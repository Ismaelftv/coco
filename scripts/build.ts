/**
 * Build do frontend com esbuild: bundle com hash no nome, CSS extraído,
 * index.html gerado com as referências finais. `--watch` reconstrói ao gravar.
 */
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const web = join(root, 'apps/web');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');
const production = !watch;

async function writeHtml(metafile: esbuild.Metafile) {
  const outputs = Object.keys(metafile.outputs).map((p) => basename(p));
  const js = outputs.filter((f) => f.endsWith('.js'));
  const css = outputs.filter((f) => f.endsWith('.css'));
  const template = await readFile(join(web, 'index.html'), 'utf8');
  const html = template
    .replace('<!--styles-->', css.map((f) => `<link rel="stylesheet" href="/assets/${f}" />`).join('\n    '))
    .replace('<!--scripts-->', js.map((f) => `<script type="module" src="/assets/${f}"></script>`).join('\n    '));
  await writeFile(join(dist, 'index.html'), html);
}

const htmlPlugin: esbuild.Plugin = {
  name: 'html',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length || !result.metafile) return;
      await writeHtml(result.metafile);
      if (watch) console.log(`[build] ${new Date().toLocaleTimeString('pt-PT')} atualizado`);
    });
  },
};

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'assets'), { recursive: true });
await cp(join(web, 'public'), dist, { recursive: true });

const options: esbuild.BuildOptions = {
  entryPoints: [join(web, 'src/main.tsx')],
  outdir: join(dist, 'assets'),
  entryNames: '[name]-[hash]',
  bundle: true,
  format: 'esm',
  splitting: false,
  target: ['es2022', 'chrome111', 'firefox115', 'safari16.4'],
  jsx: 'automatic',
  minify: production,
  sourcemap: production ? 'linked' : 'inline',
  metafile: true,
  legalComments: 'linked',
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
  logLevel: 'info',
  plugins: [htmlPlugin],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  const result = await esbuild.build(options);
  const sizes = Object.entries(result.metafile!.outputs)
    .filter(([p]) => !p.endsWith('.map') && !p.endsWith('.txt'))
    .map(([p, o]) => `${basename(p)} ${(o.bytes / 1024).toFixed(1)} KB`);
  console.log(`[build] ${sizes.join(' · ')}`);
}
