/* ==========================================================================
   BuildMind — dev proxy for the E2E run (NOT shipped).

   Serves the static frontend and proxies /api/* to the backend on :3100, so
   the browser sees one origin. That is exactly the production layout
   documented in DEPLOYMENT.md (same-origin API under /api), which is why the
   CSP can stay `connect-src 'self'`.

   This file lives in tests/, not in the app: it is tooling, not product code.
   ========================================================================== */

import { createServer, request as httpRequest } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// helpers → tests → backend → repo root
const ROOT = join(HERE, '..', '..', '..');
const PORT = Number(process.env.PROXY_PORT ?? 8180);
const API = process.env.API_TARGET ?? 'http://127.0.0.1:3100';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
};

/** Only ever serve from inside the repo root. */
function resolve(pathname: string): string | null {
  const bare = pathname.split('?')[0] ?? '/';
  const clean = normalize(decodeURIComponent(bare));
  const target = join(ROOT, clean);
  return target.startsWith(ROOT) ? target : null;
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (url.startsWith('/api/')) {
    const target = new URL(url, API);
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstream.on('error', () => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'API unavailable' } }));
    });

    req.pipe(upstream);
    return;
  }

  const pathname = url === '/' ? '/index.html' : (url.split('?')[0] ?? '/');
  let file = resolve(pathname);
  if (!file) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  try {
    const info = await stat(file);
    const dirIndex = join(file, 'index.html');
    if (info.isDirectory()) file = dirIndex;
  } catch {
    // Unknown path: serve the real 404 page with a 404 status, the way a
    // static host does.
    try {
      const page = await readFile(join(ROOT, '404.html'), 'utf8');
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    } catch {
      res.writeHead(404);
      res.end('not found');
      return;
    }
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`E2E proxy on http://127.0.0.1:${PORT} → ${API}`);
});
