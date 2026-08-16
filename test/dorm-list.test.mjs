// test/dorm-list.test.mjs —— T3-2 驗收：modules/dorm/views/list.js（合約清單）
//                                        與 modules/dorm/index.js（mount/onRoute/badge）
// 跑法：node test/dorm-list.test.mjs
//
// ⚠ 宿舍合約系統存的是同仁實際簽過的租約，是法律文件。這支測試全程用假資料、假
// ctx.api.call，一律不打真實網路——測試最開始就把 globalThis.fetch 換成「呼叫了就丟錯」
// 的哨兵函式（做法照抄 test/dorm-api.test.mjs），檔案最後對呼叫次數做總量斷言。
//
// 沒有 jsdom，DOM stub（FakeElement／FakeDocument／withEvents／flush／byId／allByClass／
// byDataAttr／findDescendant／findAllDescendants／fireClick）照抄
// test/audit-stock-fill.test.mjs 的做法。ctx.fmt 直接用 platform/fmt.js 的真正實作
// （純函式、沒有瀏覽器依賴，同該檔案的理由）。ctx.ui／ctx.api／ctx.can／ctx.nav 全部
// 造假、只記錄呼叫。

'use strict';

const realNetworkCalls = [];
globalThis.fetch = async (url) => {
  realNetworkCalls.push(String(url));
  throw new Error('GUARD: 這次呼叫沒有被 mock，攔截下來避免真的打網路。url=' + url);
};

import assert from 'node:assert/strict';
import { esc, datetime, date, roc, money } from '../platform/fmt.js';
import { validateManifest } from '../platform/manifest-check.js';

// ============================================================
// 0. 事件系統 + 最小 DOM stub（照抄 test/audit-stock-fill.test.mjs）
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

// ============================================================
// 1. 樹狀查找／事件觸發小工具（照抄 test/audit-stock-fill.test.mjs）
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

function allByClass(root, cls) {
  return findAllDescendants(root, (n) => n.classList && n.classList.contains(cls));
}
function allByDataAttr(root, name, value) {
  return findAllDescendants(root, (n) => n.getAttribute && n.getAttribute(name) === value);
}
function textOf(root) {
  // FakeElement 的 textContent 只在「直接 set」時有值；escEl()/el(text) 混用 innerHTML
  // 與 children，所以找文字要遞迴撈 innerHTML 與 textContent 兩種寫法，同時涵蓋。
  const own = root._textContent || root._innerHTML || '';
  const childText = (root.children || []).map(textOf).join('');
  return own + childText;
}
function findByText(root, text) {
  return findDescendant(root, (n) => textOf(n).includes(text) && (n.children || []).every((c) => !textOf(c).includes(text)));
}

function fireClick(node) {
  node.dispatchEvent(makeEvent('click', { bubbles: true, target: node }));
}

/** 等待 microtask/setImmediate 佇列跑過幾輪，讓 async 呼叫鏈落地（同 audit-stock-fill 慣例）。 */
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
// 2. 假 ctx／假資料
// ============================================================

function makeContract(overrides) {
  return Object.assign({
    contract_id: 'C0001',
    name: '王小明',
    room: '二樓單人房',
    bed: '',
    room_bed_display: '二樓單人房',
    rent: 3500,
    term_start: '2026-01-01',
    term_end: '2026-06-30',
    term_no: '1',
    status: '在住',
    terminate_flag: '',
    signed_at: '2026-01-02 09:15:00'
  }, overrides);
}

