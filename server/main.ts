import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { createMockProvider } from './providers/mock.ts';

const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? '127.0.0.1';
const delay = process.env.MOCK_DELAY_MS ? Number(process.env.MOCK_DELAY_MS) : undefined;

const app = createApp({
  provider: createMockProvider(delay === undefined ? {} : { delayMs: delay }),
  staticDir: fileURLToPath(new URL('../dist', import.meta.url)),
  log: (line) => console.log(line),
});

app.listen(port, host, () => {
  console.log(`Forja (dev) em http://${host}:${port} — fornecedor: simulado`);
});
