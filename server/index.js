// server/index.js
// HTTP 静态服务 + WebSocket 升级 + 启动日志。零第三方依赖。
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebSocketServer } from './ws.js';
import { RoomManager } from './rooms.js';
import { S2C } from '../shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const PUBLIC_ROOT = path.join(WORKSPACE_ROOT, 'public');
const SHARED_ROOT = path.join(WORKSPACE_ROOT, 'shared');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendStatus(res, code, body) {
  const text = body || String(code);
  try {
    res.writeHead(code, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    });
    res.end(text);
  } catch {
    /* ignore */
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * 把 URL pathname 解析成磁盘路径。
 * 目录穿越（..、绝对路径、%2e%2e、反斜杠、NUL）一律 403；不存在由调用方 404。
 */
export function resolveStaticPath(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return { status: 404 };
  if (pathname.includes('\0')) return { status: 403 };

  const lowerRaw = pathname.toLowerCase();
  if (lowerRaw.includes('%2e%2e') || lowerRaw.includes('%252e') || lowerRaw.includes('..')) {
    return { status: 403 };
  }

  const decoded = safeDecode(pathname);
  if (decoded === null) return { status: 403 };
  if (decoded.includes('\0') || decoded.includes('\\')) return { status: 403 };

  const segments = decoded.split('/');
  if (segments.includes('..')) return { status: 403 };

  let root;
  let rel;
  if (decoded === '/' || decoded === '') {
    root = PUBLIC_ROOT;
    rel = 'index.html';
  } else if (decoded === '/shared' || decoded === '/shared/') {
    root = SHARED_ROOT;
    rel = 'index.html';
  } else if (decoded.startsWith('/shared/')) {
    root = SHARED_ROOT;
    rel = decoded.slice('/shared/'.length);
  } else {
    root = PUBLIC_ROOT;
    rel = decoded.replace(/^\/+/, '');
  }

  if (!rel) return { status: 404 };
  if (path.isAbsolute(rel)) return { status: 403 };
  if (/^[a-zA-Z]:/.test(rel)) return { status: 403 };

  const rootResolved = path.resolve(root);
  const filePath = path.resolve(rootResolved, rel);
  if (filePath !== rootResolved && !filePath.startsWith(rootResolved + path.sep)) {
    return { status: 403 };
  }
  return { status: 200, filePath };
}

async function serveStatic(req, res, pathname) {
  const resolved = resolveStaticPath(pathname);
  if (resolved.status !== 200) {
    sendStatus(res, resolved.status);
    return;
  }

  let filePath = resolved.filePath;
  try {
    let info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      info = await stat(filePath);
    }
    if (!info.isFile()) {
      sendStatus(res, 404);
      return;
    }
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(data);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR')) {
      sendStatus(res, 404);
      return;
    }
    sendStatus(res, 500, 'internal error');
  }
}

export function createAppServer() {
  const rooms = new RoomManager();
  let nextSessionId = 1;

  const server = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendStatus(res, 405, 'method not allowed');
        return;
      }
      const rawUrl = req.url || '/';
      const queryIndex = rawUrl.indexOf('?');
      const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);

      if (pathname === '/health') {
        const body = JSON.stringify({
          ok: true,
          rooms: rooms.roomCount,
          uptime: Math.round(process.uptime()),
        });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }

      serveStatic(req, res, pathname);
    } catch {
      sendStatus(res, 500, 'internal error');
    }
  });

  const wss = createWebSocketServer({
    server,
    onConnection(socket) {
      const session = {
        id: 'c' + nextSessionId++,
        name: '',
        room: null,
        seat: null,
        socket,
        send(obj) {
          let text;
          try {
            text = JSON.stringify(obj);
          } catch {
            return;
          }
          try {
            socket.send(text);
          } catch {
            /* ignore */
          }
        },
        close(code) {
          try {
            socket.close(code);
          } catch {
            /* ignore */
          }
        },
      };

      socket.on('message', (raw) => {
        try {
          if (typeof raw === 'string') rooms.handleMessage(session, raw);
        } catch {
          /* ignore */
        }
      });
      socket.on('close', () => {
        try {
          rooms.handleClose(session);
        } catch {
          /* ignore */
        }
      });
      socket.on('error', () => {
        /* ignore */
      });

      session.send({ t: S2C.HELLO, id: session.id, serverTime: Date.now() });
    },
  });

  return { server, rooms, wss };
}

const app = createAppServer();
const { server, rooms, wss } = app;

export { server, rooms, wss };
export default app;

// 只有作为主模块直接运行时（node server/index.js）才监听端口；
// 被 import 时（例如 tests/）不产生监听副作用。
const isMain =
  !!process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const rawPort = process.env.PORT;
  const parsedPort = rawPort === undefined || rawPort === '' ? 3000 : Number(rawPort);
  const port = Number.isFinite(parsedPort) ? parsedPort : 3000;

  server.on('error', (err) => {
    console.error('[server] error:', err && err.message ? err.message : err);
    process.exit(1);
  });

  server.listen(port, () => {
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    console.log(`listening on http://127.0.0.1:${actualPort}`);
  });
}
