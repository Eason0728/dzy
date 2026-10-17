/**
 * modules/approvals/list-view.js — 卡片列表共用骨架（我的單／待我簽／待我辦／全部單據都用它）
 * load() → Promise<{ok, error?, sections:[{title, forms:[Form]}]}>；骨架負責畫、展開明細、按鈕分派、重讀。
 */
'use strict';

import { cardHtml, detailHtml } from './cards.js';
import { runAction } from './actions.js';
import { hydrateImages, showBig } from './widgets.js';
import { errText } from './lib.js';

/**
 * @param {object} cfg { scope, title, hint?, toolbar?: ()=>html, bindToolbar?: (root, reload)=>void,
 *                       load: ()=>Promise, empty: string, after?: (box, sections)=>void }
 * @returns {() => void} unmount
 */
export function mountCardList(el, ctx, cfg) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let forms = new Map();
  el.innerHTML = `<div class="card stack" data-role="apv-head">
      <div class="card-title">${esc(cfg.title)}</div>
      ${cfg.hint ? `<p class="text-muted">${esc(cfg.hint)}</p>` : ''}
      ${cfg.toolbar ? `<div data-role="apv-toolbar">${cfg.toolbar()}</div>` : ''}
    </div><div data-role="apv-results"><div class="card"><p class="text-muted">讀取中…</p></div></div>`;
  const box = el.querySelector('[data-role="apv-results"]');

  async function reload() {
    box.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';
    let res;
    try { res = await cfg.load(); } catch (e) { res = { ok: false, error: '讀取失敗' }; }
    if (!alive) return;
    if (!res || !res.ok) {
      box.innerHTML = `<div class="card" data-role="apv-error"><p class="text-muted">${esc(res && res.message ? res.message : errText(res))}</p></div>`;
      return;
    }
    forms = new Map();
    const secs = res.sections || [];
    let total = 0;
    const html = secs.map((s) => {
      (s.forms || []).forEach((f) => { forms.set(f.id, f); total++; });
      if (!(s.forms || []).length) return '';
      return `${s.title ? `<div class="card-title" data-role="apv-sec">${esc(s.title)}（${s.forms.length}）</div>` : ''}${s.forms.map((f) => cardHtml(f, cfg.scope, esc, ctx.fmt)).join('')}`;
    }).join('');
    box.innerHTML = html || `<div class="card" data-role="apv-empty"><p class="text-muted">${esc(cfg.empty)}</p></div>`;
    hydrateImages(box);
    if (cfg.after) cfg.after(box, secs, total);
  }

  async function toggleDetail(card, form) {
    const slot = card.querySelector('[data-role="detail"]');
    if (slot.innerHTML) { slot.innerHTML = ''; return; }
    slot.innerHTML = '<p class="text-muted">讀取中…</p>';
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('approvals', 'apvGet', { id: form.id }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!r || !r.ok || !r.data) { slot.innerHTML = ''; ctx.ui.toast(errText(r), 'danger'); return; }
    slot.innerHTML = detailHtml(r.data, esc, ctx.fmt);
    hydrateImages(slot);
  }

  async function onClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const img = t.closest('img[data-file]');
    if (img) { showBig(ctx, img.getAttribute('src')); return; }
    const btn = t.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('[data-role="apv-card"]');
    if (!card) return;
    const form = forms.get(card.getAttribute('data-id'));
    if (!form) return;
    const act = btn.getAttribute('data-act');
    if (act === 'view') { await toggleDetail(card, form); return; }
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const changed = await runAction(ctx, form, act);
      if (changed && alive) await reload();
    } finally { btn.disabled = false; }
  }
  box.addEventListener('click', onClick);
  if (cfg.bindToolbar) cfg.bindToolbar(el.querySelector('[data-role="apv-toolbar"]'), reload);
  reload();
  return () => { alive = false; box.removeEventListener('click', onClick); };
}
