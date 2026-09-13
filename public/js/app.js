// public/js/app.js
// 入口与界面状态机：大厅 -> 房间 -> 棋盘。
// 联机模式完全以服务器下发的 ClientView 为准（不在前端算规则）；
// 本地双人热座 / 人机对战直接使用 /shared/engine.js 规则引擎。

import { Net } from './net.js';
import { createBoard } from './board.js';
import * as FX from './effects.js';
import { AudioFX } from './audio.js';
import { createLocalGame, localView, localMove, localResign } from './local.js';
import { chooseMove, AI_LEVELS, DEFAULT_LEVEL } from './ai.js';
import { MODE_INFO, MODES } from '../../shared/engine.js';

const $ = (id) => document.getElementById(id);

const GLYPH = {
  r: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
  b: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' },
};
const SIDE_NAME = { r: '红方', b: '黑方' };
const SEAT_CLASS = { r: 'hr', b: 'hb' };

// 静态托管（GitHub Pages 等）没有 Node 进程，联机必然失败，提前识别。
const STATIC_HOST = /\.github\.io$/i.test(location.hostname) ||
  /\.gitlab\.io$/i.test(location.hostname) ||
  location.protocol === 'file:';

const S = {
  nick: '',
  mode: 'normal',
  screen: 'lobby',
  net: null,
  netStarted: false,
  room: null,
  you: null,
  view: null,
  local: null,
  ai: null,        // { level, humanColor, thinking }
  aiGen: 0,        // 新开一局时自增，用于作废进行中的 AI 思考
  board: null,
  pending: null,
  mateShown: false,
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function toast(text, isErr) {
  const wrap = $('toast');
  if (!wrap) return;
  const d = document.createElement('div');
  d.className = 'toast' + (isErr ? ' err' : '');
  d.textContent = text;
  wrap.appendChild(d);
  setTimeout(function () { d.remove(); }, 2600);
}

function setConn(status, text) {
  const node = $('conn-status');
  if (!node) return;
  if (!text) { node.className = 'conn-status hidden'; node.textContent = ''; return; }
  node.className = 'conn-status ' + (status || '');
  node.textContent = text;
}

function showScreen(name) {
  S.screen = name;
  for (const key of ['lobby', 'room', 'game']) {
    const node = $('screen-' + key);
    if (node) node.classList.toggle('active', key === name);
  }
  if (name === 'game' && S.board) setTimeout(function () { S.board.relayout(); }, 30);
}

function myColor() {
  if (S.local) return (S.ai && S.ai.humanColor) || S.local.viewer;
  if (S.you && (S.you.seat === 'r' || S.you.seat === 'b')) return S.you.seat;
  return null;
}

function isInteractive(view) {
  if (!view || view.over) return false;
  if (S.local) {
    if (S.ai) return !S.ai.thinking && view.turn === S.ai.humanColor;
    return true; // 热座：当前行棋方操作
  }
  const c = myColor();
  return !!c && c === view.turn;
}

/**
 * 本地/人机模式的视图。
 * 热座：视角跟随当前行棋方（红绿描边随之切换）。
 * 人机：视角固定为我方，这样"红=我的子有危险 / 绿=我能白吃"始终以我为参照。
 */
function localViewForHuman() {
  if (!S.local) return null;
  S.local.viewer = S.ai ? S.ai.humanColor : S.local.state.turn;
  return localView(S.local);
}

// ---------------------------------------------------------------------------
// 模式卡片
// ---------------------------------------------------------------------------

function renderModeCards() {
  const host = $('mode-cards');
  if (!host) return;
  host.innerHTML = '';
  for (const key of MODES) {
    const info = MODE_INFO[key] || { name: key, desc: '' };
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'mode-card' + (key === S.mode ? ' active' : '');
    card.dataset.mode = key;
    const h = document.createElement('h3');
    h.textContent = info.name;
    const p = document.createElement('p');
    p.textContent = info.desc || '';
    card.appendChild(h);
    card.appendChild(p);
    card.addEventListener('click', function () {
      S.mode = key;
      AudioFX.click();
      renderModeCards();
    });
    host.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// 棋盘与视图
// ---------------------------------------------------------------------------

function initBoard() {
  S.board = createBoard($('board-host'), {
    onMove: function (from, to) {
      if (S.local) {
        if (S.ai && (S.ai.thinking || S.local.state.turn !== S.ai.humanColor)) {
          AudioFX.click();
          return;
        }
        const res = localMove(S.local, from, to);
        if (!res.ok) { toast('这一步不合法', true); AudioFX.click(); return; }
        applyView(localViewForHuman(), res.events);
        maybeAiMove();
        return;
      }
      if (!S.net || !S.net.connected) { toast('未连接服务器', true); return; }
      S.net.send({ t: 'move', from: from, to: to });
    },
  });
}

function applyView(view, events) {
  if (!view) return;
  S.view = view;
  S.board.render(view, { myColor: myColor(), interactive: isInteractive(view) });
  playEvents(events || view.events || [], view);
  updateTurn(view);
  updateHistory(view);
  updateResult(view);
}

function updateTurn(view) {
  const node = $('turn-indicator');
  if (!node) return;
  if (view.over) {
    node.textContent = '对局结束';
    node.className = 'turn-indicator over';
  } else if (S.ai && S.ai.thinking) {
    node.textContent = '电脑思考中…';
    node.className = 'turn-indicator ' + view.turn;
  } else if (S.ai) {
    node.textContent = view.turn === S.ai.humanColor ? '轮到你走棋' : '电脑行棋';
    node.className = 'turn-indicator ' + view.turn;
  } else {
    node.textContent = SIDE_NAME[view.turn] + '行棋';
    node.className = 'turn-indicator ' + view.turn;
  }
  const badge = $('check-badge');
  if (badge) badge.classList.toggle('hidden', !(view.check && view.check[view.turn] && !view.over));
}

function updateHistory(view) {
  const list = $('history-list');
  if (!list) return;
  const h = view.history || [];
  if (list.childElementCount === h.length) return;
  list.innerHTML = '';
  for (const item of h) {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'hn';
    n.textContent = item.n + '.';
    const mv = document.createElement('span');
    mv.className = SEAT_CLASS[item.color] || '';
    const g = (GLYPH[item.color] && GLYPH[item.color][item.type]) || '?';
    const fx = (item.from % 9) + ',' + ((item.from / 9) | 0);
    const tx = (item.to % 9) + ',' + ((item.to / 9) | 0);
    mv.textContent = SIDE_NAME[item.color] + ' ' + g + ' (' + fx + ')→(' + tx + ')';
    li.appendChild(n);
    li.appendChild(mv);
    if (item.captured) {
      const cap = document.createElement('span');
      cap.className = 'cap';
      const cg = (GLYPH[item.captured.color] && GLYPH[item.captured.color][item.captured.type]) || '?';
      cap.textContent = ' 吃 ' + cg;
      li.appendChild(cap);
    }
    list.appendChild(li);
  }
  list.scrollTop = list.scrollHeight;
}

function updateResult(view) {
  const bar = $('result-bar');
  const text = $('result-text');
  const btn = $('btn-rematch');
  if (!bar || !text) return;
  if (!view.over) {
    bar.classList.add('hidden');
    return;
  }
  const reasonText = {
    checkmate: '绝杀',
    stalemate: '困毙',
    kingcaptured: '擒王',
    resign: '认输',
    agreement: '和棋',
    perpetual_check: '长将判负',
    repetition: '三次重复',
  }[view.reason] || '终局';
  const winnerText = view.winner ? (SIDE_NAME[view.winner] + '胜') : '和棋';
  text.textContent = winnerText + ' · ' + reasonText;
  bar.classList.remove('hidden');
  if (btn) {
    btn.classList.toggle('hidden', !(S.local || (S.room && S.room.seats && S.room.seats.r && S.room.seats.b)));
    btn.textContent = S.local ? '再来一局' : '申请再来一局';
  }
}

function findKing(view, color) {
  for (let i = 0; i < 90; i++) {
    const p = view.board[i];
    if (p && p.color === color && p.type === 'K' && p.revealed) return i;
  }
  return -1;
}

function playEvents(events, view) {
  if (!Array.isArray(events)) return;
  for (const ev of events) {
    if (!ev || typeof ev.t !== 'string') continue;
    switch (ev.t) {
      case 'move':
        AudioFX.move();
        break;
      case 'reveal':
        AudioFX.reveal();
        break;
      case 'capture': {
        AudioFX.capture();
        try {
          const p = S.board.toScreen(ev.index);
          FX.captureBurst(p.x, p.y);
          FX.shake(S.board.element);
        } catch (e) { /* ignore */ }
        break;
      }
      case 'check': {
        AudioFX.check();
        const k = findKing(view, ev.color);
        if (k >= 0) {
          try {
            const p = S.board.toScreen(k);
            FX.checkPulse(p.x, p.y);
          } catch (e) { /* ignore */ }
        }
        break;
      }
      case 'checkmate':
      case 'stalemate':
      case 'kingcaptured':
      case 'perpetual_check':
      case 'repetition':
      case 'resign':
        showMate(ev.t, ev.winner);
        break;
      default:
        break;
    }
  }
}

function showMate(kind, winner) {
  if (S.mateShown) return;
  S.mateShown = true;

  const overlay = $('mate-overlay');
  const text = $('mate-text');
  const sub = $('mate-sub');
  const title = {
    checkmate: '绝杀!',
    stalemate: '困毙!',
    kingcaptured: '擒 王!',
    perpetual_check: '长将判负!',
    repetition: '和 棋',
    resign: '认 输',
  }[kind] || '终局';

  if (text) text.textContent = title;
  if (sub) {
    const who = winner ? (SIDE_NAME[winner] + '胜') : '';
    const mine = myColor();
    const tag = (mine && winner === mine) ? ' · 你赢了' : (mine && winner ? ' · 你输了' : '');
    sub.textContent = who + tag;
  }
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.classList.toggle('dim', kind === 'resign' || kind === 'stalemate' || kind === 'repetition');
  }

  if (kind === 'checkmate' || kind === 'kingcaptured' || kind === 'perpetual_check') {
    FX.mateBurst(kind);
    AudioFX.mate();
  } else {
    FX.mateBurst('soft');
    AudioFX.soft();
  }
  setTimeout(function () {
    if (overlay) overlay.classList.add('hidden');
    S.mateShown = false;
  }, 3800);
}

// ---------------------------------------------------------------------------
// 房间界面
// ---------------------------------------------------------------------------

function renderRoom(room, you) {
  if (!room) return;
  S.room = room;
  if (you) S.you = you;

  const modeInfo = MODE_INFO[room.mode] || { name: room.mode };
  const modeEl = $('room-mode');
  if (modeEl) modeEl.textContent = modeInfo.name;
  const gameMode = $('game-mode');
  if (gameMode) gameMode.textContent = modeInfo.name;
  const codeEl = $('room-code');
  if (codeEl) codeEl.textContent = room.code || '------';
  const gameCode = $('game-code');
  if (gameCode) gameCode.textContent = room.code || '';

  renderSeat('r', room, S.you);
  renderSeat('b', room, S.you);

  const readyBtn = $('btn-ready');
  const startBtn = $('btn-start');
  const seat = S.you && (S.you.seat === 'r' || S.you.seat === 'b') ? S.you.seat : null;
  const seatData = seat ? room.seats[seat] : null;

  if (readyBtn) {
    readyBtn.classList.toggle('hidden', !seat || room.started);
    readyBtn.textContent = seatData && seatData.ready ? '取消准备' : '准备';
  }
  if (startBtn) {
    const canStart = seat && room.host === seat && !room.started && room.seats.r && room.seats.b;
    startBtn.classList.toggle('hidden', !canStart);
  }

  const status = $('room-status');
  if (status) {
    if (room.over) status.textContent = '本局已结束，可点击"再来一局"。';
    else if (room.started) status.textContent = '';
    else if (!room.seats.r || !room.seats.b) status.textContent = '等待对手加入…把房间号发给好友即可。';
    else if (room.seats.r.ready && room.seats.b.ready) status.textContent = '双方已准备，即将开始…';
    else status.textContent = '双方都点击"准备"后自动开局。';
  }
  const spec = $('room-spectators');
  if (spec) spec.textContent = room.spectators ? ('观战 ' + room.spectators + ' 人') : '';

  if (room.started && S.screen !== 'game') showScreen('game');
}

function renderSeat(key, room, you) {
  const node = $('seat-' + key);
  if (!node) return;
  const seat = room.seats[key];
  node.innerHTML = '';

  const side = document.createElement('div');
  side.className = 'seat-side';
  side.textContent = SIDE_NAME[key];
  node.appendChild(side);

  const name = document.createElement('div');
  name.className = 'seat-name';
  name.textContent = seat ? seat.name : '虚位以待';
  node.appendChild(name);

  const tags = document.createElement('div');
  tags.className = 'seat-tags';
  if (you && you.seat === key) {
    const p = document.createElement('span');
    p.className = 'pill you';
    p.textContent = '你';
    tags.appendChild(p);
  }
  if (room.host === key) {
    const p = document.createElement('span');
    p.className = 'pill host';
    p.textContent = '房主';
    tags.appendChild(p);
  }
  if (seat) {
    const p = document.createElement('span');
    p.className = 'pill' + (seat.ready ? ' ready' : '');
    p.textContent = seat.ready ? '已准备' : '未准备';
    tags.appendChild(p);
    if (!seat.connected) {
      const q = document.createElement('span');
      q.className = 'pill off';
      q.textContent = '掉线';
      tags.appendChild(q);
    }
  } else {
    const p = document.createElement('span');
    p.className = 'pill empty';
    p.textContent = '空';
    tags.appendChild(p);
  }
  node.appendChild(tags);
}

function appendChat(list, name, text) {
  if (!list) return;
  const d = document.createElement('div');
  d.className = 'cm';
  const b = document.createElement('b');
  b.textContent = (name || '玩家') + '：';
  d.appendChild(b);
  d.appendChild(document.createTextNode(text));
  list.appendChild(d);
  list.scrollTop = list.scrollHeight;
  while (list.childElementCount > 200) list.removeChild(list.firstChild);
}

function chatLists() {
  return Array.prototype.slice.call(document.querySelectorAll('.chat-list'));
}

// ---------------------------------------------------------------------------
// 联机（按需连接：只有点了"创建/加入"才连服务器）
// ---------------------------------------------------------------------------

function ensureNet() {
  if (S.net) return S.net;
  S.net = new Net({
    onStatus: function (status, text) {
      setConn(status, text);
      if (status === 'ok') setTimeout(function () { if (S.net && S.net.connected) setConn('', ''); }, 1600);
    },
    onReconnect: function () {
      if (S.pending) {
        const p = S.pending;
        S.pending = null;
        S.net.send(p);
      } else if (S.room && S.room.code && S.nick) {
        S.net.send({ t: 'join', code: S.room.code, name: S.nick });
      }
    },
    onMessage: function (msg) {
      switch (msg.t) {
        case 'hello':
          break;
        case 'room':
          renderRoom(msg.room, msg.you);
          if (msg.room && msg.room.code) {
            try {
              const url = new URL(location.href);
              url.searchParams.set('room', msg.room.code);
              history.replaceState(null, '', url.toString());
            } catch (e) { /* ignore */ }
          }
          break;
        case 'state':
          if (S.screen !== 'game') showScreen('game');
          applyView(msg.view, msg.events);
          break;
        case 'chat':
          for (const list of chatLists()) appendChat(list, msg.name, msg.text);
          break;
        case 'error':
          toast(errorText(msg.code, msg.message), true);
          break;
        default:
          break;
      }
    },
  });
  return S.net;
}

function errorText(code, message) {
  const map = {
    no_room: '房间不存在',
    room_full: '房间已满',
    illegal_move: '不合法的着法',
    not_your_turn: '还没轮到你',
    not_started: '对局尚未开始',
    already_started: '对局已开始',
    game_over: '对局已结束',
    not_seated: '你不在座位上',
    bad_mode: '模式无效',
    rate_limit: '操作太快了',
  };
  return map[code] || message || '操作失败';
}

function send(obj) {
  if (STATIC_HOST) {
    toast('静态托管没有服务器，请用「人机对战」或「本地双人」', true);
    return false;
  }
  const net = ensureNet();
  if (net.connected) return net.send(obj);
  S.pending = obj;
  if (!S.netStarted) {
    S.netStarted = true;
    net.connect();
  }
  toast('正在连接服务器…', false);
  return false;
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function bind() {
  const nick = $('nickname');
  if (nick) {
    nick.value = S.nick;
    nick.addEventListener('input', function () {
      S.nick = nick.value.trim().slice(0, 16);
      try { localStorage.setItem('xq.nick', S.nick); } catch (e) { /* ignore */ }
    });
  }

  const create = $('btn-create');
  if (create) create.addEventListener('click', function () {
    AudioFX.unlock();
    send({ t: 'create', mode: S.mode, name: S.nick || '玩家' });
  });

  const join = $('btn-join');
  const codeInput = $('join-code');
  const doJoin = function () {
    AudioFX.unlock();
    const code = ((codeInput && codeInput.value) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) { toast('请输入 6 位房间号', true); return; }
    send({ t: 'join', code: code, name: S.nick || '玩家' });
  };
  if (join) join.addEventListener('click', doJoin);
  if (codeInput) codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });

  const aiBtn = $('btn-ai');
  if (aiBtn) aiBtn.addEventListener('click', function () { startLocal(true); });

  const local = $('btn-local');
  if (local) local.addEventListener('click', function () { startLocal(false); });

  const rules = $('btn-rules');
  const modal = $('rules-modal');
  if (rules && modal) rules.addEventListener('click', function () { modal.classList.remove('hidden'); });
  const closeRules = $('btn-close-rules');
  if (closeRules && modal) closeRules.addEventListener('click', function () { modal.classList.add('hidden'); });
  if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) modal.classList.add('hidden'); });

  const leaveRoom = $('btn-leave-room');
  if (leaveRoom) leaveRoom.addEventListener('click', leaveToLobby);
  const leaveGame = $('btn-leave');
  if (leaveGame) leaveGame.addEventListener('click', leaveToLobby);
  const backRoom = $('btn-back-room');
  if (backRoom) backRoom.addEventListener('click', function () { showScreen('room'); });

  const ready = $('btn-ready');
  if (ready) ready.addEventListener('click', function () { AudioFX.unlock(); send({ t: 'ready' }); });
  const start = $('btn-start');
  if (start) start.addEventListener('click', function () { send({ t: 'start' }); });

  const resign = $('btn-resign');
  if (resign) resign.addEventListener('click', function () {
    if (S.local) {
      const c = myColor() || S.local.state.turn;
      localResign(S.local, c);
      applyView(localViewForHuman(), S.local.events);
      return;
    }
    if (!S.view || S.view.over) return;
    if (window.confirm('确定认输吗？')) send({ t: 'resign' });
  });

  const rematch = $('btn-rematch');
  if (rematch) rematch.addEventListener('click', function () {
    if (S.local) { startLocal(!!S.ai); return; }
    send({ t: 'rematch' });
    toast('已申请再来一局，等待对方同意');
  });

  const copy = $('btn-copy-code');
  if (copy) copy.addEventListener('click', function () {
    const code = S.room && S.room.code;
    if (!code) return;
    const done = function () { toast('房间号已复制：' + code); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done, function () { toast('复制失败，请手动复制', true); });
    } else {
      toast('房间号：' + code);
    }
  });

  document.querySelectorAll('form[data-chat]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const input = form.querySelector('.chat-input');
      const text = input ? input.value.trim().slice(0, 200) : '';
      if (!text) return;
      if (S.local) {
        for (const list of chatLists()) appendChat(list, S.nick || '我', text);
      } else {
        send({ t: 'chat', text: text });
      }
      if (input) input.value = '';
    });
  });

  document.addEventListener('click', function once() {
    AudioFX.unlock();
    document.removeEventListener('click', once);
  }, { once: true });

  window.addEventListener('beforeunload', function () {
    if (S.net) S.net.close();
  });
}

