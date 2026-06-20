# Claude Code Dashboard (cc-scope)

Silent observer for Claude Code: a passthrough API proxy + transcript tailer + live dashboard.
Built to answer one question: **what is Claude Code actually doing during those long autonomous runs?**

## How it works

```
claude (CLI) ──ANTHROPIC_BASE_URL──▶ proxy :4000 ──HTTPS──▶ api.anthropic.com
                                       │ tee (never blocks traffic)
                                       ▼
                              capture pipeline ──▶ logs/<date>/wire.jsonl
                                       │
~/.claude/projects/**/*.jsonl ──tail──▶ store (join on requestId)
                                       │
                                       ▼
                              dashboard :4001  (live via SSE)
```

Two independent data sources, joined exactly:

- **Wire captures** — full API round-trips (system prompt, message array, tools offered, streaming events reconstructed, timings). Only present when you launch Claude Code via `ccspy`.
- **Transcripts** — Claude Code's own session JSONL (turns, tool calls, sub-agent sidechains, token usage). Present for *every* session, proxied or not.

The transcript's `requestId` equals the API's `request-id` response header — that's the join key.

## Try it in 60 seconds

```bash
git clone https://github.com/etopple/claude-code-dashboard
cd claude-code-dashboard
npm run demo
```

Then open **http://127.0.0.1:4001**. Demo mode points the dashboard at `fixtures/claude-projects`, a tiny synthetic Claude Code transcript with tool calls, token usage, and repeated-call data. No real Claude Code history or API key is required.

## Usage

```cmd
bin\ccspy.cmd -p "do the thing"     :: or just: ccspy <any claude args>
```

```bash
bin/ccspy -p "do the thing"         # or just: ccspy <any claude args>
```

`ccspy` starts the server if needed, sets `ANTHROPIC_BASE_URL=http://127.0.0.1:4000`, and runs `claude`
with all your arguments. Plain `claude` is never touched — observation is opt-in per invocation.

Dashboard: **http://127.0.0.1:4001**

Run the server standalone: `node server.js` (env: `CCSCOPE_PROXY_PORT`, `CCSCOPE_DASH_PORT`, `CCSCOPE_BACKFILL_HOURS`, `CCSCOPE_TRANSCRIPT_ROOT`).

## Views

Header tabs:

- **Session** (`/`) — per-session analytics: autonomy banner, gallery, inspector, tool counts, tokens. Every session (proxied or not).
- **Flounder** — tool-call failure taxonomy + error-rate-over-time (below).
- **Live feed** — universal, hook-fed activity stream across every session/tool (below).
- **Skills** — portable skill inventory across tools + gaps to build (below).
- **Daily / ROI** — per-day cost roll-up and a leverage/ROI view.
- **Live console** (`/live`) — watch a turn stream **token-by-token**: thinking, tool calls + args, results, text. Needs `ccspy` (the live proxy stream).

## Live console

The "watch it think" view. Each proxied `/v1/messages` turn renders as a card:

- 🧠 **thinking** — streams live if Claude Code requested summarized thinking; otherwise shows "thought for Ns (summary omitted)".
- 🔧 **tool call** — tool name + arguments streaming in, then `awaiting result…`, then ✓/✗ with the result size once the next turn's request carries the `tool_result`.
- 💬 **text** — the assistant's reply, streaming.
- footer — stop reason + token usage per turn.

Claude Code housekeeping turns (title generation, quota pings — they offer zero tools) are filtered out so you only see real agent work. A blinking cursor marks the block that's actively streaming. `?replay=<jsonl>` renders a captured stream statically (dev aid).

## Dashboard

- **Autonomy banner** — turns since last human input, max streak, sub-agent spawns, top repeated identical call. The "Ralph loop detector": a true batch loop shows as a hot repeated-call counter; a normal agentic run shows as a high autonomous-turn streak with varied tool calls.
- **Session gallery** — every session as a card with a **barcode strip**: one bar per turn (amber = tool call, green = answer, cyan = sub-agent, orange = tool error, red = API error) and a tick for each human input. Cards are grouped into tiers — **Marathon** (60+ turns), **Autonomous** (15+ unbroken chain — the loop-watch tier), **Mixed** (human-guided), **Quick**. Each card shows `N turns · chain K · $cost · date`, where *chain* is the longest run with no human input. A long mostly-amber barcode = a long autonomous run. Click a card to select it (updates the panels below); click a bar to open that turn in the inspector; hover for turn type.
- **Inspector** — overview / raw request (system prompt, full context) / reconstructed response (thinking, text, tool_use) / raw wire record.
- **Tool calls** — counts per tool; repeated-identical-call list (hash of name+input).
- **Tokens** — per-turn output bars, cumulative usage, cache-hit ratio, estimated cost (edit `public/pricing.json`).
- **Account-wide (Console)** — *optional, separate data source.* Aggregate cost/usage across your whole Anthropic **API organization** (every machine, web, etc.), pulled from the Console Cost Report API. Set `CCSCOPE_ADMIN_KEY` to a Console Admin key (`sk-ant-admin…`) and restart. Without it the panel shows setup instructions. Note: this is **API-org** billing — a Claude.ai Pro/Max subscription is billed separately and is not exposed by this API.

