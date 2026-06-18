#!/usr/bin/env node
'use strict';

const path = require('node:path');

const root = path.resolve(__dirname, '..');
process.env.CCSCOPE_TRANSCRIPT_ROOT = path.join(root, 'fixtures', 'claude-projects');
process.env.CCSCOPE_BACKFILL_HOURS = '0';
process.env.CCSCOPE_DASH_PORT ||= '4001';
process.env.CCSCOPE_PROXY_PORT ||= '4000';

console.log('[cc-scope demo] transcript root:', process.env.CCSCOPE_TRANSCRIPT_ROOT);
console.log(`[cc-scope demo] dashboard: http://127.0.0.1:${process.env.CCSCOPE_DASH_PORT}`);

require('../server');
