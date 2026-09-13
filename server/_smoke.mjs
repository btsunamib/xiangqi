// server/_smoke.mjs
// 临时冒烟脚本（允许保留在 server/ 下）：真实启动 HTTP+WS 栈，
// 用 Node 内置原生 WebSocket 客户端（globalThis.WebSocket）跑完整闭环：
//   创建 jieqi 房间 -> 第二连接 join -> 双方 ready -> 自动开局 -> 红方走子
//   -> 双方收到 state(turn=b) -> 越权/非法走子被拒 -> 黑方认输 -> over(winner=r,reason=resign)
// 并断言：任何客户端都拿不到对手暗子的真实身份。
// 运行：node server/_smoke.mjs
import http from 'node:http';
import { createAppServer } from './index.js';

const failures = [];
function check(cond, label) {
  if (cond) console.log('  ok   ' + label);
  else {
    console.log('  FAIL ' + label);
    failures.push(label);
  }
}

// 原生 http.request：不会像 fetch/URL 那样把 %2e%2e 规范化掉，可真实测目录穿越
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: rawPath, method: 'GET' },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

class Client {
  constructor(name) {
    this.name = name;
    this.frames = [];
    this.queue = [];
    this.pending = [];
  }

  open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error(this.name + ': websocket error')));
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    });
  }

  _onMessage(data) {
    let msg;
    try {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      msg = JSON.parse(text);
    } catch {
      return;
    }
    this.frames.push(msg);
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (p.pred(msg)) {
        this.pending.splice(i, 1);
        p.resolve(msg);
        return;
      }
    }
    this.queue.push(msg);
  }

  next(pred, timeout = 5000) {
    for (let i = 0; i < this.queue.length; i++) {
      if (pred(this.queue[i])) return Promise.resolve(this.queue.splice(i, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      let entry;
      const timer = setTimeout(() => {
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error(this.name + ': timeout waiting for message'));
      }, timeout);
      entry = {
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      this.pending.push(entry);
    });
  }

  clear() {
    this.queue.length = 0;
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const { server, wss } = createAppServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log('listening on ' + base);

const A = new Client('A');
const B = new Client('B');

try {
  // ---------- HTTP ----------
  const health = await fetch(base + '/health');
  const healthBody = await health.json();
  check(
    health.status === 200 && healthBody.ok === true && typeof healthBody.rooms === 'number',
    `GET /health -> ${health.status} ${JSON.stringify(healthBody)}`,
  );

  const root = await fetch(base + '/');
  check(root.status === 200, `GET / -> ${root.status}`);
  await root.arrayBuffer();

  const engine = await fetch(base + '/shared/engine.js');
  check(
    engine.status === 200 && /javascript/.test(engine.headers.get('content-type') || ''),
    `GET /shared/engine.js -> ${engine.status} ${engine.headers.get('content-type')}`,
  );
  await engine.arrayBuffer();

  const traversal1 = await rawGet(port, '/%2e%2e/package.json');
  const traversal2 = await rawGet(port, '/../package.json');
  const traversal3 = await rawGet(port, '/..%2fpackage.json');
  check(traversal1 === 403, `GET /%2e%2e/package.json -> ${traversal1} (期望 403)`);
  check(traversal2 === 403, `GET /../package.json -> ${traversal2} (期望 403)`);
  check(traversal3 === 403, `GET /..%2fpackage.json -> ${traversal3} (期望 403)`);

  const missing = await fetch(base + '/definitely-not-here.js');
  check(missing.status === 404, `GET /definitely-not-here.js -> ${missing.status}`);

  // ---------- WebSocket 完整对局 ----------
  const wsUrl = `ws://127.0.0.1:${port}/`;
  await A.open(wsUrl);
  const helloA = await A.next((m) => m.t === 'hello');
  check(!!helloA && typeof helloA.id === 'string', 'A 收到 hello');

  A.send({ t: 'create', mode: 'jieqi', name: 'Alice' });
  const roomA = await A.next((m) => m.t === 'room');
  const code = roomA.room.code;
  check(/^[A-Z0-9]{6}$/.test(code) && roomA.room.mode === 'jieqi', `A 创建 jieqi 房间 code=${code}`);
  check(roomA.you.seat === 'r' && roomA.you.name === 'Alice', 'A 坐红方');

  await B.open(wsUrl);
  await B.next((m) => m.t === 'hello');
  B.send({ t: 'join', code, name: 'Bob' });
  const roomB = await B.next((m) => m.t === 'room');
  check(roomB.you.seat === 'b' && roomB.you.name === 'Bob', 'B 加入并坐黑方');
  await A.next((m) => m.t === 'room' && m.room.seats.b && m.room.seats.b.name === 'Bob');

  A.send({ t: 'ready' });
  await A.next((m) => m.t === 'room' && m.room.seats.r && m.room.seats.r.ready === true);
  A.clear();
  B.clear();
  B.send({ t: 'ready' });

  const startA = await A.next(
    (m) => m.t === 'state' && m.view && m.view.mode === 'jieqi' && m.view.ply === 0,
  );
  const startB = await B.next(
    (m) => m.t === 'state' && m.view && m.view.mode === 'jieqi' && m.view.ply === 0,
  );
  check(startA.view.turn === 'r' && startB.view.turn === 'r', '双方 ready -> 自动开局，turn=r, ply=0');

  // 红方走一步合法棋：64（炮位）-> 67，即炮二平五（暗子按位置角色 C 走）
  A.send({ t: 'move', from: 64, to: 67 });
  const mvA = await A.next((m) => m.t === 'state' && m.view && m.view.ply === 1);
  const mvB = await B.next((m) => m.t === 'state' && m.view && m.view.ply === 1);
  check(mvA.view.turn === 'b' && mvB.view.turn === 'b', '走子后双方 state.turn=b');
  check(
    mvA.view.lastMove && mvA.view.lastMove.from === 64 && mvA.view.lastMove.to === 67,
    'lastMove=64->67',
  );
  check(
    Array.isArray(mvA.events) && mvA.events.some((e) => e.t === 'move'),
    'events 含 move',
  );

  // 越权（非本方回合）走子 -> not_your_turn
  A.send({ t: 'move', from: 0, to: 0 });
  const errTurn = await A.next((m) => m.t === 'error');
  check(errTurn.code === 'not_your_turn', `非本方回合走子 -> error ${errTurn.code}`);

  // 本回合方的非法着法 -> illegal_move，状态不变
  B.send({ t: 'move', from: 0, to: 0 });
  const errIllegal = await B.next((m) => m.t === 'error');
  check(errIllegal.code === 'illegal_move', `非法走子 -> error ${errIllegal.code}`);
  check(
    !B.frames.some((m) => m.t === 'state' && m.view && m.view.ply >= 2),
    '非法走子未改变状态（无 ply>=2 广播）',
  );

  // 黑方认输
  B.send({ t: 'resign' });
  const overA = await A.next((m) => m.t === 'state' && m.view && m.view.over === true);
  const overB = await B.next((m) => m.t === 'state' && m.view && m.view.over === true);
  check(
    overA.view.winner === 'r' && overA.view.reason === 'resign',
    `A over: winner=${overA.view.winner} reason=${overA.view.reason}`,
  );
  check(
    overB.view.winner === 'r' && overB.view.reason === 'resign',
    `B over: winner=${overB.view.winner} reason=${overB.view.reason}`,
  );

  // ---------- 隐藏信息断言 ----------
  const scanHidden = (client, oppColor) => {
    let dark = 0;
    let leaked = null;
    for (const msg of client.frames) {
      if (msg.t !== 'state' || !msg.view || !Array.isArray(msg.view.board)) continue;
      for (const piece of msg.view.board) {
        if (!piece) continue;
        if (piece.color === oppColor && piece.revealed === false) {
          dark++;
          if (piece.type !== null) leaked = piece;
        }
      }
    }
    return { dark, leaked };
  };
  const hidA = scanHidden(A, 'b');
  const hidB = scanHidden(B, 'r');
  check(
    hidA.dark > 0 && hidA.leaked === null,
    `A 收到的所有帧中 B 的暗子 type 恒为 null（样本 ${hidA.dark}）`,
  );
  check(
    hidB.dark > 0 && hidB.leaked === null,
    `B 收到的所有帧中 A 的暗子 type 恒为 null（样本 ${hidB.dark}）`,
  );
} catch (err) {
  console.error('SMOKE ERROR: ' + (err && err.message ? err.message : err));
  failures.push('exception: ' + (err && err.message ? err.message : err));
} finally {
  A.close();
  B.close();
  try {
    wss.close();
  } catch {
    /* ignore */
  }
  await Promise.race([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
}

// 不用 process.exit()：Windows 上在 WS 关闭握手期间强制退出会触发 libuv 断言。
// 只设置 exitCode，让事件循环自然排空退出。
if (failures.length === 0) {
  console.log('\nSMOKE PASS: 全部断言通过');
  process.exitCode = 0;
} else {
  console.log('\nSMOKE FAIL (' + failures.length + '):\n - ' + failures.join('\n - '));
  process.exitCode = 1;
}
