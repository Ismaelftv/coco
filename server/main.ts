import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/db.ts';
import { migrate } from './db/migrate.ts';
import { runMaintenance } from './modules/maintenance.ts';
import { createMockProvider } from './providers/mock.ts';
import { createLocalStorage } from './storage/storage.ts';

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const config = loadConfig();
const db = createDb({ url: config.DATABASE_URL, poolSize: config.DB_POOL_SIZE });
await migrate(db, log);

const storage = createLocalStorage(config.STORAGE_DIR);
const { server, shutdown } = createApp({
  config,
  db,
  provider: createMockProvider({ delayMs: config.MOCK_DELAY_MS }),
  storage,
  staticDir: fileURLToPath(new URL('../dist', import.meta.url)),
  log,
});

const maintenance = setInterval(() => {
  runMaintenance(db, storage, log).catch((e: Error) => log(`[manutenção] ${e.message}`));
}, 60_000);
await runMaintenance(db, storage, log);

server.listen(config.PORT, config.HOST, () => {
  log(`Forja em http://${config.HOST}:${config.PORT} — fornecedor: simulado — ambiente: ${config.NODE_ENV}`);
});

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  log(`[${signal}] a terminar…`);
  clearInterval(maintenance);
  server.close();
  await shutdown();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
