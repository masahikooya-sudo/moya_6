FROM node:20-alpine

# ログローテーションの「日付が変わるタイミング」をTZ環境変数どおりに判定するために必要
RUN apk add --no-cache tzdata

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV PORT=3000
ENV TZ=Asia/Tokyo
EXPOSE 3000

CMD ["node", "server.js"]
