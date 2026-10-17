/**
 * 核決權限（spec §7、§14.1）：照 Eason 的「門店支出」表——每列一個金額輸入框、門市一排與總部一排權限人（點選）、
 * 新增一級／刪除、儲存前顯示「改了什麼」、儲存帶 expected_ver（不符回 conflict）。只有 role admin 看得到分頁（manifest）。
 * 請購、請款共用這一張表。
 */
'use strict';

import {
  THR_ROLES, THR_ROLE_STORE_LABEL, THR_ROLE_HQ_LABEL, validateThr, normThrRows, diffThr, toNum, errText, isConflict
} from '../lib.js';
import { domOf } from '../widgets.js';

export function mountThr(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let ver = 0;
  let orig = [];   // 伺服器上的版本（正規化）
  let rows = [];   // 編輯中：{max: string|null, store_role, hq_role}

  function fresh(list) {
    return list.map((r) => ({ max: r.max === null || r.max === undefined ? null : String(r.max), store_role: r.store_role, hq_role: r.hq_role }));
  }
  function rangeLabel(i) {
    const lo = i === 0 ? 0 : (toNum(rows[i - 1].max) + 1);
    const loT = isFinite(lo) ? lo.toLocaleString('en-US') : '?';
    return i === rows.length - 1 ? `${loT} 以上` : `${loT} ～ ${isFinite(toNum(rows[i].max)) ? toNum(rows[i].max).toLocaleString('en-US') : '?'}`;
  }
  function chips(i, which) {
    const labels = which === 'store' ? THR_ROLE_STORE_LABEL : THR_ROLE_HQ_LABEL;
    const cur = rows[i][which === 'store' ? 'store_role' : 'hq_role'];
    return THR_ROLES.map((r) => `<button type="button" class="btn ${cur === r ? 'btn-primary' : 'btn-secondary'}" data-pick="${which}" data-i="${i}" data-val="${r}" aria-pressed="${cur === r}">${esc(labels[r])}</button>`).join('');
  }
  function draw(msg) {
    const last = rows.length - 1;
    el.innerHTML = `
      <div class="card stack"><div class="card-title">核決權限（請購、請款共用）</div>
        <p class="text-muted">金額落在哪一級，就只有那一級的權限人簽一關。門市（含中央工廠、品牌辦公室）與總部各選一個權限人。目前版本 ${esc(ver)}。</p></div>
      ${rows.map((r, i) => `
        <div class="card stack" data-role="thr-row" data-i="${i}">
          <div class="card-row"><div class="card-title">第 ${i + 1} 級　<span class="text-muted" data-role="range">${esc(rangeLabel(i))}</span></div>
            <button type="button" class="btn btn-danger" data-act="del" data-i="${i}"${rows.length <= 1 ? ' disabled' : ''}>刪除</button></div>
          <div class="field"><label class="field-label" for="thr-max-${i}">金額上限（元，含）</label>
            ${i === last ? `<input class="input" id="thr-max-${i}" value="以上全部" disabled>` : `<input class="input" id="thr-max-${i}" type="number" inputmode="numeric" min="1" step="1" data-max="${i}" value="${esc(r.max === null ? '' : r.max)}">`}</div>
          <div class="field"><div class="field-label">門市權限人</div><div class="btn-row">${chips(i, 'store')}</div></div>
          <div class="field"><div class="field-label">總部權限人</div><div class="btn-row">${chips(i, 'hq')}</div></div>
        </div>`).join('')}
      <div class="card stack">
        <div class="btn-row">
          <button type="button" class="btn btn-secondary" data-act="add">新增一級</button>
          <button type="button" class="btn btn-secondary" data-act="reset">還原</button>
          <button type="button" class="btn btn-primary" data-act="save">儲存</button>
        </div>
        <p class="field-hint" data-role="thr-msg">${esc(msg || '')}</p>
      </div>`;
  }

  async function load() {
    el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';
    const r = await ctx.api.call('approvals', 'apvThresholdGet', {});
    if (!alive) return;
    if (r && r.error === 'not_inited') {
      // 第一次上線：資料表還沒建（只有 admin 看得到本頁）→ 給一顆初始化按鈕，免下指令
      el.innerHTML = `<div class="card" data-role="apv-init"><p>表單簽核還沒初始化。按下面按鈕會建立資料表，並寫入預設核決權限（店長 5,000／品牌總監 10,000／總經理 30,000／以上董事長）。</p>
        <button type="button" class="btn btn-primary" data-act="init">初始化表單簽核</button><p class="field-hint" data-role="thr-msg"></p></div>`;
      el.querySelector('[data-act="init"]').addEventListener('click', async () => {
        const x = await ctx.api.call('approvals', 'apvSetup', {});
        if (!alive) return;
        if (x && x.ok) { load(); return; }
        setMsg(errText(x));
      });
      return;
    }
    if (!r || !r.ok) { el.innerHTML = `<div class="card" data-role="apv-error"><p class="text-muted">${esc(errText(r))}</p></div>`; return; }
    const d = r.data || {};
    ver = d.ver || 0;
    orig = normThrRows(fresh(Array.isArray(d.rows) ? d.rows : []));
    rows = fresh(orig);
    draw();
  }

  function setMsg(t) { const m = el.querySelector('[data-role="thr-msg"]'); if (m) m.textContent = t || ''; }

  function addLevel() {
    const last = rows[rows.length - 1];
    const prevMax = rows.length >= 2 ? toNum(rows[rows.length - 2].max) : 0;
    // 原本最後一級（以上全部）補一個金額上限，新的最後一級接在後面
    const base = isFinite(prevMax) ? prevMax : 0;
    last.max = String(base > 0 ? base * 2 : 10000);
    rows.push({ max: null, store_role: last.store_role, hq_role: last.hq_role });
    draw('已新增一級，請改金額與權限人');
  }
  function delLevel(i) {
    if (rows.length <= 1) return;
    rows.splice(i, 1);
    rows[rows.length - 1].max = null;
    draw();
  }

  async function save() {
    const err = validateThr(rows);
    if (err) { setMsg(err); ctx.ui.toast(err, 'warn'); return; }
    const next = normThrRows(rows);
    const diffs = diffThr(orig, next);
    if (!diffs.length) { setMsg('沒有改動'); ctx.ui.toast('沒有改動', 'info'); return; }
    const body = domOf(`<p>儲存後，新送出的單照新的表走；已送出的單不受影響。</p><ul data-role="thr-diff">${diffs.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`);
    const v = await ctx.ui.dialog({ title: '確認要改的地方', body, actions: [
      { label: '取消', value: null, variant: 'secondary' }, { label: '確定儲存', value: 'ok', variant: 'primary' }] });
    if (v !== 'ok') return;
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('approvals', 'apvThresholdSave', { expected_ver: ver, rows: next }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!r || !r.ok) {
      if (isConflict(r)) { ctx.ui.toast('這張表剛被別人改過，已重新讀取最新版，請再確認', 'warn'); await load(); return; }
      setMsg(errText(r)); ctx.ui.toast(errText(r), 'danger'); return;
    }
    ctx.ui.toast('已儲存', 'ok');
    await load();
  }

  function onClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const pick = t.closest('[data-pick]');
    if (pick) {
      rows[Number(pick.getAttribute('data-i'))][pick.getAttribute('data-pick') === 'store' ? 'store_role' : 'hq_role'] = pick.getAttribute('data-val');
      draw();
      return;
    }
    const b = t.closest('[data-act]');
    if (!b) return;
    const a = b.getAttribute('data-act');
    if (a === 'add') addLevel();
    else if (a === 'del') delLevel(Number(b.getAttribute('data-i')));
    else if (a === 'reset') { rows = fresh(orig); draw('已還原成伺服器上的版本'); }
    else if (a === 'save') save();
  }
  function onInput(e) {
    const t = e.target;
    if (!t || !t.getAttribute || t.getAttribute('data-max') === null) return;
    rows[Number(t.getAttribute('data-max'))].max = t.value;
    el.querySelectorAll('[data-role="thr-row"]').forEach((card, i) => {
      const r = card.querySelector('[data-role="range"]');
      if (r) r.textContent = rangeLabel(i);
    });
  }
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  load();
  return () => { alive = false; el.removeEventListener('click', onClick); el.removeEventListener('input', onInput); };
}
