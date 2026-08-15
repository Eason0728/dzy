// test/audit-ops.test.mjs —— T2-5 驗收：modules/audit-ops/**（營運稽核表：搬遷，不是重寫）
// 跑法：node test/audit-ops.test.mjs
//
// 稽核系統是會計每個月實際在用的正式系統，這裡全程不打真實網路（ctx.api.call 全部造假）、
// 不依賴後端。DOM stub／事件系統／localStorage stub 的做法照抄
// test/audit-stock-fill.test.mjs（T2-3 已驗收的範本）——沒有 jsdom，自己刻一份最小 DOM。
//
// ⚠ modules/audit-shared/api.js 的快取（cache／inFlight）是 module-level 單例，跨測試段落
// 會殘留，所以每個測試段落開始前都呼叫 resetAll()（invalidate + 還原時鐘 + 清空 localStorage）。
//
// 這張表不能拿掉的兩條規則（任務指示明講：拿掉任何一條就是把這張表變成裝飾品）：
// ①未完成的項目必填說明 ②稽核人員必填。段落 D／E 各自獨立驗證這兩條，
// 對應的變異測試（拿掉「未完成必填說明」那段程式碼）另外在回報裡跑，不寫進本檔。

'use strict';

import assert from 'node:assert/strict';
import { esc, datetime, date, roc, money } from '../platform/fmt.js';
import { validateManifest } from '../platform/manifest-check.js';
import { getAll, invalidate, __setClock } from '../modules/audit-shared/api.js';
import { OpsChecklist } from '../modules/audit-shared/umd-bridge.js';
import * as FillSubmit from '../modules/audit-ops/views/fill-submit.js';

// ============================================================
// 0. 事件系統（含手刻的冒泡邏輯，照抄 test/audit-stock-fill.test.mjs）
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

  // ⚠ 這支 stub 原本照抄 test/audit-stock-fill.test.mjs 沒有補 firstChild：那份範本裡每個
  // render 函式在同一段測試中最多只被觀察一次，沒有測試會在同一個容器上重繪兩次後
  // 再斷言內容，所以「`while (el.firstChild) el.removeChild(...)` 清空重繪」這個清單／
  // 篩選鈕大量使用的慣用法從沒被真正跑到過。本檔的測試會在同一個容器上重繪多次
  // （送出擋下後切篩選、點判定鈕後重畫清單……），沒有 firstChild 這個清空迴圈永遠不會
  // 執行（`undefined` 恆假），新內容會疊在舊內容後面而不是取代它——這裡補上，讓 stub
  // 更貼近真實 DOM，不影響任何應用程式碼。
  get firstChild() {
    return this.children.length ? this.children[0] : null;
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

// ---- 最小 localStorage stub（草稿功能靠它）----
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
// 2. 樹狀查找／事件觸發小工具（照抄 test/audit-stock-fill.test.mjs）
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
/** 總覽格子一格同時帶 data-store 與 data-month（同一店有 12 個月份格），要兩個一起比對才找得到正確那格。 */
function gridCell(root, store, month) {
  return findDescendant(root, (n) =>
    n.getAttribute && n.getAttribute('data-store') === store && n.getAttribute('data-month') === month);
}

function fireClick(node) {
  node.dispatchEvent(makeEvent('click', { bubbles: true, target: node }));
}
function fireInput(node, value) {
  node.value = value;
  node.dispatchEvent(makeEvent('input', { bubbles: true, target: node }));
}
function fireChange(node, value) {
  node.value = value;
  node.dispatchEvent(makeEvent('change', { bubbles: true, target: node }));
}

/** 等待 microtask/setImmediate 佇列跑過幾輪，讓 async 呼叫鏈落地（做法同 audit-stock 範本）。 */
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
    stores: [
      { code: 'sxl-gf', name: '小辛辣光復', order: 1 },
      { code: 'ck', name: '央廚', order: 2 }
    ]
  }, overrides);
}

