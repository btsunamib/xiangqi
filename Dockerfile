# 中国象棋联机网站 —— 零依赖，不需要 npm install
FROM node:22-alpine

WORKDIR /app

# 只复制运行所需内容（项目没有任何第三方依赖）
COPY package.json README.md ./
COPY shared/ ./shared/
COPY server/ ./server/
COPY public/ ./public/
COPY docs/ ./docs/

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# 以非 root 用户运行（node 镜像自带 node 用户）
USER node

CMD ["node", "server/index.js"]
