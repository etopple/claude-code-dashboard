'use strict';
const http = require('node:http');
const https = require('node:https');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

// Pure passthrough proxy. Tees request/response bytes to onCapture without
// blocking or modifying live traffic. The single request normalization is
// stripping accept-encoding so captured bodies stay plain text.
function createProxy({ upstreamHost, onCapture, onLive }) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
  let liveSeq = 0;

  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    const liveId = (onLive && req.method === 'POST' && req.url.startsWith('/v1/messages') && !req.url.includes('count_tokens'))
      ? 'L' + (++liveSeq) : null;
    const reqChunks = [];
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    }
    headers.host = upstreamHost;
    delete headers['accept-encoding'];

    let ttfbMs = null;
    const upstreamReq = https.request(
      { host: upstreamHost, path: req.url, method: req.method, headers, agent },
      (upRes) => {
        ttfbMs = Date.now() - startedAt;
        const resHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase())) resHeaders[k] = v;
        }
        res.writeHead(upRes.statusCode, resHeaders);
        if (res.socket) res.socket.setNoDelay(true);
        if (liveId) { try { onLive.responseStart({ id: liveId, status: upRes.statusCode, headers: upRes.headers }); } catch { /* live is best-effort */ } }
        const resChunks = [];
        upRes.on('data', (c) => {
          resChunks.push(c);
          res.write(c);
          if (liveId) { try { onLive.chunk({ id: liveId }, c); } catch { /* live is best-effort */ } }
        });
        upRes.on('end', () => {
          res.end();
          if (liveId) { try { onLive.end({ id: liveId }); } catch { /* live is best-effort */ } }
          try {
            onCapture({
              startedAt,
              endedAt: Date.now(),
              ttfbMs,
              method: req.method,
              path: req.url,
              status: upRes.statusCode,
              requestHeaders: req.headers,
              requestBody: Buffer.concat(reqChunks),
              responseHeaders: upRes.headers,
              responseBody: Buffer.concat(resChunks),
            });
          } catch (err) {
            console.error('[proxy] capture error (traffic unaffected):', err.message);
          }
        });
        upRes.on('error', () => res.destroy());
      }
    );

    upstreamReq.on('error', (err) => {
      console.error('[proxy] upstream error:', err.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_upstream_error', message: err.message } }));
    });

    req.on('data', (c) => { reqChunks.push(c); upstreamReq.write(c); });
    req.on('end', () => {
      upstreamReq.end();
      if (liveId) { try { onLive.start({ id: liveId, body: Buffer.concat(reqChunks) }); } catch { /* live is best-effort */ } }
    });
    req.on('error', () => upstreamReq.destroy());
  });

  // Agent turns can stream for many minutes; never kill them.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 10 * 60 * 1000;
  return server;
}

module.exports = { createProxy };
