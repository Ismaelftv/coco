/**
 * Executa o agente de programação sobre uma CÓPIA de um projeto local.
 * O projeto original nunca é alterado: o resultado é um patch (git diff) e um
 * relatório com evidências (comandos, códigos de saída, critérios).
 *
 * Uso:
 *   npm run agent -- --config config/models.json --model qwen3-4b-local \
 *     --project ./meu-projeto --goal "Corrige o teste que falha em src/x.test.js" \
 *     [--test-cmd "npm test"] [--mode native|prompted] [--max-iterations 30] \
 *     [--patch alteracoes.patch] [--out relatorio.json]
 *
 * Operações que exigem confirmação (apagar, ficheiros sensíveis) são perguntadas
 * no terminal; sem terminal interativo são recusadas.
 */
import { createInterface } from 'node:readline/promises';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runAgent, describeCriterion, type AgentEvent, type SuccessCriterion } from '../server/agent/loop.ts';
import { ProcessSandbox } from '../server/agent/sandbox.ts';
import { detectCommands, type CommandSpec, type ConfirmationRequest } from '../server/agent/tools.ts';
import { Workspace } from '../server/agent/workspace.ts';
import { loadCatalog } from '../server/providers/catalog.ts';
import { createModelRegistry } from '../server/providers/registry.ts';

export function printEvent(e: AgentEvent): void {
  switch (e.type) {
    case 'plan':
      console.log(`\n── plano ──\n${e.text}\n`);
      break;
    case 'model_text':
      if (e.text.trim()) console.log(`  · ${e.text.trim().replace(/\s+/g, ' ').slice(0, 160)}`);
      break;
    case 'tool_start':
      console.log(`[${e.iteration}] → ${e.call.name} ${JSON.stringify(e.call.arguments).slice(0, 160)}`);
      break;
    case 'tool_end':
      console.log(`      ${e.output.ok ? 'ok' : `erro (${e.output.errorCode})`}${e.output.command ? ` · código ${e.output.command.exitCode}` : ''} · ${e.output.content.split('\n')[0]!.slice(0, 120)}`);
      break;
    case 'confirmation':
      console.log(`      confirmação ${e.granted ? 'CONCEDIDA' : 'RECUSADA'}: ${e.request.reason}`);
      break;
    case 'criteria':
      for (const r of e.results) console.log(`  ${r.passed ? '✔' : '✘'} ${describeCriterion(r.criterion)} — ${r.evidence.split('\n')[0]}`);
      break;
    case 'stop':
      console.log(`\n── fim: ${e.reason} ──`);
      break;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      model: { type: 'string' },
      project: { type: 'string' },
      goal: { type: 'string' },
      'test-cmd': { type: 'string' },
      mode: { type: 'string' },
      'max-iterations': { type: 'string', default: '30' },
      patch: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!values.config || !values.model || !values.project || !values.goal) {
    throw new Error('Indica --config, --model, --project e --goal.');
  }
  const registry = createModelRegistry({ catalog: await loadCatalog(values.config), log: (l) => console.error(l) });
  await registry.refresh();
  const model = registry.models.find((m) => m.id === values.model);
  if (!model) throw new Error(`Modelo "${values.model}" não existe no catálogo.`);
  if (model.status === 'offline') throw new Error(`Modelo indisponível: ${model.statusDetail}`);

  const ws = await Workspace.create(values.project);
  const sandbox = new ProcessSandbox();
  let commands: CommandSpec[] = await detectCommands(ws.root);
  if (values['test-cmd']) {
    const argv = values['test-cmd'].split(/\s+/).filter(Boolean);
    commands = [{ name: 'test', argv, description: `Executa os testes (${argv.join(' ')})` }];
  }
  const criteria: SuccessCriterion[] = commands.some((c) => c.name === 'test') ? [{ type: 'command', name: 'test' }] : [];

  console.log(`Modelo: ${model.label}${model.author ? ` (${model.author}, ${model.license})` : ''}`);
  console.log(`Espaço de trabalho (cópia): ${ws.root}`);
  if (ws.omitted.length) console.log(`Ficheiros sensíveis não copiados: ${ws.omitted.join(', ')}`);
  console.log(`Isolamento: rede ${sandbox.isolation.network}, utilizador ${sandbox.isolation.user}, limites ${sandbox.isolation.resourceLimits ? 'sim' : 'não'}`);
  for (const n of sandbox.isolation.notes) console.log(`  aviso: ${n}`);
  if (criteria.length === 0) console.log('Aviso: sem comando de testes, o sucesso não pode ser verificado pelo sistema.');

  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const confirm = async (r: ConfirmationRequest) => {
    if (!rl) return false;
    const answer = await rl.question(`\n⚠ ${r.reason}\n${r.details}\nAutorizar? [s/N] `);
    return /^s(im)?$/i.test(answer.trim());
  };

  try {
    const report = await runAgent({
      provider: registry,
      model: { id: model.id, label: model.label, author: model.author ?? undefined, license: model.license ?? undefined, hosting: model.hosting },
      workspace: ws,
      sandbox,
      commands,
      task: { goal: values.goal, criteria },
      ...(values.mode === 'native' || values.mode === 'prompted' ? { toolCalling: values.mode } : {}),
      limits: { maxIterations: Number(values['max-iterations']) },
      confirm,
      onEvent: printEvent,
    });
    console.log(`\nEstado: ${report.status === 'succeeded' ? 'CONCLUÍDO (critérios verificados)' : 'NÃO CONCLUÍDO'} · ${report.metrics.iterations} iterações · ${report.metrics.toolCalls} ferramentas · ${Math.round(report.metrics.wallMs / 1000)} s`);
    console.log(`Ficheiros alterados: ${report.changedFiles.map((f) => `${f.status} ${f.path}`).join(', ') || 'nenhum'}`);
    if (report.summary) console.log(`Resumo do modelo (não verificado por si só):\n${report.summary}`);
    if (values.patch) await writeFile(values.patch, report.diff);
    if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2));
    if (!values.patch && report.diff) console.log(`\n${report.diff.slice(0, 6000)}`);
    process.exitCode = report.status === 'succeeded' ? 0 : 1;
  } finally {
    rl?.close();
    await ws.dispose();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: Error) => {
    console.error(`Erro: ${e.message}`);
    process.exitCode = 2;
  });
}
