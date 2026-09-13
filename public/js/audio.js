// 纯 WebAudio 合成音效（无音频文件、无外部依赖）
let ac = null;
let master = null;
let noiseBuf = null;
let muted = false;

function ensure() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ac) {
    try {
      ac = new AC();
      master = ac.createGain();
      master.gain.value = 0.5;
      master.connect(ac.destination);
    } catch (e) {
      ac = null;
      return null;
    }
  }
  if (ac.state === 'suspended') { try { ac.resume(); } catch (e) { /* ignore */ } }
  return ac;
}

function noise(seconds) {
  const c = ensure();
  if (!c) return null;
  if (!noiseBuf) {
    const len = Math.floor(c.sampleRate * 0.6);
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const g = c.createGain();
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 1800;
  f.Q.value = 0.8;
  src.connect(f).connect(g);
  return { src, g, dur: seconds || 0.2 };
}

function tone(opts) {
  const c = ensure();
  if (!c) return;
  const o = opts || {};
  const freq = o.freq || 440;
  const type = o.type || 'sine';
  const dur = o.dur || 0.2;
  const gain = o.gain || 0.2;
  const t0 = c.currentTime + (o.delay || 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.slideTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.02, dur * 0.2));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function noiseHit(seconds, gain, delay) {
  const n = noise(seconds);
  if (!n || !ac) return;
  const t0 = ac.currentTime + (delay || 0);
  n.g.gain.setValueAtTime(0.0001, t0);
  n.g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
  n.g.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
  try { n.src.start(t0); n.src.stop(t0 + seconds + 0.02); } catch (e) { /* ignore */ }
}

function guard(fn) {
  return function () {
    if (muted) return;
    try { fn.apply(null, arguments); } catch (e) { /* 音频失败不影响游戏 */ }
  };
}

export const AudioFX = {
  unlock() { ensure(); },
  setMuted(v) { muted = !!v; },
  isMuted() { return muted; },
  toggle() { muted = !muted; return muted; },

  // 落子：清脆木质敲击
  move: guard(function () {
    tone({ freq: 520, type: 'triangle', dur: 0.09, gain: 0.22, slideTo: 180 });
    noiseHit(0.05, 0.09);
  }),

  // 吃子：爆响 + 低频冲击
  capture: guard(function () {
    noiseHit(0.18, 0.32);
    tone({ freq: 180, type: 'square', dur: 0.16, gain: 0.2, slideTo: 60 });
    tone({ freq: 900, type: 'triangle', dur: 0.07, gain: 0.16, slideTo: 300 });
  }),

  // 暗子翻开
  reveal: guard(function () {
    tone({ freq: 380, type: 'sine', dur: 0.14, gain: 0.16, slideTo: 760 });
    noiseHit(0.08, 0.07);
  }),

  // 将军：双音警示
  check: guard(function () {
    tone({ freq: 880, type: 'triangle', dur: 0.16, gain: 0.24 });
    tone({ freq: 660, type: 'triangle', dur: 0.22, gain: 0.22, delay: 0.14 });
    tone({ freq: 1180, type: 'sine', dur: 0.12, gain: 0.12, delay: 0.28 });
  }),

  // 绝杀：低音轰鸣 + 长尾
  mate: guard(function () {
    tone({ freq: 110, type: 'sawtooth', dur: 1.5, gain: 0.3, slideTo: 45 });
    tone({ freq: 165, type: 'sawtooth', dur: 1.3, gain: 0.18, slideTo: 62, delay: 0.05 });
    tone({ freq: 330, type: 'sine', dur: 1.1, gain: 0.12, slideTo: 120, delay: 0.1 });
    noiseHit(0.9, 0.2, 0);
    noiseHit(0.5, 0.14, 0.05);
  }),

  // 困毙 / 认输：温和下行
  soft: guard(function () {
    tone({ freq: 440, type: 'sine', dur: 0.3, gain: 0.16, slideTo: 220 });
    tone({ freq: 330, type: 'sine', dur: 0.4, gain: 0.12, slideTo: 165, delay: 0.16 });
  }),

  click: guard(function () {
    tone({ freq: 700, type: 'sine', dur: 0.05, gain: 0.12 });
  }),
};

export default AudioFX;
