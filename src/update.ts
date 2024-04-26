import {Config, ux} from '@oclif/core'
import chalk from 'chalk'
import fileSize from 'filesize'
import {HTTP} from 'http-call'
import throttle from 'lodash.throttle'
import {Stats, existsSync} from 'node:fs'
import {mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile} from 'node:fs/promises'
import {basename, dirname, join} from 'node:path'

import {Extractor} from './tar.js'
import {ls, wait} from './util.js'

const filesize = (n: number): string => {
  const [num, suffix] = fileSize(n, {output: 'array'})
  return Number.parseFloat(num).toFixed(1) + ` ${suffix}`
}

type Options = {
  autoUpdate: boolean
  channel?: string | undefined
  force?: boolean
  version?: string | undefined
}

type VersionIndex = Record<string, string>

export class Updater {
  private readonly clientBin: string
  private readonly clientRoot: string

  constructor(private config: Config) {
    this.clientRoot = config.scopedEnvVar('OCLIF_CLIENT_HOME') ?? join(config.dataDir, 'client')
    this.clientBin = join(this.clientRoot, 'bin', config.windows ? `${config.bin}.cmd` : config.bin)
  }

  public async fetchVersionIndex(): Promise<VersionIndex> {
    // TODO should this be github or npm?
    const newIndexUrl = 'https://api.github.com/repos/xataio/client-ts/releases'
    try {
      const {body} = await HTTP.get<{tag_name: string}[]>(newIndexUrl)
      // eslint-disable-next-line unicorn/no-array-reduce
      const newbody = body.reduce(
        (acc, release) => {
          const version = release.tag_name
          if (version.includes('@xata.io/cli@')) {
            // TODO find platform specific binary
            // const asset = release.assets.find((a) => a.name.includes("arm"));
            // TODO put the download link here, as .tar?
            const versionOnly = version.replace('@xata.io/cli@', '')
            acc[versionOnly] = `LINK_TO_DOWNLOAD_BINARY`
            return acc
          }

          return acc
        },
        {} as {[key: string]: string},
      )
      return newbody
    } catch {
      throw new Error(`No version indices exist for ${this.config.name}.`)
    }
  }

  public async findLocalVersions(): Promise<string[]> {
    await ensureClientDir(this.clientRoot)
    const dirOrFiles = await readdir(this.clientRoot)
    return dirOrFiles
      .filter((dirOrFile) => dirOrFile !== 'bin' && dirOrFile !== 'current')
      .map((f) => join(this.clientRoot, f))
  }

  public async runUpdate(options: Options): Promise<void> {
    const {autoUpdate, force = false, version} = options
    if (autoUpdate) await debounce(this.config.cacheDir)

    ux.action.start(`${this.config.name}: Updating CLI`)

    if (notUpdatable(this.config)) {
      ux.action.stop('not updatable')
      return
    }

    const [channel, current] = await Promise.all([
      options.channel ?? determineChannel({config: this.config, version}),
      determineCurrentVersion(this.clientBin, this.config.version),
    ])

    if (version) {
      const localVersion = force ? null : await this.findLocalVersion(version)

      if (alreadyOnVersion(current, localVersion || null)) {
        ux.action.stop(this.config.scopedEnvVar('HIDE_UPDATED_MESSAGE') ? 'done' : `already on version ${current}`)
        return
      }

      await this.config.runHook('preupdate', {channel, version})

      if (localVersion) {
        await this.updateToExistingVersion(current, localVersion)
      } else {
        const index = await this.fetchVersionIndex()
        const url = index[version]
        if (!url) {
          throw new Error(`${version} not found in index:\n${Object.keys(index).join(', ')}`)
        }

        await this.update(current, version, force, channel)
      }

      await this.config.runHook('update', {channel, version})
      ux.action.stop()
      ux.log()
      ux.log(
        `Updating to a specific version will not update the channel. If autoupdate is enabled, the CLI will eventually be updated back to ${channel}.`,
      )
    } else {
      const {
        body: {version: latestVersion},
      } = await HTTP.get<{version: string}>('https://registry.npmjs.org/@xata.io/cli/latest')

      const updated = latestVersion

      if (!force && alreadyOnVersion(current, updated)) {
        ux.action.stop(this.config.scopedEnvVar('HIDE_UPDATED_MESSAGE') ? 'done' : `already on version ${current}`)
      } else {
        await this.config.runHook('preupdate', {channel, version: updated})
        await this.update(current, updated, force, channel)
      }

      await this.config.runHook('update', {channel, version: updated})
      ux.action.stop()
    }

    await this.touch()
    await this.tidy()
    ux.debug('done')
  }

