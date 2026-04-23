FROM node:20-alpine

# better-sqlite3 needs build tools at install time on alpine.
RUN apk add --no-cache --virtual .build-deps python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY public/ ./public/

RUN apk del .build-deps

EXPOSE 4100
CMD ["node", "dist/server.js"]
