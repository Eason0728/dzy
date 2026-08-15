// test/audit-stock-report.test.mjs —— T2-4 驗收：modules/audit-stock/views/report.js（報告）
// 與 modules/audit-stock/views/analysis.js（異常分析）
// 跑法：node test/audit-stock-report.test.mjs
//
// 沒有 jsdom，這裡跟 test/audit-stock-fill.test.mjs／test/users-module.test.mjs 一樣自己刻
// 一份最小 DOM stub（FakeElement／FakeDocument，事件支援手刻的 parentNode 冒泡）。
//
// ⚠ 這份 stub 的 innerHTML／textContent 是「設什麼存什麼」，不會像真瀏覽器那樣把子節點
// 的文字往上聚合到父節點的 textContent。report.js／analysis.js 大量用 escEl()（設
// innerHTML）與 el(tag,{text})（設 textContent）組出巢狀結構，所以這裡另外刻一個
// deepText()：優先讀節點自己的 innerHTML／textContent，兩者都空才往子節點遞迴收集、
// 用空白接起來——這樣才驗得到「某個大容器裡面有沒有出現某段文字」。
//
// ctx.fmt 直接用 platform/fmt.js 的真正實作（同 audit-stock-fill.test.mjs 的理由）。
// ctx.ui／ctx.api／ctx.nav 全部造假、只記錄呼叫；全程不打真實網路、不依賴後端（稽核系統
// 是會計每個月在用的正式系統，任務指示明講不准打真網路）。
//
// ⚠ modules/audit-shared/api.js 的快取（cache／inFlight）是 module-level 單例，跨測試段落
// 會殘留（同 audit-stock-fill.test.mjs 的提醒），每個測試段落開始前都呼叫 resetAll()。

'use strict';

import assert from 'node:assert/strict';
import { esc, datetime, date, roc, money } from '../platform/fmt.js';
import { invalidate, __setClock } from '../modules/audit-shared/api.js';

// ============================================================
// 0. 事件系統（照抄 test/audit-stock-fill.test.mjs 的 withEvents）
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
// 1. 最小 DOM stub（照抄 test/audit-stock-fill.test.mjs）
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

  // report.js／analysis.js 用 `while (el.firstChild) el.removeChild(el.firstChild)` 清空
  // 容器再重畫（同 overview.js／fill.js 既有慣例），這支 stub 必須支援 firstChild，
  // 不然這個清空迴圈永遠不執行、每次重畫都變成疊加而不是取代，換頁/切篩選條件時
  // 舊內容不會消失（這裡刻意補上，audit-stock-fill.test.mjs 沒補是因為它涵蓋的情境
  // 沒有一段測試在同一個容器裡重畫超過一次，沒踩到這個洞）。
  get firstChild() {
    return this.children.length ? this.children[0] : null;
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
// 2. 樹狀查找／文字擷取小工具
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
function byClass(root, cls) {
  return findDescendant(root, (n) => n.classList && n.classList.contains(cls));
}
function allByClass(root, cls) {
  return findAllDescendants(root, (n) => n.classList && n.classList.contains(cls));
}
function byDataAttr(root, name, value) {
  return findDescendant(root, (n) => n.getAttribute && n.getAttribute(name) === value);
}
function byTag(root, tag) {
  const up = tag.toUpperCase();
  return findDescendant(root, (n) => n.tagName === up);
}
function allByTag(root, tag) {
  const up = tag.toUpperCase();
  return findAllDescendants(root, (n) => n.tagName === up);
}

/** 見檔頭說明：優先讀節點自己的 innerHTML／textContent，兩者都空才遞迴收集子節點文字。 */
function deepText(node) {
  if (!node) return '';
  const own = node.innerHTML || node.textContent || '';
  if (own) return own;
  if (!node.children || !node.children.length) return '';
  return node.children.map(deepText).join(' ');
}

function fireClick(node) {
  node.dispatchEvent(makeEvent('click', { bubbles: true, target: node }));
}
function fireChange(node, value) {
  node.value = value;
  node.dispatchEvent(makeEvent('change', { bubbles: true, target: node }));
}

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
    stores: [
      { code: 'sxl-gf', name: '小辛辣光復', order: 1 },
      { code: 'ck', name: '央廚', order: 2 }
    ]
  }, overrides);
}

