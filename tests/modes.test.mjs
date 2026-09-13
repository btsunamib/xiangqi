// 四种模式的布局与暗子规则测试
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, movesFrom, makeMove, roleOfSquare, startingSquares, MODES, inCheck,
} from '../shared/engine.js';
import { P, ST, I, coords } from './_helpers.mjs';

const IDS = ['R', 'R', 'N', 'N', 'B', 'B', 'A', 'A', 'C', 'C', 'P', 'P', 'P', 'P', 'P', 'K'];
const NON_KING_IDS = IDS.filter((t) => t !== 'K');
const ALL_IDS = IDS.concat(IDS); // 红黑各 16 枚，共 32 枚

function countBy(state) {
  let dark = 0, shown = 0;
  for (const p of state.board) {
    if (!p) continue;
    if (p.revealed) shown += 1; else dark += 1;
  }
  return { dark, shown };
}

function layoutKey(g) {
  return g.board.map((p) => (p ? p.type + p.color + (p.revealed ? '1' : '0') : '.')).join('');
}

test('四种模式都能建局，棋子总数 32，红先', () => {
  for (const mode of MODES) {
    const g = createGame(mode, 12345);
    assert.equal(g.board.filter(Boolean).length, 32, mode);
    assert.equal(g.turn, 'r', mode);
    assert.equal(g.over, false, mode);
    assert.equal(g.mode, mode);
  }
});

test('揭棋：将/帅固定在原位且为明子，其余 30 枚为暗子', () => {
  const g = createGame('jieqi', 4242);
  assert.deepEqual(countBy(g), { dark: 30, shown: 2 });

  const bk = g.board[I(4, 0)];
  const rk = g.board[I(4, 9)];
  assert.equal(bk.type, 'K');
  assert.equal(bk.revealed, true);
  assert.equal(bk.color, 'b');
  assert.equal(rk.type, 'K');
  assert.equal(rk.revealed, true);
  assert.equal(rk.color, 'r');
});

test('揭棋：暗子身份多重集恰为除将/帅外的 15 枚（每方各一份）', () => {
  for (const seed of [1, 2, 3, 999]) {
    const g = createGame('jieqi', seed);
    for (const color of ['r', 'b']) {
      const dark = g.board.filter((p) => p && p.color === color && !p.revealed).map((p) => p.type);
      assert.deepEqual(dark.slice().sort(), NON_KING_IDS.slice().sort(), 'seed=' + seed + ' color=' + color);
    }
  }
});

test('揭棋：所有暗子都停在本方初始格上', () => {
  const g = createGame('jieqi', 777);
  for (const color of ['r', 'b']) {
    const squares = new Set(startingSquares(color));
    for (let i = 0; i < 90; i++) {
      const p = g.board[i];
      if (!p || p.color !== color || p.revealed) continue;
      assert.ok(squares.has(i), '暗子在非初始格: ' + JSON.stringify(coords(i)));
      assert.notEqual(roleOfSquare(i), null);
    }
  }
});

test('全乱揭棋：32 枚全暗，铺满 32 个初始格，身份多重集完整', () => {
  const g = createGame('chaosJieqi', 555);
  assert.deepEqual(countBy(g), { dark: 32, shown: 0 });

  const squares = startingSquares('b').concat(startingSquares('r'));
  assert.equal(squares.length, 32);
  for (const sq of squares) {
    const p = g.board[sq];
    assert.ok(p, '每个初始格都必须有子: ' + JSON.stringify(coords(sq)));
    assert.equal(p.revealed, false, '全乱揭棋开局全暗');
  }
  for (let i = 0; i < 90; i++) {
    if (squares.includes(i)) continue;
    assert.equal(g.board[i], null, '初始格之外不应有子: ' + JSON.stringify(coords(i)));
  }

  const ids = g.board.filter(Boolean).map((p) => p.type);
  assert.deepEqual(ids.slice().sort(), ALL_IDS.slice().sort(), '32 枚身份多重集必须完整');
});

