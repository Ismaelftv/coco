/**
 * Executa as soluções de referência (evals/agent/referencia/solucoes.json) pelo mesmo ciclo, ferramentas
 * e critérios que os modelos, com um "modelo" roteirizado. Prova que cada tarefa É POSSÍVEL com as
 * ferramentas disponíveis e que os critérios a reconhecem. Não usa nenhum modelo real.
 *
 *   npm run agent-reference -- [--sandbox auto|container|process] [--only corrigir-bug] [--out ficheiro.json]
 *
 * As referências nunca são fornecidas aos modelos avaliados.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { classifyOutcome } from '../server/agent/classify.ts';
import { runAgent, type AgentTask } from '../server/agent/loop.ts';
import { selectSandbox, type SandboxChoice } from '../server/agent/sandbox-factory.ts';
import { detectCommands, TOOLS_VERSION } from '../server/agent/tools.ts';
import { Workspace } from '../server/agent/workspace.ts';
import { createScriptedProvider, tool } from '../tests/helpers/scripted-model.ts';

async function main() {
  const { values } = parseArgs({ options: { sandbox: { type: 'string', default: 'auto' }, only: { type: 'string' }, tasks: { type: 'string', default: 'evals/agent/tarefas.json' }, out: { type: 'string' } } });
  const suiteFile = resolve(values.tasks!);
  const dir = dirname(suiteFile);
  const suite = JSON.parse(await readFile(suiteFile, 'utf8')) as { version: number; tasks: (AgentTask & { id: string; project: string })[] };
  const refs = JSON.parse(await readFile(join(dir, 'referencia/solucoes.json'), 'utf8')) as { suiteVersion: number; solutions: Record<string, { steps: { tool: string; args: unknown }[]; summary: string }> };
  if (refs.suiteVersion !== suite.version) throw new Error(`Referências da suite v${refs.suiteVersion}, suite v${suite.version}.`);
  const { sandbox, verdict } = await selectSandbox(values.sandbox as SandboxChoice);
  console.log(`Sandbox: ${sandbox.name} · isolamento VERIFICADO: ${verdict.level.toUpperCase()} · suite v${suite.version} · ferramentas v${TOOLS_VERSION}`);
  const only = values.only?.split(',');
  const out: unknown[] = [];
  let bad = 0;
  for (const t of suite.tasks.filter((x) => !only || only.includes(x.id))) {
    const ref = refs.solutions[t.id];
    if (!ref) { console.log(`✘ ${t.id}: sem referência`); bad++; continue; }
    const ws = await Workspace.create(join(dir, 'projetos', t.project));
    try {
      const provider = createScriptedProvider([{ text: '1. Aplicar a referência' }, ...ref.steps.map((s) => tool(s.tool, s.args)), tool('finish', { summary: ref.summary })]);
      const report = await runAgent({
        provider, model: { id: 'referencia', label: 'Solução de referência', hosting: 'simulated' }, workspace: ws, sandbox, verdict,
        trust: 'untrusted', holdoutRoot: join(dir, 'holdout'), commands: await detectCommands(ws.root),
        task: { goal: t.goal, criteria: t.criteria, ...(t.allowedTools ? { allowedTools: t.allowedTools } : {}), ...(t.forbiddenActions ? { forbiddenActions: t.forbiddenActions } : {}) } as AgentTask,
        limits: { maxIterations: 10 },
      });
      const o = classifyOutcome(report);
      const exec = report.criteria.filter((c) => c.passed).length;
      const ok = o.outcome === 'success' && report.quality.every((q) => q.passed) && report.metrics.toolErrors === 0;
      if (!ok) bad++;
      console.log(`${ok ? '✔' : '✘'} ${t.id.padEnd(26)} ${o.outcome.padEnd(14)} exec=${exec}/${report.criteria.length} qual=${report.quality.filter((q) => q.passed).length}/${report.quality.length} erros-ferramenta=${report.metrics.toolErrors}`);
      out.push({ id: t.id, outcome: o, status: report.status, stopReason: report.stopReason, criteria: report.criteria, quality: report.quality, metrics: report.metrics, changedFiles: report.changedFiles });
    } finally {
      await ws.dispose();
    }
  }
  if (values.out) await writeFile(values.out, JSON.stringify({ suiteVersion: suite.version, toolsVersion: TOOLS_VERSION, sandbox: sandbox.name, verifiedLevel: verdict.level, results: out }, null, 2));
  process.exitCode = bad ? 1 : 0;
}
main().catch((e: Error) => { console.error(`Erro: ${e.message}`); process.exitCode = 2; });