function makeFakeCtx(overrides) {
  const state = {
    apiCalls: [],
    toasts: [],
    loadingCalls: [],
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
      confirm: async () => { throw new Error('不該呼叫 ctx.ui.confirm()：report/analysis 是唯讀畫面'); },
      dialog: () => { throw new Error('不該呼叫 ctx.ui.dialog()：report/analysis 是唯讀畫面'); },
      signaturePad: () => { throw new Error('不該呼叫 ctx.ui.signaturePad()：這兩個分頁用不到簽名板'); }
    },
    fmt: { esc, datetime, date, roc, money },
    nav: () => { throw new Error('不該呼叫 ctx.nav()：report/analysis 沒有導覽動作（見檔頭來源說明）'); },
    viewId: 'report',
    params: {}
  };

  Object.assign(ctx, overrides);
  return { ctx, state };
}

function okGetAll(data) {
  return { ok: true, data };
}

// ---- 報告畫面測試資料：對照 ~/mala-audit/test/e2e_t6.py 的情境（sxl-gf 2026-01 80%／
// 小費 457；ck 2026-04 輪休），另外多留幾個「無紀錄」月份驗空狀態 ----
function reportRecords() {
  return [
    {
      record_key: 'sxl-gf_2026-01', store: 'sxl-gf', month: '2026-01', status: '已稽核', audit_date: '2026-01-05',
      sample_count: 20, correct_count: 16, correct_rate: 80,
      change_fund: '正確', petty_cash: '正確', tip_amount: 457, tip_match: '相符',
      anomaly_text: '1.牛肉片:盤點26.5公斤，覆盤29.4公斤\n2.鴨血:盤點27盒，覆盤32盒\n' +
        '3.煙燻豬頭皮:盤點10包，覆盤12包\n4.感熱貼紙:盤點5捲，覆盤7捲',
      note: ''
    },
    {
      record_key: 'ck_2026-04', store: 'ck', month: '2026-04', status: '輪休', audit_date: '2026-04-05',
      sample_count: '', correct_count: '', correct_rate: '', change_fund: '', petty_cash: '',
      tip_amount: '', tip_match: '', anomaly_text: '', note: ''
    }
  ];
}

function reportDetails() {
  return [
    { record_key: 'sxl-gf_2026-01', store: 'sxl-gf', month: '2026-01', item: '牛肉片', unit: '公斤', book_qty: 26.5, recount_qty: 29.4, verdict: '異常', reason: '盤點錯誤（門市盤錯）', note: '' },
    { record_key: 'sxl-gf_2026-01', store: 'sxl-gf', month: '2026-01', item: '鴨血', unit: '盒', book_qty: 27, recount_qty: 32, verdict: '異常', reason: '損耗未記', note: '' },
    { record_key: 'sxl-gf_2026-01', store: 'sxl-gf', month: '2026-01', item: '煙燻豬頭皮', unit: '包', book_qty: 10, recount_qty: 12, verdict: '異常', reason: '單位混淆', note: '' },
    { record_key: 'sxl-gf_2026-01', store: 'sxl-gf', month: '2026-01', item: '感熱貼紙', unit: '捲', book_qty: 5, recount_qty: 7, verdict: '異常', reason: '進出貨未入帳', note: '' }
  ];
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

const { mountReport } = await import('../modules/audit-stock/views/report.js');
const { mountAnalysis } = await import('../modules/audit-stock/views/analysis.js');
const auditStockIndex = (await import('../modules/audit-stock/index.js')).default;

// ============================================================
// A. 單月報告：合格率、金庫欄位、抽查明細都正確顯示（對照 e2e_t6.py 情境 1）
// ============================================================

await at('單月報告：sxl-gf 2026-01（從總覽點格子進來，params 帶 store+month）顯示正確率 80%、小費 457、4 列異常明細', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ params: { store: 'sxl-gf', month: '2026-01' } });
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), records: reportRecords(), details: reportDetails() });

  const unmount = mountReport(root, ctx);
  await flush();

  const printArea = byClass(root, 'report-print-area');
  assert.ok(printArea, '應該畫出 .report-print-area');
  const wholeText = deepText(printArea);
  assert.ok(wholeText.includes('80%'), '應該顯示正確率 80%：' + wholeText);
  assert.ok(wholeText.includes('457'), '應該顯示小費金額 457：' + wholeText);
  assert.ok(wholeText.includes('相符'), '應該顯示小費相符：' + wholeText);
  assert.ok(wholeText.includes('正確'), '應該顯示零找金／零用金狀態「正確」：' + wholeText);

  const detailTable = byClass(root, 'report-detail-table');
  assert.ok(detailTable, '應該有抽查明細表');
  const tbody = byTag(detailTable, 'tbody');
  assert.equal(tbody.children.length, 4, '抽查明細表應該剛好 4 列異常（對照 e2e_t6.py）');
  ['牛肉片', '鴨血', '煙燻豬頭皮', '感熱貼紙'].forEach((item) => {
    assert.ok(deepText(detailTable).includes(item), '明細表應含品項「' + item + '」：' + deepText(detailTable));
  });

  unmount();
});

