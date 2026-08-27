'use strict';

// Minimal reverse proxy sufficient for streaming a noVNC/KasmVNC page and its
// WebSocket back to the browser. Purpose-built for the workspace feature —
// intentionally small and dependency-free (no http-proxy) so it's easy to
// reason about the exact bytes flowing through.
//
// Backend can be plain HTTP or self-signed HTTPS (kasmweb/* uses the latter).
// Certificate validation is disabled because the backend is always on
// 127.0.0.1 with a per-container self-signed cert.

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Hop-by-hop headers must not be forwarded (RFC 7230 §6.1). Strip on both
// directions so upstream doesn't see a stray Connection: close.
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

// Headers that would prevent embedding the noVNC page in our iframe. We
// suppress them so the workspace can render inside the panel.
const FRAME_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
]);

function filterResponseHeaders(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || FRAME_HEADERS.has(lk)) continue;
    out[k] = v;
  }
  return out;
}

function filterRequestHeaders(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function buildTargetOrigin({ hostPort, useHttps }) {
  return `${useHttps ? 'https' : 'http'}://127.0.0.1:${hostPort}`;
}

/**
 * Proxy a plain HTTP request/response pair. Consumed body is streamed through
 * so this MUST be mounted BEFORE express.json() or the body will be gone.
 */
function proxyHttp({ hostPort, useHttps }, req, res, remainderPath) {
  const parsed = new URL(buildTargetOrigin({ hostPort, useHttps }));
  const requester = useHttps ? https.request : http.request;
  const headers = filterRequestHeaders(req.headers);
  headers.host = parsed.host;

  const upstream = requester(
    {
      host: parsed.hostname,
      port: Number(parsed.port),
      method: req.method,
      path: remainderPath || '/',
      headers,
      rejectUnauthorized: false,
    },
    (upRes) => {
      const outHeaders = filterResponseHeaders(upRes.headers);
      res.writeHead(upRes.statusCode || 502, outHeaders);
      upRes.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end('workspace proxy upstream error: ' + err.message);
  });
  req.on('error', () => {
    try {
      upstream.destroy();
    } catch {
      /* noop */
    }
  });
  req.pipe(upstream);
}

/**
 * Proxy a WebSocket upgrade. Handles both ws:// and wss:// backends by using
 * http.request / https.request with the built-in Upgrade support — the
 * upstream socket returned in the 'upgrade' event is a raw duplex stream we
 * can pipe against the client socket.
 */
function proxyWebSocket(
  { hostPort, useHttps },
  req,
  clientSocket,
  head,
  remainderPath,
) {
  const parsed = new URL(buildTargetOrigin({ hostPort, useHttps }));
  const headers = filterRequestHeaders(req.headers);
  headers.host = parsed.host;
  // http.request only sends an Upgrade if this is present.
  headers.connection = 'Upgrade';
  headers.upgrade = req.headers.upgrade;

  const opts = {
    host: parsed.hostname,
    port: Number(parsed.port),
    method: req.method || 'GET',
    path: remainderPath || '/',
    headers,
    rejectUnauthorized: false,
  };
  const upstreamReq = (useHttps ? https : http).request(opts);
  upstreamReq.end();

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    if (clientSocket.destroyed) {
      try {
        upstreamSocket.destroy();
      } catch {
        /* noop */
      }
      return;
    }
    // Replay the 101 status line + headers to the browser. Preserve the exact
    // Sec-WebSocket-Accept the upstream computed so the handshake validates.
    const lines = [
      `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || ''}`,
    ];
    for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
      const k = upstreamRes.rawHeaders[i];
      const v = upstreamRes.rawHeaders[i + 1];
      if (FRAME_HEADERS.has(k.toLowerCase())) continue;
      lines.push(`${k}: ${v}`);
    }
    lines.push('', '');
    try {
      clientSocket.write(lines.join('\r\n'));
    } catch {
      try {
        upstreamSocket.destroy();
      } catch {
        /* noop */
      }
      return;
    }
    if (upstreamHead && upstreamHead.length) {
      try {
        clientSocket.write(upstreamHead);
      } catch {
        /* noop */
      }
    }
    if (head && head.length) {
      try {
        upstreamSocket.write(head);
      } catch {
        /* noop */
      }
    }
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);

    const cleanup = () => {
      try {
        upstreamSocket.destroy();
      } catch {
        /* noop */
      }
      try {
        clientSocket.destroy();
      } catch {
        /* noop */
      }
    };
    upstreamSocket.on('error', cleanup);
    clientSocket.on('error', cleanup);
    upstreamSocket.on('close', cleanup);
    clientSocket.on('close', cleanup);
  });

  upstreamReq.on('error', (err) => {
    const msg = 'workspace proxy upstream error: ' + err.message;
    try {
      clientSocket.write(
        `HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${Buffer.byteLength(msg)}\r\nConnection: close\r\n\r\n${msg}`,
      );
    } catch {
      /* noop */
    }
    try {
      clientSocket.destroy();
    } catch {
      /* noop */
    }
  });
}

// Parse "/api/workspaces/:id/stream[/rest...]" into { id, remainder }.
function parseWorkspaceProxyPath(url) {
  if (!url) return null;
  // Ignore query for matching; keep it for `remainder`.
  const m = url.match(/^\/api\/workspaces\/([^/?]+)\/stream(\/[^?]*)?(\?.*)?$/);
  if (!m) return null;
  return {
    id: decodeURIComponent(m[1]),
    remainder: (m[2] || '/') + (m[3] || ''),
  };
}

module.exports = {
  proxyHttp,
  proxyWebSocket,
  parseWorkspaceProxyPath,
};
