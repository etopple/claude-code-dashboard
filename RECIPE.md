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
                                       ▼
                              dashboard :4001  (live via SSE)
```

Two data sources, joined on `requestId` = the API `request-id` header:
- **Wire captures** — full API round-trips. Only for sessions launched via `ccspy`.
- **Transcripts** — Claude Code's own session JSONL. Present for *every* local session, proxied or not.

---

## 2. Ingredients (prerequisites)

| Need | This machine | Notes |
|------|--------------|-------|
| Node | `C:\claude\tools\node-v22.22.0-win-x64` | Any Node ≥ 18. Must be on PATH. |
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
$add = @("C:\claude\tools\node-v22.22.0-win-x64","C:\claude\cc-scope\bin")
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

## 5. The four views

| View | URL | Covers | Needs ccspy? |
|------|-----|--------|--------------|
| **Session** | `/` | autonomy banner, barcode gallery, tool counts, per-turn tokens, inspector | no (transcript side works for all) |
| **Daily** | `/` → daily tab | per-local-day roll-up across **all local history** (not today): day · sessions · turns · in · out · cacheR · cacheW · cost + cost/day chart + by-model | no |
| **ROI** | `/` → roi tab | leverage → hours → value → ROI under your editable assumptions; by-project + per-session override | no |
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
$env:Path = "C:\claude\tools\node-v22.22.0-win-x64;$env:Path"
$env:NODE_EXTRA_CA_CERTS = "C:\ProgramData\Cloudflare\installed_cert.pem"
Start-Process node -ArgumentList "C:\claude\cc-scope\server.js" -WindowStyle Hidden
```
Front-end edits (`public/*`) are served fresh on reload — no restart. Back-end edits (`server.js`, `lib/*`) need the restart above. The next `ccspy` invocation also restarts the server if it's down.

---

## 9. File map

```
server.js          HTTP: proxy wiring, dashboard routes, wire persistence
bin/ccspy(.cmd)    launcher — sets env, starts server, runs claude
lib/proxy.js       passthrough proxy + capture/live tee
lib/sse.js         parse SSE, reconstruct full message from deltas
lib/livestream.js  incremental SSE → live-console events
lib/store.js       transcript model; /api summaries: sessions, dailyRollup, roiRollup
lib/transcripts.js tail ~/.claude/projects/**/*.jsonl
lib/usage.js       account-wide Console cost report (optional admin key)
public/            dashboard (index/app/style) + live (live.html/js) + pricing.json
```
Pricing is editable: `public/pricing.json`, matched by model-id prefix, USD per 1M tokens.
