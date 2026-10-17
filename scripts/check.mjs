import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const dir of ['web', 'server', 'scripts', 'tests']) for (const file of await readdir(new URL(`../${dir}/`, import.meta.url))) {
  if (!/\.(m?js)$/.test(file)) continue;
  const r = spawnSync(process.execPath, ['--check', `${root}${dir}/${file}`], { stdio: 'inherit' });
  if (r.status) process.exit(r.status);
}
console.log('JavaScript 语法检查通过。');
