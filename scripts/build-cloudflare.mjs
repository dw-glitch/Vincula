import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist-cloudflare');
const publicFiles = ['index.html', 'styles.css', 'assets', 'lib', 'src'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const relative of publicFiles) {
  await cp(path.join(root, relative), path.join(output, relative), {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: false
  });
}

const html = await readFile(path.join(output, 'index.html'), 'utf8');
if (!html.includes('Vincula') || !html.includes('src/workers/pool.js')) {
  throw new Error('Pacote Vincula incompleto: página ou Web Workers ausentes.');
}

// Builds do Workers Builds disparados por deploy hook trazem o nome do branch
// em WORKERS_CI_COMMIT_SHA; a revisão publicada precisa ser o hash real.
const isSha = (value) => /^[0-9a-f]{40}$/i.test(value || '');
function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
}
const revision = [process.env.VINCULA_COMMIT_SHA, process.env.WORKERS_CI_COMMIT_SHA, process.env.GITHUB_SHA, gitHead()]
  .find(isSha) || 'local';
const build = {
  application: 'vincula',
  platform: 'cloudflare-workers',
  revision,
  generatedAt: new Date().toISOString()
};
await writeFile(path.join(output, 'deployment-meta.json'), JSON.stringify(build, null, 2) + '\n');
console.log('Vincula: pacote estático isolado gerado em dist-cloudflare/ (' + revision + ').');
