// 人机 AI 测试：AI 必须只给出合法着法、不修改输入局面、在时间上限内返回。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, allMoves, makeMove, MODES } from '../shared/engine.js';
import { chooseMove, evaluate, AI_LEVELS, DEFAULT_LEVEL } from '../public/js/ai.js';
import { P, ST, I } from './_helpers.mjs';

test('AI 等级预设完整且都有 depth/timeMs', () => {
  for (const key of ['easy', 'normal', 'hard']) {
    const lv = AI_LEVELS[key];
    assert.ok(lv, '缺少等级 ' + key);
    assert.ok(lv.depth >= 1);
    assert.ok(lv.timeMs > 0);
  }
  assert.ok(AI_LEVELS[DEFAULT_LEVEL], '默认等级必须在 AI_LEVELS 中');
});

test('四种模式下 AI 都返回合法着法', () => {
  for (const mode of MODES) {
    const g = createGame(mode, 20240607);
    const mv = chooseMove(g, { depth: 1, timeMs: 400 });
    assert.ok(mv, mode + ' 没有返回着法');
    const ok = allMoves(g).some((m) => m.from === mv.from && m.to === mv.to);
    assert.ok(ok, mode + ' 返回了非法着法: ' + JSON.stringify(mv));
  }
});

test('AI 会吃掉白送的子', () => {
  // 红车(0,0) 可以横向吃掉黑车(0,4)，且不会被任何黑子反吃。
  // 黑将放在 (4,1)：既在九宫内，又不在红车所在的行/列上，避免"直接吃将"成为更优解。
  const s = ST([
    [3, 9, P('r', 'K')],
    [4, 1, P('b', 'K')],
    [0, 0, P('r', 'R')],
    [0, 4, P('b', 'R')],
  ], 'r');
  const mv = chooseMove(s, { depth: 2, timeMs: 800 });
  assert.ok(mv);
  assert.equal(mv.from, I(0, 0));
  assert.equal(mv.to, I(0, 4));
});

test('终局或无处可走时返回 null', () => {
  const g = createGame('normal', 1);
  g.over = true;
  g.winner = 'r';
  g.reason = 'resign';
  assert.equal(chooseMove(g, { depth: 1, timeMs: 100 }), null);

  // 黑方被困毙，无着可走
  const stale = ST([
    [5, 9, P('r', 'K')],
    [4, 0, P('b', 'K')],
    [3, 5, P('r', 'R')],
    [5, 5, P('r', 'R')],
    [0, 1, P('r', 'R')],
  ], 'b');
  assert.equal(chooseMove(stale, { depth: 1, timeMs: 100 }), null);
});

test('AI 不修改传入的局面（纯函数）', () => {
  const g = createGame('normal', 9);
  const snap = () => g.board.map((p) => (p ? p.id + p.type + (p.revealed ? '1' : '0') : '.')).join(',') +
    '|' + g.ply + '|' + g.turn + '|' + g.over;
  const before = snap();
  chooseMove(g, { depth: 2, timeMs: 500 });
  assert.equal(snap(), before, 'AI 搜索修改了输入局面');
});

test('评估函数零和对称', () => {
  const g = createGame('chaosOpen', 777);
  assert.equal(evaluate(g, 'r'), -evaluate(g, 'b'));
});

test('AI 遵守时间上限（不会长时间卡死）', () => {
  const g = createGame('normal', 3);
  const t0 = Date.now();
  const mv = chooseMove(g, { depth: 6, timeMs: 300 });
  const dt = Date.now() - t0;
  assert.ok(mv, '应仍返回着法');
  assert.ok(dt < 3000, 'AI 耗时过长: ' + dt + 'ms');
});

test('AI 自我对弈 12 步全部合法且不崩溃', () => {
  let s = createGame('normal', 42);
  let played = 0;
  for (let i = 0; i < 12 && !s.over; i++) {
    const mv = chooseMove(s, { depth: 1, timeMs: 300 });
    if (!mv) break;
    const res = makeMove(s, mv.from, mv.to);
    assert.equal(res.ok, true, '第 ' + (i + 1) + ' 步非法: ' + JSON.stringify(mv));
    s = res.state;
    played += 1;
  }
  assert.ok(played >= 8, '自我对弈步数过少: ' + played);
});

test('AI 在揭棋模式下也能连续走子（暗子会翻开）', () => {
  let s = createGame('jieqi', 2024);
  for (let i = 0; i < 6 && !s.over; i++) {
    const mv = chooseMove(s, { depth: 1, timeMs: 300 });
    if (!mv) break;
    const res = makeMove(s, mv.from, mv.to);
    assert.equal(res.ok, true);
    s = res.state;
  }
  assert.ok(s.history.length >= 4, '揭棋模式下自我对弈步数过少');
});
