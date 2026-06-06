# pi-handoff

Proactive context-handoff for the [pi coding agent](https://pi.dev).

When a session's context usage crosses a threshold (default **80%**, or any
absolute token count you pick), pi-handoff automatically writes a structured
**handoff document** so you can cleanly continue after a `/compact` or in a
brand-new session without losing the thread.

## What it does

- **Watches context usage** after every turn (`turn_end` + `getContextUsage()`).
- At the threshold, generates a structured handoff (Goal / Current State / Next
  Steps / Open Questions / Key Facts) using a cheap-model heuristic, writes it to
  `.pi/handoff.md`, and notifies you. It does **not** auto-compact — you stay in
  control. It refreshes the doc as usage keeps climbing.
- **On a new session or a fresh launch** (not a `resume` of existing history),
  if a recent handoff from a *different* session exists, it asks whether to load
  it, and injects it into your next message's context.
- **Enriches pi's own `/compact`** (on by default): replaces the built-in
  compaction summary with the same structured handoff format, so the in-context
  summary after a compaction carries the Goal / State / Next-Steps shape too.
  Falls back to pi's default summary on any error.

## Install

### From npm (recommended)

```bash
pi install npm:@ttiimmaahh/pi-handoff
```

Pi downloads the package under `~/.pi/agent/npm/`, installs runtime dependencies,
and auto-loads the extension on startup. Run the command on each machine where
you want the extension. `pi update` keeps unpinned npm package installs current;
pin a version with `pi install npm:@ttiimmaahh/pi-handoff@<version>` if you want updates to
skip this package.

Then run Pi and configure the extension:

```text
/handoff-setup
```

### Alternative: install from git

For an unpublished fork or branch you want to track directly:

```bash
pi install git:github.com/ttiimmaahh/pi-handoff@main
```

Pi clones to `~/.pi/agent/git/…`, runs `npm install`, and auto-loads on startup.
Note: an `@main` git install is **not** moved to newer commits by `pi update` (it
only reconciles to the pinned ref) — prefer the npm install above for hands-off
updates.

### Local development

```bash
npm install
pi -e ./index.ts
```

This loads the local extension for that Pi process and overrides any globally
installed version for the session.

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
| `PI_HANDOFF_COMPACTION` | `enrich` | `off` to disable enriching Pi's `/compact` summary. |
| `PI_HANDOFF_PATH` | `.pi/handoff.md` | Where to write the doc (relative to cwd, or absolute). |
| `PI_HANDOFF_CONFIG` | `~/.pi/agent/pi-handoff-config.json` | Path to the saved config file. |
| `PI_HANDOFF_DEBUG` | unset | Optional debug JSONL path. Use `1`/`true` for `<tmpdir>/pi-handoff-debug.jsonl`. Debug logs can contain sensitive conversation previews and metadata; delete them when done. |

**Model precedence:** `PI_HANDOFF_MODEL` → `/handoff-setup` choice → cheap-model
heuristic on your available models → the active conversation model.
**Threshold precedence:** `PI_HANDOFF_THRESHOLD` → `/handoff-setup` choice → `80%`.
**Compaction precedence:** `PI_HANDOFF_COMPACTION` → `/handoff-setup` choice → on.

## Privacy and generated files

Handoff generation sends the conversation to the configured summarizer model. The
resulting handoff document can contain sensitive session context: code, paths,
command output, project details, and anything pasted into the conversation.

By default the document is written to `.pi/handoff.md` with restrictive file
permissions on creation (`0600`). Keep `.pi/` gitignored, or set
`PI_HANDOFF_PATH` to a different private location. The debug log controlled by
`PI_HANDOFF_DEBUG` is also sensitive if enabled because it may include
conversation previews and compaction metadata.

## Notes / limitations

- Handoff generation is an extra summarizer-model call. With the default
  cheap-model heuristic the cost is usually small.
- Compaction enrichment **replaces** Pi's built-in compaction summarization with
  a call to your chosen summarizer model — it's a substitution, not an extra
  call.
- Injection on load is **one-shot**: the handoff is added to your next message's
  context so the model reads it once. It is not persisted as a session entry.

## Releasing (maintainers)

Releases are **tag-driven** and published to npm by GitHub Actions. There is no
build step — Pi loads the `.ts` source directly via jiti — so a release is just
*verify + publish*.

1. Update `CHANGELOG.md`: move items from `[Unreleased]` into a new version
   heading.
2. Bump the version (this commits `package.json` and creates a `vX.Y.Z` tag):
   ```bash
   npm version patch   # or minor / major
   git push --follow-tags
   ```
3. The [`Publish`](.github/workflows/publish.yml) workflow fires on the `v*` tag,
   asserts the tag matches `package.json`, typechecks, publishes to npm, and
   creates/updates the matching GitHub Release from that version's
   `CHANGELOG.md` notes.

Every push to `main` and every PR also runs the [`CI`](.github/workflows/ci.yml)
typecheck gate.

### One-time setup: npm Trusted Publishing (OIDC)

Publishing is **tokenless** — no `NPM_TOKEN` secret. Authorize this repo once on
npmjs.com:

1. npmjs.com → the `@ttiimmaahh/pi-handoff` package → **Settings** → **Trusted Publisher**.
2. Choose **GitHub Actions** and enter (case-sensitive, exact match):
   - **Organization or user:** `ttiimmaahh`
   - **Repository:** `pi-handoff`
   - **Workflow filename:** `publish.yml`
   - **Allowed actions:** `npm publish`
3. Save. The next `v*` tag publishes automatically, with provenance attestations.

> The first CI release must be a version newer than any previously published
> manual version — npm rejects republishing an existing version.

## Repo layout

```
.
├── package.json              # pi-package manifest + npm metadata + scripts
├── tsconfig.json             # editor support; pi runs the .ts directly
├── CHANGELOG.md              # Keep a Changelog; updated per release
├── LICENSE                   # MIT
├── .github/workflows/
│   ├── ci.yml                # typecheck gate on push to main + PRs
│   └── publish.yml           # tag-driven npm publish via OIDC trusted publishing
└── index.ts                  # ExtensionAPI factory, commands, hooks, handoff logic
```
