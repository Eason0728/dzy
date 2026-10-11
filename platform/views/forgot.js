/**
 * platform/views/forgot.js — 忘記密碼（docs/personnel/spec.md §6.6／§7.3）
 *
 * 編號＋生日＋手機三樣都對才能設新密碼。錯誤訊息照後端原樣顯示（後端刻意不透露是哪一欄錯、
 * 也不回剩餘次數，這裡不自己加）。成功回登入頁並帶入編號。
 */

import { publicCall } from '../auth.js';
import { loading, toast } from '../ui.js';

export function renderForgot(card, opts) {
  card.innerHTML = `
    <h1 class="card-title">忘記密碼</h1>
    <p class="pre-text">輸入編號、生日、手機確認是你本人，就能設定新密碼。</p>
    <div class="toast toast-danger" data-role="error" hidden></div>
    <form class="stack" data-role="form" novalidate>
      <div class="field">
        <label class="field-label" for="forgot-emp">員工編號</label>
        <input class="input" id="forgot-emp" type="text" placeholder="DZY001" autocapitalize="characters" autocomplete="username" required>
      </div>
      <div class="form-grid-2">
        <div class="field">
          <label class="field-label" for="forgot-birthday">生日</label>
          <input class="input" id="forgot-birthday" type="date" required>
        </div>
        <div class="field">
          <label class="field-label" for="forgot-phone">手機</label>
          <input class="input" id="forgot-phone" type="tel" inputmode="numeric" placeholder="0912345678" required>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="field">
          <label class="field-label" for="forgot-pw">新密碼（8 碼以上）</label>
          <input class="input" id="forgot-pw" type="password" autocomplete="new-password" required>
        </div>
        <div class="field">
          <label class="field-label" for="forgot-pw2">再輸入一次</label>
          <input class="input" id="forgot-pw2" type="password" autocomplete="new-password" required>
        </div>
      </div>
      <button class="btn btn-primary btn-block" type="submit" data-role="submit">設定新密碼</button>
    </form>
    <div class="login-links"><button type="button" class="link-btn" data-role="back">回登入</button></div>`;

  const box = card.querySelector('[data-role="error"]');
  const showError = (m) => { box.textContent = m || ''; box.hidden = !m; };
  card.querySelector('[data-role="back"]').addEventListener('click', () => opts.onBack());

  card.querySelector('[data-role="form"]').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const empNo = card.querySelector('#forgot-emp').value.trim().toUpperCase();
    const pw = card.querySelector('#forgot-pw').value;
    if (!/^DZY[0-9]{3}$/.test(empNo)) return showError('編號格式是 DZY 加三位數字，例如 DZY001');
    if (pw.length < 8) return showError('新密碼至少要 8 個字元');
    if (pw !== card.querySelector('#forgot-pw2').value) return showError('兩次輸入的新密碼不一樣');
    showError('');
    const btn = card.querySelector('[data-role="submit"]');
    btn.disabled = true;
    btn.textContent = '確認中…';
    loading(true);
    let res;
    try {
      res = await publicCall('forgotReset', {
        emp_no: empNo,
        birthday: card.querySelector('#forgot-birthday').value,
        phone: card.querySelector('#forgot-phone').value.replace(/[\s-]/g, ''),
        new_password: pw
      });
    } finally {
      loading(false);
      btn.disabled = false;
      btn.textContent = '設定新密碼';
    }
    if (!res.ok) return showError(res.error);
    toast('密碼已更新，請用新密碼登入', 'ok');
    opts.onDone(empNo);
  });
}
