/**
 * modules/inspection/lib.js — 營運巡檢共用：樣式、草稿、照片上傳／讀取、錯誤訊息
 *
 * 照片：沿用表單簽核的照片庫（<平台主機>/platform/svc/apv-file-put|get，kind receipt，JPEG ≤180KB），
 *   壓縮做法照 modules/approvals/photo.js（模組之間不互相 import，所以複製一份；兩份行為一致）。
 *   上傳拿到檔號，送出巡檢時後端把檔號綁到這筆巡檢；之後誰看得到這筆巡檢、誰就看得到照片。
 * 試跑模式 ?dryrun=1：照片不上傳（回假檔號 F-DRYRUN-…），送出由平台攔下。
 * 草稿：localStorage `dzy.u.<user id>.insp_draft`（只認本人，規矩同稽核草稿）；照片只存檔號。
 */
'use strict';

import { BACKENDS } from '../../platform/config.js';
import { getToken } from '../../platform/auth.js';

export const STYLE = `
.ip-wrap{display:flex;flex-direction:column;gap:14px;max-width:900px}
.ip-note{color:var(--muted);font-size:14px;line-height:1.6}
.ip-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.ip-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ip-tabs{display:flex;gap:6px;flex-wrap:wrap;position:sticky;top:0;z-index:2;background:var(--bg);padding:6px 0}
.ip-tab{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:6px 14px;font-size:15px;cursor:pointer}
.ip-tab.on{background:var(--ink);color:var(--card);border-color:var(--ink)}
.ip-tab .n{font-size:12px;margin-left:4px;color:var(--danger)}
.ip-tab.on .n{color:inherit}
.ip-score{display:flex;gap:10px;flex-wrap:wrap}
.ip-score>div{flex:1;min-width:120px;border:1px solid var(--line);border-radius:var(--radius);background:var(--card);padding:10px 12px}
.ip-score b{display:block;font-size:24px;font-variant-numeric:tabular-nums}
.ip-score small{color:var(--muted)}
.ip-cat{font-weight:700;margin:6px 0 2px}
.ip-item{border:1px solid var(--line);border-radius:var(--radius);background:var(--card);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.ip-item.bad{border-color:var(--danger)}
.ip-text{white-space:pre-wrap;line-height:1.55}
.ip-pts{display:flex;gap:6px;flex-wrap:wrap}
.ip-pt{min-width:42px;height:40px;border:1px solid var(--line);border-radius:8px;background:var(--card);font-size:17px;cursor:pointer;font-variant-numeric:tabular-nums}
.ip-pt.on{background:var(--ink);color:var(--card);border-color:var(--ink)}
.ip-pt.on.low{background:var(--danger);border-color:var(--danger)}
.ip-ev{display:flex;flex-direction:column;gap:6px}
.ip-ev textarea,.ip-ev input[type=text]{width:100%;box-sizing:border-box}
.ip-photos{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ip-thumb{position:relative;width:72px;height:72px;border-radius:8px;overflow:hidden;border:1px solid var(--line);background:var(--bg)}
.ip-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.ip-thumb .x{position:absolute;top:2px;right:2px;width:22px;height:22px;border-radius:50%;border:0;background:rgba(0,0,0,.6);color:#fff;cursor:pointer;line-height:22px;padding:0}
.ip-thumb.busy{display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--muted)}
.ip-bigphotos{display:flex;gap:8px;flex-wrap:wrap}
.ip-bigphotos img{width:160px;height:120px;object-fit:cover;border-radius:8px;border:1px solid var(--line)}
.ip-table td.num,.ip-table th.num{text-align:right;font-variant-numeric:tabular-nums}
.ip-grade{display:inline-block;min-width:1.6em;text-align:center;font-weight:700;border-radius:6px;padding:0 6px;background:var(--bg)}
.ip-grade.g-A,.ip-grade.g-B{color:var(--ok)}
.ip-grade.g-D,.ip-grade.g-E,.ip-grade.g-未達{color:var(--danger)}
.ip-def{border-left:3px solid var(--danger);padding:6px 10px;display:flex;flex-direction:column;gap:4px}
.ip-def small{color:var(--muted)}
.ip-sticky{position:sticky;bottom:0;background:var(--bg);padding:10px 0;border-top:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between}
@media (max-width:640px){.ip-grid2{grid-template-columns:1fr}.ip-pt{min-width:38px}}
`;

export function addStyle(el) {
  const s = document.createElement('style');
  s.textContent = STYLE;
  el.appendChild(s);
}

export function errText(r) {
  if (!r) return '連不上伺服器，請稍後再試';
  if (r.message) return r.message;
  const map = { not_inited: '營運巡檢還沒初始化，請系統管理者先按「初始化營運巡檢」', forbidden: '你沒有權限', not_found: '找不到這筆巡檢',
    busy: '系統忙碌中，請稍後再試', DRYRUN: '試跑模式：沒有真的送出' };
  return map[r.error] || map[r.code] || r.error || '發生錯誤';
}

