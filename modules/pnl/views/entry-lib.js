/**
 * modules/pnl/views/entry-lib.js — 填資料頁的純函式（不碰 DOM，node 可直接測；對照舊網站 gas/entry.html 的同名邏輯）
 * 類別分組、已填／選填／待補判斷、分攤提示、附件檢查與壓縮尺寸、附件 id 解析。
 */
'use strict';

export const BLOCKS = ['營收', '食材', '包材', '人事', '可控', '不可控', '營業稅', '營業外收入'];

/** 類別 ↔ 科目區塊（照舊網站 PnlEntryCategories） */
export const CATS = [
  { key: 'food', label: '食材費用', blocks: ['食材', '包材'] },
  { key: 'labor', label: '人事費用', blocks: ['人事'] },
  { key: 'controllable', label: '可控費用', blocks: ['可控'] },
  { key: 'uncontrollable', label: '不可控費用', blocks: ['不可控', '營業稅', '營業外收入'] },
  { key: 'revenue', label: '營業收入', blocks: ['營收'] }
];

/** 後端 apiAddEntry_ 只放行這兩種取值方式 */
export const ADD_ALLOWED_MODES = { 手動: true, 連接器: true };

export const PHOTO_MAX_DIM = 1600;
export const PHOTO_QUALITY = 0.82;
/** 後端：base64 字串長度上限 8MB（ATTACHMENT_MAX_BASE64_LENGTH_） */
export const ATTACH_MAX_BASE64 = 8 * 1024 * 1024;

export function catOf(key) { return CATS.filter((c) => c.key === key)[0] || null; }