function farFutureDateStr(days) {
  return date(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
}

/** 造一個假 ctx；state 記錄所有呼叫，供斷言用。canWrite 控制 ctx.can('dorm.write')。 */
function makeFakeCtx({ canWrite = true, listHandler, terminateHandler, nextConfirm = true } = {}) {
  const state = {
    apiCalls: [],
    toasts: [],
    loadingCalls: [],
    confirmCalls: [],
    nextConfirm
  };

  const ctx = {
    user: { id: 'u001', name: '王會計', role: 'manager', node: '' },
    can: (perm) => (perm === 'dorm.write' ? canWrite : true),
    api: {
      call: async (backendId, action, payload) => {
        state.apiCalls.push({ backendId, action, payload });
        if (action === 'list') {
          if (typeof listHandler === 'function') return listHandler(payload);
          return { ok: true, data: { contracts: [] } };
        }
        if (action === 'terminate') {
          if (typeof terminateHandler === 'function') return terminateHandler(payload);
          return { ok: true, data: {} };
        }
        return { ok: false, error: '未知的 action：' + action };
      }
    },
    ui: {
      toast: (message, type) => { state.toasts.push({ message, type }); },
      loading: (on) => { state.loadingCalls.push(on); },
      confirm: async (message) => {
        state.confirmCalls.push(message);
        return typeof state.nextConfirm === 'function' ? state.nextConfirm() : state.nextConfirm;
      },
      dialog: () => { throw new Error('不該呼叫 ctx.ui.dialog()：list.js 只用 ctx.ui.confirm()'); },
      signaturePad: () => { throw new Error('不該呼叫 ctx.ui.signaturePad()：這個分頁用不到簽名板'); }
    },
    fmt: { esc, datetime, date, roc, money },
    nav: () => {},
    viewId: 'list',
    params: {}
  };

  return { ctx, state };
}

// ============================================================
// 3. 測試小工具
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

const { mountList } = await import('../modules/dorm/views/list.js');
const dormIndex = (await import('../modules/dorm/index.js')).default;
const dormManifest = (await import('../modules/dorm/manifest.js')).default;

// ============================================================
// A. manifest 驗證：通過 platform/manifest-check.js（errors 為空）
// ============================================================

await at('manifest：驗證通過，errors 為空陣列', () => {
  const r = validateManifest(dormManifest);
  assert.equal(r.ok, true, 'manifest 應驗證通過：' + JSON.stringify(r.errors));
  assert.deepEqual(r.errors, []);
  assert.equal(dormManifest.backend, dormManifest.ns, 'backend 必須等於 ns（spec §4.1）');
  assert.deepEqual(dormManifest.views.map((v) => v.id), ['list', 'create', 'handover'], 'views 三個都要列上，list 是第一個（預設分頁）');
});

// ============================================================
// B. 清單渲染正確
// ============================================================

await at('清單渲染：多筆合約都畫出來，欄位內容正確（編號／姓名／房間床位／租金／期別／簽署）', async () => {
  const root = new FakeElement('div');
  const contracts = [
    makeContract({ contract_id: 'C0001', name: '王小明', rent: 3500, term_no: '1', signed_at: '2026-01-02 09:15:00' }),
    makeContract({ contract_id: 'C0002', name: '陳小華', room: '三樓四人房', bed: 'A', room_bed_display: '', rent: 1500, term_no: '不定期', status: '在住', signed_at: '' })
  ];
  const { ctx, state } = makeFakeCtx({ listHandler: () => ({ ok: true, data: { contracts } }) });

  const unmount = mountList(root, ctx);
  await flush();

  const rows = allByDataAttr(root, 'data-role', 'contract-row');
  assert.equal(rows.length, 2, '兩筆合約應該各畫一列');

  assert.ok(findByText(rows[0], 'C0001'), '第一列要看得到編號 C0001');
  assert.ok(findByText(rows[0], '王小明'), '第一列要看得到姓名');
  assert.ok(findByText(rows[0], '3,500'), '租金要用千分位（ctx.fmt.money）');
  assert.ok(findByText(rows[0], '第 1 期'), '期別 1 要顯示「第 1 期」');
  assert.ok(findByText(rows[0], '2026-01-02'), '簽署日期要顯示（ctx.fmt.date 只取日期）');

  assert.ok(findByText(rows[1], '三樓四人房 A'), '沒有 room_bed_display 時要自己組房間+床位');
  assert.ok(findByText(rows[1], '不定期（月租）'), '期別「不定期...」開頭要顯示「不定期（月租）」');
  assert.ok(findByText(rows[1], '1,500'), '第二筆租金也要千分位');

  assert.equal(state.apiCalls.length, 1, '掛載時應該只打一次 list');
  assert.equal(state.apiCalls[0].action, 'list');

  unmount();
});

// ============================================================
// C. 狀態顯示正確
// ============================================================

await at('狀態顯示：在住／待簽／已退宿三種狀態的標籤 class 正確，終止旗標顯示在狀態欄下方', async () => {
  const root = new FakeElement('div');
  const contracts = [
    makeContract({ contract_id: 'C0001', status: '在住', terminate_flag: '已通知終止 2026-08-10' }),
    makeContract({ contract_id: 'C0002', status: '待簽', terminate_flag: '' }),
    makeContract({ contract_id: 'C0003', status: '已退宿', terminate_flag: '' })
  ];
  const { ctx } = makeFakeCtx({ listHandler: () => ({ ok: true, data: { contracts } }) });

  const unmount = mountList(root, ctx);
  await flush();

  const rows = allByDataAttr(root, 'data-role', 'contract-row');

  const okTag = findDescendant(rows[0], (n) => n.classList && n.classList.contains('tag-ok'));
  assert.ok(okTag, '在住狀態要用 tag-ok');
  assert.ok(findByText(rows[0], '已通知終止 2026-08-10'), '有終止旗標時要顯示旗標文字');

  const warnTag = findDescendant(rows[1], (n) => n.classList && n.classList.contains('tag-warn'));
  assert.ok(warnTag, '待簽狀態要用 tag-warn');

  const tagEls = allByClass(rows[2], 'tag');
  assert.equal(tagEls.length, 1, '已退宿狀態要有一個 tag');
  assert.ok(!tagEls[0].classList.contains('tag-ok') && !tagEls[0].classList.contains('tag-warn') && !tagEls[0].classList.contains('tag-danger'),
    '已退宿是中性樣式，不套用 tag-ok/tag-warn/tag-danger 任何顏色變體（不新增色碼）');

  unmount();
});

// ============================================================
// D. 終止合約：二次確認，取消時不呼叫後端
// ============================================================

await at('終止合約：點擊後跳出確認；使用者取消 → 完全不呼叫後端 terminate', async () => {
  const root = new FakeElement('div');
  const contracts = [makeContract({ contract_id: 'C0001', status: '在住' })];
  const { ctx, state } = makeFakeCtx({
    canWrite: true,
    listHandler: () => ({ ok: true, data: { contracts } }),
    nextConfirm: false // 使用者按取消
  });

  const unmount = mountList(root, ctx);
  await flush();

  const btn = allByDataAttr(root, 'data-action', 'toggle-terminate')[0];
  assert.ok(btn, '在住合約且有寫入權限應該看得到終止按鈕');
  fireClick(btn);
  await flush();

  assert.equal(state.confirmCalls.length, 1, '應該呼叫一次 ctx.ui.confirm()');
  const terminateCalls = state.apiCalls.filter((c) => c.action === 'terminate');
  assert.equal(terminateCalls.length, 0, '使用者取消後，不該呼叫後端 terminate');

  unmount();
});

await at('終止合約：使用者確認 → 呼叫後端 terminate（帶正確 contract_id），成功後重新整理清單並 toast', async () => {
  const root = new FakeElement('div');
  let listHits = 0;
  const contracts = [makeContract({ contract_id: 'C0001', status: '在住', terminate_flag: '' })];
  const { ctx, state } = makeFakeCtx({
    canWrite: true,
    listHandler: () => { listHits++; return { ok: true, data: { contracts } }; },
    terminateHandler: (payload) => {
      assert.equal(payload.contract_id, 'C0001', '終止動作要帶正確的 contract_id');
      return { ok: true, data: { terminate_flag: '已通知終止 2026-08-16' } };
    },
    nextConfirm: true
  });

  const unmount = mountList(root, ctx);
  await flush();
  assert.equal(listHits, 1, '掛載時打一次 list（基準線）');

  const btn = allByDataAttr(root, 'data-action', 'toggle-terminate')[0];
  fireClick(btn);
  await flush();

  const terminateCalls = state.apiCalls.filter((c) => c.action === 'terminate');
  assert.equal(terminateCalls.length, 1, '確認後應該呼叫一次後端 terminate');
  assert.equal(listHits, 2, '終止成功後應該重新整理清單（再打一次 list）');
  const okToasts = state.toasts.filter((t) => t.type === 'ok');
  assert.ok(okToasts.length >= 1, '成功後應該有成功 toast');

  unmount();
});

// ============================================================
// E. 只有 dorm.read（沒有 dorm.write）時看不到終止按鈕
// ============================================================

await at('權限：只有 dorm.read（canWrite=false）時，在住合約也看不到終止按鈕，且完全不呼叫 terminate', async () => {
  const root = new FakeElement('div');
  const contracts = [makeContract({ contract_id: 'C0001', status: '在住' })];
  const { ctx, state } = makeFakeCtx({ canWrite: false, listHandler: () => ({ ok: true, data: { contracts } }) });

  const unmount = mountList(root, ctx);
  await flush();

  const btns = allByDataAttr(root, 'data-action', 'toggle-terminate');
  assert.equal(btns.length, 0, '唯讀者不該看到終止按鈕');
  assert.equal(state.confirmCalls.length, 0, '不該有任何確認彈窗');
  const terminateCalls = state.apiCalls.filter((c) => c.action === 'terminate');
  assert.equal(terminateCalls.length, 0, '唯讀者不可能觸發 terminate');

  unmount();
});

// ============================================================
// F. 後端回 {ok:false}：顯示 toast，不崩潰
// ============================================================

await at('載入清單：後端回 {ok:false} → 顯示 toast，不拋例外、畫面不崩潰', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ listHandler: () => ({ ok: false, error: '通行碼錯誤' }) });

  let threw = false;
  let unmount;
  try {
    unmount = mountList(root, ctx);
    await flush();
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'mount 不該拋例外');
  const dangerToasts = state.toasts.filter((t) => t.type === 'danger');
  assert.ok(dangerToasts.length >= 1, '應該有一則錯誤 toast');
  assert.ok(dangerToasts.some((t) => t.message === '通行碼錯誤'), 'toast 應該帶後端的錯誤訊息');

  if (unmount) unmount();
});

