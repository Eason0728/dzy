/**
 * 全系統唯一一份共用 UI 元件 —— toast / loading / confirm / dialog / signaturePad
 *
 * 正本規格：docs/spec.md §4.10（ctx.ui 的逐字元簽章）、§8（樣式系統）。
 * 每個模組一律透過 ctx.ui 拿到這五個函式，不得自己再刻一份
 * （教訓來源：宿舍合約系統把簽名板複製了兩份、esc() 複製了三份）。
 *
 * 規則：
 *   - 只能用 platform/css/components.css 既有的 class，不內嵌樣式、不新增色碼。
 *     簽名板需要的顏色一律用 getComputedStyle 讀 tokens.css 的 CSS 變數，不寫死色碼。
 *   - 訊息一律經過 fmt.js 的 esc() 轉義，這裡不重刻一份。
 *   - 本檔預期執行在瀏覽器環境（用到全域 document / window / getComputedStyle）。
 */

import { esc } from './fmt.js';

/* ============================================================
   toast(message, type)
   ============================================================ */

const TOAST_TYPES = new Set(['ok', 'warn', 'danger', 'info']);
const TOAST_DURATION_MS = 3200;

let toastStackEl = null;

function ensureToastStack() {
  if (toastStackEl && document.body.contains(toastStackEl)) return toastStackEl;
  toastStackEl = document.createElement('div');
  toastStackEl.className = 'toast-stack';
  document.body.appendChild(toastStackEl);
  return toastStackEl;
}

/**
 * type: 'ok' | 'warn' | 'danger' | 'info'（預設 'info'）→ void
 * 同時多則會疊在同一個 .toast-stack 裡（components.css 已用 flex+gap 排開，
 * 不會互相蓋住），每則數秒後自動移除。
 */
export function toast(message, type) {
  const t = TOAST_TYPES.has(type) ? type : 'info';
  const stack = ensureToastStack();

  const el = document.createElement('div');
  el.className = t === 'info' ? 'toast' : `toast toast-${t}`;
  el.innerHTML = esc(message);
  stack.appendChild(el);

  setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, TOAST_DURATION_MS);
}

/* ============================================================
   loading(on)
   ============================================================ */

// 可重入計數器：兩支非同步請求同時進行時，先回來的那支不該把畫面的
// 載入中關掉，所以要連呼叫兩次 loading(true) 之後、連呼叫兩次
// loading(false) 才真的關閉。
let loadingCount = 0;
let loadingOverlayEl = null;

function showLoadingOverlay() {
  if (loadingOverlayEl) return;
  loadingOverlayEl = document.createElement('div');
  loadingOverlayEl.className = 'loading-overlay';

  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  loadingOverlayEl.appendChild(spinner);

  document.body.appendChild(loadingOverlayEl);
}

function hideLoadingOverlay() {
  if (loadingOverlayEl && loadingOverlayEl.parentNode) {
    loadingOverlayEl.parentNode.removeChild(loadingOverlayEl);
  }
  loadingOverlayEl = null;
}

/** on: boolean → void。可重入（內部計數器）。 */
export function loading(on) {
  if (on) {
    loadingCount += 1;
    if (loadingCount === 1) showLoadingOverlay();
    return;
  }

  if (loadingCount === 0) return; // 沒有對應的 true，忽略多餘的 false
  loadingCount -= 1;
  if (loadingCount === 0) hideLoadingOverlay();
}

/* ============================================================
   dialog({ title, body, actions }) → Promise<value>
   ============================================================ */

const VARIANT_CLASS = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  danger: 'btn-danger'
};

function focusableEls(container) {
  const candidates = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.tagName === 'BUTTON' && !child.hasAttribute?.('disabled')) {
        candidates.push(child);
      }
      walk(child);
    }
  };
  walk(container);
  return candidates;
}

/**
 * actions: [{ label, value, variant }]，variant: 'primary'|'secondary'|'danger'
 * → Promise<value>；使用者按 Esc 或點背景遮罩關閉 → Promise<null>。
 * 開啟時焦點進入對話框，關閉後焦點還給開啟前的元素。
 */
