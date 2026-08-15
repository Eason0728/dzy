// test/audit-stock-fill.test.mjs —— T2-3 驗收：modules/audit-stock/views/fill.js（稽核填寫）
// 跑法：node test/audit-stock-fill.test.mjs
//
// 沒有 jsdom，這裡跟 test/users-module.test.mjs 一樣自己刻一份最小 DOM stub
// （FakeElement／FakeDocument，事件支援手刻的 parentNode 冒泡，做法照抄
// test/shell.test.mjs 的 withEvents()）。另外多刻一份最小 localStorage stub——
// 草稿功能本來就是純瀏覽器儲存（見 fill-submit.js 檔頭），不透過 ctx.api，
// 沒有真正的 localStorage 這支測試會整組炸掉。
//
// ctx.fmt 直接用 platform/fmt.js 的真正實作（同 users-module.test.mjs 的理由：純函式、
// 沒有瀏覽器依賴，import 進來比自己刻一份假的更貼近真實情況）。ctx.ui／ctx.api／ctx.nav
// 全部造假、只記錄呼叫；全程不打真實網路、不依賴後端（稽核系統是會計每個月在用的正式
// 系統，任務指示明講不准打真網路）。
//
// ⚠ modules/audit-shared/api.js 的快取（cache／inFlight）是 module-level 單例，跨測試段落
// 會殘留（同 test/audit-shared.test.mjs 的提醒），所以每個測試段落開始前都呼叫
// resetAll()（invalidate + 還原時鐘 + 清空 localStorage），避免段落之間互相污染
// （例如 A 段落存的草稿被 B 段落誤當成「有未送出草稿」而改變預設月份）。

'use strict';

import assert from 'node:assert/strict';
import { esc, datetime, date, roc, money } from '../platform/fmt.js';
import { getAll, invalidate, __setClock } from '../modules/audit-shared/api.js';
import * as FillSubmit from '../modules/audit-stock/views/fill-submit.js';

// ============================================================
// 0. 事件系統（含手刻的冒泡邏輯，照抄 test/shell.test.mjs／test/users-module.test.mjs 的 withEvents）
// ============================================================

function withEvents(Base) {
  return class extends Base {
    constructor(...args) {
      super(...args);
      this._listeners = {};
    }
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this._listeners[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    }
    dispatchEvent(event) {
      if (event.target === undefined || event.target === null) event.target = this;
      let node = this;
      while (node) {
        const list = (node._listeners && node._listeners[event.type]) || [];
        for (const fn of list.slice()) fn.call(node, event);
        if (!event.bubbles) break;
        node = node.parentNode || null;
      }
      return true;
    }
  };
}

function makeEvent(type, opts) {
  return Object.assign({ type, bubbles: false }, opts);
}

// ============================================================
// 1. 最小 DOM stub
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

class FakeElement extends withEvents(Object) {
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
    this.value = '';
    this.hidden = false;
    this.disabled = false;
  }

  get className() {
    return this.classList.toString();
  }
  set className(v) {
    this.classList = new FakeClassList();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }

  setAttribute(name, value) {
    this._attrs[name] = String(value);
    // 真實 DOM 裡，全新元素的 value content attribute 會反映到 value IDL 屬性
    // （在使用者互動或程式碼直接指派 .value 之前，見 HTML 標準的「dirty value flag」）。
    // 這支 stub 不做完整的 dirty-flag 模型，簡化成「setAttribute('value',...) 就同步」，
    // 對這支測試涵蓋的情境已經足夠。
    if (name === 'value') this.value = String(value);
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
    this.children = [];
  }
}

class FakeDocument extends withEvents(Object) {
  constructor() {
    super();
    this.body = new FakeElement('body');
  }
  createElement(tag) {
    return new FakeElement(tag);
  }
}

const fakeDocument = new FakeDocument();
globalThis.document = fakeDocument;

// ---- 最小 localStorage stub（草稿功能靠它，見檔頭說明）----
class FakeStorage {
  constructor() {
    this._data = new Map();
  }
  getItem(k) {
    return this._data.has(k) ? this._data.get(k) : null;
  }
  setItem(k, v) {
    this._data.set(String(k), String(v));
  }
  removeItem(k) {
    this._data.delete(k);
  }
  key(i) {
    const keys = [...this._data.keys()];
    return i >= 0 && i < keys.length ? keys[i] : null;
  }
  get length() {
    return this._data.size;
  }
  clear() {
    this._data.clear();
  }
}
globalThis.localStorage = new FakeStorage();

