// public/js/board.js
// 棋盘渲染与走子交互。
//  - SVG 画线（楚河汉界 / 九宫 / 炮位兵位十字标记 / 双线外框）
//  - 棋子用绝对定位 DOM + CSS transform 过渡，走子平滑滑动
//  - 暗子统一背面纹样，绝不泄露真实身份（只用"楚/汉"表示颜色，颜色是公开信息）
//  - 红/绿描边：view.red = 我方被白吃（红），view.green = 可白吃对方（绿）
// 坐标严格遵循引擎约定：index = y*9 + x，x:0..8 左->右，y:0..9 上->下，红方在下。

const CELL = 62;
const MARGIN = 36;
const COLS = 9;
const ROWS = 10;
const BOARD_W = MARGIN * 2 + (COLS - 1) * CELL; // 568
const BOARD_H = MARGIN * 2 + (ROWS - 1) * CELL; // 630
const SVG_NS = 'http://www.w3.org/2000/svg';

export const BOARD_SIZE = { w: BOARD_W, h: BOARD_H, cell: CELL, margin: MARGIN };

const GLYPH = {
  r: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
  b: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' },
};
// 暗子背面：只体现颜色（颜色本就公开），不体现任何身份
const DARK_GLYPH = { r: '汉', b: '楚' };

const cellX = (x) => MARGIN + x * CELL;
const cellY = (y) => MARGIN + y * CELL;
const centerOf = (i) => ({ x: cellX(i % 9), y: cellY((i / 9) | 0) });
const tf = (i) => {
  const c = centerOf(i);
  return 'translate(' + c.x + 'px,' + c.y + 'px)';
};

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  if (attrs) {
    for (const k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, String(attrs[k]));
    }
  }
  return node;
}

function line(x1, y1, x2, y2, cls) {
  return el('line', { x1, y1, x2, y2, class: cls || 'gline' });
}

/** 炮位 / 兵位的十字标记（贴边处省略越界的角） */
function crossMarks(g, x, y) {
  const dirs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (const d of dirs) {
    const dx = d[0], dy = d[1];
    const px = cellX(x) + dx * 7;
    const py = cellY(y) + dy * 7;
    const ax = cellX(x) + dx * 18;
    const ay = cellY(y) + dy * 18;
    if (ax < 0 || ax > BOARD_W || ay < 0 || ay > BOARD_H) continue;
    g.appendChild(line(px, py, ax, py));
    g.appendChild(line(px, py, px, ay));
  }
}

