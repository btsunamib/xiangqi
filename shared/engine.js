// shared/engine.js
// 中国象棋规则引擎：正常模式 / 揭棋 / 全乱揭棋 / 全明乱棋
// 零依赖，纯函数，可同时在 Node 与浏览器中运行。
// 接口契约见 docs/CONTRACTS.md 第 1~4 节（已冻结）。
//
// 坐标：index = y*9 + x，x:0..8 左->右，y:0..9 上->下。
//       上方 y=0..4 为黑方 'b'，下方 y=9..5 为红方 'r'（红方在下方）。

export const MODES = ['normal', 'jieqi', 'chaosJieqi', 'chaosOpen'];

export const MODE_INFO = {
  normal: {
    key: 'normal', name: '正常模式', dark: false, chaos: false,
    desc: '标准中国象棋，双方全明开局。',
  },
  jieqi: {
    key: 'jieqi', name: '揭棋', dark: true, chaos: false,
    desc: '将帅明子固定原位，其余 15 枚身份随机暗置；暗子按所在位置角色走，走动即翻开。',
  },
  chaosJieqi: {
    key: 'chaosJieqi', name: '全乱揭棋', dark: true, chaos: true,
    desc: '含将帅在内 16 枚身份全部随机暗置；将帅被吃立即判负。',
  },
  chaosOpen: {
    key: 'chaosOpen', name: '全明乱棋', dark: false, chaos: true,
    desc: '全乱布局，但开局即全部翻开，按标准象棋规则行棋。',
  },
};

// 汉字字形（前端可直接使用）
export const PIECE_GLYPH = {
  r: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
  b: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' },
};

const BACK_ROLES = ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R'];
const DIRS4 = [[0, -1], [0, 1], [-1, 0], [1, 0]];
const DIAG4 = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const KNIGHT_DELTAS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

export function opposite(color) {
  return color === 'r' ? 'b' : 'r';
}

export function idx(x, y) {
  return y * 9 + x;
}

export function xy(i) {
  return { x: i % 9, y: (i / 9) | 0 };
}

/** 初始格（含九宫、炮位、兵位）的位置角色；非初始格返回 null。 */
export function roleOfSquare(index) {
  if (index < 0 || index > 89) return null;
  const { x, y } = xy(index);
  if (y === 0 || y === 9) return BACK_ROLES[x];
  if ((y === 2 || y === 7) && (x === 1 || x === 7)) return 'C';
  if ((y === 3 || y === 6) && x % 2 === 0) return 'P';
  return null;
}

/** 某一方 16 个初始格的索引（顺序固定，保证洗牌可复现）。 */
export function startingSquares(color) {
  const backY = color === 'b' ? 0 : 9;
  const cannonY = color === 'b' ? 2 : 7;
  const pawnY = color === 'b' ? 3 : 6;
  const out = [];
  for (let x = 0; x < 9; x++) out.push(idx(x, backY));
  out.push(idx(1, cannonY), idx(7, cannonY));
  for (const x of [0, 2, 4, 6, 8]) out.push(idx(x, pawnY));
  return out;
}

function onOwnSide(color, y) {
  return color === 'r' ? y >= 5 : y <= 4;
}

function inPalace(color, x, y) {
  if (x < 3 || x > 5) return false;
  return color === 'r' ? (y >= 7 && y <= 9) : (y >= 0 && y <= 2);
}

