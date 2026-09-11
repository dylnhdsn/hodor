# 012 — Modern subagent transcripts: per-file, not in-file

Date: 2026-09-11
Status: implemented. Root cause of Dylan's report "I'm not seeing any
sessions with agents in them."

## The finding

011 assumed subagent runs appear as `isSidechain: true` lines inside the
parent transcript. Current CLIs (verified live on 2.1.268 by spawning a
subagent and watching the store) write each run to its own files instead:

```
<bucket>/<parentSessionId>/subagents/agent-<agentId>.jsonl
<bucket>/<parentSessionId>/subagents/agent-<agentId>.meta.json
```

The run's lines still carry `isSidechain: true`, plus an `agentId` on
every line, and `sessionId` = the PARENT session id. The sidecar meta
carries `agentType` ("Explore", "general-purpose", …), `description`,
`toolUseId`, `spawnDepth`. The parent transcript contains no sidechain
lines at all — so hodor, which only scanned `<bucket>/*.jsonl`, saw
zero subagents anywhere. The session-id-named directory also holds
non-transcript clutter (`ccr-tip.json`), which stays ignored.

## The fix

- **Tailer** discovers `<bucket>/<dir>/subagents/agent-*.jsonl` and tails
  each like any transcript (offsets, pending buffers). Their line events
  are emitted for the PARENT session and carry the parent's MAIN
  transcript path, so folding stays order-independent no matter which
  file is seen first. On first tracking, the sidecar meta is read and
  emitted as a `subagent-meta` event (tolerant: missing/bad meta just
  means no metadata).
- **Fold** groups sidechain lines by `agentId` when present (one thread
  per run, robust across interleaved polls); legacy in-file sidechains
  keep the parent-uuid chain grouping. `agentMeta` lands on the session
  and the snapshot merges it onto threads: `Thread.agentId/agentType/
  description`.
- **Removal/rewrite rules**: a deleted agent file never removes the
  parent session (its lines are forgotten on the next full rescan); an
  agent-file rewrite is out of contract like grow-rewrites, reset
  silently rather than wiping the parent.
- **`/api/transcript`** merges the main file with the session's agent
  files by timestamp, so the detail pane's conversation shows ⑂ turns
  inline for modern sessions too.
- **`hodor stats`** now prints `subagent runs: N across M sessions` —
  the quick check for whether discovery is working on a store.

## Validation

Run against this machine's real store: the working session reported its
one live subagent with type "Explore", real timestamps, and its turns
merged into the tail of a 12MB transcript. Plus directed tests: tailer
discovery + incremental append + no-parent-removal, agentId grouping
across interleaved events, meta-before-lines order independence, thread
meta in the snapshot, tail merge over HTTP.

## Notes

- Cost: one extra `stat` per session directory per poll, plus a
  `listDir` where a `subagents/` dir exists. Fine at current scale;
  revisit if stores with thousands of sessions poll slowly.
- `spawnDepth` > 1 (agents spawning agents) still lands under the same
  parent session — flattened for now. Nesting display can come later.
- The old in-file format keeps working; stores migrate CLI version by
  CLI version and both shapes can coexist in one store.
