/**
 * Avaliação de modelos — componente próprio da Forja.
 *
 * Corre um conjunto de casos (evals/*.json) contra um modelo do catálogo,
 * usando o mesmo caminho da aplicação (registo + prompt de sistema), e mede
 * qualidade (critérios por caso), latência e tokens. Serve para comparar
 * modelos locais, servidores (Ollama vs vLLM) e integrações externas com os
 * mesmos casos, antes de trocar o modelo por defeito.
 *
 * Uso:
 *   tsx scripts/eval.ts --config config/models.json --model qwen3-4b-local \
 *     --cases evals/basico.json [--out relatorio.json] [--min-pass 0.8]
 *
 * Código de saída ≠ 0 se algum caso falhar por erro de infraestrutura, ou se a
 * taxa de aprovação ficar abaixo de --min-pass (por omissão 0: só infraestrutura).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadCatalog } from '../server/providers/catalog.ts';
import { createMockProvider } from '../server/providers/mock.ts';
import { createModelRegistry } from '../server/providers/registry.ts';
import { buildSystemPrompt } from '../server/prompts/system.ts';

const checkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('regex'), value: z.string(), flags: z.string().optional() }),
  z.object({ type: z.literal('not-regex'), value: z.string(), flags: z.string().optional() }),
  z.object({ type: z.literal('max-chars'), value: z.number().int().positive() }),
  z.object({ type: z.literal('json') }),
]);
const suiteSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  cases: z
    .array(
      z.object({
        id: z.string(),
        prompt: z.string(),
        attachments: z.array(z.object({ name: z.string(), content: z.string() })).optional(),
        checks: z.array(checkSchema).min(1),
      }),
    )
    .min(1),
});
type Check = z.infer<typeof checkSchema>;

export function runCheck(check: Check, answer: string): boolean {
  switch (check.type) {
    case 'regex':
      return new RegExp(check.value, check.flags).test(answer);
    case 'not-regex':
      return !new RegExp(check.value, check.flags).test(answer);
    case 'max-chars':
      return answer.trim().length <= check.value;
    case 'json':
      try {
        JSON.parse(answer.trim());
        return true;
      } catch {
        return false;
      }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      model: { type: 'string' },
      cases: { type: 'string', default: 'evals/basico.json' },
      out: { type: 'string' },
      'min-pass': { type: 'string', default: '0' },
    },
  });
  if (!values.model) throw new Error('Indica --model (id do catálogo, ou forja-sim).');
  const catalog = values.config ? await loadCatalog(values.config) : { backends: [], models: [] };
  const registry = createModelRegistry({ catalog, simulator: createMockProvider({ delayMs: 0 }), log: (l) => console.error(l) });
  await registry.refresh();
  const model = registry.models.find((m) => m.id === values.model);
  if (!model) throw new Error(`Modelo "${values.model}" não existe no catálogo.`);
  if (model.status === 'offline') throw new Error(`Modelo indisponível: ${model.statusDetail}`);

  const suite = suiteSchema.parse(JSON.parse(await readFile(values.cases!, 'utf8')));
  const system = model.hosting === 'simulated' ? undefined : buildSystemPrompt(model);
  const results = [];
  for (const c of suite.cases) {
    const started = performance.now();
    let firstToken: number | null = null;
    let answer = '';
    let error: string | null = null;
    let usage = null;
    const attachments = (c.attachments ?? []).map((a) => ({ name: a.name, mediaType: 'text/plain', content: a.content }));
    for await (const ev of registry.stream(
      { model: model.id, ...(system ? { system } : {}), messages: [{ role: 'user', content: c.prompt, ...(attachments.length ? { attachments } : {}) }] },
      AbortSignal.timeout(600_000),
    )) {
      if (ev.type === 'delta') {
        firstToken ??= performance.now() - started;
        answer += ev.text;
      } else if (ev.type === 'end') usage = ev.usage;
      else if (ev.type === 'error') error = `${ev.code}: ${ev.message}`;
    }
    const checks = error ? [] : c.checks.map((ck) => ({ ...ck, passed: runCheck(ck, answer) }));
    const passed = !error && answer.trim().length > 0 && checks.every((x) => x.passed);
    results.push({ id: c.id, passed, error, answer, checks, usage, firstTokenMs: firstToken && Math.round(firstToken), totalMs: Math.round(performance.now() - started) });
    console.log(`${passed ? '✔' : '✘'} ${c.id.padEnd(22)} ${String(Math.round(performance.now() - started)).padStart(6)} ms  ${error ?? answer.replace(/\s+/g, ' ').slice(0, 70)}`);
  }

  const passRate = results.filter((r) => r.passed).length / results.length;
  const infraFailures = results.filter((r) => r.error || r.answer.trim().length === 0);
  const report = {
    suite: suite.name,
    model: { id: model.id, label: model.label, hosting: model.hosting, author: model.author, license: model.license },
    date: new Date().toISOString(),
    passRate,
    medianTotalMs: [...results.map((r) => r.totalMs)].sort((a, b) => a - b)[Math.floor(results.length / 2)],
    results,
  };
  console.log(`\nAprovação: ${(passRate * 100).toFixed(0)}% (${results.filter((r) => r.passed).length}/${results.length}) · falhas de infraestrutura: ${infraFailures.length}`);
  if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2));
  if (infraFailures.length > 0 || passRate < Number(values['min-pass'])) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: Error) => {
    console.error(`Erro: ${e.message}`);
    process.exitCode = 2;
  });
}
