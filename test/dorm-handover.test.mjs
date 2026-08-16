// test/dorm-handover.test.mjs —— T3-4 驗收：modules/dorm/views/handover.js（退宿點交）
// 跑法：node test/dorm-handover.test.mjs
//
// DOM stub 做法同 test/dorm-create.test.mjs／test/audit-stock-fill.test.mjs（自己刻一份
// 最小 FakeElement／FakeDocument）。ctx.ui.signaturePad 也是假的——真正的簽名板
// （platform/ui.js）需要瀏覽器的 canvas 2D context／getComputedStyle／
// devicePixelRatio，這裡不重刻一份繪圖引擎，只驗證 handover.js「有沒有照 spec §4.10
// 呼叫 ctx.ui.signaturePad(canvasEl)、unmount 時有沒有呼叫它回傳物件的 destroy()」這件事
// 本身，簽名的畫圖細節不是這支測試的責任範圍（那是 platform/ui.js 自己的測試該管的）。
//
// 全程不打真實網路、不依賴後端（宿舍合約是同仁實際簽過的租約與退宿點交單，任務指示
// 明講測試一律用假資料）。真實網路守衛做法同 dorm-create.test.mjs。

'use strict';

const realNetworkCalls = [];
globalThis.fetch = async (url) => {
  realNetworkCalls.push(String(url));
  throw new Error('GUARD: 這次呼叫沒有被 mock，攔截下來避免真的打網路。url=' + url);
};

import assert from 'node:assert/strict';
import { esc, datetime, date, roc, money } from '../platform/fmt.js';

// ============================================================
// 0／1. 最小 DOM stub（做法照抄 test/dorm-create.test.mjs）
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
      const list = (this._listeners && this._listeners[event.type]) || [];
      for (const fn of list.slice()) fn.call(this, event);
      return true;
    }
  };
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
    this.checked = false;
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
  createTextNode(text) {
    const node = new FakeElement('#text');
    node.textContent = String(text);
    return node;
  }
}

globalThis.document = new FakeDocument();

// ============================================================
// 2. 樹狀查找／事件觸發小工具
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
function byDataAttr(root, name, value) {
  return findDescendant(root, (n) => n.getAttribute && n.getAttribute(name) === value);
}
function buttonByText(root, text) {
  return findDescendant(root, (n) => n.tagName === 'BUTTON' && n.textContent === text);
}

function makeEvent(type, opts) {
  return Object.assign({ type, bubbles: false }, opts);
}
function fireClick(node) {
  node.dispatchEvent(makeEvent('click', { target: node }));
}
function fireCheck(node, checked) {
  node.checked = checked;
  node.dispatchEvent(makeEvent('change', { target: node }));
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
// 3. 假 ctx／假設備資料
// ============================================================

// 對齊 Core.gs 的 EQUIP_ITEMS 與 Setup.gs 的 price.* 預設值（見 handover.js 檔頭行號）。
const EQUIP = [
  { item: '書桌', price: 2000 },
  { item: '椅子', price: 1000 }
];
const CLEANING_FEE = 3000;

/** 假簽名板：isEmpty 由 state.padEmpty 控制，destroy() 呼叫次數記在 state.padDestroyCalls。 */
function makeFakeCtx(overrides) {
  const state = {
    apiCalls: [],
    toasts: [],
    loadingCalls: [],
    apiHandlers: {},
    padEmpty: true,
    padDestroyCalls: 0,
    padClearCalls: 0,
    signaturePadCalls: 0
  };

  const ctx = {
    user: { id: 'u001', name: '王小明', role: 'manager', node: '' },
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
      confirm: async () => { throw new Error('不該呼叫 ctx.ui.confirm()：handover.js 沒有需要二次確認的動作'); },
      dialog: () => { throw new Error('不該呼叫 ctx.ui.dialog()：handover.js 用不到對話框'); },
      signaturePad: (canvasEl) => {
        state.signaturePadCalls++;
        assert.ok(canvasEl, 'ctx.ui.signaturePad() 必須傳入 canvas 元素');
        return {
          isEmpty: () => state.padEmpty,
          toDataURL: () => 'data:image/png;base64,FAKESIGNATURE',
          clear: () => { state.padClearCalls++; state.padEmpty = true; },
          destroy: () => { state.padDestroyCalls++; }
        };
      }
    },
    fmt: { esc, datetime, date, roc, money },
    nav: () => {},
    viewId: 'handover',
    params: {}
  };

  Object.assign(ctx, overrides);
  return { ctx, state };
}

