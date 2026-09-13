# 契约文档（冻结版 v1）

> 本文件是 **接口契约**，由 Lead 维护并冻结。任何队友不得修改 `shared/**` 与 `docs/**`。
> 所有代码 **零第三方依赖**（禁止 npm install）。Node >= 18，ESM（`"type":"module"`）。

## 0. 文件所有权（写入范围，互不重叠）

| 目录 | Owner | 说明 |
|---|---|---|
| `shared/**`, `docs/**`, `package.json`, `README.md` | lead | 规则引擎 + 协议常量 + 文档 |
| `server/**` | server-dev | HTTP 静态服务 + WebSocket + 房间/对局 |
| `public/**` | client-dev | 前端页面、棋盘渲染、特效 |
| `tests/**` | qa-verifier | 独立测试与验证脚本 |

## 1. 坐标与数据模型

- 棋盘 9 列 × 10 行，`index = y * 9 + x`，`x: 0..8` 左→右，`y: 0..9` 上→下。
- **上方（y=0..4）为黑方 `'b'`，下方（y=9..5）为红方 `'r'`**（红方在下方）。
- 棋子类型：`K`帅/将 `A`仕/士 `B`相/象 `N`马 `R`车 `C`炮 `P`兵/卒
- 棋子对象：`{ id: string, color: 'r'|'b', type: 'K'|'A'|'B'|'N'|'R'|'C'|'P', revealed: boolean }`
  - `revealed === true`：明子，走法按 `type`。
  - `revealed === false`：暗子，**永远停留在初始格**，走法按该初始格的"位置角色"（见 `roleOfSquare`）；它的第一次移动 = 移动 + 翻开。
- 局面状态 `GameState`：
```js
{
  mode: 'normal'|'jieqi'|'chaosJieqi'|'chaosOpen',
  seed: number,
  board: (Piece|null)[90],
  turn: 'r'|'b',
  ply: number,
  over: boolean,
  winner: null|'r'|'b',
  reason: null|'checkmate'|'stalemate'|'kingcaptured'|'resign'|'agreement',
  history: Array<{ n:number, color:'r'|'b', from:number, to:number, type:string, captured:null|{type:string,color:string}, revealed:boolean }>,
  lastMove: null|{from:number,to:number}
}
```
- 标准初始格的角色（`roleOfSquare`）：底线 `x=0..8` → `R N B A K A B N R`；炮位 `(1,2)/(7,2)`（黑）与 `(1,7)/(7,7)`（红）→ `C`；兵位 `y=3,x=0,2,4,6,8`（黑）与 `y=6,x=0,2,4,6,8`（红）→ `P`。其余格 → `null`。

## 2. 四种模式

| mode | 中文 | 布局 | 明暗 |
|---|---|---|---|
| `normal` | 正常模式 | 标准 | 全明 |
| `jieqi` | 揭棋 | 帅/将固定在本方九宫原位（明），其余 15 枚身份随机洗牌到本方其余 15 个初始格 | 15 枚暗子，**双方均不可见其身份与阵营**（客户端 `type: null`、`color: null`） |
| `chaosJieqi` | 全乱揭棋 | **红黑 32 枚（含颜色）整体打乱**铺满 32 个初始格，阵营也是乱的 | 32 枚全暗，**身份与阵营均不可见** |
| `chaosOpen` | 全明乱棋（"一开始就揭完的全乱揭棋"） | 同 `chaosJieqi`（乱阵营） | 全明 |

洗牌使用 `seed` 决定的确定性 PRNG（mulberry32），同 seed 同布局。

### 2.1 暗子规则
- 暗子走法 = `roleOfSquare(它当前所在格)` 对应棋子的走法（该格即它的初始格）。
- 暗子一旦移动：先按上述走法移动到目标格，然后**翻开**，此后按真实身份走。
- 暗子被吃：**先翻开再移除**（事件里给出真实身份）。

### 2.2 将军 / 胜负
- 只有 **已翻开的将/帅** 才会被将军、才受"不能送将"约束。
- 若某方的将/帅仍是暗子：该方不受送将限制（因为本人不知道将在哪），但 **将/帅被吃 = 立即判负**。
- `normal` / `jieqi`：将/帅恒为明子 ⇒ 等价于标准象棋（含"困毙判负"）。
- 终局判定：
  - 被吃将/帅 → `kingcaptured`；
  - 轮到走棋的一方**无任何合法着法** → 该方负，`checkmate`（被将军时）或 `stalemate`（困毙，未被将军）；
  - 认输 → `resign`。
