/**
 * platform/views/apply-status.js — 查新進同仁申請進度（docs/self-apply/spec.md 第 2、4 節，Q1 A）
 *
 * 輸入姓名＋手機 → 等審核中／已通過（顯示員工編號）／被退回（顯示原因）／查無申請。
 * 後端同姓名查無 5 次會暫時擋（applyStatus），錯誤訊息照後端原樣顯示。
 */

import { publicCall } from '../auth.js';
import { loading } from '../ui.js';
import { esc } from '../fmt.js';

export function renderApplyStatus(card, opts) {
  card.innerHTML = `
    <h1 class="card-title">查申請進度</h1>
    <p class="pre-text">輸入申請時填的全名和手機。</p>
    <div class="toast toast-danger" data-role="error" hidden></div>
    <form class="stack" data-role="form" novalidate>
      <div class="field">
        <label class="field-label" for="apst-name">全名</label>
        <input class="input" id="apst-name" type="text" autocomplete="name" required>
      </div>
      <div class="field">
        <label class="field-label" for="apst-phone">手機</label>
        <input class="input" id="apst-phone" type="tel" inputmode="numeric" placeholder="0912345678" required>
      </div>
      <button class="btn btn-primary btn-block" type="submit" data-role="submit">查詢</button>
    </form>
    <div data-role="result"></div>
    <div class="login-links">
      <a href="#/apply" data-role="to-apply">我要申請帳號</a>
      <button type="button" class="link-btn" data-role="back">回登入</button>
    </div>`;
  const box = card.querySelector('[data-role="error"]');
  const out = card.querySelector('[data-role="result"]');
  const showError = (m) => { box.textContent = m || ''; box.hidden = !m; };
  card.querySelector('[data-role="back"]').addEventListener('click', () => opts.onBack());

  card.querySelector('[data-role="form"]').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = card.querySelector('#apst-name').value.trim();
    const phone = card.querySelector('#apst-phone').value.replace(/[\s-]/g, '');
    if (!name) return showError('請輸入全名');
    if (!/^09[0-9]{8}$/.test(phone)) return showError('手機要是 09 開頭的 10 碼數字');
    showError('');
    out.innerHTML = '';
    const btn = card.querySelector('[data-role="submit"]');
    btn.disabled = true;
    loading(true);
    let res;
    try {
      res = await publicCall('applyStatus', { name, phone });
    } finally {
      loading(false);
      btn.disabled = false;
    }
    if (!res || !res.ok) return showError((res && res.error) || '查詢失敗，請稍後再試');
    const d = res.data || {};
    if (d.status === 'approved') {
      out.innerHTML = `<div class="toast toast-ok" data-role="apply-approved">已通過！你的員工編號是 <span class="emp-no">${esc(d.emp_no)}</span></div>
        <p class="pre-text">回登入頁，用這個編號和申請時設的密碼登入。</p>
        <button class="btn btn-primary btn-block" type="button" data-role="to-login">用這個編號登入</button>`;
      out.querySelector('[data-role="to-login"]').addEventListener('click', () => opts.onBack(d.emp_no));
    } else if (d.status === 'rejected') {
      out.innerHTML = `<div class="toast toast-danger" data-role="apply-rejected">申請被退回：${esc(d.reason || '請問你的主管')}</div>
        <p class="pre-text">資料改正後可以重新申請；有疑問請直接問你的店長或主管。</p>`;
    } else if (d.status === 'pending') {
      out.innerHTML = '<div class="toast toast-warn" data-role="apply-pending">還在等主管審核，請稍後再查，或直接問你的店長或主管。</div>';
    } else {
      out.innerHTML = '<div class="toast toast-warn" data-role="apply-none">查不到這個姓名和手機的申請，請確認輸入的跟申請時一樣。</div>';
    }
  });
}
