# 017 — Checkpoint metadata

Date: 2026-09-12
Status: implemented.

Claude Code's checkpoint feature (`/rewind`, double-Esc) snapshots
tracked files before each prompt that starts a turn. The raw material
lives in files hodor already reads, so surfacing it is a fold
extension, not a new discovery layer.

## How the CLI records checkpoints (verified against 2.1.269)

Two transcript line types, shapes captured from real output:

- `file-history-snapshot` — one checkpoint. `{messageId, snapshot:
  {trackedFileBackups: {<relativePath>: {backupFileName, version,
  backupTime, realParentDir}}, timestamp}, isSnapshotUpdate}`. The
  first snapshot of a session has empty backups; a RESUME re-snapshots
  every tracked file (that's when `<hash>@v<N>` backup blobs appear).
- `file-history-delta` — one file first-modified under the current
  checkpoint. `backupFileName: null` means the file did not exist at
  checkpoint time (restore = delete it).

Backup blobs live in `<store>/file-history/<sessionId>/<hash>@v<N>`
and are swept ~30 days after the session's last snapshot
(`cleanupPeriodDays`), so restorability is a filesystem fact, not a
transcript fact.

Checkpointing is OFF in print/SDK runs (and hence our remote
container sessions) unless `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`
is set — found by reading the CLI binary; that's also how we provoked
real lines to build against. Interactive local sessions have it on by
default, so Dylan's real stores carry these lines everywhere.

## What hodor extracts

Per session (`session.checkpoints`, absent when none):

- `count` — distinct checkpoints, deduped by snapshot messageId so
  `isSnapshotUpdate` rewrites never double-count.
- `edits` — tracked file-modification events (delta lines).
- `files` — every path ever tracked, resolved against each backup's
  `realParentDir` (separator sniffed for Windows paths).
- `lastAt` — newest snapshot/delta timestamp.
- `backupFiles` — blobs actually on disk under
  `file-history/<sessionId>`, probed by a cached enrichment pass like
  memory files; absent = not probed, 0 = expired or never written.

Surfaces: detail-pane fact (`checkpoints 12 · 8 files · restorable` /
`backups gone`), `hodor stats` line (total, sessions, restorable
count), and the full structure in `scan --json`.

## Not done (deliberately)

- Rewind detection: a rewind shows up as a parentUuid branch, not a
  checkpoint line — same tree shape as double-resume (016). If branch
  analytics ever land, they cover both.
- Reading backup blob contents. hodor never opens them; count only.
