#!/usr/bin/env node
/**
 * 算出每個模組需要哪些程式檔，產生 platform/preload-map.js，並更新 index.html 的預載區塊。
 * 用法：node tools/gen-preload.mjs（新增模組或改 import 後跑一次；test/preload-map.test.mjs 會提醒）
 * 忘了跑也不會壞畫面，只是少了加速。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_IMPORT = /(?:^|[;\n}])\s*(?:(?:import|export)\s+[\w$*{},\s]*?from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const BEGIN = '<!-- preload:begin 由 tools/gen-preload.mjs 產生，不要手改 -->';
const END = '<!-- preload:end -->';

function closure(entries) {
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel) || !fs.existsSync(path.join(ROOT, rel))) return;
    seen.add(rel);
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(STATIC_IMPORT)) walk(path.posix.join(path.posix.dirname(rel), m[1]));
  };
  entries.forEach(walk);
  return seen;
}

export function build() {
  const registry = fs.readFileSync(path.join(ROOT, 'platform/registry.js'), 'utf8');
  const manifests = [...registry.matchAll(/import\('\.\.\/(modules\/[^']+\/manifest\.js)'\)/g)].map((m) => m[1]);
  const core = closure(['platform/shell.js', ...manifests]);
  const map = {};
  for (const manifest of manifests) {
    const id = path.posix.basename(path.posix.dirname(manifest));
    map[id] = [...closure([path.posix.join(path.posix.dirname(manifest), 'index.js')])].filter((f) => !core.has(f)).sort();
  }
  const mapText = '// 由 tools/gen-preload.mjs 產生，不要手改。模組代號 → 該模組本體要用到、殼還沒載入的程式檔。\n'
    + 'export const PRELOAD = ' + JSON.stringify(map, null, 1) + ';\n';
  const links = [...core].sort().map((f) => `  <link rel="modulepreload" href="${f}">`).join('\n');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const block = `  ${BEGIN}\n${links}\n  ${END}\n`;
  const nextHtml = html.includes(BEGIN)
    ? html.replace(new RegExp(`  ${BEGIN}[\\s\\S]*?${END}\\n`), () => block)
    : html.replace('</head>', () => block + '</head>');
  return { mapText, nextHtml };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { mapText, nextHtml } = build();
  fs.writeFileSync(path.join(ROOT, 'platform/preload-map.js'), mapText);
  fs.writeFileSync(path.join(ROOT, 'index.html'), nextHtml);
  console.log('preload 清單已更新');
}