  private async createBin(version: string): Promise<void> {
    const dst = this.clientBin
    const {bin, windows} = this.config
    const binPathEnvVar = this.config.scopedEnvVarKey('BINPATH')
    const redirectedEnvVar = this.config.scopedEnvVarKey('REDIRECTED')
    await mkdir(dirname(dst), {recursive: true})

    if (windows) {
      const body = `@echo off
setlocal enableextensions
set ${redirectedEnvVar}=1
set ${binPathEnvVar}=%~dp0${bin}
"%~dp0..\\${version}\\bin\\${bin}.cmd" %*
`
      await writeFile(dst, body)
    } else {
      /* eslint-disable no-useless-escape */
      const body = `#!/usr/bin/env bash
set -e
get_script_dir () {
  SOURCE="\${BASH_SOURCE[0]}"
  # While $SOURCE is a symlink, resolve it
  while [ -h "$SOURCE" ]; do
    DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
    SOURCE="$( readlink "$SOURCE" )"
    # If $SOURCE was a relative symlink (so no "/" as prefix, need to resolve it relative to the symlink base directory
    [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
  done
  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
  echo "$DIR"
}
DIR=$(get_script_dir)
${binPathEnvVar}="\$DIR/${bin}" ${redirectedEnvVar}=1 "$DIR/../${version}/bin/${bin}" "$@"
`
      /* eslint-enable no-useless-escape */
      await writeFile(dst, body, {mode: 0o755})
      await rm(join(this.clientRoot, 'current'), {force: true, recursive: true})
      await symlink(`./${version}`, join(this.clientRoot, 'current'))
    }
  }

  private async findLocalVersion(version: string): Promise<string | undefined> {
    const versions = await this.findLocalVersions()
    return versions.map((file) => basename(file)).find((file) => file.startsWith(version))
  }

  private async refreshConfig(version: string): Promise<void> {
    this.config = (await Config.load({root: join(this.clientRoot, version)})) as Config
  }

  // removes any unused CLIs
  private async tidy(): Promise<void> {
    ux.debug('tidy')
    try {
      const root = this.clientRoot
      if (!existsSync(root)) return
      const files = await ls(root)

      const isNotSpecial = (fPath: string, version: string): boolean =>
        !['bin', 'current', version].includes(basename(fPath))

      const isOld = (fStat: Stats): boolean => {
        const {mtime} = fStat
        mtime.setHours(mtime.getHours() + 42 * 24)
        return mtime < new Date()
      }

      await Promise.all(
        files
          .filter((f) => isNotSpecial(this.config.version, f.path) && isOld(f.stat))
          .map((f) => rm(f.path, {force: true, recursive: true})),
      )
    } catch (error: unknown) {
      ux.warn(error as Error | string)
    }
  }

  private async touch(): Promise<void> {
    // touch the client so it won't be tidied up right away
    try {
      const p = join(this.clientRoot, this.config.version)
      ux.debug('touching client at', p)
      if (!existsSync(p)) return
      return utimes(p, new Date(), new Date())
    } catch (error: unknown) {
      ux.warn(error as Error | string)
    }
  }

  private async update(current: string, updated: string, force: boolean, channel: string) {
    ux.action.start(
      `${this.config.name}: Updating CLI from ${chalk.green(current)} to ${chalk.green(updated)}${
        channel === 'stable' ? '' : ' (' + chalk.yellow(channel) + ')'
      }`,
    )

    await ensureClientDir(this.clientRoot)
    const output = join(this.clientRoot, updated)
    if (force || !existsSync(output)) await downloadAndExtract(output, '', channel, this.config)

    await this.refreshConfig(updated)
    await setChannel(channel, this.config.dataDir)
    await this.createBin(updated)
  }

  private async updateToExistingVersion(current: string, updated: string): Promise<void> {
    ux.action.start(`${this.config.name}: Updating CLI from ${chalk.green(current)} to ${chalk.green(updated)}`)
    await ensureClientDir(this.clientRoot)
    await this.refreshConfig(updated)
    await this.createBin(updated)
  }
}

