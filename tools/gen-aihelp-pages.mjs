// node tools/gen-aihelp-pages.mjs —— 產生 apps-script/platform/AiHelpPages.gs（AI 小幫手的頁面地圖 AIH_PAGES）
// 來源：platform/registry.js 各模組 manifest；每個分頁一列 {m, v, name, view_name, dept, requires_module, requires}。
//   m＝模組 id、v＝分頁 id、name＝模組中文名、view_name＝分頁中文名、dept＝部門代碼（沒有就空字串）、
//   requires_module＝模組層 requires、requires＝分頁層 requires；殼是兩者都要通過（isModulePermitted ∧ isViewPermitted），空陣列＝通過，否則任一碼即可。
// 加／改／刪模組或分頁後要重跑；test/ai-help.mock.test.mjs 會比對產物＝現行 registry（忘了重產就紅）。
// 用法：node tools/gen-aihelp-pages.mjs [--check]   --check 只比對、不寫檔（不一致結束碼 1）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_FILE = path.join(ROOT, 'apps-script', 'platform', 'AiHelpPages.gs');

/** 讀 registry → 頁面地圖陣列（順序＝registry 順序、分頁順序） */
export async function buildPages(registryPath) {
  const reg = await import(pathToFileURL(registryPath || path.join(ROOT, 'platform', 'registry.js')).href);
  const pages = [];
  for (const entry of reg.MODULES) {
    const mod = await entry.load();
    const m = mod && mod.default;
    if (!m || !Array.isArray(m.views)) continue;
    for (const v of m.views) {
      pages.push({
        m: String(m.id),
        v: String(v.id),
        name: String(m.name),
        view_name: String(v.name),
        dept: m.dept ? String(m.dept) : '',
        requires_module: Array.isArray(m.requires) ? m.requires.map(String) : [],
        requires: Array.isArray(v.requires) ? v.requires.map(String) : []
      });
    }
  }
  return pages;
}

/** 頁面地圖 → .gs 全文（一列一頁，方便 diff） */
export function renderSource(pages) {
  return [
    '/**',
    ' * AI 小幫手頁面地圖（AIH_PAGES）—— ⚠ 產生物，不要手改。',
    ' * 重產：node tools/gen-aihelp-pages.mjs（讀 platform/registry.js 各 manifest）；test/ai-help.mock.test.mjs 會比對。',
    ' * requires_module＋requires：模組層與分頁層都要通過（空＝通過；否則任一碼即可），同前端殼。',
    ' */',
    'var AIH_PAGES = [',
    pages.map((p) => '  ' + JSON.stringify(p)).join(',\n'),
    '];',
    ''
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pages = await buildPages();
  const src = renderSource(pages);
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
    if (cur !== src) { console.error('AiHelpPages.gs 與 registry 不一致，請重跑 node tools/gen-aihelp-pages.mjs'); process.exit(1); }
    console.log('AiHelpPages.gs 與 registry 一致');
  } else {
    fs.writeFileSync(OUT_FILE, src);
    console.log('已寫入 ' + path.relative(ROOT, OUT_FILE) + '（' + pages.length + ' 頁）');
  }
}