test('全乱揭棋：阵营也是乱的 —— 两方半场都会混入对方颜色的子', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  let mixed = 0;
  for (const seed of seeds) {
    const g = createGame('chaosJieqi', seed);
    const redHalf = startingSquares('r').filter((i) => g.board[i] && g.board[i].color === 'b').length;
    const blackHalf = startingSquares('b').filter((i) => g.board[i] && g.board[i].color === 'r').length;
    if (redHalf > 0 && blackHalf > 0) mixed += 1;
  }
  assert.ok(mixed >= seeds.length - 1, '绝大多数 seed 下两侧半场都应混有对方颜色, mixed=' + mixed);
});

test('全明乱棋：布局与全乱揭棋一致，但全部翻开', () => {
  const g = createGame('chaosOpen', 555);
  assert.deepEqual(countBy(g), { dark: 0, shown: 32 });
  const g2 = createGame('chaosJieqi', 555);
  const a = g.board.map((p) => (p ? p.type + p.color : '.'));
  const b = g2.board.map((p) => (p ? p.type + p.color : '.'));
  assert.deepEqual(a, b, '同 seed 下两种模式布局应一致');
});

test('全明乱棋：布局确实被打乱（不是标准开局）', () => {
  const g = createGame('chaosOpen', 2024);
  const std = createGame('normal', 2024);
  let diff = 0;
  for (let i = 0; i < 90; i++) {
    const a = g.board[i], b = std.board[i];
    const at = a ? a.type + a.color : '.';
    const bt = b ? b.type + b.color : '.';
    if (at !== bt) diff += 1;
  }
  assert.ok(diff > 10, '全乱布局应与标准布局明显不同, diff=' + diff);
});

test('相同 seed 布局完全可复现，不同 seed 布局不同', () => {
  for (const mode of ['jieqi', 'chaosJieqi', 'chaosOpen']) {
    assert.equal(layoutKey(createGame(mode, 31337)), layoutKey(createGame(mode, 31337)), mode + ' 同 seed');
    assert.notEqual(layoutKey(createGame(mode, 31337)), layoutKey(createGame(mode, 31338)), mode + ' 不同 seed');
  }
});

test('暗子按所在初始格的"位置角色"走：兵位暗子只走兵步', () => {
  let checked = 0;
  for (const seed of [11, 22, 33, 44, 55]) {
    const g = createGame('chaosJieqi', seed);
    for (let i = 0; i < 90; i++) {
      if (roleOfSquare(i) !== 'P') continue;
      const p = g.board[i];
      if (!p || p.revealed) continue;
      if (p.color !== g.turn) continue;   // 只看当前行棋方（红）
      const from = coords(i);
      const fwd = p.color === 'r' ? -1 : 1;
      const ownSide = p.color === 'r' ? from[1] >= 5 : from[1] <= 4;
      for (const to of movesFrom(g, i)) {
        const c = coords(to);
        const dx = c[0] - from[0];
        const dy = c[1] - from[1];
        if (dy === fwd) {
          assert.equal(dx, 0, '前进只能走同一列: ' + JSON.stringify([from, c]));
        } else {
          assert.equal(ownSide, false, '未过河不应能横走: ' + JSON.stringify([from, c]));
          assert.equal(dy, 0, '横走不能改变行: ' + JSON.stringify([from, c]));
          assert.equal(Math.abs(dx), 1, '横走只能走一格: ' + JSON.stringify([from, c]));
        }
      }
      checked += 1;
    }
  }
  assert.ok(checked > 0, '应至少检查到一个兵位暗子');
});