export function dialog(options) {
  const { title, body, actions } = options || {};

  // 2026-08-15 對抗審查補：對外暴露 close()。
  // 原本 close() 只是內部閉包，呼叫端拿不到——結果是「模組卸載時要能關掉開著的對話框」
  // 這件事用共用元件反而做不到，模組只好自己刻一套彈窗，共用元件形同虛設。
  // 回傳值仍然是可以 await 的 Promise（簽章沒變），只是多掛一個 close(value) 方法。
  let closeHandle = null;

  const promise = new Promise((resolve) => {
    const previousActive = document.activeElement;

    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    const box = document.createElement('div');
    box.className = 'dialog';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('tabindex', '-1');

    if (title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'dialog-title';
      titleEl.innerHTML = esc(title);
      box.appendChild(titleEl);
    }

    if (body) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'dialog-body';
      // body 可以是字串（一律轉義，防注入）或已經建好的 DOM 節點（原樣放進去）。
      // 支援 DOM 節點是 2026-08-14 補的：原本只吃純文字，導致「要放輸入欄的對話框」
      // 做不出來，人員管理模組只好自己刻一套彈窗——那正是這個專案要消滅的重複。
      // 放節點的責任在呼叫端：節點裡的使用者資料要自己先經過 esc()。
      if (typeof body === 'string') {
        bodyEl.innerHTML = esc(body);
      } else if (body && typeof body === 'object' && body.nodeType === 1) {
        bodyEl.appendChild(body);
      } else {
        bodyEl.innerHTML = esc(String(body));
      }
      box.appendChild(bodyEl);
    }

    const actionsEl = document.createElement('div');
    actionsEl.className = 'dialog-actions';

    const list = Array.isArray(actions) ? actions : [];
    for (const action of list) {
      const variantClass = VARIANT_CLASS[action && action.variant] || VARIANT_CLASS.secondary;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${variantClass}`;
      btn.innerHTML = esc(action && action.label);
      btn.addEventListener('click', () => close(action ? action.value : null));
      actionsEl.appendChild(btn);
    }
    box.appendChild(actionsEl);
    overlay.appendChild(box);

    function onKeydown(e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault?.();
        close(null);
        return;
      }
      // 簡單 focus trap：Tab／Shift+Tab 只在對話框內的按鈕之間循環
      if (e.key === 'Tab') {
        const items = focusableEls(box);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault?.();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault?.();
          first.focus();
        }
      }
    }

    function onOverlayClick(e) {
      if (e.target === overlay) close(null);
    }

    let closed = false;
    function close(value) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.removeEventListener('click', onOverlayClick);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (previousActive && typeof previousActive.focus === 'function') {
        previousActive.focus();
      }
      resolve(value === undefined ? null : value);
    }
    closeHandle = close;

    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown, true);

    document.body.appendChild(overlay);

    const firstFocusable = focusableEls(box)[0];
    (firstFocusable || box).focus();
  });

  /** 從外部強制關閉（模組 unmount 時用）。已經關掉再呼叫是安全的，不會重複 resolve。 */
  promise.close = (value) => { if (closeHandle) closeHandle(value); };
  return promise;
}

/**
 * message → Promise<boolean>（取消為 false，確定為 true）。
 * 直接用 dialog() 實作，不另寫一套。
 */
export function confirm(message) {
  return dialog({
    body: message,
    actions: [
      { label: '取消', value: false, variant: 'secondary' },
      { label: '確定', value: true, variant: 'primary' }
    ]
  }).then((value) => value === true);
}

/* ============================================================
   signaturePad(canvasEl) → { isEmpty(), toDataURL(), clear() }
   ============================================================ */

/** 從 tokens.css 讀 CSS 變數，不在 JS 裡寫死色碼 */
function cssVar(name) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name);
  return value ? value.trim() : '';
}

function pointerPos(canvasEl, e) {
  const rect = canvasEl.getBoundingClientRect();
  const point = e.touches && e.touches.length ? e.touches[0] : e;
  return { x: point.clientX - rect.left, y: point.clientY - rect.top };
}

/**
 * 手機觸控與桌機滑鼠都可簽名；處理 devicePixelRatio 讓高解析螢幕不糊。
 * clear() 之後 isEmpty() 必為 true。
 */
export function signaturePad(canvasEl) {
  const ctx = canvasEl.getContext('2d');

  // 依目前版面尺寸（乘上 devicePixelRatio）設定畫布解析度；設定 canvasEl.width/height
  // 會重置整個 2D context 狀態，所以每次真的改尺寸後都要重新套用線條樣式。
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvasEl.getBoundingClientRect();
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    // 版面尚未就緒時 rect 會是 0（例如畫布剛插入 DOM、樣式表還沒套用完），
    // 這時候先不要把畫布釘死在 1px 解析度，等下一輪畫面更新後再試一次。
    if (w < 2 || h < 2) return false;
    canvasEl.width = w;
    canvasEl.height = h;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = cssVar('--ink');
    return true;
  }

  if (!resize() && typeof requestAnimationFrame === 'function') {
    // 這麼早（下一次畫面更新之前）使用者不可能已經簽了名，補一次量測是安全的。
    requestAnimationFrame(resize);
  }

  let drawing = false;
  let dirty = false;
  let last = null;

  function start(e) {
    e.preventDefault?.();
    drawing = true;
    last = pointerPos(canvasEl, e);
  }

  function move(e) {
    if (!drawing) return;
    e.preventDefault?.();
    const p = pointerPos(canvasEl, e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    dirty = true;
  }

  function end() {
    drawing = false;
    last = null;
  }

  canvasEl.addEventListener('mousedown', start);
  canvasEl.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvasEl.addEventListener('touchstart', start, { passive: false });
  canvasEl.addEventListener('touchmove', move, { passive: false });
  canvasEl.addEventListener('touchend', end);
  canvasEl.addEventListener('touchcancel', end);

  function clear() {
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    dirty = false;
  }

  /**
   * 解除所有監聽（2026-08-15 對抗審查補）。
   * 原本只回傳三個方法，沒有解除的路——但這支掛了七個監聽，其中
   * `window` 上的 mouseup 是掛在全域的。宿舍模組會反覆進出簽名畫面，
   * 每進一次就多累積一組，模組 unmount 也帶不走。
   * 模組在 unmount 時必須呼叫這支。
   */
  function destroy() {
    canvasEl.removeEventListener('mousedown', start);
    canvasEl.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', end);
    canvasEl.removeEventListener('touchstart', start);
    canvasEl.removeEventListener('touchmove', move);
    canvasEl.removeEventListener('touchend', end);
    canvasEl.removeEventListener('touchcancel', end);
  }

  return {
    isEmpty: () => !dirty,
    toDataURL: () => canvasEl.toDataURL('image/png'),
    clear,
    destroy
  };
}
