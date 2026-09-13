// server/ws.js
// 零依赖 RFC6455 WebSocket 服务器实现（仅服务端视角）。
// 支持：握手、掩码客户端帧、文本/二进制/close/ping/pong、分片(continuation)、
//       126/127 长度（含 64 位）、>MAX_MESSAGE_BYTES 断开、30s ping / 60s 无 pong 断开。
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MAX_MESSAGE_BYTES } from '../shared/protocol.js';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export const CLOSE_NORMAL = 1000;
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_PROTOCOL_ERROR = 1002;
export const CLOSE_UNSUPPORTED_DATA = 1003;
export const CLOSE_MESSAGE_TOO_BIG = 1009;

const DEFAULT_PING_INTERVAL = 30000;
const DEFAULT_PONG_TIMEOUT = 60000;

function sha1Base64(text) {
  return createHash('sha1').update(text).digest('base64');
}

/** Sec-WebSocket-Key -> Sec-WebSocket-Accept */
export function computeAcceptKey(key) {
  return sha1Base64(String(key) + WS_GUID);
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode，服务端不掩码
  return Buffer.concat([header, payload], header.length + len);
}

function unmask(payload, mask) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i & 3];
  return out;
}

function closePayload(code, reason) {
  const text = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
  const buf = Buffer.allocUnsafe(2 + text.length);
  buf.writeUInt16BE(code, 0);
  text.copy(buf, 2);
  return buf;
}

export class WebSocketConnection extends EventEmitter {
  constructor(rawSocket, opts = {}) {
    super();
    this.rawSocket = rawSocket;
    this.maxMessageBytes = opts.maxMessageBytes || MAX_MESSAGE_BYTES;
    this.pingInterval = opts.pingInterval === undefined ? DEFAULT_PING_INTERVAL : opts.pingInterval;
    this.pongTimeout = opts.pongTimeout === undefined ? DEFAULT_PONG_TIMEOUT : opts.pongTimeout;

    this.isAlive = true;
    this.closed = false;
    this.readyState = 'open';

    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentBytes = 0;
    this._fragmentOpcode = null;
    this._closeSent = false;
    this._closedEmitted = false;
    this._closeCode = CLOSE_NORMAL;
    this._closeReason = '';
    this._lastPong = Date.now();
    this._heartbeat = null;

    // 保证 'error' 事件永远有监听者，socket 错误不会让进程退出。
    this.on('error', () => {});

    try {
      rawSocket.setNoDelay(true);
    } catch {
      /* ignore */
    }

    rawSocket.on('data', (chunk) => this._onData(chunk));
    rawSocket.on('error', (err) => {
      this.emit('error', err);
    });
    rawSocket.on('close', () => this._finish());

    if (this.pingInterval > 0) {
      this._heartbeat = setInterval(() => this._onHeartbeat(), this.pingInterval);
      if (typeof this._heartbeat.unref === 'function') this._heartbeat.unref();
    }
  }

  // ---------- 公开 API ----------

  send(data) {
    if (this.closed || this._closeSent) return false;
    if (typeof data === 'string') {
      return this._sendFrame(OP_TEXT, Buffer.from(data, 'utf8'));
    }
    if (Buffer.isBuffer(data)) return this._sendFrame(OP_BINARY, data);
    return this._sendFrame(OP_TEXT, Buffer.from(String(data), 'utf8'));
  }

  sendBinary(data) {
    if (this.closed || this._closeSent) return false;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return this._sendFrame(OP_BINARY, buf);
  }

  ping(payload) {
    const buf = payload === undefined ? Buffer.alloc(0) : Buffer.from(payload);
    return this._sendFrame(OP_PING, buf.subarray(0, 125));
  }

  pong(payload) {
    const buf = payload === undefined ? Buffer.alloc(0) : Buffer.from(payload);
    return this._sendFrame(OP_PONG, buf.subarray(0, 125));
  }