/** 造一個假 ctx；state 記錄所有呼叫，供斷言用。 */
function makeFakeCtx(overrides) {
  const state = {
    apiCalls: [],
    toasts: [],
    loadingCalls: [],
    navCalls: [],
    apiHandlers: {}
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
      confirm: async () => { throw new Error('不該呼叫 ctx.ui.confirm()：舊版 ops.js 沒有覆蓋確認流程，只有一段行內提示'); },
      dialog: () => { throw new Error('不該呼叫 ctx.ui.dialog()'); },
      signaturePad: () => { throw new Error('不該呼叫 ctx.ui.signaturePad()'); }
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

const { mountFill } = await import('../modules/audit-ops/views/fill.js');
const { mountOverview } = await import('../modules/audit-ops/views/overview.js');
const { mountReport } = await import('../modules/audit-ops/views/report.js');
const auditOpsIndex = (await import('../modules/audit-ops/index.js')).default;
const auditOpsManifest = (await import('../modules/audit-ops/manifest.js')).default;

// ============================================================
// A. manifest：19 項四大類完整、通過 manifest-check.js
// ============================================================

t('manifest：audit-ops 通過 platform/manifest-check.js，errors 為空陣列', () => {
  const r = validateManifest(auditOpsManifest);
  assert.deepEqual(r.errors, [], 'errors 應為空陣列，實際：' + JSON.stringify(r.errors));
  assert.equal(r.ok, true);
});

t('manifest：分頁依 spec §4.5 摘要表列 overview／fill／report／my 四個', () => {
  const ids = auditOpsManifest.views.map((v) => v.id);
  assert.deepEqual(ids, ['overview', 'fill', 'report', 'my']);
});

t('manifest：ns 與 backend 都是 audit，與 audit-stock 共用同一支後端', () => {
  assert.equal(auditOpsManifest.ns, 'audit');
  assert.equal(auditOpsManifest.backend, 'audit');
});

t('OpsChecklist：19 項，四大類（消防安全／營運／環境清潔／食安）分組數量完整（7/2/6/4）', () => {
  assert.equal(OpsChecklist.total, 19);
  assert.equal(OpsChecklist.flat.length, 19);
  const byGroup = {};
  OpsChecklist.flat.forEach((it) => { byGroup[it.group] = (byGroup[it.group] || 0) + 1; });
  assert.deepEqual(byGroup, { '消防安全': 7, '營運': 2, '環境清潔': 6, '食安': 4 });
});

// ============================================================
// B. 純函式（fill-submit.js）——這張表存在的理由：兩條規則各自獨立驗證
// ============================================================

t('規則①稽核人員必填：auditorError 對空字串／空白字串回錯誤訊息', () => {
  assert.equal(FillSubmit.auditorError(''), '請填稽核人員。');
  assert.equal(FillSubmit.auditorError('   '), '請填稽核人員。');
  assert.equal(FillSubmit.auditorError(undefined), '請填稽核人員。');
});

t('規則①稽核人員必填：auditorError 對有效字串回 null（對照組）', () => {
  assert.equal(FillSubmit.auditorError('王會計'), null);
});

t('規則②未完成必填說明：missingNoteError 對「未完成且沒填說明」回錯誤（單筆）', () => {
  const details = [{ item_id: 'c0g0i0', cat: '營運管理', group: '消防安全', text: '一家店至少兩支滅火器', verdict: '未完成', track: false, note: '' }];
  const err = FillSubmit.missingNoteError(details);
  assert.ok(err, '應該回傳錯誤物件');
  assert.equal(err.count, 1);
  assert.ok(err.message.includes('未完成'), '訊息要提到「未完成」：' + err.message);
  assert.ok(err.message.includes('沒填說明'), '訊息要提到「沒填說明」：' + err.message);
});

t('規則②未完成必填說明：missingNoteError 對「未完成但已填說明」回 null（對照組，證明真的是因為沒填說明）', () => {
  const details = [{ item_id: 'c0g0i0', cat: '營運管理', group: '消防安全', text: '一家店至少兩支滅火器', verdict: '未完成', track: false, note: '壓力錶指針在紅區' }];
  assert.equal(FillSubmit.missingNoteError(details), null);
});

t('規則②未完成必填說明：合格／未檢查的項目不需要說明', () => {
  const details = [
    { item_id: 'a', cat: 'c', group: 'g', text: 't1', verdict: '合格', track: false, note: '' },
    { item_id: 'b', cat: 'c', group: 'g', text: 't2', verdict: '未檢查', track: false, note: '' }
  ];
  assert.equal(FillSubmit.missingNoteError(details), null);
});

t('missingNoteError 訊息超過 3 項時只列前 3 項並加「等」（逐字元照抄 ops.js submit()）', () => {
  const details = ['甲', '乙', '丙', '丁'].map((text, i) => ({
    item_id: 'i' + i, cat: 'c', group: 'g', text, verdict: '未完成', track: false, note: ''
  }));
  const err = FillSubmit.missingNoteError(details);
  assert.equal(err.count, 4);
  assert.ok(err.message.includes('甲、乙、丙'), '應列出前 3 項：' + err.message);
  assert.ok(err.message.includes('等'), '超過 3 項要加「等」：' + err.message);
  assert.ok(!err.message.includes('丁'), '第 4 項不該出現在訊息裡：' + err.message);
});

t('validate()：稽核人員沒填時只回這一條，不疊加未完成說明的錯誤（同舊版短路順序）', () => {
  const details = [{ item_id: 'a', cat: 'c', group: 'g', text: 't', verdict: '未完成', track: false, note: '' }];
  const errors = FillSubmit.validate({ auditor: '', details });
  assert.deepEqual(errors, ['請填稽核人員。']);
});

t('counts()／buildRecord()：合格率計算正確（10 合格／2 未完成／7 未檢查，分母固定 19 項）', () => {
  const entries = FillSubmit.blankEntries();
  const ids = OpsChecklist.flat.map((it) => it.id);
  for (let i = 0; i < 10; i++) entries[ids[i]] = { verdict: '合格', track: false, note: '' };
  for (let i = 10; i < 12; i++) entries[ids[i]] = { verdict: '未完成', track: false, note: '理由' };
  // 其餘 7 項維持未檢查（emptyEntry() 預設）

  const c = FillSubmit.counts(entries);
  assert.equal(c.total, 19);
  assert.equal(c.pass, 10);
  assert.equal(c.fail, 2);
  assert.equal(c.pending, 7);
  assert.equal(c.pass_rate, 53, '10/19 四捨五入應為 53%（Math.round(10/19*100)）');

  const details = FillSubmit.detailList(entries);
  const record = FillSubmit.buildRecord({ store: 'sxl-gf', month: '2026-08', auditor: '王會計', details });
  assert.equal(record.record_key, 'sxl-gf_2026-08');
  assert.equal(record.total_count, 19);
  assert.equal(record.pass_count, 10);
  assert.equal(record.fail_count, 2);
  assert.equal(record.pending_count, 7);
  assert.equal(record.pass_rate, 53);
  assert.equal(record.auditor, '王會計');
});

// ============================================================
// C. 沒有 audit.write 權限：看不到送出控制項（fill／overview 各驗一次）
// ============================================================

await at('fill：沒有 audit.write 權限，整個填寫表單（含送出鈕）都不顯示，完全不呼叫後端', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ can: () => false });

  const unmount = mountFill(root, ctx);
  await flush();

  assert.equal(byId(root, 'ops-submit'), null, '沒有寫入權限，不該看到送出鈕');
  assert.equal(byId(root, 'ops-store'), null, '沒有寫入權限，整個填寫表單都不該畫出來');
  assert.equal(state.apiCalls.length, 0, '沒有寫入權限時完全不必呼叫後端');

  unmount();
});

