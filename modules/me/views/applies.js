/**
 * modules/me/views/applies.js — 待審核裡的「新進同仁申請」（docs/self-apply/spec.md 第 3、4 節，Eason 2026-11-06）
 *
 * 名冊沒有的新人在登入頁送申請；這裡列出自己能審的（後端 unitPending 的 applies，已依審核者資格過濾，
 * 不含生日、地址）。每列：姓名、單位、職稱下拉（可改，Q3 A）、到職日（必填）、通過、退回（要原因）。
 * 通過＝後端當下給最新 DZY 編號、開帳號與打卡單；畫面跳出編號請審核者轉告新人（Q1 A）。
 * 兩處共用：「待審核」分頁（review.js）；只有「可新增同仁」例外、沒有待審核分頁的人放在「我的單位」上方（team.js）。
 */
'use strict';

import { titlesForUnit } from '../../staff-shared/org-fields.js';
import { ymd } from '../../staff-shared/clock-lib.js';

/** @returns {{html:(list:Array)=>string, onClick:(e:Event)=>Promise<boolean>, setOrg:(o:object)=>void}} */
export function createApplies(ctx, reload) {
  const esc = ctx.fmt.esc;
  let list = [];
  let org = null;

  function titleSelect(a) {
    const unit = org && (org.units || []).find((u) => u.code === a.unit);
    const titles = unit ? titlesForUnit(org, unit) : [];
    const opts = titles.length ? titles : [{ code: a.title, name: a.title_name || a.title }];
    return `<select class="input" data-role="apply-title" data-id="${esc(a.apply_id)}">${opts.map((t) =>
      `<option value="${esc(t.code)}"${t.code === a.title ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`;
  }

  function html(items) {
    list = Array.isArray(items) ? items : [];
    if (!list.length) return '';
    const today = ymd(new Date());
    const cards = list.map((a) => `
      <div class="card stack" data-role="apply-row" data-id="${esc(a.apply_id)}">
        <div class="card-row"><div class="card-title">${esc(a.name)}</div><span class="tag tag-warn">新進同仁申請</span></div>
        <div class="table-wrap"><table class="table"><tbody>
          <tr><th>申請單位</th><td>${esc([a.unit_name, a.dept_name].filter(Boolean).join('／') || a.unit)}</td></tr>
          <tr><th>手機</th><td>${esc(a.phone)}</td></tr>
          <tr><th>送出時間</th><td>${esc(a.created_at)}</td></tr>
        </tbody></table></div>
        <div class="form-grid-2">
          <div class="field"><label class="field-label">職稱（可改）</label>${titleSelect(a)}</div>
          <div class="field"><label class="field-label">到職日（必填）</label>
            <input class="input" type="date" data-role="apply-hire" data-id="${esc(a.apply_id)}" value="${esc(today)}"></div>
        </div>
        <div class="card-row">
          <button type="button" class="btn btn-primary" data-act="apply-approve" data-id="${esc(a.apply_id)}">通過</button>
          <button type="button" class="btn btn-danger" data-act="apply-reject" data-id="${esc(a.apply_id)}">退回</button>
        </div>
      </div>`).join('');
    return `<div class="card" data-role="apply-section"><div class="card-title">新進同仁申請（${list.length}）</div>
      <p class="text-muted">名冊上沒有、自己送申請的新人。請先確認是本人（打手機）、單位沒選錯；單位選錯請退回讓他重填。通過後系統才給員工編號。</p></div>${cards}`;
  }

  function domOf(s) { const d = document.createElement('div'); d.innerHTML = s; return d; }

  async function send(action, payload) {
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('me', action, payload); } finally { ctx.ui.loading(false); }
    if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '操作失敗，請稍後再試', 'danger'); return null; }
    return r;
  }

  async function onClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-act^="apply-"]') : null;
    if (!btn) return false;
    const root = e.currentTarget || document;
    const id = btn.getAttribute('data-id');
    const a = list.find((x) => x.apply_id === id);
    if (!a) return true;
    if (btn.getAttribute('data-act') === 'apply-approve') {
      const sel = root.querySelector(`[data-role="apply-title"][data-id="${id}"]`);
      const hireEl = root.querySelector(`[data-role="apply-hire"][data-id="${id}"]`);
      const title = sel ? sel.value : a.title;
      const hire = hireEl ? hireEl.value : '';
      if (!hire) { ctx.ui.toast('請填到職日', 'warn'); return true; }
      const tName = sel && sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : a.title_name;
      const body = domOf(`<p><b>請先確認是他本人</b>（當面或打手機 ${esc(a.phone)}）。</p>
        <p>通過後開帳號：${esc(a.unit_name)}／${esc(tName)}，到職日 ${esc(hire)}。</p>`);
      const v = await ctx.ui.dialog({ title: `通過 ${a.name}`, body, actions: [
        { label: '取消', value: null, variant: 'secondary' },
        { label: '已核對，通過', value: 'ok', variant: 'primary' }] });
      if (v !== 'ok') return true;
      const r = await send('applyApprove', { apply_id: id, title, hire_date: hire });
      if (!r) return true;
      const emp = (r.data && r.data.emp_no) || '';
      await ctx.ui.dialog({ title: '已通過',
        body: domOf(`<p data-role="apply-approved-emp">已通過，編號 <b class="emp-no">${esc(emp)}</b>，請告訴同仁用這個編號和他設的密碼登入。</p>
          <p class="field-hint">同仁也可以在登入頁「第一次使用 → 查申請進度」用姓名＋手機查到編號。</p>`),
        actions: [{ label: '知道了', value: 'ok', variant: 'primary' }] });
      await reload();
    } else {
      const body = domOf(`<div class="field"><label class="field-label" for="apl-reason">退回原因（必填，同仁查進度看得到）</label>
        <textarea class="input" id="apl-reason" rows="3" maxlength="100"></textarea></div>
        <p class="field-hint">退回後這筆申請作廢、不給編號；同仁改正後可以重新申請。</p>`);
      const v = await ctx.ui.dialog({ title: `退回 ${a.name}`, body, actions: [
        { label: '取消', value: null, variant: 'secondary' },
        { label: '退回', value: 'ok', variant: 'danger' }] });
      if (v !== 'ok') return true;
      const reason = body.querySelector('#apl-reason').value.trim();
      if (!reason) { ctx.ui.toast('請填寫退回原因', 'warn'); return true; }
      const r = await send('applyReject', { apply_id: id, reason });
      if (!r) return true;
      ctx.ui.toast('已退回', 'ok');
      await reload();
    }
    return true;
  }

  return { html, onClick, setOrg(o) { org = o; } };
}

/**
 * 只有「可新增同仁」例外（platform.unitstaff、沒有待審核分頁）的人：在「我的單位」上方放申請清單。
 * 沒有申請＝不顯示任何東西。回 unmount。
 */
export function mountApplies(el, ctx) {
  let alive = true;
  const ap = createApplies(ctx, load);
  async function load() {
    const [res, org] = await Promise.all([ctx.api.call('me', 'unitPending', {}), ctx.api.call('me', 'orgOptions', {})]);
    if (!alive) return;
    if (org && org.ok) ap.setOrg(org.data);
    el.innerHTML = res && res.ok ? ap.html(res.data.applies) : '';
  }
  const onClick = (e) => { ap.onClick(e); };
  el.addEventListener('click', onClick);
  load();
  return () => { alive = false; el.removeEventListener('click', onClick); };
}