await at('終止合約：後端回 {ok:false} → 顯示 toast，不拋例外、畫面不崩潰', async () => {
  const root = new FakeElement('div');
  const contracts = [makeContract({ contract_id: 'C0001', status: '在住' })];
  const { ctx, state } = makeFakeCtx({
    canWrite: true,
    listHandler: () => ({ ok: true, data: { contracts } }),
    terminateHandler: () => ({ ok: false, error: '只有在住合約可以標記終止' }),
    nextConfirm: true
  });

  const unmount = mountList(root, ctx);
  await flush();

  const btn = allByDataAttr(root, 'data-action', 'toggle-terminate')[0];
  let threw = false;
  try {
    fireClick(btn);
    await flush();
  } catch {
    threw = true;
  }
  assert.equal(threw, false, '終止失敗不該拋例外');
  const dangerToasts = state.toasts.filter((t) => t.type === 'danger');
  assert.ok(dangerToasts.some((t) => t.message === '只有在住合約可以標記終止'), '應該顯示後端的錯誤訊息');

  unmount();
});

// ============================================================
// G. 清單為空時有合理空狀態
// ============================================================

await at('空清單：後端回傳空陣列 → 顯示空狀態文字，表格隱藏，不是一片空白', async () => {
  const root = new FakeElement('div');
  const { ctx } = makeFakeCtx({ listHandler: () => ({ ok: true, data: { contracts: [] } }) });

  const unmount = mountList(root, ctx);
  await flush();

  const emptyEl = findDescendant(root, (n) => n.classList && n.classList.contains('dorm-list-empty'));
  assert.ok(emptyEl, '應該有空狀態元素');
  assert.equal(emptyEl.hidden, false, '空清單時空狀態要顯示');
  assert.ok(textOf(emptyEl).length > 0, '空狀態要有文字說明');

  const tableWrap = findDescendant(root, (n) => n.classList && n.classList.contains('table-wrap'));
  assert.equal(tableWrap.hidden, true, '空清單時表格要隱藏');

  const rows = allByDataAttr(root, 'data-role', 'contract-row');
  assert.equal(rows.length, 0, '不該有任何資料列');

  unmount();
});

