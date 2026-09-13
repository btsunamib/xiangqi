// 正常模式规则测试（node:test，零依赖）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, allMoves, movesFrom, makeMove, inCheck, status,
} from '../shared/engine.js';
import { P, ST, I, coords } from './_helpers.mjs';

test('标准初始局面：红方合法着法恰好 44 步', () => {
  const g = createGame('normal', 1);
  assert.equal(g.turn, 'r');
  assert.equal(allMoves(g).length, 44);
});

test('标准初始局面：双方 16 子且全部为明子', () => {
  const g = createGame('normal', 1);
  const pieces = g.board.filter(Boolean);
  assert.equal(pieces.length, 32);
  assert.equal(pieces.filter((p) => p.color === 'r').length, 16);
  assert.equal(pieces.filter((p) => p.color === 'b').length, 16);
  assert.equal(pieces.filter((p) => !p.revealed).length, 0);
});

test('仕/相 走斜线（仕在九宫、相走田字不过河）', () => {
  const g = createGame('normal', 1);
  assert.deepEqual(coords(movesFrom(g, I(3, 9))[0]), [4, 8]);
  const bTargets = movesFrom(g, I(2, 9)).map(coords).sort();
  assert.deepEqual(bTargets, [[0, 7], [4, 7]]);
});

test('马：蹩马腿则不能走', () => {
  // 红马(1,9)，马腿(1,8) 用红兵占住 -> 左前方(0,7)/(2,7) 都走不了
  const s = ST([[4, 9, P('r', 'K')], [4, 0, P('b', 'K')], [1, 9, P('r', 'N')], [1, 8, P('r', 'P')]]);
  assert.deepEqual(movesFrom(s, I(1, 9)), []);
});

test('马：无阻挡时可走 (0,7)/(2,7)/(3,8) 三个方向', () => {
  const s = ST([[4, 9, P('r', 'K')], [5, 0, P('b', 'K')], [1, 9, P('r', 'N')]]);
  const t = movesFrom(s, I(1, 9)).map(coords).sort();
  assert.deepEqual(t, [[0, 7], [2, 7], [3, 8]]);
});

test('相：塞象眼则不能走', () => {
  const s = ST([[4, 9, P('r', 'K')], [5, 0, P('b', 'K')], [2, 9, P('r', 'B')], [1, 8, P('r', 'P')]]);
  const t = movesFrom(s, I(2, 9)).map(coords);
  assert.ok(!t.some((c) => c[0] === 0 && c[1] === 7), '象眼被塞，不应能走 (0,7)');
  assert.ok(t.some((c) => c[0] === 4 && c[1] === 7), '另一侧仍可走');
});

test('相：不能过河', () => {
  const s = ST([[4, 9, P('r', 'K')], [5, 0, P('b', 'K')], [2, 7, P('r', 'B')]]);
  const t = movesFrom(s, I(2, 7)).map(coords);
  assert.ok(t.every((c) => c[1] >= 5), '红相必须留在 y>=5');
});

test('炮：不吃子时不能隔子，吃子必须隔一子', () => {
  // 红炮(1,7)，正上方 (1,6) 空，(1,5) 空，(1,4) 放红兵当炮架，(1,3) 放黑卒
  const s = ST([
    [4, 9, P('r', 'K')], [5, 0, P('b', 'K')],
    [1, 7, P('r', 'C')], [1, 4, P('r', 'P')], [1, 3, P('b', 'P')],
  ]);
  const t = movesFrom(s, I(1, 7)).map(coords);
  assert.ok(t.some((c) => c[0] === 1 && c[1] === 6), '炮架前的空格可走');
  assert.ok(t.some((c) => c[0] === 1 && c[1] === 5), '炮架前的空格可走');
  assert.ok(!t.some((c) => c[0] === 1 && c[1] === 4), '不能吃自己的炮架');
  assert.ok(t.some((c) => c[0] === 1 && c[1] === 3), '隔一子吃黑卒');
});

test('兵：过河前只能前进，过河后可横走', () => {
  const before = ST([[4, 9, P('r', 'K')], [5, 0, P('b', 'K')], [2, 6, P('r', 'P')]]);
  assert.deepEqual(movesFrom(before, I(2, 6)).map(coords), [[2, 5]]);

  const after = ST([[4, 9, P('r', 'K')], [5, 0, P('b', 'K')], [2, 4, P('r', 'P')]]);
  const t = movesFrom(after, I(2, 4)).map(coords).sort();
  assert.deepEqual(t, [[1, 4], [2, 3], [3, 4]]);
});

test('士与将只能在九宫内活动', () => {
  const s = ST([[4, 9, P('r', 'K')], [5, 0, P('b', 'K')], [3, 8, P('r', 'A')]]);
  for (const to of movesFrom(s, I(3, 8))) {
    const [x, y] = coords(to);
    assert.ok(x >= 3 && x <= 5 && y >= 7 && y <= 9, '士越出九宫: ' + x + ',' + y);
  }
  const k = ST([[4, 9, P('r', 'K')], [5, 0, P('b', 'K')]]);
  for (const to of movesFrom(k, I(4, 9))) {
    const [x, y] = coords(to);
    assert.ok(x >= 3 && x <= 5 && y >= 7 && y <= 9, '帅越出九宫: ' + x + ',' + y);
  }
});

