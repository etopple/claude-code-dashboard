#!/usr/bin/env node
'use strict';

// cc-scope digest — a terse weekly readout so the dashboard pulls you back
// instead of going stale. Prints floundering trend + the top discipline-skill
// gaps + skill coverage. Fold into your morning-briefing or a scheduled task.
//
//   node bin/cc-scope-digest.js          # human text
//   node bin/cc-scope-digest.js --json   # machine-readable
//
// Reads the running dashboard's API (CCSCOPE_DASH_PORT, default 4001). If the
// server isn't up, it says so and exits 0 (never noisy in a briefing pipeline).

const http = require('node:http');
const PORT = Number(process.env.CCSCOPE_DASH_PORT || 4001);
const asJson = process.argv.includes('--json');

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
const pct = (r) => (r * 100).toFixed(1) + '%';
function rate(days) { const s = days.reduce((a, x) => ({ e: a.e + x.errored, t: a.t + x.total }), { e: 0, t: 0 }); return s.t ? s.e / s.t : 0; }

(async () => {
  let err, sk;
  try { [err, sk] = await Promise.all([get('/api/errors'), get('/api/skills')]); }
  catch { console.log('cc-scope: dashboard not running (start `node server.js` or `ccspy`).'); process.exit(0); }

  const daily = err.daily || [];
  const cur = rate(daily.slice(-7)), prev = rate(daily.slice(-14, -7));
  const delta = cur - prev;
  const topGap = (sk.needed || []).find((n) => !n.covered);

  if (asJson) {
    console.log(JSON.stringify({
      errorRate: err.errorRate, last7: cur, prior7: prev, delta,
      topClasses: (err.classes || []).slice(0, 3),
      topSpiral: (err.spirals || [])[0] || null,
      topGap: topGap || null,
      skills: sk.counts || {},
    }, null, 2));
    return;
  }

  const arrow = delta < -0.001 ? '▼ improving' : delta > 0.001 ? '▲ worse' : '▬ flat';
  console.log('— cc-scope digest —');
  console.log(`floundering: ${pct(err.errorRate)} overall · 7d ${pct(cur)} vs prior ${pct(prev)} (${arrow}) · ${Math.round(err.tokensOnErroredTurns / 1000)}k out-tok burned on errors`);
  const cls = (err.classes || []).slice(0, 3).map((c) => `${c.cls} ${c.count}`).join(' · ');
  if (cls) console.log(`top failures: ${cls}`);
  const sp = (err.spirals || [])[0];
  if (sp) console.log(`worst retry spiral: ${sp.count}× ${sp.name} (${sp.errorClass})`);
  if (topGap) console.log(`build next: ${topGap.skill} — ${topGap.failures} ${topGap.fromClass} fails would shrink`);
  const c = sk.counts || {}, bt = c.byTool || {};
  console.log(`skills: ${c.total || 0} total · claude ${bt.claude || 0} / codex ${bt.codex || 0} / cowork ${bt.cowork || 0} staged${c.drift ? ` · ⚠ ${c.drift} drifted` : ''}${c.needed ? ` · ${c.needed} gaps` : ''}`);
})();
