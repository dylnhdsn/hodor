/**
 * Release channels.
 *
 * The channel is BAKED INTO THE BUILD (scripts/bundle*.mjs define
 * __HODOR_CHANNEL__), never a runtime setting. Two installs on one
 * machine — stable for work, experimental to try things — have to be two
 * products, each with its own identity, data directory and update feed;
 * an app that switched its own feed would update itself into the other
 * product. Moving channels means installing the other build.
 *
 * - nightly: every push to the default branch. Publishes to the 'latest'
 *   release tag — the one every existing install already tracks.
 * - experimental: every push to an exp/* branch.
 * - stable: only by hand — Actions → build → Run workflow → pick the ref,
 *   channel stable. A REBUILD of that ref with the stable identity, never
 *   a copy of a nightly's binaries.
 */

export const REPO = 'dylnhdsn/hodor'

export type Channel = 'stable' | 'nightly' | 'experimental'
export const CHANNELS: readonly Channel[] = ['stable', 'nightly', 'experimental']

export const isChannel = (value: unknown): value is Channel =>
  typeof value === 'string' && (CHANNELS as readonly string[]).includes(value)

/** The GitHub release tag a channel publishes to. */
export const releaseTagOf = (channel: Channel): string =>
  channel === 'nightly' ? 'latest' : channel

/** Base URL of a channel's assets (installers, feeds, version.json). */
export const feedUrlOf = (channel: Channel): string =>
  `https://github.com/${REPO}/releases/download/${releaseTagOf(channel)}`

declare const __HODOR_CHANNEL__: string | undefined

/** The channel this build was made for. A dev checkout counts as nightly. */
export function cliChannel(): Channel {
  return typeof __HODOR_CHANNEL__ === 'string' && isChannel(__HODOR_CHANNEL__)
    ? __HODOR_CHANNEL__
    : 'nightly'
}
