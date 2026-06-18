'use strict';

// Parse a raw SSE stream body into [{ event, data }] entries.
function parseSSE(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = 'message';
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length) events.push({ event, data: dataLines.join('\n') });
  }
  return events;
}

// Rebuild the complete API message object from streaming events.
function reconstructMessage(events) {
  let message = null;
  let error = null;
  const eventCounts = {};
  for (const { event, data } of events) {
    eventCounts[event] = (eventCounts[event] || 0) + 1;
    let obj;
    try { obj = JSON.parse(data); } catch { continue; }
    switch (obj.type) {
      case 'message_start':
        message = JSON.parse(JSON.stringify(obj.message || {}));
        message.content = message.content || [];
        break;
      case 'content_block_start': {
        if (!message || !obj.content_block) break;
        const block = JSON.parse(JSON.stringify(obj.content_block));
        // tool input arrives as input_json_delta fragments; accumulate then parse
        if (['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(block.type)) block._partialJson = '';
        message.content[obj.index] = block;
        break;
      }
      case 'content_block_delta': {
        const block = message && message.content[obj.index];
        if (!block || !obj.delta) break;
        const d = obj.delta;
        if (d.type === 'text_delta') block.text = (block.text || '') + d.text;
        else if (d.type === 'input_json_delta') block._partialJson = (block._partialJson || '') + d.partial_json;
        else if (d.type === 'thinking_delta') block.thinking = (block.thinking || '') + d.thinking;
        else if (d.type === 'signature_delta') block.signature = (block.signature || '') + d.signature;
        else if (d.type === 'citations_delta') (block.citations = block.citations || []).push(d.citation);
        break;
      }
      case 'content_block_stop': {
        const block = message && message.content[obj.index];
        if (block && block._partialJson !== undefined) {
          try { block.input = block._partialJson ? JSON.parse(block._partialJson) : {}; }
          catch { block.inputRaw = block._partialJson; }
          delete block._partialJson;
        }
        break;
      }
      case 'message_delta':
        if (!message) break;
        if (obj.delta) {
          if (obj.delta.stop_reason !== undefined) message.stop_reason = obj.delta.stop_reason;
          if (obj.delta.stop_sequence !== undefined) message.stop_sequence = obj.delta.stop_sequence;
        }
        if (obj.usage) message.usage = Object.assign({}, message.usage, obj.usage);
        break;
      case 'error':
        error = obj.error;
        break;
    }
  }
  return { message, error, eventCounts };
}

module.exports = { parseSSE, reconstructMessage };
