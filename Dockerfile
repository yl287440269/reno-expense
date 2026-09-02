FROM node:18-bookworm-slim

WORKDIR /app

# 安装依赖（better-sqlite3 在 linux-x64 上有预编译包，无需本地编译）
COPY package*.json ./
RUN npm install --omit=dev

# 复制源码
COPY . .

RUN mkdir -p /data
ENV DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.js"]
