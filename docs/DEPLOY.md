# 部署与手机访问

## 结论速览

| 想做的事 | 可行 | 说明 |
|---|---|---|
| GitHub Pages 玩人机 / 本地双人 | ✅ | 仓库根已有 `index.html` 入口 + `.nojekyll`，直接开 Pages 即可 |
| GitHub Pages 玩联机对战 | ❌ | Pages 只托管静态文件，没有 Node 进程，WebSocket 连不上 |
| 局域网内手机对战 | ✅ | 电脑跑 `node server/index.js`，手机访问 `http://<电脑IP>:3000` |
| 公网联机对战 | ✅ | Render / Railway / Fly.io / VPS + 仓库自带的 `Dockerfile` |
| 把代码放 GitHub | ✅ | 代码托管 ≠ 能运行服务端，两者是分开的 |

## 一、GitHub Pages（玩人机 / 本地双人）

### 为什么这样能行

`public/js/app.js` 顶部是静态 import：

```js
import { MODE_INFO, MODES } from '../../shared/engine.js';
```

静态 import 一旦 404，**整个 app.js 会加载失败、页面白屏**。所以关键在于让
`shared/` 与 `public/` **处在同一个站点根之下**。仓库根的 `index.html` 会把访问者
重定向到 `public/`，此时：

```
https://<user>.github.io/<repo>/            -> index.html -> 跳到 public/
https://<user>.github.io/<repo>/public/     -> public/index.html
       引用的 css/style.css   -> /<repo>/public/css/style.css   ✓
       引用的 js/app.js       -> /<repo>/public/js/app.js       ✓
       app.js 导入的 ../../shared/engine.js -> /<repo>/shared/engine.js ✓
```

### 步骤

1. 把仓库推到 GitHub；
2. 仓库 **Settings → Pages**；
3. Source 选 **Deploy from a branch**，Branch 选 `main`，目录选 **`/ (root)`**，保存；
4. 等约一分钟，访问 `https://<你的用户名>.github.io/<仓库名>/`。

`.nojekyll` 让 Pages 跳过 Jekyll 处理，按原样发布文件。

### 页面上会发生什么

`app.js` 会检测 `*.github.io`（以及 `file:` 协议），然后：

- 大厅顶部显示提示：「当前是静态托管，没有联机服务器：请使用「人机对战」或「本地双人」」；
- 点「创建房间 / 加入房间」时直接给出同样的提示，**不会**去尝试连接、也不会无限重连；
- 「人机对战」和「本地双人」完全正常，所有规则计算在浏览器里完成。

## 二、公网联机（需要 Node 主机）

### 方案 A：Docker（推荐，仓库已带 Dockerfile）

```bash
docker build -t xiangqi .
docker run -d --name xiangqi -p 3000:3000 --restart unless-stopped xiangqi
```

托管平台（Render / Railway / Fly.io）：连接 GitHub 仓库 → 识别 `Dockerfile` → 部署 →
对外端口填 `3000`（或设置环境变量 `PORT`，服务端会读 `process.env.PORT`）。

### 方案 B：平台直接跑 Node（Node >= 18）

启动命令 `node server/index.js`，环境变量 `PORT=3000`。
**没有 `npm install` 这一步**——项目没有任何第三方依赖。

### HTTPS 与 wss

`public/js/net.js` 按页面协议自动选择：

```js
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
```

部署到 HTTPS 平台后自动走 `wss://`，**不需要改代码**。
Nginx 反代要记得转发升级头：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## ⚠️ 房间状态存在内存里

`server/rooms.js` 用内存 `Map` 保存房间与对局，因此：

- **不能多实例横向扩容**（实例之间房间不互通）；
- **进程重启 = 所有房间和对局丢失**；
- Render / Railway 免费档休眠回收后会中断正在下的棋（前端会自动重连，但可能收到「房间不存在」）。

要长期稳定联机请用不休眠的实例；要支撑大量用户，需要把房间状态外置（如 Redis），目前未实现。

## 三、手机访问

### 局域网（最快）

1. 电脑 `ipconfig` 找到 IPv4 地址（形如 `192.168.x.x`）；
2. 电脑运行 `node server/index.js`；
3. 手机连**同一个 Wi-Fi**，浏览器打开 `http://192.168.x.x:3000`；
4. 打不开多半是 Windows 防火墙拦了 Node —— 在「Windows Defender 防火墙 → 允许应用通过防火墙」
   里给 Node.js 放行**专用网络**。

### 公网

直接用托管平台的 HTTPS 域名，手机浏览器打开即可，可「添加到主屏幕」当 App 用。

## 手机适配现状（如实说明）

已具备：

- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`；
- `overflow-x: hidden`，以及 `max-width: 900px` / `560px` 两档媒体查询
  （≤900px 时侧栏从右侧改为堆叠到棋盘下方，座位与聊天区收窄）；
- `board.js` 用 `ResizeObserver` 监听容器宽度，棋盘按 `scale(min(1, 容器宽/568))` 等比缩放，
  最小 0.32 倍，窄屏不会横向溢出；
- 交互是普通 DOM + `click`，触屏可直接点选落子；
- 已加 `touch-action: manipulation`（减少双击缩放），并把「可走点」的点击热区
  用伪元素扩大到约 46px（视觉大小不变）。

**仍未在真机目视验证**，可能的遗留问题：

- 360px 宽屏幕上棋子约 34px，低于 44px 的推荐触摸目标，落子精度要求偏高；
- 侧栏在手机上会堆在棋盘下方，看棋谱/聊天需要往下滚。
