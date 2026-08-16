// test/audit-module-state.test.mjs —— 任務①驗收：切分頁保留已選店別／月份（狀態保留）
// 跑法：node test/audit-module-state.test.mjs
//
// 範圍：modules/audit-stock/index.js、modules/audit-ops/index.js 新增的模組層狀態
// （moduleState），以及 views/fill.js、views/report.js 讀寫這份狀態的部分。
//
// DOM stub／事件系統／localStorage stub 照抄 test/audit-stock-report.test.mjs（已驗收範本）。
// ctx.fmt 用 platform/fmt.js 的真正實作；ctx.ui／ctx.api／ctx.nav 全部造假，不打真實網路。
//
// ⚠ modules/audit-shared/api.js 的快取是 module-level 單例，跨測試段落會殘留，
// 每個測試段落開始前都呼叫 resetAll()。

'use strict';

import assert from 'node:assert/strict';
import { esc, datetime, date, roc, money } from '../platform/fmt.js';
import { invalidate, __setClock } from '../modules/audit-shared/api.js';

// ============================================================
// 0. 事件系統（照抄既有測試檔）
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
// 1. 最小 DOM stub（照抄既有測試檔）
// ============================================================

class FakeClassList {
  constructor() { this._set = new Set(); }
  add(...names) { for (const n of names) if (n) this._set.add(n); }
  remove(...names) { for (const n of names) this._set.delete(n); }
  contains(name) { return this._set.has(name); }
  toString() { return [...this._set].join(' '); }
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
  get className() { return this.classList.toString(); }
  set className(v) {
    this.classList = new FakeClassList();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
  setAttribute(name, value) {
    this._attrs[name] = String(value);
    if (name === 'value') this.value = String(value);
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name); }
  removeAttribute(name) { delete this._attrs[name]; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  contains(node) {
    let n = node;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v); this.children = []; }
  get firstChild() { return this.children.length ? this.children[0] : null; }
}

class FakeDocument extends withEvents(Object) {
  constructor() { super(); this.body = new FakeElement('body'); }
  createElement(tag) { return new FakeElement(tag); }
}

const fakeDocument = new FakeDocument();
globalThis.document = fakeDocument;

class FakeStorage {
  constructor() { this._data = new Map(); }
  getItem(k) { return this._data.has(k) ? this._data.get(k) : null; }
  setItem(k, v) { this._data.set(String(k), String(v)); }
  removeItem(k) { this._data.delete(k); }
  key(i) { const keys = [...this._data.keys()]; return i >= 0 && i < keys.length ? keys[i] : null; }
  get length() { return this._data.size; }
  clear() { this._data.clear(); }
}
globalThis.localStorage = new FakeStorage();

// ============================================================
// 2. 樹狀查找／小工具
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
function byId(root, id) {
  return findDescendant(root, (n) => n.getAttribute && n.getAttribute('id') === id);
}

function fireChange(node, value) {
  node.value = value;
  node.dispatchEvent(makeEvent('change', { bubbles: true, target: node }));
}

function flush(rounds = 15) {
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

function makeConfig() {
  return {
    reasons: ['盤點錯誤（門市盤錯）', '損耗未記', '單位混淆', '進出貨未入帳', '其他'],
    stores: [
      { code: 'sxl-gf', name: '小辛辣光復', order: 1 },
      { code: 'ck', name: '央廚', order: 2 },
      { code: 'mzt-gf', name: '墨竹亭光復', order: 3 },
      { code: 'mzt-js', name: '墨竹亭金山', order: 4 },
      { code: 'mzt-lzl', name: '墨竹亭六張犁', order: 5 }
    ]
  };
}

function makeFakeCtx(overrides) {
  const state = { apiCalls: [], toasts: [], loadingCalls: [], apiHandlers: {} };
  const ctx = {
    user: { id: 'u002', name: '王會計', role: 'accountant', node: '' },
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
      confirm: async () => true,
      dialog: () => { throw new Error('不該呼叫 ctx.ui.dialog()'); },
      signaturePad: () => { throw new Error('不該呼叫 ctx.ui.signaturePad()'); }
    },
    fmt: { esc, datetime, date, roc, money },
    nav: () => {},
    viewId: 'fill',
    params: {}
  };
  Object.assign(ctx, overrides);
  return { ctx, state };
}

