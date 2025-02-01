import type { SyncResolver } from 'jest-resolve'

const mjsResolver: SyncResolver = (path, options) => {
  const mjsExtRegex = /\.mjs$/i
  const resolver = options.defaultResolver
  if (mjsExtRegex.test(path)) {
    try {
      return resolver(path.replace(mjsExtRegex, '.mts'), options)
    } catch {
      // use default resolver
    }
  }

  return resolver(path, options)
}

export default mjsResolver


