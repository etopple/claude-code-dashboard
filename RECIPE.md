# Claude Code Dashboard (cc-scope) — Recipe

Reproducible setup + operation for the Claude Code flight recorder. Clone → run `ccspy` → watch `http://127.0.0.1:4001`. Zero npm deps, no build step.

---

## 1. What it is (30-second mental model)

```
claude (CLI) ──ANTHROPIC_BASE_URL──▶ proxy :4000 ──HTTPS──▶ api.anthropic.com
                                       │ tee (never blocks)
                                       ▼
                              logs/<date>/wire.jsonl   (full round-trips)
~/.claude/projects/**/*.jsonl ──tail──▶ store  (joined on requestId)
Claude Code hooks ──HTTP POST──▶ /ingest ──▶ store  (universal live feed)
                                       ▼
                              dashboard :4001  (live via SSE)
```

Three data sources:
- **Wire captures** — full API round-trips. Only for sessions launched via `ccspy`. Joined to transcripts on `requestId` = the API `request-id` header.
- **Transcripts** — Claude Code's own session JSONL. Present for *every* local session, proxied or not. Drives the gallery, tokens, ROI, and the FLOUNDER error taxonomy.
- **Hook events** — a native Claude Code `http` hook POSTs each tool call / prompt / stop to `/ingest`, powering the LIVE FEED. Works for *every* session with zero proxy, no `ccspy` (see §4b).

---

## 1b. Quick demo (no Claude history required)

```bash
git clone https://github.com/etopple/claude-code-dashboard
cd claude-code-dashboard
npm run demo
```

Opens on **http://127.0.0.1:4001** pointed at the bundled `fixtures/claude-projects` — a tiny synthetic transcript with tool calls, token usage, and repeated-call data. No real history or API key needed. `npm run check` runs `node --check` across the server, library, and browser scripts.

---

## 2. Ingredients (prerequisites)

| Need | Example location | Notes |
|------|------------------|-------|
| Node | `C:\tools\node` | Any Node ≥ 18, matching your OS arch (win-x64 or win-arm64). Must be on PATH. |
| Cloudflare WARP cert | `C:\ProgramData\Cloudflare\installed_cert.pem` | Only if WARP does TLS inspection. The launcher sets `NODE_EXTRA_CA_CERTS` to it. |
| Claude Code CLI | `claude` on PATH | The thing being observed. |
| Repo | `claude-code-dashboard` | Cloned to your install dir (examples below use `C:\claude\cc-scope`). |

---

## 3. Setup on a fresh machine

```bash
# clone (swap in your own fork/clone URL)
git clone https://github.com/<you>/claude-code-dashboard C:/claude/cc-scope

# put node + the ccspy launcher on the USER PATH (PowerShell)
```
```powershell
$add = @("C:\tools\node","C:\claude\cc-scope\bin")
$cur = ([Environment]::GetEnvironmentVariable("Path","User") -split ';') | Where-Object { $_ }
$new = $cur + ($add | Where-Object { $cur -notcontains $_ })
[Environment]::SetEnvironmentVariable("Path", ($new -join ';'), "User")
```
Then **open a new terminal** (PATH changes only apply to new shells) and verify:
```powershell
node --version ; (Get-Command ccspy).Source ; (Get-Command claude).Source
```
If WARP isn't installed/inspecting on that machine, the cert line in `bin/ccspy.cmd` is harmless (Node ignores a missing `NODE_EXTRA_CA_CERTS`). If WARP *is* present, confirm the cert path exists.

---

## 4. Daily use

Run anything you'd normally run with `claude`, but through `ccspy`:
```cmd
ccspy                          :: interactive session (watch it on /live)
ccspy -p "do the thing"        :: one-shot
ccspy <any claude args>
```
`ccspy` auto-starts the server if it's not up, sets `ANTHROPIC_BASE_URL=http://127.0.0.1:4000`, and runs `claude`. Plain `claude` is never touched — observation is opt-in per invocation.

Dashboard: **http://127.0.0.1:4001**

---

## 4b. Enable the LIVE FEED (hook, not proxy)

The **Live feed** captures *every* Claude Code session — proxied or not — because it's driven by a Claude Code hook rather than the `ccspy` proxy. Wire it once in `~/.claude/settings.json`.

