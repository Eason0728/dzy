/**
 * platform/views/login.js — 登入頁
 *
 * 正本規格：docs/spec.md §4.10（ctx.ui 簽章）、§6.1（開機流程 step 2：
 * auth.restore() 失敗就顯示這頁）、任務指示第 4 點（帳密欄、送出鈕、錯誤訊息區；
 * 前端節流是體驗，不是安全——真正的安全鎖在後端，5 次鎖 15 分鐘）。
 *
 * 匯出 render(el, app)：
 * - el：要畫進去的容器 DOM 節點（由呼叫方，預期是 shell.js，決定放在哪）。
 * - app：選填。登入成功時，若 app.onSuccess 是函式就呼叫一次（不帶參數；
 *   最新身分請呼叫方自己用 auth.getUser() 拿），讓呼叫方接手 spec §6.1
 *   step 3 起的開機流程（載入模組清單、畫首頁）。本檔不強求呼叫方一定要
 *   提供這個欄位——沒有就只是把畫面留在「登入成功」的狀態，不硬接手。
 * - 回傳一個 unmount 函式，清掉節流用的計時器（呼叫方可選擇要不要用）。
 *
 * 安全規則（任務指示第 4 點，逐條對應）：
 * - 密碼欄一律 type="password"、autocomplete="current-password"。
 * - 密碼只活在 submit handler 的區域變數：讀出 input.value → 直接交給
 *   auth.login() → 函式結束就沒有任何地方留著它的副本。絕不 console.log、
 *   絕不放進網址查詢字串（送出一律走 auth.js 內的 POST body）、絕不寫進
 *   localStorage／sessionStorage。
 * - 失敗時清空密碼欄，不讓密碼留在畫面上等下一次意外送出。
 *
 * 樣式一律用 platform/css/components.css 既有 class，不內嵌樣式、不新增色碼
 * ——錯誤訊息區借用既有的 .toast.toast-danger 樣式（危險色的輕量卡片），
 * 不是走 toast 的浮動堆疊機制，只是重用同一組既有 class。
 *
 * ui.js 是另一個任務同時在做的檔案，這裡照 spec §4.10 的簽章直接 import 使用
 * （loading／toast 兩個函式），不因為它可能還沒完成就自己刻一份 loading/toast。
 */

import { login } from '../auth.js';
import { loading, toast } from '../ui.js';
import { APP_NAME } from '../config.js';
import { esc } from '../fmt.js';

/** 連續失敗幾次後，前端先擋一段冷卻時間才讓使用者再送出（純體驗節流，見檔頭說明） */
// Eason 2026-08-14 指定：連續輸入錯誤三次之後才擋。與後端 Auth.gs 的
// AUTH_LOGIN_FAIL_LIMIT 必須一致，兩邊不同會出現「畫面還讓你按、後端已經鎖了」的錯亂。
const THROTTLE_AFTER_FAILURES = 3;
const THROTTLE_COOLDOWN_SEC = 30;

/** 手機一次只顯示一張品牌照片，依日期輪替——每天固定同一張，不會每次重整都跳，但長期三個品牌輪得到 */
const HERO_BRANDS = ['mala', 'mzt', 'yakiniku'];

function pickHero(today = new Date()) {
  const dayIndex = Math.floor(today.getTime() / 86400000);
  return HERO_BRANDS[((dayIndex % HERO_BRANDS.length) + HERO_BRANDS.length) % HERO_BRANDS.length];
}

export function render(el, app) {
  el.innerHTML = `
    <div class="login-bg" data-hero="${esc(pickHero())}">
      <div class="login-bg-panes" aria-hidden="true">
        <div class="login-bg-pane login-bg-pane--mala"></div>
        <div class="login-bg-pane login-bg-pane--mzt"></div>
        <div class="login-bg-pane login-bg-pane--yakiniku"></div>
      </div>
    <div class="page">
      <div class="card">
        <h1 class="card-title">${esc(APP_NAME)}</h1>
        <div class="toast toast-danger" data-role="error" hidden></div>
        <form data-role="form" class="stack" novalidate>
          <div class="field">
            <label class="field-label" for="login-username">帳號</label>
            <input class="input" id="login-username" name="username" type="text"
                   autocomplete="username" autocapitalize="off" autocorrect="off" required>
          </div>
          <div class="field">
            <label class="field-label" for="login-password">密碼</label>
            <input class="input" id="login-password" name="password" type="password"
                   autocomplete="current-password" required>
          </div>
          <button class="btn btn-primary btn-block" type="submit" data-role="submit">登入</button>
          <p class="field-hint" data-role="hint"></p>
        </form>
      </div>
    </div>
    </div>
  `;

  const form = el.querySelector('[data-role="form"]');
  const usernameInput = el.querySelector('#login-username');
  const passwordInput = el.querySelector('#login-password');
  const errorBox = el.querySelector('[data-role="error"]');
  const submitBtn = el.querySelector('[data-role="submit"]');
  const hint = el.querySelector('[data-role="hint"]');

  let failureCount = 0;
  let cooldownTimer = null;

  function showError(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    usernameInput.disabled = busy;
    passwordInput.disabled = busy;
  }

  /** 純體驗節流：擋使用者手殘連點，不是安全機制（安全機制在後端） */
  function startCooldown(seconds) {
    let remain = seconds;
    submitBtn.disabled = true;
    const tick = () => {
      if (remain <= 0) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
        submitBtn.disabled = false;
        hint.textContent = '';
        failureCount = 0;
        return;
      }
      hint.textContent = `嘗試次數過多，請等 ${remain} 秒再試一次`;
      remain -= 1;
    };
    tick();
    cooldownTimer = setInterval(tick, 1000);
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (cooldownTimer) return; // 冷卻中不受理送出

    const username = usernameInput.value.trim();
    const password = passwordInput.value; // 只在這個區域變數活一下，交給 auth.login() 後就沒了

    showError('');

    if (!username || !password) {
      showError('請輸入帳號與密碼');
      return;
    }

    setBusy(true);
    loading(true);
    let res;
    try {
      res = await login(username, password);
    } finally {
      loading(false);
      setBusy(false);
    }

    if (!res || res.ok !== true) {
      failureCount += 1;
      showError((res && res.error) || '登入失敗，請再試一次');
      passwordInput.value = ''; // 失敗就清掉密碼欄，不留在畫面上
      passwordInput.focus();

      if (failureCount >= THROTTLE_AFTER_FAILURES) {
        startCooldown(THROTTLE_COOLDOWN_SEC);
      }
      return;
    }

    failureCount = 0;
    showError('');
    passwordInput.value = '';
    toast('登入成功', 'ok');

    if (app && typeof app.onSuccess === 'function') {
      app.onSuccess();
    }
  });

  return function unmount() {
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  };
}
