// 测试辅助：手工构造局面（不属于测试文件本身，不会被 --test 收集）
export const I = (x, y) => y * 9 + x;

let seq = 0;
export function P(color, type, revealed = true) {
  seq += 1;
  return { id: color + type + seq, color, type, revealed };
}

/** 用 [x, y, piece] 列表构造一个 normal 模式局面 */
export function ST(list, turn = 'r') {
  const board = new Array(90).fill(null);
  for (const [x, y, p] of list) board[y * 9 + x] = p;
  return {
    mode: 'normal',
    seed: 1,
    board,
    turn,
    ply: 0,
    over: false,
    winner: null,
    reason: null,
    history: [],
    lastMove: null,
  };
}

export const coords = (i) => [i % 9, (i / 9) | 0];

export function moveList(state, allMoves) {
  return allMoves(state).map((m) => [coords(m.from), coords(m.to)]);
}