function mulberry32(a) {
  let s = a >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(rng, input) {
  const a = input.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

function randomSeed() {
  return (Math.floor(Math.random() * 0x100000000) >>> 0);
}

// ---------------------------------------------------------------------------
// 建局
// ---------------------------------------------------------------------------

export function createGame(mode = 'normal', seed) {
  if (!MODES.includes(mode)) throw new Error('unknown mode: ' + mode);
  const s = (seed === undefined || seed === null) ? randomSeed() : (seed >>> 0);
  const st = {
    mode, seed: s,
    board: new Array(90).fill(null),
    turn: 'r', ply: 0,
    over: false, winner: null, reason: null,
    history: [], lastMove: null,
  };
  let n = 0;
  const put = (i, color, type, revealed) => {
    st.board[i] = { id: color + type + (n++), color, type, revealed };
  };

  if (mode === 'normal') {
    for (const color of ['b', 'r']) {
      const backY = color === 'b' ? 0 : 9;
      const cannonY = color === 'b' ? 2 : 7;
      const pawnY = color === 'b' ? 3 : 6;
      for (let x = 0; x < 9; x++) put(idx(x, backY), color, BACK_ROLES[x], true);
      put(idx(1, cannonY), color, 'C', true);
      put(idx(7, cannonY), color, 'C', true);
      for (const x of [0, 2, 4, 6, 8]) put(idx(x, pawnY), color, 'P', true);
    }
    return st;
  }

  // 揭棋 / 全乱揭棋 / 全明乱棋：身份洗牌
  const rng = mulberry32(s);
  for (const color of ['b', 'r']) {
    const squares = startingSquares(color);
    if (mode === 'jieqi') {
      // 帅/将固定在九宫原位且为明子；其余 15 枚身份洗牌到其余 15 格
      const kingSq = squares.find((i) => roleOfSquare(i) === 'K');
      put(kingSq, color, 'K', true);
      const others = squares.filter((i) => i !== kingSq);
      const ids = shuffle(rng, ['R', 'R', 'N', 'N', 'B', 'B', 'A', 'A', 'C', 'C', 'P', 'P', 'P', 'P', 'P']);
      others.forEach((sq, k) => put(sq, color, ids[k], false));
    } else {
      // 全乱：含将帅在内 16 枚身份洗牌到 16 个初始格
      const ids = shuffle(rng, ['R', 'R', 'N', 'N', 'B', 'B', 'A', 'A', 'C', 'C', 'P', 'P', 'P', 'P', 'P', 'K']);
      const revealed = mode === 'chaosOpen';
      squares.forEach((sq, k) => put(sq, color, ids[k], revealed));
    }
  }
  return st;
}

export function cloneState(state) {
  const board = new Array(90);
  for (let i = 0; i < 90; i++) {
    const p = state.board[i];
    board[i] = p ? { id: p.id, color: p.color, type: p.type, revealed: p.revealed } : null;
  }
  return {
    mode: state.mode,
    seed: state.seed,
    board,
    turn: state.turn,
    ply: state.ply,
    over: state.over,
    winner: state.winner,
    reason: state.reason,
    history: state.history.slice(),
    lastMove: state.lastMove ? { from: state.lastMove.from, to: state.lastMove.to } : null,
  };
}

export function serialize(state) {
  return state;
}

// ---------------------------------------------------------------------------
// 着法生成
// ---------------------------------------------------------------------------

function findRevealedKing(state, color) {
  const board = state.board;
  for (let i = 0; i < 90; i++) {
    const p = board[i];
    if (p && p.color === color && p.type === 'K' && p.revealed) return i;
  }
  return -1;
}

/** 伪合法着法（不考虑己方将帅安全）。暗子按所在初始格的角色走。 */
function pseudoTargets(state, from) {
  const out = [];
  const board = state.board;
  const p = board[from];
  if (!p) return out;
  const type = p.revealed ? p.type : roleOfSquare(from);
  if (!type) return out;
  const c = p.color;
  const x = from % 9;
  const y = (from / 9) | 0;
  const at = (xx, yy) => (xx < 0 || xx > 8 || yy < 0 || yy > 9) ? undefined : board[yy * 9 + xx];

  switch (type) {
    case 'R': {
      for (let d = 0; d < 4; d++) {
        const dx = DIRS4[d][0], dy = DIRS4[d][1];
        let xx = x + dx, yy = y + dy;
        for (;;) {
          const q = at(xx, yy);
          if (q === undefined) break;
          if (q === null) { out.push(yy * 9 + xx); }
          else { if (q.color !== c) out.push(yy * 9 + xx); break; }
          xx += dx; yy += dy;
        }
      }
      break;
    }
    case 'C': {
      for (let d = 0; d < 4; d++) {
        const dx = DIRS4[d][0], dy = DIRS4[d][1];
        let xx = x + dx, yy = y + dy, jumped = false;
        for (;;) {
          const q = at(xx, yy);
          if (q === undefined) break;
          if (!jumped) {
            if (q === null) out.push(yy * 9 + xx);
            else jumped = true;
          } else if (q !== null) {
            if (q.color !== c) out.push(yy * 9 + xx);
            break;
          }
          xx += dx; yy += dy;
        }
      }
      break;
    }
    case 'N': {
      for (let k = 0; k < 8; k++) {
        const dx = KNIGHT_DELTAS[k][0], dy = KNIGHT_DELTAS[k][1];
        const lx = dx === 2 || dx === -2 ? x + dx / 2 : x;
        const ly = dy === 2 || dy === -2 ? y + dy / 2 : y;
        if (at(lx, ly) !== null) continue; // 蹩马腿
        const q = at(x + dx, y + dy);
        if (q === undefined) continue;
        if (q === null || q.color !== c) out.push((y + dy) * 9 + (x + dx));
      }
      break;
    }
    case 'B': {
      for (let d = 0; d < 4; d++) {
        const dx = DIAG4[d][0], dy = DIAG4[d][1];
        const nx = x + dx * 2, ny = y + dy * 2;
        if (nx < 0 || nx > 8 || ny < 0 || ny > 9) continue;
        if (!onOwnSide(c, ny)) continue;          // 象不过河
        if (at(x + dx, y + dy) !== null) continue; // 塞象眼
        const q = at(nx, ny);
        if (q === null || q.color !== c) out.push(ny * 9 + nx);
      }
      break;
    }
    case 'A': {
      for (let d = 0; d < 4; d++) {
        const nx = x + DIAG4[d][0], ny = y + DIAG4[d][1];
        if (!inPalace(c, nx, ny)) continue;
        const q = at(nx, ny);
        if (q === null || q.color !== c) out.push(ny * 9 + nx);
      }
      break;
    }
    case 'K': {
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRS4[d][0], ny = y + DIRS4[d][1];
        if (!inPalace(c, nx, ny)) continue;
        const q = at(nx, ny);
        if (q === null || q.color !== c) out.push(ny * 9 + nx);
      }
      // 飞将：同列且中间无子时，可直接吃掉对方已翻开的将/帅
      const ek = findRevealedKing(state, opposite(c));
      if (ek >= 0) {
        const ex = ek % 9, ey = (ek / 9) | 0;
        if (ex === x) {
          const dir = ey > y ? 1 : -1;
          let clear = true;
          for (let yy = y + dir; yy !== ey; yy += dir) {
            if (board[yy * 9 + x]) { clear = false; break; }
          }
          if (clear) out.push(ek);
        }
      }
      break;
    }
    case 'P': {
      const fwd = c === 'r' ? -1 : 1;
      const ny = y + fwd;
      if (ny >= 0 && ny <= 9) {
        const q = at(x, ny);
        if (q === null || q.color !== c) out.push(ny * 9 + x);
      }
      if (!onOwnSide(c, y)) { // 过河后可横走
        for (const dx of [-1, 1]) {
          const q = at(x + dx, y);
          if (q === undefined) continue;
          if (q === null || q.color !== c) out.push(y * 9 + (x + dx));
        }
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/** 某方所有伪合法攻击到的格子集合（用于被将检测）。 */
function isAttacked(state, target, byColor) {
  const board = state.board;
  for (let i = 0; i < 90; i++) {
    const p = board[i];
    if (!p || p.color !== byColor) continue;
    const ts = pseudoTargets(state, i);
    for (let k = 0; k < ts.length; k++) if (ts[k] === target) return true;
  }
  return false;
}

/**
 * 一步是否合法。
 * 关键规则：只有当走子方自己的将/帅【在走这步之前就已经翻开】时，才受"不能送将"约束；
 * 将/帅还是暗子的一方不受约束（因为本人并不知道将/帅在哪），代价是对手下一步可以吃掉它。
 */
function isLegalMove(state, from, to) {
  const p = state.board[from];
  if (!p || p.color !== state.turn) return false;
  const c = p.color;
  const tgt = state.board[to];
  if (tgt && tgt.color === c) return false;

  const k0 = findRevealedKing(state, c);
  if (k0 < 0) return true;                                   // 己方将/帅未翻开 -> 无送将限制
  if (tgt && tgt.type === 'K' && tgt.revealed) return true;  // 可以直接吃对方将/帅

  // 原地模拟：移动 + 翻开，检查己方明将是否被攻击
  const pWasRevealed = p.revealed;
  const tWasRevealed = tgt ? tgt.revealed : false;
  state.board[from] = null;
  state.board[to] = p;
  p.revealed = true;
  if (tgt) tgt.revealed = true;
  let ok = true;
  const k = findRevealedKing(state, c);
  if (k >= 0) ok = !isAttacked(state, k, opposite(c));
  state.board[from] = p;
  state.board[to] = tgt;
  p.revealed = pWasRevealed;
  if (tgt) tgt.revealed = tWasRevealed;
  return ok;
}

export function movesFrom(state, from) {
  if (state.over) return [];
  if (typeof from !== 'number' || from < 0 || from > 89) return [];
  const p = state.board[from];
  if (!p || p.color !== state.turn) return [];
  const ts = pseudoTargets(state, from);
  const out = [];
  for (let k = 0; k < ts.length; k++) if (isLegalMove(state, from, ts[k])) out.push(ts[k]);
  return out;
}

const movesCache = new WeakMap();

export function allMoves(state) {
  if (state.over) return [];
  const cached = movesCache.get(state);
  if (cached) return cached;
  const out = [];
  for (let i = 0; i < 90; i++) {
    const p = state.board[i];
    if (!p || p.color !== state.turn) continue;
    const ts = movesFrom(state, i);
    for (let k = 0; k < ts.length; k++) out.push({ from: i, to: ts[k] });
  }
  movesCache.set(state, out);
  return out;
}

// ---------------------------------------------------------------------------
// 执行着法
// ---------------------------------------------------------------------------

function applyRaw(state, from, to) {
  const ns = cloneState(state);
  const p = ns.board[from];
  const tgt = ns.board[to];
  const events = [];
  const wasDark = !p.revealed;

  events.push({ t: 'move', from, to, color: p.color, type: p.type, dark: wasDark });

  let captured = null;
  if (tgt) {
    if (!tgt.revealed) {
      tgt.revealed = true;
      events.push({ t: 'reveal', index: to, color: tgt.color, type: tgt.type });
    }
    events.push({
      t: 'capture', index: to, color: tgt.color, type: tgt.type,
      byColor: p.color, byType: p.type,
    });
    captured = { type: tgt.type, color: tgt.color };
  }

  ns.board[from] = null;
  ns.board[to] = p;
  if (wasDark) {
    p.revealed = true;
    events.push({ t: 'reveal', index: to, color: p.color, type: p.type });
  }

  ns.turn = opposite(p.color);
  ns.ply = state.ply + 1;
  ns.lastMove = { from, to };
  ns.history = state.history.concat([{
    n: ns.ply, color: p.color, from, to,
    type: p.type, captured, revealed: wasDark,
  }]);
  ns.over = false;
  ns.winner = null;
  ns.reason = null;

  return { ns, events, mover: p.color, capturedKing: !!(captured && captured.type === 'K') };
}

function applyFull(state, from, to) {
  const { ns, events, mover, capturedKing } = applyRaw(state, from, to);

  if (capturedKing) {
    ns.over = true;
    ns.winner = mover;
    ns.reason = 'kingcaptured';
  } else {
    const ms = allMoves(ns);
    if (ms.length === 0) {
      ns.over = true;
      ns.winner = mover;
      ns.reason = inCheck(ns, ns.turn) ? 'checkmate' : 'stalemate';
    }
  }

  if (ns.over) {
    events.push({
      t: ns.reason,
      winner: ns.winner,
      loser: opposite(ns.winner),
    });
  } else if (inCheck(ns, ns.turn)) {
    events.push({ t: 'check', color: ns.turn });
  }

  return { state: ns, events };
}

export function makeMove(state, from, to) {
  if (state.over) return { ok: false, error: 'game_over' };
  if (typeof from !== 'number' || typeof to !== 'number' || from < 0 || from > 89 || to < 0 || to > 89) {
    return { ok: false, error: 'bad_move' };
  }
  const p = state.board[from];
  if (!p) return { ok: false, error: 'empty_from' };
  if (p.color !== state.turn) return { ok: false, error: 'not_your_turn' };
  if (!movesFrom(state, from).includes(to)) return { ok: false, error: 'illegal_move' };
  const res = applyFull(state, from, to);
  return { ok: true, state: res.state, events: res.events };
}

export function resign(state, color) {
  if (state.over) return state;
  const ns = cloneState(state);
  ns.over = true;
  ns.winner = opposite(color);
  ns.reason = 'resign';
  return ns;
}

// ---------------------------------------------------------------------------
// 状态查询
// ---------------------------------------------------------------------------

export function inCheck(state, color) {
  const k = findRevealedKing(state, color);
  if (k < 0) return false; // 将/帅未翻开 -> 不存在"被将军"
  return isAttacked(state, k, opposite(color));
}

/**
 * 权威终局判定。即使传入的是手工构造、尚未经过 applyFull 的局面，
 * 也会自行推导「无着可走 -> 负」的终局，不会返回过期的 over。
 */
export function status(state) {
  const check = { r: inCheck(state, 'r'), b: inCheck(state, 'b') };
  if (state.over) {
    return { over: true, winner: state.winner, reason: state.reason, check };
  }
  if (allMoves(state).length === 0) {
    return {
      over: true,
      winner: opposite(state.turn),
      reason: check[state.turn] ? 'checkmate' : 'stalemate',
      check,
    };
  }
  return { over: false, winner: null, reason: null, check };
}

// ---------------------------------------------------------------------------
// 安全吃子高亮（用户核心需求）
//   某枚棋子 P 能被对方吃掉，且对方吃掉它之后不会被任何棋子反吃（"白吃"）。
//   返回 { r:[索引...], b:[索引...] }，按【被吃方】归属色分组。
//   同一组格子在 viewFor 里按视角着色：P 是自己的 -> 红描边；P 是对方的 -> 绿描边。
// ---------------------------------------------------------------------------

const hlCache = new WeakMap();

export function highlights(state) {
  const empty = { r: [], b: [] };
  if (state.over) return empty;
  const cached = hlCache.get(state);
  if (cached) return cached;

  const res = { r: [], b: [] };
  const owner = opposite(state.turn); // 当前可能被白吃的一方
  const moves = allMoves(state);      // 当前走子方的全部合法着法

  const byTarget = new Map();
  for (let k = 0; k < moves.length; k++) {
    const m = moves[k];
    let list = byTarget.get(m.to);
    if (!list) { list = []; byTarget.set(m.to, list); }
    list.push(m.from);
  }

  for (let i = 0; i < 90; i++) {
    const p = state.board[i];
    if (!p || p.color !== owner) continue;
    const attackers = byTarget.get(i);
    if (!attackers || attackers.length === 0) continue;

    // 被吃的是将/帅 -> 直接终局，视为可安全吃
    if (p.type === 'K') { res[p.color].push(i); continue; }

    let safe = false;
    for (let a = 0; a < attackers.length; a++) {
      const sim = applyRaw(state, attackers[a], i); // 对手吃子后的局面
      const counter = allMoves(sim.ns);             // 被吃方能否反吃
      let canRecapture = false;
      for (let c = 0; c < counter.length; c++) {
        if (counter[c].to === i) { canRecapture = true; break; }
      }
      if (!canRecapture) { safe = true; break; }
    }
    if (safe) res[p.color].push(i);
  }

  hlCache.set(state, res);
  return res;
}

// ---------------------------------------------------------------------------
// 客户端视图（隐藏暗子真实身份）
// ---------------------------------------------------------------------------

export function viewFor(state, viewer) {
  const board = new Array(90).fill(null);
  for (let i = 0; i < 90; i++) {
    const p = state.board[i];
    if (!p) continue;
    board[i] = {
      i,
      id: p.id,
      color: p.color,
      type: p.revealed ? p.type : null, // 暗子对任何人都不暴露身份
      revealed: p.revealed,
      role: p.revealed ? null : roleOfSquare(i), // 公开信息：该初始格的角色
    };
  }

  const hl = highlights(state);
  const owner = state.over ? null : opposite(state.turn);
  const targets = owner ? (hl[owner] || []) : [];

  let legal = {};
  if (!state.over && viewer && (viewer === 'r' || viewer === 'b') && viewer === state.turn) {
    const ms = allMoves(state);
    for (let k = 0; k < ms.length; k++) {
      const m = ms[k];
      if (!legal[m.from]) legal[m.from] = [];
      legal[m.from].push(m.to);
    }
  }

  return {
    mode: state.mode,
    seed: state.seed,
    turn: state.turn,
    ply: state.ply,
    over: state.over,
    winner: state.winner,
    reason: state.reason,
    board,
    check: { r: inCheck(state, 'r'), b: inCheck(state, 'b') },
    legal,
    // 同一批"可被白吃"的棋子：自己看到红色（危险），对方看到绿色（机会）
    red: viewer && viewer === owner ? targets.slice() : [],
    green: !viewer || viewer === state.turn ? targets.slice() : [],
    threats: { r: (hl.r || []).slice(), b: (hl.b || []).slice() },
    lastMove: state.lastMove ? { from: state.lastMove.from, to: state.lastMove.to } : null,
    history: state.history.map((h) => ({
      n: h.n, color: h.color, from: h.from, to: h.to,
      type: h.type, captured: h.captured ? { type: h.captured.type, color: h.captured.color } : null,
      revealed: !!h.revealed,
    })),
    events: [],
  };
}

export default {
  MODES, MODE_INFO, PIECE_GLYPH,
  createGame, cloneState, serialize, movesFrom, allMoves, makeMove,
  inCheck, status, highlights, viewFor, resign,
  opposite, idx, xy, roleOfSquare, startingSquares,
};
