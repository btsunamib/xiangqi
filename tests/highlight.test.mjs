// 安全吃子高亮（红/绿描边）测试 —— 用户核心需求
import test from 'node:test';
import assert from 'node:assert/strict';
import { highlights, viewFor, allMoves, createGame } from '../shared/engine.js';
import { P, ST, I } from './_helpers.mjs';

// 局面：红帅(3,9)、黑将(5,0)、红车(2,4)、黑车(2,6)
// 红车可以吃黑车(2,6)，且吃完不会被任何黑子反吃 -> 安全吃子
const SAFE = () => ST([
  [3, 9, P('r', 'K')],
  [5, 0, P('b', 'K')],
  [2, 4, P('r', 'R')],
  [2, 6, P('b', 'R')],
], 'r');

// 在上面基础上加一个黑车(3,6)：红车吃(2,6) 后会被 (3,6) 反吃 -> 不算安全吃子
const UNSAFE = () => ST([
  [3, 9, P('r', 'K')],
  [5, 0, P('b', 'K')],
  [2, 4, P('r', 'R')],
  [2, 6, P('b', 'R')],
  [3, 6, P('b', 'R')],
], 'r');

const TARGET = I(2, 6); // 56

test('正例：可以被白吃的棋子会被高亮，且归属色正确', () => {
  const s = SAFE();
  const h = highlights(s);
  assert.deepEqual(h.b, [TARGET], '黑车(2,6) 应被标记为可安全吃');
  assert.deepEqual(h.r, [], '红方没有可被白吃的子');
});

test('正例：黑将不在被攻击位置时不会被误标', () => {
  const h = highlights(SAFE());
  assert.equal(h.b.includes(I(5, 0)), false, '黑将没有被攻击，不该高亮');
  assert.equal(h.b.includes(I(4, 0)), false);
});

test('负例：能被吃但吃完会被反吃 -> 必须不高亮', () => {
  const s = UNSAFE();
  const h = highlights(s);
  assert.deepEqual(h.b, [], '吃了会被 (3,6) 反吃，不应高亮');
  assert.deepEqual(h.r, []);
});

test('负例：棋子根本不能被吃到 -> 不高亮', () => {
  const s = ST([
    [3, 9, P('r', 'K')],
    [5, 0, P('b', 'K')],
    [2, 4, P('r', 'R')],
    [7, 3, P('b', 'R')], // 与红车不同线，吃不到
  ], 'r');
  assert.deepEqual(highlights(s).b, []);
});

test('viewFor：同一批棋子按视角着色（己方红、对方绿）', () => {
  const s = SAFE();
  const red = viewFor(s, 'r'); // 红方是当前行棋方 -> 对方棋子显示绿色
  assert.deepEqual(red.green, [TARGET]);
  assert.deepEqual(red.red, []);

  const black = viewFor(s, 'b'); // 黑方是被吃一方 -> 自己的棋子显示红色
  assert.deepEqual(black.red, [TARGET]);
  assert.deepEqual(black.green, []);
});

test('viewFor：旁观者（viewer=null）看到绿色标记且没有 legal', () => {
  const s = SAFE();
  const v = viewFor(s, null);
  assert.deepEqual(v.green, [TARGET]);
  assert.deepEqual(v.red, []);
  assert.deepEqual(Object.keys(v.legal), []);
});

test('viewFor：只有当前行棋方拿到 legal 着法', () => {
  const s = SAFE();
  assert.ok(Object.keys(viewFor(s, 'r').legal).length > 0);
  assert.deepEqual(Object.keys(viewFor(s, 'b').legal), []);
});

test('高亮与 allMoves 一致：被标记者必定存在一步合法吃子', () => {
  const s = SAFE();
  const h = highlights(s);
  const captures = allMoves(s).filter((m) => m.to === TARGET);
  assert.ok(captures.length > 0, '必须存在真实可走的吃子着法');
  assert.equal(h.b.length, 1);
});

test('终局后不再产生高亮', () => {
  const s = SAFE();
  s.over = true;
  s.winner = 'r';
  s.reason = 'checkmate';
  assert.deepEqual(highlights(s), { r: [], b: [] });
});

test('正常开局无白吃机会（高亮为空）', () => {
  const g = createGame('normal', 5);
  assert.deepEqual(highlights(g), { r: [], b: [] });
  const v = viewFor(g, 'r');
  assert.deepEqual(v.green, []);
  assert.deepEqual(v.red, []);
});

test('暗子身份对任何视角都不泄露（高亮计算不影响保密）', () => {
  const g = createGame('chaosJieqi', 31415);
  for (const viewer of ['r', 'b', null]) {
    const v = viewFor(g, viewer);
    for (const p of v.board) {
      if (p && !p.revealed) assert.equal(p.type, null, '暗子身份泄露给 ' + viewer);
    }
  }
});