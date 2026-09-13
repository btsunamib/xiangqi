// 端到端集成测试：真实启动 server/index.js，用独立实现的 WebSocket 客户端完成整局流程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { wsConnect, countLeaks } from './_ws.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pickPort() {
  return 3300 + Math.floor(Math.random() * 900);
}

function httpGet(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function startServer(port) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  child.stdout.on('data', () => { /* drain */ });

  const deadline = Date.now() + 12000;
  for (;;) {
    const res = await httpGet(port, '/health');
    if (res && res.status === 200) break;
    if (Date.now() > deadline) {
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      throw new Error('server did not become ready in time. stderr=' + stderr);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { child, port, stderr: () => stderr };
}

function killServer(srv) {
  if (!srv || !srv.child) return;
  try { srv.child.kill('SIGKILL'); } catch (e) { /* ignore */ }
}

const P_RED_PAWN = 64; // (1,7) 红炮
const P_CENTER = 67;   // (4,7)

test('HTTP：/health、首页与共享引擎均可访问，目录穿越被拒', async (t) => {
  const port = pickPort();
  const srv = await startServer(port);
  t.after(() => killServer(srv));

  const health = await httpGet(port, '/health');
  assert.equal(health.status, 200);
  const parsed = JSON.parse(health.body);
  assert.equal(parsed.ok, true);
  assert.equal(typeof parsed.rooms, 'number');

  const index = await httpGet(port, '/');
  assert.equal(index.status, 200);
  assert.ok(index.body.includes('中国象棋'));

  const engine = await httpGet(port, '/shared/engine.js');
  assert.equal(engine.status, 200);
  assert.ok(engine.body.includes('createGame'));

  const traverse = await httpGet(port, '/../package.json');
  assert.ok(traverse === null || traverse.status === 403 || traverse.status === 404,
    '目录穿越必须被拒, got ' + (traverse && traverse.status));

  const missing = await httpGet(port, '/definitely-missing.js');
  assert.equal(missing.status, 404);
});

test('端到端：创建 → 加入 → 准备 → 开局 → 走子 → 认输，且暗子身份全程不泄露', async (t) => {
  const port = pickPort();
  const srv = await startServer(port);
  const clients = [];
  t.after(() => {
    for (const c of clients) c.close();
    killServer(srv);
  });

  // A 创建揭棋房间
  const A = await wsConnect(port);
  clients.push(A);
  await A.waitFor((m) => m.t === 'hello', 'A hello');
  A.send({ t: 'create', mode: 'jieqi', name: 'Alice' });

  const roomA = await A.waitFor((m) => m.t === 'room', 'A room');
  const code = roomA.room.code;
  assert.equal(typeof code, 'string');
  assert.equal(code.length, 6);
  assert.equal(roomA.you.seat, 'r');
  assert.equal(roomA.room.mode, 'jieqi');

  // B 加入
  const B = await wsConnect(port);
  clients.push(B);
  await B.waitFor((m) => m.t === 'hello', 'B hello');
  B.send({ t: 'join', code, name: 'Bob' });
  const roomB = await B.waitFor((m) => m.t === 'room', 'B room');
  assert.equal(roomB.you.seat, 'b', 'B 应坐上黑方');
  assert.equal(roomB.room.seats.r.name, 'Alice');
  assert.equal(roomB.room.seats.b.name, 'Bob');

  // 双方准备 -> 自动开局
  A.send({ t: 'ready' });
  B.send({ t: 'ready' });

  const startA = await A.waitFor(
    (m) => m.t === 'state' && m.view && m.view.mode === 'jieqi' &&
      m.view.turn === 'r' && m.view.over === false && m.view.history.length === 0 &&
      m.view.legal && Object.keys(m.view.legal).length > 0,
    'A game start state',
  );
  assert.equal(startA.view.board.filter(Boolean).length, 32);
  assert.equal(startA.view.board.filter((p) => p && !p.revealed).length, 30);

  // 开局帧里暗子身份必须为 null
  const startDark = startA.view.board.filter((p) => p && !p.revealed);
  assert.ok(startDark.length > 0);
  for (const p of startDark) assert.equal(p.type, null, '开局不应泄露暗子身份');

  // A（红方，当前行棋方）拿到 legal；B 拿不到
  await B.waitFor(
    (m) => m.t === 'state' && m.view && m.view.history.length === 0 && m.view.over === false,
    'B game start state',
  );
  assert.deepEqual(Object.keys(B.messages.filter((m) => m.t === 'state').slice(-1)[0].view.legal), []);

  // A 走一步：炮二平五
  A.send({ t: 'move', from: P_RED_PAWN, to: P_CENTER });
  const afterMove = await A.waitFor(
    (m) => m.t === 'state' && m.view && m.view.ply === 1,
    'state after red move',
  );
  assert.equal(afterMove.view.turn, 'b');
  assert.equal(afterMove.view.lastMove.from, P_RED_PAWN);
  assert.equal(afterMove.view.lastMove.to, P_CENTER);
  assert.equal(afterMove.view.history.length, 1);
  assert.equal(afterMove.view.history[0].color, 'r');
  assert.ok(Array.isArray(afterMove.events) && afterMove.events.some((e) => e.t === 'move'));

  // B 也收到同步后的状态
  const bAfter = await B.waitFor(
    (m) => m.t === 'state' && m.view && m.view.ply === 1,
    'B state after red move',
  );
  assert.equal(bAfter.view.turn, 'b');
  assert.deepEqual(Object.keys(bAfter.view.legal).length > 0, true, 'B 现在应拿到自己的合法着法');

  // 越权：A 不能再走（已不是 A 的回合）
  const beforeErrCount = A.messages.filter((m) => m.t === 'error').length;
  A.send({ t: 'move', from: P_CENTER, to: P_CENTER + 9 });
  const err = await A.waitFor(
    (m) => m.t === 'error' && m.code === 'not_your_turn',
    'not_your_turn error',
  );
  assert.equal(err.code, 'not_your_turn');
  assert.equal(A.messages.filter((m) => m.t === 'error').length, beforeErrCount + 1);

  // 非法着法：B 走一个不可能的位置
  B.send({ t: 'move', from: P_CENTER, to: P_CENTER });
  const err2 = await B.waitFor((m) => m.t === 'error', 'illegal move error');
  assert.ok(['illegal_move', 'not_your_turn'].includes(err2.code), 'got ' + err2.code);

  // 旁观者加入
  const C = await wsConnect(port);
  clients.push(C);
  await C.waitFor((m) => m.t === 'hello', 'C hello');
  C.send({ t: 'join', code, name: 'Watcher' });
  const roomC = await C.waitFor((m) => m.t === 'room', 'C room');
  assert.equal(roomC.you.seat, 'spectator', '第三个连接应为旁观者');
  const stateC = await C.waitFor((m) => m.t === 'state', 'C state');
  assert.deepEqual(Object.keys(stateC.view.legal), [], '旁观者不应拿到 legal');

  // B 认输
  B.send({ t: 'resign' });
  const overA = await A.waitFor(
    (m) => m.t === 'state' && m.view && m.view.over === true,
    'A game over',
  );
  assert.equal(overA.view.winner, 'r');
  assert.equal(overA.view.reason, 'resign');

  const overB = await B.waitFor(
    (m) => m.t === 'state' && m.view && m.view.over === true,
    'B game over',
  );
  assert.equal(overB.view.winner, 'r');
  assert.equal(overB.view.reason, 'resign');

  // 终局后仍不得泄露未翻开暗子的身份
  const leakA = countLeaks(A.messages);
  const leakB = countLeaks(B.messages);
  const leakC = countLeaks(C.messages);
  assert.equal(leakA.leaks, 0, '发给 A 的帧泄露了暗子身份: ' + JSON.stringify(leakA.samples));
  assert.equal(leakB.leaks, 0, '发给 B 的帧泄露了暗子身份: ' + JSON.stringify(leakB.samples));
  assert.equal(leakC.leaks, 0, '发给旁观者的帧泄露了暗子身份: ' + JSON.stringify(leakC.samples));
});

test('端到端：房间号不存在时报错；双方再来一局可重开', async (t) => {
  const port = pickPort();
  const srv = await startServer(port);
  const clients = [];
  t.after(() => {
    for (const c of clients) c.close();
    killServer(srv);
  });

  const X = await wsConnect(port);
  clients.push(X);
  await X.waitFor((m) => m.t === 'hello', 'X hello');
  X.send({ t: 'join', code: 'ZZZZZZ', name: 'Nobody' });
  const e = await X.waitFor((m) => m.t === 'error', 'no_room error');
  assert.equal(e.code, 'no_room');

  // 建一局全明乱棋，快速认输后双方申请再来一局
  const A = await wsConnect(port);
  clients.push(A);
  await A.waitFor((m) => m.t === 'hello', 'A hello');
  A.send({ t: 'create', mode: 'chaosOpen', name: 'A2' });
  const roomA = await A.waitFor((m) => m.t === 'room', 'A2 room');
  const code = roomA.room.code;

  const B = await wsConnect(port);
  clients.push(B);
  await B.waitFor((m) => m.t === 'hello', 'B hello');
  B.send({ t: 'join', code, name: 'B2' });
  await B.waitFor((m) => m.t === 'room' && m.you.seat === 'b', 'B2 seat');

  A.send({ t: 'ready' });
  B.send({ t: 'ready' });
  const start = await A.waitFor(
    (m) => m.t === 'state' && m.view && m.view.mode === 'chaosOpen' && m.view.over === false &&
      m.view.legal && Object.keys(m.view.legal).length > 0,
    'chaosOpen start',
  );
  assert.equal(start.view.board.filter((p) => p && !p.revealed).length, 0, '全明乱棋应无暗子');

  A.send({ t: 'resign' });
  await A.waitFor((m) => m.t === 'state' && m.view.over === true, 'A over');
  await B.waitFor((m) => m.t === 'state' && m.view.over === true, 'B over');

  A.send({ t: 'rematch' });
  B.send({ t: 'rematch' });
  const restart = await A.waitFor(
    (m) => m.t === 'state' && m.view && m.view.over === false && m.view.ply === 0 &&
      m.view.legal && Object.keys(m.view.legal).length > 0,
    'rematch restart',
  );
  assert.equal(restart.view.turn, 'r');
  assert.equal(restart.view.history.length, 0);
  assert.equal(restart.view.board.filter(Boolean).length, 32);
});