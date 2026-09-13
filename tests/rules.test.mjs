// 规则改造回归测试：
//   1) 长将判负 / 重复局面和棋
//   2) 揭棋系列象/相可以过河
//   3) 被翻开的士/将解除九宫限制
//   4) 乱棋里被洗到九宫外的士/将解除九宫限制
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, movesFrom, makeMove, inCheck, viewFor,
} from '../shared/engine.js';
import { P, ST, I, coords } from './_helpers.mjs';

/** 造一个指定 mode 的局面 */
function STM(mode, list, turn = 'r') {
  const s = ST(list, turn);
  s.mode = mode;
  return s;
}

/** 给 (x,y) 的棋子打上 flipped / free 标记 */
function mark(s, x, y, opts) {
  const p = s.board[I(x, y)];
  assert.ok(p, '该位置应有棋子: ' + x + ',' + y);
  if (opts.flipped !== undefined) p.flipped = opts.flipped;
  if (opts.free !== undefined) p.free = opts.free;
  return p;
}

// ---------------------------------------------------------------------------
// 长将 / 重复局面
// ---------------------------------------------------------------------------

test('长将判负：同一局面第 3 次出现且被将方在将军中 -> 将军方判负', () => {
  // 红帅(4,9) 被黑车(4,1) 将军；黑车在两列之间来回将，红帅来回躲 -> 4 手一循环
  const s = ST([
    [4, 9, P('r', 'K')],
    [0, 0, P('b', 'K')],
    [4, 1, P('b', 'R')],
  ], 'r');
  assert.equal(inCheck(s, 'r'), true, '红帅应正被将军');

  const seq = [
    [I(4, 9), I(3, 9)], [I(4, 1), I(3, 1)],
    [I(3, 9), I(4, 9)], [I(3, 1), I(4, 1)],
    [I(4, 9), I(3, 9)], [I(4, 1), I(3, 1)],
    [I(3, 9), I(4, 9)], [I(3, 1), I(4, 1)],
  ];

  let cur = s;
  for (let i = 0; i < seq.length; i++) {
    const res = makeMove(cur, seq[i][0], seq[i][1]);
    assert.equal(res.ok, true, '第 ' + (i + 1) + ' 手应合法, error=' + res.error);
    cur = res.state;
    if (i < seq.length - 1) {
      assert.equal(cur.over, false, '第 ' + (i + 1) + ' 手后还不该终局');
    }
  }

  assert.equal(cur.over, true, '第 3 次重复局面应终局');
  assert.equal(cur.reason, 'perpetual_check');
  assert.equal(cur.winner, 'r', '长将的黑方判负，红方获胜');
  assert.equal(cur.turn, 'r');
});

test('重复局面：第 3 次出现但双方都没连续将军 -> 和棋', () => {
  // 双方车各自来回挪动，全程不将军
  const s = ST([
    [4, 9, P('r', 'K')],
    [3, 0, P('b', 'K')],
    [0, 9, P('r', 'R')],
    [0, 0, P('b', 'R')],
  ], 'r');
  assert.equal(inCheck(s, 'r'), false);
  assert.equal(inCheck(s, 'b'), false);

  const seq = [
    [I(0, 9), I(1, 9)], [I(0, 0), I(1, 0)],
    [I(1, 9), I(0, 9)], [I(1, 0), I(0, 0)],
    [I(0, 9), I(1, 9)], [I(0, 0), I(1, 0)],
    [I(1, 9), I(0, 9)], [I(1, 0), I(0, 0)],
  ];

  let cur = s;
  for (let i = 0; i < seq.length; i++) {
    const res = makeMove(cur, seq[i][0], seq[i][1]);
    assert.equal(res.ok, true, '第 ' + (i + 1) + ' 手应合法, error=' + res.error);
    cur = res.state;
  }

  assert.equal(cur.over, true);
  assert.equal(cur.reason, 'repetition');
  assert.equal(cur.winner, null, '无连续将军的重复局面判和棋');
});