// ============================================================
// 2. 樹狀查找／事件觸發小工具（照抄 test/users-module.test.mjs）
// ============================================================

function findDescendant(root, predicate) {
  if (!root || !root.children) return null;
  for (const child of root.children) {
    if (predicate(child)) return child;
    const found = findDescendant(child, predicate);
    if (found) return found;
  }
  return null;
}

function findAllDescendants(root, predicate, acc = []) {
  if (!root || !root.children) return acc;
  for (const child of root.children) {
    if (predicate(child)) acc.push(child);
    findAllDescendants(child, predicate, acc);
  }
  return acc;
}

function byId(root, id) {
  return findDescendant(root, (n) => n.getAttribute && n.getAttribute('id') === id);
}
function allByClass(root, cls) {
  return findAllDescendants(root, (n) => n.classList && n.classList.contains(cls));
}
function byDataAttr(root, name, value) {
  return findDescendant(root, (n) => n.getAttribute && n.getAttribute(name) === value);
}
function allByDataAttr(root, name, value) {
  return findAllDescendants(root, (n) => n.getAttribute && n.getAttribute(name) === value);
}

function fireClick(node) {
  node.dispatchEvent(makeEvent('click', { bubbles: true, target: node }));
}
function fireInput(node, value) {
  node.value = value;
  node.dispatchEvent(makeEvent('input', { bubbles: true, target: node }));
}

/** 等待 microtask/setImmediate 佇列跑過幾輪，讓 async 呼叫鏈落地（做法同 test/shell.test.mjs）。 */
function flush(rounds = 10) {
  return new Promise((resolve) => {
    let n = rounds;
    (function step() {
      if (n-- <= 0) return resolve();
      setImmediate(step);
    })();
  });
}

// ============================================================
// 3. 假 ctx／假資料
// ============================================================

function resetAll() {
  invalidate();
  __setClock(null);
  globalThis.localStorage.clear();
}

function makeConfig(overrides) {
  return Object.assign({
    reasons: ['盤點錯誤（門市盤錯）', '損耗未記', '單位混淆', '進出貨未入帳', '其他'],
    change_fund_std: 10000,
    petty_cash_std: 10000,
    stores: [{ code: 'sxl-gf', name: '小辛辣光復', order: 1 }]
  }, overrides);
}

/** 造一個假 ctx；state 記錄所有呼叫，供斷言用。 */
function makeFakeCtx(overrides) {
  const state = {
    apiCalls: [],
    toasts: [],
    loadingCalls: [],
    confirmCalls: [],
    navCalls: [],
    apiHandlers: {},
    nextConfirm: true
  };

  const ctx = {
    user: { id: 'u001', name: '王會計', role: 'accountant', node: '' },
    can: () => true,
    api: {
      call: async (backendId, action, payload) => {
        state.apiCalls.push({ backendId, action, payload });
        const handler = state.apiHandlers[action];
        if (typeof handler === 'function') return handler(payload);
        if (handler !== undefined) return handler;
        return { ok: true, data: {} };
      }
    },
    ui: {
      toast: (message, type) => { state.toasts.push({ message, type }); },
      loading: (on) => { state.loadingCalls.push(on); },
      confirm: async (message) => {
        state.confirmCalls.push(message);
        return typeof state.nextConfirm === 'function' ? state.nextConfirm() : state.nextConfirm;
      },
      dialog: () => {
        throw new Error('不該呼叫 ctx.ui.dialog()：fill.js 的覆蓋確認用 ctx.ui.confirm()，見檔頭說明');
      },
      signaturePad: () => { throw new Error('不該呼叫 ctx.ui.signaturePad()：這個分頁用不到簽名板'); }
    },
    fmt: { esc, datetime, date, roc, money },
    nav: (viewId, params) => { state.navCalls.push({ viewId, params }); },
    viewId: 'fill',
    params: {}
  };

  Object.assign(ctx, overrides);
  return { ctx, state };
}

function okGetAll(data) {
  return { ok: true, data };
}

