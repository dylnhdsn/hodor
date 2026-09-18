import { REPO, releaseTagOf, type Channel } from './channel.js'

/**
 * Self-update from a channel's GitHub release. CI publishes each channel
 * to its own release tag (nightly → "latest", stable, experimental)
 * carrying hodor.mjs + version.json; `hodor update` compares versions and
 * swaps the installed bundle in place. The bundle knows its own channel
 * and follows it; `--channel` moves to another, and the bundle that
 * lands then follows THAT one.
 *
 * All effects are injected via UpdateIO so the logic is testable; bin.ts
 * provides the real fetch/fs implementation.
 */

export { REPO }

export interface HttpResponse {
  status: number
  bytes: Uint8Array
}

export interface UpdateIO {
  currentVersion: string
  /** The channel this bundle was built for (nightly when unknown). */
  channel?: Channel
  /** Path of the installed bundle; undefined when running from a dev checkout. */
  selfPath?: string
  /** GitHub token, if any — needed only for private repos and rate limits. */
  token?: string
  http(url: string, headers: Record<string, string>): Promise<HttpResponse>
  /** Atomically replace the installed bundle with new content. */
  replaceSelf(bytes: Uint8Array): Promise<void>
  write(text: string): void
}

export interface ReleaseAsset {
  name: string
  /** API asset URL — works with a token on private repos. */
  url: string
  /** Public download URL — works unauthenticated on public repos. */
  browser_download_url: string
}

export function pickAsset(release: unknown, name: string): ReleaseAsset | undefined {
  const assets = (release as { assets?: unknown } | null)?.assets
  if (!Array.isArray(assets)) return undefined
  for (const asset of assets) {
    const a = asset as Partial<ReleaseAsset> | null
    if (
      a !== null &&
      a.name === name &&
      typeof a.url === 'string' &&
      typeof a.browser_download_url === 'string'
    ) {
      return { name, url: a.url, browser_download_url: a.browser_download_url }
    }
  }
  return undefined
}

function baseHeaders(io: UpdateIO, accept: string): Record<string, string> {
  return {
    accept,
    'user-agent': 'hodor-cli',
    ...(io.token !== undefined ? { authorization: `Bearer ${io.token}` } : {}),
  }
}

async function downloadAsset(io: UpdateIO, asset: ReleaseAsset): Promise<Uint8Array | undefined> {
  // The API asset URL honors tokens (private repos); the browser URL is the
  // plain public path. Pick whichever matches how we're authenticated.
  const url = io.token !== undefined ? asset.url : asset.browser_download_url
  const res = await io.http(url, baseHeaders(io, 'application/octet-stream'))
  return res.status === 200 ? res.bytes : undefined
}

export async function runUpdate(io: UpdateIO, wanted?: Channel): Promise<number> {
  const out = (text: string): void => io.write(text + '\n')

  if (io.selfPath === undefined) {
    out('update: this looks like a dev checkout — use `git pull && pnpm build` instead.')
    return 1
  }

  const own = io.channel ?? 'nightly'
  const channel = wanted ?? own
  const tag = releaseTagOf(channel)
  const releaseUrl = `https://api.github.com/repos/${REPO}/releases/tags/${tag}`
  const res = await io.http(releaseUrl, baseHeaders(io, 'application/vnd.github+json'))
  if (res.status !== 200) {
    out(`update: could not fetch the ${tag} release (HTTP ${res.status}).`)
    out('update: if the repo is private, set GITHUB_TOKEN or log in with `gh auth login`.')
    return 1
  }

  let release: unknown
  try {
    release = JSON.parse(new TextDecoder().decode(res.bytes))
  } catch {
    out('update: release metadata was not valid JSON.')
    return 1
  }

  const versionAsset = pickAsset(release, 'version.json')
  const bundleAsset = pickAsset(release, 'hodor.mjs')
  if (versionAsset === undefined || bundleAsset === undefined) {
    out('update: the release is missing hodor.mjs/version.json assets — is CI green?')
    return 1
  }

  const versionBytes = await downloadAsset(io, versionAsset)
  if (versionBytes === undefined) {
    out('update: failed to download version.json.')
    return 1
  }
  let remoteVersion: string
  try {
    remoteVersion = (JSON.parse(new TextDecoder().decode(versionBytes)) as { version: string })
      .version
  } catch {
    out('update: version.json was not valid JSON.')
    return 1
  }

  if (remoteVersion === io.currentVersion) {
    out(`hodor ${io.currentVersion} is already up to date (${channel}).`)
    return 0
  }

  const bundleBytes = await downloadAsset(io, bundleAsset)
  if (bundleBytes === undefined) {
    out('update: failed to download hodor.mjs.')
    return 1
  }

  await io.replaceSelf(bundleBytes)
  out(`hodor updated: ${io.currentVersion} → ${remoteVersion} (${channel})`)
  if (channel !== own) {
    out(`update: now on the ${channel} channel — future updates follow it.`)
  }
  return 0
}
