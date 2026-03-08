FROM node:20-alpine

WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装依赖
RUN npm install --production

# 复制源代码
COPY server.js ./
COPY text-cleaner.js ./
COPY frontend/ ./frontend/

# 暴露端口
EXPOSE 3001

# 启动服务
CMD ["node", "server.js"]
