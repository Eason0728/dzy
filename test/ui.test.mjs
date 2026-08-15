// ui.js 單元測試 —— 涵蓋 docs/spec.md §4.10 定義的 ctx.ui 五個函式。
// 純 node 執行，無第三方套件，無 jsdom：node test/ui.test.mjs
//
// 因為沒有 jsdom，這裡自己刻一份「最小 DOM stub」（FakeElement / FakeDocument /
// FakeWindow），只做到 ui.js 實際會用到的那些 DOM API：createElement／
// appendChild／removeChild／classList／addEventListener／dispatchEvent／
// getBoundingClientRect／canvas 2d context／getComputedStyle。
// 互動細節（真的用滑鼠拖曳、真的按 Esc 鍵、畫面疊放）另外用 Playwright 對
// test/ui-preview.html 做手動驗收，這裡只驗證邏輯正確性。

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push({ name, err });
  }
}

async function at(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push({ name, err });
  }
}

// ============================================================
// 最小 DOM stub
// ============================================================

class FakeClassList {
  constructor() {
    this._set = new Set();
  }
  add(...names) {
    for (const n of names) if (n) this._set.add(n);
  }
  remove(...names) {
    for (const n of names) this._set.delete(n);
  }
  contains(name) {
    return this._set.has(name);
  }
  toString() {
    return [...this._set].join(' ');
  }
}

function makeFakeCanvasContext() {
  return {
    scale() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    clearRect() {},
    set lineWidth(v) {},
    set lineCap(v) {},
    set lineJoin(v) {},
    set strokeStyle(v) {}
  };
}

class FakeElement extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = String(tagName || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.style = {};
    this._attrs = {};
    this._textContent = '';
    this._innerHTML = '';
    // canvas 用得到，其餘元素預設值也無妨
    this.width = 300;
    this.height = 150;
    this._rect = { width: 300, height: 150, left: 0, top: 0 };
  }

  get className() {
    return this.classList.toString();
  }
  set className(v) {
    this.classList = new FakeClassList();
    String(v)
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => this.classList.add(c));
  }

  setAttribute(name, value) {
    this._attrs[name] = String(value);
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name);
  }
  removeAttribute(name) {
    delete this._attrs[name];
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  contains(node) {
    let n = node;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }

  get textContent() {
    return this._textContent;
  }
  set textContent(v) {
    this._textContent = String(v);
    this.children = [];
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(v) {
    this._innerHTML = String(v);
  }

  getBoundingClientRect() {
    return this._rect;
  }

  focus() {
    fakeDocument.activeElement = this;
    this.dispatchEvent(new Event('focus'));
  }
  blur() {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = fakeDocument.body;
  }

  getContext(type) {
    if (type !== '2d') return null;
    if (!this._ctx) this._ctx = makeFakeCanvasContext();
    return this._ctx;
  }
  toDataURL() {
    return 'data:image/png;base64,FAKE';
  }
}

class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.documentElement = new FakeElement('html');
    this.body = new FakeElement('body');
    this.activeElement = this.body;
  }
  createElement(tag) {
    return new FakeElement(tag);
  }
}

class FakeWindow extends EventTarget {
  constructor() {
    super();
    this.devicePixelRatio = 2;
  }
}

const fakeDocument = new FakeDocument();
const fakeWindow = new FakeWindow();

globalThis.document = fakeDocument;
globalThis.window = fakeWindow;
globalThis.getComputedStyle = (el) => ({
  getPropertyValue(name) {
    if (name === '--ink') return '#1c1a19';
    return '';
  }
});

function fireMouse(el, type, x, y) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  e.clientX = x;
  e.clientY = y;
  el.dispatchEvent(e);
}

function fireTouch(el, type, x, y) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  e.touches = [{ clientX: x, clientY: y }];
  el.dispatchEvent(e);
}

function fireKey(target, type, key, extra) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  e.key = key;
  if (extra) Object.assign(e, extra);
  target.dispatchEvent(e);
}

// 模組必須在上面的全域 stub 就位之後才 import，
// 因為 ui.js 內部用的是裸露的 document / window / getComputedStyle。
const { toast, loading, confirm, dialog, signaturePad } = await import('../platform/ui.js');

// ============================================================
// toast()
// ============================================================

t('toast: 訊息經過 esc() 轉義', () => {
  toast('<b>hi</b>', 'ok');
  const stack = fakeDocument.body.children.find((c) => c.className === 'toast-stack');
  const last = stack.children[stack.children.length - 1];
  assert.equal(last.innerHTML, '&lt;b&gt;hi&lt;/b&gt;');
});