// ---------------------------------------------------------------------------
// 本地双人 / 人机对战
// ---------------------------------------------------------------------------

async function startLocal(vsAI) {
  AudioFX.unlock();
  S.aiGen += 1;
  try {
    const ctx = await createLocalGame(S.mode);
    S.local = ctx;
    S.ai = vsAI ? {
      level: ($('ai-level') && $('ai-level').value) || DEFAULT_LEVEL,
      humanColor: ($('ai-side') && $('ai-side').value) === 'b' ? 'b' : 'r',
      thinking: false,
    } : null;
    S.mateShown = false;
    showScreen('game');
    const modeEl = $('game-mode');
    if (modeEl) modeEl.textContent = (MODE_INFO[S.mode] && MODE_INFO[S.mode].name) || S.mode;
    const codeEl = $('game-code');
    if (codeEl) codeEl.textContent = S.ai ? '人机' : '本地';
    const list = $('history-list');
    if (list) list.innerHTML = '';
    applyView(localViewForHuman(), []);
    maybeAiMove();
  } catch (err) {
    toast('本地模式启动失败：' + (err && err.message ? err.message : err), true);
  }
}

/** 轮到电脑时让它走一步（用 setTimeout 让"思考中"先渲染出来） */
function maybeAiMove() {
  if (!S.ai || !S.local) return;
  const ai = S.ai;
  const gen = S.aiGen;
  if (S.local.state.over) return;
  if (S.local.state.turn === ai.humanColor) return;
  if (ai.thinking) return;

  ai.thinking = true;
  updateTurn(S.view);

  setTimeout(function () {
    if (gen !== S.aiGen || S.ai !== ai || !S.local) return;

    const level = AI_LEVELS[ai.level] || AI_LEVELS[DEFAULT_LEVEL];
    let mv = null;
    try {
      mv = chooseMove(S.local.state, { depth: level.depth, timeMs: level.timeMs });
    } catch (e) {
      mv = null;
    }
    if (gen !== S.aiGen || S.ai !== ai || !S.local) return;

    ai.thinking = false;
    if (!mv) {
      applyView(localViewForHuman(), []);
      return;
    }
    const res = localMove(S.local, mv.from, mv.to);
    if (!res.ok) {
      applyView(localViewForHuman(), []);
      return;
    }
    applyView(localViewForHuman(), res.events);
  }, 80);
}

