/**
 * platform/views/claim.js — 第一次使用（docs/personnel/spec.md §7.2）
 *
 * 三步：輸入全名 → 看到自己的編號、設密碼、填個人資料 → 送出，等單位主管審核通過才能登入
 *（2026-10-12 Eason：認領只是核對編號，不自動登入）。
 * 登入前畫面，屬平台層（不是模組）；由 login.js 依 #/claim 掛進登入卡片。
 * 密碼只活在 submit handler 的區域變數，交給 auth.claimSubmit() 後就沒有副本（同 login.js 的規則）。
 */

import { publicCall, claimSubmit } from '../auth.js';
import { loading } from '../ui.js';
import { esc } from '../fmt.js';
import { orgFieldsHtml, bindOrgFields, readOrgFields } from './org-fields.js';

export function renderClaim(card, opts) {
  stepName(card, opts);
}

function errorBoxHtml() {
  return '<div class="toast toast-danger" data-role="error" hidden></div>';
}
function showError(card, msg) {
  const box = card.querySelector('[data-role="error"]');
  if (!box) return;
  box.textContent = msg || '';
  box.hidden = !msg;
}

function stepName(card, opts) {
  card.innerHTML = `
    <h1 class="card-title">第一次使用</h1>
    <p class="pre-text">請輸入你的全名（跟公司名冊上的一樣），系統會帶出你的員工編號。</p>
    ${errorBoxHtml()}
    <form class="stack" data-role="form" novalidate>
      <div class="field">
        <label class="field-label" for="claim-name">全名</label>
        <input class="input" id="claim-name" type="text" autocomplete="name" required>
      </div>
      <button class="btn btn-primary btn-block" type="submit" data-role="submit">查詢我的編號</button>
    </form>
    <div class="login-links"><button type="button" class="link-btn" data-role="back">回登入</button></div>`;
  card.querySelector('[data-role="back"]').addEventListener('click', () => opts.onBack());
  const input = card.querySelector('#claim-name');
  input.focus();
  card.querySelector('[data-role="form"]').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = input.value.trim();
    if (!name) return showError(card, '請輸入全名');
    showError(card, '');
    const btn = card.querySelector('[data-role="submit"]');
    btn.disabled = true;
    btn.textContent = '查詢中…';
    loading(true);
    let lk;
    let org;
    try {
      [lk, org] = await Promise.all([publicCall('claimLookup', { name }), publicCall('orgOptions', {})]);
    } finally {
      loading(false);
      btn.disabled = false;
      btn.textContent = '查詢我的編號';
    }
    if (!lk.ok) return showError(card, lk.error);
    if (!org.ok) return showError(card, org.error || '選項讀取失敗，請稍後再試');
    stepForm(card, opts, name, lk.data.emp_no, org.data);
  });
}

function stepForm(card, opts, name, empNo, org) {
  card.innerHTML = `
    <h1 class="card-title">你的編號是</h1>
    <p class="pre-text"><span class="emp-no">${esc(empNo)}</span><br>${esc(name)}，之後登入請用這個編號。</p>
    ${errorBoxHtml()}
    <form class="stack" data-role="form" novalidate>
      <div class="form-grid-2">
        <div class="field">
          <label class="field-label" for="claim-pw">設定密碼（8 碼以上）</label>
          <input class="input" id="claim-pw" type="password" autocomplete="new-password" required>
        </div>
        <div class="field">
          <label class="field-label" for="claim-pw2">再輸入一次</label>
          <input class="input" id="claim-pw2" type="password" autocomplete="new-password" required>
        </div>
      </div>
      ${orgFieldsHtml('claim')}
      <div class="form-grid-2">
        <div class="field">
          <label class="field-label" for="claim-birthday">生日</label>
          <input class="input" id="claim-birthday" type="date" required>
        </div>
        <div class="field">
          <label class="field-label" for="claim-phone">手機</label>
          <input class="input" id="claim-phone" type="tel" inputmode="numeric" placeholder="0912345678" required>
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="claim-address">居住地址</label>
        <input class="input" id="claim-address" type="text" autocomplete="street-address" required>
      </div>
      <p class="field-hint">送出後要等你的單位主管審核，通過後才能用編號登入。生日和手機是主管核對本人、以及忘記密碼時確認本人用的，請填正確。</p>
      <button class="btn btn-primary btn-block" type="submit" data-role="submit">送出審核</button>
    </form>
    <div class="login-links"><button type="button" class="link-btn" data-role="back">這不是我，回上一步</button></div>`;
  card.querySelector('[data-role="back"]').addEventListener('click', () => stepName(card, opts));
  bindOrgFields(card, 'claim', org, {});

  card.querySelector('[data-role="form"]').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pw = card.querySelector('#claim-pw').value;
    const pw2 = card.querySelector('#claim-pw2').value;
    if (pw.length < 8) return showError(card, '密碼至少要 8 個字元');
    if (pw !== pw2) return showError(card, '兩次輸入的密碼不一樣');
    const orgVals = readOrgFields(card, 'claim');
    if (!orgVals.brand || !orgVals.unit || !orgVals.title) return showError(card, '請選擇品牌、單位、職稱');
    const payload = Object.assign({
      name,
      emp_no: empNo,
      password: pw,
      birthday: card.querySelector('#claim-birthday').value,
      phone: card.querySelector('#claim-phone').value.replace(/[\s-]/g, ''),
      address: card.querySelector('#claim-address').value.trim()
    }, orgVals);
    showError(card, '');
    const btn = card.querySelector('[data-role="submit"]');
    btn.disabled = true;
    btn.textContent = '送出中，請稍候…';
    loading(true);
    let res;
    try {
      res = await claimSubmit(payload);
    } finally {
      loading(false);
      btn.disabled = false;
      btn.textContent = '送出審核';
    }
    if (!res.ok) return showError(card, res.error);
    stepSent(card, opts, empNo);
  });
}

/** 送出完成：不登入，告訴他等主管審核、之後怎麼登入 */
function stepSent(card, opts, empNo) {
  card.innerHTML = `
    <h1 class="card-title">已送出</h1>
    <div class="toast toast-ok" data-role="claim-sent">已送出，等你的單位主管審核通過後就能登入。</div>
    <p class="pre-text">你的編號是 <span class="emp-no">${esc(empNo)}</span>。<br>審核通過後，回登入頁用這個編號和剛才設的密碼登入。<br>等很久沒消息，請直接問你的店長或主管。</p>
    <button class="btn btn-primary btn-block" type="button" data-role="back">回登入頁</button>`;
  card.querySelector('[data-role="back"]').addEventListener('click', () => opts.onBack(empNo));
}