## Flounder — tool-call failure taxonomy

Most "errors" in long agent runs aren't model/API failures — they're fragile tool calls (bad shell, wrong path, raw cloud-CLI, empty searches retried as failures). **Flounder** classifies every tool result (from transcripts, so it covers *all* sessions) into a taxonomy — `shell_failure`, `stale_edit`, `file_not_found`, `validation`, `expected_empty`, `unknown_tool`, `webfetch_miss`, … — and shows:

- headline error rate, errored calls, and **output tokens burned on errored turns**
- per-tool error rate + a **retry-spiral** list (the same call failing 2+ times — the floundering signature)
- **error rate over time** (daily, with a 7d-vs-prior delta) so a fix shows a measurable before/after
- **gaps you need**: discipline-skill suggestions ranked by the failures they'd prevent

Classes are heuristic; the detail panel shows real (secret-redacted) result previews so you can tune them.

## Live feed — universal, hook-based

The `/live` console needs the proxy. **Live feed** is fed by Claude Code **hooks** instead, so it lights up for *every* session and every tool — no proxy required. Point hooks at the dashboard's `/ingest` endpoint:

```json
// ~/.claude/settings.json
{
  "hooks": {
    "PostToolUse":      [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4001/ingest", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4001/ingest", "timeout": 5 }] }],
    "Stop":             [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4001/ingest", "timeout": 5 }] }]
  }
}
```

`/ingest` accepts the raw hook JSON and shapes it server-side; result previews are secret-redacted and truncated. (`bin/cc-scope-hook.js` is included for setups that prefer a command hook.)

## Skills — portable inventory

`SKILL.md` (Agent Skills) is read by Claude Code, Codex, and Claude Cowork alike. **Skills** inventories yours across those tools — per-tool presence (`ok` / `staged` / `drift` / `missing`) and, cross-referenced with Flounder, which discipline skills you still *need*. Set `CCSCOPE_SKILLS_ROOT` to a canonical skills repo (a folder of `<name>/SKILL.md`) to track coverage against it; otherwise it scans the tools' skill dirs directly.

## Digest

`node bin/cc-scope-digest.js` prints a terse readout — floundering trend, top skill gap, coverage — for a daily briefing or scheduled task (`--json` for machine output).

## Scope — what each view covers

- **Local CLI history** (gallery, tokens, tools) — reads `CCSCOPE_TRANSCRIPT_ROOT` if set, otherwise `~/.claude/projects/` on this machine. By default loads **all** history; set `CCSCOPE_BACKFILL_HOURS=24` to limit to recent. Covers every local Claude Code CLI session, proxied or not.
- **Wire detail** (inspector, live console, timings) — only sessions launched via `ccspy` on this machine.
- **Account-wide** (Console panel) — org-level totals across everything, via Admin key. The only view that isn't local.
- Not captured anywhere: other machines' transcripts, Claude Code on the web/desktop app, cloud agents.

## First-run troubleshooting

- **Dashboard is blank** — no transcript JSONL files were found. Try `npm run demo`, or set `CCSCOPE_TRANSCRIPT_ROOT` to a directory containing Claude Code transcript files.
- **`/live` is blank** — launch Claude through `ccspy`; plain `claude` sessions only populate transcript-side dashboard views.
- **No request/response/raw wire tabs** — that session was not proxied through `ccspy`, so only transcript-side data is available.
- **Port already in use** — set `CCSCOPE_DASH_PORT` and/or `CCSCOPE_PROXY_PORT` before starting the server.
- **Corporate TLS proxy/WARP/Zscaler errors** — set `NODE_EXTRA_CA_CERTS` to the proxy root CA PEM.
- **Cost looks wrong** — edit `public/pricing.json`; prices are examples matched by model-id prefix.

## Notes & caveats

- **Auth headers are scrubbed** (`authorization`, `x-api-key`, `cookie`) before anything is persisted or displayed. Wire logs still contain full prompts/responses — treat `logs/` as sensitive.
- The proxy strips `accept-encoding` upstream so captures stay plain-text. That is its only request modification.
- Behind a TLS-inspecting proxy (corporate root CA, Cloudflare WARP, Zscaler, etc.)? Set `NODE_EXTRA_CA_CERTS` to your root CA PEM. The launchers also auto-detect the Cloudflare WARP cert (`C:\ProgramData\Cloudflare\installed_cert.pem`) if it's present and the var isn't already set.
- Sessions not run through `ccspy` still appear on the dashboard (transcript side only) — no wire timings, bars drawn dim at their transcript timestamps.
- Zero npm dependencies; no build step.

## Development checks

```bash
npm run check
```

This runs `node --check` across the server, library files, browser scripts, and Node helper scripts.
