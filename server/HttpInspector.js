'use strict';

// Per-service HTTP capture proxy. Hand-rolled reverse proxy (no `http-proxy`
// dep, matching vncProxy.js style) that listens on a chosen local port and
// forwards to `http://localhost:targetPort`, streaming a summary of each
// req/res pair over the manager's event bus.
//
// Bodies are captured up to MAX_BODY_BYTES and stored *decoded when possible*
// (JSON is pretty-printed; anything binary is base64) so the UI can just
// render them without worrying about content-type.

const EventEmitter = require('events');
const http = require('http');
const crypto = require('crypto');

const MAX_BODY_BYTES = 128 * 1024; // 128 KB per body — capture, don't hoard
const HISTORY_LIMIT = 200; // rolling ring buffer per inspector
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

function stripHopByHop(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function decodeBody(buf, contentType) {
  if (!buf || buf.length === 0) return { text: '', encoding: 'utf8', truncated: false };
  const truncated = buf.length >= MAX_BODY_BYTES;
  const slice = buf.slice(0, MAX_BODY_BYTES);
  const ct = String(contentType || '').toLowerCase();
  const textual =
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('javascript') ||
    ct.includes('urlencoded') ||
    ct.includes('form-data') ||
    ct === '';
  if (textual) {
    let text = slice.toString('utf8');
    if (ct.includes('json')) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* leave as-is */
      }
    }
    return { text, encoding: 'utf8', truncated };
  }
  return { text: slice.toString('base64'), encoding: 'base64', truncated };
}

class HttpInspector extends EventEmitter {
  constructor() {
    super();
    this.taps = new Map(); // serviceId -> { server, listenPort, targetPort, startedAt, history: [], count }
  }

  isActive(serviceId) {
    return this.taps.has(serviceId);
  }

  status(serviceId) {
    const t = this.taps.get(serviceId);
    if (!t) return { active: false };
    return {
      active: true,
      listenPort: t.listenPort,
      targetPort: t.targetPort,
      startedAt: t.startedAt,
      captured: t.count,
    };
  }

  history(serviceId) {
    const t = this.taps.get(serviceId);
    return t ? t.history.slice() : [];
  }

  start(serviceId, { listenPort, targetPort } = {}) {
    if (!serviceId) return Promise.reject(new Error('serviceId is required'));
    const tp = Number(targetPort);
    if (!Number.isInteger(tp) || tp < 1 || tp > 65535) {
      return Promise.reject(new Error('targetPort must be 1–65535'));
    }
    if (this.taps.has(serviceId)) {
      return Promise.resolve(this.status(serviceId));
    }
    // 0 = OS picks any free port.
    const requested = listenPort == null ? 0 : Number(listenPort);
    if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
      return Promise.reject(new Error('listenPort must be 0–65535 or omitted'));
    }

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) =>
        this._handle(serviceId, req, res),
      );
      server.on('clientError', (err, socket) => {
        socket.destroy();
        this.emit('proxy-error', serviceId, err);
      });
      server.listen(requested, '127.0.0.1', () => {
        const addr = server.address();
        const entry = {
          server,
          listenPort: addr.port,
          targetPort: tp,
          startedAt: new Date().toISOString(),
          history: [],
          count: 0,
        };
        this.taps.set(serviceId, entry);
        const status = this.status(serviceId);
        this.emit('status', serviceId, status);
        resolve(status);
      });
      server.once('error', (err) => {
        if (this.taps.has(serviceId)) this.taps.delete(serviceId);
        reject(err);
      });
    });
  }

  stop(serviceId) {
    const entry = this.taps.get(serviceId);
    if (!entry) return false;
    this.taps.delete(serviceId);
    try {
      entry.server.close();
    } catch {
      /* noop */
    }
    this.emit('status', serviceId, { active: false });
    return true;
  }

  clearHistory(serviceId) {
    const t = this.taps.get(serviceId);
    if (!t) return false;
    t.history = [];
    t.count = 0;
    this.emit('cleared', serviceId);
    return true;
  }

  shutdown() {
    for (const id of Array.from(this.taps.keys())) this.stop(id);
  }

  _handle(serviceId, clientReq, clientRes) {
    const entry = this.taps.get(serviceId);
    if (!entry) {
      clientRes.statusCode = 503;
      clientRes.end('inspector stopped');
      return;
    }
    const startedAt = Date.now();
    const id = 'req_' + crypto.randomBytes(6).toString('hex');
    const reqChunks = [];
    let reqLen = 0;
    let reqTruncated = false;

    clientReq.on('data', (chunk) => {
      reqLen += chunk.length;
      if (!reqTruncated) {
        if (reqLen > MAX_BODY_BYTES) {
          reqChunks.push(chunk.slice(0, chunk.length - (reqLen - MAX_BODY_BYTES)));
          reqTruncated = true;
        } else {
          reqChunks.push(chunk);
        }
      }
    });

    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port: entry.targetPort,
        method: clientReq.method,
        path: clientReq.url,
        headers: stripHopByHop({
          ...clientReq.headers,
          host: `127.0.0.1:${entry.targetPort}`,
        }),
      },
      (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode, stripHopByHop(proxyRes.headers));
        const respChunks = [];
        let respLen = 0;
        let respTruncated = false;
        proxyRes.on('data', (chunk) => {
          respLen += chunk.length;
          if (!respTruncated) {
            if (respLen > MAX_BODY_BYTES) {
              respChunks.push(
                chunk.slice(0, chunk.length - (respLen - MAX_BODY_BYTES)),
              );
              respTruncated = true;
            } else {
              respChunks.push(chunk);
            }
          }
          clientRes.write(chunk);
        });
        proxyRes.on('end', () => {
          clientRes.end();
          const reqBuf = Buffer.concat(reqChunks);
          const respBuf = Buffer.concat(respChunks);
          const record = {
            id,
            timestamp: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt,
            method: clientReq.method,
            url: clientReq.url,
            status: proxyRes.statusCode,
            requestHeaders: clientReq.headers,
            requestBody: {
              ...decodeBody(reqBuf, clientReq.headers['content-type']),
              size: reqLen,
              truncated: reqTruncated,
            },
            responseHeaders: proxyRes.headers,
            responseBody: {
              ...decodeBody(respBuf, proxyRes.headers['content-type']),
              size: respLen,
              truncated: respTruncated,
            },
          };
          this._record(serviceId, record);
        });
      },
    );

    proxyReq.on('error', (err) => {
      const record = {
        id,
        timestamp: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        method: clientReq.method,
        url: clientReq.url,
        status: 502,
        error: err.message,
        requestHeaders: clientReq.headers,
        requestBody: { text: '', encoding: 'utf8', size: reqLen, truncated: reqTruncated },
        responseHeaders: {},
        responseBody: { text: '', encoding: 'utf8', size: 0, truncated: false },
      };
      this._record(serviceId, record);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'content-type': 'text/plain' });
      }
      try {
        clientRes.end(`upstream error: ${err.message}`);
      } catch {
        /* client may have vanished */
      }
    });

    clientReq.pipe(proxyReq);
  }

  _record(serviceId, record) {
    const entry = this.taps.get(serviceId);
    if (!entry) return;
    entry.history.push(record);
    entry.count += 1;
    while (entry.history.length > HISTORY_LIMIT) entry.history.shift();
    this.emit('capture', serviceId, record);
  }
}

module.exports = HttpInspector;