const alreadyOnVersion = (current: string, updated: null | string): boolean => current === updated

const ensureClientDir = async (clientRoot: string): Promise<void> => {
  try {
    await mkdir(clientRoot, {recursive: true})
  } catch (error: unknown) {
    const {code} = error as {code: string}
    if (code === 'EEXIST') {
      // for some reason the client directory is sometimes a file
      // if so, this happens. Delete it and recreate
      await rm(clientRoot, {force: true, recursive: true})
      await mkdir(clientRoot, {recursive: true})
    } else {
      throw error
    }
  }
}

// eslint-disable-next-line unicorn/no-await-expression-member
const mtime = async (f: string): Promise<Date> => (await stat(f)).mtime

const notUpdatable = (config: Config): boolean => {
  if (!config.binPath) {
    const instructions = config.scopedEnvVar('UPDATE_INSTRUCTIONS')
    if (instructions) {
      ux.warn(instructions)
      // once the spinner stops, it'll eat this blank line
      // https://github.com/oclif/core/issues/799
      ux.log()
    }

    return true
  }

  return false
}

// const determinePlatform = (config: Config): Interfaces.PlatformTypes =>
//   config.platform === 'wsl' ? 'linux' : config.platform

// when autoupdating, wait until the CLI isn't active
const debounce = async (cacheDir: string): Promise<void> => {
  let output = false
  const lastrunfile = join(cacheDir, 'lastrun')
  const m = await mtime(lastrunfile)
  m.setHours(m.getHours() + 1)
  if (m > new Date()) {
    const msg = `waiting until ${m.toISOString()} to update`
    if (output) {
      ux.debug(msg)
    } else {
      ux.log(msg)
      output = true
    }

    await wait(60 * 1000) // wait 1 minute
    return debounce(cacheDir)
  }

  ux.log('time to update')
}

const setChannel = async (channel: string, dataDir: string): Promise<void> =>
  writeFile(join(dataDir, 'channel'), channel, 'utf8')

const downloadAndExtract = async (output: string, baseDir: string, channel: string, config: Config): Promise<void> => {
  console.log('downlaoding......', output, baseDir, channel, config.version)
  try {
    // TODO should be from github
    // TODO expects a .tar file
    const {response: stream} = await HTTP.stream('https://www.dwsamplefiles.com/?dl_id=553', {})
    stream.pause()

    const extraction = Extractor.extract(stream, baseDir, output)

    if (ux.action.type === 'spinner') {
      // No content-length on chunked responses
      const total = Number.parseInt(stream.headers['content-length'] ?? '0', 10)
      let current = 0
      const updateStatus = throttle(
        (newStatus: string) => {
          ux.action.status = newStatus
        },
        250,
        {leading: true, trailing: false},
      )
      stream.on('data', (data) => {
        current += data.length
        updateStatus(`${filesize(current)}/${filesize(total)}`)
      })
    }

    stream.resume()
    await extraction
  } catch {
    throw new Error('unabel to extract')
  }
}

const determineChannel = async ({config, version}: {config: Config; version?: string}): Promise<string> => {
  const channelPath = join(config.dataDir, 'channel')

  // eslint-disable-next-line unicorn/no-await-expression-member
  const channel = existsSync(channelPath) ? (await readFile(channelPath, 'utf8')).trim() : 'stable'

  try {
    const {body} = await HTTP.get<{'dist-tags': Record<string, string>}>(
      `${config.npmRegistry ?? 'https://registry.npmjs.org'}/${config.pjson.name}`,
    )
    const tags = body['dist-tags']
    const tag = Object.keys(tags).find((v) => tags[v] === version) ?? channel
    // convert from npm style tag defaults to OCLIF style
    if (tag === 'latest') return 'stable'
    if (tag === 'latest-rc') return 'stable-rc'
    return tag
  } catch {
    return channel
  }
}

const determineCurrentVersion = async (clientBin: string, version: string): Promise<string> => {
  try {
    const currentVersion = await readFile(clientBin, 'utf8')
    const matches = currentVersion.match(/\.\.[/\\|](.+)[/\\|]bin/)
    return matches ? matches[1] : version
  } catch (error: unknown) {
    ux.warn(error as Error | string)
  }

  return version
}
