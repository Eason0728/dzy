/**
 * platform/tabs.js — 動態分頁（2026-10-20，Eason：門市營運的選單要跟模組名在同一列，且依人依店不同、帶待辦數字）
 *
 * manifest 選填 dynamicTabs: true 的模組，ctx 多一個 tabs(list)：模組把「這個人此刻有的分頁」交給殼，殼畫在頁頂分頁列。
 * 權限仍由 manifest.views[0].requires 守（進得了模組＝每個動態分頁都看得到；分頁內容該不該給，是被嵌入系統自己的事）。
 * 本檔是純函式（node 測試直接 import）：只收乾淨的資料，其他一律丟掉，不信任模組（模組資料多半來自 iframe）。
 */
'use strict';

export const TAB_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const TABS_MAX = 20;
const NAME_MAX = 12;

/** list → [{id, name, badge, err}]；整個不合格回 null（殼就不更新）。重複 id 只留第一個。 */
export function sanitizeTabs(list) {
  if (!Array.isArray(list) || list.length > TABS_MAX) return null;
  const out = [];
  const seen = new Set();
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const id = t.id;
    if (typeof id !== 'string' || !TAB_ID_RE.test(id) || seen.has(id)) continue;
    const name = typeof t.name === 'string' ? t.name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
    if (!name) continue;
    const n = Number(t.badge);
    const badge = Number.isInteger(n) && n > 0 ? Math.min(n, 999) : 0;
    seen.add(id);
    out.push({ id, name, badge, err: t.err === true });
  }
  return out;
}

/** 動態分頁模組的目前分頁：網址上的（合格才收）→ 已知第一個分頁 → manifest 第一個分頁 */
export function pickDynamicView(viewId, tabs, fallbackId) {
  if (typeof viewId === 'string' && TAB_ID_RE.test(viewId)) return viewId;
  if (Array.isArray(tabs) && tabs.length) return tabs[0].id;
  return fallbackId;
}