test('暗子按位置角色走：炮位暗子具备炮的长距离走法', () => {
  let checked = 0;
  for (const seed of [8888, 4242, 777]) {
    const g = createGame('jieqi', seed);
    for (const color of ['r', 'b']) {
      if (g.turn !== color) continue;
      for (const sq of startingSquares(color)) {
        if (roleOfSquare(sq) !== 'C') continue;
        const p = g.board[sq];
        if (!p || p.revealed) continue;
        const far = movesFrom(g, sq).filter((to) => {
          const a = coords(sq), b = coords(to);
          return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) >= 2;
        });
        assert.ok(far.length > 0, '炮位暗子应能走多格: ' + JSON.stringify(coords(sq)));
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, '应至少检查到一个炮位暗子');
});

test('暗子移动后立即翻开，历史记录真实身份', () => {
  const g = createGame('jieqi', 4242);
  let sq = -1;
  for (let i = 0; i < 90; i++) {
    const p = g.board[i];
    if (p && !p.revealed && p.color === 'r') { sq = i; break; }
  }
  assert.ok(sq >= 0, '应有红方暗子');
  const targets = movesFrom(g, sq);
  assert.ok(targets.length > 0);

  const res = makeMove(g, sq, targets[0]);
  assert.equal(res.ok, true);
  const moved = res.state.board[targets[0]];
  assert.equal(moved.revealed, true, '移动后必须翻开');
  assert.ok(res.events.some((e) => e.t === 'reveal' && e.index === targets[0]));
  assert.equal(res.state.history[0].revealed, true);
  assert.equal(res.state.history[0].type, moved.type);
});

test('暗子被吃时先 reveal 再 capture，capture 带真实身份', () => {
  let done = false;
  for (const seed of [4242, 777, 1234, 555]) {
    const g = createGame('jieqi', seed);
    for (let i = 0; i < 90 && !done; i++) {
      const p = g.board[i];
      if (!p || p.color !== g.turn) continue;
      for (const to of movesFrom(g, i)) {
        const q = g.board[to];
        if (!q || q.revealed) continue;
        const res = makeMove(g, i, to);
        const kinds = res.events.map((e) => e.t);
        const ri = kinds.indexOf('reveal');
        const ci = kinds.indexOf('capture');
        assert.ok(ri >= 0 && ci >= 0 && ri < ci, 'reveal 必须早于 capture: ' + JSON.stringify(kinds));
        const cap = res.events.find((e) => e.t === 'capture');
        assert.equal(cap.type, q.type);
        done = true;
        break;
      }
    }
    if (done) break;
  }
  assert.ok(done, '应能找到首步吃暗子的走法');
});

test('暗将/帅被吃 = 立即判负（kingcaptured）', () => {
  const s = ST([
    [3, 9, P('r', 'K', true)],
    [5, 0, P('b', 'K', false)], // 黑将是暗子
    [0, 0, P('r', 'R', true)],
  ], 'r');
  assert.equal(inCheck(s, 'b'), false, '暗将不应被判为被将军');
  const res = makeMove(s, I(0, 0), I(5, 0));
  assert.equal(res.ok, true);
  assert.equal(res.state.over, true);
  assert.equal(res.state.winner, 'r');
  assert.equal(res.state.reason, 'kingcaptured');
});

test('暗将一方不受"送将"约束；翻开后才受约束', () => {
  // 红方将帅是暗子时，红方可以随意走子（引擎不做送将过滤）
  const hidden = ST([
    [3, 9, P('r', 'K', false)],
    [5, 0, P('b', 'K', true)],
    [0, 9, P('r', 'R', true)],
    [4, 5, P('b', 'R', true)],
  ], 'r');
  const okMoves = movesFrom(hidden, I(0, 9));
  assert.ok(okMoves.length > 0, '暗将一方不应被送将限制卡死');

  // 将帅是明子时，同一局面下红车必须解将
  const revealed = ST([
    [3, 9, P('r', 'K', true)],
    [5, 0, P('b', 'K', true)],
    [0, 9, P('r', 'R', true)],
    [3, 5, P('b', 'R', true)],
  ], 'r');
  assert.equal(inCheck(revealed, 'r'), true);
  const ms = movesFrom(revealed, I(0, 9));
  for (const to of ms) {
    const [x] = coords(to);
    assert.equal(x, 3, '红车必须走到第 3 列垫将，实际: ' + JSON.stringify(coords(to)));
  }
});