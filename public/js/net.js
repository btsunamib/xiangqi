// WebSocket 客户端：连接 / 重连 / 心跳 / 消息分发（零依赖）
const HEARTBEAT_MS = 20000;   // 主动 ping 间隔
const PONG_TIMEOUT_MS = 45000; // 超时未收到 pong 则强制重连
const MAX_BACKOFF_MS = 8000;

export class Net {
  constructor(handlers) {
    const h = handlers || {};
    this.onStatus = h.onStatus || function () {};
    this.onMessage = h.onMessage || function () {};
    this.onReconnect = h.onReconnect || function () {};
    this.ws = null;
    this.connected = false;
    this.url = '';
    this.attempts = 0;
    this.shouldReconnect = true;
    this.closedByUser = false;
    this.lastPong = 0;
    this._hbTimer = null;
    this._reTimer = null;
  }

  connect() {
    if (typeof window === 'undefined') return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = proto + '//' + location.host;
    this._open();
  }

  _open() {
    this._clearTimers();
    this.closedByUser = false;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    const self = this;

    ws.onopen = function () {
      self.connected = true;
      self.attempts = 0;
      self.lastPong = Date.now();
      self.onStatus('ok', '已连接服务器');
      self._startHeartbeat();
      self.onReconnect();
    };

    ws.onmessage = function (ev) {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'pong') { self.lastPong = Date.now(); return; }
      try { self.onMessage(msg); } catch (e) { /* 单个消息处理失败不影响连接 */ }
    };

    ws.onerror = function () {
      self.onStatus('err', '连接异常');
    };

    ws.onclose = function () {
      self.connected = false;
      self._clearTimers();
      if (self.closedByUser || !self.shouldReconnect) {
        self.onStatus('', '已断开连接');
        return;
      }
      self.onStatus('err', '连接断开，正在重连…');
      self._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    const self = this;
    if (this._reTimer) return;
    this.attempts++;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * Math.pow(1.7, Math.min(6, this.attempts)));
    this._reTimer = setTimeout(function () {
      self._reTimer = null;
      if (self.closedByUser || !self.shouldReconnect) return;
      self._open();
    }, delay);
  }

  _startHeartbeat() {
    const self = this;
    this._hbTimer = setInterval(function () {
      if (!self.connected) return;
      if (Date.now() - self.lastPong > PONG_TIMEOUT_MS) {
        try { self.ws.close(); } catch (e) { /* ignore */ }
        return;
      }
      self.send({ t: 'ping', ts: Date.now() });
    }, HEARTBEAT_MS);
  }

  _clearTimers() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    if (this._reTimer) { clearTimeout(this._reTimer); this._reTimer = null; }
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  close() {
    this.closedByUser = true;
    this.shouldReconnect = false;
    this._clearTimers();
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
    }
    this.ws = null;
    this.connected = false;
  }
}

export default Net;
