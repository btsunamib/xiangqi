// 规则改造回归测试：
//   1) 长将判负 / 重复局面和棋
//   2) 揭棋系列象/相可以过河
//   3) 被翻开的士/将解除九宫限制
//   4) 乱棋里被洗到九宫外的士/将解除九宫限制
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, movesFrom, makeMove, inCheck, viewFor, mixedCamps,
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

test('象过河：暗象不能过河，翻开的象才能过河（仍走田字）', () => {
  // 把红象放到【黑方的象位】(2,0)：不过河就一步都走不了，最严格地验证语义
  const mk = (mode, opts) => {
    const s = STM(mode, [
      [4, 9, P('r', 'K')],
      [3, 0, P('b', 'K')],
      [2, 0, P('r', 'B')],
    ], 'r');
    const p = s.board[I(2, 0)];
    p.revealed = !!opts.revealed;
    p.flipped = !!opts.flipped;
    p.free = !!opts.free;
    return s;
  };

  // 正常模式：就算硬标成"已翻开"也不放行
  assert.deepEqual(
    movesFrom(mk('normal', { revealed: true, flipped: true, free: true }), I(2, 0)),
    [], '正常模式的象永远不能过河',
  );

  // 揭棋：暗子（按所在格的位置角色走）不能过河
  assert.deepEqual(
    movesFrom(mk('jieqi', { revealed: false }), I(2, 0)),
    [], '暗象不能过河，应无着可走',
  );

  // 揭棋：翻开后可以过河，且仍然只走田字
  const open = movesFrom(mk('jieqi', { revealed: true, flipped: true }), I(2, 0)).map(coords).sort();
  assert.deepEqual(open, [[0, 2], [4, 2]], '翻开的象应能过河');
});

test('象过河：全明乱棋（开局即明子 + free）可以过河', () => {
  const s = STM('chaosOpen', [
    [4, 9, P('r', 'K')],
    [3, 0, P('b', 'K')],
    [2, 0, P('r', 'B')],
  ], 'r');
  const p = s.board[I(2, 0)];
  p.revealed = true;
  p.free = true;   // createGame 对揭棋系列的象都会打上这个标记
  assert.deepEqual(movesFrom(s, I(2, 0)).map(coords).sort(), [[0, 2], [4, 2]]);
});

test('象过河：createGame 给揭棋系列的象打了 free，正常模式不打', () => {
  for (const mode of ['jieqi', 'chaosJieqi', 'chaosOpen']) {
    const g = createGame(mode, 42);
    let n = 0;
    for (let i = 0; i < 90; i++) {
      const p = g.board[i];
      if (p && p.type === 'B') {
        n += 1;
        assert.equal(p.free, true, mode + ' 的象应带 free');
      }
    }
    assert.equal(n, 4, mode + ' 应有 4 只象');
  }
  const g = createGame('normal', 42);
  for (let i = 0; i < 90; i++) {
    const p = g.board[i];
    if (p && p.type === 'B') assert.equal(p.free, false, '正常模式的象不该带 free');
  }
});

test('象过河：塞象眼依然生效', () => {
  const mk = (blocked) => {
    const list = [
      [4, 9, P('r', 'K')],
      [3, 0, P('b', 'K')],
      [2, 5, P('r', 'B')],
    ];
    if (blocked) list.push([1, 4, P('b', 'P')]); // 堵住通往 (0,3) 的象眼
    const s = STM('jieqi', list, 'r');
    const p = s.board[I(2, 5)];
    p.revealed = true;
    p.flipped = true; // 翻开后才允许过河，这样 (0,3) 才在候选里
    return s;
  };

  const free = movesFrom(mk(false), I(2, 5)).map(coords);
  assert.ok(free.some(([x, y]) => x === 0 && y === 3), '没堵象眼时应能走 (0,3): ' + JSON.stringify(free));

  const blocked = movesFrom(mk(true), I(2, 5)).map(coords);
  assert.ok(!blocked.some(([x, y]) => x === 0 && y === 3), '象眼被塞就不该能走 (0,3)');
  assert.ok(blocked.some(([x, y]) => x === 0 && y === 7), '未被塞的方向仍可走');
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

// ---------------------------------------------------------------------------
// 翻开之前不知道阵营
// ---------------------------------------------------------------------------

test('藏阵营：暗子在 viewFor 里 color 为 null，翻开后才有颜色', () => {
  for (const mode of ['jieqi', 'chaosJieqi', 'chaosOpen']) {
    const g = createGame(mode, 2024);
    const v = viewFor(g, 'r');
    for (let i = 0; i < 90; i++) {
      const p = g.board[i];
      if (!p) continue;
      const vp = v.board[i];
      if (p.revealed) {
        assert.equal(vp.color, p.color, mode + ' 明子应有颜色');
        assert.equal(vp.type, p.type, mode + ' 明子应有身份');
      } else {
        assert.equal(vp.color, null, mode + ' 暗子不得泄露阵营');
        assert.equal(vp.type, null, mode + ' 暗子不得泄露身份');
      }
    }
  }
});

test('藏阵营：走一步翻开的子会开始带颜色', () => {
  const g = createGame('jieqi', 808);
  const before = viewFor(g, 'r');
  const dark = [];
  for (let i = 0; i < 90; i++) if (g.board[i] && !g.board[i].revealed) dark.push(i);
  assert.ok(dark.length > 0);
  for (const i of dark) assert.equal(before.board[i].color, null);

  // 红方走任意一步合法着法，被移动的暗子必然翻开
  const from = Number(Object.keys(before.legal)[0]);
  const to = before.legal[from][0];
  const res = makeMove(g, from, to);
  assert.equal(res.ok, true, 'error=' + res.error);
  const after = viewFor(res.state, 'r');
  assert.equal(res.state.board[to].revealed, true, '移动即翻开');
  assert.equal(after.board[to].color, res.state.board[to].color, '翻开后应公开颜色');
  assert.ok(after.board[to].color === 'r' || after.board[to].color === 'b');
});

test('藏阵营：全乱揭棋里红/绿描边与 threats 都不标注暗子', () => {
  const g = createGame('chaosJieqi', 555);
  const v = viewFor(g, 'r');
  for (const i of (v.red || [])) assert.equal(g.board[i].revealed, true, 'red 里不该有暗子');
  for (const i of (v.green || [])) assert.equal(g.board[i].revealed, true, 'green 里不该有暗子');
  for (const i of (v.threats.r || [])) assert.equal(g.board[i].revealed, true, 'threats.r 里不该有暗子');
  for (const i of (v.threats.b || [])) assert.equal(g.board[i].revealed, true, 'threats.b 里不该有暗子');
});

test('mixedCamps：只有全乱揭棋 / 全明乱棋算阵营混置', () => {
  assert.equal(mixedCamps('normal'), false);
  assert.equal(mixedCamps('jieqi'), false);
  assert.equal(mixedCamps('chaosJieqi'), true);
  assert.equal(mixedCamps('chaosOpen'), true);
});
