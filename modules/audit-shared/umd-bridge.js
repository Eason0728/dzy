/**
 * UMD → ESM 轉接層（docs/plan.md「既有測試怎麼搬」那一節指定的做法）
 *
 * 為什麼需要這一層：
 * 從稽核系統原樣搬過來的 format.js／sampling.js／mock-data.js／ops-checklist.js
 * 是 UMD 寫法——node 裡走 `module.exports`，瀏覽器裡掛到 `window.Xxx`。
 * 它們**刻意不改寫成 ESM**，因為既有測試要用 `require()` 載入它們，
 * 改寫暴露方式等於在搬遷的同時改行為（plan.md 有寫，那是這類工程最典型的翻車點）。
 *
 * 但模組本體是 ES module，`import Format from './format.js'` 在瀏覽器裡會直接失敗：
 *   SyntaxError: The requested module does not provide an export named 'default'
 *
 * 這一層就是那道橋：先 `import` 那些檔讓它們執行（副作用是掛上 window.Xxx），
 * 再把全域上的東西轉成具名匯出給模組用。
 *
 * ⚠ 2026-08-15 踩到的教訓：這個問題**node 測試抓不到**。
 * node 把 .js 當 CommonJS，`require()` 一路正常，15 支測試全綠；
 * 只有真的在瀏覽器打開才會爆。跨執行環境的接縫，一定要在真環境點一次。
 */

import './format.js';
import './sampling.js';
import './mock-data.js';
import './ops-checklist.js';

/**
 * 兩個執行環境走的是 UMD 裡不同的分支，所以要兩邊都撐住：
 *
 * - **瀏覽器**：上面的 `import './format.js'` 把它當 ES module 執行（那個檔沒有
 *   import/export，是合法的 module），`module` 是 undefined → 走 `root.Format = ...`
 *   分支，掛到 window 上。所以直接從全域取得。
 * - **node**：`.js` 被當成 CommonJS，走 `module.exports` 分支，**全域上什麼都沒有**。
 *   所以退而用動態 import 取它的 default（node 對 CJS 的互通就是包成 default）。
 *
 * 2026-08-15 踩到的教訓：第一版只寫了瀏覽器那半，node 測試全爆；
 * 而更早之前只寫了 node 那半（模組直接 `import Format from './format.js'`），
 * 15 支測試全綠、瀏覽器一開就爆。**跨環境的接縫，兩邊都要真的跑過一次。**
 */
const g = typeof window !== 'undefined' ? window : globalThis;

async function resolve(name, path) {
  if (g && g[name]) return g[name];
  const mod = await import(path);
  const value = mod.default || mod[name];
  if (!value) {
    throw new Error(
      `[umd-bridge] 取不到 ${name}（試過全域與 ${path} 的 default）——` +
      '那支 UMD 檔可能沒載入成功，或它的暴露名稱改了'
    );
  }
  return value;
}

export const Format = await resolve('Format', './format.js');
export const Sampling = await resolve('Sampling', './sampling.js');
export const MockData = await resolve('MockData', './mock-data.js');
export const OpsChecklist = await resolve('OpsChecklist', './ops-checklist.js');
