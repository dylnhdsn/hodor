import { createRequire } from 'node:module'

/**
 * Injected by scripts/bundle.mjs at build time (e.g. "0.0.1-build.12.abc123").
 * Absent in a dev checkout, where the package version is used instead.
 */
declare const __HODOR_VERSION__: string | undefined

export function cliVersion(): string {
  if (typeof __HODOR_VERSION__ === 'string') return __HODOR_VERSION__
  const req = createRequire(import.meta.url)
  return (req('../package.json') as { version: string }).version
}