test('飞将：同列无子可直接吃对方将/帅；有子则不可', () => {
  const open = ST([[4, 9, P('r', 'K')], [4, 0, P('b', 'K')]]);
  assert.ok(movesFrom(open, I(4, 9)).includes(I(4, 0)), '应可飞将吃将');
  assert.equal(inCheck(open, 'r'), true);
  assert.equal(inCheck(open, 'b'), true);

  const blocked = ST([[4, 9, P('r', 'K')], [4, 0, P('b', 'K')], [4, 5, P('b', 'P')]]);
  assert.ok(!movesFrom(blocked, I(4, 9)).includes(I(4, 0)), '中间有子不能飞将');
});

test('被将军时只能走解将着法', () => {
  const s = ST([
    [4, 9, P('r', 'K')], [5, 0, P('b', 'K')],
    [4, 5, P('b', 'R')],
    [0, 9, P('r', 'R')], [0, 6, P('r', 'P')],
  ], 'r');
  assert.equal(inCheck(s, 'r'), true);
  const ms = allMoves(s);
  assert.equal(ms.length, 1, '唯一解将着法：帅(4,9)->(3,9)');
  assert.deepEqual(coords(ms[0].from), [4, 9]);
  assert.deepEqual(coords(ms[0].to), [3, 9]);
  // (5,9) 会与黑将(5,0) 照面，因此非法
  assert.ok(!movesFrom(s, I(4, 9)).includes(I(5, 9)));
});

test('困毙（无着可走且未被将军）判负', () => {
  const s = ST([
    [5, 9, P('r', 'K')], [4, 0, P('b', 'K')],
    [3, 5, P('r', 'R')], [5, 5, P('r', 'R')], [0, 1, P('r', 'R')],
  ], 'b');
  assert.equal(allMoves(s).length, 0);
  assert.equal(inCheck(s, 'b'), false);
  const st = status(s);
  assert.equal(st.over, true);
  assert.equal(st.winner, 'r');
  assert.equal(st.reason, 'stalemate');
});

test('绝杀（将军且无着可解）判负', () => {
  const s = ST([
    [5, 9, P('r', 'K')], [4, 0, P('b', 'K')],
    [4, 1, P('r', 'R')], [4, 5, P('r', 'R')],
    [3, 5, P('r', 'R')], [5, 5, P('r', 'R')],
  ], 'b');
  assert.equal(inCheck(s, 'b'), true);
  assert.equal(allMoves(s).length, 0);
  const st = status(s);
  assert.equal(st.over, true);
  assert.equal(st.winner, 'r');
  assert.equal(st.reason, 'checkmate');
});

test('makeMove 是纯函数：不修改入参', () => {
  const g = createGame('normal', 7);
  const before = JSON.stringify(g.board.map((p) => (p ? [p.id, p.color, p.type, p.revealed] : null)));
  const res = makeMove(g, I(1, 7), I(4, 7));
  assert.equal(res.ok, true);
  const after = JSON.stringify(g.board.map((p) => (p ? [p.id, p.color, p.type, p.revealed] : null)));
  assert.equal(after, before, '入参局面被修改了');
  assert.equal(g.ply, 0);
  assert.equal(res.state.ply, 1);
  assert.equal(res.state.turn, 'b');
});

test('makeMove 拒绝非法着法与错误方走子', () => {
  const g = createGame('normal', 7);
  assert.equal(makeMove(g, I(0, 9), I(4, 4)).ok, false, '车不能跳着走');
  assert.equal(makeMove(g, I(0, 0), I(0, 1)).ok, false, '不能替黑方走子');
  assert.equal(makeMove(g, I(3, 9), I(3, 8)).ok, false, '仕不能直走');
  assert.equal(makeMove(g, 5, 5).ok, false, '空格不能走');
});

test('吃子后必须切换行棋方并记录历史', () => {
  const g = createGame('normal', 7);
  const res = makeMove(g, I(1, 7), I(4, 7)); // 炮二平五
  assert.equal(res.ok, true);
  assert.equal(res.state.turn, 'b');
  assert.equal(res.state.history.length, 1);
  assert.equal(res.state.lastMove.from, I(1, 7));
  assert.equal(res.state.lastMove.to, I(4, 7));
  assert.ok(res.events.some((e) => e.t === 'move'));
});

test('吃将立刻结束对局（kingcaptured）', () => {
  const s = ST([
    [4, 9, P('r', 'K')], [5, 0, P('b', 'K')],
    [0, 0, P('r', 'R')],
  ], 'r');
  const res = makeMove(s, I(0, 0), I(5, 0));
  assert.equal(res.ok, true);
  assert.equal(res.state.over, true);
  assert.equal(res.state.winner, 'r');
  assert.equal(res.state.reason, 'kingcaptured');
  assert.ok(res.events.some((e) => e.t === 'kingcaptured'));
});