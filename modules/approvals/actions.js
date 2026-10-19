/**
 * modules/approvals/actions.js — 卡片上的動作（核准／退回／簽名／已處理／改派／作廢／撤回）
 * 每個動作都帶畫面當下的 rev＋step（api.md；後端不符回 conflict）。權限由後端判，前端 form.can 只決定按鈕出不出現。
 */
'use strict';

import { errText, isConflict } from './lib.js';
import { domOf } from './widgets.js';
import { uploadSignature } from './photo.js';

const REASON_HTML = (id, label, hint) => `<div class="field"><label class="field-label" for="${id}">${label}</label>
  <textarea class="input" id="${id}" rows="3" maxlength="200"></textarea>${hint ? `<p class="field-hint">${hint}</p>` : ''}</div>`;

async function send(ctx, action, payload, okMsg) {
  ctx.ui.loading(true);
  let r;
  try { r = await ctx.api.call('approvals', action, payload); } finally { ctx.ui.loading(false); }
  if (!r || !r.ok) {
    ctx.ui.toast(errText(r), isConflict(r) ? 'warn' : 'danger');
    return { ok: false, conflict: isConflict(r) };
  }
  if (okMsg) ctx.ui.toast(okMsg, 'ok');
  return { ok: true, data: r.data };
}

async function reasonDialog(ctx, title, label, okLabel, variant, required) {
  const body = domOf(REASON_HTML('apv-reason', label));
  const v = await ctx.ui.dialog({ title, body, actions: [
    { label: '取消', value: null, variant: 'secondary' }, { label: okLabel, value: 'ok', variant }] });
  if (v !== 'ok') return null;
  const text = body.querySelector('#apv-reason').value.trim();
  if (required && !text) { ctx.ui.toast('請填寫原因', 'warn'); return null; }
  return text;
}

/**
 * @returns {Promise<boolean>} true＝後端有動到資料或發生 conflict（呼叫端應重讀列表）
 */
export async function runAction(ctx, form, act) {
  const base = { id: form.id, rev: form.rev, step: form.step };
  if (act === 'approve') {
    if (!(await ctx.ui.confirm(`核准 ${form.id}？`))) return false;
    const r = await send(ctx, 'apvDecide', { ...base, decision: 'approve' }, '已核准');
    return r.ok || r.conflict;
  }
  if (act === 'reject') {
    const note = await reasonDialog(ctx, `退回 ${form.id}`, '退回原因（必填，送件人會看到）', '退回', 'danger', true);
    if (note === null) return false;
    const r = await send(ctx, 'apvDecide', { ...base, decision: 'reject', note }, '已退回');
    return r.ok || r.conflict;
  }
  if (act === 'sign') return signFlow(ctx, form, base);
  if (act === 'done') {
    const note = await reasonDialog(ctx, `已處理 ${form.id}`, '承辦備註（選填）', '已處理', 'primary', false);
    if (note === null) return false;
    const r = await send(ctx, 'apvHandle', { ...base, result: 'done', note }, '已標為處理完成');
    return r.ok || r.conflict;
  }
  if (act === 'return') {
    const note = await reasonDialog(ctx, `退回送件人 ${form.id}`, '退回原因（必填；送件人改完要重新核准）', '退回', 'danger', true);
    if (note === null) return false;
    const r = await send(ctx, 'apvHandle', { ...base, result: 'return', note }, '已退回送件人');
    return r.ok || r.conflict;
  }
  if (act === 'withdraw') {
    if (!(await ctx.ui.confirm(`撤回 ${form.id}？撤回後不會再有人簽。`))) return false;
    const r = await send(ctx, 'apvWithdraw', base, '已撤回');
    return r.ok || r.conflict;
  }
  if (act === 'reassign') return reassignFlow(ctx, form, base);
  if (act === 'void') {
    const reason = await reasonDialog(ctx, `作廢 ${form.id}`, '作廢原因（必填）', '作廢', 'danger', true);
    if (reason === null) return false;
    const r = await send(ctx, 'apvVoid', { ...base, reason }, '已作廢');
    return r.ok || r.conflict;
  }
  if (act === 'resubmit') { ctx.nav('submit', { resubmit: form.id }); return false; }
  return false;
}

async function reassignFlow(ctx, form, base) {
  const body = domOf(`<div class="field"><label class="field-label" for="apv-to">改派給（DZY 編號）</label>
    <input class="input" id="apv-to" maxlength="12" placeholder="DZY9xx"></div>${REASON_HTML('apv-reason', '改派原因（必填）')}
    <p class="field-hint">對象必須是這一關該有的職稱或更高的在職同仁，後端會檢查。</p>`);
  const v = await ctx.ui.dialog({ title: `改派 ${form.id}`, body, actions: [
    { label: '取消', value: null, variant: 'secondary' }, { label: '改派', value: 'ok', variant: 'primary' }] });
  if (v !== 'ok') return false;
  const to = body.querySelector('#apv-to').value.trim().toUpperCase();
  const reason = body.querySelector('#apv-reason').value.trim();
  if (!/^DZY\d{3,}$/.test(to)) { ctx.ui.toast('請填正確的 DZY 編號', 'warn'); return false; }
  if (!reason) { ctx.ui.toast('請填改派原因', 'warn'); return false; }
  const r = await send(ctx, 'apvReassign', { ...base, to, reason }, '已改派');
  return r.ok || r.conflict;
}

/** 離職單的本人簽名關：簽名板 → PNG → 上傳 kind=sign → apvSign */
async function signFlow(ctx, form, base) {
  const body = domOf(`<p>${ctx.fmt.esc(form.id)} 離職單，請在下面簽名確認是你本人。</p>
    <canvas data-role="sign-pad" style="width:100%;height:160px;border:1px solid var(--line);border-radius:var(--radius);background:var(--card);touch-action:none"></canvas>
    <div class="btn-row"><button type="button" class="btn btn-secondary" data-act="clear">清除重簽</button></div>`);
  const p = ctx.ui.dialog({ title: '本人簽名', body, actions: [
    { label: '取消', value: null, variant: 'secondary' }, { label: '簽好了，送出', value: 'ok', variant: 'primary' }] });
  const pad = ctx.ui.signaturePad(body.querySelector('[data-role="sign-pad"]'));
  body.querySelector('[data-act="clear"]').addEventListener('click', () => pad.clear());
  const v = await p;
  const empty = pad.isEmpty();
  const dataUrl = empty ? '' : pad.toDataURL();
  if (typeof pad.destroy === 'function') pad.destroy();
  if (v !== 'ok') return false;
  if (empty) { ctx.ui.toast('請先簽名', 'warn'); return false; }
  ctx.ui.loading(true);
  let up;
  try { up = await uploadSignature(dataUrl); } finally { ctx.ui.loading(false); }
  if (!up.ok) { ctx.ui.toast(errText({ error: up.error }), 'danger'); return false; }
  const r = await send(ctx, 'apvSign', { ...base, sign_file: up.id }, '已簽名');
  return r.ok || r.conflict;
}
