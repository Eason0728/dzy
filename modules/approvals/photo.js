/**
 * modules/approvals/photo.js — 照片壓縮、上傳、讀取（spec §8、§14.9；api.md「照片路由」）
 *
 * - 長邊壓到 1600px、JPEG；超過 180 KB 逐步降畫質（再不行就縮尺寸），一次傳一張（請求本體上限 256 KB）。
 * - 上傳／讀取不走 ctx.api（那是 JSON action 通道），走 <平台主機>/platform/svc/apv-file-put|get。
 *   主機從 platform/config.js 的 BACKENDS.platform 推：把結尾 /api 換成 /svc/…，推法同 platform/api.js proxyUrl()
 *  （模組不能 import platform/api.js 內部，所以複製一份小函式；bulletin 模組 import config.js 有先例）。
 * - token：POST body 需要 token，ctx 沒有給。platform/auth.js 把 token 存在 localStorage 'dzy.token'（該檔「儲存規則」），
 *   這裡只讀不寫；讀不到就當未登入。
 * - 試跑模式 ?dryrun=1：上傳是寫入，一律不送（回假檔號），跟 platform/dryrun.js 的規矩一致。
 */
'use strict';

import { BACKENDS } from '../../platform/config.js';

export const MAX_EDGE = 1600;
export const MAX_BYTES = 180 * 1024;
export const MAX_PHOTOS = 5;
export const QUALITY_STEPS = [0.85, 0.72, 0.6, 0.5, 0.4];
const SHRINK = 0.8;
const MAX_ROUNDS = 4;

/** 長邊不超過 max 的等比縮放尺寸 */
export function fitSize(w, h, max = MAX_EDGE) {
  const long = Math.max(w, h);
  if (!(long > 0)) return { w: 0, h: 0 };
  if (long <= max) return { w: Math.round(w), h: Math.round(h) };
  const s = max / long;
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/**
 * 逐步降畫質直到 ≤ maxBytes。render(w, h, quality) → Promise<Blob-like {size}>。
 * 回傳 {ok, blob, w, h, quality, tries}；縮到底仍太大 → ok:false。
 */
export async function compressToLimit(srcW, srcH, render, opts = {}) {
  const maxBytes = opts.maxBytes || MAX_BYTES;
  let { w, h } = fitSize(srcW, srcH, opts.maxEdge || MAX_EDGE);
  if (!w || !h) return { ok: false, error: 'bad_size' };
  let tries = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 第一輪從最高畫質開始；縮過尺寸的輪次不必再試最高畫質
    const steps = round === 0 ? QUALITY_STEPS : QUALITY_STEPS.slice(1);
    for (const q of steps) {
      tries++;
      const blob = await render(w, h, q);
      if (blob && blob.size <= maxBytes) return { ok: true, blob, w, h, quality: q, tries };
    }
    w = Math.max(1, Math.round(w * SHRINK));
    h = Math.max(1, Math.round(h * SHRINK));
  }
  return { ok: false, error: 'too_large', tries };
}

/** 用 canvas 當 render：createCanvas(w,h) 回 {getContext, toBlob}（測試可換假的） */
export function canvasRenderer(createCanvas, source) {
  return (w, h, q) => new Promise((resolve) => {
    const c = createCanvas(w, h);
    const g = c.getContext('2d');
    g.drawImage(source, 0, 0, w, h);
    c.toBlob((b) => resolve(b), 'image/jpeg', q);
  });
}

function realCreateCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function loadSource(file) {
  if (typeof createImageBitmap === 'function') {
    try { const bmp = await createImageBitmap(file); return { src: bmp, w: bmp.width, h: bmp.height }; } catch (e) { /* 退回 Image */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('讀不到圖片'));
      im.src = url;
    });
    return { src: img, w: img.naturalWidth, h: img.naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}

/** File（手機拍的照片）→ 壓好的 JPEG Blob */
export async function compressFile(file, createCanvas = realCreateCanvas) {
  const { src, w, h } = await loadSource(file);
  return compressToLimit(w, h, canvasRenderer(createCanvas, src));
}

export function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
    fr.onerror = () => reject(new Error('讀不到圖片'));
    fr.readAsDataURL(blob);
  });
}