// ============================================================
// H. badge()：30 天內到期的「在住」合約數
// ============================================================

await at('badge：只算「在住」且 30 天內到期的合約，待簽／已退宿／太久以後到期都不算', async () => {
  const dueSoonEnd = farFutureDateStr(10);   // 10 天後：算
  const notDueEnd = farFutureDateStr(200);   // 200 天後：不算
  const contracts = [
    makeContract({ contract_id: 'C0001', status: '在住', term_end: dueSoonEnd }),
    makeContract({ contract_id: 'C0002', status: '在住', term_end: notDueEnd }),
    makeContract({ contract_id: 'C0003', status: '待簽', term_end: dueSoonEnd }),
    makeContract({ contract_id: 'C0004', status: '已退宿', term_end: dueSoonEnd }),
    makeContract({ contract_id: 'C0005', status: '在住', term_end: dueSoonEnd })
  ];
  const ctx = {
    api: { call: async (backendId, action) => (action === 'list' ? { ok: true, data: { contracts } } : { ok: false, error: 'x' }) },
    fmt: { esc, datetime, date, roc, money }
  };

  const n = await dormIndex.badge(ctx);
  assert.equal(n, 2, 'C0001 與 C0005 是在住且 30 天內到期，應該算 2 筆：' + n);
});

