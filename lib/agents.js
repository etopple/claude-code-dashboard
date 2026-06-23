'use strict';

// Agent roster ("Pokédex") for the cc-scope AGENTS tab.
//
// Joins two things on agentType:
//   1. DEFINITIONS (static) — authored agent files (~/.claude/agents/*.md and
//      per-project .claude/agents/*.md). Gives role, model, owner (git author).
//   2. LIVE STATE — every subagent run Claude Code recorded under
//      projects/*/subagents/agent-*.{meta.json,jsonl}. Gives where they've been
//      (cwd/project), what they did (tools), which skills they used, run count,
//      last-seen, tokens, error rate.
//
// A defined agent that never ran reads "dormant"; a run agentType with no
// definition reads "wild". Pure read — nothing here writes or mutates state.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { classifyToolResult } = require('./store');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');

// --- definitions -----------------------------------------------------------

// Minimal YAML-frontmatter reader: flat `key: value` pairs only. Good enough
// for agent files (name/description/model/color); ignores the body.
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

// First human-readable sentence of an agent description (they tend to open with
// "Use this agent when…" then a wall of examples). Keeps the card scannable.
function firstSentence(desc) {
  if (!desc) return '';
  const clean = String(desc).replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = clean.search(/(?<=\.)\s/);
  const s = cut > 0 ? clean.slice(0, cut + 1) : clean;
  return s.length > 220 ? s.slice(0, 220) + '…' : s;
}

const ownerCache = new Map(); // file -> { owner, ts }
function gitOwner(file) {
  const cached = ownerCache.get(file);
  if (cached) return cached;
  let owner = null;
  try {
    owner = execFileSync('git', ['log', '-1', '--format=%an', '--', path.basename(file)], {
      cwd: path.dirname(file), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).trim() || null;
  } catch { owner = null; }
  ownerCache.set(file, owner);
  return owner;
}

function defDirs(cwds) {
  const dirs = new Set([path.join(HOME, '.claude', 'agents')]);
  if (process.env.CCSCOPE_AGENTS_ROOT) dirs.add(path.normalize(process.env.CCSCOPE_AGENTS_ROOT));
  for (const c of cwds) if (c) dirs.add(path.join(c, '.claude', 'agents'));
  return [...dirs];
}

function scanDefinitions(cwds) {
  const defs = new Map(); // name -> def
  for (const dir of defDirs(cwds)) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let raw = '';
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const fm = parseFrontmatter(raw);
      const name = fm.name || f.replace(/\.md$/, '');
      if (defs.has(name)) continue; // first dir wins (user global before project)
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch {}
      defs.set(name, {
        name,
        description: firstSentence(fm.description),
        model: fm.model || '',
        color: fm.color || '',
        owner: gitOwner(file),
        source: dir,
        updatedTs: mtime,
      });
    }
  }
  return defs;
}

// --- live runs -------------------------------------------------------------

// Aggregate one subagent transcript into a single run record. Same entry shape
// as a main transcript (type/message/timestamp/cwd), so the parse mirrors the
// store's: tool_use → tool/skill tallies, tool_result → error tally.
function parseRun(jsonl) {
  const run = {
    cwd: '', gitBranch: '', model: '', tools: new Map(), skills: new Set(),
    calls: 0, errors: 0, tokens: 0, firstTs: null, lastTs: null,
  };
  let raw = '';
  try { raw = fs.readFileSync(jsonl, 'utf8'); } catch { return run; }
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.cwd && !run.cwd) run.cwd = e.cwd;
    if (e.gitBranch && !run.gitBranch) run.gitBranch = e.gitBranch;
    const ts = Date.parse(e.timestamp) || null;
    if (ts) { if (!run.firstTs || ts < run.firstTs) run.firstTs = ts; if (!run.lastTs || ts > run.lastTs) run.lastTs = ts; }
    const m = e.message;
    if (e.type === 'assistant' && m) {
      if (m.model) run.model = m.model;
      if (m.usage) run.tokens += m.usage.output_tokens || 0;
      for (const b of m.content || []) {
        if (b && b.type === 'tool_use') {
          run.calls++;
          run.tools.set(b.name, (run.tools.get(b.name) || 0) + 1);
          if (b.name === 'Skill' && b.input) { const sk = b.input.skill || b.input.command; if (sk) run.skills.add(sk); }
        }
      }
    } else if (e.type === 'user' && m && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === 'tool_result' && b.is_error) run.errors++;
      }
    }
  }
  return run;
}

// Subagent transcripts live at projects/<project>/<session-uuid>/subagents/.
// Walk project → session → subagents; a meta.json + sibling jsonl is one run.
function scanRuns() {
  const runs = [];
  const subdirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name)); } catch { return []; } };
  for (const project of subdirs(PROJECTS)) {
    for (const session of subdirs(project)) {
      const sub = path.join(session, 'subagents');
      let metas = [];
      try { metas = fs.readdirSync(sub).filter((f) => f.endsWith('.meta.json')); } catch { continue; }
      for (const mf of metas) {
        let meta; try { meta = JSON.parse(fs.readFileSync(path.join(sub, mf), 'utf8')); } catch { continue; }
        const run = parseRun(path.join(sub, mf.replace(/\.meta\.json$/, '.jsonl')));
        run.agentType = meta.agentType || '(unknown)';
        run.lastDescription = meta.description || '';
        runs.push(run);
      }
    }
  }
  return runs;
}