  close(code = CLOSE_NORMAL, reason = '') {
    if (this.closed || this._closeSent) return;
    this._closeSent = true;
    this._closeCode = typeof code === 'number' ? code : CLOSE_NORMAL;
    this._closeReason = reason || '';
    try {
      this._sendFrame(OP_CLOSE, closePayload(this._closeCode, this._closeReason));
    } catch {
      /* ignore */
    }
    try {
      this.rawSocket.end();
    } catch {
      try {
        this.rawSocket.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  destroy(err) {
    if (err) this.emit('error', err);
    try {
      this.rawSocket.destroy();
    } catch {
      /* ignore */
    }
    this._finish();
  }

  // ---------- 内部 ----------

  _sendFrame(opcode, payload) {
    if (this.closed) return false;
    if (opcode !== OP_CLOSE && this._closeSent) return false;
    if (!this.rawSocket || this.rawSocket.destroyed) return false;
    try {
      return this.rawSocket.write(encodeFrame(opcode, payload));
    } catch {
      return false;
    }
  }

  _finish() {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this.closed = true;
    this.readyState = 'closed';
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
    try {
      this.rawSocket.removeAllListeners('data');
    } catch {
      /* ignore */
    }
    this.emit('close', { code: this._closeCode, reason: this._closeReason });
  }

  _onHeartbeat() {
    if (this.closed) return;
    const now = Date.now();
    if (!this.isAlive && now - this._lastPong >= this.pongTimeout) {
      // 60s 无 pong：断开
      try {
        this.rawSocket.destroy();
      } catch {
        /* ignore */
      }
      this._finish();
      return;
    }
    this.isAlive = false;
    this.ping();
  }

  _onData(chunk) {
    if (this.closed) return;
    this.isAlive = true;
    try {
      this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
      this._processBuffer();
    } catch (err) {
      this.emit('error', err);
      this.close(CLOSE_PROTOCOL_ERROR);
    }
  }

  _processBuffer() {
    for (;;) {
      if (this._closeSent) return;
      const buf = this._buffer;
      if (buf.length < 2) return;

      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) {
        this.close(CLOSE_PROTOCOL_ERROR, 'RSV must be 0');
        return;
      }
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.close(CLOSE_MESSAGE_TOO_BIG, 'payload too large');
          return;
        }
        length = Number(big);
        offset = 10;
      }

      const isControl = (opcode & 0x8) !== 0;
      if (isControl && (!fin || length > 125)) {
        this.close(CLOSE_PROTOCOL_ERROR, 'invalid control frame');
        return;
      }

      // 客户端 -> 服务端必须掩码
      if (!masked) {
        this.close(CLOSE_PROTOCOL_ERROR, 'client frames must be masked');
        return;
      }
      if (buf.length < offset + 4) return;
      const maskKey = buf.subarray(offset, offset + 4);
      offset += 4;

      if (length > this.maxMessageBytes) {
        this.close(CLOSE_MESSAGE_TOO_BIG, 'message too big');
        return;
      }
      if (buf.length < offset + length) return;

      let payload = buf.subarray(offset, offset + length);
      payload = unmask(payload, maskKey);
      this._buffer = buf.subarray(offset + length);

      this._handleFrame(opcode, fin, payload);
      if (this._closeSent) return;
    }
  }