await at('badge：後端回 {ok:false} → 回 null，不拋錯', async () => {
  const ctx = {
    api: { call: async () => ({ ok: false, error: '通行碼錯誤' }) },
    fmt: { esc, datetime, date, roc, money }
  };
  let threw = false;
  let n;
  try {
    n = await dormIndex.badge(ctx);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'badge() 不該拋例外');
  assert.equal(n, null, '後端失敗應該回 null');
});

await at('badge：ctx.api.call 拋例外 → 回 null，不拋錯', async () => {
  const ctx = {
    api: { call: async () => { throw new Error('網路逾時'); } },
    fmt: { esc, datetime, date, roc, money }
  };
  let threw = false;
  let n;
  try {
    n = await dormIndex.badge(ctx);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'badge() 不該讓例外往外拋');
  assert.equal(n, null);
});

await at('badge：contracts 不是陣列（回傳格式不符）→ 回 null，不拋錯', async () => {
  const ctx = {
    api: { call: async () => ({ ok: true, data: { contracts: 'not-an-array' } }) },
    fmt: { esc, datetime, date, roc, money }
  };
  const n = await dormIndex.badge(ctx);
  assert.equal(n, null);
});

// ============================================================
// I. index.js：viewId 分派——list 掛出清單，create／handover 是占位卡片
// ============================================================

await at('index.js：viewId=\'list\' 掛出合約清單（不是占位卡片）', async () => {
  const root = new FakeElement('div');
  const { ctx } = makeFakeCtx({ listHandler: () => ({ ok: true, data: { contracts: [] } }) });
  ctx.viewId = 'list';

  const unmount = dormIndex.mount(root, ctx);
  await flush();

  assert.ok(findDescendant(root, (n) => n.classList && n.classList.contains('dorm-list-table')), 'viewId=list 應該掛出合約清單表格');
  const placeholder = findByText(root, '此分頁尚未完成');
  assert.equal(placeholder, null, '不該顯示占位卡片');

  unmount();
});

await at('index.js：viewId=\'create\' 與 \'handover\' 顯示「此分頁尚未完成」占位，不崩潰', async () => {
  for (const viewId of ['create', 'handover']) {
    const root = new FakeElement('div');
    const { ctx } = makeFakeCtx({ listHandler: () => ({ ok: true, data: { contracts: [] } }) });
    ctx.viewId = viewId;

    let threw = false;
    let unmount;
    try {
      unmount = dormIndex.mount(root, ctx);
      await flush();
    } catch {
      threw = true;
    }
    assert.equal(threw, false, `viewId=${viewId} 掛載不該拋例外`);
    assert.ok(findByText(root, '此分頁尚未完成'), `viewId=${viewId} 應該顯示占位卡片，未拿到`);

    if (unmount) unmount();
  }
});

await at('index.js：onRoute 切分頁——同一次 mount 內從 list 切到 create 會換成占位卡片', async () => {
  const root = new FakeElement('div');
  const { ctx } = makeFakeCtx({ listHandler: () => ({ ok: true, data: { contracts: [] } }) });
  ctx.viewId = 'list';

  const unmount = dormIndex.mount(root, ctx);
  await flush();
  assert.ok(findDescendant(root, (n) => n.classList && n.classList.contains('dorm-list-table')), '一開始應該是清單畫面');

  ctx.viewId = 'create'; // 殼原地更新同一個 ctx 物件（spec §4.7），再呼叫 onRoute
  dormIndex.onRoute(ctx);
  await flush();

  assert.equal(findDescendant(root, (n) => n.classList && n.classList.contains('dorm-list-table')), null, '切到 create 後清單表格應該被換掉');
  assert.ok(findByText(root, '此分頁尚未完成'), '切到 create 後應該顯示占位卡片');

  unmount();
});

// ============================================================
// J. 真實網路守衛總量斷言
// ============================================================
assert.equal(realNetworkCalls.length, 0, 'J: 全程真實網路呼叫次數為 0（未被 mock 的 fetch 從未被呼叫）');

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