- 轮到走棋的一方"无合法着法"的定义：无合法着法即负（象棋规则，困毙同样判负）。

### 2.3 安全吃子高亮（用户核心需求）
对棋盘上每一枚棋子 P（颜色 C），若存在敌方棋子 E 满足：
1. E 存在一步**合法**着法吃掉 P；
2. E 吃子后落在 P 的格子上，此时 **C 方没有任何合法着法能吃掉 E**（即"吃完不会被其他棋子吃"）；
则称 P 为 **可安全吃子**。
视图映射（viewer 相对）：
- P 属于 viewer ⇒ 显示**红色描边**（警示：我的子被白吃）；
- P 属于对方 ⇒ 显示**绿色描边**（提示：可白吃对方）。
- 计算使用引擎内部真实身份（即"实际会发生的结果"）；对暗子而言，吃子后 E 会翻开，故按翻开后的真实身份判定。旁观者：`threats` 按归属色给出，`red`/`green` 为空。

## 3. `shared/engine.js` API（冻结）

```js
export const MODES = ['normal','jieqi','chaosJieqi','chaosOpen'];
export const MODE_INFO = { normal:{...}, jieqi:{...}, chaosJieqi:{...}, chaosOpen:{...} };
// MODE_INFO[m] = { key, name, desc, dark: boolean, chaos: boolean }

export function opposite(color)                 // 'r' <-> 'b'
export function idx(x, y)                       // -> number
export function xy(i)                           // -> {x, y}
export function roleOfSquare(index)             // -> 'K'|'A'|'B'|'N'|'R'|'C'|'P'|null
export function createGame(mode, seed)          // -> GameState（seed 省略则随机）
export function cloneState(state)               // -> GameState（深拷贝）
export function movesFrom(state, from)          // -> number[] 目标格（完全合法，已过滤送将/暴露己方明将）
export function allMoves(state)                 // -> Array<{from,to}>
export function makeMove(state, from, to)       // -> { ok:true, state, events } | { ok:false, error }
export function inCheck(state, color)           // -> boolean（仅针对已翻开的将/帅）
export function status(state)                   // -> { over, winner, reason, check:{r,b} }
export function highlights(state)               // -> { r:number[], b:number[] }  // 归属色 -> 可被安全吃的子所在格
export function viewFor(state, viewer)          // viewer: 'r'|'b'|null -> ClientView
export function resign(state, color)            // -> GameState（新状态，over=true, reason='resign'）
export function serialize(state)                // -> 可 JSON 化（等于 state 本身）
```

`makeMove` **不修改**入参，返回新状态。`events` 数组元素：
```js
{ t:'move',    from, to, color, type, dark:boolean }        // dark=移动前是否为暗子
{ t:'reveal',  index, color, type }                          // 暗子翻开（移动或被杀）
{ t:'capture', index, color, type, byColor, byType }         // 被吃子（暗子已翻开，type 为真实身份）
{ t:'check',   color }                                        // color 方被将军
{ t:'kingcaptured', winner }
{ t:'checkmate', winner, loser }
{ t:'stalemate', winner, loser }
```

## 4. `ClientView` 对象（`viewFor` 返回，服务器直接下发）

```js
{
  mode, turn, ply, over, winner, reason,
  board: Array<null | { i, id, color, type: string|null, revealed: boolean, role: string }>,
  //          type=null 表示该暗子身份对 viewer 隐藏；role = 该格位置角色（公开信息，可用于暗子走法提示）
  check: { r:boolean, b:boolean },
  legal: { [fromIndex]: number[] },   // 仅当 viewer 正是当前走子方时非空；否则 {}
  red:   number[],                    // viewer 己方被安全吃的子 -> 红描边
  green: number[],                    // 对方可被安全吃的子 -> 绿描边
  threats: { r:number[], b:number[] },// 归属色原始数据（旁观者用）
  lastMove: { from, to } | null,
  history: Array<{ n, color, from, to, type, captured:null|{type,color} }>,
  events: Array<Event>                // 本帧新产生的事件（服务器填充；本地模式由客户端填充）
}
```

## 5. HTTP