function okGetAll(data) {
  return { ok: true, data };
}

// ============================================================
// 4. 測試小工具
// ============================================================

let passed = 0;
let failed = 0;
const failures = [];

async function at(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push({ name, err });
  }
}

const auditStockIndex = (await import('../modules/audit-stock/index.js')).default;
const auditOpsIndex = (await import('../modules/audit-ops/index.js')).default;

// ============================================================
// A. audit-stock：切分頁保留店別／月份，離開模組（unmount）才清掉
// ============================================================

await at('audit-stock：在 fill 分頁設定店別／月份 → onRoute 切到 report 分頁 → 讀到同一組值', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ viewId: 'fill', params: {} });
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), items: [], details: [], records: [] });

  const unmount = auditStockIndex.mount(root, ctx);
  await flush();

  const storeSelect = byId(root, 'audit-store');
  const monthSelect = byId(root, 'audit-month');
  assert.ok(storeSelect && monthSelect, 'fill 分頁應該掛出店別／月份選單');

  fireChange(storeSelect, 'mzt-js');
  await flush();
  fireChange(monthSelect, '2026-08');
  await flush();
  assert.equal(storeSelect.value, 'mzt-js');
  assert.equal(monthSelect.value, '2026-08');

  // 切分頁（不是切模組）：殼會原地更新同一個 ctx 物件的 viewId／params，再呼叫 onRoute()
  // （spec §4.6／§4.7 的實際行為，見 platform/shell.js route()）。
  ctx.viewId = 'report';
  ctx.params = {};
  auditStockIndex.onRoute(ctx);
  await flush();

  const reportStoreSelect = byId(root, 'report-store-select');
  const reportMonthSelect = byId(root, 'report-month-select');
  assert.ok(reportStoreSelect && reportMonthSelect, 'report 分頁應該掛出店別／月份選單');
  assert.equal(reportStoreSelect.value, 'mzt-js', 'report 分頁應該讀到 fill 分頁剛選的店別');
  assert.equal(reportMonthSelect.value, '2026-08', 'report 分頁應該讀到 fill 分頁剛選的月份');

  unmount();
});

await at('audit-stock：離開模組（unmount）再進來 → 回到預設值，不是殘留 mzt-js／2026-03', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ viewId: 'fill', params: {} });
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), items: [], details: [], records: [] });

  const unmount = auditStockIndex.mount(root, ctx);
  await flush();
  fireChange(byId(root, 'audit-store'), 'mzt-js');
  await flush();
  // 刻意選一個「不是當月」的月份：預設值就是當月，用當月測不出有沒有被重置
  fireChange(byId(root, 'audit-month'), '2026-03');
  await flush();
  assert.equal(byId(root, 'audit-store').value, 'mzt-js');

  unmount(); // 離開模組：moduleState 應該被清成 {store:null, month:null}

  const root2 = new FakeElement('div');
  const { ctx: ctx2, state: state2 } = makeFakeCtx({ viewId: 'fill', params: {} });
  state2.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), items: [], details: [], records: [] });
  const unmount2 = auditStockIndex.mount(root2, ctx2);
  await flush();

  // 2026-08-15 修正這條斷言：原本寫「重新進來應該回到清單第一家店」，那是錯的——
  // 稽核系統本來就有「記住上次稽核的是哪家店」的功能（舊版 js/views/audit.js 的
  // LAST_STORE_KEY = 'audit_last_store'，註解明寫「報告頁沿用」）。會計通常連續稽核
  // 同一家店，那是刻意設計，不是殘留。要求它重置等於在搬遷時砍掉一個既有功能。
  //
  // 這裡真正該驗的是「模組層狀態」有沒有被 unmount 清掉：
  // 店別會從 localStorage 回來（既有功能，正確）；月份沒有被持久化，所以應該回到預設。
  const storeSelect2 = byId(root2, 'audit-store');
  assert.equal(
    storeSelect2.value, 'mzt-js',
    '店別從 localStorage 還原——這是舊版就有的「記住上次稽核哪家店」，不是狀態殘留'
  );
  assert.notEqual(
    byId(root2, 'audit-month').value, '2026-03',
    '月份沒有持久化，unmount 清掉 moduleState 後應回到預設月份'
  );

  unmount2();
});

