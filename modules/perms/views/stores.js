/**
 * modules/perms/views/stores.js — 店別對照分頁（admin；spec §7.1-3）
 * 組織的門市單位 ↔ 稽核系統的店別代碼。選項＝已經對照過的稽核店（permStoreGet 回傳）＋「其他代碼」自行輸入；可清空。
 */
'use strict';

import { errorText, unmappedStoreUnits } from '../lib.js';

export function mountStores(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let data = null;

  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';

  async function load() {
    const r = await ctx.api.call('perms', 'permStoreGet', {});
    if (!alive) return;
    if (!r.ok) { el.innerHTML = `<div class="card"><p>${esc(r.error || '讀不到店別對照')}</p></div>`; return; }
    data = r.data || {};
    draw();
  }

  function draw() {
    if (data.inited === false) {
      el.innerHTML = '<div class="card"><div class="card-title">權限設定還沒初始化</div><p class="text-muted">請先到「對照表」分頁按「初始化」。</p></div>';
      return;
    }
    const mapOf = {};
    (data.items || []).forEach((i) => { mapOf[i.unit] = i.audit_store; });
    const codes = Array.from(new Set((data.items || []).map((i) => i.audit_store).filter(Boolean))).sort();
    const units = (data.units || []).filter((u) => u.ladder === 'store');
    const missing = unmappedStoreUnits(data).length;
    const rows = units.map((u) => {
      const cur = mapOf[u.code] || '';
      const known = !cur || codes.indexOf(cur) !== -1;
      const opts = ['<option value="">（不對照）</option>']
        .concat(codes.map((c) => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}</option>`))
        .concat(['<option value="__other__">其他代碼…</option>']).join('');
      return `<div class="card stack" data-role="store-row" data-unit="${esc(u.code)}">
        <div class="card-row"><div class="card-title">${esc(u.name)}</div>${cur ? `<span class="tag tag-ok">${esc(cur)}</span>` : '<span class="tag tag-warn">還沒對照</span>'}</div>
        <div class="form-grid-2">
          <div class="field"><label class="field-label" for="st-${esc(u.code)}">稽核店別</label>
            <select class="input" id="st-${esc(u.code)}" data-role="store-sel">${opts}</select></div>
          <div class="field" data-role="store-other-wrap" hidden><label class="field-label" for="sto-${esc(u.code)}">稽核店別代碼</label>
            <input class="input" id="sto-${esc(u.code)}" type="text" maxlength="32" data-role="store-other" value="${known ? '' : esc(cur)}" placeholder="英數字與 - _"></div>
        </div>
        <div><button type="button" class="btn btn-primary" data-act="save" data-unit="${esc(u.code)}">儲存</button></div>
      </div>`;
    }).join('');
    el.innerHTML = `<div class="card stack"><div class="card-title">店別對照</div>
      <p class="text-muted">店長與區督導能看哪幾家的稽核，是靠這張對照。${missing ? `<strong>還有 ${missing} 個門市單位沒對照。</strong>` : '全部門市單位都已對照。'}</p></div>${rows || '<div class="card"><p class="text-muted">沒有門市單位。</p></div>'}`;
    el.querySelectorAll('[data-role="store-sel"]').forEach((sel) => {
      const wrap = sel.closest('[data-role="store-row"]').querySelector('[data-role="store-other-wrap"]');
      const sync = () => { wrap.hidden = sel.value !== '__other__'; };
      sel.addEventListener('change', sync);
      // 目前對照的值不在選項裡（理論上不會）→ 直接切到「其他」顯示它
      const unit = sel.closest('[data-role="store-row"]').getAttribute('data-unit');
      const cur = mapOf[unit] || '';
      if (cur && codes.indexOf(cur) === -1) { sel.value = '__other__'; }
      sync();
    });
  }

  async function onSave(unit) {
    const row = el.querySelector(`[data-role="store-row"][data-unit="${CSS.escape(unit)}"]`);
    const sel = row.querySelector('[data-role="store-sel"]');
    const store = sel.value === '__other__' ? row.querySelector('[data-role="store-other"]').value.trim() : sel.value;
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('perms', 'permStoreSave', { unit, audit_store: store }); } finally { ctx.ui.loading(false); }
    if (!alive || r.dryrun) return;
    if (!r.ok) { ctx.ui.toast(errorText(r), 'danger'); return; }
    ctx.ui.toast(store ? '已對照' : '已清除對照', 'ok');
    await load();
  }

  const onClick = (ev) => {
    const btn = ev.target.closest('[data-act="save"]');
    if (btn && el.contains(btn)) onSave(btn.getAttribute('data-unit'));
  };
  el.addEventListener('click', onClick);
  load();
  return () => { alive = false; el.removeEventListener('click', onClick); };
}