test('未重复到 3 次时不应提前终局', () => {
  const s = ST([
    [4, 9, P('r', 'K')],
    [3, 0, P('b', 'K')],
    [0, 9, P('r', 'R')],
    [0, 0, P('b', 'R')],
  ], 'r');
  const seq = [
    [I(0, 9), I(1, 9)], [I(0, 0), I(1, 0)],
    [I(1, 9), I(0, 9)], [I(1, 0), I(0, 0)], // 第 2 次同一局面
  ];
  let cur = s;
  for (const [from, to] of seq) {
    const res = makeMove(cur, from, to);
    assert.equal(res.ok, true, 'error=' + res.error);
    cur = res.state;
  }
  assert.equal(cur.over, false, '只重复 2 次不应终局');
});

test('每次开局都会初始化重复局面记录', () => {
  for (const mode of ['normal', 'jieqi', 'chaosJieqi', 'chaosOpen']) {
    const g = createGame(mode, 1234);
    assert.ok(Array.isArray(g.repKeys), mode);
    assert.equal(g.repKeys.length, 1, mode);
  }
});

// ---------------------------------------------------------------------------
// 象过河
// ---------------------------------------------------------------------------

test('象过河：正常模式不过河，揭棋系列可以过河（仍走田字、仍塞象眼）', () => {
  const mk = (mode) => STM(mode, [
    [4, 9, P('r', 'K')],
    [3, 0, P('b', 'K')],
    [2, 5, P('r', 'B')],
  ], 'r');

  const normal = movesFrom(mk('normal'), I(2, 5)).map(coords);
  assert.ok(normal.length > 0, '正常模式象应能走');
  assert.ok(normal.every((c) => c[1] >= 5), '正常模式象不能过河: ' + JSON.stringify(normal));

  for (const mode of ['jieqi', 'chaosJieqi', 'chaosOpen']) {
    const ts = movesFrom(mk(mode), I(2, 5)).map(coords);
    assert.ok(ts.some((c) => c[1] < 5), mode + ' 里象应能过河: ' + JSON.stringify(ts));
    // 仍然只走田字
    assert.ok(
      ts.every(([x, y]) => Math.abs(x - 2) === 2 && Math.abs(y - 5) === 2),
      mode + ' 象仍然只走田字: ' + JSON.stringify(ts),
    );
  }
});

test('象过河：塞象眼依然生效', () => {
  const s = STM('jieqi', [
    [4, 9, P('r', 'K')],
    [3, 0, P('b', 'K')],
    [2, 5, P('r', 'B')],
    [1, 4, P('b', 'P')], // 堵住通往 (0,3) 的象眼
  ], 'r');
  const ts = movesFrom(s, I(2, 5)).map(coords);
  assert.ok(!ts.some(([x, y]) => x === 0 && y === 3), '象眼被塞就不该能走 (0,3)');
  assert.ok(ts.some(([x, y]) => x === 0 && y === 7), '未被塞的方向仍可走');
});

// ---------------------------------------------------------------------------
// 被翻开的士 / 将解除九宫限制
// ---------------------------------------------------------------------------

test('揭棋：被翻开的士可以走出九宫（未翻开的明子士不行）', () => {
  const mk = (flipped) => {
    const s = STM('jieqi', [
      [4, 9, P('r', 'K')],
      [3, 0, P('b', 'K')],
      [3, 9, P('r', 'A')],
    ], 'r');
    mark(s, 3, 9, { flipped });
    return s;
  };

  const locked = movesFrom(mk(false), I(3, 9)).map(coords);
  assert.deepEqual(locked, [[4, 8]], '未翻开的士只能在九宫内走');

  const free = movesFrom(mk(true), I(3, 9)).map(coords).sort();
  assert.deepEqual(free, [[2, 8], [4, 8]], '翻开的士可以走出九宫');
});

