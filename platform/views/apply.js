/**
 * platform/views/apply.js — 新進同仁自行申請帳號（docs/self-apply/spec.md 第 4 節，Eason 2026-11-06）
 *
 * 名冊上找不到名字的新人在這裡送申請：姓名、手機、生日、地址、密碼（兩次）、品牌→單位→部門→職稱。
 * 送出不給編號、不登入；所選單位的主管在「我的資料 → 待審核」通過後才產生 DZY 編號，
 * 新人再到「查申請進度」用姓名＋手機看編號。
 * 登入前畫面，屬平台層；由 login.js 依 #/apply 掛進登入卡片。密碼只活在 submit handler 的區域變數。
 */

import { publicCall } from '../auth.js';
import { loading } from '../ui.js';
import { orgFieldsHtml, bindOrgFields, readOrgFields } from './org-fields.js';

export function renderApply(card, opts) {
  card.innerHTML = '<p class="pre-text">讀取中…</p>';
  loading(true);
  publicCall('orgOptions', {}).then((org) => {
    loading(false);
    if (!org || !org.ok) {
      card.innerHTML = `<h1 class="card-title">申請帳號</h1>
        <div class="toast toast-danger">選項讀取失敗，請稍後再試</div>
        <div class="login-links"><button type="button" class="link-btn" data-role="back">回登入</button></div>`;
      card.querySelector('[data-role="back"]').addEventListener('click', () => opts.onBack());
      return;
    }
    stepForm(card, opts, org.data);
  });
}

function stepForm(card, opts, org) {
  card.innerHTML = `
    <h1 class="card-title">新進同仁申請帳號</h1>
    <p class="pre-text">名冊上還沒有你的名字時，填這張申請；你選的單位主管審核通過後，才會給你員工編號。</p>
    <div class="toast toast-danger" data-role="error" hidden></div>
    <form class="stack" data-role="form" novalidate>
      <div class="field">
        <label class="field-label" for="apply-name">全名</label>
        <input class="input" id="apply-name" type="text" autocomplete="name" maxlength="20" required>
      </div>
      <div class="form-grid-2">
        <div class="field">
          <label class="field-label" for="apply-pw">設定密碼（8 碼以上）</label>
          <input class="input" id="apply-pw" type="password" autocomplete="new-password" required>
        </div>
        <div class="field">
          <label class="field-label" for="apply-pw2">再輸入一次</label>
          <input class="input" id="apply-pw2" type="password" autocomplete="new-password" required>
        </div>
      </div>
      ${orgFieldsHtml('apply')}
      <div class="form-grid-2">
        <div class="field">
          <label class="field-label" for="apply-birthday">生日</label>
          <input class="input" id="apply-birthday" type="date" required>
        </div>
        <div class="field">
          <label class="field-label" for="apply-phone">手機</label>
          <input class="input" id="apply-phone" type="tel" inputmode="numeric" placeholder="0912345678" required>
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="apply-address">居住地址</label>
        <input class="input" id="apply-address" type="text" autocomplete="street-address" required>
      </div>
      <p class="field-hint">送出後要等你選的單位主管審核。之後到「查申請進度」輸入姓名和手機，就能看到結果和員工編號，請記好這支手機號碼。</p>
      <button class="btn btn-primary btn-block" type="submit" data-role="submit">送出申請</button>
    </form>
    <div class="login-links">
      <a href="#/apply-status" data-role="to-status">查申請進度</a>
      <button type="button" class="link-btn" data-role="back">回登入</button>
    </div>`;
  const box = card.querySelector('[data-role="error"]');
  const showError = (m) => { box.textContent = m || ''; box.hidden = !m; };
  card.querySelector('[data-role="back"]').addEventListener('click', () => opts.onBack());
  bindOrgFields(card, 'apply', org, {});

  card.querySelector('[data-role="form"]').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = card.querySelector('#apply-name').value.trim();
    const pw = card.querySelector('#apply-pw').value;
    const pw2 = card.querySelector('#apply-pw2').value;
    if (!name) return showError('請輸入全名');
    if (pw.length < 8) return showError('密碼至少要 8 個字元');
    if (pw !== pw2) return showError('兩次輸入的密碼不一樣');
    const orgVals = readOrgFields(card, 'apply');
    if (!orgVals.brand || !orgVals.unit || !orgVals.title) return showError('請選擇品牌、單位、職稱');
    const phone = card.querySelector('#apply-phone').value.replace(/[\s-]/g, '');
    const payload = Object.assign({
      name,
      password: pw,
      birthday: card.querySelector('#apply-birthday').value,
      phone,
      address: card.querySelector('#apply-address').value.trim()
    }, orgVals);
    showError('');
    const btn = card.querySelector('[data-role="submit"]');
    btn.disabled = true;
    btn.textContent = '送出中，請稍候…';
    loading(true);
    let res;
    try {
      res = await publicCall('applySubmit', payload);
    } finally {
      loading(false);
      btn.disabled = false;
      btn.textContent = '送出申請';
    }
    if (!res || !res.ok) {
      showError((res && res.error) || '送出失敗');
      if (res && res.code === 'name_in_roster') {
        box.insertAdjacentHTML('beforeend', ' <a href="#/claim" data-role="to-claim">去「第一次使用」</a>');
      }
      return;
    }
    stepSent(card, opts);
  });
}

function stepSent(card, opts) {
  card.innerHTML = `
    <h1 class="card-title">申請已送出</h1>
    <div class="toast toast-ok" data-role="apply-sent">已送出，等你選的單位主管審核。</div>
    <p class="pre-text">審核通過後才會有員工編號。<br>請到「查申請進度」輸入姓名和手機查看；拿到編號後，用編號和剛才設的密碼登入。<br>等很久沒消息，請直接問你的店長或主管。</p>
    <a class="btn btn-primary btn-block" href="#/apply-status" data-role="to-status">查申請進度</a>
    <div class="login-links"><button type="button" class="link-btn" data-role="back">回登入頁</button></div>`;
  card.querySelector('[data-role="back"]').addEventListener('click', () => opts.onBack());
}
