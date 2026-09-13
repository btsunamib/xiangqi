// 特效系统：全屏 Canvas 粒子 + DOM 命中闪光 + 棋盘震动 + 终局遮罩
let canvas = null;
let ctx = null;
let dpr = 1;
let running = false;
let lastT = 0;
let particles = [];
let rings = [];

const PALETTE = ['#ffffff', '#ffe9a8', '#ffc94d', '#ff8a3d', '#ff5a3d', '#ffd464'];

function ensureCanvas() {
  if (ctx) return true;
  canvas = document.getElementById('fx-layer');
  if (!canvas) return false;
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
  return true;
}

function resize() {
  if (!canvas) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function loop(now) {
  if (!ctx) { running = false; return; }
  const dt = Math.min(48, now - lastT);
  lastT = now;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    const s = dt / 16.6667;
    p.vy += p.g * s;
    p.vx *= Math.pow(p.drag, s);
    p.vy *= Math.pow(p.drag, s);
    p.x += p.vx * s;
    p.y += p.vy * s;
    const a = Math.max(0, p.life / p.max);
    ctx.globalAlpha = p.fade ? a : 1;
    ctx.fillStyle = p.color;
    if (p.shape === 'rect') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rot || 0) + now * 0.004 * (p.spin || 0));
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.4, p.size * (p.shrink ? a : 1)), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.life -= dt;
    if (r.life <= 0) { rings.splice(i, 1); continue; }
    const t = 1 - r.life / r.max;
    const rad = r.from + (r.to - r.from) * (1 - Math.pow(1 - t, 2.2));
    ctx.globalAlpha = Math.max(0, 1 - t) * (r.alpha || 1);
    ctx.strokeStyle = r.color;
    ctx.lineWidth = Math.max(1, r.width * (1 - t));
    ctx.beginPath();
    ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  if (particles.length || rings.length) {
    requestAnimationFrame(loop);
  } else {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    running = false;
  }
}

function kick() {
  if (!ensureCanvas()) return;
  if (!running) {
    running = true;
    lastT = performance.now();
    requestAnimationFrame(loop);
  }
}

export function initEffects() {
  kick();
}

/** 命中闪光（DOM，不依赖 canvas） */
export function hitFlash(x, y, size) {
  const d = document.createElement('div');
  d.className = 'hit-flash';
  const s = size || 70;
  d.style.left = x + 'px';
  d.style.top = y + 'px';
  d.style.width = s + 'px';
  d.style.height = s + 'px';
  d.style.margin = (-s / 2) + 'px 0 0 ' + (-s / 2) + 'px';
  document.body.appendChild(d);
  setTimeout(function () { d.remove(); }, 460);
}

/** 吃子：闪光 + 粒子爆散 */
export function captureBurst(x, y, opts) {
  const o = opts || {};
  hitFlash(x, y, 78);
  const n = o.count || 30;
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = 2.2 + Math.random() * 7.4;
    particles.push({
      x: x, y: y,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd - 2.2,
      g: 0.34,
      drag: 0.965,
      life: 480 + Math.random() * 560,
      max: 1040,
      size: 2 + Math.random() * 5.4,
      color: (o.colors && o.colors[(Math.random() * o.colors.length) | 0]) || PALETTE[(Math.random() * PALETTE.length) | 0],
      shape: Math.random() < 0.34 ? 'rect' : 'circle',
      rot: Math.random() * Math.PI,
      spin: Math.random() * 2 - 1,
      fade: true,
      shrink: true,
    });
  }
  rings.push({ x: x, y: y, from: 8, to: 96, life: 420, max: 420, color: 'rgba(255,225,150,0.9)', width: 4, alpha: 0.85 });
  kick();
}

/** 将军：克制的红色脉冲环 */
export function checkPulse(x, y) {
  rings.push({ x: x, y: y, from: 10, to: 130, life: 640, max: 640, color: 'rgba(255,80,60,0.95)', width: 5, alpha: 0.95 });
  rings.push({ x: x, y: y, from: 10, to: 190, life: 820, max: 820, color: 'rgba(255,150,90,0.55)', width: 3, alpha: 0.7 });
  kick();
}

/** 走子小火花 */
export function moveSpark(x, y) {
  for (let i = 0; i < 8; i++) {
    const ang = Math.random() * Math.PI * 2;
    particles.push({
      x: x, y: y,
      vx: Math.cos(ang) * (0.6 + Math.random() * 2),
      vy: Math.sin(ang) * (0.6 + Math.random() * 2) - 0.8,
      g: 0.12, drag: 0.94,
      life: 260 + Math.random() * 220, max: 480,
      size: 1.4 + Math.random() * 2.4,
      color: '#ffe9a8', shape: 'circle', fade: true, shrink: true,
    });
  }
  kick();
}

/** 终局：粒子雨 + 冲击波环 */
export function mateBurst(kind) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const warm = kind === 'kingcaptured' || kind === 'checkmate';
  const colors = warm
    ? ['#ffd464', '#ff8a3d', '#ff5a3d', '#fff3d0', '#ffb347']
    : ['#9ecbff', '#d6e6ff', '#ffffff', '#8fa8d8'];

  for (let i = 0; i < 160; i++) {
    particles.push({
      x: Math.random() * w,
      y: -20 - Math.random() * h * 0.6,
      vx: (Math.random() - 0.5) * 2.4,
      vy: 2.4 + Math.random() * 5.2,
      g: 0.06, drag: 0.999,
      life: 1600 + Math.random() * 1900, max: 3500,
      size: 2.4 + Math.random() * 6,
      color: colors[(Math.random() * colors.length) | 0],
      shape: Math.random() < 0.4 ? 'rect' : 'circle',
      rot: Math.random() * Math.PI, spin: Math.random() * 2 - 1,
      fade: true, shrink: false,
    });
  }
  const cx = w / 2;
  const cy = h / 2;
  for (let i = 0; i < 3; i++) {
    rings.push({
      x: cx, y: cy, from: 30, to: Math.max(w, h) * 0.85,
      life: 1100 + i * 240, max: 1100 + i * 240,
      color: i === 0 ? 'rgba(255,230,170,0.95)' : (i === 1 ? 'rgba(255,120,80,0.7)' : 'rgba(255,255,255,0.5)'),
      width: 7 - i * 2, alpha: 1,
    });
  }
  kick();
}

/** 棋盘 / 容器轻微震动 */
export function shake(el) {
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  setTimeout(function () { el.classList.remove('shake'); }, 400);
}

export function clearFx() {
  particles = [];
  rings = [];
  if (ctx) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

export default { initEffects: initEffects, captureBurst: captureBurst, checkPulse: checkPulse, mateBurst: mateBurst, shake: shake, hitFlash: hitFlash, moveSpark: moveSpark, clearFx: clearFx };