function apiHandoverCreateOk(token) {
  return { ok: true, data: { handover_id: 'H-20260816-001', token, url: 'https://x/handover.html?t=' + token } };
}
function apiHandoverDataOk(overrides) {
  return Object.assign({
    ok: true,
    data: { state: 'pending', handover: {}, equip: EQUIP, cleaning_fee: CLEANING_FEE }
  }, overrides);
}

/** 逐項把 equip 清單點成「正常／已歸還」（validateHandoverSubmit 要求全部點過才能送出）。 */
function markAllItemsOk(root) {
  EQUIP.forEach((x) => {
    const li = byDataAttr(root, 'data-item', x.item);
    assert.ok(li, '應該找得到 ' + x.item + ' 這一列');
    fireClick(findAllDescendants(li, (n) => n.tagName === 'BUTTON' && n.textContent === '正常')[0]);
    fireClick(findAllDescendants(li, (n) => n.tagName === 'BUTTON' && n.textContent === '已歸還')[0]);
  });
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

const { mountHandover, calcCompensationPreview, validateHandoverSubmit } =
  await import('../modules/dorm/views/handover.js');

// ============================================================
// A. 純函式：賠償金額計算（對齊 Handover.gs calcCompensation() 75-90 行，見 handover.js 檔頭）
// ============================================================

const priceOf = (item) => (EQUIP.find((x) => x.item === item) || {}).price || 0;

t('calcCompensationPreview：異常＋未歸還 → 計價（書桌 2000）', () => {
  const total = calcCompensationPreview([{ item: '書桌', normal: false, returned: false }], false, priceOf, CLEANING_FEE);
  assert.equal(total, 2000);
});
t('calcCompensationPreview：異常但已歸還 → 不計價（已歸還一律視為 0，不是猜的，Handover.gs 81-84 行明講）', () => {
  const total = calcCompensationPreview([{ item: '書桌', normal: false, returned: true }], false, priceOf, CLEANING_FEE);
  assert.equal(total, 0);
});
t('calcCompensationPreview：正常且已歸還 → 不計價（對照組）', () => {
  const total = calcCompensationPreview([{ item: '書桌', normal: true, returned: true }], false, priceOf, CLEANING_FEE);
  assert.equal(total, 0);
});
t('calcCompensationPreview：兩項都異常未歸還 + 需清潔 → 加總含清潔費', () => {
  const total = calcCompensationPreview(
    [{ item: '書桌', normal: false, returned: false }, { item: '椅子', normal: false, returned: false }],
    true, priceOf, CLEANING_FEE
  );
  assert.equal(total, 2000 + 1000 + CLEANING_FEE);
});
t('calcCompensationPreview：空清單、不需清潔 → 0', () => {
  assert.equal(calcCompensationPreview([], false, priceOf, CLEANING_FEE), 0);
});

// ============================================================
// B. 純函式：validateHandoverSubmit——設備逐項須點過、簽名不可空白
// ============================================================

t('validateHandoverSubmit：設備都還沒點選、簽名也是空的 → 兩條錯誤都要有', () => {
  const errors = validateHandoverSubmit(
    [{ normal: undefined, returned: undefined }, { normal: undefined, returned: undefined }],
    { isEmpty: () => true }
  );
  assert.ok(errors.some((e) => e.startsWith('設備檢查：')), '應有設備檢查的錯誤：' + JSON.stringify(errors));
  assert.ok(errors.some((e) => e.startsWith('簽名：')), '應有簽名的錯誤：' + JSON.stringify(errors));
});

t('validateHandoverSubmit：設備都點完了、簽名是空的 → 只有簽名被擋（這是本任務指定要測的情境）', () => {
  const errors = validateHandoverSubmit(
    [{ normal: true, returned: true }, { normal: false, returned: false }],
    { isEmpty: () => true }
  );
  assert.deepEqual(errors, ['簽名：尚未簽名，請在下方簽名區簽名後再送出']);
});

t('validateHandoverSubmit：沒有簽名板物件（padCtl 是 null）→ 視同空簽名，一樣被擋，不拋例外', () => {
  const errors = validateHandoverSubmit([{ normal: true, returned: true }], null);
  assert.ok(errors.some((e) => e.startsWith('簽名：')));
});

t('validateHandoverSubmit：設備都點完了、簽名也有 → 沒有任何錯誤（對照組）', () => {
  const errors = validateHandoverSubmit(
    [{ normal: true, returned: true }, { normal: false, returned: false }],
    { isEmpty: () => false }
  );
  assert.deepEqual(errors, []);
});

// ============================================================
// C. DOM：無 dorm.write 權限 → 看不到表單、不呼叫任何後端
// ============================================================

await at('無 dorm.write 權限：只顯示提示，不打任何後端、不建簽名板', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ can: () => false, params: { contract_id: 'C-1' } });

  const unmount = mountHandover(root, ctx);
  await flush();

  assert.equal(state.apiCalls.length, 0, '沒有權限就不該呼叫任何後端');
  assert.equal(state.signaturePadCalls, 0, '沒有權限就不該建立簽名板');
  unmount();
  assert.equal(state.padDestroyCalls, 0, '沒建立過簽名板，unmount 不該假裝呼叫 destroy');
});

