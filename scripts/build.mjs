import { cp, mkdir, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { buildMmpkg } from '../../plugin-open-platform/PhoneSDK/tools/build-mmpkg.mjs';
import { DEFAULT_GATEWAY } from '../web/config.js';
import { normalizeBackend } from '../web/network.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = resolve(root, '../plugin-open-platform');
const dist = join(root, 'dist');
let profile;
try { profile = JSON.parse(await readFile(join(root, '.env.connection.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('本机连接配置无法读取；已取消构建，不输出私密内容。'); }
const gateway = normalizeBackend(process.env.WENQUAN_GATEWAY_URL || profile?.gateway || DEFAULT_GATEWAY, true);
let token = '';
if (profile && normalizeBackend(profile.gateway, true) === gateway) {
  if (typeof profile.accessCode !== 'string' || profile.accessCode.length < 32 || profile.accessCode.length > 256) throw new Error('本机设备访问码无效，已取消构建。');
  token = profile.accessCode;
}
await mkdir(dist, { recursive: true });
// dist 是本工程生成目录；保留源文件和用户配置。
for (const file of await readdir(dist)) await rm(join(dist, file), { recursive: true, force: true });
await cp(join(root, 'web'), dist, { recursive: true });
await writeFile(join(dist, 'config.js'), `export const DEFAULT_GATEWAY = ${JSON.stringify(gateway)};\nexport const DEFAULT_GATEWAY_TOKEN = ${JSON.stringify(token)};\n`, { mode: 0o600 });
await mkdir(join(dist, 'vendor'), { recursive: true });
await cp(join(sdk, 'PhoneSDK/examples/life-desk/vendor/gm-plugin-web-sdk.esm.js'), join(dist, 'vendor/gm-plugin-web-sdk.esm.js'));
const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
const filename = `wenquan-${manifest.version}.mmpkg`;
await mkdir(join(root, 'release'), { recursive: true });
await buildMmpkg(dist, join(root, 'release', filename));
// 放到官方扫描层级，保持“问全”仓库为唯一编辑源。
const workspace = join(sdk, 'PhoneSDK/examples/wenquan');
await mkdir(workspace, { recursive: true });
await cp(dist, workspace, { recursive: true });
await writeFile(join(workspace, 'README.md'), '# 问全\n\n此目录为自动生成的 Studio 工作区镜像。请编辑 `极米/问全/web`，再运行 `npm run build`。\n');
await cp(join(root, 'release', filename), join(sdk, 'PhoneSDK/dist', filename));
if (token) {
  await chmod(join(root, 'release', filename), 0o600);
  await chmod(join(sdk, 'PhoneSDK/dist', filename), 0o600);
}
console.log(`已构建 ${join(root, 'release', filename)}\nStudio 工作区：${workspace}`);
console.log(token ? '已预置云端连接；此安装包含个人网关访问凭证，请仅供本人使用。' : '未预置设备访问码；安装后需手动配置。');
