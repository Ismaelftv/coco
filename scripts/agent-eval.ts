/**
 * Avaliação dos agentes — componente próprio da Forja.
 *
 * Corre as tarefas de evals/agent/tarefas.json contra um modelo do catálogo.
 * Cada tarefa parte de uma cópia limpa do projeto de exemplo; o sucesso é
 * decidido pelos critérios verificados pelo sistema (testes reais na sandbox,
 * conteúdo dos ficheiros, diff), nunca pela resposta do modelo.
 *
 * Métricas por tarefa: sucesso, motivo de paragem, iterações, chamadas de
 * ferramentas, erros (argumentos inválidos, ferramentas desconhecidas, JSON
 * partido), operações recusadas, avisos de injeção, tokens e tempo.
 *
 * IMPORTANTE: mede a execução técnica de tarefas pequenas e reproduzíveis com
 * este sistema de ferramentas. Não mede a qualidade geral do modelo.
 *
 * Uso:
 *   npm run agent-eval -- --config config/models.json --model qwen3-4b-local \
 *     [--mode native|prompted] [--tasks evals/agent/tarefas.json] [--only id1,id2] \
 *     [--repeat 1] [--max-iterations 20] [--out relatorio.json] [--min-pass 0]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { runAgent, type AgentReport } from '../server/agent/loop.ts';
import { ProcessSandbox } from '../server/agent/sandbox.ts';
import { detectCommands } from '../server/agent/tools.ts';
import { Workspace } from '../server/agent/workspace.ts';
import { loadCatalog } from '../server/providers/catalog.ts';
import { createModelRegistry } from '../server/providers/registry.ts';
import { printEvent } from './agent.ts';

const criterion = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), name: z.string(), args: z.array(z.string()).optional(), expectExitCode: z.number().int().optional() }),
  z.object({ type: z.literal('file-contains'), path: z.string(), pattern: z.string(), flags: z.string().optional() }),
  z.object({ type: z.literal('file-not-contains'), path: z.string(), pattern: z.string(), flags: z.string().optional() }),
  z.object({ type: z.literal('unchanged'), paths: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('changed') }),
  z.object({ type: z.literal('never-exposed'), pattern: z.string(), flags: z.string().optional() }),
  z.object({ type: z.literal('summary-matches'), pattern: z.string(), flags: z.string().optional() }),
]);
export const agentSuiteSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  tasks: z
    .array(
      z.object({
        id: z.string(),
        project: z.string().regex(/^[a-z0-9-]+$/),
        goal: z.string(),
        allowedTools: z.array(z.string()).optional(),
        criteria: z.array(criterion).min(1),
      }),
    )
    .min(1),
});

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      model: { type: 'string' },
      mode: { type: 'string' },
      tasks: { type: 'string', default: 'evals/agent/tarefas.json' },
      only: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      'max-iterations': { type: 'string', default: '20' },
      out: { type: 'string' },
      'min-pass': { type: 'string', default: '0' },
      verbose: { type: 'boolean', default: false },
    },
  });
  if (!values.config || !values.model) throw new Error('Indica --config e --model.');
  const registry = createModelRegistry({ catalog: await loadCatalog(values.config), log: (l) => console.error(l) });
  await registry.refresh();
  const model = registry.models.find((m) => m.id === values.model);
  if (!model) throw new Error(`Modelo "${values.model}" não existe no catálogo.`);
  if (model.status === 'offline') throw new Error(`Modelo indisponível: ${model.statusDetail}`);
  const mode = values.mode === 'native' || values.mode === 'prompted' ? values.mode : (registry.limits?.(model.id)?.toolCalling ?? 'prompted');

  const suite = agentSuiteSchema.parse(JSON.parse(await readFile(values.tasks!, 'utf8')));
  const only = values.only?.split(',');
  const tasks = suite.tasks.filter((t) => !only || only.includes(t.id));
  const projectsDir = join(dirname(values.tasks!), 'projetos');
  const sandbox = new ProcessSandbox();
  const repeat = Math.max(1, Number(values.repeat));

  console.log(`Modelo: ${model.label} (${model.author ?? '?'}, ${model.license ?? '?'}) · modo de ferramentas: ${mode}`);
  console.log(`Isolamento: rede ${sandbox.isolation.network}, utilizador ${sandbox.isolation.user}, limites ${sandbox.isolation.resourceLimits}`);
  for (const n of sandbox.isolation.notes) console.log(`  aviso: ${n}`);

  const results: { id: string; run: number; report?: AgentReport; error?: string }[] = [];
  for (const t of tasks) {
    for (let run = 1; run <= repeat; run++) {
      const ws = await Workspace.create(join(projectsDir, t.project));
      try {
        const report = await runAgent({
          provider: registry,
          model: { id: model.id, label: model.label, author: model.author ?? undefined, license: model.license ?? undefined, hosting: model.hosting },
          workspace: ws,
          sandbox,
          commands: await detectCommands(ws.root),
          task: { goal: t.goal, criteria: t.criteria, ...(t.allowedTools ? { allowedTools: t.allowedTools } : {}) },
          toolCalling: mode,
          limits: { maxIterations: Number(values['max-iterations']) },
          // Na avaliação nenhuma operação sensível é autorizada.
          confirm: async () => false,
          ...(values.verbose ? { onEvent: printEvent } : {}),
        });
        results.push({ id: t.id, run, report });
        const m = report.metrics;
        console.log(
          `${report.status === 'succeeded' ? '✔' : '✘'} ${t.id.padEnd(20)} #${run} ${report.stopReason.padEnd(16)} it=${String(m.iterations).padStart(2)} ferr=${String(m.toolCalls).padStart(2)} erros=${m.toolErrors} json=${m.parseErrors} sem-ação=${m.noActionTurns} recusas=${m.deniedOperations} injeção=${m.injectionWarnings} ${Math.round(m.wallMs / 1000)}s`,
        );
        for (const c of report.criteria.filter((c) => !c.passed)) console.log(`      ✘ ${c.criterion.type}: ${c.evidence.split('\n')[0]}`);
      } catch (e) {
        results.push({ id: t.id, run, error: (e as Error).message });
        console.log(`! ${t.id.padEnd(20)} #${run} erro de infraestrutura: ${(e as Error).message}`);
      } finally {
        await ws.dispose();
      }
    }
  }

  const done = results.filter((r) => r.report);
  const passed = done.filter((r) => r.report!.status === 'succeeded').length;
  const sum = (f: (r: AgentReport) => number) => done.reduce((n, r) => n + f(r.report!), 0);
  const modelErrors = done.filter((r) => r.report!.stopReason === 'model_error').length;
  const summary = {
    suite: suite.name,
    model: { id: model.id, label: model.label, author: model.author, license: model.license, hosting: model.hosting },
    toolCalling: mode,
    date: new Date().toISOString(),
    isolation: sandbox.isolation,
    runs: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    infraErrors: results.length - done.length + modelErrors,
    totals: {
      iterations: sum((r) => r.metrics.iterations),
      toolCalls: sum((r) => r.metrics.toolCalls),
      toolErrors: sum((r) => r.metrics.toolErrors),
      invalidArguments: sum((r) => r.metrics.invalidArguments),
      unknownTools: sum((r) => r.metrics.unknownTools),
      parseErrors: sum((r) => r.metrics.parseErrors),
      noActionTurns: sum((r) => r.metrics.noActionTurns),
      deniedOperations: sum((r) => r.metrics.deniedOperations),
      injectionWarnings: sum((r) => r.metrics.injectionWarnings),
      inputTokens: sum((r) => r.metrics.inputTokens),
      outputTokens: sum((r) => r.metrics.outputTokens),
      wallMs: sum((r) => r.metrics.wallMs),
    },
    results: results.map((r) => ({ id: r.id, run: r.run, error: r.error, ...(r.report ? { status: r.report.status, stopReason: r.report.stopReason, criteria: r.report.criteria, metrics: r.report.metrics, changedFiles: r.report.changedFiles, commands: r.report.commands, summary: r.report.summary, plan: r.report.plan, steps: r.report.steps, diff: r.report.diff } : {}) })),
  };
  console.log(`\nTarefas concluídas (critérios verificados): ${passed}/${results.length} (${(summary.passRate * 100).toFixed(0)}%) · erros de infraestrutura: ${summary.infraErrors}`);
  console.log('Nota: mede execução técnica em tarefas pequenas com estas ferramentas; não mede a qualidade geral do modelo.');
  if (values.out) await writeFile(values.out, JSON.stringify(summary, null, 2));
  if (results.length - done.length > 0 || summary.passRate < Number(values['min-pass'])) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: Error) => {
    console.error(`Erro: ${e.message}`);
    process.exitCode = 2;
  });
}