**Preferred — native `http` hook (zero process spawn).** The server accepts the raw hook JSON at `POST /ingest` and normalizes it server-side. Add a hook to each event you care about (`PostToolUse` is the useful one; `UserPromptSubmit` / `Stop` / `SubagentStop` / `Notification` round it out):

```json
{
  "hooks": {
    "PostToolUse": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:4001/ingest", "timeout": 2 } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:4001/ingest", "timeout": 2 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:4001/ingest", "timeout": 2 } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:4001/ingest", "timeout": 2 } ] }
    ]
  }
}
```

**Fallback — command hook.** If your Claude Code build predates the `http` hook type, point a `command` hook at the bundled bridge, which shapes the event and POSTs it (always exits 0, never blocks):

```json
{ "type": "command", "command": "node \"<repo>/bin/cc-scope-hook.js\"" }
```

Notes:
- Hooks only load in sessions that **start after** the edit. Open `/hooks` once or start a new `claude` session — the current one won't fire them.
- The server replies fast and the hook is capped at a short timeout, so it can never stall the agent. If the dashboard is down, the hook silently no-ops.
- Honors `CCSCOPE_DASH_PORT` (default `4001`) via the bridge; the native `http` hook needs the URL updated by hand if you move the port.
- Previews are **redacted** (API keys, tokens, JWTs, basic-auth URLs, `key=value`) and truncated before storage.

---

## 5. The views

Seven tabs at `/` (the nav is pinned top-left), plus the standalone live console at `/live`.

| View | URL | Covers | Needs ccspy? |
|------|-----|--------|--------------|
| **Session** | `/` → session | autonomy banner, barcode gallery, tool counts, per-turn tokens, inspector | no (transcript side works for all) |
| **Agents** | `/` → agents | a card per agent type: the definition (role, model, owner from git author) joined to its live runs — count, tokens, error rate, last-seen, skills used, top tools, projects. Status: active / idle / wild (ran, no definition) / dormant (defined, never run). Sourced from `projects/*/*/subagents/`. | no |
| **Flounder** | `/` → flounder | tool-call failure taxonomy from transcripts: per-tool error rate, retry spirals, tokens burned on errored turns, error-rate-over-time chart + **7d vs prior 7d** delta. Barcode gains an `x` mark for tool errors (distinct from `r` = HTTP error). | no |
| **Live feed** | `/` → live feed | universal hook-fed activity stream — each tool call / prompt / stop / notification as it happens, secrets redacted. Fed by the `http` hook (§4b), **not** the proxy. | no (needs the hook, not ccspy) |
| **Skills** | `/` → skills | portable-skill inventory: reconciles your canonical `agent-skills` repo against the live tool dirs (Claude / Codex / Cowork presence + drift) and Claude commands, with "gaps you need" derived from the Flounder taxonomy. Cowork reads `staged ⇡` (cc-scope sees only the local upload bundle, not cloud state). | no |
| **Daily** | `/` → daily | per-local-day roll-up across **all local history** (not today): day · sessions · turns · in · out · cacheR · cacheW · cost + cost/day chart + by-model | no |
| **ROI** | `/` → roi | leverage → hours → value → ROI under your editable assumptions; by-project + per-session override | no |
| **Live console** | `/live` | watch a turn stream token-by-token: thinking marker, tool calls + args, results, text | **yes** |

---

## 6. Seasoning (env vars)

Set before launching the server (or add to `bin/ccspy.cmd`).

| Var | Default | Effect |
|-----|---------|--------|
| `CCSCOPE_BACKFILL_HOURS` | `0` (all history) | Limit transcript load, e.g. `24` or `168` (7d). Use to scope the Daily/ROI range. |
| `CCSCOPE_DASH_PORT` | `4001` | Dashboard port. |
| `CCSCOPE_PROXY_PORT` | `4000` | Proxy port (must match `ANTHROPIC_BASE_URL`). |
| `CCSCOPE_UPSTREAM` | `api.anthropic.com` | Upstream API host. |
| `CCSCOPE_ADMIN_KEY` | (unset) | Console Admin key (`sk-ant-admin…`) to populate the account-wide panel. Org-level API billing only — *not* Claude.ai Pro/Max. |
| `CCSCOPE_SKILLS_ROOT` | sibling `agent-skills/skills` | Canonical skills repo the SKILLS tab reconciles against. Point it at wherever your source-of-truth skills live. |
| `CCSCOPE_TRANSCRIPT_ROOT` | `~/.claude/projects` | Transcript directory to tail. `npm run demo` points this at the bundled `fixtures/` so you can see the dashboard with no real history. |