function buildSvg() {
  const svg = el('svg', {
    class: 'board-svg',
    width: BOARD_W,
    height: BOARD_H,
    viewBox: '0 0 ' + BOARD_W + ' ' + BOARD_H,
  });

  const g = el('g');
  svg.appendChild(g);

  // 横线 10 条
  for (let j = 0; j < ROWS; j++) {
    g.appendChild(line(cellX(0), cellY(j), cellX(8), cellY(j)));
  }
  // 竖线 9 条（中间 7 条在河界处断开）
  for (let i = 0; i < COLS; i++) {
    if (i === 0 || i === 8) {
      g.appendChild(line(cellX(i), cellY(0), cellX(i), cellY(9)));
    } else {
      g.appendChild(line(cellX(i), cellY(0), cellX(i), cellY(4)));
      g.appendChild(line(cellX(i), cellY(5), cellX(i), cellY(9)));
    }
  }

  // 九宫斜线
  g.appendChild(line(cellX(3), cellY(0), cellX(5), cellY(2)));
  g.appendChild(line(cellX(5), cellY(0), cellX(3), cellY(2)));
  g.appendChild(line(cellX(3), cellY(7), cellX(5), cellY(9)));
  g.appendChild(line(cellX(5), cellY(7), cellX(3), cellY(9)));

  // 炮位 / 兵位十字标记
  const marks = [
    [1, 2], [7, 2], [1, 7], [7, 7],
    [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
    [0, 6], [2, 6], [4, 6], [6, 6], [8, 6],
  ];
  for (const m of marks) crossMarks(g, m[0], m[1]);

  // 外框双线
  const pad = 7;
  g.appendChild(el('rect', {
    class: 'frame-outer',
    x: cellX(0) - pad, y: cellY(0) - pad,
    width: cellX(8) - cellX(0) + pad * 2,
    height: cellY(9) - cellY(0) + pad * 2,
    rx: 4,
  }));
  g.appendChild(el('rect', {
    class: 'frame-inner',
    x: cellX(0) - 2.5, y: cellY(0) - 2.5,
    width: cellX(8) - cellX(0) + 5,
    height: cellY(9) - cellY(0) + 5,
    rx: 2,
  }));

  // 楚河汉界
  const riverY = cellY(4) + CELL * 0.5 + 11;
  const t1 = el('text', { class: 'river-text', x: cellX(2), y: riverY, 'text-anchor': 'middle' });
  t1.textContent = '楚 河';
  const t2 = el('text', { class: 'river-text', x: cellX(6), y: riverY, 'text-anchor': 'middle' });
  t2.textContent = '汉 界';
  g.appendChild(t1);
  g.appendChild(t2);

  return svg;
}

/**
 * 纯函数：把屏幕上的点映射成格子索引（-1 = 没命中任何格子）。
 * 单独抽出来是为了能在 node:test 里回归测试缩放计算。
 * @param {number} clientX 屏幕 X
 * @param {number} clientY 屏幕 Y
 * @param {{left:number,top:number,k:number}} m 棋盘左上角与缩放比
 */
export function hitTest(clientX, clientY, m) {
  const k = (m && m.k) ? m.k : 1;
  const lx = (clientX - m.left) / k;   // 还原到未缩放的棋盘坐标
  const ly = (clientY - m.top) / k;
  const cx = Math.round((lx - MARGIN) / CELL);
  const cy = Math.round((ly - MARGIN) / CELL);
  if (cx < 0 || cx > 8 || cy < 0 || cy > 9) return -1;
  const dx = lx - cellX(cx);
  const dy = ly - cellY(cy);
  // 触屏上保证至少约 22 个 CSS 像素的容错半径
  const tol = Math.max(CELL * 0.55, 22 / k);
  if (dx * dx + dy * dy > tol * tol) return -1;
  // |0 归一化：浮点误差会让 Math.round 返回 -0（-0 === 0 为真，但规范化更干净）
  return (cy * 9 + cx) | 0;
}

/**
 * @param {HTMLElement} host  容器（#board-host）
 * @param {{onMove?: (from:number,to:number)=>void}} opts
 */
export function createBoard(host, opts) {
  const onMove = (opts && opts.onMove) || function () {};

  const fit = document.createElement('div');
  fit.className = 'board-fit';
  const scale = document.createElement('div');
  scale.className = 'board-scale';
  // 必须给显式宽高：.board-scale 的子元素全是 absolute，否则它自身尺寸为 0，
  // getBoundingClientRect().width 也就是 0，缩放比 k 会退化成 1（手机端点不中格子）。
  scale.style.width = BOARD_W + 'px';
  scale.style.height = BOARD_H + 'px';
  fit.appendChild(scale);
  host.appendChild(fit);

  scale.appendChild(buildSvg());

  const pieceLayer = document.createElement('div');
  pieceLayer.className = 'layer piece-layer';
  const dotLayer = document.createElement('div');
  dotLayer.className = 'layer dot-layer';
  const markLayer = document.createElement('div');
  markLayer.className = 'layer';
  scale.appendChild(markLayer);
  scale.appendChild(pieceLayer);
  scale.appendChild(dotLayer);

  const state = {
    view: null,
    myColor: null,
    interactive: false,
    selected: -1,
    pieces: new Map(),   // id -> element
    meta: new Map(),     // id -> { revealed, type }
    byCell: new Map(),   // index -> id
    scaleK: 1,
  };

  // ---------- 自适应缩放 ----------
  function relayout() {
    const avail = host.clientWidth || BOARD_W;
    const k = Math.max(0.32, Math.min(1, avail / BOARD_W));
    state.scaleK = k;
    scale.style.transform = 'scale(' + k + ')';
    fit.style.width = (BOARD_W * k) + 'px';
    fit.style.height = (BOARD_H * k) + 'px';
  }
  relayout();
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(relayout);
    ro.observe(host);
  } else {
    window.addEventListener('resize', relayout);
  }

  // ---------- 坐标换算 ----------
  // .board-scale 的显示宽度 = BOARD_W * k，用它反推缩放比。
  // 兜底：万一拿到的宽度为 0，就退回 .board-fit（它的宽高由 relayout 显式设置）。
  function boardMetrics() {
    const r = scale.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let w = r.width;
    if (!w) {
      const fr = fit.getBoundingClientRect();
      left = fr.left;
      top = fr.top;
      w = fr.width;
    }
    return { left: left, top: top, k: w ? w / BOARD_W : 1 };
  }

  function toScreen(index) {
    const m = boardMetrics();
    const c = centerOf(index);
    return { x: m.left + c.x * m.k, y: m.top + c.y * m.k };
  }

  function indexFromPoint(clientX, clientY) {
    return hitTest(clientX, clientY, boardMetrics());
  }

  // ---------- 棋子 ----------
  function ensurePiece(p, index) {
    let node = state.pieces.get(p.id);
    const meta = state.meta.get(p.id);
    const isNew = !node;

    if (isNew) {
      node = document.createElement('div');
      node.className = 'piece';
      const glyph = document.createElement('span');
      glyph.className = 'glyph';
      node.appendChild(glyph);
      node.style.transition = 'none';
      node.style.opacity = '0';
      pieceLayer.appendChild(node);
      state.pieces.set(p.id, node);
      requestAnimationFrame(function () {
        node.style.transition = '';
        node.style.opacity = '';
      });
    }

    const t = tf(index);
    node.style.setProperty('--tf', t);
    node.style.transform = t;

    // 明暗样式（暗子只用"楚/汉"体现颜色，不体现身份）
    const dark = !p.revealed;
    node.classList.toggle('r', p.color === 'r');
    node.classList.toggle('b', p.color === 'b');
    node.classList.toggle('dark', dark);
    const glyphEl = node.firstChild;
    const text = dark ? DARK_GLYPH[p.color] : (GLYPH[p.color][p.type] || '?');
    if (glyphEl.textContent !== text) glyphEl.textContent = text;

    // 刚翻开：做一个翻牌脉冲
    if (meta && meta.revealed === false && p.revealed === true && !isNew) {
      try {
        node.animate(
          [
            { transform: t + ' scale(.62)', filter: 'brightness(2.1)' },
            { transform: t + ' scale(1.14)', filter: 'brightness(1.35)' },
            { transform: t + ' scale(1)', filter: 'brightness(1)' },
          ],
          { duration: 430, easing: 'cubic-bezier(.2,.9,.3,1.25)' },
        );
      } catch (e) { /* 不支持 WAAPI 就静默降级 */ }
    }

    state.meta.set(p.id, { revealed: !!p.revealed, type: p.type });
    state.byCell.set(index, p.id);
    return node;
  }

  function render(view, options) {
    const o = options || {};
    state.view = view;
    state.myColor = o.myColor || null;
    state.interactive = !!o.interactive;
    if (state.selected >= 0 && !state.interactive) state.selected = -1;

    const board = view.board || [];
    state.byCell = new Map();
    const present = new Set();

    for (let i = 0; i < 90; i++) {
      const p = board[i];
      if (!p) continue;
      present.add(p.id);
      ensurePiece(p, i);
    }

    // 消失的棋子 = 被吃：碎裂后移除
    state.pieces.forEach(function (node, id) {
      if (present.has(id)) return;
      state.pieces.delete(id);
      state.meta.delete(id);
      node.classList.add('shatter');
      setTimeout(function () { node.remove(); }, 620);
    });

    // 红/绿描边（同一批"可被白吃"的棋子，按视角着色）
    const reds = new Set(view.red || []);
    const greens = new Set(view.green || []);
    state.pieces.forEach(function (node, id) {
      const cell = indexOfId(id);
      node.classList.toggle('hl-red', cell >= 0 && reds.has(cell));
      node.classList.toggle('hl-green', cell >= 0 && greens.has(cell));
    });

    renderMarks(view);
    renderDots(view);
    renderSelection();
  }

  function indexOfId(id) {
    let found = -1;
    state.byCell.forEach(function (v, k) { if (v === id) found = k; });
    return found;
  }

  function renderMarks(view) {
    markLayer.innerHTML = '';
    const lm = view.lastMove;
    if (!lm) return;
    for (const key of ['from', 'to']) {
      const i = lm[key];
      if (typeof i !== 'number' || i < 0 || i > 89) continue;
      const d = document.createElement('div');
      d.className = 'lastmark' + (key === 'to' ? ' to' : '');
      d.style.transform = tf(i);
      markLayer.appendChild(d);
    }
  }

  function renderDots(view) {
    dotLayer.innerHTML = '';
    if (state.selected < 0 || !state.interactive) return;
    const legal = (view.legal && view.legal[state.selected]) || [];
    for (const to of legal) {
      const d = document.createElement('div');
      d.className = 'dot' + (view.board[to] ? ' cap' : '');
      d.style.transform = tf(to);
      dotLayer.appendChild(d);
    }
  }

  function renderSelection() {
    state.pieces.forEach(function (node, id) {
      const cell = indexOfId(id);
      node.classList.toggle('selected', cell >= 0 && cell === state.selected);
    });
  }

  function clearSelection() {
    state.selected = -1;
    renderSelection();
    if (state.view) renderDots(state.view);
  }

  function select(i) {
    state.selected = i;
    renderSelection();
    if (state.view) renderDots(state.view);
  }

  // ---------- 交互 ----------
  function onClick(ev) {
    if (!state.interactive || !state.view || state.view.over) return;
    const i = indexFromPoint(ev.clientX, ev.clientY);
    if (i < 0) return;
    const view = state.view;
    const legal = (state.selected >= 0 && view.legal && view.legal[state.selected]) || [];

    if (state.selected >= 0 && legal.indexOf(i) >= 0) {
      const from = state.selected;
      clearSelection();
      onMove(from, i);
      return;
    }
    const p = view.board[i];
    if (p && p.color === state.myColor) {
      if (state.selected === i) clearSelection();
      else select(i);
      return;
    }
    clearSelection();
  }

  fit.addEventListener('click', onClick);

  function destroy() {
    fit.removeEventListener('click', onClick);
    if (ro) ro.disconnect();
    else window.removeEventListener('resize', relayout);
    fit.remove();
  }

  return {
    element: fit,
    render: render,
    toScreen: toScreen,
    clearSelection: clearSelection,
    relayout: relayout,
    destroy: destroy,
    get selected() { return state.selected; },
  };
}

export default createBoard;