await at('overview：沒有 audit.write 權限時看不到「開始稽核」鈕', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ can: () => false });
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [] });

  const unmount = mountOverview(root, ctx);
  await flush();

  assert.equal(byId(root, 'btn-start-ops'), null, '沒有寫入權限，不該看到開始稽核鈕');

  unmount();
});

// ============================================================
// D. 規則①（稽核人員必填）在真實 DOM 流程中會被擋下
// ============================================================

await at('送出：稽核人員沒填 → 被擋下，不呼叫後端 submitOpsAudit，訊息顯示「請填稽核人員。」', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });
  state.apiHandlers.submitOpsAudit = () => ({ ok: true, record_key: 'sxl-gf_2026-08' });

  const unmount = mountFill(root, ctx);
  await flush();

  // 刻意不填 #ops-auditor，直接送出
  fireClick(byId(root, 'ops-submit'));
  await flush();

  const submitCalls = state.apiCalls.filter((c) => c.action === 'submitOpsAudit');
  assert.equal(submitCalls.length, 0, '稽核人員沒填應該擋下送出，後端 submitOpsAudit 完全不該被呼叫');

  const msgEl = byId(root, 'ops-message');
  assert.equal(msgEl.hidden, false, '應該顯示訊息');
  assert.equal(msgEl.textContent, '請填稽核人員。');

  unmount();
});