/** 一個有效的金庫狀態（用於「只想測別的擋下條件」的情境，排除金庫本身造成的驗證失敗）。 */
function validVault() {
  return { change_fund: '正確', petty_cash: '正確', tip_amount: '500', tip_match: '相符', note: '' };
}

// ============================================================
// 4. 測試小工具
// ============================================================

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

const { mountFill } = await import('../modules/audit-stock/views/fill.js');
const auditStockIndex = (await import('../modules/audit-stock/index.js')).default;

// ============================================================
// A. 純函式（fill-submit.js）——不需要 DOM，直接驗規則本身
// ============================================================

t('validate：缺單位會被擋下（純函式）', () => {
  const errors = FillSubmit.validate({
    mode: FillSubmit.MODE_FULL,
    items: [{ name: '台灣白芝麻粒', unit: '', book_qty: 1, recount_qty: 1, verdict: '正確' }],
    vault: validVault(),
    sampleSize: 1
  });
  assert.ok(errors.some((e) => e.includes('缺單位')), '應該有一條錯誤訊息提到缺單位');
});

t('validate：單位有填、其餘都合法 → 沒有錯誤（對照組，證明上一條真的是因為缺單位失敗）', () => {
  const errors = FillSubmit.validate({
    mode: FillSubmit.MODE_FULL,
    items: [{ name: '台灣白芝麻粒', unit: '包', book_qty: 1, recount_qty: 1, verdict: '正確' }],
    vault: validVault(),
    sampleSize: 1
  });
  assert.deepEqual(errors, []);
});

t('buildRecord：只填異常項模式，未填的項目視同正確（分母固定 20，同舊版 Format.anomalyOnlyCounts）', () => {
  const items = [FillSubmit.normalizeItem(
    { name: '鴨血', unit: '盒', book_qty: 27, recount_qty: 32 },
    FillSubmit.MODE_ANOMALY
  )];
  items[0].reason = '盤點錯誤（門市盤錯）';
  const record = FillSubmit.buildRecord({
    store: 'sxl-gf', month: '2026-08', mode: FillSubmit.MODE_ANOMALY,
    items, vault: validVault(), sampleSize: 20
  });
  assert.equal(record.sample_count, 20, '分母固定 20');
  assert.equal(record.correct_count, 19, '20 − 1 項異常 = 19 項視同正確');
  assert.equal(record.correct_rate, 95, '19/20 = 95%（Eason 指定的例子，同 audit-format.test.js）');
});

t('normalizeItem：只填異常項模式下，verdict 直接固定成「異常」，不需要逐項核定', () => {
  const it = FillSubmit.normalizeItem({ name: 'X', unit: '包' }, FillSubmit.MODE_ANOMALY);
  assert.equal(it.verdict, '異常');
});

// ============================================================
// B. 抽樣結果數量正確；品項庫不足 20 項時顯示提示、不是報錯
// ============================================================

await at('抽樣：品項庫只有 5 項（< 20），抽樣後畫面顯示提示、不是報錯', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  const items5 = ['牛肉片', '鴨血', '肉燥', '米血', '高麗菜'].map((name) => ({ store: 'sxl-gf', name, unit: '包', active: true }));
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), items: items5, details: [], records: [] });

  const unmount = mountFill(root, ctx);
  await flush();

  const drawBtn = byId(root, 'audit-draw');
  assert.ok(drawBtn, '抽樣鈕存在');
  fireClick(drawBtn);
  await flush();

  const rows = allByClass(root, 'audit-item-row');
  assert.equal(rows.length, 5, '品項庫只有 5 項，抽出來就是 5 項，不是硬湊 20 項');

  const warningEl = byId(root, 'audit-count-warning');
  assert.equal(warningEl.hidden, false, '數量不足時提示要顯示');
  assert.ok(warningEl.textContent.includes('目前 5 項'), '提示文字要講清楚目前抽了幾項：' + warningEl.textContent);
  assert.ok(warningEl.textContent.includes('標準 20 項'), '提示文字要講清楚標準是幾項：' + warningEl.textContent);
  assert.ok(!warningEl.classList.contains('tag-danger'), '這是正常情況的提示，不該用「錯誤」樣式（tag-danger）');

  const dangerToasts = state.toasts.filter((x) => x.type === 'danger');
  assert.equal(dangerToasts.length, 0, '抽不滿 20 項不該觸發任何錯誤 toast（正常情況不是錯誤）：' + JSON.stringify(dangerToasts));

  unmount();
});

