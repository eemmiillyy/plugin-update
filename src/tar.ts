import makeDebug from 'debug'
import {existsSync} from 'node:fs'
import {cp, rename, rm} from 'node:fs/promises'
import {join} from 'node:path'

import {touch} from './util.js'
const debug = makeDebug('oclif-update')
import {Headers, extract as tarExtract} from 'tar-fs'

const ignore = (_name: string, header?: Headers) => {
  switch (header?.type) {
    case 'directory':
    case 'file': {
      if (process.env.OCLIF_DEBUG_UPDATE_FILES) debug(header.name)
      return false
    }

    case 'symlink': {
      return true
    }

    default: {
      throw new Error(header?.type)
    }
  }
}

async function extract(stream: NodeJS.ReadableStream, basename: string, output: string): Promise<void> {
  const getTmp = () => `${output}.partial.${Math.random().toString().split('.')[1].slice(0, 5)}`
  let tmp = getTmp()
  if (existsSync(tmp)) tmp = getTmp()
  debug(`extracting to ${tmp}`)
  try {
    await new Promise((resolve, reject) => {
      let extracted = false
      const check = () => extracted && resolve(null)

      const extract = tarExtract(tmp, {ignore})
      extract.on('error', reject)
      extract.on('finish', () => {
        extracted = true
        check()
      })

      stream.pipe(extract)
    })

    if (existsSync(output)) {
      try {
        const tmp = getTmp()
        await cp(output, tmp)
        await rm(tmp, {force: true, recursive: true}).catch(debug)
      } catch (error: unknown) {
        debug(error)
        await rm(tmp, {force: true, recursive: true}).catch(debug)
      }
    }

    const from = join(tmp, basename)

    debug('moving %s to %s', from, output)
    await rename(from, output)
    await rm(tmp, {force: true, recursive: true}).catch(debug)
    await touch(output)
    debug('done extracting')
  } catch (error: unknown) {
    await rm(tmp, {force: true, recursive: true}).catch(process.emitWarning)
    throw error
  }
}

// This is done so that we can stub it in tests
export const Extractor = {
  extract,
}
