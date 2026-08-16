// test/dorm-create.test.mjs —— T3-3 驗收：modules/dorm/views/create.js（建合約單、產生簽約連結）
// 跑法：node test/dorm-create.test.mjs
//
// 沒有 jsdom，DOM stub 照抄 test/audit-stock-fill.test.mjs／test/dorm-list.test.mjs 的做法
// （FakeElement／FakeDocument，事件走手刻的 addEventListener/dispatchEvent，不需要冒泡）。
// ctx.fmt 用 platform/fmt.js 的真正實作（純函式、沒有瀏覽器依賴）。ctx.ui／ctx.api／ctx.nav
// 全部造假、只記錄呼叫；全程不打真實網路、不依賴後端（宿舍合約是同仁實際簽過的租約，
// 任務指示明講測試一律用假資料、不准打真實網路）。
//
// A. 真實網路守衛：把 globalThis.fetch 換成「呼叫了就記一筆、並丟錯」的哨兵函式。
// create.js 一律走 ctx.api.call（不 import platform/api.js、不自己 fetch），這支守衛全程
//不該被觸發；留著是雙重保險。檔案最後對 realNetworkCalls.length 做總量斷言。

'use strict';

const realNetworkCalls = [];
globalThis.fetch = async (url) => {
  realNetworkCalls.push(String(url));
  throw new Error('GUARD: 這次呼叫沒有被 mock，攔截下來避免真的打網路。url=' + url);
};

import assert from 'node:assert/strict';
import { esc, datetime, date, roc, money } from '../platform/fmt.js';

// ============================================================
// 0／1. 最小 DOM stub（做法照抄 test/audit-stock-fill.test.mjs）
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
// create.js 的複製連結按鈕用 navigator.clipboard；測試環境沒有真的剪貼簿，
// 故意不補這個全域，讓程式碼走它自己的 try/catch 分支（見下方「複製連結」測試）。

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
function byId(root, id) {
  return findDescendant(root, (n) => n.getAttribute && n.getAttribute('id') === id);
}

function makeEvent(type, opts) {
  return Object.assign({ type, bubbles: false }, opts);
}
function fireClick(node) {
  node.dispatchEvent(makeEvent('click', { target: node }));
}
function fireChange(node, value) {
  node.value = value;
  node.dispatchEvent(makeEvent('change', { target: node }));
}

/** 等待 microtask/setImmediate 佇列跑過幾輪，讓 async 呼叫鏈落地（做法同 audit-stock-fill）。 */
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
// 3. 假 ctx／假房間資料
// ============================================================

// 對齊 Core.gs 的 ROOMS（見 modules/dorm/views/create.js 檔頭行號）：兩間單人房、
// 一間有床位的四人房、一間有床位的雙人房，涵蓋「整間出租」與「多人房」兩種規則。
const SOLO_ROOM = { room: '二樓單人房', beds: [], type: '單人房' };
const QUAD_ROOM = { room: '二樓四人房', beds: ['1號床位', '2號床位', '3號床位', '4號床位'], type: '四人房' };
const TWIN_ROOM = { room: '三樓1號房', beds: ['雙人床位A', '雙人床位B'], type: '雙人房' };
const ALL_ROOMS = [SOLO_ROOM, QUAD_ROOM, TWIN_ROOM];

function makeFakeCtx(overrides) {
  const state = {
    apiCalls: [],
    toasts: [],
    loadingCalls: [],
    confirmCalls: [], // 每次呼叫 ctx.ui.confirm(message) 記一筆 message，供斷言「訊息是後端給的那句」
    nextConfirm: true, // 下一次（也是每一次，這裡沒有需要連問兩次的情境）confirm 的回答
    apiHandlers: {}
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
      confirm: async (message) => {
        state.confirmCalls.push(message);
        return typeof state.nextConfirm === 'function' ? state.nextConfirm() : state.nextConfirm;
      },
      dialog: () => { throw new Error('不該呼叫 ctx.ui.dialog()：create.js 用不到對話框'); },
      signaturePad: () => { throw new Error('不該呼叫 ctx.ui.signaturePad()：建單畫面用不到簽名板'); }
    },
    fmt: { esc, datetime, date, roc, money },
    nav: () => {},
    viewId: 'create',
    params: {}
  };

  Object.assign(ctx, overrides);
  return { ctx, state };
}