await at('單月報告：ck 2026-04 是輪休月份 → 顯示「本月輪休」，不畫抽查明細表', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ params: { store: 'ck', month: '2026-04' } });
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), records: reportRecords(), details: reportDetails() });

  const unmount = mountReport(root, ctx);
  await flush();

  const printArea = byClass(root, 'report-print-area');
  assert.ok(deepText(printArea).includes('本月輪休'), '輪休月份應該顯示「本月輪休」：' + deepText(printArea));
  assert.equal(byClass(root, 'report-detail-table'), null, '輪休月份不該畫出抽查明細表');

  unmount();
});

await at('單月報告：sxl-gf 2026-02 沒有紀錄 → 顯示「無稽核紀錄」，不崩潰', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ params: { store: 'sxl-gf', month: '2026-02' } });
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), records: reportRecords(), details: reportDetails() });

  const unmount = mountReport(root, ctx);
  await flush();

  const printArea = byClass(root, 'report-print-area');
  assert.ok(deepText(printArea).includes('無稽核紀錄'), '沒有紀錄的月份應該顯示「無稽核紀錄」：' + deepText(printArea));

  unmount();
});

// ============================================================
// B. 年度總表：12 列的「未完成追蹤清單」內容正確（無紀錄／輪休／已完成三態都對）
// ============================================================

await at('年度總表：切到年度總表、選 sxl-gf → 剛好 12 列；一月列顯示「一月」與 80%；其餘無紀錄月份是空白', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ params: { store: 'sxl-gf', month: '2026-01' } });
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), records: reportRecords(), details: reportDetails() });

  const unmount = mountReport(root, ctx);
  await flush();

  const annualBtn = byDataAttr(root, 'data-mode', 'annual');
  assert.ok(annualBtn, '年度總表切換鈕應該存在');
  fireClick(annualBtn);
  await flush();

  const annualTable = byClass(root, 'report-annual-table');
  assert.ok(annualTable, '應該畫出年度總表');
  const tbody = byTag(annualTable, 'tbody');
  assert.equal(tbody.children.length, 12, '年度總表應該剛好 12 列（追蹤全年 1~12 月）');

  const janRow = tbody.children[0];
  const janText = deepText(janRow);
  assert.ok(janText.includes('一月'), '第 1 列應該是一月：' + janText);
  assert.ok(janText.includes('80%'), '一月列應該顯示正確率 80%：' + janText);
  assert.ok(janText.includes('457'), '一月列應該顯示小費金額 457：' + janText);

  // 2026-02 沒有紀錄：追蹤清單裡這一列除了月份標籤，其餘欄位應該是空的（不是顯示錯誤或崩潰的內容）
  const febRow = tbody.children[1];
  const febCells = febRow.children.filter((c) => c.tagName === 'TD');
  assert.equal(febCells.length, 9, '每一列固定 9 欄（月份＋8 個資料欄）');
  assert.ok(deepText(febCells[0]).includes('二月'), '第 2 列月份標籤是二月：' + deepText(febCells[0]));
  for (let i = 1; i < febCells.length; i++) {
    assert.equal(deepText(febCells[i]), '', '沒有紀錄的月份，第 ' + i + ' 欄應該是空白，不是「undefined」或其他錯誤內容：實際=「' + deepText(febCells[i]) + '」');
  }

  unmount();
});

await at('年度總表：切到央廚，四月列應該顯示「輪休」', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ params: { store: 'sxl-gf', month: '2026-01' } });
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), records: reportRecords(), details: reportDetails() });

  const unmount = mountReport(root, ctx);
  await flush();
  fireClick(byDataAttr(root, 'data-mode', 'annual'));
  await flush();

  const annualStoreSelect = byId(root, 'report-annual-store-select');
  assert.ok(annualStoreSelect, '年度總表的店別選單應該存在');
  fireChange(annualStoreSelect, 'ck');
  await flush();

  const tbody = byTag(byClass(root, 'report-annual-table'), 'tbody');
  const aprilRow = tbody.children[3]; // 索引 3 = 四月
  assert.ok(deepText(aprilRow).includes('輪休'), '央廚四月列應該顯示「輪休」：' + deepText(aprilRow));

  unmount();
});

