# pi-handoff

Proactive context-handoff for the [pi](https://github.com/earendil-works) coding agent.

When a session's context usage crosses a threshold (default **80%**, or any
absolute token count you pick), pi-handoff automatically writes a structured
**handoff document** of the session so you can cleanly continue after a
`/compact` or in a brand-new session — instead of losing the thread (or hitting
the auto-compaction-mid-loop crash).

## What it does

- **Watches context usage** after every turn (`turn_end` + `getContextUsage()`).
- At the threshold, generates a structured handoff (Goal / Current State / Next
  Steps / Open Questions / Key Facts) using a **cheap, fast model**, writes it to
  `.pi/handoff.md`, and notifies you. It does **not** auto-compact — you stay in
  control. It refreshes the doc as usage keeps climbing (every +5%).
- **On a new session or a fresh launch** (not a `resume` of existing history),
  if a recent handoff from a *different* session exists, it asks whether to load
  it, and injects it into your next message's context.
- **Enriches pi's own `/compact`** (on by default): replaces the built-in
  compaction summary with the same structured handoff format, so the in-context
  summary after a compaction carries the Goal / State / Next-Steps shape too.
  Falls back to pi's default summary on any error.

## Install

```bash
pi install git:github.com/ttiimmaahh/pi-handoff@main
```

Local dev (single file, no install):

```bash
pi --extension /path/to/pi-handoff/index.ts
```

> Note: `pi install` no-ops if the package is already cloned. To update an
> existing install, `git -C ~/.pi/agent/git/github.com/ttiimmaahh/pi-handoff pull`
> and restart pi.

## Commands

- `/handoff-setup` — guided setup (like `/login`): pick the **summarizer model**
  (listed cheapest-first with per-Mtok cost), the **trigger mode** (percent of
  context window or absolute token count) and value, and whether to **enrich
  `/compact`**. Saved to a config file so it sticks across sessions.
- `/handoff` — generate the handoff document right now.
- `/handoff-load` — inject the existing `.pi/handoff.md` into this session.

## Configuration

The easy path is **`/handoff-setup`**. It writes your choices to a config file
(default `~/.pi/agent/pi-handoff-config.json`):

```json
{
  "model": "sap-aicore/anthropic--claude-4.5-haiku",
  "threshold": { "type": "percent", "value": 80 },
  "compaction": "enrich"
}
```

Or, with an absolute token threshold:

```json
{
  "model": "sap-aicore/anthropic--claude-4.5-haiku",
  "threshold": { "type": "tokens", "value": 120000 },
  "compaction": "enrich"
}
```

> Older configs that stored a bare number (e.g. `"threshold": 80`) are still
> read — they're treated as a percent threshold.

Environment variables override the saved config (handy for one-off/scripted runs):

| Var | Default | Meaning |
|---|---|---|
| `PI_HANDOFF_MODEL` | auto | Summarizer model as `provider/id` (e.g. `sap-aicore/anthropic--claude-4.5-haiku`). |
| `PI_HANDOFF_THRESHOLD` | `80%` | Trigger threshold. Accepts `80%` (percent), `120000` (tokens), `120k` / `1.5M` (suffix tokens). A bare integer 1–99 is treated as percent for back-compat with older setups. |
| `PI_HANDOFF_COMPACTION` | `enrich` | `off` to disable enriching pi's `/compact` summary. |
| `PI_HANDOFF_PATH` | `.pi/handoff.md` | Where to write the doc (relative to cwd, or absolute). |
| `PI_HANDOFF_CONFIG` | `~/.pi/agent/pi-handoff-config.json` | Path to the saved config file. |

**Model precedence:** `PI_HANDOFF_MODEL` → `/handoff-setup` choice → cheapest
known model on your current provider → the active conversation model.
**Threshold precedence:** `PI_HANDOFF_THRESHOLD` → `/handoff-setup` choice → `80%`.
**Compaction precedence:** `PI_HANDOFF_COMPACTION` → `/handoff-setup` choice → on.

## Notes / limitations

- Handoff generation sends the conversation to the summarizer model — that's a
  (cheap) extra call. With the default cheap-model selection the cost is small.
- Compaction enrichment **replaces** pi's built-in compaction summarization with
  a call to your chosen summarizer model — it's a substitution, not an extra
  call (and is often cheaper, since the summarizer is usually cheaper than the
  conversation model).
- Injection on load is **one-shot**: the handoff is added to your next message's
  context so the model reads it once. It is not persisted as a session entry.
- The doc lives at `.pi/handoff.md`, which is gitignored by default here.