await at('抽樣：品項庫有 25 項，抽 20 項數量剛好，提示隱藏', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  const items25 = Array.from({ length: 25 }, (_, i) => ({ store: 'sxl-gf', name: '品項' + i, unit: '包', active: true }));
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), items: items25, details: [], records: [] });

  const unmount = mountFill(root, ctx);
  await flush();
  fireClick(byId(root, 'audit-draw'));
  await flush();

  const rows = allByClass(root, 'audit-item-row');
  assert.equal(rows.length, 20, '抽滿標準項數');
  const warningEl = byId(root, 'audit-count-warning');
  assert.equal(warningEl.hidden, true, '數量剛好時不顯示提示');

  unmount();
});

// ============================================================
// C. 「只填異常項」模式切換：DOM 層面確認畫面行為（分母固定已由上面 A 段純函式驗過）
// ============================================================

await at('模式切換：切到「只填異常項」後，抽樣鈕隱藏、加入的品項不需要逐項核定正確/異常', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  const items = [{ store: 'sxl-gf', name: '鴨血', unit: '盒', active: true }];
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), items, details: [], records: [] });

  const unmount = mountFill(root, ctx);
  await flush();

  const anomalyBtn = byDataAttr(root, 'data-mode', FillSubmit.MODE_ANOMALY);
  assert.ok(anomalyBtn, '「只填異常項」按鈕存在');
  fireClick(anomalyBtn);
  await flush();

  assert.equal(byId(root, 'audit-draw').hidden, true, '只填異常項模式沒有「抽樣」這件事，抽樣鈕要隱藏');

  // 用「加入品項」把鴨血加進清單（只填異常項模式的正常操作方式）
  const addInput = byId(root, 'audit-add-input');
  const addUnitInput = byId(root, 'audit-add-unit');
  addInput.value = '鴨血';
  addUnitInput.value = '盒';
  fireClick(byId(root, 'audit-add-btn'));
  await flush();

  const rows = allByClass(root, 'audit-item-row');
  assert.equal(rows.length, 1, '加入後清單有 1 項');
  const verdictBtns = allByClass(rows[0], 'audit-verdict-btn');
  assert.equal(verdictBtns.length, 0, '只填異常項模式：單項不顯示正確/異常按鈕，加進清單的就是異常，不必核定');

  unmount();
});

// ============================================================
// D. 缺單位會被擋下、不送出
// ============================================================

await at('送出：抽到缺單位的品項、沒有補單位就送出 → 被擋下，不會呼叫後端 submitAudit', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  // 品項庫只有這一項且單位留空，同真實案例（sxl-gf「台灣白芝麻粒」單位留空）；
  // 品項庫只有 1 項，抽樣一定抽到它。
  const items = [{ store: 'sxl-gf', name: '台灣白芝麻粒', unit: '', active: true }];
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), items, details: [], records: [] });
  state.apiHandlers.submitAudit = () => ({ ok: true, data: { record_key: 'sxl-gf_2026-08' } });

  const unmount = mountFill(root, ctx);
  await flush();
  fireClick(byId(root, 'audit-draw'));
  await flush();

  const row = allByClass(root, 'audit-item-row')[0];
  fireInput(findDescendant(row, (n) => n.classList.contains('audit-book-qty')), '10');
  fireInput(findDescendant(row, (n) => n.classList.contains('audit-recount-qty')), '10');
  // 刻意不填「單位」欄位（audit-unit-fix）——這正是要測的擋下條件。
  const correctBtn = findAllDescendants(row, (n) => n.classList.contains('audit-verdict-btn'))
    .find((b) => b.getAttribute('data-value') === '正確');
  fireClick(correctBtn);

  const vault = validVault();
  const changeFundOk = allByDataAttr(root, 'data-group', 'change_fund').find((b) => b.getAttribute('data-value') === '正確');
  fireClick(changeFundOk);
  const pettyCashOk = allByDataAttr(root, 'data-group', 'petty_cash').find((b) => b.getAttribute('data-value') === '正確');
  fireClick(pettyCashOk);
  fireInput(byId(root, 'audit-tip-amount'), vault.tip_amount);
  const tipMatchOk = allByDataAttr(root, 'data-group', 'tip_match').find((b) => b.getAttribute('data-value') === '相符');
  fireClick(tipMatchOk);

  fireClick(byId(root, 'audit-submit-btn'));
  await flush();

  const submitCalls = state.apiCalls.filter((c) => c.action === 'submitAudit');
  assert.equal(submitCalls.length, 0, '缺單位應該擋下送出，後端 submitAudit 完全不該被呼叫');

  const submitErrorEl = byId(root, 'audit-submit-error');
  assert.equal(submitErrorEl.hidden, false, '應該顯示送出錯誤訊息');
  assert.ok(submitErrorEl.textContent.includes('缺單位'), '錯誤訊息要提到缺單位：' + submitErrorEl.textContent);

  const dangerToasts = state.toasts.filter((x) => x.type === 'danger');
  assert.ok(dangerToasts.length >= 1, '應該有錯誤 toast 提醒使用者');

  unmount();
});