function apiRoomsOk(rooms) {
  return { ok: true, data: { rooms, equip: [] } };
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

const { mountCreate, computeRent, computeTermEndPreview, validateCreate } =
  await import('../modules/dorm/views/create.js');

// ============================================================
// A. 純函式：租金計算（對齊 Setup.gs DEFAULT_SETTINGS，見 create.js 檔頭行號）
// ============================================================

t('computeRent：單人房・自住 → 3500（rate.單人房）', () => {
  assert.equal(computeRent(SOLO_ROOM, '自住'), 3500);
});
t('computeRent：單人房・合租 → 1750（rate.單人房合租，不是自住費率的一半用猜的）', () => {
  assert.equal(computeRent(SOLO_ROOM, '合租'), 1750);
});
t('computeRent：雙人房 → 2000（rate.雙人房）', () => {
  assert.equal(computeRent(TWIN_ROOM, ''), 2000);
});
t('computeRent：四人房 → 1500（rate.四人房）', () => {
  assert.equal(computeRent(QUAD_ROOM, ''), 1500);
});
t('computeRent：沒有房間定義 → null（不是拋例外、不是 0）', () => {
  assert.equal(computeRent(null, '自住'), null);
});

t('computeTermEndPreview：2026-08-01 起六個月 → 2027-01-31（與 Api.gs testPhase1() 的既有斷言同一組例子）', () => {
  assert.equal(computeTermEndPreview('2026-08-01'), '2027-01-31');
});
t('computeTermEndPreview：空字串 → 空字串（不拋例外、不顯示 Invalid Date）', () => {
  assert.equal(computeTermEndPreview(''), '');
});

// ============================================================
// B. 純函式：validateCreate——對齊 Api.gs createContract() 111-123 行的規則
//    （這裡直接測純函式，理由見 create.js 檔頭：bedField 在畫面上只在多人房才會顯示，
//    UI 結構本身已經防止「整間出租卻選了床位」這個操作，這條規則能被觸發的路徑
//    只剩「直接呼叫這個純函式」，所以驗證放在這一層最準確、也最貼近變異測試要打的目標）
// ============================================================

t('validateCreate：必填缺漏（姓名／房間／起日全空）→ 三條錯誤，各自標明是哪一欄', () => {
  const errors = validateCreate({ name: '', room: '', bed: '', term_start: '' }, null);
  assert.ok(errors.some((e) => e.startsWith('姓名：')), '應有姓名欄的錯誤：' + JSON.stringify(errors));
  assert.ok(errors.some((e) => e.startsWith('房間：')), '應有房間欄的錯誤：' + JSON.stringify(errors));
  assert.ok(errors.some((e) => e.startsWith('租期起日：')), '應有租期起日欄的錯誤：' + JSON.stringify(errors));
});

t('validateCreate：整間出租（單人房，beds=[]）卻帶了床位 → 被擋，訊息講清楚是床位欄且是「整間出租」', () => {
  const errors = validateCreate(
    { name: '測試一', room: SOLO_ROOM.room, bed: '不該有的床位', term_start: '2026-08-01' },
    SOLO_ROOM
  );
  assert.ok(errors.some((e) => e.startsWith('床位：') && e.includes('整間出租')),
    '應該擋下並說明「整間出租不應指定床位」：' + JSON.stringify(errors));
});

t('validateCreate：整間出租、沒有帶床位 → 合法，不該有床位相關錯誤（對照組）', () => {
  const errors = validateCreate(
    { name: '測試一', room: SOLO_ROOM.room, bed: '', term_start: '2026-08-01' },
    SOLO_ROOM
  );
  assert.ok(!errors.some((e) => e.startsWith('床位：')), '不該有床位錯誤：' + JSON.stringify(errors));
});

t('validateCreate：多人房（四人房）沒指定床位 → 被擋，訊息講清楚是床位欄且是「必須指定床位」', () => {
  const errors = validateCreate(
    { name: '測試二', room: QUAD_ROOM.room, bed: '', term_start: '2026-08-01' },
    QUAD_ROOM
  );
  assert.ok(errors.some((e) => e.startsWith('床位：') && e.includes('必須指定床位')),
    '應該擋下並說明「必須指定床位」：' + JSON.stringify(errors));
});

t('validateCreate：多人房、有指定床位 → 合法，不該有床位相關錯誤（對照組）', () => {
  const errors = validateCreate(
    { name: '測試二', room: QUAD_ROOM.room, bed: '1號床位', term_start: '2026-08-01' },
    QUAD_ROOM
  );
  assert.ok(!errors.some((e) => e.startsWith('床位：')), '不該有床位錯誤：' + JSON.stringify(errors));
});

t('validateCreate：所有欄位都合法 → 沒有任何錯誤', () => {
  const errors = validateCreate(
    { name: '測試三', room: SOLO_ROOM.room, bed: '', term_start: '2026-08-01' },
    SOLO_ROOM
  );
  assert.deepEqual(errors, []);
});

// ============================================================
// C. DOM：無 dorm.write 權限 → 看不到送出控制項（連表單都不畫）
// ============================================================

await at('無 dorm.write 權限：不畫表單，看不到送出按鈕', async () => {
  const root = new FakeElement('div');
  const { ctx } = makeFakeCtx({ can: () => false });

  const unmount = mountCreate(root, ctx);
  await flush();

  assert.equal(byId(root, 'dorm-create-submit'), null, '不該有送出按鈕');
  assert.equal(byId(root, 'dorm-create-name'), null, '不該畫出表單欄位');
  unmount();
});

// ============================================================
// D. DOM：必填缺漏被擋（不呼叫後端）
// ============================================================

await at('必填缺漏：什麼都不填直接送出 → 顯示錯誤、不呼叫後端 create', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.rooms = () => apiRoomsOk(ALL_ROOMS);

  const unmount = mountCreate(root, ctx);
  await flush();

  const submitBtn = byId(root, 'dorm-create-submit');
  assert.ok(submitBtn, '應該有送出按鈕（有權限）');
  fireClick(submitBtn);
  await flush();

  const errEl = byId(root, 'dorm-create-error');
  assert.equal(errEl.hidden, false, '錯誤區塊應該顯示');
  assert.ok(errEl.textContent.includes('姓名：'), '錯誤訊息要講清楚是姓名欄：' + errEl.textContent);
  assert.ok(errEl.textContent.includes('租期起日：'), '錯誤訊息要講清楚是租期起日欄：' + errEl.textContent);

  const createCalls = state.apiCalls.filter((c) => c.action === 'create');
  assert.equal(createCalls.length, 0, '驗證沒過，不該呼叫後端 create');

  unmount();
});

