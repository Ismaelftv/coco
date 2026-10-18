/**
 * Servidor de modelos falso para testes: fala a API nativa do Ollama
 * (/api/tags, /api/chat em NDJSON) e a API compatível com OpenAI
 * (/v1/models, /v1/chat/completions em SSE). Respostas determinísticas,
 * controladas por comandos na última mensagem do utilizador:
 *
 *   #lento        fragmentos espaçados de 50 ms
 *   #erro-http    responde 500
 *   #erro-stream  falha a meio da resposta
 *   #pensar       inclui raciocínio (campo próprio e etiquetas <think>)
 *   #longo        termina por limite de tokens (finish_reason "length")
 *   #ferramenta   (em qualquer mensagem) se o pedido trouxer `tools`, devolve uma chamada à primeira
 *                 ferramenta com {"path":"src/a.js"} (OpenAI: argumentos fragmentados)
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
  /** O cliente fechou a ligação antes do fim da resposta. */
  aborted: boolean;
}

export interface FakeModelServer {
  url: string;
  models: string[];
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lastUserText(body: Record<string, unknown>): string {
  const messages = (body.messages as { role: string; content: string }[] | undefined) ?? [];
  return [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
}

function replyFor(prompt: string): string[] {
  const words = `Resposta do modelo de teste para: ${prompt.slice(0, 60)}`.split(/(\s+)/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 2) out.push(words.slice(i, i + 2).join(''));
  return out;
}

export async function startFakeModelServer(opts: { models?: string[]; port?: number } = {}): Promise<FakeModelServer> {
  const state = { models: opts.models ?? ['qwen3:4b'], requests: [] as RecordedRequest[] };

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
    const record: RecordedRequest = { path: req.url ?? '', headers: req.headers, body, aborted: false };
    state.requests.push(record);
    res.on('close', () => {
      if (!res.writableFinished) record.aborted = true;
    });

    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: state.models.map((name) => ({ name, model: name })) }));
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: state.models.map((id) => ({ id, object: 'model' })) }));
    }

    const isOllama = req.url === '/api/chat';
    const isOpenAI = req.url === '/v1/chat/completions';
    if (req.method !== 'POST' || (!isOllama && !isOpenAI)) {
      res.writeHead(404).end();
      return;
    }
    if (!state.models.includes(String(body.model))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `model '${String(body.model)}' not found` }));
    }
    const prompt = lastUserText(body);
    if (prompt.includes('#erro-http')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'detalhe interno que não deve chegar ao utilizador: /srv/segredo' }));
    }
    const pieces = replyFor(prompt);
    const delay = prompt.includes('#lento') ? 50 : 0;
    const thinking = prompt.includes('#pensar');
    const failAt = prompt.includes('#erro-stream') ? 2 : -1;
    const finish = prompt.includes('#longo') ? 'length' : 'stop';

    const tools = body.tools as { function: { name: string } }[] | undefined;
    if (JSON.stringify(body.messages ?? []).includes('#ferramenta') && tools?.length) {
      const name = tools[0]!.function.name;
      if (isOllama) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: { path: 'src/a.js' } } }] }, done: false })}\n`);
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 5 })}\n`);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const sse = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      sse({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name, arguments: '' } }] } }] });
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] });
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"src/a.js"}' } }] } }] });
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    if (isOllama) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
      if (thinking) line({ message: { role: 'assistant', content: '', thinking: 'a ponderar…' }, done: false });
      for (let i = 0; i < pieces.length; i++) {
        if (res.destroyed) return;
        if (i === failAt) {
          line({ error: 'falha simulada' });
          return res.end();
        }
        line({ message: { role: 'assistant', content: pieces[i] }, done: false });
        if (delay) await sleep(delay);
      }
      line({ message: { role: 'assistant', content: '' }, done: true, done_reason: finish, prompt_eval_count: 42, eval_count: pieces.length });
      return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const sse = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (thinking) {
      sse({ choices: [{ delta: { reasoning_content: 'campo de raciocínio' } }] });
      sse({ choices: [{ delta: { content: '<thi' } }] });
      sse({ choices: [{ delta: { content: 'nk>pensamento em linha</think>\n' } }] });
    }
    for (let i = 0; i < pieces.length; i++) {
      if (res.destroyed) return;
      if (i === failAt) {
        sse({ error: { message: 'falha simulada' } });
        return res.end();
      }
      sse({ choices: [{ delta: { content: pieces[i] }, finish_reason: null }] });
      if (delay) await sleep(delay);
    }
    sse({ choices: [{ delta: {}, finish_reason: finish }] });
    if ((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage) {
      sse({ choices: [], usage: { prompt_tokens: 42, completion_tokens: pieces.length } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    get models() {
      return state.models;
    },
    set models(v: string[]) {
      state.models = v;
    },
    requests: state.requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