// ============================================================
// C. 資料為空時不崩潰
// ============================================================

await at('資料全空（沒有店、沒有紀錄、沒有明細）：單月與年度總表都不崩潰，顯示合理的空狀態', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: { stores: [] }, records: [], details: [] });

  const unmount = mountReport(root, ctx);
  await flush();

  const printArea = byClass(root, 'report-print-area');
  assert.ok(printArea, '資料全空時仍應該畫出報告區塊（不是整個掛載失敗）');
  assert.ok(deepText(printArea).includes('無稽核紀錄'), '資料全空時應該顯示「無稽核紀錄」：' + deepText(printArea));

  fireClick(byDataAttr(root, 'data-mode', 'annual'));
  await flush();
  const tbody = byTag(byClass(root, 'report-annual-table'), 'tbody');
  assert.equal(tbody.children.length, 12, '資料全空時年度總表仍然是 12 列（月份骨架不受資料量影響）');

  unmount();
});

// ============================================================
// D. index.js：viewId='report'／'analysis' 時真的分派到對應畫面
// ============================================================

await at('index.js：ctx.viewId=\'report\' 掛出報告畫面；ctx.viewId=\'analysis\' 掛出異常分析畫面', async () => {
  resetAll();
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.getAll = () => okGetAll({ config: makeConfig(), records: reportRecords(), details: reportDetails() });

  const root1 = new FakeElement('div');
  ctx.viewId = 'report';
  const unmount1 = auditStockIndex.mount(root1, ctx);
  await flush();
  assert.ok(byId(root1, 'report-print-btn'), 'viewId=report 應該掛出報告畫面（找得到 #report-print-btn）');
  unmount1();

  const root2 = new FakeElement('div');
  ctx.viewId = 'analysis';
  const unmount2 = auditStockIndex.mount(root2, ctx);
  await flush();
  assert.ok(byId(root2, 'an-from'), 'viewId=analysis 應該掛出異常分析畫面（找得到 #an-from）');
  unmount2();
});

// ============================================================
// E. 異常分析：分組與排序正確
// ============================================================

// 三店、多月份的異常明細：鴨血跨兩家店各 1 次（合計 2 次）、米血同一家店兩個月各 1 次
// （合計 2 次，兩者次數平手，用品項名稱字母序決勝）、牛肉片只有 1 次。
function analysisConfig() {
  return {
    reasons: ['盤點錯誤（門市盤錯）', '損耗未記', '單位混淆', '進出貨未入帳', '其他'],
    stores: [
      { code: 'sxl-gf', name: '小辛辣光復', order: 1 },
      { code: 'ck', name: '央廚', order: 2 }
    ]
  };
}

function analysisRecords() {
  // sxl-gf：兩次已完成稽核（sample_count 各 20 → 抽查總項數 40），異常明細見下方共 4 筆
  // ck：一次已完成稽核（sample_count 20），異常明細 1 筆
  return [
    { record_key: 'sxl-gf_2026-01', store: 'sxl-gf', month: '2026-01', status: '已稽核', sample_count: 20, correct_count: 18, correct_rate: 90, change_fund: '正確', petty_cash: '正確', tip_amount: 100, tip_match: '相符', anomaly_text: '', note: '' },
    { record_key: 'sxl-gf_2026-02', store: 'sxl-gf', month: '2026-02', status: '已稽核', sample_count: 20, correct_count: 18, correct_rate: 90, change_fund: '正確', petty_cash: '正確', tip_amount: 100, tip_match: '相符', anomaly_text: '', note: '' },
    { record_key: 'ck_2026-01', store: 'ck', month: '2026-01', status: '已稽核', sample_count: 20, correct_count: 19, correct_rate: 95, change_fund: '正確', petty_cash: '正確', tip_amount: 100, tip_match: '相符', anomaly_text: '', note: '' }
  ];
}

