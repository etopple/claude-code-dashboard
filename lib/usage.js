'use strict';
const https = require('node:https');

// Account-wide usage via the Anthropic Console Admin API (cost_report).
// Requires an admin credential — set CCSCOPE_ADMIN_KEY to either an Admin API
// key (sk-ant-admin...) or an OAuth token. This is org/account-wide data,
// completely separate from the local transcript/proxy view.

const HOST = 'api.anthropic.com';

function apiGet(path, key) {
  const headers = { 'anthropic-version': '2023-06-01', accept: 'application/json' };
  if (/^sk-ant-/.test(key)) headers['x-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ host: HOST, path, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(body); } catch { /* leave null */ }
        if (res.statusCode >= 400) {
          const msg = (json && json.error && json.error.message) || body.slice(0, 300) || `HTTP ${res.statusCode}`;
          reject(Object.assign(new Error(msg), { status: res.statusCode }));
        } else {
          resolve(json || {});
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Pull every page of the cost report for [startingAt, endingAt], grouped by
// description so we get a per-model / per-cost-type breakdown.
async function fetchCostReport(key, startingAt, endingAt) {
  const buckets = [];
  let page = null;
  for (let guard = 0; guard < 60; guard++) {
    const qs = new URLSearchParams({ starting_at: startingAt, bucket_width: '1d', limit: '31' });
    if (endingAt) qs.set('ending_at', endingAt);
    qs.append('group_by[]', 'description');
    if (page) qs.set('page', page);
    const res = await apiGet('/v1/organizations/cost_report?' + qs.toString(), key);
    if (Array.isArray(res.data)) buckets.push(...res.data);
    if (res.has_more && res.next_page) { page = res.next_page; } else break;
  }
  return buckets;
}

function aggregate(buckets) {
  let totalCents = 0;
  const byModel = new Map();   // model -> cents
  const byType = new Map();    // cost_type -> cents
  const byDay = new Map();     // YYYY-MM-DD -> cents
  for (const b of buckets) {
    const day = (b.starting_at || '').slice(0, 10);
    for (const r of b.results || []) {
      const cents = parseFloat(r.amount) || 0;
      totalCents += cents;
      const model = r.model || (r.cost_type && r.cost_type !== 'tokens' ? r.cost_type : 'other');
      byModel.set(model, (byModel.get(model) || 0) + cents);
      byType.set(r.cost_type || 'other', (byType.get(r.cost_type) || 0) + cents);
      if (day) byDay.set(day, (byDay.get(day) || 0) + cents);
    }
  }
  const sortDesc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, usd: v / 100 }));
  return {
    totalUsd: totalCents / 100,
    byModel: sortDesc(byModel),
    byType: sortDesc(byType),
    byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, usd: v / 100 })),
  };
}

// Short cache so the dashboard can poll without hammering the Admin API.
const cache = { at: 0, data: null, days: 0 };

async function getAccountUsage({ key, days = 30, ttlMs = 5 * 60 * 1000 } = {}) {
  if (!key) return { configured: false };
  const now = Date.now();
  if (cache.data && cache.days === days && now - cache.at < ttlMs) return cache.data;
  const startingAt = new Date(now - days * 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';
  try {
    const buckets = await fetchCostReport(key, startingAt);
    const agg = aggregate(buckets);
    const data = { configured: true, days, fetchedAt: new Date(now).toISOString(), ...agg };
    cache.at = now; cache.data = data; cache.days = days;
    return data;
  } catch (err) {
    return { configured: true, error: err.message, status: err.status || 0, days };
  }
}

module.exports = { getAccountUsage };
