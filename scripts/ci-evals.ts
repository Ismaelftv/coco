/**
 * Avaliações DEMORADAS dos agentes, em local, separadas da CI normal.
 *
 *   npm run ci:evals -- --model qwen25-coder-7b-cmp --mode prompted --only corrigir-bug          (só mostra o plano)
 *   npm run ci:evals -- --model qwen25-coder-7b-cmp --mode prompted --only corrigir-bug --yes    (executa)
 *
 * Sem --yes NÃO executa nada. Com --yes: verifica a sandbox em contentor (imagem fixada por digest),
 * o Ollama local e o modelo instalado; corre primeiro a verificação de referência (barata, sem modelo)
 * e só depois a avaliação. O código dos projetos avaliados corre SEMPRE no contentor; este script recusa
 * qualquer outro nível de sandbox. Não descarrega modelos (usa `ollama pull` à mão) e não usa APIs pagas.
 * Resultados: resultados-local/evals/<data>-<commit>/ (agentes.json, agentes.txt, proveniencia.json).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const a = { model: '', mode: 'prompted', only: '', repeat: '1', temperature: '', seedBase: '', maxIt: '15', maxWall: '1800', config: 'config/models.compare.json', yes: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i]!; const v = () => argv[++i] ?? '';
  if (k === '--model') a.model = v(); else if (k === '--mode') a.mode = v(); else if (k === '--only') a.only = v();
  else if (k === '--repeat') a.repeat = v(); else if (k === '--temperature') a.temperature = v(); else if (k === '--seed-base') a.seedBase = v();
  else if (k === '--max-iterations') a.maxIt = v(); else if (k === '--max-wall-seconds') a.maxWall = v(); else if (k === '--config') a.config = v();
  else if (k === '--yes') a.yes = true;
  else { console.error(`argumento desconhecido: ${k}`); process.exit(64); }
}
const fail = (msg: string, code = 2): never => { console.error(`✗ ${msg}`); process.exit(code); };
const sh = (c: string, args: string[], t = 20_000) => { const r = spawnSync(c, args, { cwd: ROOT, encoding: 'utf8', timeout: t }); return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }; };

const catalog = JSON.parse(readFileSync(join(ROOT, a.config), 'utf8')) as { models: { id: string; upstreamModel: string }[] };
if (!a.model) fail(`indica --model (${catalog.models.map((m) => m.id).join(', ')})`, 64);
const entry = catalog.models.find((m) => m.id === a.model) ?? fail(`modelo "${a.model}" não existe em ${a.config}`, 64);
if (!['native', 'prompted'].includes(a.mode)) fail('--mode deve ser native|prompted', 64);
const tasks = (JSON.parse(readFileSync(join(ROOT, 'evals/agent/tarefas.json'), 'utf8')) as { tasks: unknown[] }).tasks?.length ?? 0;
const nTasks = a.only ? a.only.split(',').length : tasks;
const runs = nTasks * Number(a.repeat);
const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';

console.log(`Plano: modelo ${entry.id} (${entry.upstreamModel}), modo ${a.mode}, ${nTasks} tarefa(s) × ${a.repeat} repetição(ões) = ${runs} execução(ões)`);
console.log(`Limites: ${a.maxIt} iterações e ${a.maxWall} s por execução → no máximo ~${Math.ceil((runs * Number(a.maxWall)) / 60)} min só em CPU (medido: 14–30 min por execução em modelos 4B–7B sem GPU).`);
if (!a.yes) { console.log('\nNADA FOI EXECUTADO. Acrescenta --yes para correr (é caro: usa CPU/RAM durante muito tempo).'); process.exit(0); }

// ── pré-requisitos ──
if (sh('docker', ['info', '--format', '{{.ServerVersion}}']).code !== 0) fail('Docker indisponível: a avaliação exige sandbox em contentor.');
const pinned = readFileSync(join(ROOT, 'config/sandbox-image.txt'), 'utf8').trim();
const image = process.env.FORJA_SANDBOX_IMAGE ?? pinned;
if (sh('docker', ['image', 'inspect', image]).code !== 0 && sh('docker', ['pull', image], 300_000).code !== 0) fail(`imagem do sandbox ${image} indisponível.`);
const tags = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json() as Promise<{ models: { name: string; digest: string }[] }>).catch(() => null);
if (!tags) fail(`Ollama não responde em ${OLLAMA} (arranca com \`ollama serve\`).`);
const installed = tags!.models.find((m) => m.name === entry.upstreamModel) ?? fail(`modelo ${entry.upstreamModel} não instalado: corre \`ollama pull ${entry.upstreamModel}\`.`);
const version = await fetch(`${OLLAMA}/api/version`).then((r) => r.json() as Promise<{ version: string }>).then((j) => j.version).catch(() => 'desconhecida');

const commit = sh('git', ['rev-parse', 'HEAD']).out;
const dirty = sh('git', ['status', '--porcelain']).out.split('\n').filter(Boolean).length;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const out = resolve(ROOT, 'resultados-local', 'evals', `${stamp}-${commit.slice(0, 7)}${dirty ? '-dirty' : ''}-${a.model}-${a.mode}`);
mkdirSync(out, { recursive: true });
const env = { ...process.env, FORJA_SANDBOX_REQUIRE_DIGEST: image === pinned ? '1' : '', FORJA_SANDBOX_IMAGE: image, OLLAMA_URL: OLLAMA };

const exec = (name: string, args: string[]) => new Promise<number | null>((res) => {
  const log = createWriteStream(join(out, `${name}.txt`));
  const c = spawn('npx', ['tsx', ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', (b) => { log.write(b); process.stdout.write(b); }); c.stderr.on('data', (b) => { log.write(b); process.stderr.write(b); });
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.once(s, () => c.kill('SIGTERM'));
  c.on('close', (code) => log.end(() => res(code)));
});

console.log('\n▶ 1/2 verificação de referência (sem modelo)');
const refCode = await exec('referencia', ['scripts/agent-reference.ts', '--sandbox', 'container', ...(a.only ? ['--only', a.only] : []), '--out', join(out, 'referencia.json')]);
if (refCode !== 0) { writeFileSync(join(out, 'proveniencia.json'), JSON.stringify({ abortado: 'a verificação de referência falhou; a avaliação do modelo não foi executada', refCode, commit }, null, 2)); fail('a verificação de referência falhou: o instrumento não é fiável; avaliação NÃO executada.', 1); }

console.log('\n▶ 2/2 avaliação do modelo');
const ram: number[] = [];
const sample = () => { const m = readFileSync('/proc/meminfo', 'utf8'); const g = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(m)?.[1] ?? 0); ram.push(Math.round((g('MemTotal') - g('MemAvailable')) / 1024)); };
const timer = setInterval(() => { try { sample(); } catch { /* sem /proc */ } }, 5000);
const t0 = Date.now();
const evalCode = await exec('agentes', ['scripts/agent-eval.ts', '--config', a.config, '--model', a.model, '--mode', a.mode, '--sandbox', 'container',
  '--repeat', a.repeat, '--max-iterations', a.maxIt, '--max-wall-seconds', a.maxWall,
  ...(a.only ? ['--only', a.only] : []), ...(a.temperature ? ['--temperature', a.temperature] : []), ...(a.seedBase ? ['--seed-base', a.seedBase] : []), '--out', join(out, 'agentes.json')]);
clearInterval(timer);
writeFileSync(join(out, 'proveniencia.json'), JSON.stringify({
  origem: 'LOCAL (não é CI do GitHub)', commit, dirty: dirty > 0, codigoDeSaidaAvaliacao: evalCode, duracaoMs: Date.now() - t0,
  modelo: { id: a.model, upstream: entry.upstreamModel, digest: installed.digest, modo: a.mode }, ollama: version,
  sandbox: { imagem: image, fixadaPorDigest: image === pinned },
  hardware: { cpu: cpus()[0]?.model, nucleos: cpus().length, ramTotalMB: Math.round(totalmem() / 1048576) }, picoRamUsadaMB: ram.length ? Math.max(...ram) : null,
  nota: 'RAM = pico do sistema inteiro (amostras de 5 s), não só do Ollama. O hardware local difere do da CI: não misturar durações.',
  ficheiros: readdirSync(out),
}, null, 2));
console.log(`\nResultados em ${out}`);
process.exit(evalCode === 0 ? 0 : 1);
