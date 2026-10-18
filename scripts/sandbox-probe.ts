/**
 * Diagnóstico do isolamento neste anfitrião: factos do sistema + verificação
 * comportamental de cada sandbox disponível (processo e contentor).
 *
 *   npm run sandbox-probe [-- --json] [--out relatorio.json]
 *
 * Os resultados dependem da máquina: o que vale numa não vale na outra.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ContainerSandbox, detectContainerEngine } from '../server/agent/container-sandbox.ts';
import { collectHostFacts, probeSandbox, type IsolationVerdict } from '../server/agent/isolation.ts';
import { ProcessSandbox, type Sandbox } from '../server/agent/sandbox.ts';

async function main() {
  const { values } = parseArgs({ options: { json: { type: 'boolean', default: false }, out: { type: 'string' }, label: { type: 'string', default: '' } } });
  const facts = await collectHostFacts();
  const sandboxes: { sandbox?: Sandbox; unavailable?: string; name: string }[] = [{ sandbox: new ProcessSandbox(), name: 'process' }];
  const eng = detectContainerEngine();
  if (eng.available) {
    try {
      sandboxes.push({ sandbox: ContainerSandbox.create({ engine: eng.engine, pull: true }), name: `container:${eng.engine}` });
    } catch (e) {
      sandboxes.push({ name: `container:${eng.engine}`, unavailable: (e as Error).message });
    }
  } else sandboxes.push({ name: 'container', unavailable: eng.reason });

  const verdicts: (IsolationVerdict | { sandbox: string; unavailable: string })[] = [];
  for (const s of sandboxes) {
    if (!s.sandbox) {
      verdicts.push({ sandbox: s.name, unavailable: s.unavailable! });
      continue;
    }
    verdicts.push({ ...(await probeSandbox(s.sandbox)), declared: s.sandbox.isolation } as IsolationVerdict);
  }
  const report = { label: values.label, date: new Date().toISOString(), host: facts, verdicts };
  if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2));
  if (values.json) {
    console.log(JSON.stringify(report));
    return;
  }
  console.log('Anfitrião:');
  for (const [k, v] of Object.entries(facts)) console.log(`  ${k.padEnd(34)} ${v}`);
  for (const v of verdicts) {
    if ('unavailable' in v) {
      console.log(`\n${v.sandbox}: INDISPONÍVEL — ${v.unavailable}`);
      continue;
    }
    console.log(`\n${v.sandbox}: nível verificado = ${v.level.toUpperCase()}${v.error ? ` (erro: ${v.error})` : ''}`);
    for (const c of v.checks) console.log(`  ${c.passed ? '✔' : '✘'} [${c.requiredFor.padEnd(7)}] ${c.title} — ${c.evidence}`);
    for (const x of v.contradictions) console.log(`  ⚠ CONTRADIÇÃO: ${x}`);
  }
}

main().catch((e: Error) => {
  console.error(`Erro: ${e.message}`);
  process.exitCode = 2;
});
