// server/rooms.js
// 房间管理 + 对局会话。服务器是唯一权威：
//  - 所有走子都经 engine.makeMove 校验；非法走子不改变状态
//  - 下发给客户端的一律是 viewFor(state, seat) / viewFor(state, null)，绝不泄露暗子身份
import { createGame, makeMove, viewFor, resign, MODE_INFO } from '../shared/engine.js';
import {
  C2S,
  S2C,
  ERR,
  CHAT_MAX_LEN,
  NAME_MAX_LEN,
  ROOM_CODE_LEN,
  ROOM_CODE_ALPHABET,
  sanitizeText,
  isPlainObject,
} from '../shared/protocol.js';

export const RECONNECT_GRACE_MS = 60 * 1000;
export const SEATS = ['r', 'b'];

function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

function randomRoomCode(rooms) {
  for (let attempt = 0; attempt < 5000; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('room code space exhausted');
}

function normalizeRoomCode(value) {
  const raw = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== ROOM_CODE_LEN) return null;
  for (const ch of raw) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  }
  return raw;
}

function isValidMode(mode) {
  return typeof mode === 'string' && Object.prototype.hasOwnProperty.call(MODE_INFO, mode);
}

class Room {
  constructor(code, mode, seed) {
    this.code = code;
    this.mode = mode;
    this.seed = seed;
    this.state = createGame(mode, seed);
    this.started = false;
    this.over = false;
    this.host = null; // 'r' | 'b' | null
    this.seats = { r: null, b: null }; // { session, name, ready, connected }
    this.spectators = new Set();
    this.graceTimers = { r: null, b: null };
    this.rematchVotes = new Set();
    this.createdAt = Date.now();
  }
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  get roomCount() {
    return this.rooms.size;
  }

  // ---------- 生命周期 ----------

  handleClose(session) {
    try {
      this._leaveRoom(session, { explicit: false });
    } catch {
      /* 任何异常都不能让进程退出 */
    }
  }

