/**
 * modules/ai-help/lib.js — 小幫手管理的共用小工具
 * 規矩（spec §12.4）：問題、答案、who、label 等一律當純文字（textContent／createTextNode），本模組不用 innerHTML。
 */
'use strict';

import { isDryRun } from '../../platform/dryrun.js';

export { isDryRun };

/** 建 DOM：h('div', {class:'x', 'data-role':'y', on:{click:fn}}, ['文字', 子節點...])；字串子項一律是文字節點 */
export function h(tag, attrs, kids) {
  const e = document.createElement(tag);
  const a = attrs || {};
  for (const k of Object.keys(a)) {
    const v = a[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') { for (const ev of Object.keys(v)) e.addEventListener(ev, v[ev]); continue; }
    if (k === 'value') { e.value = v; continue; }
    e.setAttribute(k, v === true ? '' : String(v));
  }
  (Array.isArray(kids) ? kids : (kids === undefined || kids === null ? [] : [kids])).forEach((c) => {
    if (c === undefined || c === null || c === false) return;
    e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  });
  return e;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

const ERR_ZH = {
  not_inited: '小幫手還沒初始化，請系統管理者先按「初始化小幫手」',
  unauthorized: '請重新登入',
  forbidden: '沒有權限',
  bad_request: '資料格式不對',
  not_found: '找不到這一筆',
  conflict: '這一題已經被別人改過，請重新整理再改',
  busy: '系統忙碌，請稍後再試'
};

/** 錯誤回應 → 給人看的字（platform 的 {error:code, data:{message}}、svc client 的 {error:中文}、api 的 {error:string} 都收） */
export function errText(r) {
  if (!r) return '連不上伺服器，請稍後再試';
  const m = (r.data && typeof r.data.message === 'string' && r.data.message) || (typeof r.message === 'string' && r.message) || '';
  if (m) return m;
  const e = typeof r.error === 'string' ? r.error : '';
  return ERR_ZH[e] || e || '發生錯誤';
}

/** 台北今天 YYYY-MM-DD */
export function taipeiDay(ms) {
  const t = new Date((ms === undefined ? Date.now() : ms) + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
}

export const pct = (x) => (typeof x === 'number' && isFinite(x) ? Math.round(x * 1000) / 10 + '%' : '—');

/** 頁面選項（從 registry 的 manifest 讀；讀不到就空，編輯器退回純文字輸入）。結果快取 */
let pagesCache = null;
export async function loadPages() {
  if (pagesCache) return pagesCache;
  const out = [];
  try {
    const reg = await import('../../platform/registry.js');
    for (const entry of reg.MODULES) {
      let mod;
      try { mod = await entry.load(); } catch (e) { continue; }
      const m = mod && mod.default;
      if (!m || !Array.isArray(m.views)) continue;
      out.push({ m: String(m.id), v: '', label: String(m.name) + '（整個模組）' });
      m.views.forEach((v) => out.push({ m: String(m.id), v: String(v.id), label: String(m.name) + '・' + String(v.name) }));
    }
  } catch (e) { /* 沒有就空 */ }
  pagesCache = out;
  return out;
}

/** m,v → 中文頁名（沒有就顯示代碼；m 空＝通用） */
export function pageLabel(pages, m, v) {
  if (!m) return '通用（不限頁面）';
  const hit = pages.find((p) => p.m === m && p.v === (v || ''));
  return hit ? hit.label : (m + (v ? '/' + v : ''));
}

/** 慢動作按鈕：按下去顯示「文字…」，完成還原 */
export function busyBtn(btn, text) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = text + '…';
  return (enable = true) => { btn.textContent = orig; btn.disabled = !enable; };
}

/** 寫入鈕在試跑模式要鎖住 */
export function lockIfDryrun(btn) {
  if (isDryRun()) { btn.disabled = true; btn.setAttribute('title', '試跑模式：不能寫入'); btn.setAttribute('data-dryrun-locked', '1'); }
  return btn;
}

const STYLE = `
.aim-wrap{max-width:960px}
.aim-top{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.aim-chip{display:inline-block;padding:3px 10px;border-radius:999px;font-size:13px;background:var(--ok-light);color:var(--ok)}
.aim-chip.is-paused{background:var(--warn-light);color:var(--warn)}
.aim-chip.is-off{background:var(--line);color:var(--muted)}
.aim-item{border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;margin:8px 0;background:var(--card);min-width:0}
.aim-q{font-weight:700;white-space:pre-wrap;overflow-wrap:anywhere}
.aim-a{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
.aim-meta{font-size:13px;color:var(--muted);margin:4px 0;overflow-wrap:anywhere}
.aim-act{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.aim-edit{border-top:1px dashed var(--line);margin-top:10px;padding-top:10px}
.aim-edit .field{margin-bottom:10px}
.aim-filter{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}
.aim-filter .input{flex:1 1 160px;min-width:0}
.aim-hist{margin-top:8px;border-left:3px solid var(--line);padding-left:10px}
.aim-hist-row{padding:6px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.aim-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.aim-stat{border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;background:var(--card)}
.aim-stat b{display:block;font-size:22px}
.aim-bar{height:10px;background:var(--line);border-radius:5px;overflow:hidden;margin-top:6px}
.aim-bar i{display:block;height:100%;background:var(--brand)}
.aim-day{display:flex;align-items:center;gap:8px;font-size:13px;margin:2px 0}
.aim-day span:first-child{flex:none;width:92px;color:var(--muted)}
.aim-day .aim-bar{flex:1 1 auto;margin:0}
.aim-note{color:var(--muted);font-size:13px}
@media (max-width:640px){.aim-act .btn{flex:1 1 auto}}
`;

export function addStyle(el) {
  el.appendChild(h('style', null, STYLE));
}
