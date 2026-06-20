'use strict';

// Skill inventory scanner for the cc-scope SKILLS tab.
//
// Reconciles three things into one catalog:
//   1. the canonical agent-skills repo (source of truth, if present),
//   2. the live tool dirs (Claude / Codex skills + Claude commands) — for
//      PRESENCE and DRIFT,
//   3. "needed" gaps inferred from the FLOUNDER failure taxonomy — the skills
//      your error data says you should build but haven't.
//
// Pure read. No tool dir is modified here (that's skillsync's job).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const HOME = os.homedir();
// Canonical repo: env override, else the sibling agent-skills repo next to cc-scope.
const CANON = process.env.CCSCOPE_SKILLS_ROOT
  ? path.normalize(process.env.CCSCOPE_SKILLS_ROOT)
  : path.join(path.dirname(__dirname), '..', 'agent-skills', 'skills');

// Tools that read SKILL.md folders. cowork is cloud — presence = staged bundle.
const TOOLS = [
  { key: 'claude', label: 'Claude Code', dir: path.join(HOME, '.claude', 'skills') },
  { key: 'codex', label: 'Codex', dir: path.join(HOME, '.codex', 'skills') },
  // Cowork is cloud — cc-scope can only see the local upload bundle, never what's
  // actually live in claude.ai. So a present+matching bundle reads 'staged', not 'ok'.
  { key: 'cowork', label: 'Cowork', dir: path.join(path.dirname(CANON), '.cowork-bundle'), bundle: true },
];
const COMMANDS_DIR = path.join(HOME, '.claude', 'commands');

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function isSkillDir(d) { return exists(path.join(d, 'SKILL.md')); }
function listSkillDirs(base) {
  if (!exists(base)) return [];
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isSkillDir(path.join(base, e.name)))
      .map((e) => e.name);
  } catch { return []; }
}
function skillHash(dir) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, 'SKILL.md'))).digest('hex').slice(0, 12); }
  catch { return null; }
}