  handleMessage(session, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      this._err(session, ERR.BAD_MESSAGE, 'invalid JSON');
      return;
    }
    if (!isPlainObject(msg) || typeof msg.t !== 'string') {
      this._err(session, ERR.BAD_MESSAGE, 'invalid message');
      return;
    }
    try {
      switch (msg.t) {
        case C2S.CREATE:
          return this.onCreate(session, msg);
        case C2S.JOIN:
          return this.onJoin(session, msg);
        case C2S.MOVE:
          return this.onMove(session, msg);
        case C2S.READY:
          return this.onReady(session, msg);
        case C2S.START:
          return this.onStart(session, msg);
        case C2S.RESIGN:
          return this.onResign(session, msg);
        case C2S.REMATCH:
          return this.onRematch(session, msg);
        case C2S.CHAT:
          return this.onChat(session, msg);
        case C2S.LEAVE:
          return this.onLeave(session, msg);
        case C2S.PING:
          return this._send(session, {
            t: S2C.PONG,
            ts: Number.isFinite(msg.ts) ? msg.ts : Date.now(),
          });
        default:
          return this._err(session, ERR.BAD_MESSAGE, 'unknown message type');
      }
    } catch {
      // 兜底：任何消息处理异常都只回错误，不影响进程与其他房间
      this._err(session, ERR.BAD_MESSAGE, 'internal error');
    }
  }

  // ---------- 客户端消息 ----------

  onCreate(session, msg) {
    if (!isValidMode(msg.mode)) {
      this._err(session, ERR.BAD_MODE, 'unknown mode');
      return;
    }
    const mode = msg.mode;
    const name = sanitizeText(msg.name, NAME_MAX_LEN) || '玩家';
    const color = msg.color === 'b' ? 'b' : 'r';

    this._leaveRoom(session, { explicit: false, silent: true });

    const code = randomRoomCode(this.rooms);
    const room = new Room(code, mode, randomSeed());
    this.rooms.set(code, room);

    session.name = name;
    this._takeSeat(room, color, session, name, { ready: false, makeHost: true });
    session.room = room;
    session.seat = color;

    this._sendRoom(room, session);
    this._sendState(room, session, color, []);
  }

  onJoin(session, msg) {
    const code = normalizeRoomCode(msg.code);
    const room = code ? this.rooms.get(code) : null;
    if (!room) {
      this._err(session, ERR.NO_ROOM, 'room not found');
      return;
    }
    const name = sanitizeText(msg.name, NAME_MAX_LEN) || '玩家';

    if (session.room === room && SEATS.includes(session.seat)) {
      // 同连接重复 join：只重发当前快照
      this._sendRoom(room, session);
      this._sendState(room, session, session.seat, []);
      return;
    }

    this._leaveRoom(session, { explicit: false, silent: true });
    session.name = name;

    // 1) 同名 + 未连接 => 复座（断线重连）
    for (const key of SEATS) {
      const seat = room.seats[key];
      if (seat && !seat.connected && seat.name === name) {
        this._clearGrace(room, key);
        seat.session = session;
        seat.connected = true;
        session.room = room;
        session.seat = key;
        this._sendRoom(room, session);
        this._sendState(room, session, key, []);
        this._broadcastRoom(room);
        return;
      }
    }

    // 2) 空座位优先（对局进行中不允许中途入座）
    const canTakeSeat = !(room.started && !room.over);
    let target = null;
    if (canTakeSeat) {
      for (const key of SEATS) {
        if (!room.seats[key]) {
          target = key;
          break;
        }
      }
      if (!target) {
        for (const key of SEATS) {
          const seat = room.seats[key];
          if (seat && !seat.connected) {
            target = key;
            break;
          }
        }
      }
    }

    if (target) {
      this._takeSeat(room, target, session, name, { ready: false, makeHost: true });
      session.room = room;
      session.seat = target;
      this._sendRoom(room, session);
      this._sendState(room, session, target, []);
      this._broadcastRoom(room);
      return;
    }

    // 3) 旁观者
    room.spectators.add(session);
    session.room = room;
    session.seat = 'spectator';
    this._sendRoom(room, session);
    if (room.started || room.over) this._sendState(room, session, 'spectator', []);
  }

  onReady(session, msg) {
    const room = session.room;
    if (!room || !SEATS.includes(session.seat)) {
      this._err(session, ERR.NOT_SEATED, 'not seated');
      return;
    }
    if (room.over) {
      this._err(session, ERR.GAME_OVER, 'game over');
      return;
    }
    if (room.started) {
      this._err(session, ERR.ALREADY_STARTED, 'already started');
      return;
    }
    const seat = room.seats[session.seat];
    if (!seat) {
      this._err(session, ERR.NOT_SEATED, 'not seated');
      return;
    }
    seat.ready = !seat.ready;
    this._broadcastRoom(room);
    this._maybeAutoStart(room);
  }

  onStart(session, msg) {
    const room = session.room;
    if (!room || !SEATS.includes(session.seat)) {
      this._err(session, ERR.NOT_SEATED, 'not seated');
      return;
    }
    if (room.over) {
      this._err(session, ERR.GAME_OVER, 'game over');
      return;
    }
    if (room.started) {
      this._err(session, ERR.ALREADY_STARTED, 'already started');
      return;
    }
    if (!room.seats.r || !room.seats.b) {
      this._err(session, ERR.NOT_SEATED, 'waiting for opponent');
      return;
    }
    this._start(room);
  }

  onMove(session, msg) {
    const room = session.room;
    if (!room || !SEATS.includes(session.seat)) {
      this._err(session, ERR.NOT_SEATED, 'not seated');
      return;
    }
    if (!room.started) {
      this._err(session, ERR.NOT_STARTED, 'game not started');
      return;
    }
    if (room.over) {
      this._err(session, ERR.GAME_OVER, 'game over');
      return;
    }
    if (room.state.turn !== session.seat) {
      this._err(session, ERR.NOT_YOUR_TURN, 'not your turn');
      return;
    }
    const from = msg.from;
    const to = msg.to;
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      this._err(session, ERR.BAD_MESSAGE, 'bad coordinates');
      return;
    }

    let result;
    try {
      result = makeMove(room.state, from, to);
    } catch {
      this._err(session, ERR.ILLEGAL_MOVE, 'illegal move');
      return;
    }
    if (!result || !result.ok) {
      this._err(session, ERR.ILLEGAL_MOVE, (result && result.error) || 'illegal move');
      return;
    }

    room.state = result.state;
    if (room.state.over) room.over = true;

    this._broadcastState(room, Array.isArray(result.events) ? result.events : []);
    this._broadcastRoom(room);
  }

  onResign(session, msg) {
    const room = session.room;
    if (!room || !SEATS.includes(session.seat)) {
      this._err(session, ERR.NOT_SEATED, 'not seated');
      return;
    }
    if (!room.started) {
      this._err(session, ERR.NOT_STARTED, 'game not started');
      return;
    }
    if (room.over) {
      this._err(session, ERR.GAME_OVER, 'game over');
      return;
    }
    this._endByResign(room, session.seat);
  }

  onRematch(session, msg) {
    const room = session.room;
    if (!room || !SEATS.includes(session.seat)) {
      this._err(session, ERR.NOT_SEATED, 'not seated');
      return;
    }
    if (!room.over) {
      this._err(session, ERR.NOT_STARTED, 'game is not over');
      return;
    }
    if (!room.seats.r || !room.seats.b) {
      this._err(session, ERR.NOT_SEATED, 'waiting for opponent');
      return;
    }

    room.rematchVotes.add(session.seat);
    if (room.rematchVotes.has('r') && room.rematchVotes.has('b')) {
      room.seed = randomSeed();
      room.state = createGame(room.mode, room.seed);
      room.started = true;
      room.over = false;
      room.rematchVotes.clear();
      for (const key of SEATS) {
        if (room.seats[key]) room.seats[key].ready = true;
      }
      this._broadcastRoom(room);
      this._broadcastState(room, []);
    } else {
      this._broadcastRoom(room);
    }
  }

  onChat(session, msg) {
    const room = session.room;
    if (!room) {
      this._err(session, ERR.NO_ROOM, 'not in a room');
      return;
    }
    const text = sanitizeText(msg.text, CHAT_MAX_LEN);
    if (!text) return;
    const seat = SEATS.includes(session.seat) ? session.seat : 'spectator';
    const name = session.name || '玩家';
    const ts = Date.now();
    for (const member of this._members(room)) {
      this._send(member, { t: S2C.CHAT, seat, name, text, ts });
    }
  }

  onLeave(session, msg) {
    this._leaveRoom(session, { explicit: true });
  }

  // ---------- 内部：座位 / 房间 ----------

  _takeSeat(room, key, session, name, opts = {}) {
    this._clearGrace(room, key);
    room.seats[key] = {
      session,
      name,
      ready: opts.ready === true,
      connected: true,
    };
    if (opts.makeHost && !room.host) room.host = key;
  }

  _start(room) {
    room.started = true;
    room.over = false;
    this._broadcastRoom(room);
    this._broadcastState(room, []);
  }

  _maybeAutoStart(room) {
    if (room.started || room.over) return;
    const r = room.seats.r;
    const b = room.seats.b;
    if (r && b && r.ready && b.ready && r.connected && b.connected) {
      this._start(room);
    }
  }

  _endByResign(room, color) {
    let next;
    try {
      next = resign(room.state, color);
    } catch {
      next = room.state;
    }
    room.state = next;
    room.over = true;
    room.rematchVotes.clear();
    this._broadcastState(room, []);
    this._broadcastRoom(room);
  }

  _leaveRoom(session, opts = {}) {
    const explicit = opts.explicit === true;
    const room = session.room;
    session.room = null;
    session.seat = null;
    if (!room) return;

    if (room.spectators.delete(session)) {
      if (!opts.silent) this._broadcastRoom(room);
      this._maybeDelete(room);
      return;
    }

    let key = null;
    for (const candidate of SEATS) {
      const seat = room.seats[candidate];
      if (seat && seat.session === session) {
        key = candidate;
        break;
      }
    }
    if (!key) {
      this._maybeDelete(room);
      return;
    }

    if (explicit) {
      this._clearGrace(room, key);
      if (room.started && !room.over) {
        this._endByResign(room, key);
      }
      room.seats[key] = null;
      if (room.host === key) room.host = SEATS.find((k) => room.seats[k]) || null;
      this._broadcastRoom(room);
      this._maybeDelete(room);
      return;
    }

    // 掉线：保留座位 60s 等待同 code + 同名复座
    const seat = room.seats[key];
    seat.connected = false;
    seat.session = null;
    this._startGrace(room, key);
    if (!opts.silent) this._broadcastRoom(room);
  }

  _startGrace(room, key) {
    this._clearGrace(room, key);
    const timer = setTimeout(() => {
      room.graceTimers[key] = null;
      try {
        const seat = room.seats[key];
        if (!seat || seat.connected) return;
        if (room.started && !room.over) {
          this._endByResign(room, key);
        }
        room.seats[key] = null;
        if (room.host === key) room.host = SEATS.find((k) => room.seats[k]) || null;
        this._broadcastRoom(room);
        this._maybeDelete(room);
      } catch {
        /* ignore */
      }
    }, RECONNECT_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    room.graceTimers[key] = timer;
  }

  _clearGrace(room, key) {
    const timer = room.graceTimers[key];
    if (timer) {
      clearTimeout(timer);
      room.graceTimers[key] = null;
    }
  }

  _maybeDelete(room) {
    const empty =
      !room.seats.r && !room.seats.b && room.spectators.size === 0;
    if (!empty) return;
    this._clearGrace(room, 'r');
    this._clearGrace(room, 'b');
    this.rooms.delete(room.code);
  }

  // ---------- 内部：下发 ----------

  _members(room) {
    const list = [];
    for (const key of SEATS) {
      const seat = room.seats[key];
      if (seat && seat.session) list.push(seat.session);
    }
    for (const spectator of room.spectators) list.push(spectator);
    return list;
  }

  _roomInfo(room) {
    const seatInfo = (seat) =>
      seat
        ? { name: seat.name, ready: !!seat.ready, connected: !!seat.connected }
        : null;
    return {
      code: room.code,
      mode: room.mode,
      started: !!room.started,
      over: !!room.over,
      seats: { r: seatInfo(room.seats.r), b: seatInfo(room.seats.b) },
      spectators: room.spectators.size,
      host: room.host,
    };
  }

  _sendRoom(room, session) {
    const seat = SEATS.includes(session.seat) ? session.seat : 'spectator';
    this._send(session, {
      t: S2C.ROOM,
      room: this._roomInfo(room),
      you: { seat, name: session.name || '' },
    });
  }

  _broadcastRoom(room) {
    for (const member of this._members(room)) this._sendRoom(room, member);
  }

  _sendState(room, session, seat, events) {
    let view;
    try {
      view = viewFor(room.state, seat === 'spectator' ? null : seat);
    } catch {
      return;
    }
    const list = Array.isArray(events) ? events : [];
    view.events = list;
    this._send(session, { t: S2C.STATE, view, events: list });
  }

  _broadcastState(room, events) {
    for (const key of SEATS) {
      const seat = room.seats[key];
      if (seat && seat.session && seat.connected) {
        this._sendState(room, seat.session, key, events);
      }
    }
    for (const spectator of room.spectators) {
      this._sendState(room, spectator, 'spectator', events);
    }
  }

  _send(session, obj) {
    try {
      session.send(obj);
    } catch {
      /* ignore */
    }
  }

  _err(session, code, message) {
    this._send(session, { t: S2C.ERROR, code, message: message || code });
  }
}

export default RoomManager;