test('揭棋：被翻开的将/帅可以走出九宫（开局即明子的将/帅不行）', () => {
  const mk = (flipped) => {
    const s = STM('jieqi', [
      [3, 9, P('r', 'K')],
      [0, 0, P('b', 'K')],
    ], 'r');
    mark(s, 3, 9, { flipped });
    return s;
  };

  const locked = movesFrom(mk(false), I(3, 9)).map(coords);
  assert.deepEqual(locked, [[3, 8], [4, 9]], '明子将只能在九宫内走');

  const free = movesFrom(mk(true), I(3, 9)).map(coords).sort();
  assert.deepEqual(free, [[2, 9], [3, 8], [4, 9]], '翻开的将可以走出九宫');
});

test('揭棋：士/将的步法不变（士仍走一步斜线、将仍走一步直线）', () => {
  const sA = STM('jieqi', [
    [4, 9, P('r', 'K')],
    [0, 0, P('b', 'K')],
    [4, 4, P('r', 'A')],
  ], 'r');
  mark(sA, 4, 4, { flipped: true });
  const a = movesFrom(sA, I(4, 4)).map(coords);
  assert.ok(a.every(([x, y]) => Math.abs(x - 4) === 1 && Math.abs(y - 4) === 1), '士仍走一步斜线');

  const sK = STM('jieqi', [
    [4, 4, P('r', 'K')],
    [0, 0, P('b', 'K')],
  ], 'r');
  mark(sK, 4, 4, { flipped: true });
  const k = movesFrom(sK, I(4, 4)).map(coords);
  assert.ok(k.every(([x, y]) => (x === 4) !== (y === 4)), '将仍走一步直线');
});

// ---------------------------------------------------------------------------
// 乱棋里被洗到九宫外的士/将
// ---------------------------------------------------------------------------

test('全明乱棋：被洗到九宫外的士/将带 free 标记，九宫内的不带', () => {
  let outside = 0;
  let inside = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const g = createGame('chaosOpen', seed);
    for (let i = 0; i < 90; i++) {
      const p = g.board[i];
      if (!p || (p.type !== 'A' && p.type !== 'K')) continue;
      const x = i % 9;
      const y = (i / 9) | 0;
      const inPalace = x >= 3 && x <= 5 && (p.color === 'r' ? (y >= 7 && y <= 9) : (y >= 0 && y <= 2));
      if (inPalace) {
        assert.equal(!!p.free, false, '九宫内的士/将不该带 free: ' + JSON.stringify([x, y]));
        inside += 1;
      } else {
        assert.equal(!!p.free, true, '九宫外的士/将必须带 free: ' + JSON.stringify([x, y]));
        outside += 1;
      }
    }
  }
  assert.ok(outside > 0, '应至少出现一个被洗到九宫外的士/将');
  assert.ok(inside > 0, '也应至少出现一个在九宫内的士/将');
});

test('全明乱棋：被洗到九宫外的明子士不再是死子', () => {
  const build = (free) => {
    const s = STM('chaosOpen', [
      [4, 9, P('r', 'K')],
      [0, 0, P('b', 'K')],
      [0, 9, P('r', 'A')],
    ], 'r');
    mark(s, 0, 9, { free });
    return s;
  };

  assert.deepEqual(movesFrom(build(false), I(0, 9)), [], '九宫外的士若不解限就一步都走不了');
  assert.deepEqual(movesFrom(build(true), I(0, 9)).map(coords), [[1, 8]], '解限后可以正常走');
});

// ---------------------------------------------------------------------------
// 不泄露内部字段
// ---------------------------------------------------------------------------

test('viewFor 不会把 flipped / free 等内部字段下发给客户端', () => {
  for (const mode of ['jieqi', 'chaosJieqi', 'chaosOpen']) {
    const v = viewFor(createGame(mode, 777), 'r');
    for (const p of v.board) {
      if (!p) continue;
      assert.equal('flipped' in p, false, mode);
      assert.equal('free' in p, false, mode);
    }
  }
});
