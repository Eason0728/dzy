/**
 * modules/me/views/profile.js — 個人資料（docs/personnel/spec.md §6.2／§7.4）
 * 顯示狀態、已確認值與待確認值；可改品牌／單位／部門／職稱（要重新確認）、手機、地址。
 * 生日與姓名只能找後台改（生日是忘記密碼的驗證依據）。
 */
'use strict';

import { orgFieldsHtml, bindOrgFields, readOrgFields } from '../../staff-shared/org-fields.js';

const STATUS_TEXT = {
  pending: ['tag tag-warn', '等後台確認'],
  rejected: ['tag tag-danger', '被退回'],
  active: ['tag tag-ok', '已確認'],
  unclaimed: ['tag', '未開通'],
  disabled: ['tag', '已停用']
};

export function mountProfile(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';

  async function load() {
    const [res, org] = await Promise.all([ctx.api.call('me', 'myProfile', {}), ctx.api.call('me', 'orgOptions', {})]);
    if (!alive) return;
    if (!res.ok) { el.innerHTML = `<div class="card"><p>${esc(res.error || '讀不到資料')}</p></div>`; return; }
    if (res.data.none) {
      el.innerHTML = '<div class="card"><div class="card-title">這是系統帳號</div><p class="text-muted">系統帳號（例如 BOSS、會計）沒有個人資料。同仁請用自己的 DZY 編號登入。</p></div>';
      return;
    }
    draw(res.data, org.ok ? org.data : { brands: [], units: [], depts: [], titles: [] });
  }

  function orgLine(p, prefix) {
    const n = (k) => p[prefix + k + '_name'];
    return [n('brand'), n('unit'), n('dept'), n('title')].filter(Boolean).join('／');
  }

  function draw(p, org) {
    const [cls, txt] = STATUS_TEXT[p.status] || ['tag', p.status];
    const confirmed = orgLine(p, '');
    const pending = orgLine(p, 'p_');
    const initial = p.has_pending_change
      ? { brand: p.p_brand, unit: p.p_unit, dept: p.p_dept, title: p.p_title }
      : { brand: p.brand, unit: p.unit, dept: p.dept, title: p.title };
    el.innerHTML = `
      <div class="card">
        <div class="card-row"><div class="card-title">${esc(p.name)}　${esc(p.emp_no)}</div><span class="${cls}">${esc(txt)}</span></div>
        ${p.status === 'rejected' ? `<div class="toast toast-danger">退回原因：${esc(p.reject_reason)}。請修改後再按「送出」。</div>` : ''}
        <div class="table-wrap"><table class="table"><tbody>
          <tr><th>已確認</th><td>${esc(confirmed || '（還沒有）')}${(p.extra_dept_names || []).length ? `<div class="text-muted" data-role="extra-depts">兼任：${esc(p.extra_dept_names.join('、'))}</div>` : ''}</td></tr>
          ${pending ? `<tr><th>等確認</th><td>${esc(pending)}</td></tr>` : ''}
          <tr><th>生日</th><td>${esc(p.birthday)}<span class="text-muted">（要改請找後台）</span></td></tr>
        </tbody></table></div>
      </div>
      <form class="card stack" data-role="form" novalidate>
        <div class="card-title">修改資料</div>
        <div class="toast toast-danger" data-role="error" hidden></div>
        ${orgFieldsHtml('me')}
        <p class="field-hint">改品牌、單位、部門、職稱要等後台確認；確認前沿用原本的。</p>
        <div class="form-grid-2">
          <div class="field"><label class="field-label" for="me-phone">手機</label>
            <input class="input" id="me-phone" type="tel" inputmode="numeric" value="${esc(p.phone)}"></div>
          <div class="field"><label class="field-label" for="me-address">居住地址</label>
            <input class="input" id="me-address" type="text" value="${esc(p.address)}"></div>
        </div>
        <div class="field" data-role="curpw-wrap" hidden>
          <label class="field-label" for="me-curpw">目前的密碼（改手機要輸入）</label>
          <input class="input" id="me-curpw" type="password" autocomplete="current-password">
          <p class="field-hint">手機是忘記密碼時確認本人用的，改手機要先確認是你本人。</p>
        </div>
        <button class="btn btn-primary" type="submit" data-role="submit">${p.status === 'rejected' ? '送出' : '儲存'}</button>
      </form>`;
    bindOrgFields(el, 'me', org, initial);
    const form = el.querySelector('[data-role="form"]');
    const box = el.querySelector('[data-role="error"]');
    // 改手機要帶目前密碼（2026-10-12 後端修正：防偷到登入的人改手機再走忘記密碼搶帳號）
    const phoneEl = el.querySelector('#me-phone');
    const curpwWrap = el.querySelector('[data-role="curpw-wrap"]');
    const curpwEl = el.querySelector('#me-curpw');
    const cleanPhone = () => phoneEl.value.replace(/[\s-]/g, '');
    const phoneChanged = () => cleanPhone() !== String(p.phone || '');
    phoneEl.addEventListener('input', () => { curpwWrap.hidden = !phoneChanged(); });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const payload = Object.assign(readOrgFields(el, 'me'), {
        phone: cleanPhone(),
        address: el.querySelector('#me-address').value.trim()
      });
      if (phoneChanged()) {
        curpwWrap.hidden = false;
        if (!curpwEl.value) { box.textContent = '改手機要輸入目前的密碼'; box.hidden = false; curpwEl.focus(); return; }
        payload.current_password = curpwEl.value;
      }
      box.hidden = true;
      ctx.ui.loading(true);
      let r;
      try { r = await ctx.api.call('me', 'saveMyProfile', payload); } finally { ctx.ui.loading(false); }
      if (!alive) return;
      // 後端訊息原樣顯示（「改手機要輸入目前的密碼」「目前密碼不正確」「嘗試次數過多，請 15 分鐘後再試」）
      if (!r.ok) { box.textContent = r.error || '儲存失敗，請稍後再試'; box.hidden = false; return; }
      ctx.ui.toast(r.data.has_pending_change || r.data.status === 'pending' ? '已送出，等後台確認' : '已儲存', 'ok');
      draw(r.data, org);
    });
  }

  load();
  return () => { alive = false; };
}