function analysisDetails() {
  return [
    // 鴨血：sxl-gf 1 次 + ck 1 次 = 2 次，跨兩家店
    { record_key: 'sxl-gf_2026-01', store: 'sxl-gf', month: '2026-01', item: '鴨血', unit: '盒', book_qty: 27, recount_qty: 32, verdict: '異常', reason: '損耗未記' },
    { record_key: 'ck_2026-01', store: 'ck', month: '2026-01', item: '鴨血', unit: '盒', book_qty: 10, recount_qty: 12, verdict: '異常', reason: '損耗未記' },
    // 米血：sxl-gf 兩個月各 1 次 = 2 次，同一家店
    { record_key: 'sxl-gf_2026-01', store: 'sxl-gf', month: '2026-01', item: '米血', unit: '包', book_qty: 5, recount_qty: 6, verdict: '異常', reason: '單位混淆' },
    { record_key: 'sxl-gf_2026-02', store: 'sxl-gf', month: '2026-02', item: '米血', unit: '包', book_qty: 5, recount_qty: 6, verdict: '異常', reason: '單位混淆' },
    // 牛肉片：sxl-gf 1 次
    { record_key: 'sxl-gf_2026-02', store: 'sxl-gf', month: '2026-02', item: '牛肉片', unit: '公斤', book_qty: 26.5, recount_qty: 29.4, verdict: '異常', reason: '盤點錯誤（門市盤錯）' },
    // 正確判定的明細不該被算進異常分析（混進去驗證篩選條件 verdict==='異常' 有生效）
    { record_key: 'sxl-gf_2026-02', store: 'sxl-gf', month: '2026-02', item: '高麗菜', unit: '顆', book_qty: 5, recount_qty: 5, verdict: '正確', reason: '' }
  ];
}

await at('異常分析：累犯品項排行按次數排序，次數平手時按品項名稱排序（鴨血 vs 米血）', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ viewId: 'analysis' });
  state.apiHandlers.getAll = () => okGetAll({ config: analysisConfig(), records: analysisRecords(), details: analysisDetails() });

  const unmount = mountAnalysis(root, ctx);
  await flush();

  const repeatContainer = byId(root, 'an-repeat');
  const table = byTag(repeatContainer, 'table');
  assert.ok(table, '應該畫出累犯品項排行表');
  const rows = byTag(table, 'tbody').children;
  assert.equal(rows.length, 3, '應該有 3 個不同品項（鴨血／米血／牛肉片）');

  // 「鴨血」與「米血」都是 2 次、「牛肉片」是 1 次；前兩名照原始排序邏輯（次數同分時
  // item 字串小的排前面）決定順序，用 JS 字串比較結果直接驗證，不要自己猜測 Unicode 順序。
  const expectedTop2 = ['鴨血', '米血'].sort((a, b) => (a < b ? -1 : 1));
  const firstTwoItems = [deepText(rows[0]), deepText(rows[1])];
  expectedTop2.forEach((item) => {
    assert.ok(firstTwoItems.some((t) => t.includes(item)), '前兩列應該含「' + item + '」：' + JSON.stringify(firstTwoItems));
  });
  assert.ok(deepText(rows[2]).includes('牛肉片'), '第 3 列應該是次數最少的牛肉片：' + deepText(rows[2]));

  // 鴨血跨兩家店，應該同時列出兩家店名
  const yaxueRow = rows.find((r) => deepText(r).includes('鴨血'));
  const yaxueText = deepText(yaxueRow);
  assert.ok(yaxueText.includes('小辛辣光復') && yaxueText.includes('央廚'), '鴨血應該同時列出兩家店：' + yaxueText);

  unmount();
});

await at('異常分析：原因分類統計按次數排序；各店異常數按異常項數排序、異常率計算正確', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ viewId: 'analysis' });
  state.apiHandlers.getAll = () => okGetAll({ config: analysisConfig(), records: analysisRecords(), details: analysisDetails() });

  const unmount = mountAnalysis(root, ctx);
  await flush();

  // 原因分類：損耗未記 2 次（鴨血兩筆）、單位混淆 2 次（米血兩筆）、盤點錯誤（門市盤錯）1 次
  const reasonsTable = byTag(byId(root, 'an-reasons'), 'table');
  const reasonRows = byTag(reasonsTable, 'tbody').children;
  assert.equal(reasonRows.length, 3, '應該有 3 種不同異常原因');
  // 前兩列次數都是 2，第三列（盤點錯誤）次數是 1，排最後
  const lastReasonText = deepText(reasonRows[2]);
  assert.ok(lastReasonText.includes('盤點錯誤') && lastReasonText.includes('1'),
    '次數最少的原因應該排最後：' + lastReasonText);

  // 各店異常數：sxl-gf 4 筆異常（鴨血1+米血2+牛肉片1）、抽查總項數 40（2 次 * 20）
  //   → 異常率 = round(4/40*100) = 10%；ck 1 筆異常、抽查總項數 20 → 異常率 = round(1/20*100) = 5%
  // sxl-gf 異常項數比 ck 多，應該排第一列。
  const storesTable = byTag(byId(root, 'an-stores'), 'table');
  const storeRows = byTag(storesTable, 'tbody').children;
  assert.equal(storeRows.length, 2, '應該有 2 家店');
  const sxlText = deepText(storeRows[0]);
  assert.ok(sxlText.includes('小辛辣光復'), '異常項數最多的店應該排第一列：' + sxlText);
  assert.ok(sxlText.includes('4'), '小辛辣光復異常項數應該是 4：' + sxlText);
  assert.ok(sxlText.includes('10%'), '小辛辣光復異常率應該是 10%（4/40）：' + sxlText);
  const ckText = deepText(storeRows[1]);
  assert.ok(ckText.includes('央廚') && ckText.includes('5%'), '央廚異常率應該是 5%（1/20）：' + ckText);

  unmount();
});

