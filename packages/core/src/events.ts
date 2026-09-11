import type { TranscriptLine } from './claude/transcript.js'
import type { HodorConfig } from './config.js'
import type { GitContext } from './git.js'
import type { UserPlane } from './userplane.js'
import type { Runtime, SessionId, SessionMeta, SessionStore, StoreId } from './types.js'

/**
 * The event stream: the pure fold's entire input. Edge adapters (tailers,
 * the git enricher, a future session host, the persistence layer) emit
 * these; nothing else mutates core state.
 */
export type SourceEvent =
  | { type: 'store-discovered'; store: SessionStore }
  | {
      type: 'transcript-lines'
      storeId: StoreId
      transcriptPath: string
      /** Filename stem — the CLI names transcripts `<sessionId>.jsonl`. */
      sessionId: SessionId
      lines: TranscriptLine[]
    }
  | { type: 'transcript-removed'; storeId: StoreId; transcriptPath: string }
  | {
      /** Sidecar metadata for one subagent run (agent-<id>.meta.json). */
      type: 'subagent-meta'
      storeId: StoreId
      sessionId: SessionId
      /** The parent session's MAIN transcript, for order-independent folds. */
      transcriptPath: string
      agentId: string
      agentType?: string
      description?: string
    }
  | { type: 'git-context-resolved'; storeId: StoreId; cwd: string; context: GitContext | null }
  | { type: 'runtime-changed'; sessionId: SessionId; runtime: Runtime }
  | { type: 'meta-changed'; meta: SessionMeta }
  | { type: 'config-changed'; config: HodorConfig }
  | { type: 'userplane-changed'; plane: UserPlane }