function leaveToLobby() {
  S.aiGen += 1;
  S.ai = null;
  if (S.local) {
    S.local = null;
  } else if (S.net && S.net.connected) {
    S.net.send({ t: 'leave' });
  }
  S.room = null;
  S.you = null;
  S.view = null;
  S.mateShown = false;
  const bar = $('result-bar');
  if (bar) bar.classList.add('hidden');
  const badge = $('check-badge');
  if (badge) badge.classList.add('hidden');
  const list = $('history-list');
  if (list) list.innerHTML = '';
  try {
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url.toString());
  } catch (e) { /* ignore */ }
  showScreen('lobby');
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function boot() {
  try { S.nick = localStorage.getItem('xq.nick') || ''; } catch (e) { S.nick = ''; }

  renderModeCards();
  initBoard();
  bind();
  FX.initEffects();

  if (STATIC_HOST) {
    const hint = $('static-hint');
    if (hint) {
      hint.classList.remove('hidden');
      hint.textContent = '当前是静态托管，没有联机服务器：请使用「人机对战」或「本地双人」。' +
        '要联机请把项目部署到能运行 Node 的主机（见 docs/DEPLOY.md）。';
    }
  }

  const params = new URLSearchParams(location.search);
  const roomCode = params.get('room');
  if (roomCode && $('join-code')) {
    $('join-code').value = roomCode.toUpperCase().slice(0, 6);
    if (S.nick && !STATIC_HOST) {
      setTimeout(function () {
        send({ t: 'join', code: $('join-code').value, name: S.nick });
      }, 260);
    }
  }

  showScreen('lobby');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