**ROI knobs** (rate, min/edit, min/command, min/ask) and per-session hour overrides live in **browser localStorage**, not on the server — per machine/browser.

---

## 7. Gotchas (field-tested)

- **You can't read Claude's internal thinking.** Claude Code requests `thinking:{type:"adaptive"}`, but the summarized thinking text is **omitted over the wire** — `/live` shows "thought for Ns (summary omitted)". You see tool calls, results, timings, and reasoning the model writes into its *answer*. Forcing `MAX_THINKING_TOKENS` costs ~20× output burn for no readable payoff. Don't.
- **Daily/ROI = whole local history, not today.** Date range is shown; use `CCSCOPE_BACKFILL_HOURS` to shorten.
- **ROI is a modeled number, not a measurement.** It's `hours × rate ÷ cost` where hours = your minute-knobs × output counts. Tune the knobs or rate individual sessions; the headline moves with your assumptions by design.
- **`logs/` is sensitive.** Auth headers are scrubbed (`<redacted>`), but full prompts/responses are stored. Gitignored — keep it that way.
- **PATH only updates new terminals.** "ccspy not recognized" after install = reopen the shell.
- **Stale server on a port.** If a launch hangs, an old server may own `:4001`/`:4000`. Kill it:
  ```powershell
  4000,4001 | % { Get-NetTCPConnection -LocalPort $_ -State Listen -EA 0 | % { Stop-Process -Id $_.OwningProcess -Force } }
  ```

---

## 8. Update / redeploy

```bash
cd C:/claude/cc-scope
git pull
# restart the server so store.js / server.js changes take effect:
```
```powershell
4000,4001 | % { Get-NetTCPConnection -LocalPort $_ -State Listen -EA 0 | % { Stop-Process -Id $_.OwningProcess -Force } }
$env:Path = "C:\tools\node;$env:Path"
$env:NODE_EXTRA_CA_CERTS = "C:\ProgramData\Cloudflare\installed_cert.pem"
Start-Process node -ArgumentList "C:\claude\cc-scope\server.js" -WindowStyle Hidden
```
Front-end edits (`public/*`) are served fresh on reload — no restart. Back-end edits (`server.js`, `lib/*`) need the restart above. The next `ccspy` invocation also restarts the server if it's down.

---

## 9. File map

```
server.js            HTTP: proxy wiring, dashboard routes, /ingest hook sink, wire persistence
bin/ccspy(.cmd)      launcher — sets env, starts server, runs claude
bin/cc-scope-hook.js hook bridge — shapes a Claude hook event and POSTs it to /ingest (command-hook fallback)
bin/cc-scope-digest.js  terse weekly readout (trend, top gaps, coverage) for a morning briefing
lib/proxy.js         passthrough proxy + capture/live tee
lib/sse.js           parse SSE, reconstruct full message from deltas
lib/livestream.js    incremental SSE → live-console events
lib/store.js         transcript model; /api summaries: sessions, dailyRollup, roiRollup, errorRollup, liveFeed; redact()
lib/skills.js        skill inventory: canonical repo × live tool dirs (presence + drift) + needed gaps
lib/agents.js        agent roster: definitions (~/.claude/agents) × live subagent runs, owner via git author
bin/demo.js          `npm run demo` — serve the bundled fixtures/ so the dashboard renders with no real history
bin/check.js         `npm run check` — node --check across server, lib, and browser scripts
lib/transcripts.js   tail ~/.claude/projects/**/*.jsonl
lib/usage.js         account-wide Console cost report (optional admin key)
public/              dashboard (index/app/style) + live (live.html/js) + pricing.json
```
Pricing is editable: `public/pricing.json`, matched by model-id prefix, USD per 1M tokens.

**Weekly digest:** `node bin/cc-scope-digest.js` prints a terse floundering-trend + top skill-gaps + coverage readout (add `--json` for machine-readable). Reads the running dashboard's API; if the server is down it says so and exits 0 — safe to fold into a scheduled morning briefing.