export function gradeTag(esc, g) {
  if (!g) return '';
  return `<span class="ip-grade g-${esc(g)}">${esc(g === '未評' ? '未評' : g)}</span>`;
}
export const r1 = (n) => (n === null || n === undefined || n === '' ? '—' : String(Math.round(Number(n) * 10) / 10));

export function todayStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
/** 巡檢編號 INS-<時間36進位>-<亂數>（後端 INSP_ID_RE） */
export function newId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return 'INS-' + Date.now().toString(36).toUpperCase() + '-' + s;
}

// ── 草稿（只認本人）──────────────────────────────────
function draftKey(user) { return `dzy.u.${user && user.id ? user.id : 'x'}.insp_draft`; }
export function loadDraft(user) {
  try { const s = localStorage.getItem(draftKey(user)); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
export function saveDraft(user, d) {
  try { localStorage.setItem(draftKey(user), JSON.stringify(d)); return true; } catch (e) { return false; }
}
export function clearDraft(user) {
  try { localStorage.removeItem(draftKey(user)); } catch (e) { /* 無妨 */ }
}

// ── 照片 ─────────────────────────────────────────────
const MAX_EDGE = 1600;
const MAX_BYTES = 180 * 1024;
const QUALITY_STEPS = [0.85, 0.72, 0.6, 0.5, 0.4];

function fitSize(w, h, max) {
  const long = Math.max(w, h);
  if (!(long > 0)) return { w: 0, h: 0 };
  if (long <= max) return { w: Math.round(w), h: Math.round(h) };
  const s = max / long;
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}
async function loadSource(file) {
  if (typeof createImageBitmap === 'function') {
    try { const b = await createImageBitmap(file); return { src: b, w: b.width, h: b.height }; } catch (e) { /* 退回 Image */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error('讀不到圖片')); im.src = url; });
    return { src: img, w: img.naturalWidth, h: img.naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}
async function compress(file) {
  const { src, w: sw, h: sh } = await loadSource(file);
  let { w, h } = fitSize(sw, sh, MAX_EDGE);
  for (let round = 0; round < 4; round++) {
    for (const q of (round === 0 ? QUALITY_STEPS : QUALITY_STEPS.slice(1))) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(src, 0, 0, w, h);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= MAX_BYTES) return blob;
    }
    w = Math.max(1, Math.round(w * 0.8)); h = Math.max(1, Math.round(h * 0.8));
  }
  return null;
}
function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
    fr.onerror = () => reject(new Error('讀不到圖片'));
    fr.readAsDataURL(blob);
  });
}
function svcUrl(name) {
  const u = BACKENDS.platform || '';
  return /\/api$/.test(u) ? u.replace(/\/api$/, '/svc/' + name) : '';
}
function token() { try { return getToken() || ''; } catch (e) { return ''; } }
export function isDryRun() {
  try { return new URLSearchParams(window.location.search).get('dryrun') === '1'; } catch (e) { return false; }
}

const photoCache = new Map();
let dryN = 0;

/** File → 壓縮 → 上傳。回 {ok, id, preview} 或 {ok:false, error 中文} */
export async function uploadPhoto(file) {
  let blob;
  try { blob = await compress(file); } catch (e) { return { ok: false, error: '讀不到這張照片' }; }
  if (!blob) return { ok: false, error: '照片太大，壓不下來' };
  const b64 = await blobToB64(blob);
  const preview = 'data:image/jpeg;base64,' + b64;
  if (isDryRun()) { const id = 'F-DRYRUN-' + (++dryN); photoCache.set(id, preview); return { ok: true, id, preview, dryRun: true }; }
  const url = svcUrl('apv-file-put');
  if (!url) return { ok: false, error: '連不上伺服器' };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ token: token(), kind: 'receipt', mime: 'image/jpeg', b64 }) });
    const j = await res.json();
    if (j && j.ok === true && j.data && j.data.id) { photoCache.set(j.data.id, preview); return { ok: true, id: j.data.id, preview }; }
    const m = { quota: '今天上傳的照片已達上限', forbidden: '你的帳號不能上傳照片', file_too_large: '照片太大', unauthorized: '登入過期，請重新登入' };
    return { ok: false, error: m[j && j.error] || '照片上傳失敗' };
  } catch (e) { return { ok: false, error: '照片上傳失敗（網路）' }; }
}

/** 檔號 → data URL；讀不到回 null */
export async function fetchPhoto(id) {
  if (photoCache.has(id)) return photoCache.get(id);
  const url = svcUrl('apv-file-get');
  if (!url) return null;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ token: token(), id }) });
    const j = await res.json();
    if (j && j.ok === true && j.data && j.data.b64) {
      const d = `data:${j.data.mime || 'image/jpeg'};base64,${j.data.b64}`;
      photoCache.set(id, d);
      return d;
    }
  } catch (e) { /* 讀不到就不顯示 */ }
  return null;
}
/** 把容器裡的 img[data-fid] 補上圖 */
export function hydratePhotos(root) {
  root.querySelectorAll('img[data-fid]').forEach(async (img) => {
    if (img.getAttribute('src')) return;
    const d = await fetchPhoto(img.dataset.fid);
    if (d) img.src = d; else img.alt = '（照片讀不到）';
  });
}