// ============================================================
// E. 規則②（未完成必填說明）在真實 DOM 流程中會被擋下
// ============================================================

await at('送出：填了稽核人員、但有一項判「未完成」沒填說明 → 被擋下，篩選自動切到「未完成」', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });
  state.apiHandlers.submitOpsAudit = () => ({ ok: true, record_key: 'sxl-gf_2026-08' });

  const unmount = mountFill(root, ctx);
  await flush();

  fireInput(byId(root, 'ops-auditor'), '王會計');

  // 找第一個「未完成」鈕，點下去（不補說明）
  const firstFailBtn = allByDataAttr(root, 'data-verdict', '未完成')[0];
  assert.ok(firstFailBtn, '應該找得到至少一個「未完成」鈕（19 項都在畫面上）');
  fireClick(firstFailBtn);
  await flush();

  fireClick(byId(root, 'ops-submit'));
  await flush();

  const submitCalls = state.apiCalls.filter((c) => c.action === 'submitOpsAudit');
  assert.equal(submitCalls.length, 0, '未完成缺說明應該擋下送出，後端 submitOpsAudit 完全不該被呼叫');

  const msgEl = byId(root, 'ops-message');
  assert.equal(msgEl.hidden, false, '應該顯示訊息');
  assert.ok(msgEl.textContent.includes('未完成'), '訊息要提到未完成：' + msgEl.textContent);
  assert.ok(msgEl.textContent.includes('沒填說明'), '訊息要提到沒填說明：' + msgEl.textContent);

  const failFilterBtn = byDataAttr(root, 'data-filter', 'fail');
  assert.ok(failFilterBtn.classList.contains('sel'), '篩選應該自動切到「未完成」，方便直接補說明');

  unmount();
});

await at('送出：補上說明後同一項可以正常送出（對照組，證明上一條真的是因為沒填說明擋下）', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });
  state.apiHandlers.submitOpsAudit = () => ({ ok: true, record_key: 'sxl-gf_2026-08' });

  const unmount = mountFill(root, ctx);
  await flush();

  fireInput(byId(root, 'ops-auditor'), '王會計');

  const firstFailBtn = allByDataAttr(root, 'data-verdict', '未完成')[0];
  fireClick(firstFailBtn);
  await flush();

  const noteEl = allByClass(root, 'ops-note')[0];
  fireInput(noteEl, '壓力錶指針在紅區，已聯絡廠商更換');
  await flush();

  fireClick(byId(root, 'ops-submit'));
  await flush();

  const submitCalls = state.apiCalls.filter((c) => c.action === 'submitOpsAudit');
  assert.equal(submitCalls.length, 1, '補上說明後應該可以成功送出');

  unmount();
});

// ============================================================
// F. 19 項四大類在畫面上完整呈現
// ============================================================

