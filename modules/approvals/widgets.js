/**
 * modules/approvals/widgets.js — 會碰 DOM 的小零件：照片挑選器、圖片補載、大圖、對話框輔助
 */
'use strict';

import { pickAndUpload, fetchPhoto, MAX_PHOTOS } from './photo.js';
import { errText } from './lib.js';

export function domOf(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

/** 把 root 底下所有 <img data-file> 補上 src（抓不到就留空白）。回 Promise。 */
export async function hydrateImages(root, fetchFn) {
  const imgs = Array.from(root.querySelectorAll('img[data-file]'));
  for (const im of imgs) {
    if (im.getAttribute('src')) continue;
    const d = await fetchPhoto(im.getAttribute('data-file'), fetchFn);
    if (d) im.setAttribute('src', d);
  }
}

/** 點縮圖看大圖 */
export function showBig(ctx, src) {
  if (!src) return;
  const img = document.createElement('img');
  img.src = src;
  img.alt = '照片';
  img.style.cssText = 'max-width:100%;max-height:70vh;display:block;margin:0 auto';
  ctx.ui.dialog({ title: '照片', body: img, actions: [{ label: '關閉', value: null, variant: 'secondary' }] });
}

/**
 * 照片挑選器。initial: [{id, previewUrl?}]（改完再送時帶入舊的）。
 * 回 {el, ids(), busy(), count(), destroy()}；onChange(ids) 在張數變動時呼叫。
 */
export function createPhotoPicker(ctx, { max = MAX_PHOTOS, initial = [], onChange, label = '拍照／選照片', fetchFn } = {}) {
  const items = initial.map((x) => ({ id: x.id, previewUrl: x.previewUrl || '' }));
  let busy = false;
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('data-role', 'photo-picker');
  wrap.innerHTML = `
    <div class="btn-row" data-role="photo-list"></div>
    <div class="btn-row">
      <button type="button" class="btn btn-secondary" data-act="add">${ctx.fmt.esc(label)}</button>
      <span class="field-hint" data-role="photo-count"></span>
    </div>
    <input type="file" accept="image/*" multiple hidden data-role="photo-file">`;
  const list = wrap.querySelector('[data-role="photo-list"]');
  const countEl = wrap.querySelector('[data-role="photo-count"]');
  const input = wrap.querySelector('[data-role="photo-file"]');

  function draw() {
    list.innerHTML = items.map((it, i) => `
      <span style="position:relative;display:inline-block">
        <img ${it.previewUrl ? `src="${ctx.fmt.esc(it.previewUrl)}"` : `data-file="${ctx.fmt.esc(it.id)}"`} alt="照片 ${i + 1}" data-big="1"
          style="width:72px;height:72px;object-fit:cover;border-radius:var(--radius);border:1px solid var(--line);background:var(--bg)">
        <button type="button" class="btn btn-danger" data-remove="${i}" aria-label="移除第 ${i + 1} 張" style="position:absolute;top:-8px;right:-8px;padding:0 var(--space-2);min-height:0;line-height:1.6">✕</button>
      </span>`).join('');
    countEl.textContent = busy ? '處理中…' : `${items.length}/${max} 張`;
    hydrateImages(list, fetchFn);
  }
  const changed = () => { if (typeof onChange === 'function') onChange(items.map((x) => x.id)); };

  async function onFiles() {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    const room = max - items.length;
    if (room <= 0) { ctx.ui.toast(`最多 ${max} 張`, 'warn'); return; }
    busy = true;
    draw();
    for (const f of files.slice(0, room)) {
      let r;
      try { r = await pickAndUpload(f, { fetchFn }); } catch (e) { r = { ok: false, error: 'file_invalid' }; }
      if (!r.ok) { ctx.ui.toast(errText({ error: r.error }), 'danger'); continue; }
      items.push({ id: r.id, previewUrl: r.previewUrl });
      draw();
    }
    if (files.length > room) ctx.ui.toast(`最多 ${max} 張，多的沒收`, 'warn');
    busy = false;
    draw();
    changed();
  }
  function onClick(e) {
    const rm = e.target && e.target.closest ? e.target.closest('[data-remove]') : null;
    if (rm) { items.splice(Number(rm.getAttribute('data-remove')), 1); draw(); changed(); return; }
    const big = e.target && e.target.closest ? e.target.closest('img[data-big]') : null;
    if (big) { showBig(ctx, big.getAttribute('src')); return; }
    const add = e.target && e.target.closest ? e.target.closest('[data-act="add"]') : null;
    if (add) {
      if (busy) return;
      if (items.length >= max) { ctx.ui.toast(`最多 ${max} 張`, 'warn'); return; }
      input.click();
    }
  }
  input.addEventListener('change', onFiles);
  wrap.addEventListener('click', onClick);
  draw();
  return {
    el: wrap,
    ids: () => items.map((x) => x.id),
    busy: () => busy,
    count: () => items.length,
    destroy() { input.removeEventListener('change', onFiles); wrap.removeEventListener('click', onClick); }
  };
}