// ============================================================
// D. DOM：缺少合約編號／token → 顯示錯誤提示，不打後端
// ============================================================

await at('缺少 contract_id 與 token：顯示提示訊息，不呼叫後端', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ params: {} });

  const unmount = mountHandover(root, ctx);
  await flush();

  assert.equal(state.apiCalls.length, 0, '缺少參數就不該呼叫後端');
  const container = byId(root, 'dorm-handover-container');
  assert.ok(findDescendant(container, (n) => (n.textContent || '').includes('缺少合約編號')),
    '應該顯示缺少合約編號的提示');
  unmount();
});

// ============================================================
// E. DOM：完整流程——handoverCreate → handover → 逐項點選 → 簽名 → handoverSign
// ============================================================

await at('完整流程：全部點完＋簽名後送出 → 呼叫 handoverSign，payload 正確，完成畫面顯示賠償金額', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ params: { contract_id: 'C-20260801-001' } });
  const token = 'tok-abc-123';
  state.apiHandlers.handoverCreate = (payload) => {
    assert.equal(payload.contract_id, 'C-20260801-001');
    return apiHandoverCreateOk(token);
  };
  state.apiHandlers.handover = (payload) => {
    assert.equal(payload.token, token, 'handover action 要帶 handoverCreate 拿到的 token');
    return apiHandoverDataOk();
  };
  state.apiHandlers.handoverSign = (payload) => {
    assert.equal(payload.token, token);
    assert.equal(payload.items.length, EQUIP.length, '送出的設備項目數要對');
    // markAllItemsOk() 把每一項都點成「正常」＋「已歸還」——逐項確認狀態真的被正確記到
    // 對應的 item（不是 stale 的巧合：renderItemsList() 每次點擊都整個重畫 <ul>，
    // 這裡驗證即使 DOM 節點被整批換掉，事件關的閉包狀態仍然對得上正確的品項）。
    payload.items.forEach((it) => {
      assert.equal(it.normal, true, it.item + ' 應該是「正常」');
      assert.equal(it.returned, true, it.item + ' 應該是「已歸還」');
    });
    assert.equal(payload.sign_png, 'data:image/png;base64,FAKESIGNATURE');
    assert.equal(payload.need_cleaning, false);
    return { ok: true, data: { pdf_url: 'https://drive/x.pdf', compensation_total: 0, signed_at: '2026-08-16 10:00:00' } };
  };

  const unmount = mountHandover(root, ctx);
  await flush();

  assert.equal(state.signaturePadCalls, 1, '表單畫出來時應該建立一次簽名板');

  markAllItemsOk(root);
  state.padEmpty = false; // 模擬使用者已經簽名

  const submitBtn = byId(root, 'dorm-handover-submit');
  assert.ok(submitBtn, '應該有送出按鈕');
  fireClick(submitBtn);
  await flush();

  const signCalls = state.apiCalls.filter((c) => c.action === 'handoverSign');
  assert.equal(signCalls.length, 1, '應該呼叫一次 handoverSign');

  const container = byId(root, 'dorm-handover-container');
  assert.ok(findDescendant(container, (n) => (n.textContent || '').includes('點交完成')), '應該顯示點交完成畫面');

  unmount();
  assert.equal(state.padDestroyCalls, 1, 'unmount 時必須呼叫 signaturePad 的 destroy()（本任務指定驗收項）');
});

