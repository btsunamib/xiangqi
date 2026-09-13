// public/js/ai.js
// 人机对战 AI：迭代加深 + α-β 剪枝 + 简单局面评估。
// 不依赖 DOM，可在 Node 中直接 import 做测试。
//
// 说明：暗棋模式（揭棋 / 全乱揭棋）下，评估函数对"未翻开的暗子"按其
// 所在初始格的位置角色估值（这是公开信息），不会因为偷看真实身份而虚高。

import { allMoves, makeMove, opposite, roleOfSquare } from '../../shared/engine.js';

const VALUE = { K: 60000, R: 900, C: 450, N: 400, B: 200, A: 200, P: 100 };
const MATE = 1e6;

export const AI_LEVELS = {
  easy: { key: 'easy', name: '简单', depth: 1, timeMs: 400 },
  normal: { key: 'normal', name: '普通', depth: 3, timeMs: 1400 },
  hard: { key: 'hard', name: '困难', depth: 4, timeMs: 2600 },
};

export const DEFAULT_LEVEL = 'normal';

function effectiveType(piece, index) {
  if (piece.revealed) return piece.type;
  return roleOfSquare(index) || piece.type;
}

/** 位置奖励：rel = 0 表示本方底线，rel 越大表示越深入对方阵地 */
function posBonus(type, index, color) {
  const x = index % 9;
  const y = (index / 9) | 0;
  const rel = color === 'r' ? 9 - y : y;
  switch (type) {
    case 'P': return rel * 8 + (x >= 3 && x <= 5 ? 6 : 0);
    case 'R': return (x >= 2 && x <= 6 ? 4 : 0) + rel * 2;
    case 'C': return (x >= 2 && x <= 6 ? 8 : 0) + rel * 2;
    case 'N': return (x >= 2 && x <= 6 && rel >= 2 ? 12 : 0) + rel * 3;
    case 'K': return -rel * 2;
    default: return 0;
  }
}

/** 从 color 视角给局面打分（正数 = 对 color 有利） */
export function evaluate(state, color) {
  let score = 0;
  for (let i = 0; i < 90; i++) {
    const p = state.board[i];
    if (!p) continue;
    const type = effectiveType(p, i);
    const v = (VALUE[type] || 0) + posBonus(type, i, p.color);
    score += p.color === color ? v : -v;
  }
  return score;
}

/** 吃子优先排序，提高剪枝效率 */
function orderMoves(state, moves) {
  if (moves.length < 2) return moves.slice();
  const scored = new Array(moves.length);
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const target = state.board[m.to];
    let s = 0;
    if (target) s = 1000 + (VALUE[effectiveType(target, m.to)] || 0);
    scored[i] = { m, s };
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.map((o) => o.m);
}

function negamax(state, depth, alpha, beta, color, deadline) {
  if (state.over) {
    if (state.winner === color) return MATE - 1;
    if (state.winner === null) return 0;   // 和棋（重复局面，双方都没连续将军）
    return -(MATE - 1);
  }
  if (Date.now() > deadline) return evaluate(state, color);
  if (depth <= 0) return evaluate(state, color);

  const moves = allMoves(state);
  if (moves.length === 0) return -(MATE - 1); // 无着可走 -> 当前行棋方负

  let best = -Infinity;
  const ordered = orderMoves(state, moves);
  for (let i = 0; i < ordered.length; i++) {
    const res = makeMove(state, ordered[i].from, ordered[i].to);
    if (!res.ok) continue;
    const v = -negamax(res.state, depth - 1, -beta, -alpha, opposite(color), deadline);
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * 选一步棋。返回 { from, to } 或 null（无着可走 / 已终局）。
 * @param {object} state 引擎局面
 * @param {{depth?:number, timeMs?:number}} [options]
 */
export function chooseMove(state, options) {
  const opts = options || {};
  if (!state || state.over) return null;

  const moves = allMoves(state);
  if (moves.length === 0) return null;
  if (moves.length === 1) return { from: moves[0].from, to: moves[0].to };

  const maxDepth = Math.max(1, opts.depth || 2);
  const timeMs = Math.max(50, opts.timeMs || 1000);
  const deadline = Date.now() + timeMs;
  const color = state.turn;

  let ordered = orderMoves(state, moves);
  let bestMove = { from: ordered[0].from, to: ordered[0].to };

  for (let depth = 1; depth <= maxDepth; depth++) {
    let iterBest = null;
    let iterScore = -Infinity;
    let alpha = -Infinity;
    let aborted = false;

    for (let i = 0; i < ordered.length; i++) {
      if (Date.now() > deadline) { aborted = true; break; }
      const m = ordered[i];
      const res = makeMove(state, m.from, m.to);
      if (!res.ok) continue;
      const v = -negamax(res.state, depth - 1, -Infinity, -alpha, opposite(color), deadline);
      if (v > iterScore) {
        iterScore = v;
        iterBest = m;
        if (v > alpha) alpha = v;
      }
    }

    // 只有完整跑完这一层才采纳结果（避免半途而废的着法）
    if (iterBest && !aborted) {
      bestMove = { from: iterBest.from, to: iterBest.to };
      const idx = ordered.indexOf(iterBest);
      if (idx > 0) {
        ordered.splice(idx, 1);
        ordered.unshift(iterBest);
      }
    }
    if (aborted) break;
    if (iterScore >= MATE - 100) break; // 已经看到必胜
  }

  return bestMove;
}

export default { chooseMove, evaluate, AI_LEVELS, DEFAULT_LEVEL };