// Minimal SKILL.md frontmatter reader: name, description (incl. folded >/|), tags,
// plus a short body excerpt for the "what it does" panel.
function parseSkillMd(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { name: '', description: '', body: '' }; }
  const out = { name: '', description: '', tags: [], body: '' };
  let body = raw;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    body = m[2] || '';
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const km = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
      if (!km) continue;
      const key = km[1].toLowerCase();
      let val = km[2];
      // folded/literal block scalar: collect indented continuation lines
      if (val === '' || val === '>' || val === '|' || val === '>-' || val === '|-') {
        const buf = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) { buf.push(lines[++i].trim()); }
        val = buf.join(' ');
      }
      val = val.replace(/^["']|["']$/g, '');
      if (key === 'name') out.name = val;
      else if (key === 'description') out.description = val;
      else if (key === 'tags') out.tags = val.replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  out.body = body.replace(/^#.*$/m, '').trim().replace(/\s+/g, ' ').slice(0, 600);
  return out;
}
function readMeta(dir) {
  const f = path.join(dir, 'skill.meta.json');
  if (exists(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* ignore */ } }
  return null;
}

// FLOUNDER class -> the discipline skill it argues for. nameHints lets us detect
// whether you already have a skill that covers it (so it's "covered", not "needed").
const CLASS_TO_SKILL = {
  stale_edit: { skill: 'read-before-edit', why: 'Edit/Write precondition failures — read first, re-read after external change.', hints: ['read-before-edit', 'edit-discipline', 'file-discipline'] },
  shell_failure: { skill: 'command-discipline', why: 'Fragile shell calls — preflight cwd/repo state, one canonical command shape.', hints: ['command-discipline', 'shell', 'bash-discipline'] },
  aws_format: { skill: 'aws-command', why: 'Malformed raw AWS calls — a typed wrapper for auth + flags.', hints: ['aws'] },
  file_not_found: { skill: 'path-preflight', why: 'Assumed paths — search/glob before read/edit.', hints: ['path', 'preflight'] },
  expected_empty: { skill: 'search-result-discipline', why: 'Empty results retried as failures — "no matches is a valid answer".', hints: ['search', 'result-discipline'] },
  unknown_tool: { skill: 'tool-discovery', why: 'Invented/unregistered tools — search_tools before invoke_tool.', hints: ['tool-discovery', 'mcp'] },
  brain_validation: { skill: 'brain-capture', why: 'Rejected Brain captures — shape + validate before sending.', hints: ['brain', 'capture'] },
};

function buildCatalog(errorRollup) {
  const canonNames = new Set(listSkillDirs(CANON));
  // union of every skill name we can see anywhere
  const names = new Set(canonNames);
  for (const t of TOOLS) for (const n of listSkillDirs(t.dir)) names.add(n);

  const skills = [];
  for (const name of [...names].sort()) {
    const canonDir = path.join(CANON, name);
    const isCanon = canonNames.has(name);
    const srcDir = isCanon ? canonDir : (TOOLS.map((t) => path.join(t.dir, name)).find(isSkillDir) || canonDir);
    const md = parseSkillMd(path.join(srcDir, 'SKILL.md'));
    const meta = isCanon ? readMeta(canonDir) : null;
    const canonHash = isCanon ? skillHash(canonDir) : null;

    const presence = {};
    for (const t of TOOLS) {
      const td = path.join(t.dir, name);
      if (!isSkillDir(td)) { presence[t.key] = 'missing'; continue; }
      const h = skillHash(td);
      if (canonHash && h !== canonHash) presence[t.key] = 'drift';
      else presence[t.key] = t.bundle ? 'staged' : 'ok'; // bundle = staged for upload, not confirmed live
    }
    let mtime = 0;
    try { mtime = fs.statSync(path.join(srcDir, 'SKILL.md')).mtimeMs; } catch { /* ignore */ }

    skills.push({
      name: md.name || name,
      slug: name,
      kind: 'skill',
      status: (meta && meta.status) || 'active',
      description: md.description || '',
      body: md.body || '',
      tags: (meta && meta.tags && meta.tags.length) ? meta.tags : md.tags,
      targets: (meta && meta.targets) || TOOLS.map((t) => t.key),
      canonical: isCanon,
      presence,
      mtime,
      coverage: Object.values(presence).filter((v) => v === 'ok' || v === 'staged').length,
    });
  }

  // Claude slash-commands — part of "what you have", Claude-only, not synced.
  const commands = [];
  if (exists(COMMANDS_DIR)) {
    for (const f of fs.readdirSync(COMMANDS_DIR).filter((x) => x.endsWith('.md'))) {
      const md = parseSkillMd(path.join(COMMANDS_DIR, f));
      commands.push({ name: md.name || f.replace(/\.md$/, ''), slug: f.replace(/\.md$/, ''), kind: 'command', description: md.description || '', body: md.body || '' });
    }
  }

  // Needed gaps from the failure taxonomy.
  const haveBlob = skills.map((s) => (s.slug + ' ' + (s.tags || []).join(' ')).toLowerCase());
  const needed = [];
  const classes = (errorRollup && errorRollup.classes) || [];
  for (const c of classes) {
    const map = CLASS_TO_SKILL[c.cls];
    if (!map) continue;
    const covered = haveBlob.some((b) => map.hints.some((h) => b.includes(h)));
    needed.push({ skill: map.skill, fromClass: c.cls, failures: c.count, why: map.why, covered });
  }
  needed.sort((a, b) => (a.covered - b.covered) || (b.failures - a.failures));

  const counts = {
    total: skills.length,
    active: skills.filter((s) => s.status === 'active').length,
    drift: skills.filter((s) => Object.values(s.presence).includes('drift')).length,
    commands: commands.length,
    needed: needed.filter((n) => !n.covered).length,
    byTool: Object.fromEntries(TOOLS.map((t) => [t.key, skills.filter((s) => s.presence[t.key] === 'ok' || s.presence[t.key] === 'staged').length])),
  };

  return {
    tools: TOOLS.map((t) => ({ key: t.key, label: t.label })),
    canonicalRoot: exists(CANON) ? CANON : null,
    skills, commands, needed, counts,
  };
}

module.exports = { buildCatalog };
