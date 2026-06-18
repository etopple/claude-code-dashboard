'use strict';

// Incremental SSE → live-console events. One LiveSession per proxied
// POST /v1/messages stream. server.js feeds it raw response chunks via push();
// it emits compact, render-ready events through the `emit` callback.

function parseEventBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join('\n') };
}

class LiveSession {
  constructor(id, emit) {
    this.id = id;
    this.emit = emit;
    this.buf = '';
    this.intro = null;      // turn_start/user/tool_results, flushed once we know it streams
    this.isStream = false;
  }

  // Parse the request body before the response streams. Buffers the intro
  // events; they are flushed by begin() only if the response is a real stream.
  request(reqJson) {
    if (!reqJson) return;
    const msgs = Array.isArray(reqJson.messages) ? reqJson.messages : [];
    const intro = [{
      t: 'turn_start',
      id: this.id,
      model: reqJson.model || null,
      messages: msgs.length,
      tools: Array.isArray(reqJson.tools) ? reqJson.tools.length : 0,
      systemChars: reqJson.system ? JSON.stringify(reqJson.system).length : 0,
    }];

    const last = msgs[msgs.length - 1];
    if (last && last.role === 'user') {
      const content = last.content;
      if (typeof content === 'string') {
        intro.push({ t: 'user', id: this.id, text: content });
      } else if (Array.isArray(content)) {
        const results = [];
        let userText = '';
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'tool_result') {
            results.push({
              toolUseId: b.tool_use_id,
              isError: !!b.is_error,
              chars: JSON.stringify(b.content ?? '').length,
            });
          } else if (b.type === 'text') {
            userText += b.text || '';
          }
        }
        if (userText.trim()) intro.push({ t: 'user', id: this.id, text: userText.trim() });
        if (results.length) intro.push({ t: 'tool_results', id: this.id, results });
      }
    }
    this.intro = intro;
  }

  begin() {
    this.isStream = true;
    if (this.intro) { for (const ev of this.intro) this.emit(ev); this.intro = null; }
  }

  push(chunkStr) {
    if (!this.isStream) return;
    this.buf += chunkStr.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const ev = parseEventBlock(block);
      if (ev) this._handle(ev);
    }
  }

  end() {
    this.emit({ t: 'turn_done', id: this.id });
  }

  _handle({ data }) {
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    const TOOLISH = ['tool_use', 'server_tool_use', 'mcp_tool_use'];
    switch (obj.type) {
      case 'content_block_start': {
        const cb = obj.content_block || {};
        if (TOOLISH.includes(cb.type)) {
          this.emit({ t: 'block', id: this.id, index: obj.index, blockType: 'tool_use', name: cb.name, toolId: cb.id });
        } else {
          this.emit({ t: 'block', id: this.id, index: obj.index, blockType: cb.type });
        }
        break;
      }
      case 'content_block_delta': {
        const d = obj.delta || {};
        if (d.type === 'text_delta') this.emit({ t: 'delta', id: this.id, index: obj.index, kind: 'text', text: d.text });
        else if (d.type === 'thinking_delta') this.emit({ t: 'delta', id: this.id, index: obj.index, kind: 'thinking', text: d.thinking });
        else if (d.type === 'input_json_delta') this.emit({ t: 'delta', id: this.id, index: obj.index, kind: 'tool_input', text: d.partial_json });
        break;
      }
      case 'content_block_stop':
        this.emit({ t: 'block_stop', id: this.id, index: obj.index });
        break;
      case 'message_delta':
        this.emit({ t: 'turn_meta', id: this.id, stopReason: obj.delta && obj.delta.stop_reason, usage: obj.usage || null });
        break;
      case 'message_stop':
        this.emit({ t: 'turn_end', id: this.id });
        break;
      case 'error':
        this.emit({ t: 'error', id: this.id, error: obj.error });
        break;
    }
  }
}

module.exports = { LiveSession };
