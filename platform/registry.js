/**
 * 模組清單 —— 整個系統唯一「知道有哪些模組存在」的地方。
 *
 * ★ 加一支新系統進來，規定只能改這個檔（新增下面陣列裡的一列），
 *   platform/ 底下其他檔案一行都不該動。這條就是 docs/spec.md §6.1 的驗收標準。
 *   如果你發現「不改別的檔就加不進來」，那是分層破了，回頭修架構，不要在別處補洞。
 *
 * 每一列的格式：
 *   { load: () => import('<manifest.js 的相對路徑>') }
 *
 * 順序＝首頁卡片與導覽列的顯示順序。
 * 這裡只載入 manifest（很輕）；模組本體要等使用者真的點進去，才由 manifest.entry() 載入。
 */

export const MODULES = [
  { load: () => import('../modules/users/manifest.js') },
  { load: () => import('../modules/audit-stock/manifest.js') },
  { load: () => import('../modules/audit-ops/manifest.js') },
  // Phase 2 加入：
  // { load: () => import('../modules/audit-ops/manifest.js') },
  // { load: () => import('../modules/audit-stock/manifest.js') },
  // Phase 3 加入：
  // { load: () => import('../modules/dorm/manifest.js') },
];

/**
 * 逐一載入所有 manifest，驗證後回傳合格的清單。
 * 單一模組載入失敗或驗證不過 → 只有那個模組不上架，其他照常
 *（一個模組寫壞不該讓整個系統開不起來）。
 */
export async function loadManifests(reportManifest) {
  const out = [];
  for (const [i, entry] of MODULES.entries()) {
    let mod;
    try {
      mod = await entry.load();
    } catch (err) {
      console.error(`[registry] 第 ${i + 1} 個模組載入失敗，已略過：${err && err.message}`);
      continue;
    }
    const manifest = mod && mod.default;
    if (!reportManifest(manifest, `registry[${i}]`)) continue;
    out.push(manifest);
  }
  return out;
}
