import { normalizeCloudListing, pathOps, type SourceEvent } from '@hodor/core'
import type { CliDeps } from './main.js'

/**
 * Cloud-session listing: the same endpoint the CLI's own cloud features
 * use (found by inspecting the installed CLI; there is no documented
 * REST API), authenticated with the claude.ai OAuth token that `claude
 * login` stores locally. Deliberately failure-tolerant: no credentials
 * means the feature is simply absent, and any listing failure becomes a
 * one-line hint rather than an error.
 */

const LIST_URL = 'https://api.anthropic.com/v1/code/sessions?limit=50'

async function readAccessToken(deps: CliDeps): Promise<string | undefined> {
  const p = pathOps(deps.platformFlavor)
  const path = p.join(deps.homedir(), '.claude', '.credentials.json')
  const content = await deps.fs.readFile(path).catch(() => undefined)
  if (content === undefined) return undefined
  try {
    const creds = JSON.parse(content) as { claudeAiOauth?: { accessToken?: string } }
    const token = creds.claudeAiOauth?.accessToken
    return typeof token === 'string' && token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

/**
 * One listing pass. Returns undefined when the machine has no claude.ai
 * login (feature absent), otherwise always an event — with sessions on
 * success, with `error` on failure so the UI can say why it's empty.
 */
export async function scanCloudSessions(deps: CliDeps): Promise<SourceEvent | undefined> {
  const token = await readAccessToken(deps)
  if (token === undefined) return undefined
  const scannedAt = deps.now().toISOString()
  try {
    const res = await deps.httpGetJson(LIST_URL, {
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      // Required on every api.anthropic.com call — the CLI always sends
      // it; omitting it is a 400 even with valid auth.
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
    })
    if (res.status === 401 || res.status === 403) {
      return {
        type: 'cloud-sessions-scanned',
        sessions: [],
        scannedAt,
        error: `cloud listing not authorized (HTTP ${res.status}) — try \`claude login\` to refresh credentials`,
      }
    }
    if (res.status !== 200) {
      // Carry the server's own words: this endpoint is undocumented, so
      // when it drifts, the error text is the diagnosis.
      const detail = JSON.stringify(res.json ?? '').slice(0, 300)
      return {
        type: 'cloud-sessions-scanned',
        sessions: [],
        scannedAt,
        error: `cloud listing failed (HTTP ${res.status})${detail !== '""' ? ` — ${detail}` : ''}`,
      }
    }
    return { type: 'cloud-sessions-scanned', sessions: normalizeCloudListing(res.json), scannedAt }
  } catch (error) {
    return {
      type: 'cloud-sessions-scanned',
      sessions: [],
      scannedAt,
      error: `cloud listing failed: ${String(error)}`,
    }
  }
}
