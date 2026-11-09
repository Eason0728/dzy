// 預載清單要跟程式一致（過期不會壞畫面，但會少了加速）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from '../tools/gen-preload.mjs';
import { PRELOAD } from '../platform/preload-map.js';

const { mapText, nextHtml } = build();
assert.equal(fs.readFileSync('platform/preload-map.js', 'utf8'), mapText, 'preload-map.js 過期：跑 node tools/gen-preload.mjs');
assert.equal(fs.readFileSync('index.html', 'utf8'), nextHtml, 'index.html 預載區塊過期：跑 node tools/gen-preload.mjs');
for (const [id, files] of Object.entries(PRELOAD)) {
  for (const f of files) assert.ok(fs.existsSync(f), `${id} 指到不存在的檔 ${f}`);
}
const links = [...nextHtml.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
assert.ok(links.includes('platform/shell.js'));
links.forEach((f) => assert.ok(fs.existsSync(f), f));
console.log('preload-map 全部通過');