- `GET /` → `public/index.html`
- `GET /<path>` → `public/**` 静态文件；额外允许 `/shared/**`（浏览器直接 `import` 引擎，MIME `text/javascript`）
- `GET /health` → `200 {"ok":true,"rooms":N,"uptime":s}`
- 端口：`process.env.PORT`，默认 `3000`。启动日志必须打印实际监听地址。
- 未知路径 → 404；目录穿越（`..`）→ 403。

## 6. WebSocket 协议（JSON 文本帧）

客户端 → 服务器：
```js
{ t:'create',  mode, name, color? }        // color 可选 'r'|'b'
{ t:'join',    code, name }
{ t:'move',    from, to }
{ t:'ready' }                              // 切换准备状态
{ t:'start' }                              // 房主强制开局（双方就座后）
{ t:'resign' }
{ t:'rematch' }                            // 双方都点 -> 用新 seed 重开
{ t:'chat',    text }
{ t:'leave' }
{ t:'ping',    ts }
```
服务器 → 客户端：
```js
{ t:'hello',  id, serverTime }
{ t:'room',   room:{ code, mode, started, over, seats:{ r:{name,ready,connected}|null, b:{...}|null }, spectators:number, host:'r'|'b'|null }, you:{ seat:'r'|'b'|'spectator', name } }
{ t:'state',  view: ClientView, events: Array<Event> }
{ t:'chat',   seat, name, text, ts }
{ t:'error',  code, message }
{ t:'pong',   ts }
```
行为要求：
- `create` → 生成 6 位大写字母数字房间码，创建者坐下（默认红方，`color` 可指定），至少 2 人到位且都 `ready` 才可 `start`；也可房主 `start` 强制开始。
- `join` 同 code：空座位优先；两座已满 → 旁观者（`seat:'spectator'`），旁观者**只能看，不能走子**。
- 每个座位一份 `viewFor(state, seat)`；旁观者 `viewFor(state, null)`。**必须保证任何客户端都拿不到暗子的真实身份**（对局中/结束后未翻开的暗子也不下发身份）。
- 走子失败 → `{t:'error', code:'illegal_move'}`，状态不变。
- 掉线：座位标记 `connected:false`，保留 60s 可重连（同 `join` 同 code 且带 `name` 复座）；超时判负（`resign` 语义）。
- 心跳：服务器每 30s ping，60s 无 pong 断开。
- 消息上限 64KB，超限断开。

## 7. 前端要求（client-dev）

- 纯静态，`public/index.html` + ES module，可 `import` `/shared/engine.js`（本地双人模式直接用引擎）。
- 三个界面：大厅 / 房间 / 棋盘。大厅含 4 种模式卡片、创建房间、输入房号加入、**本地双人（热座）**、规则说明。
- 棋盘：SVG 画线（楚河汉界、九宫斜线、炮/兵位十字标记），棋子用 DOM 绝对定位 + CSS transform 过渡。
- 棋子：圆形，红方红字、黑方黑字；暗子显示统一背面纹样（不可泄露身份）。
- 高亮：**红描边 = 己方被白吃的子；绿描边 = 可白吃对方的子**，带呼吸动画。
- 选中棋子显示可走点（小圆点/空心圈），点击落子。
- **吃子特效**：命中闪光 + 粒子爆散 + 棋盘轻微震动 + WebAudio 合成音效（无音频文件）。
- **绝杀特效**：全屏"绝杀!"横幅 + 光晕冲击波 + 粒子雨 + 棋盘变暗 + 音效；困毙/认输/吃将用不同文案。
- 将军提示、回合指示、着法记录、认输/再来一局/离开、聊天、房间码一键复制。
- 移动端可玩（窄屏自适应），无横向滚动。

## 8. 测试要求（qa-verifier）

- `node --test tests/` 必须全绿。
- 引擎：标准初始局面红方合法着法数 = **44**；炮的隔子吃；马腿；象眼；士/将九宫限制；将帅照面（飞将）非法；困毙判负；被将军时只有解将着法合法。
- 揭棋：暗子按位置角色走；移动后翻开；同 seed 布局可复现。
- 高亮：构造局面断言 `highlights()` 归属正确（含"能被吃但会被反吃 ⇒ 不高亮"的负例）。
- 隐藏信息：创建房间、双方就座开局后，遍历服务器发给每个连接的所有帧，断言**对手暗子的 `type` 恒为 `null`**；并断言不能通过非法/越权消息替对手走子。
- 集成：真实启动 `server/index.js`，用原生 WebSocket 客户端完成「创建→加入→准备→开局→走子→吃子→认输」全流程，断言最终状态。
