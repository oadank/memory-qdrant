FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
COPY dist/ ./dist/

RUN npm install --production && npm install @qdrant/js-client-rest pg better-sqlite3

EXPOSE 7777

CMD ["node", "dist/server-native.js"]