// ============================================================
// E. DOM：成功建立後顯示簽約連結（後端回傳的 sign_url 原樣顯示，不是前端自己拼）
// ============================================================

await at('建立成功：顯示簽約連結（複製連結不打真網路，走 try/catch 分支不炸掉）', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.rooms = () => apiRoomsOk(ALL_ROOMS);
  const fakeSignUrl = 'https://eason0728.github.io/dzy/sign.html?t=abc123token';
  state.apiHandlers.create = (payload) => {
    assert.equal(payload.room, SOLO_ROOM.room, '送出的房間欄位要對');
    assert.equal(payload.term_start, '2026-08-01', '送出的起日欄位要對');
    return {
      ok: true,
      data: {
        contract_id: 'C-20260816-001', token: 'abc123token', rent: 3500,
        term_start: '2026-08-01', term_end: '2027-01-31', sign_url: fakeSignUrl
      }
    };
  };

  const unmount = mountCreate(root, ctx);
  await flush();

  fireChange(byId(root, 'dorm-create-name'), '王小明');
  fireChange(byId(root, 'dorm-create-room'), SOLO_ROOM.room); // 觸發床位／住宿方式連動
  await flush();
  fireChange(byId(root, 'dorm-create-start'), '2026-08-01');

  fireClick(byId(root, 'dorm-create-submit'));
  await flush();

  const resultCard = byId(root, 'dorm-create-result');
  assert.equal(resultCard.hidden, false, '成功後結果卡片要顯示');
  const linkEl = byId(root, 'dorm-create-link');
  assert.equal(linkEl.textContent, fakeSignUrl, '簽約連結要用後端回傳的 sign_url，不是前端自己拼網址');

  const copyBtn = byId(root, 'dorm-create-copy');
  assert.ok(copyBtn, '應該有「複製連結」按鈕');
  fireClick(copyBtn); // 測試環境沒有 navigator.clipboard，斷言只求不拋例外把測試炸掉
  await flush();

  unmount();
});

// ============================================================
// F. DOM：床位衝突（軟性警告）→ ctx.ui.confirm 問一次，確認才帶 force:true 重送一次
//    （2026-08-16 平台層 transformResponse_() 補洞後接回舊版流程，見 create.js 檔頭）
// ============================================================

