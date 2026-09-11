# 014 — Metadata sweep: everything else the transcripts carry

Date: 2026-09-11
Status: implemented. Follow-on to 013: "grab all the metadata you
mentioned."

## New per-session fields

- **`toolCounts`** — tool_use blocks by tool name; `counts.toolCalls`
  stays as the sum. The session's tool fingerprint (this repo's build
  session: Edit 422, Bash 248, Write 105…). Rendered as a bar list in
  the detail pane; `hodor stats` aggregates a store-wide histogram.
- **`usage.*.thinking`** — thinking tokens per model, from
  `output_tokens_details`. A SUBSET of output at the same price: shown
  for insight (`out 757.1k (think 260.7k)`), never added to cost or
  totals separately — that would double-count.
- **`slug`** — the CLI's human-readable session name
  ("structured-munching-map"); shown in facts and searchable.
- **`effort`** — last effort level in force (low…max).
- **`compactions`** — how many times the context was compacted. Each
  compaction writes a uuid-less `system/compact_boundary` line AND an
  `isCompactSummary` user turn; the fold counts both kinds and the
  snapshot takes the max, so it tolerates either marker alone and stays
  order-independent. The parser now preserves `subtype` on downgraded
  uuid-less system lines to make this possible.
- **`apiErrors`** — count of `isApiErrorMessage` assistant lines. That
  field name comes from CLI convention; no occurrence exists in the
  stores we can see, so it's parsed tolerantly and unverified in the
  wild.
- **`serviceTier` / `inferenceGeo`** (last observed; geo skipped when
  "not_available") and **`fastMode`** (true once any response ran at
  `speed: "fast"` — a flag that matters because fast mode prices
  differently, still not reflected in cost).
- Deliberately still skipped: `requestId` and `userType` — strictly
  per-line values with no useful session-level reduction.

## A title bug found on the way

The `isCompactSummary` user turn is machine text ("This session is
being continued from a previous conversation…"). A session resumed
after compaction could have that as its FIRST user line — and it would
have become the session's prompt-preview title. The parser now refuses
to take prompt text from compact-summary turns.

## Where it shows

Detail pane facts (slug, effort, tier when non-standard, geo,
compactions, fast mode, api errors in amber) + a TOOLS bar section +
`(think X)` in usage rows; `hodor stats` gains the store-wide tool
histogram and a `think` column in the by-model table; slug joins the
search index. All of it is in `scan --json` for scripting.