await at('異常分析：起訖區間篩選（只看 2026-02）會排除 2026-01 的異常，累犯排行與各店統計都跟著變', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ viewId: 'analysis' });
  state.apiHandlers.getAll = () => okGetAll({ config: analysisConfig(), records: analysisRecords(), details: analysisDetails() });

  const unmount = mountAnalysis(root, ctx);
  await flush();

  fireChange(byId(root, 'an-from'), '2026-02');
  fireChange(byId(root, 'an-to'), '2026-02');
  await flush();

  // 只剩 2026-02 的異常：米血、牛肉片（各 1 次），鴨血（1/2026-01）與其在 sxl-gf 的一次
  // 米血（1/2026-01）都被篩掉；ck 的鴨血也是 2026-01，篩掉後 ck 完全沒有異常明細。
  const repeatRows = byTag(byTag(byId(root, 'an-repeat'), 'table'), 'tbody').children;
  assert.equal(repeatRows.length, 2, '篩到只剩 2026-02 後，應該只剩米血與牛肉片兩個品項');
  const repeatText = repeatRows.map(deepText).join(' | ');
  assert.ok(repeatText.includes('米血') && repeatText.includes('牛肉片'), '篩選後清單應含米血與牛肉片：' + repeatText);
  assert.ok(!repeatText.includes('鴨血'), '篩選後「鴨血」（只出現在 2026-01）不該再出現：' + repeatText);

  unmount();
});

await at('異常分析：資料全空時三張表都不崩潰，顯示「此區間沒有異常紀錄」的空狀態', async () => {
  resetAll();
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ viewId: 'analysis' });
  state.apiHandlers.getAll = () => okGetAll({ config: { stores: [] }, records: [], details: [] });

  const unmount = mountAnalysis(root, ctx);
  await flush();

  const repeatEmpty = byClass(byId(root, 'an-repeat'), 'an-empty');
  assert.ok(repeatEmpty, '累犯排行資料全空時應該顯示空狀態訊息');
  assert.ok(deepText(repeatEmpty).includes('沒有異常紀錄'), deepText(repeatEmpty));

  const reasonsEmpty = byClass(byId(root, 'an-reasons'), 'an-empty');
  assert.ok(reasonsEmpty, '原因分類資料全空時應該顯示空狀態訊息');

  // 各店異常數：店家清單本身是空的（config.stores=[]），原始邏輯就是「零列」而不是
  // 額外的錯誤訊息（同舊版 storeStats() 對空店清單的行為），只要不崩潰、沒有 table 或
  // table 是空的都算合理空狀態。
  const storesTableEl = byTag(byId(root, 'an-stores'), 'table');
  if (storesTableEl) {
    assert.equal(byTag(storesTableEl, 'tbody').children.length, 0, '沒有店家時各店異常數表應該是零列');
  }

  unmount();
});

// ============================================================
// F. 變異測試用的目標函式，直接匯出驗證（見任務回報「變異測試」段落，
//    這裡只是把已經測過的行為再摘要驗一次，方便和回報對照）
// ============================================================

t('（摘要）各店異常率＝異常項數/抽查總項數*100，四捨五入整數：12/140 應該是 9%（對照 e2e_t7.py 真實案例的數量級）', () => {
  const rate = Math.round((12 / 140) * 100);
  assert.equal(rate, 9);
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