// --- flavor ----------------------------------------------------------------

const projOf = (cwd) => (cwd || '').split(/[\\/]/).filter(Boolean).pop() || '(unknown)';

// A cosmetic "element type" from the dominant tool category — pure pet-Pokémon
// flavor, but a genuinely useful at-a-glance "what kind of agent is this".
function elementType(tools) {
  const cat = { research: 0, builder: 0, ops: 0, orchestrator: 0 };
  for (const [name, n] of tools) {
    if (/WebSearch|WebFetch|Grep|Glob|Read|Search/i.test(name)) cat.research += n;
    else if (/Edit|Write|NotebookEdit/i.test(name)) cat.builder += n;
    else if (/Bash|PowerShell|Shell/i.test(name)) cat.ops += n;
    else if (/Agent|Task|Workflow/i.test(name)) cat.orchestrator += n;
  }
  let best = 'mixed', max = 0;
  for (const [k, v] of Object.entries(cat)) if (v > max) { max = v; best = k; }
  return max ? best : 'mixed';
}

// --- public API ------------------------------------------------------------

function buildRoster() {
  const runs = scanRuns();
  const cwds = new Set(runs.map((r) => r.cwd).filter(Boolean));
  const defs = scanDefinitions(cwds);

  // group runs by agentType
  const byType = new Map();
  for (const r of runs) {
    let a = byType.get(r.agentType);
    if (!a) {
      a = { agentType: r.agentType, runs: 0, tokens: 0, calls: 0, errors: 0,
        firstTs: null, lastTs: null, tools: new Map(), skills: new Set(),
        projects: new Map(), models: new Set(), lastDescription: '' };
      byType.set(r.agentType, a);
    }
    a.runs++;
    a.tokens += r.tokens; a.calls += r.calls; a.errors += r.errors;
    if (r.firstTs && (!a.firstTs || r.firstTs < a.firstTs)) a.firstTs = r.firstTs;
    if (r.lastTs && (!a.lastTs || r.lastTs > a.lastTs)) { a.lastTs = r.lastTs; a.lastDescription = r.lastDescription || a.lastDescription; }
    for (const [t, n] of r.tools) a.tools.set(t, (a.tools.get(t) || 0) + n);
    for (const sk of r.skills) a.skills.add(sk);
    if (r.model) a.models.add(r.model);
    const pj = projOf(r.cwd);
    a.projects.set(pj, (a.projects.get(pj) || 0) + 1);
  }

  const now = Date.now();
  const names = new Set([...byType.keys(), ...defs.keys()]);
  const roster = [];
  for (const name of names) {
    const live = byType.get(name);
    const def = defs.get(name);
    const tools = live ? live.tools : new Map();
    const runCount = live ? live.runs : 0;
    const lastTs = live ? live.lastTs : null;
    const status = lastTs && now - lastTs < 2 * 60 * 1000 ? 'active'
      : !def ? 'wild'
      : runCount === 0 ? 'dormant'
      : 'idle';
    roster.push({
      name,
      defined: !!def,
      description: (def && def.description) || (live && firstSentence(live.lastDescription)) || '',
      owner: def ? def.owner : null,
      model: (def && def.model) || (live && [...live.models][0]) || '',
      color: def ? def.color : '',
      updatedTs: def ? def.updatedTs : null,
      status,
      element: elementType(tools),
      level: Math.floor(Math.log2(runCount + 1)) + 1,
      runs: runCount,
      tokens: live ? live.tokens : 0,
      calls: live ? live.calls : 0,
      errors: live ? live.errors : 0,
      errorRate: live && live.calls ? live.errors / live.calls : 0,
      firstTs: live ? live.firstTs : null,
      lastTs,
      lastTask: live ? firstSentence(live.lastDescription) : '',
      skills: live ? [...live.skills].filter(Boolean).sort() : [],
      topTools: [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => ({ tool: t, count: n })),
      projects: live ? [...live.projects.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => ({ project: p, count: n })) : [],
    });
  }

  // sort: active first, then by recency, then by run volume
  const rank = { active: 0, idle: 1, wild: 2, dormant: 3 };
  roster.sort((a, b) => (rank[a.status] - rank[b.status]) || ((b.lastTs || 0) - (a.lastTs || 0)) || (b.runs - a.runs));

  const counts = { total: roster.length, defined: roster.filter((r) => r.defined).length,
    active: roster.filter((r) => r.status === 'active').length,
    wild: roster.filter((r) => r.status === 'wild').length,
    dormant: roster.filter((r) => r.status === 'dormant').length };
  const totalRuns = roster.reduce((n, r) => n + r.runs, 0);

  return { roster, counts, totalRuns };
}

module.exports = { buildRoster };
