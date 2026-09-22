// Resolver hook so benchmarks can import the server's extensionless TS modules
// directly under Node's native type stripping.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
    try {
      const url = new URL(specifier, context.parentURL)
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        const candidate = new URL(url.href + ext)
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(candidate.href, context)
        }
      }
    } catch {
      // Fall through to the default resolver.
    }
  }
  return nextResolve(specifier, context)
}