await at('畫面：19 項全部呈現，分成 4 個群組標題（消防安全／營運／環境清潔／食安）', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });

  const unmount = mountFill(root, ctx);
  await flush();

  const items = allByClass(root, 'ops-item');
  assert.equal(items.length, 19, '預設篩選「全部」應顯示全部 19 項');

  const groups = findAllDescendants(root, (n) => n.tagName === 'H3' && n.classList.contains('ops-group'));
  const groupTexts = groups.map((g) => g.innerHTML);
  assert.equal(groups.length, 4, '應該有 4 個群組標題');
  ['消防安全', '營運', '環境清潔', '食安'].forEach((name) => {
    assert.ok(groupTexts.some((t2) => t2.includes(name)), '群組標題應包含「' + name + '」：' + JSON.stringify(groupTexts));
  });

  unmount();
});

// ============================================================
// G. 合格率計算正確（透過真實送出流程驗證，端到端）
// ============================================================

await at('送出：10 項合格／2 項未完成（已填說明）／7 項未檢查 → payload 的 pass_rate 為 53', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });
  state.apiHandlers.submitOpsAudit = () => ({ ok: true, record_key: 'sxl-gf_2026-08' });

  const unmount = mountFill(root, ctx);
  await flush();

  fireInput(byId(root, 'ops-auditor'), '王會計');

  const items = allByClass(root, 'ops-item');
  assert.equal(items.length, 19);

  for (let i = 0; i < 10; i++) {
    const passBtn = findDescendant(items[i], (n) => n.getAttribute && n.getAttribute('data-verdict') === '合格');
    fireClick(passBtn);
  }
  for (let i = 10; i < 12; i++) {
    const failBtn = findDescendant(items[i], (n) => n.getAttribute && n.getAttribute('data-verdict') === '未完成');
    fireClick(failBtn);
    const noteEl = findDescendant(items[i], (n) => n.classList && n.classList.contains('ops-note'));
    fireInput(noteEl, '缺失說明 ' + i);
  }
  await flush();

  fireClick(byId(root, 'ops-submit'));
  await flush();

  const submitCalls = state.apiCalls.filter((c) => c.action === 'submitOpsAudit');
  assert.equal(submitCalls.length, 1, '應該成功送出一次');
  const record = submitCalls[0].payload.record;
  assert.equal(record.total_count, 19);
  assert.equal(record.pass_count, 10);
  assert.equal(record.fail_count, 2);
  assert.equal(record.pending_count, 7);
  assert.equal(record.pass_rate, 53, '10/19 應為 53%');
  assert.equal(record.auditor, '王會計');

  const payloadDetails = submitCalls[0].payload.details;
  assert.equal(payloadDetails.length, 19, '明細應該是全部 19 項（不只是有動過的項目）');

  unmount();
});

// ============================================================
// H. 送出成功後 invalidate() 有被呼叫
// ============================================================

await at('送出成功後：共用快取被 invalidate，下一次 getAll() 會重新打後端', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  let getAllHits = 0;
  state.apiHandlers.getAll = () => {
    getAllHits++;
    return okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });
  };
  state.apiHandlers.submitOpsAudit = () => ({ ok: true, record_key: 'sxl-gf_2026-08' });

  const unmount = mountFill(root, ctx);
  await flush();
  assert.equal(getAllHits, 1, '掛載時打了一次 getAll（基準線）');

  fireInput(byId(root, 'ops-auditor'), '王會計');
  // 全部 19 項都標「合格」：最簡單能通過驗證、送出成功的組合
  allByDataAttr(root, 'data-verdict', '合格').forEach((btn) => fireClick(btn));
  await flush();

  fireClick(byId(root, 'ops-submit'));
  await flush();

  const submitCalls = state.apiCalls.filter((c) => c.action === 'submitOpsAudit');
  assert.equal(submitCalls.length, 1, '送出應該成功一次');
  assert.deepEqual(state.navCalls[state.navCalls.length - 1].viewId, 'report', '送出成功後應該導到報告頁');

  const beforeExtraGetAll = getAllHits;
  await getAll(ctx);
  assert.equal(getAllHits, beforeExtraGetAll + 1,
    '送出成功後快取應該已經被 invalidate()，下一次 getAll() 要重新打後端，而不是吃舊快取');

  unmount();
});

// ============================================================
// I. 追蹤／再點一次取消（回未檢查）等互動細節
// ============================================================

