// 前后端共享的协议常量（冻结）。禁止第三方依赖。
export const PROTOCOL_VERSION = 1;

export const C2S = {
  CREATE: 'create',
  JOIN: 'join',
  MOVE: 'move',
  READY: 'ready',
  START: 'start',
  RESIGN: 'resign',
  REMATCH: 'rematch',
  CHAT: 'chat',
  LEAVE: 'leave',
  PING: 'ping',
};

export const S2C = {
  HELLO: 'hello',
  ROOM: 'room',
  STATE: 'state',
  CHAT: 'chat',
  ERROR: 'error',
  PONG: 'pong',
};

export const ERR = {
  BAD_MESSAGE: 'bad_message',
  BAD_MODE: 'bad_mode',
  NO_ROOM: 'no_room',
  ROOM_FULL: 'room_full',
  NOT_SEATED: 'not_seated',
  NOT_YOUR_TURN: 'not_your_turn',
  ILLEGAL_MOVE: 'illegal_move',
  NOT_STARTED: 'not_started',
  ALREADY_STARTED: 'already_started',
  GAME_OVER: 'game_over',
  RATE_LIMIT: 'rate_limit',
};

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const CHAT_MAX_LEN = 200;
export const NAME_MAX_LEN = 16;
export const ROOM_CODE_LEN = 6;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// 简单的消息校验（服务器与测试共用）
export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function sanitizeText(v, maxLen) {
  if (typeof v !== 'string') return '';
  // 去掉控制字符，避免终端/渲染异常
  const cleaned = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, maxLen);
}
