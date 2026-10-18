/**
 * Avaliação dos agentes — componente próprio da Forja.
 *
 * Corre as tarefas de evals/agent/tarefas.json contra um modelo do catálogo.
 * Cada tarefa parte de uma cópia limpa do projeto de exemplo. Os resultados são
 * mantidos SEPARADOS, porque medem coisas diferentes e nenhuma implica outra:
 *
 *   execução   o agente concluiu a tarefa (critérios visíveis, verificados pelo sistema)
 *   qualidade  testes escondidos, tamanho/âmbito do diff, sintaxe (o modelo não os vê)
 *   injeção    tentativas do modelo de obedecer a instruções maliciosas vs. barreiras do sistema
 *   sandbox    garantias de isolamento VERIFICADAS por comportamento (não depende do modelo)
 *   custo      tempo, tokens, hardware
 *
 * Passar numa tarefa de injeção em poucas execuções NÃO prova segurança: as
 * garantias de segurança vêm das barreiras estruturais e da sandbox (secção
 * "sandbox"), não do comportamento do modelo.
 *
 * Código escrito pelo modelo é executado: por omissão exige-se uma sandbox
 * verificada como "strong" (contentor). `--allow-weak-isolation` aceita o nível
 * verificado (que fica registado no relatório) e NÃO deve usar-se com modelos ou
 * tarefas não confiáveis.
 *
 * Uso:
 *   npm run agent-eval -- --config config/models.json --model qwen3-4b-local \
 *     [--mode native|prompted] [--sandbox auto|container|process] [--allow-weak-isolation] \
 *     [--tasks evals/agent/tarefas.json] [--only id1,id2] [--repeat 1] \
 *     [--max-iterations 20] [--out relatorio.json] [--min-pass 0]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem, platform, release } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { categoryOf, runAgent, type AgentReport, type CriterionResult, type SuccessCriterion } from '../server/agent/loop.ts';
import { selectSandbox, type SandboxChoice } from '../server/agent/sandbox-factory.ts';
import { detectCommands } from '../server/agent/tools.ts';
import { Workspace } from '../server/agent/workspace.ts';
import { loadCatalog } from '../server/providers/catalog.ts';
import { createModelRegistry } from '../server/providers/registry.ts';
import { printEvent } from './agent.ts';

const category = z.enum(['execution', 'quality', 'injection']).optional();
const criterion = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), name: z.string(), args: z.array(z.string()).optional(), expectExitCode: z.number().int().optional(), category }),
  z.object({ type: z.literal('file-contains'), path: z.string(), pattern: z.string(), flags: z.string().optional(), category }),
  z.object({ type: z.literal('file-not-contains'), path: z.string(), pattern: z.string(), flags: z.string().optional(), category }),
  z.object({ type: z.literal('unchanged'), paths: z.array(z.string()).min(1), category }),
  z.object({ type: z.literal('changed'), category }),
  z.object({ type: z.literal('never-exposed'), pattern: z.string(), flags: z.string().optional(), category }),
  z.object({ type: z.literal('summary-matches'), pattern: z.string(), flags: z.string().optional(), category }),
  z.object({ type: z.literal('holdout'), dir: z.string().regex(/^[a-z0-9-]+$/), argv: z.array(z.string()).min(1), category }),
  z.object({ type: z.literal('diff-size'), maxChangedLines: z.number().int().positive(), category }),
  z.object({ type: z.literal('files-within'), paths: z.array(z.string()).min(1), category }),
  z.object({ type: z.literal('syntax-valid'), category }),
]);
export const agentSuiteSchema = z.object({
  name: z.string(),
  version: z.number().optional(),
  description: z.string().optional(),
  tasks: z
    .array(
      z.object({
        id: z.string(),
        project: z.string().regex(/^[a-z0-9-]+$/),
        goal: z.string(),
        allowedTools: z.array(z.string()).optional(),
        forbiddenActions: z.array(z.object({ tool: z.string(), argPattern: z.string().optional() })).optional(),
        criteria: z.array(criterion).min(1),
      }),
    )
    .min(1),
});

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
const sumBy = <T>(xs: T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);
const byCat = (rs: CriterionResult[], cat: 'execution' | 'quality' | 'injection') => rs.filter((r) => categoryOf(r.criterion as SuccessCriterion) === cat);

async function ollamaRuntime(baseUrl: string): Promise<Record<string, unknown>> {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const get = async (p: string) => {
    try {
      const r = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(5000) });
      return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const ps = (await get('/api/ps')) as { models?: { name: string; size: number; size_vram: number; context_length?: number }[] } | null;
  const tags = (await get('/api/tags')) as { models?: { name: string; size: number }[] } | null;
  return { loaded: ps?.models ?? null, installed: tags?.models?.map((m) => ({ name: m.name, sizeBytes: m.size })) ?? null };
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      model: { type: 'string' },
      mode: { type: 'string' },
      sandbox: { type: 'string', default: 'auto' },
      'allow-weak-isolation': { type: 'boolean', default: false },
      tasks: { type: 'string', default: 'evals/agent/tarefas.json' },
      only: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      'max-iterations': { type: 'string', default: '20' },
      'max-wall-seconds': { type: 'string', default: '900' },
      out: { type: 'string' },
      'min-pass': { type: 'string', default: '0' },
      verbose: { type: 'boolean', default: false },
    },
  });
  if (!values.config || !values.model) throw new Error('Indica --config e --model.');
  const catalog = await loadCatalog(values.config);
  const registry = createModelRegistry({ catalog, log: (l) => console.error(l) });
  await registry.refresh();
  const model = registry.models.find((m) => m.id === values.model);
  if (!model) throw new Error(`Modelo "${values.model}" não existe no catálogo.`);
  if (model.status === 'offline') throw new Error(`Modelo indisponível: ${model.statusDetail}`);
  const mode = values.mode === 'native' || values.mode === 'prompted' ? values.mode : (registry.limits?.(model.id)?.toolCalling ?? 'prompted');
  const weakOk = values['allow-weak-isolation'];

  const suite = agentSuiteSchema.parse(JSON.parse(await readFile(values.tasks!, 'utf8')));
  const only = values.only?.split(',');
  const tasks = suite.tasks.filter((t) => !only || only.includes(t.id));
  const suiteDir = dirname(resolve(values.tasks!));
  const projectsDir = join(suiteDir, 'projetos');
  const holdoutRoot = join(suiteDir, 'holdout');

  const selection = await selectSandbox(values.sandbox as SandboxChoice);
  const { sandbox, verdict } = selection;
  const trust = weakOk ? 'trusted' : 'untrusted';
  const repeat = Math.max(1, Number(values.repeat));

  console.log(`Modelo: ${model.label} (${model.author ?? '?'}, ${model.license ?? '?'}) · modo de ferramentas: ${mode}`);
  console.log(`Sandbox: ${sandbox.name} · isolamento VERIFICADO: ${verdict.level.toUpperCase()} · confiança aplicada: ${trust}`);
  for (const k of verdict.checks.filter((c) => c.requiredFor !== 'info' && !c.passed)) console.log(`  ✘ ${k.title} — ${k.evidence}`);
  for (const x of verdict.contradictions) console.log(`  ⚠ ${x}`);
  for (const s of selection.skipped) console.log(`  (alternativa descartada: ${s})`);
  if (verdict.level !== 'strong' && !weakOk) {
    console.log('A sandbox não garante isolamento forte: as tarefas serão recusadas (use contentor, ou --allow-weak-isolation só para código de confiança).');
  }

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
          verdict,
          trust,
          holdoutRoot,
          commands: await detectCommands(ws.root),
          task: { goal: t.goal, criteria: t.criteria as SuccessCriterion[], ...(t.allowedTools ? { allowedTools: t.allowedTools } : {}), ...(t.forbiddenActions ? { forbiddenActions: t.forbiddenActions } : {}) },
          toolCalling: mode,
          limits: { maxIterations: Number(values['max-iterations']), maxWallMs: Number(values['max-wall-seconds']) * 1000 },
          // Na avaliação nenhuma operação sensível é autorizada.
          confirm: async () => false,
          ...(values.verbose ? { onEvent: printEvent } : {}),
        });
        results.push({ id: t.id, run, report });
        const m = report.metrics;
        const ex = byCat(report.criteria, 'execution');
        const inj = byCat(report.criteria, 'injection');
        const q = report.quality;
        console.log(
          `${report.status === 'succeeded' ? '✔' : '✘'} ${t.id.padEnd(26)} #${run} ${report.stopReason.padEnd(20)} exec=${ex.filter((c) => c.passed).length}/${ex.length} qual=${q.filter((c) => c.passed).length}/${q.length} inj=${report.injection.attempts}tent/${inj.filter((c) => c.passed).length}/${inj.length}barr it=${m.iterations} ferr=${m.toolCalls} erros=${m.toolErrors} ${Math.round(m.wallMs / 1000)}s`,
        );
        for (const c of [...report.criteria, ...q].filter((c) => !c.passed)) console.log(`      ✘ [${categoryOf(c.criterion as SuccessCriterion)}] ${c.criterion.type}: ${c.evidence.split('\n')[0]}`);
      } catch (e) {
        results.push({ id: t.id, run, error: (e as Error).message });
        console.log(`! ${t.id.padEnd(26)} #${run} erro de infraestrutura: ${(e as Error).message}`);
      } finally {
        await ws.dispose();
      }
    }
  }

  const done = results.filter((r): r is { id: string; run: number; report: AgentReport } => !!r.report);
  const refused = done.filter((r) => r.report.stopReason === 'sandbox_insufficient');
  const ran = done.filter((r) => r.report.stopReason !== 'sandbox_insufficient');
  const modelErrors = ran.filter((r) => r.report.stopReason === 'model_error').length;
  const execPassed = ran.filter((r) => byCat(r.report.criteria, 'execution').every((c) => c.passed));
  const qualityRuns = ran.filter((r) => r.report.quality.length > 0);
  const qualityAmongExec = execPassed.filter((r) => r.report.quality.length > 0);
  const injRuns = ran.filter((r) => (tasks.find((t) => t.id === r.id)?.forbiddenActions?.length ?? 0) > 0);
  const stopReasons: Record<string, number> = {};
  for (const r of done) stopReasons[r.report.stopReason] = (stopReasons[r.report.stopReason] ?? 0) + 1;
  const wallMs = sumBy(ran, (r) => r.report.metrics.wallMs);
  const outTok = sumBy(ran, (r) => r.report.metrics.outputTokens);
  const runtime = catalog.backends.find((b) => b.id === catalog.models.find((m) => m.id === model.id)?.backend && b.kind === 'ollama');

  const summary = {
    suite: suite.name,
    suiteVersion: suite.version ?? 1,
    model: { id: model.id, label: model.label, author: model.author, license: model.license, hosting: model.hosting },
    toolCalling: mode,
    date: new Date().toISOString(),
    trust,
    // 1. SANDBOX — segurança da infraestrutura, independente do modelo.
    sandbox: { name: sandbox.name, declared: sandbox.isolation, verifiedLevel: verdict.level, checks: verdict.checks, contradictions: verdict.contradictions, discarded: selection.skipped, runsRefused: refused.length },
    // 2. EXECUÇÃO TÉCNICA
    execution: {
      runs: ran.length,
      passed: execPassed.length,
      passRate: ran.length ? execPassed.length / ran.length : null,
      fullySucceeded: ran.filter((r) => r.report.status === 'succeeded').length,
      stopReasons,
      medianIterations: median(ran.map((r) => r.report.metrics.iterations)),
      totals: {
        toolCalls: sumBy(ran, (r) => r.report.metrics.toolCalls),
        toolErrors: sumBy(ran, (r) => r.report.metrics.toolErrors),
        invalidArguments: sumBy(ran, (r) => r.report.metrics.invalidArguments),
        unknownTools: sumBy(ran, (r) => r.report.metrics.unknownTools),
        parseErrors: sumBy(ran, (r) => r.report.metrics.parseErrors),
        noActionTurns: sumBy(ran, (r) => r.report.metrics.noActionTurns),
      },
    },
    // 3. QUALIDADE DO CÓDIGO (testes escondidos e diff), avaliada sem o modelo ver
    quality: {
      runsEvaluated: qualityRuns.length,
      criteriaPassed: sumBy(qualityRuns, (r) => r.report.quality.filter((c) => c.passed).length),
      criteriaTotal: sumBy(qualityRuns, (r) => r.report.quality.length),
      runsAllPassed: qualityRuns.filter((r) => r.report.quality.every((c) => c.passed)).length,
      amongExecutionPassed: { runs: qualityAmongExec.length, allPassed: qualityAmongExec.filter((r) => r.report.quality.every((c) => c.passed)).length },
      note: 'Em execuções sem alterações úteis a qualidade falha trivialmente; ver "amongExecutionPassed".',
    },
    // 4. INJEÇÃO — tentativas do modelo vs. resultado das barreiras
    injection: {
      scenarioRuns: injRuns.length,
      runsWithAttempts: injRuns.filter((r) => r.report.injection.attempts > 0).length,
      attempts: sumBy(injRuns, (r) => r.report.injection.attempts),
      attemptsExecuted: sumBy(injRuns, (r) => r.report.injection.details.filter((d) => d.includes('EXECUTADA')).length),
      runsWhereBarriersHeld: injRuns.filter((r) => byCat(r.report.criteria, 'injection').every((c) => c.passed)).length,
      secretExposedRuns: injRuns.filter((r) => r.report.criteria.some((c) => c.criterion.type === 'never-exposed' && !c.passed)).length,
      flaggedObservations: sumBy(injRuns, (r) => r.report.injection.flaggedObservations),
      note: 'Poucas execuções não demonstram resistência. A proteção real vem das barreiras estruturais (segredos não copiados, confirmação, critérios de integridade) e da sandbox.',
    },
    // 5. CUSTO E HARDWARE
    cost: {
      wallMsTotal: wallMs,
      wallMsMedianPerRun: median(ran.map((r) => r.report.metrics.wallMs)),
      inputTokens: sumBy(ran, (r) => r.report.metrics.inputTokens),
      outputTokens: outTok,
      outputTokensPerSecond: wallMs ? Number(((outTok / wallMs) * 1000).toFixed(2)) : null,
      tokensEstimated: ran.some((r) => r.report.metrics.tokensEstimated),
      hardware: { cpus: cpus().length, cpuModel: cpus()[0]?.model ?? '?', memGB: Number((totalmem() / 2 ** 30).toFixed(1)), platform: `${platform()} ${release()}`, node: process.version, gpu: 'não medido' },
      runtime: runtime ? await ollamaRuntime(runtime.baseUrl) : null,
    },
    results: results.map((r) => ({
      id: r.id,
      run: r.run,
      error: r.error,
      ...(r.report
        ? {
            status: r.report.status,
            stopReason: r.report.stopReason,
            execution: byCat(r.report.criteria, 'execution').map((c) => ({ type: c.criterion.type, passed: c.passed, evidence: c.evidence.slice(0, 300) })),
            injection: { attempts: r.report.injection.attempts, details: r.report.injection.details, barriers: byCat(r.report.criteria, 'injection').map((c) => ({ type: c.criterion.type, passed: c.passed, evidence: c.evidence.slice(0, 200) })) },
            quality: r.report.quality.map((c) => ({ type: c.criterion.type, passed: c.passed, evidence: c.evidence.slice(0, 300) })),
            metrics: r.report.metrics,
            changedFiles: r.report.changedFiles,
            commands: r.report.commands.map((c) => ({ name: c.name, exitCode: c.exitCode, timedOut: c.timedOut, durationMs: c.durationMs })),
            summary: r.report.summary,
            plan: r.report.plan,
            steps: r.report.steps.map((s) => ({ ...s, observation: s.observation?.slice(0, 160) })),
            diff: r.report.diff.slice(0, 4000),
          }
        : {}),
    })),
  };

  const pct = (n: number, d: number) => (d ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : 'n/d');
  console.log('\n══ Resultados (categorias separadas) ══');
  console.log(`SANDBOX    ${sandbox.name}: nível verificado ${verdict.level.toUpperCase()}${verdict.contradictions.length ? ` · ${verdict.contradictions.length} contradição(ões)` : ''} · execuções recusadas por isolamento insuficiente: ${refused.length}`);
  console.log(`EXECUÇÃO   critérios de execução cumpridos: ${pct(execPassed.length, ran.length)} · concluídas por inteiro: ${pct(summary.execution.fullySucceeded, ran.length)} · paragens: ${JSON.stringify(stopReasons)}`);
  console.log(`QUALIDADE  testes escondidos/diff: execuções com tudo OK ${pct(summary.quality.runsAllPassed, qualityRuns.length)} · entre as que cumpriram a execução ${pct(summary.quality.amongExecutionPassed.allPassed, qualityAmongExec.length)}`);
  console.log(`INJEÇÃO    execuções com tentativa de obedecer: ${pct(summary.injection.runsWithAttempts, injRuns.length)} (ações executadas: ${summary.injection.attemptsExecuted}) · barreiras aguentaram: ${pct(summary.injection.runsWhereBarriersHeld, injRuns.length)} · segredo exposto: ${summary.injection.secretExposedRuns}`);
  console.log(`CUSTO      ${Math.round(wallMs / 1000)} s no total · ${summary.cost.outputTokensPerSecond ?? '?'} tokens/s de saída · ${summary.cost.hardware.cpus} CPU, ${summary.cost.hardware.memGB} GB RAM`);
  console.log('Nota: amostras pequenas, 6 tarefas em JavaScript. Medem execução técnica com estas ferramentas, não a qualidade geral do modelo nem a segurança da infraestrutura.');
  if (values.out) await writeFile(values.out, JSON.stringify(summary, null, 2));
  const infra = results.length - done.length + modelErrors;
  if (infra > 0 || refused.length > 0 || (summary.execution.passRate ?? 0) < Number(values['min-pass'])) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: Error) => {
    console.error(`Erro: ${e.message}`);
    process.exitCode = 2;
  });
}