export function fmtInt(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const r = Math.round(n);
  return (r < 0 ? '−' : '') + String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 啟用中的科目依區塊分組、依 sort 排序 */
export function accountsByBlock(accounts) {
  const out = {};
  BLOCKS.forEach((b) => { out[b] = []; });
  (accounts || []).forEach((a) => {
    if (!a || a.active !== true) return;
    if (!out[a.block]) out[a.block] = [];
    out[a.block].push(a);
  });
  Object.keys(out).forEach((b) => out[b].sort((x, y) => (x.sort || 0) - (y.sort || 0)));
  return out;
}

export function pendingSetOf(pending) {
  const s = {};
  (Array.isArray(pending) ? pending : []).forEach((id) => { s[id] = true; });
  return s;
}

/** 本月有有效明細（含確認為 0）的科目 */
export function liveSetOf(entries) {
  const s = {};
  (Array.isArray(entries) ? entries : []).forEach((e) => { if (e && e.void !== true) s[e.acc_id] = true; });
  return s;
}

/** 已填：非待補，且有有效明細或是固定／公式這種自動算的科目 */
export function isFilled(a, pendingSet, liveSet) {
  if (pendingSet[a.acc_id]) return false;
  return !!liveSet[a.acc_id] || a.mode === '固定' || a.mode === '公式';
}

/** 選填且本月沒明細（不算待補） */
export function isOptionalEmpty(a, pendingSet, liveSet) {
  return !pendingSet[a.acc_id] && !liveSet[a.acc_id] && !!(a.params && a.params.optional === true);
}

/** 同區塊內：非選填在前、選填無明細在後（穩定排序） */
export function sortOptionalLast(accs, pendingSet, liveSet) {
  const head = [], tail = [];
  accs.forEach((a) => { (isOptionalEmpty(a, pendingSet, liveSet) ? tail : head).push(a); });
  return head.concat(tail);
}

/** 待補總覽：每類別一組（不列已填、不列選填）；回 {groups:[{cat, accs}], total} */
export function pendingGroups(accounts, pending, entries) {
  const byBlock = accountsByBlock(accounts);
  const ps = pendingSetOf(pending), ls = liveSetOf(entries);
  const groups = [];
  let total = 0;
  CATS.forEach((c) => {
    const accs = [];
    c.blocks.forEach((b) => (byBlock[b] || []).forEach((a) => {
      if (!isFilled(a, ps, ls) && !isOptionalEmpty(a, ps, ls)) accs.push(a);
    }));
    if (accs.length) { groups.push({ cat: c, accs }); total += accs.length; }
  });
  return { groups, total };
}

/** 單一類別完整資料：[{block, accs}]（待補／已填在前、選填無明細在後） */
export function categoryBlocks(accounts, pending, entries, catKey) {
  const cat = catOf(catKey);
  if (!cat) return [];
  const byBlock = accountsByBlock(accounts);
  const ps = pendingSetOf(pending), ls = liveSetOf(entries);
  return cat.blocks.map((b) => ({ block: b, accs: sortOptionalLast(byBlock[b] || [], ps, ls) })).filter((x) => x.accs.length);
}

/** 連接器寫入的明細來源是「連接器:<名稱>」→「現金帳（連接器）」 */
export function sourceLabel(src) {
  const s = String(src || '');
  return s.indexOf('連接器:') === 0 ? s.slice(4) + '（連接器）' : s;
}

/** 同科目兩個以上不同來源時的一行「來源：A NT$ 1,300＋B NT$ 500」；不到兩個來源回空字串 */
export function sourceSummary(entries) {
  const order = [], sums = {};
  entries.forEach((e) => {
    const k = sourceLabel(e.source);
    if (!Object.prototype.hasOwnProperty.call(sums, k)) { sums[k] = 0; order.push(k); }
    sums[k] += Number(e.amount) || 0;
  });
  return order.length < 2 ? '' : '來源：' + order.map((k) => k + ' NT$ ' + fmtInt(sums[k])).join('＋');
}

/** 「確認為 0」按鈕要不要給：待補、手動／連接器、月份列已建立、連接器當月（含未來月）不給（後端也擋） */
export function showConfirmZero(account, isPending, canEdit, monthExists, month, thisMonth) {
  if (!isPending || !canEdit || !monthExists) return false;
  if (!ADD_ALLOWED_MODES[account.mode]) return false;
  return !(account.mode === '連接器' && month >= thisMonth);
}

/** 新增表單驗證；回 {ok, error?, amount, split_months} */
export function validateAdd(amountStr, splitStr) {
  const amount = parseFloat(amountStr);
  const split = parseInt(splitStr, 10);
  if (!isFinite(amount) || amount < 0) return { ok: false, error: '金額必須是 ≥0 的數字' };
  if (!Number.isInteger(split) || split < 1) return { ok: false, error: '分攤月數必須是 ≥1 整數' };
  return { ok: true, amount, split_months: split };
}

/** 分攤月數 > 1 時的提示；否則空字串 */
export function splitHint(amountStr, splitStr) {
  const amount = parseFloat(amountStr);
  const months = parseInt(splitStr, 10);
  return isFinite(amount) && amount >= 0 && Number.isInteger(months) && months > 1 ? '本月認列＝金額÷月數＝NT$ ' + fmtInt(amount / months) : '';
}

/** 科目手續費提示（params.fee 是數字才有） */
export function feeHint(account) {
  const fee = account && account.params && typeof account.params.fee === 'number' ? account.params.fee : null;
  return fee === null ? '' : '填對帳單金額，手續費 NT$' + fmtInt(fee) + ' 系統自動加';
}

/** 縮到長邊 max 以內（不放大）；回 {w,h} */
export function fitSize(w, h, max) {
  const scale = Math.min(1, (max || PHOTO_MAX_DIM) / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/**
 * 選檔檢查：回 {kind:'image'|'pdf'} 或 {error}
 * HEIC／HEIF 擋下（後端也擋）；圖片前端壓縮成 JPEG；PDF 照傳（base64 超過後端上限 8MB 由 checkBase64 擋）
 */
export function classifyFile(file) {
  const name = String((file && file.name) || '').toLowerCase();
  const type = String((file && file.type) || '').toLowerCase();
  if (/heic|heif/.test(type) || /\.(heic|heif)$/.test(name)) return { error: 'HEIC 格式請先轉成 JPEG／PNG 再上傳' };
  if (type === 'application/pdf' || /\.pdf$/.test(name)) return { kind: 'pdf' };
  if (/^image\//.test(type) || /\.(jpe?g|png|webp)$/.test(name)) return { kind: 'image' };
  return { error: '只能上傳圖片（JPEG／PNG／WebP）或 PDF' };
}

export function checkBase64(b64) {
  return typeof b64 === 'string' && b64.length > 0 && b64.length <= ATTACH_MAX_BASE64 ? null : '檔案超過 8MB，請縮小後再上傳';
}

/** 附件網址 → getAttachment 的 file_id：本機 pnlfile:… 整串；舊的 drive 網址取檔案 ID；其他回 null */
export function attachFileId(url) {
  const u = String(url || '');
  if (/^pnlfile:\S+$/.test(u)) return u;
  const m = /^https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)\/\S*$/.exec(u);
  return m ? m[1] : null;
}

/** getAttachment 回的 mime → 顯示方式 */
export function attachKind(mime) {
  if (/^image\/(jpeg|png|webp)$/.test(mime)) return 'image';
  return mime === 'application/pdf' ? 'pdf' : 'none';
}

/** base64 → Blob URL（瀏覽器環境） */
export function base64ToObjectUrl(base64, mime) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/** 圖檔 → 長邊 1600px 的 JPEG base64（無前綴）；解不開（多半是 HEIC）丟帶 friendly 的錯 */
export function compressImageToJpeg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const s = fitSize(img.naturalWidth, img.naturalHeight, PHOTO_MAX_DIM);
        const canvas = document.createElement('canvas');
        canvas.width = s.w; canvas.height = s.h;
        canvas.getContext('2d').drawImage(img, 0, 0, s.w, s.h);
        const dataUrl = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
        URL.revokeObjectURL(url);
        resolve(dataUrl.split(',')[1]);
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      const e = new Error('圖片格式無法讀取（可能是 HEIC），請改用 JPEG／PNG');
      e.friendly = true;
      reject(e);
    };
    img.src = url;
  });
}

/** 檔案 → 要送的 {mime, base64}（圖片壓縮、PDF 直接讀）；失敗丟帶 friendly 的錯 */
export async function prepareUpload(file) {
  const c = classifyFile(file);
  if (c.error) { const e = new Error(c.error); e.friendly = true; throw e; }
  let base64, mime;
  if (c.kind === 'image') { base64 = await compressImageToJpeg(file); mime = 'image/jpeg'; } else {
    const buf = new Uint8Array(await file.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    base64 = btoa(s); mime = 'application/pdf';
  }
  const bad = checkBase64(base64);
  if (bad) { const e = new Error(bad); e.friendly = true; throw e; }
  return { mime, base64 };
}