t('toast: type 對應正確 class', () => {
  toast('a', 'ok');
  toast('b', 'warn');
  toast('c', 'danger');
  toast('d'); // 預設 info
  toast('e', 'not-a-real-type'); // 非法值也視為 info
  const stack = fakeDocument.body.children.find((c) => c.className === 'toast-stack');
  const last5 = stack.children.slice(-5);
  assert.equal(last5[0].className, 'toast toast-ok');
  assert.equal(last5[1].className, 'toast toast-warn');
  assert.equal(last5[2].className, 'toast toast-danger');
  assert.equal(last5[3].className, 'toast');
  assert.equal(last5[4].className, 'toast');
});

t('toast: 連開三則同時存在（疊著顯示，不互相覆蓋）', () => {
  const originalSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn) => {
    timers.push(fn);
    return timers.length;
  };
  try {
    const stack = fakeDocument.body.children.find((c) => c.className === 'toast-stack');
    const before = stack.children.length;
    toast('第一則', 'ok');
    toast('第二則', 'warn');
    toast('第三則', 'danger');
    assert.equal(stack.children.length, before + 3);
    // 尚未觸發計時器之前，三則都還在（不是自動被下一則蓋掉/移除）
    assert.equal(stack.children.length >= 3, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

t('toast: 逾時後自動從畫面移除', () => {
  const originalSetTimeout = globalThis.setTimeout;
  let capturedFn = null;
  globalThis.setTimeout = (fn) => {
    capturedFn = fn;
    return 1;
  };
  try {
    const stack = fakeDocument.body.children.find((c) => c.className === 'toast-stack');
    const before = stack.children.length;
    toast('要消失的訊息', 'ok');
    assert.equal(stack.children.length, before + 1);
    capturedFn(); // 模擬計時器觸發
    assert.equal(stack.children.length, before);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

// ============================================================
// loading()：可重入計數器
// ============================================================

function hasLoadingOverlay() {
  return fakeDocument.body.children.some((c) => c.className === 'loading-overlay');
}

t('loading: 單次開關', () => {
  assert.equal(hasLoadingOverlay(), false);
  loading(true);
  assert.equal(hasLoadingOverlay(), true);
  loading(false);
  assert.equal(hasLoadingOverlay(), false);
});

t('loading: 可重入——連兩次 true 要連兩次 false 才真的關閉', () => {
  assert.equal(hasLoadingOverlay(), false);
  loading(true);
  loading(true);
  assert.equal(hasLoadingOverlay(), true, '兩次 true 後應顯示載入中');
  loading(false);
  assert.equal(hasLoadingOverlay(), true, '只關一次 false，載入中仍應顯示');
  loading(false);
  assert.equal(hasLoadingOverlay(), false, '第二次 false 之後才真的關閉');
});

t('loading: 多餘的 false 不會出錯、也不影響之後的開關', () => {
  loading(false); // 沒有對應的 true，應該安靜忽略
  assert.equal(hasLoadingOverlay(), false);
  loading(true);
  assert.equal(hasLoadingOverlay(), true);
  loading(false);
  assert.equal(hasLoadingOverlay(), false);
});

// ============================================================
// dialog() / confirm()
// ============================================================

await at('dialog: 點選按鈕以其 value resolve', async () => {
  const p = dialog({
    title: '標題',
    body: '內文',
    actions: [
      { label: '取消', value: 'cancel', variant: 'secondary' },
      { label: '確定', value: 'ok', variant: 'primary' }
    ]
  });
  const overlay = fakeDocument.body.children[fakeDocument.body.children.length - 1];
  const box = overlay.children.find((c) => c.className === 'dialog');
  const actionsEl = box.children.find((c) => c.className === 'dialog-actions');
  const [cancelBtn, okBtn] = actionsEl.children;
  assert.equal(cancelBtn.className, 'btn btn-secondary');
  assert.equal(okBtn.className, 'btn btn-primary');
  okBtn.dispatchEvent(new Event('click', { bubbles: true }));
  const value = await p;
  assert.equal(value, 'ok');
  // 關閉後 overlay 應該從 DOM 移除
  assert.equal(fakeDocument.body.contains(overlay), false);
});

await at('dialog: Esc 關閉 → resolve null', async () => {
  const p = dialog({ body: '按 Esc 看看' });
  fireKey(fakeDocument, 'keydown', 'Escape');
  const value = await p;
  assert.equal(value, null);
});

await at('dialog: 點背景遮罩關閉 → resolve null', async () => {
  const p = dialog({ body: '點背景看看' });
  const overlay = fakeDocument.body.children[fakeDocument.body.children.length - 1];
  overlay.dispatchEvent(new Event('click', { bubbles: true }));
  const value = await p;
  assert.equal(value, null);
});

await at('dialog: 點對話框本體（非遮罩）不應關閉', async () => {
  const p = dialog({
    body: '點框內',
    actions: [{ label: '確定', value: true, variant: 'primary' }]
  });
  const overlay = fakeDocument.body.children[fakeDocument.body.children.length - 1];
  const box = overlay.children.find((c) => c.className === 'dialog');
  // 直接對 box dispatch click：target 是 box 本身，不是 overlay，理當不觸發關閉
  box.dispatchEvent(new Event('click', { bubbles: true }));
  assert.equal(fakeDocument.body.contains(overlay), true, '點對話框本體不應該關閉');
  // 收尾：真的關掉，避免影響後續測試
  const actionsEl = box.children.find((c) => c.className === 'dialog-actions');
  actionsEl.children[0].dispatchEvent(new Event('click', { bubbles: true }));
  await p;
});

await at('dialog: title/body/label 都經過 esc() 轉義', async () => {
  const p = dialog({
    title: '<x>標題',
    body: 'A & B',
    actions: [{ label: "O'Brien", value: 1, variant: 'primary' }]
  });
  const overlay = fakeDocument.body.children[fakeDocument.body.children.length - 1];
  const box = overlay.children.find((c) => c.className === 'dialog');
  const titleEl = box.children.find((c) => c.className === 'dialog-title');
  const bodyEl = box.children.find((c) => c.className === 'dialog-body');
  const actionsEl = box.children.find((c) => c.className === 'dialog-actions');
  assert.equal(titleEl.innerHTML, '&lt;x&gt;標題');
  assert.equal(bodyEl.innerHTML, 'A &amp; B');
  assert.equal(actionsEl.children[0].innerHTML, 'O&#39;Brien');
  actionsEl.children[0].dispatchEvent(new Event('click', { bubbles: true }));
  await p;
});

await at('dialog: 關閉後焦點還給開啟前的元素', async () => {
  const trigger = fakeDocument.createElement('button');
  fakeDocument.body.appendChild(trigger);
  trigger.focus();
  assert.equal(fakeDocument.activeElement, trigger);

  const p = dialog({
    body: '焦點測試',
    actions: [{ label: '關閉', value: null, variant: 'secondary' }]
  });
  // 開啟後焦點應該已經離開 trigger、進到對話框內
  assert.notEqual(fakeDocument.activeElement, trigger);

  const overlay = fakeDocument.body.children[fakeDocument.body.children.length - 1];
  const box = overlay.children.find((c) => c.className === 'dialog');
  const actionsEl = box.children.find((c) => c.className === 'dialog-actions');
  actionsEl.children[0].dispatchEvent(new Event('click', { bubbles: true }));
  await p;

  assert.equal(fakeDocument.activeElement, trigger, '關閉後焦點應該還給開啟前的元素');
});

await at('confirm: 取消 → false', async () => {
  const p = confirm('要繼續嗎？');
  const overlay = fakeDocument.body.children[fakeDocument.body.children.length - 1];
  const box = overlay.children.find((c) => c.className === 'dialog');
  const actionsEl = box.children.find((c) => c.className === 'dialog-actions');
  const cancelBtn = actionsEl.children[0]; // 取消
  cancelBtn.dispatchEvent(new Event('click', { bubbles: true }));
  const value = await p;
  assert.equal(value, false);
});

await at('confirm: 確定 → true', async () => {
  const p = confirm('要繼續嗎？');
  const overlay = fakeDocument.body.children[fakeDocument.body.children.length - 1];
  const box = overlay.children.find((c) => c.className === 'dialog');
  const actionsEl = box.children.find((c) => c.className === 'dialog-actions');
  const okBtn = actionsEl.children[1];
  okBtn.dispatchEvent(new Event('click', { bubbles: true }));
  const value = await p;
  assert.equal(value, true);
});

await at('confirm: 按 Esc → false', async () => {
  const p = confirm('要繼續嗎？');
  fireKey(fakeDocument, 'keydown', 'Escape');
  const value = await p;
  assert.equal(value, false);
});

// ============================================================
// signaturePad()
// ============================================================

t('signaturePad: 依 devicePixelRatio 設定畫布解析度', () => {
  const canvas = fakeDocument.createElement('canvas');
  canvas._rect = { width: 300, height: 150, left: 0, top: 0 };
  fakeWindow.devicePixelRatio = 2;
  const pad = signaturePad(canvas);
  assert.equal(canvas.width, 600);
  assert.equal(canvas.height, 300);
  assert.equal(typeof pad.isEmpty, 'function');
  assert.equal(typeof pad.toDataURL, 'function');
  assert.equal(typeof pad.clear, 'function');
});

t('signaturePad: 初始為空', () => {
  const canvas = fakeDocument.createElement('canvas');
  const pad = signaturePad(canvas);
  assert.equal(pad.isEmpty(), true);
});

t('signaturePad: 滑鼠拖曳一筆後不再是空的', () => {
  const canvas = fakeDocument.createElement('canvas');
  const pad = signaturePad(canvas);
  assert.equal(pad.isEmpty(), true);
  fireMouse(canvas, 'mousedown', 10, 10);
  fireMouse(canvas, 'mousemove', 20, 20);
  fireMouse(canvas, 'mousemove', 30, 15);
  fakeWindow.dispatchEvent(new Event('mouseup'));
  assert.equal(pad.isEmpty(), false);
});

t('signaturePad: clear() 之後 isEmpty() 必為 true', () => {
  const canvas = fakeDocument.createElement('canvas');
  const pad = signaturePad(canvas);
  fireMouse(canvas, 'mousedown', 10, 10);
  fireMouse(canvas, 'mousemove', 40, 40);
  fakeWindow.dispatchEvent(new Event('mouseup'));
  assert.equal(pad.isEmpty(), false);
  pad.clear();
  assert.equal(pad.isEmpty(), true);
});

t('signaturePad: 觸控（手機）拖曳也能簽名', () => {
  const canvas = fakeDocument.createElement('canvas');
  const pad = signaturePad(canvas);
  assert.equal(pad.isEmpty(), true);
  fireTouch(canvas, 'touchstart', 5, 5);
  fireTouch(canvas, 'touchmove', 25, 25);
  canvas.dispatchEvent(new Event('touchend'));
  assert.equal(pad.isEmpty(), false);
});

t('signaturePad: 還沒開始拖曳前的 mousemove 不算數', () => {
  const canvas = fakeDocument.createElement('canvas');
  const pad = signaturePad(canvas);
  fireMouse(canvas, 'mousemove', 20, 20); // 沒有先 mousedown
  assert.equal(pad.isEmpty(), true);
});

t('signaturePad: toDataURL() 回傳字串', () => {
  const canvas = fakeDocument.createElement('canvas');
  const pad = signaturePad(canvas);
  assert.equal(typeof pad.toDataURL(), 'string');
  assert.equal(pad.toDataURL().startsWith('data:image/png'), true);
});

// ── 2026-08-15 對抗審查補的兩條 ──────────────────────────

t('signaturePad: destroy() 之後畫布與 window 上的監聽都解除', () => {
  const canvas = fakeDocument.createElement('canvas');
  const pad = signaturePad(canvas);
  // 沒有 destroy() 的話，宿舍模組每進出一次簽名畫面就多累積一組監聽，
  // 其中 mouseup 還是掛在 window 上，模組自己的 unmount 帶不走。
  assert.equal(typeof pad.destroy, 'function', 'destroy() 必須存在');

  pad.destroy();

  fireMouse(canvas, 'mousedown', 10, 10);
  fireMouse(canvas, 'mousemove', 20, 20);
  fakeWindow.dispatchEvent(new Event('mouseup'));
  assert.equal(pad.isEmpty(), true, 'destroy() 之後的滑鼠事件不該再畫進畫布');
});

// ⚠ 非同步測試一定要用 await at(...)，不能用 t(...)。
// t() 的 try/catch 接不到 Promise 的 rejection，async 函式傳進去會「永遠通過」——
// 2026-08-15 我自己就這樣寫錯過一次，變異測試把修正拿掉了測試還是全綠，
// 追下去才發現是測試本身沒在跑。這行註解留著提醒下一個人。
await at('dialog: 可以從外部 close() 強制關閉（模組 unmount 用）', async () => {
  const p = dialog({
    title: '測試',
    body: '內容',
    actions: [{ label: '確定', value: 'yes', variant: 'primary' }]
  });
  // 沒有 close() 把手，模組卸載時就關不掉開著的對話框——
  // 那會逼每個模組自己刻一套彈窗，共用元件形同虛設。
  assert.equal(typeof p.close, 'function', 'dialog() 回傳的 Promise 必須帶 close()');

  const before = fakeDocument.body.children.filter(
    (n) => n.classList && n.classList.contains('dialog-overlay')
  ).length;
  assert.equal(before, 1, '對話框應該已經掛上');

  p.close(null);
  const result = await p;
  assert.equal(result, null, '從外部關閉應 resolve 成 null');

  const after = fakeDocument.body.children.filter(
    (n) => n.classList && n.classList.contains('dialog-overlay')
  ).length;
  assert.equal(after, 0, '關閉後 overlay 應從 document 移除');

  p.close(null); // 重複呼叫要安全，不得重複 resolve 或拋錯
});

// ── 收尾：印出結果 ──────────────────────────────────────
if (failed > 0) {
  console.error('\n失敗清單：');
  for (const { name, err } of failures) {
    console.error(`  x ${name}`);
    console.error(`    ${err.message}`);
  }
}
console.log(`\n通過 ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