/** 填一份合法的單人房表單（不需要選床位），供 F 段共用。 */
async function fillValidSoloForm(root) {
  fireChange(byId(root, 'dorm-create-name'), '王小明');
  fireChange(byId(root, 'dorm-create-room'), SOLO_ROOM.room);
  await flush();
  fireChange(byId(root, 'dorm-create-start'), '2026-08-01');
}

const CONFLICT_MSG = '二樓四人房1號床已有人，確定要建立嗎？';
function apiConflictRes() {
  // 平台層轉接後的形狀（見 create.js 檔頭「2026-08-16 平台層補洞」說明）：
  // error 是後端的 message，data.warn 標記這是床位重複的軟性警告。
  return { ok: false, error: CONFLICT_MSG, data: { warn: '床位重複' } };
}

await at('床位衝突：跳出確認、訊息是後端給的那句（不是「請求失敗」之類的通用字）', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.rooms = () => apiRoomsOk(ALL_ROOMS);
  state.apiHandlers.create = () => apiConflictRes();
  state.nextConfirm = false; // 這個案例只驗證有沒有跳確認、訊息對不對，取消掉避免又打一次後端

  const unmount = mountCreate(root, ctx);
  await flush();
  await fillValidSoloForm(root);

  fireClick(byId(root, 'dorm-create-submit'));
  await flush();

  assert.equal(state.confirmCalls.length, 1, '應該跳出一次確認');
  assert.equal(state.confirmCalls[0], CONFLICT_MSG, '確認訊息要用後端給的那句，不是通用字：' + state.confirmCalls[0]);
  unmount();
});

await at('床位衝突・使用者確認：第二次呼叫帶 force:true，且只重送一次', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.rooms = () => apiRoomsOk(ALL_ROOMS);
  let createCallCount = 0;
  state.apiHandlers.create = (payload) => {
    createCallCount++;
    if (createCallCount === 1) {
      assert.equal(payload.force, undefined, '第一次呼叫不該帶 force');
      return apiConflictRes();
    }
    assert.equal(createCallCount, 2, '確認後只該重送一次，不是重複重送');
    assert.equal(payload.force, true, '第二次呼叫要帶 force:true（Api.gs 126 行 p.force）');
    return {
      ok: true,
      data: { contract_id: 'C-20260816-002', rent: 3500, term_start: '2026-08-01', term_end: '2027-01-31', sign_url: 'https://x/sign.html?t=forced' }
    };
  };
  state.nextConfirm = true;

  const unmount = mountCreate(root, ctx);
  await flush();
  await fillValidSoloForm(root);

  fireClick(byId(root, 'dorm-create-submit'));
  await flush();

  assert.equal(createCallCount, 2, '應該恰好呼叫後端 create 兩次（原始一次＋force 重送一次）');
  const resultCard = byId(root, 'dorm-create-result');
  assert.equal(resultCard.hidden, false, '確認後強制建立成功，應該顯示結果卡片');
  unmount();
});

await at('床位衝突・使用者取消：完全不再呼叫後端，也不顯示錯誤訊息', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.rooms = () => apiRoomsOk(ALL_ROOMS);
  state.apiHandlers.create = () => apiConflictRes();
  state.nextConfirm = false;

  const unmount = mountCreate(root, ctx);
  await flush();
  await fillValidSoloForm(root);

  fireClick(byId(root, 'dorm-create-submit'));
  await flush();

  const createCalls = state.apiCalls.filter((c) => c.action === 'create');
  assert.equal(createCalls.length, 1, '取消後不該再打第二次後端');
  const errEl = byId(root, 'dorm-create-error');
  assert.equal(errEl.hidden, true, '取消時不該顯示錯誤訊息（什麼都不做）');
  unmount();
});

await at('一般 ok:false（例如通行碼錯誤）：不會跳出「要不要強制建立」的確認，直接顯示錯誤', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.rooms = () => apiRoomsOk(ALL_ROOMS);
  state.apiHandlers.create = () => ({ ok: false, error: '通行碼錯誤' }); // 沒有 data.warn

  const unmount = mountCreate(root, ctx);
  await flush();
  await fillValidSoloForm(root);

  fireClick(byId(root, 'dorm-create-submit'));
  await flush();

  assert.equal(state.confirmCalls.length, 0, '一般錯誤不該跳確認框');
  const errEl = byId(root, 'dorm-create-error');
  assert.equal(errEl.hidden, false, '應該直接顯示錯誤');
  assert.ok(errEl.textContent.includes('通行碼錯誤'), '錯誤訊息要是後端給的那句：' + errEl.textContent);
  unmount();
});

// ============================================================
// B. 真實網路守衛總量斷言
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