// ============================================================
// B. audit-ops：同樣的行為（各自一份 moduleState，做法逐字元照抄 audit-stock）
// ============================================================

await at('audit-ops：在 fill 分頁設定店別／月份 → onRoute 切到 report 分頁 → 讀到同一組值', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ viewId: 'fill', params: {} });
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });

  const unmount = auditOpsIndex.mount(root, ctx);
  await flush();

  const storeSelect = byId(root, 'ops-store');
  const monthSelect = byId(root, 'ops-month');
  assert.ok(storeSelect && monthSelect, 'fill 分頁應該掛出店別／月份選單');

  fireChange(storeSelect, 'mzt-lzl');
  await flush();
  fireChange(monthSelect, '2026-05');
  await flush();

  ctx.viewId = 'report';
  ctx.params = {};
  auditOpsIndex.onRoute(ctx);
  await flush();

  const reportStoreSelect = byId(root, 'opsreport-store');
  const reportMonthSelect = byId(root, 'opsreport-month');
  assert.ok(reportStoreSelect && reportMonthSelect, 'report 分頁應該掛出店別／月份選單');
  assert.equal(reportStoreSelect.value, 'mzt-lzl', 'report 分頁應該讀到 fill 分頁剛選的店別');
  assert.equal(reportMonthSelect.value, '2026-05', 'report 分頁應該讀到 fill 分頁剛選的月份');

  unmount();
});

await at('audit-ops：離開模組（unmount）再進來 → 回到預設值，不是殘留 mzt-lzl／2026-05', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ viewId: 'fill', params: {} });
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });

  const unmount = auditOpsIndex.mount(root, ctx);
  await flush();
  fireChange(byId(root, 'ops-store'), 'mzt-lzl');
  await flush();
  fireChange(byId(root, 'ops-month'), '2026-05');
  await flush();

  unmount();

  const root2 = new FakeElement('div');
  const { ctx: ctx2, state: state2 } = makeFakeCtx({ viewId: 'fill', params: {} });
  state2.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });
  const unmount2 = auditOpsIndex.mount(root2, ctx2);
  await flush();

  // 同 audit-stock 那條的修正理由：舊版 js/views/ops.js 就有 `ops_last_store`
  // （第 20 行 LAST_STORE_KEY），記住上次稽核哪家店是既有功能，不是狀態殘留。
  const storeSelect2 = byId(root2, 'ops-store');
  assert.equal(
    storeSelect2.value, 'mzt-lzl',
    '店別從 localStorage 還原——舊版 ops.js 就有 ops_last_store，是既有功能'
  );
  assert.notEqual(
    byId(root2, 'ops-month').value, '2026-05',
    '月份沒有持久化，unmount 清掉 moduleState 後應回到預設月份'
  );

  unmount2();
});

// ============================================================
// C. 兩個模組互不共用狀態（audit-stock 選的店，不該影響 audit-ops）
// ============================================================

await at('audit-stock 與 audit-ops 的模組狀態互不共用', async () => {
  resetAll();
  const rootStock = new FakeElement('div');
  const { ctx: ctxStock, state: stateStock } = makeFakeCtx({ viewId: 'fill', params: {} });
  stateStock.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), items: [], details: [], records: [] });
  const unmountStock = auditStockIndex.mount(rootStock, ctxStock);
  await flush();
  fireChange(byId(rootStock, 'audit-store'), 'mzt-js');
  await flush();

  const rootOps = new FakeElement('div');
  const { ctx: ctxOps, state: stateOps } = makeFakeCtx({ viewId: 'fill', params: {} });
  stateOps.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });
  const unmountOps = auditOpsIndex.mount(rootOps, ctxOps);
  await flush();

  assert.equal(byId(rootOps, 'ops-store').value, 'sxl-gf', 'audit-ops 不該讀到 audit-stock 剛選的 mzt-js');

  unmountStock();
  unmountOps();
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