await at('互動：判定按鈕再點一次會取消（回未檢查）；追蹤鈕會切換星號文字', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });

  const unmount = mountFill(root, ctx);
  await flush();

  const firstItem = allByClass(root, 'ops-item')[0];
  const passBtn = findDescendant(firstItem, (n) => n.getAttribute && n.getAttribute('data-verdict') === '合格');
  fireClick(passBtn);
  await flush();
  let refreshedItem = allByClass(root, 'ops-item')[0];
  assert.ok(refreshedItem.classList.contains('is-pass'), '點合格後該列應加上 is-pass');

  const passBtnAgain = findDescendant(refreshedItem, (n) => n.getAttribute && n.getAttribute('data-verdict') === '合格');
  fireClick(passBtnAgain);
  await flush();
  refreshedItem = allByClass(root, 'ops-item')[0];
  assert.ok(!refreshedItem.classList.contains('is-pass'), '再點一次應該取消，回到未檢查');
  assert.ok(!refreshedItem.classList.contains('is-fail'));

  const trackBtn = findDescendant(refreshedItem, (n) => n.classList && n.classList.contains('ops-tbtn'));
  assert.equal(trackBtn.textContent, '☆ 追蹤');
  fireClick(trackBtn);
  await flush();
  refreshedItem = allByClass(root, 'ops-item')[0];
  const trackBtnAfter = findDescendant(refreshedItem, (n) => n.classList && n.classList.contains('ops-tbtn'));
  assert.equal(trackBtnAfter.textContent, '★ 追蹤中');

  unmount();
});

// ============================================================
// J. 篩選鈕真的會過濾清單
// ============================================================

await at('篩選：切到「未完成」只顯示判定為未完成的項目', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });

  const unmount = mountFill(root, ctx);
  await flush();

  const failBtn = allByDataAttr(root, 'data-verdict', '未完成')[0];
  fireClick(failBtn);
  await flush();

  fireClick(byDataAttr(root, 'data-filter', 'fail'));
  await flush();

  const shown = allByClass(root, 'ops-item');
  assert.equal(shown.length, 1, '篩選「未完成」後應該只剩 1 項');
  assert.ok(shown[0].classList.contains('is-fail'));

  unmount();
});

// ============================================================
// K. overview.js：已稽核格子可點、導到報告頁並帶正確 store/month；輪休格子不可點
// ============================================================

await at('overview：已稽核的格子可點，點下去 ctx.nav 導到 report 並帶正確 store/month', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({
    config: makeConfig(),
    ops_records: [{ record_key: 'sxl-gf_2026-08', store: 'sxl-gf', month: '2026-08', status: '已稽核', pass_rate: 90 }]
  });

  const unmount = mountOverview(root, ctx);
  await flush();

  const cell = byDataAttr(root, 'data-clickable', '1');
  assert.ok(cell, '已稽核的格子應該標記 data-clickable');
  assert.equal(cell.getAttribute('data-store'), 'sxl-gf');
  assert.equal(cell.getAttribute('data-month'), '2026-08');

  fireClick(cell);
  await flush();

  assert.deepEqual(state.navCalls[state.navCalls.length - 1], { viewId: 'report', params: { store: 'sxl-gf', month: '2026-08' } });

  unmount();
});

await at('overview：輪休的格子顯示「輪休」、不可點；沒有紀錄顯示「—」', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({
    config: makeConfig(),
    ops_records: [{ record_key: 'sxl-gf_2026-08', store: 'sxl-gf', month: '2026-08', status: '輪休' }]
  });

  const unmount = mountOverview(root, ctx);
  await flush();

  const cell = gridCell(root, 'sxl-gf', '2026-08');
  assert.equal(cell.getAttribute('data-clickable'), null, '輪休格子不該可點');
  assert.equal(cell.textContent, '輪休');

  const emptyCell = gridCell(root, 'sxl-gf', '2026-01');
  assert.equal(emptyCell.textContent, '—', '同一家店沒紀錄的其他月份應顯示 —');

  unmount();
});

