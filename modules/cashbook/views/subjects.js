/**
 * 會計科目（spec §7）：支出、收入兩個清單，一行一個；全部店共用一份。
 * 儲存只送 expenseSubjects／incomeSubjects（代轉通道不接受改通行碼欄位）。
 */
'use strict';

import { errText, parseSubjects, validateSubjects } from '../lib/util.js';

export function mountSubjects(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let orig = { exp: [], inc: [] };
  let busy = false;

  function draw(msg) {
    el.innerHTML = `<div class="card stack">
      <div class="card-title">會計科目</div>
      <p class="text-muted">一行一個科目；支出、收入各 1–100 個，每個名稱 30 字內。全部門市共用同一份，儲存後店長端下次開啟就會看到。</p>
      <div class="form-grid-2">
        <div class="field"><label class="field-label" for="cb-sub-exp">支出科目</label>
          <textarea class="input" id="cb-sub-exp" rows="14" data-role="cb-sub-exp">${esc(orig.exp.join('\n'))}</textarea></div>
        <div class="field"><label class="field-label" for="cb-sub-inc">收入科目</label>
          <textarea class="input" id="cb-sub-inc" rows="14" data-role="cb-sub-inc">${esc(orig.inc.join('\n'))}</textarea></div>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-secondary" data-act="reset">還原</button>
        <button type="button" class="btn btn-primary" data-act="save" data-role="cb-sub-save">儲存</button></div>
      <p class="field-hint" data-role="cb-msg">${esc(msg || '')}</p></div>`;
  }

  async function load() {
    el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';
    let r;
    try { r = await ctx.api.call('cashbook', 'adminGet', {}); } catch (e) { r = null; }
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card" data-role="cb-error"><p class="text-muted">${esc(errText(r))}</p></div>`; return; }
    const d = r.data || {};
    orig = { exp: Array.isArray(d.expenseSubjects) ? d.expenseSubjects.slice() : [], inc: Array.isArray(d.incomeSubjects) ? d.incomeSubjects.slice() : [] };
    draw('');
  }

  function diffText(a, b, label) {
    const add = b.filter((x) => a.indexOf(x) === -1);
    const del = a.filter((x) => b.indexOf(x) === -1);
    const out = [];
    if (add.length) out.push(`${label}新增：${add.join('、')}`);
    if (del.length) out.push(`${label}刪除：${del.join('、')}`);
    if (!add.length && !del.length && a.join('\n') !== b.join('\n')) out.push(`${label}調整了順序`);
    return out;
  }

  async function save() {
    if (busy) return;
    const exp = parseSubjects(el.querySelector('[data-role="cb-sub-exp"]').value);
    const inc = parseSubjects(el.querySelector('[data-role="cb-sub-inc"]').value);
    const err = validateSubjects(exp, '支出科目') || validateSubjects(inc, '收入科目');
    const msgEl = el.querySelector('[data-role="cb-msg"]');
    if (err) { if (msgEl) msgEl.textContent = err; ctx.ui.toast(err, 'warn'); return; }
    const diffs = diffText(orig.exp, exp, '支出').concat(diffText(orig.inc, inc, '收入'));
    if (!diffs.length) { if (msgEl) msgEl.textContent = '沒有改動'; ctx.ui.toast('沒有改動', 'info'); return; }
    const body = document.createElement('div');
    body.innerHTML = `<p>儲存後全部門市共用這份科目（歷史帳不受影響）。</p><ul data-role="cb-sub-diff">${diffs.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`;
    const v = await ctx.ui.dialog({ title: '確認要改的地方', body, actions: [
      { label: '取消', value: null, variant: 'secondary' }, { label: '確定儲存', value: 'ok', variant: 'primary' }] });
    if (v !== 'ok' || !alive) return;
    busy = true;
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('cashbook', 'adminSave', { expenseSubjects: exp, incomeSubjects: inc }); } catch (e) { r = null; } finally { ctx.ui.loading(false); busy = false; }
    if (!alive) return;
    if (!r || !r.ok) { ctx.ui.toast(errText(r), 'danger'); return; }
    if (r.data && r.data.dryRun) { ctx.ui.toast('試跑模式：未實際寫入', 'ok'); return; }
    ctx.ui.toast('已儲存', 'ok');
    await load();
  }

  function onClick(e) {
    const b = e.target && e.target.closest && e.target.closest('[data-act]');
    if (!b) return;
    const a = b.getAttribute('data-act');
    if (a === 'save') save();
    else if (a === 'reset') draw('已還原成伺服器上的版本');
  }
  el.addEventListener('click', onClick);
  load();
  return () => { alive = false; el.removeEventListener('click', onClick); };
}