// ============================================================
// E. 金庫抽查三個欄位都能填、都進 payload
// ============================================================

await at('送出：金庫三個欄位（零找金／零用金／小費）都能填，且原樣出現在送出 payload 裡', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  const items = [{ store: 'sxl-gf', name: '牛肉片', unit: '公斤', active: true }];
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), items, details: [], records: [] });
  state.apiHandlers.submitAudit = () => ({ ok: true, data: { record_key: 'sxl-gf_2026-08' } });

  const unmount = mountFill(root, ctx);
  await flush();
  fireClick(byId(root, 'audit-draw'));
  await flush();

  const row = allByClass(root, 'audit-item-row')[0];
  fireInput(findDescendant(row, (n) => n.classList.contains('audit-book-qty')), '5');
  fireInput(findDescendant(row, (n) => n.classList.contains('audit-recount-qty')), '5');
  const correctBtn = findAllDescendants(row, (n) => n.classList.contains('audit-verdict-btn'))
    .find((b) => b.getAttribute('data-value') === '正確');
  fireClick(correctBtn);

  const changeFundBad = allByDataAttr(root, 'data-group', 'change_fund').find((b) => b.getAttribute('data-value') === '不正確');
  fireClick(changeFundBad);
  const pettyCashOk = allByDataAttr(root, 'data-group', 'petty_cash').find((b) => b.getAttribute('data-value') === '正確');
  fireClick(pettyCashOk);
  fireInput(byId(root, 'audit-tip-amount'), '888');
  const tipMatchBad = allByDataAttr(root, 'data-group', 'tip_match').find((b) => b.getAttribute('data-value') === '不相符');
  fireClick(tipMatchBad);
  fireInput(byId(root, 'audit-note'), '零找金短少 200 元，已請店長確認');

  fireClick(byId(root, 'audit-submit-btn'));
  await flush();

  const submitCalls = state.apiCalls.filter((c) => c.action === 'submitAudit');
  assert.equal(submitCalls.length, 1, '三個金庫欄位都合法填寫，應該成功送出一次');
  const record = submitCalls[0].payload.record;
  assert.equal(record.change_fund, '不正確', '零找金欄位要原樣進 payload');
  assert.equal(record.petty_cash, '正確', '零用金欄位要原樣進 payload');
  assert.equal(record.tip_amount, 888, '小費金額要原樣進 payload（且轉成數字）');
  assert.equal(record.tip_match, '不相符', '小費相符欄位要原樣進 payload');
  assert.equal(record.note, '零找金短少 200 元，已請店長確認', '整單備註也要進 payload');

  unmount();
});

// ============================================================
// F. 送出成功後 invalidate() 有被呼叫
// ============================================================