// ============================================================
// F. DOM：簽名為空時被擋——設備都點完了但沒簽名，送出要被擋、不打後端
// ============================================================

await at('簽名為空時被擋：設備都點完但沒簽名 → 顯示錯誤、不呼叫 handoverSign', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ params: { contract_id: 'C-20260801-002' } });
  const token = 'tok-def-456';
  state.apiHandlers.handoverCreate = () => apiHandoverCreateOk(token);
  state.apiHandlers.handover = () => apiHandoverDataOk();
  state.apiHandlers.handoverSign = () => {
    throw new Error('不該呼叫到 handoverSign：簽名是空的，應該在前端就被擋下');
  };

  const unmount = mountHandover(root, ctx);
  await flush();

  markAllItemsOk(root);
  // state.padEmpty 維持預設 true（沒簽名）

  fireClick(byId(root, 'dorm-handover-submit'));
  await flush();

  const errEl = byId(root, 'dorm-handover-error');
  assert.equal(errEl.hidden, false, '應該顯示錯誤');
  assert.ok(errEl.textContent.includes('簽名：'), '錯誤訊息要講清楚是簽名沒填：' + errEl.textContent);

  const signCalls = state.apiCalls.filter((c) => c.action === 'handoverSign');
  assert.equal(signCalls.length, 0, '簽名是空的，不該打到後端');

  unmount();
  assert.equal(state.padDestroyCalls, 1, '即使送出被擋，unmount 時還是要 destroy 簽名板');
});

// ============================================================
// G. DOM：unmount 呼叫 signaturePad.destroy()（獨立驗證段落，對應本任務指定驗收項）
// ============================================================

await at('unmount 呼叫 signaturePad.destroy()：只呼叫一次，且發生在表單建立之後', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx({ params: { contract_id: 'C-3' } });
  state.apiHandlers.handoverCreate = () => apiHandoverCreateOk('tok-ghi');
  state.apiHandlers.handover = () => apiHandoverDataOk();

  const unmount = mountHandover(root, ctx);
  await flush();
  assert.equal(state.signaturePadCalls, 1, '簽名板應該只建立一次');
  assert.equal(state.padDestroyCalls, 0, 'unmount 之前不該呼叫 destroy');

  unmount();
  assert.equal(state.padDestroyCalls, 1, 'unmount 之後必須呼叫一次 destroy');
});

// ============================================================
// H. 真實網路守衛總量斷言
// ============================================================
assert.equal(realNetworkCalls.length, 0, '全程真實網路呼叫次數為 0（未被 mock 的 fetch 從未被呼叫）');

// ============================================================
if (failed > 0) {
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  for (const f of failures) {
    console.error('FAIL: ' + f.name);
    console.error('  ' + (f.err && f.err.stack ? f.err.stack : f.err));
  }
  process.exit(1);
} else {
  console.log('全部測試通過，共 ' + passed + ' 項');
}
