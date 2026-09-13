// 本地双人（热座）：直接使用 /shared/engine.js 规则引擎
// 只有在进入本地对局时才动态 import，联机模式下完全不依赖引擎。

let enginePromise = null;

export function loadEngine() {
  if (!enginePromise) {
    enginePromise = import('../../shared/engine.js').catch(function (err) {
      enginePromise = null;
      throw new Error('规则引擎加载失败：' + (err && err.message ? err.message : err));
    });
  }
  return enginePromise;
}

/** 创建本地对局上下文 */
export async function createLocalGame(mode, seed) {
  const engine = await loadEngine();
  const state = engine.createGame(mode, seed);
  return {
    engine: engine,
    mode: mode,
    state: state,
    viewer: state.turn,     // 热座：视角跟随当前行棋方
    events: [],
    over: false,
  };
}

function other(color) {
  return color === 'r' ? 'b' : 'r';
}

/** 由引擎状态生成 ClientView（本地模式自行计算 highlights） */
export function localView(ctx) {
  const engine = ctx.engine;
  const viewer = ctx.viewer;
  const view = engine.viewFor(ctx.state, viewer);

  // 本地模式显式调用 highlights()，按 viewer 相对映射红/绿
  try {
    const hl = engine.highlights(ctx.state);
    // 阵营混置的模式里暗子的颜色是隐藏信息，红/绿描边会泄露阵营 -> 只标注已翻开的子
    const mixed = typeof engine.mixedCamps === 'function' ? engine.mixedCamps(ctx.mode) : false;
    const keep = mixed
      ? function (list) {
          return list.filter(function (i) { return ctx.state.board[i] && ctx.state.board[i].revealed; });
        }
      : function (list) { return list; };
    view.red = viewer ? keep(hl[viewer] || []).slice() : [];
    view.green = viewer ? keep(hl[other(viewer)] || []).slice() : [];
    view.threats = { r: keep(hl.r || []).slice(), b: keep(hl.b || []).slice() };
  } catch (e) {
    view.red = view.red || [];
    view.green = view.green || [];
  }

  view.events = ctx.events || [];
  return view;
}

/** 本地走子；返回 { ok, error, events, view } */
export function localMove(ctx, from, to) {
  const engine = ctx.engine;
  const res = engine.makeMove(ctx.state, from, to);
  if (!res || !res.ok) {
    return { ok: false, error: (res && res.error) || 'illegal_move', events: [], view: localView(ctx) };
  }
  ctx.state = res.state;
  ctx.events = res.events || [];
  ctx.viewer = ctx.state.turn;
  ctx.over = !!ctx.state.over;
  return { ok: true, events: ctx.events, view: localView(ctx) };
}

export function localResign(ctx, color) {
  const engine = ctx.engine;
  if (typeof engine.resign === 'function') {
    ctx.state = engine.resign(ctx.state, color);
  } else {
    ctx.state.over = true;
    ctx.state.winner = other(color);
    ctx.state.reason = 'resign';
  }
  ctx.events = [{ t: 'resign', color: color, winner: other(color) }];
  ctx.over = true;
  return localView(ctx);
}

export function localStatus(ctx) {
  try {
    return ctx.engine.status(ctx.state);
  } catch (e) {
    return { over: !!ctx.state.over, winner: ctx.state.winner, reason: ctx.state.reason, check: { r: false, b: false } };
  }
}

export default { loadEngine, createLocalGame, localView, localMove, localResign, localStatus };
