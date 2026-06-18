#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dirs = ['lib', 'public', 'bin'];
const files = ['server.js'];

for (const dir of dirs) {
  const full = path.join(root, dir);
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(dir, entry.name));
  }
}

let failed = false;
for (const file of files) {
  const rel = file.replace(/\\/g, '/');
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.status === 0) console.log(`ok ${rel}`);
  else failed = true;
}

if (failed) process.exit(1);
