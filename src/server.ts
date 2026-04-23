#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb } from './db.js';
import { createEventBus } from './events.js';
import { createServer } from './http.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 4100);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? '/data/db.sqlite';

function resolvePublicDir(): string {
  // When run from dist/ the public dir is at ../public relative to the binary.
  const candidates = [
    path.resolve(__dirname, '..', 'public'),
    path.resolve(process.cwd(), 'public'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return candidates[0];
}

function main() {
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = openDb(DB_PATH);
  const bus = createEventBus();
  const publicDir = resolvePublicDir();
  const indexFile = path.join(publicDir, 'index.html');

  const server = createServer({ db, bus, publicDir, indexFile });

  server.listen(PORT, HOST, () => {
    console.log(`[claude-context] listening on http://${HOST}:${PORT}`);
    console.log(`[claude-context] db=${DB_PATH} public=${publicDir}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[claude-context] ${signal} received, shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