await at('送出成功後：共用快取被 invalidate，下一次 getAll() 會重新打後端（不是繼續吃舊快取）', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  const items = [{ store: 'sxl-gf', name: '牛肉片', unit: '公斤', active: true }];
  let getAllHits = 0;
  state.apiHandlers.getAll = () => {
    getAllHits++;
    return okGetAll({ config: makeConfig(), items, details: [], records: [] });
  };
  state.apiHandlers.submitAudit = () => ({ ok: true, data: { record_key: 'sxl-gf_2026-08' } });

  const unmount = mountFill(root, ctx);
  await flush();
  assert.equal(getAllHits, 1, '掛載時打了一次 getAll（基準線）');

  fireClick(byId(root, 'audit-draw'));
  await flush();
  const row = allByClass(root, 'audit-item-row')[0];
  fireInput(findDescendant(row, (n) => n.classList.contains('audit-book-qty')), '5');
  fireInput(findDescendant(row, (n) => n.classList.contains('audit-recount-qty')), '5');
  const correctBtn = findAllDescendants(row, (n) => n.classList.contains('audit-verdict-btn'))
    .find((b) => b.getAttribute('data-value') === '正確');
  fireClick(correctBtn);
  const changeFundOk = allByDataAttr(root, 'data-group', 'change_fund').find((b) => b.getAttribute('data-value') === '正確');
  fireClick(changeFundOk);
  const pettyCashOk = allByDataAttr(root, 'data-group', 'petty_cash').find((b) => b.getAttribute('data-value') === '正確');
  fireClick(pettyCashOk);
  fireInput(byId(root, 'audit-tip-amount'), '500');
  const tipMatchOk = allByDataAttr(root, 'data-group', 'tip_match').find((b) => b.getAttribute('data-value') === '相符');
  fireClick(tipMatchOk);

  fireClick(byId(root, 'audit-submit-btn'));
  await flush();

  const submitCalls = state.apiCalls.filter((c) => c.action === 'submitAudit');
  assert.equal(submitCalls.length, 1, '送出應該成功一次');
  assert.deepEqual(state.navCalls[state.navCalls.length - 1], { viewId: 'report', params: { store: 'sxl-gf', month: currentMonthOf(root) } },
    '送出成功後應該導到報告頁，並帶上剛送出的店與月份');

  // 直接呼叫 audit-shared/api.js 的 getAll(ctx)（跟 fill.js 內部用的是同一個模組單例）：
  // 如果 submit() 真的呼叫了 invalidate()，這裡快取已經失效，會是一次新的底層呼叫；
  // 如果沒呼叫，這裡會直接吃到送出前那次 getAll() 的舊快取，getAllHits 不會增加。
  const beforeExtraGetAll = getAllHits;
  await getAll(ctx);
  assert.equal(getAllHits, beforeExtraGetAll + 1,
    '送出成功後快取應該已經被 invalidate()，下一次 getAll() 要重新打後端，而不是吃舊快取');

  unmount();
});

function currentMonthOf(root) {
  return byId(root, 'audit-month').value;
}

// ============================================================
// G. 沒有 audit.write 權限時看不到送出控制項
// ============================================================

await at('沒有 audit.write 權限：整個填寫表單（含送出鈕）都不顯示，只有一段提示', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ can: () => false });
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), items: [], details: [], records: [] });

  const unmount = mountFill(root, ctx);
  await flush();

  assert.equal(byId(root, 'audit-submit-btn'), null, '沒有寫入權限，不該看到送出鈕');
  assert.equal(byId(root, 'audit-store'), null, '沒有寫入權限，整個填寫表單都不該畫出來（防禦性檢查，同 overview.js 的 canWrite 用法）');
  assert.equal(state.apiCalls.length, 0, '沒有寫入權限時完全不必呼叫後端');

  unmount();
});

// ============================================================
// H. index.js 掛上新分頁（最小改動）：ctx.viewId='fill' 時真的分派到 mountFill
// ============================================================

await at('index.js：ctx.viewId=\'fill\' 時會掛載稽核填寫畫面，不是「尚未完成」佔位卡片', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), items: [], details: [], records: [] });
  ctx.viewId = 'fill';

  const unmount = auditStockIndex.mount(root, ctx);
  await flush();

  assert.ok(byId(root, 'audit-store'), 'viewId=fill 應該掛出稽核填寫畫面（找得到 #audit-store）');
  const placeholder = findDescendant(root, (n) => n.textContent === '此分頁尚未完成');
  assert.equal(placeholder, null, '不該還是顯示尚未完成的佔位卡片');

  unmount();
});

// ============================================================
if (failed > 0) {
  console.error('\n失敗清單：');
  failures.forEach(({ name, err }) => {
    console.error('FAIL: ' + name);
    console.error('  ' + (err && err.stack ? err.stack : err));
  });
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  process.exit(1);
} else {
  console.log('全部測試通過，共 ' + passed + ' 項');
}