// ── 位址／token ────────────────────────────────────────
export function svcUrl(name) {
  const u = BACKENDS.platform || '';
  return /\/api$/.test(u) ? u.replace(/\/api$/, '/svc/' + name) : '';
}
export function putUrl() { return svcUrl('apv-file-put'); }
export function getUrl() { return svcUrl('apv-file-get'); }
function readToken() {
  try { return (typeof localStorage !== 'undefined' && localStorage.getItem('dzy.token')) || ''; } catch (e) { return ''; }
}
function dryRun() {
  try { return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('dryrun') === '1'; } catch (e) { return false; }
}
function mapErr(code) {
  return ['file_invalid', 'file_too_large', 'quota', 'forbidden', 'unauthorized'].indexOf(code) !== -1 ? code : (code || 'network');
}

/**
 * 上傳一張。kind: 'receipt'（JPEG）｜'sign'（PNG）。b64 不含 data: 前綴。
 * 回 {ok:true, id, bytes} 或 {ok:false, error:<api.md 錯誤碼>}（error 可餵給 lib.errText）。
 */
export async function uploadB64(kind, mime, b64, fetchFn) {
  if (dryRun()) return { ok: true, id: 'F-DRYRUN', bytes: 0, dryRun: true };
  const url = putUrl();
  if (!url) return { ok: false, error: 'network' };
  const f = fetchFn || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!f) return { ok: false, error: 'network' };
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ token: readToken(), kind, mime, b64 })
    });
    const json = await res.json();
    if (json && json.ok === true && json.data && json.data.id) return { ok: true, id: json.data.id, bytes: json.data.bytes };
    return { ok: false, error: mapErr(json && json.error) };
  } catch (e) { return { ok: false, error: 'network' }; }
}

/** File → 壓縮 → 上傳。回 {ok, id, bytes, previewUrl} */
export async function pickAndUpload(file, deps = {}) {
  const c = await compressFile(file, deps.createCanvas);
  if (!c.ok) return { ok: false, error: 'file_too_large' };
  const b64 = await blobToB64(c.blob);
  const r = await uploadB64('receipt', 'image/jpeg', b64, deps.fetchFn);
  if (!r.ok) return r;
  return { ok: true, id: r.id, bytes: r.bytes, previewUrl: 'data:image/jpeg;base64,' + b64 };
}

/** 簽名板 dataURL（PNG）→ 上傳 kind=sign（≤100 KB；太大就縮小重畫一次） */
export async function uploadSignature(dataUrl, fetchFn) {
  let url = dataUrl;
  const LIMIT = 100 * 1024;
  const bytesOf = (u) => Math.floor((u.length - u.indexOf(',') - 1) * 3 / 4);
  if (bytesOf(url) > LIMIT && typeof document !== 'undefined') {
    url = await shrinkPng(url, LIMIT);
  }
  return uploadB64('sign', 'image/png', url.slice(url.indexOf(',') + 1), fetchFn);
}
async function shrinkPng(dataUrl, limit) {
  const img = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = dataUrl; });
  let scale = 0.7;
  let out = dataUrl;
  for (let i = 0; i < 4; i++) {
    const c = realCreateCanvas(Math.max(1, Math.round(img.naturalWidth * scale)), Math.max(1, Math.round(img.naturalHeight * scale)));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    out = c.toDataURL('image/png');
    if (Math.floor((out.length - out.indexOf(',') - 1) * 3 / 4) <= limit) break;
    scale *= 0.7;
  }
  return out;
}

// ── 讀圖 ───────────────────────────────────────────────
const cache = new Map();
/** 檔號 → data URL；沒權限／失敗回 null。同一個檔號只抓一次 */
export async function fetchPhoto(id, fetchFn) {
  if (cache.has(id)) return cache.get(id);
  const url = getUrl();
  const f = fetchFn || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!url || !f) return null;
  try {
    const res = await f(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ token: readToken(), id }) });
    const json = await res.json();
    if (json && json.ok === true && json.data && json.data.b64) {
      const d = `data:${json.data.mime || 'image/jpeg'};base64,${json.data.b64}`;
      cache.set(id, d);
      return d;
    }
  } catch (e) { /* 讀不到就不顯示 */ }
  return null;
}
export function __clearPhotoCache() { cache.clear(); }
