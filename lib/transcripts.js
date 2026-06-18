'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// Tails the configured Claude Code transcript root (default ~/.claude/projects)
// and emits 'entry' for every appended JSON line. fs.watch(recursive) is the
// fast path; a 2s poll over known files
// plus a 10s rescan for new files covers dropped events on Windows.
class TranscriptWatcher extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.files = new Map(); // file -> { offset, remainder, reading, dirty }
  }

  start({ backfillMs = 24 * 60 * 60 * 1000 } = {}) {
    // backfillMs <= 0 means "all history" (load every transcript regardless of age).
    const cutoff = backfillMs > 0 ? Date.now() - backfillMs : 0;
    for (const file of this._scan(this.root)) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs >= cutoff) {
        this.files.set(file, { offset: 0, remainder: '', reading: false, dirty: false });
        this._drain(file);
      } else {
        this.files.set(file, { offset: st.size, remainder: '', reading: false, dirty: false });
      }
    }
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const name = filename.toString();
        if (!name.endsWith('.jsonl')) return;
        this._drain(path.join(this.root, name));
      });
    } catch (err) {
      console.error('[transcripts] fs.watch failed, polling only:', err.message);
    }
    this.pollTimer = setInterval(() => {
      for (const file of this.files.keys()) this._drainIfGrown(file);
    }, 2000);
    this.rescanTimer = setInterval(() => {
      for (const file of this._scan(this.root)) {
        if (!this.files.has(file)) this._drain(file);
      }
    }, 10000);
  }

  stop() {
    if (this.watcher) this.watcher.close();
    clearInterval(this.pollTimer);
    clearInterval(this.rescanTimer);
  }

  _scan(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) this._scan(full, out);
      else if (e.name.endsWith('.jsonl')) out.push(full);
    }
    return out;
  }

  _drainIfGrown(file) {
    const state = this.files.get(file);
    if (!state || state.reading) return;
    fs.stat(file, (err, st) => {
      if (!err && st.size !== state.offset) this._drain(file);
    });
  }

  _drain(file) {
    let state = this.files.get(file);
    if (!state) {
      state = { offset: 0, remainder: '', reading: false, dirty: false };
      this.files.set(file, state);
    }
    if (state.reading) { state.dirty = true; return; }
    state.reading = true;
    fs.stat(file, (err, st) => {
      if (err) { state.reading = false; return; }
      if (st.size < state.offset) { state.offset = 0; state.remainder = ''; }
      if (st.size === state.offset) {
        state.reading = false;
        if (state.dirty) { state.dirty = false; this._drain(file); }
        return;
      }
      const stream = fs.createReadStream(file, { start: state.offset, end: st.size - 1, encoding: 'utf8' });
      let buf = state.remainder;
      stream.on('data', (c) => { buf += c; });
      stream.on('error', () => { state.reading = false; });
      stream.on('end', () => {
        const lines = buf.split('\n');
        state.remainder = lines.pop();
        state.offset = st.size; // remainder is carried in memory, not re-read
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          try { this.emit('entry', { file, entry: JSON.parse(t) }); } catch { /* partial/corrupt line */ }
        }
        state.reading = false;
        if (state.dirty) { state.dirty = false; this._drain(file); }
      });
    });
  }
}

module.exports = { TranscriptWatcher };