await at('overview：點「開始稽核」導到 fill 分頁', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [] });

  const unmount = mountOverview(root, ctx);
  await flush();

  fireClick(byId(root, 'btn-start-ops'));
  await flush();

  assert.deepEqual(state.navCalls[state.navCalls.length - 1], { viewId: 'fill', params: undefined });

  unmount();
});

// ============================================================
// L. report.js：無紀錄／有紀錄兩種情境
// ============================================================

await at('report：無稽核紀錄時顯示「無稽核紀錄」，不崩潰', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ params: { store: 'sxl-gf', month: '2026-08' } });
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });

  const unmount = mountReport(root, ctx);
  await flush();

  const empty = findDescendant(root, (n) => n.classList && n.classList.contains('report-empty'));
  assert.ok(empty, '應該顯示無稽核紀錄的提示');
  assert.equal(empty.textContent, '無稽核紀錄');

  unmount();
});

await at('report：有紀錄時顯示合格率、未完成清單擺最前面', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ params: { store: 'sxl-gf', month: '2026-08' } });
  const record = {
    record_key: 'sxl-gf_2026-08', store: 'sxl-gf', month: '2026-08', status: '已稽核',
    audit_date: '2026-08-15', auditor: '王會計', total_count: 19, pass_count: 17,
    fail_count: 1, pending_count: 1, track_count: 0, pass_rate: 89
  };
  const details = [
    { record_key: 'sxl-gf_2026-08', store: 'sxl-gf', month: '2026-08', item_id: 'c0g0i0', cat: '營運管理', group: '消防安全', text: '一家店至少兩支滅火器', verdict: '未完成', track: false, note: '壓力不足' }
  ];
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [record], ops_details: details });

  const unmount = mountReport(root, ctx);
  await flush();

  const rateEl = findDescendant(root, (n) => n.classList && n.classList.contains('report-rate'));
  assert.ok(rateEl.innerHTML.includes('89'), '應該顯示合格率 89%：' + rateEl.innerHTML);

  const failTable = findDescendant(root, (n) => n.classList && n.classList.contains('report-ops-fail'));
  assert.ok(failTable, '應該有未完成項目表格');

  unmount();
});

// ============================================================
// M. index.js：ctx.viewId 分派到正確分頁，未實作的 'my' 顯示占位卡片而不是崩潰
// ============================================================

await at("index.js：ctx.viewId='overview' 掛出總覽（找得到年份下拉）", async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [] });
  ctx.viewId = 'overview';

  const unmount = auditOpsIndex.mount(root, ctx);
  await flush();

  assert.ok(byId(root, 'ops-overview-year'), "viewId='overview' 應該掛出總覽畫面");

  unmount();
});

await at("index.js：ctx.viewId='fill' 掛出稽核填寫（不是「尚未完成」占位卡片）", async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });
  ctx.viewId = 'fill';

  const unmount = auditOpsIndex.mount(root, ctx);
  await flush();

  assert.ok(byId(root, 'ops-store'), "viewId='fill' 應該掛出稽核填寫畫面");
  const placeholder = findDescendant(root, (n) => n.textContent === '此分頁尚未完成');
  assert.equal(placeholder, null, '不該還是顯示尚未完成的佔位卡片');

  unmount();
});

await at("index.js：ctx.viewId='report' 掛出報告畫面", async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), ops_records: [], ops_details: [] });
  ctx.viewId = 'report';

  const unmount = auditOpsIndex.mount(root, ctx);
  await flush();

  assert.ok(byId(root, 'opsreport-store'), "viewId='report' 應該掛出報告畫面");

  unmount();
});

await at("index.js：ctx.viewId='my'（尚未實作）顯示「此分頁尚未完成」占位卡片，不崩潰", async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  ctx.viewId = 'my';

  const unmount = auditOpsIndex.mount(root, ctx);
  await flush();

  const placeholder = findDescendant(root, (n) => n.textContent === '此分頁尚未完成');
  assert.ok(placeholder, "viewId='my' 應該顯示占位卡片，而不是拋錯或空白");
  assert.equal(state.apiCalls.length, 0, '占位分頁不該呼叫後端');

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
