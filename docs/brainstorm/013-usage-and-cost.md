# 013 — Usage metadata: tokens, cost estimates, tool calls

Date: 2026-09-11
Status: implemented. Dylan's ask: "all the token statistics and dollar
amounts" for sessions and subagents, plus whatever metadata is
reasonably extractable.

## What the transcripts carry

Every assistant line embeds the full API usage for its response:
`input_tokens`, `output_tokens`, `cache_read_input_tokens`, and
`cache_creation` split by TTL (`ephemeral_5m` / `ephemeral_1h`), plus
`message.model` and `message.id`. Subagent transcripts carry their own —
a run can use a different model than its parent (observed live: an
Explore run on claude-opus-5 under a claude-fable-5 session).

**The trap: one API response is written as one line PER CONTENT BLOCK,
each repeating the identical usage.** On this machine's real session,
naive summing over-counted output tokens 3× (2.1M vs the true 684K).
Billing dedupes on `message.id` — each id counts exactly once, tracked
per session in the fold so incremental folding stays equal to a full
rescan.

## Tokens are facts, dollars are estimates

The fold accumulates `usageByModel` per THREAD (main and each subagent
run); the snapshot sums threads into the session and prices both:

- `Thread.usage` / `Thread.costUsd` — what each subagent run cost.
- `Session.usage` / `Session.costUsd` / `Session.costUnpriced`.

Pricing lives in `core/pricing.ts`: the current-generation first-party
table (from the Claude API reference), with cache economics derived from
base input — writes 1.25× (5m TTL) and 2× (1h TTL), reads 0.1× (with
claude-fable-5-1's flat $0.25/MTok exception). Model matching tries
exact id, then a stripped date suffix, then longest prefix.

Two honesty rules:

1. **Unknown models are never silently $0.** Their tokens are counted
   and the model id lands in `costUnpriced` — the cost shown is a floor.
   Legacy models (3.x, 4.0/4.1/4.5) have retired or unpublished list
   prices, so they start unpriced.
2. **Prices drift.** `config.json` takes a `pricing` map (USD/MTok per
   model, partial overrides merge over defaults), which both corrects
   drift and prices legacy models:

```jsonc
{ "pricing": { "claude-sonnet-4-5": { "input": 3, "output": 15,
    "cacheRead": 0.3, "cacheWrite5m": 3.75, "cacheWrite1h": 6 } } }
```

The estimate is **first-party API list price** — what the tokens would
cost à la carte. Subscription plans (Pro/Max) bill differently; treat
the number as "API-equivalent spend", useful for comparing sessions and
noticing expensive lanes, not as an invoice.

## Where it shows

- **Rows**: an estimated-cost chip next to the age.
- **Detail pane**: a usage section (per-model token classes + est.
  cost, unpriced models flagged), tool-call count in facts, and a cost
  on every subagent run row.
- **Project header**: summed cost of the project's sessions.
- **scan**: `~$X` in each project block's meta; the footer totals every
  session, hidden included — hiding is presentation, money is money.
- **stats**: `est. cost: $X total, $Y in subagent runs`, a by-model
  table (tokens by class + dollars), and `top sessions by est. cost`.

Also extracted this round: tool-call counts (`tool_use` blocks; each
block appears on exactly one line, so no dedupe needed).

## Validation

Against this machine's real 12MB session: hodor's per-model, per-class
token counts and dollars match an independent hand computation exactly
(claude-fable-5 $301.03, claude-opus-5 $0.19 — the session's cache reads
alone are 222.8M tokens, which is what a long-running 1h-TTL harness
looks like).

## Later

- `usage.speed` ("fast" mode is priced differently) — parsed cheaply if
  fast-mode sessions ever show up in stores we care about.
- Thinking-token breakdown (`output_tokens_details.thinking_tokens`) —
  informational, same price as output.
- Per-day/per-project cost rollups over time (needs timestamps × usage,
  all already in the fold's reach).
