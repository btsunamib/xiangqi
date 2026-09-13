// 极简 WebSocket 客户端（node:net + node:crypto，零依赖）
// 独立实现，不复用 server/ws.js，这样才能真正测出服务端问题。
import net from 'node:net';
import crypto from 'node:crypto';

const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;

function encodeFrame(payload, opcode = OP_TEXT) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function unmask(payload, mask) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i & 3];
  return out;
}

export function wsConnect(port, host = '127.0.0.1', timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const key = crypto.randomBytes(16).toString('base64');
    const listeners = [];
    let buf = Buffer.alloc(0);
    let handshakeDone = false;
    let settled = false;

    const client = {
      messages: [],
      socket: sock,
      closed: false,
      send(obj) {
        if (client.closed) return false;
        sock.write(encodeFrame(Buffer.from(JSON.stringify(obj), 'utf8')));
        return true;
      },
      close() {
        if (client.closed) return;
        client.closed = true;
        try { sock.destroy(); } catch (e) { /* ignore */ }
      },
      waitFor(pred, label = 'message', ms = 6000) {
        const hit = client.messages.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            cleanup();
            rej(new Error('timeout waiting for ' + label + ' (got ' + client.messages.length + ' msgs: ' +
              JSON.stringify(client.messages.map((m) => m && m.t)) + ')'));
          }, ms);
          const fn = (msg) => {
            if (!pred(msg)) return;
            cleanup();
            res(msg);
          };
          function cleanup() {
            clearTimeout(timer);
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
          }
          listeners.push(fn);
        });
      },
    };

    const failTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) { /* ignore */ }
      reject(new Error('websocket handshake timeout'));
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(
        'GET / HTTP/1.1\r\n' +
        'Host: ' + host + ':' + port + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });

    sock.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(failTimer);
        reject(err);
      }
    });

    sock.on('close', () => { client.closed = true; });

    sock.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

      if (!handshakeDone) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString('utf8');
        if (!/^HTTP\/1\.1 101/.test(head)) {
          if (!settled) {
            settled = true;
            clearTimeout(failTimer);
            reject(new Error('handshake failed: ' + head.split('\r\n')[0]));
          }
          return;
        }
        buf = buf.subarray(idx + 4);
        handshakeDone = true;
        if (!settled) {
          settled = true;
          clearTimeout(failTimer);
          resolve(client);
        }
      }

      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0];
        const b1 = buf[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        let maskKey = null;
        if (masked) {
          if (buf.length < off + 4) return;
          maskKey = buf.subarray(off, off + 4);
          off += 4;
        }
        if (buf.length < off + len) return;
        let payload = buf.subarray(off, off + len);
        if (maskKey) payload = unmask(payload, maskKey);
        buf = buf.subarray(off + len);

        if (opcode === OP_TEXT) {
          let msg = null;
          try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { msg = null; }
          if (msg) {
            client.messages.push(msg);
            for (const fn of listeners.slice()) fn(msg);
          }
        } else if (opcode === OP_PING) {
          sock.write(encodeFrame(payload, 0xa));
        } else if (opcode === OP_CLOSE) {
          client.close();
          return;
        }
      }
    });
  });
}

/** 统计所有 state 帧里泄露的暗子身份数量 */
export function countLeaks(messages) {
  let leaks = 0;
  const samples = [];
  for (const m of messages) {
    if (!m || m.t !== 'state' || !m.view || !Array.isArray(m.view.board)) continue;
    for (const p of m.view.board) {
      if (p && p.revealed === false && p.type !== null) {
        leaks += 1;
        if (samples.length < 3) samples.push(p);
      }
    }
  }
  return { leaks, samples };
}