  _handleFrame(opcode, fin, payload) {
    switch (opcode) {
      case OP_CLOSE: {
        let code = CLOSE_NORMAL;
        if (payload.length >= 2) code = payload.readUInt16BE(0);
        this._closeCode = code;
        if (!this._closeSent) {
          this._closeSent = true;
          try {
            this._sendFrame(OP_CLOSE, closePayload(code, ''));
          } catch {
            /* ignore */
          }
        }
        try {
          this.rawSocket.end();
        } catch {
          this._finish();
        }
        return;
      }
      case OP_PING:
        this._sendFrame(OP_PONG, payload);
        this.emit('ping', payload);
        return;
      case OP_PONG:
        this.isAlive = true;
        this._lastPong = Date.now();
        this.emit('pong', payload);
        return;
      case OP_TEXT:
      case OP_BINARY: {
        if (this._fragmentOpcode !== null) {
          this.close(CLOSE_PROTOCOL_ERROR, 'unexpected data frame during fragmentation');
          return;
        }
        if (fin) {
          this._deliver(opcode, payload);
        } else {
          this._fragmentOpcode = opcode;
          this._fragments = [payload];
          this._fragmentBytes = payload.length;
        }
        return;
      }
      case OP_CONTINUATION: {
        if (this._fragmentOpcode === null) {
          this.close(CLOSE_PROTOCOL_ERROR, 'unexpected continuation frame');
          return;
        }
        this._fragmentBytes += payload.length;
        if (this._fragmentBytes > this.maxMessageBytes) {
          this.close(CLOSE_MESSAGE_TOO_BIG, 'message too big');
          return;
        }
        this._fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragments, this._fragmentBytes);
          const op = this._fragmentOpcode;
          this._fragments = [];
          this._fragmentBytes = 0;
          this._fragmentOpcode = null;
          this._deliver(op, full);
        }
        return;
      }
      default:
        this.close(CLOSE_PROTOCOL_ERROR, 'unknown opcode ' + opcode);
    }
  }

  _deliver(opcode, payload) {
    this.isAlive = true;
    if (opcode === OP_TEXT) {
      this.emit('message', payload.toString('utf8'));
    } else {
      this.emit('binary', payload);
    }
  }
}

/**
 * 把 HTTP server 升级为 WebSocket 服务器。
 * @param {{server: import('node:http').Server, onConnection?: (socket: WebSocketConnection, req: import('node:http').IncomingMessage) => void, path?: string, maxMessageBytes?: number, pingInterval?: number, pongTimeout?: number}} options
 */
export function createWebSocketServer(options = {}) {
  const {
    server,
    onConnection,
    path: wsPath,
    maxMessageBytes = MAX_MESSAGE_BYTES,
    pingInterval,
    pongTimeout,
  } = options;

  if (!server || typeof server.on !== 'function') {
    throw new TypeError('createWebSocketServer requires an http.Server');
  }

  const clients = new Set();

  function handleUpgrade(req, socket, head) {
    const upgrade = String(req.headers['upgrade'] || '').toLowerCase();
    const key = req.headers['sec-websocket-key'];
    const version = String(req.headers['sec-websocket-version'] || '');

    if (upgrade !== 'websocket' || typeof key !== 'string' || key.length === 0 || version !== '13') {
      try {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } catch {
        /* ignore */
      }
      socket.destroy();
      return;
    }

    if (wsPath) {
      const rawUrl = String(req.url || '/');
      const onlyPath = rawUrl.split('?')[0];
      if (onlyPath !== wsPath) {
        socket.destroy();
        return;
      }
    }

    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: ' + computeAcceptKey(key) + '\r\n' +
          '\r\n',
      );
    } catch {
      socket.destroy();
      return;
    }

    const conn = new WebSocketConnection(socket, { maxMessageBytes, pingInterval, pongTimeout });
    clients.add(conn);
    conn.on('close', () => clients.delete(conn));

    if (head && head.length) conn._onData(head);

    try {
      if (typeof onConnection === 'function') onConnection(conn, req);
    } catch (err) {
      conn.emit('error', err);
      conn.destroy();
    }
  }

  server.on('upgrade', handleUpgrade);

  return {
    clients,
    close() {
      server.removeListener('upgrade', handleUpgrade);
      for (const conn of [...clients]) {
        try {
          conn.close(CLOSE_GOING_AWAY, 'server shutting down');
        } catch {
          /* ignore */
        }
      }
      clients.clear();
    },
  };
}

export default createWebSocketServer;
