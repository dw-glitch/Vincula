import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist-cloudflare');
const required = [
  'index.html', 'styles.css', 'deployment-meta.json',
  'lib/jszip.min.js', 'src/core/analyzer.js', 'src/core/applier.js',
  'src/ui/app.js', 'src/ui/conference-source.js',
  'src/workers/ld-worker.js', 'src/workers/pool.js'
];

for (const relative of required) {
  await access(path.join(output, relative));
  const details = await stat(path.join(output, relative));
  if (!details.isFile() || details.size === 0) throw new Error('Arquivo inválido: ' + relative);
}
const html = await readFile(path.join(output, 'index.html'), 'utf8');
const assetRefs = [...html.matchAll(/(?:src|href)=["']([^"'#]+)["']/gi)]
  .map(match => match[1]).filter(ref => !/^(?:data:|https?:|mailto:|javascript:|\/\/)/i.test(ref));
for (const ref of assetRefs) {
  const clean = ref.split('?')[0].replace(/^\/+/, '');
  if (!clean || clean.includes('..')) throw new Error('Referência inválida: ' + ref);
  await access(path.join(output, clean));
}
const forbidden = ['.git', '.github', 'tests', 'docs', '.env', '.dev.vars', 'vercel.json', 'package.json', 'wrangler.jsonc'];
const top = await readdir(output);
for (const name of forbidden) {
  if (top.includes(name)) throw new Error('Conteúdo interno não pode ser publicado: ' + name);
}
const metadata = JSON.parse(await readFile(path.join(output, 'deployment-meta.json'), 'utf8'));
if (metadata.application !== 'vincula' || metadata.platform !== 'cloudflare-workers') {
  throw new Error('Metadados de publicação inválidos.');
}
console.log('Vincula: pacote Cloudflare validado; scripts, Web Workers e referências locais preservados.');
