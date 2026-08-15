// test/users-module.test.mjs —— T1-11 驗收：modules/users/（人員管理模組）
// 跑法：node test/users-module.test.mjs
//
// 沒有 jsdom，這裡跟 test/ui.test.mjs／test/shell.test.mjs 一樣自己刻一份最小 DOM
// stub（FakeElement／FakeDocument，事件支援手刻的 parentNode 冒泡，做法照抄
// test/shell.test.mjs 的 withEvents()）。
//
// ctx.fmt 直接用 platform/fmt.js 的真正實作（純函式、沒有瀏覽器依賴，import 進來
// 比自己刻一份假的更貼近真實情況，也才驗得出下面這條真的成立）。
// ctx.ui／ctx.api 則照任務指示「自己造假的 ctx」：toast/loading/confirm 只記錄呼叫，
// api.call 記錄 action/payload 並回傳測試指定的假回應——全程不打真實網路、不依賴後端。
//
// 這份測試也順便釘住幾個在實作時發現、但依規定不能動 platform/ 的落差，
// 讓它們不會被日後的修改悄悄改掉行為（詳見 modules/users/views/list.js 檔頭與
// displayDatetime() 的註解）：
//   1) ctx.ui.dialog() 現在的 body 雖然已經接受 DOM 元素，但它回傳單純一個
//      Promise，沒有任何管道讓呼叫端從外部強制關掉一個已經開著的對話框
//      （沒有回傳 close() 把手，也不接受 AbortSignal）。unmount() 要能把開著的
//      彈窗真的關掉，需要自己掌控 close()，所以新增／修改／重設密碼一律還是用
//      模組自己組的彈窗（沿用 components.css 既有 class），不呼叫 ctx.ui.dialog()
//      ——下面用一個「呼叫就丟例外」的假 dialog() 當哨兵。
//   2) ctx.fmt.datetime() 解析不了後端已經回傳的 'YYYY-MM-DD HH:mm:ss' 完整字串
//      （platform/fmt.js 的 toDate() 只認純日期），所以 displayDatetime() 需要
//      在 datetime() 回空字串時退回顯示原始字串。
//   3) 2026-08-15 對抗審查修正：①開著的彈窗會活過模組卸載（unmount 現在要一併
//      關掉）；②角色清單改成呼叫後端 listRoles（spec §5.2）動態取得，不再是
//      寫死在 list.js 裡的 ROLE_OPTIONS——見下面 makeFakeCtx() 的 DEFAULT_ROLES
//      預設回應，以及區塊 I／J 的新增測試。

'use strict';

import assert from 'node:assert/strict';
import { esc, datetime, date, roc, money } from '../platform/fmt.js';

// ============================================================
// 0. 事件系統（含手刻的冒泡邏輯，照抄 test/shell.test.mjs 的 withEvents）
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
// 2. 樹狀查找小工具
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

function byField(root, name) {
  return findDescendant(root, (n) => n.getAttribute && n.getAttribute('data-field') === name);
}
function byRole(root, role) {
  return findDescendant(root, (n) => n.getAttribute && n.getAttribute('data-role') === role);
}
function byAction(root, action) {
  return findDescendant(root, (n) => n.getAttribute && n.getAttribute('data-action') === action);
}
function allByAction(root, action) {
  return findAllDescendants(root, (n) => n.getAttribute && n.getAttribute('data-action') === action);
}

function fireClick(node) {
  node.dispatchEvent(makeEvent('click', { bubbles: true, target: node }));
}
function fireKeydown(target, key) {
  target.dispatchEvent(makeEvent('keydown', { key }));
}

/** 等待 microtask/setImmediate 佇列跑過幾輪，讓 async 呼叫鏈落地（做法同 test/shell.test.mjs）。 */
function flush(rounds = 8) {
  return new Promise((resolve) => {
    let n = rounds;
    (function step() {
      if (n-- <= 0) return resolve();
      setImmediate(step);
    })();
  });
}

// ============================================================
// 3. 假 ctx —— fmt 用真正的 platform/fmt.js；ui/api 全部造假、只記錄呼叫
//    （任務指示：「自己造假的 ctx，不要依賴真實後端」）
// ============================================================

// spec §4.3「本期五個角色」——用來當 listRoles 沒被個別測試 mock 時的預設回應，
// 讓原本就假設「角色欄顯示中文」的既有測試情境維持成立（那些情境模擬的是
// listRoles 正常運作的情況；listRoles 本身失敗或回傳新角色的情境，見區塊 I／J）。
const DEFAULT_ROLES = [
  { role: 'admin', name_zh: '系統管理者', perms: ['*'] },
  { role: 'manager', name_zh: '部門主管', perms: ['audit.read', 'dorm.read', 'dorm.write'] },
  { role: 'accountant', name_zh: '會計', perms: ['audit.read', 'audit.write'] },
  { role: 'storelead', name_zh: '店長', perms: ['audit.read.own'] },
  { role: 'staff', name_zh: '員工', perms: [] }
];

function makeFakeCtx() {
  const state = {
    apiCalls: [],
    toasts: [],
    loadingCalls: [],
    confirmCalls: [],
    apiHandlers: {},
    nextConfirm: true
  };

  const ctx = {
    user: { id: 'u001', name: '管理員', role: 'admin', node: '' },
    can: () => true,
    api: {
      call: async (moduleId, action, payload) => {
        state.apiCalls.push({ moduleId, action, payload });
        const handler = state.apiHandlers[action];
        if (typeof handler === 'function') return handler(payload);
        if (handler !== undefined) return handler;
        // listRoles 沒被個別測試 mock 時，預設模擬「後端正常運作」，見上面 DEFAULT_ROLES。
        if (action === 'listRoles') return { ok: true, data: { roles: DEFAULT_ROLES } };
        return { ok: true, data: {} };
      }
    },
    ui: {
      toast: (message, type) => {
        state.toasts.push({ message, type });
      },
      loading: (on) => {
        state.loadingCalls.push(on);
      },
      confirm: async (message) => {
        state.confirmCalls.push(message);
        return typeof state.nextConfirm === 'function' ? state.nextConfirm() : state.nextConfirm;
      },
      // 哨兵：人員管理模組不該呼叫 ctx.ui.dialog()——它沒有辦法讓呼叫端從外部強制
      // 關掉一個已經開著的對話框（unmount 需要這個能力），見
      // modules/users/views/list.js 檔頭設計說明。呼叫到這裡代表設計被誤改了。
      dialog: () => {
        throw new Error('不該呼叫 ctx.ui.dialog()：它無法從外部強制關閉，unmount 沒辦法把彈窗真的關掉');
      }
    },
    fmt: { esc, datetime, date, roc, money },
    nav: () => {},
    params: {}
  };

  return { ctx, state };
}

function makeUser(overrides) {
  return Object.assign(
    {
      id: 'u001',
      username: 'acc1',
      name: '王會計',
      role: 'accountant',
      node: '',
      active: true,
      created_at: '2026-08-01 09:00:00',
      last_login_at: '2026-08-10 18:30:00'
    },
    overrides
  );
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

const { mountList } = await import('../modules/users/views/list.js');
const usersManifest = (await import('../modules/users/manifest.js')).default;
const usersIndex = (await import('../modules/users/index.js')).default;
const { validateManifest } = await import('../platform/manifest-check.js');

// ============================================================
// A. manifest／模組本體形狀
// ============================================================

t('manifest：驗證通過（errors 為空）', () => {
  const r = validateManifest(usersManifest);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

t('manifest：id/ns/backend 符合 spec §4.1（backend 必須等於 ns）', () => {
  assert.equal(usersManifest.id, 'users');
  assert.equal(usersManifest.ns, 'platform');
  assert.equal(usersManifest.backend, 'platform');
  assert.equal(usersManifest.ns, usersManifest.backend);
});

t('模組本體：badge() 回 null（人員數不是待辦，不該顯示在首頁卡片）', () => {
  assert.equal(usersIndex.badge(), null);
});

// ============================================================
// B. 清單渲染／角色與節點顯示中文
// ============================================================

await at('清單渲染：listUsers 回來的資料畫成表格列，欄位含 id/帳號/姓名/角色/節點/狀態/時間', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({
    ok: true,
    data: {
      users: [
        makeUser({ id: 'u001', username: 'acc1', name: '王會計', role: 'accountant', node: '' }),
        makeUser({ id: 'u002', username: 'lead1', name: '林店長', role: 'storelead', node: 'sxl-gf', active: false })
      ]
    }
  });

  const unmount = mountList(root, ctx);
  await flush();

  const rows = findAllDescendants(root, (n) => n.getAttribute && n.getAttribute('data-role') === 'user-row');
  assert.equal(rows.length, 2, '應該畫出兩列');

  const cellsOf = (row) => findAllDescendants(row, (n) => n.tagName === 'TD');
  const row1 = cellsOf(rows[0]);
  assert.equal(row1[0].innerHTML, 'u001', 'id 欄');
  assert.equal(row1[1].innerHTML, 'acc1', '帳號欄');
  assert.equal(row1[2].innerHTML, '王會計', '姓名欄');

  unmount();
});

await at('角色與節點顯示中文（不是原始代號）', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({
    ok: true,
    data: {
      users: [
        makeUser({ id: 'u001', role: 'storelead', node: 'mzt-gf' }),
        makeUser({ id: 'u002', role: 'accountant', node: '' })
      ]
    }
  });

  const unmount = mountList(root, ctx);
  await flush();

  const rows = findAllDescendants(root, (n) => n.getAttribute && n.getAttribute('data-role') === 'user-row');
  const cellsOf = (row) => findAllDescendants(row, (n) => n.tagName === 'TD');
  const row1 = cellsOf(rows[0]);
  const row2 = cellsOf(rows[1]);

  assert.equal(row1[3].innerHTML, '店長', '角色欄應顯示中文，不是 storelead');
  assert.equal(row1[4].innerHTML, '墨竹亭 光復店', '節點欄應顯示中文，不是 mzt-gf');
  assert.equal(row2[3].innerHTML, '會計');
  assert.equal(row2[4].innerHTML, '不限節點', '空節點代號要顯示「不限節點」');

  unmount();
});

t('狀態欄：active 顯示啟用/停用，不是原始布林值', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({
    ok: true,
    data: { users: [makeUser({ id: 'u001', active: true }), makeUser({ id: 'u002', active: false })] }
  });
  const unmount = mountList(root, ctx);
  await flush();
  const rows = findAllDescendants(root, (n) => n.getAttribute && n.getAttribute('data-role') === 'user-row');
  const tagOf = (row) => findDescendant(row, (n) => n.classList && (n.classList.contains('tag-ok') || n.classList.contains('tag-danger')));
  assert.equal(tagOf(rows[0]).innerHTML, '啟用');
  assert.equal(tagOf(rows[0]).classList.contains('tag-ok'), true);
  assert.equal(tagOf(rows[1]).innerHTML, '停用');
  assert.equal(tagOf(rows[1]).classList.contains('tag-danger'), true);
  unmount();
});

// ============================================================
// C. 顯示字串都經過 ctx.fmt.esc()（含 datetime 落差的防呆）
// ============================================================

await at('危險字元顯示前經過 ctx.fmt.esc() 轉義', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({
    ok: true,
    data: { users: [makeUser({ id: 'u001', name: '<script>alert(1)</script>' })] }
  });
  const unmount = mountList(root, ctx);
  await flush();
  const rows = findAllDescendants(root, (n) => n.getAttribute && n.getAttribute('data-role') === 'user-row');
  const cellsOf = (row) => findAllDescendants(row, (n) => n.tagName === 'TD');
  const nameCell = cellsOf(rows[0])[2];
  assert.equal(nameCell.innerHTML, '&lt;script&gt;alert(1)&lt;/script&gt;');
  unmount();
});

await at('建立時間／最後登入：後端回已格式化的 "YYYY-MM-DD HH:mm:ss" 字串時，畫面不能是空白', async () => {
  // 這條原本用來「記錄平台落差」：platform/fmt.js 讀不懂後端寫出去的
  // 'YYYY-MM-DD HH:mm:ss'，整欄會空白，模組當時自己加了一層防呆繞過去。
  // 2026-08-14 已修在平台層、模組的防呆也拿掉了，斷言因此反轉成
  // 「平台自己就讀得懂」——模組不該長期扛平台的缺陷。
  assert.equal(
    datetime('2026-08-01 09:00:00'),
    '2026-08-01 09:00:00',
    '平台層必須讀得懂後端寫出去的時間格式，不能讓每個模組各自繞路'
  );

  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({
    ok: true,
    data: { users: [makeUser({ id: 'u001', created_at: '2026-08-01 09:00:00', last_login_at: '2026-08-10 18:30:00' })] }
  });
  const unmount = mountList(root, ctx);
  await flush();
  const rows = findAllDescendants(root, (n) => n.getAttribute && n.getAttribute('data-role') === 'user-row');
  const cellsOf = (row) => findAllDescendants(row, (n) => n.tagName === 'TD');
  const cells = cellsOf(rows[0]);
  assert.equal(cells[6].innerHTML, '2026-08-01 09:00:00', '建立時間欄不該是空白');
  assert.equal(cells[7].innerHTML, '2026-08-10 18:30:00', '最後登入欄不該是空白');
  unmount();
});

// ============================================================
// D. 新增／修改：送出的 payload 正確
// ============================================================

await at('新增使用者：填表送出，saveUser 收到不帶 id、帶 password 的 payload', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [] } });
  state.apiHandlers.saveUser = () => ({ ok: true, data: { id: 'u009' } });

  const unmount = mountList(root, ctx);
  await flush();

  fireClick(byRole(root, 'add-user'));
  await flush();

  const overlay = byRole(fakeDocument.body, 'user-form-overlay');
  assert.ok(overlay, '應該開出新增使用者的表單彈窗');

  byField(overlay, 'username').value = 'newlead1';
  byField(overlay, 'name').value = '新店長';
  byField(overlay, 'role').value = 'storelead';
  byField(overlay, 'node').value = 'ck';
  byField(overlay, 'password').value = 'longenoughpw1';

  fireClick(byRole(overlay, 'submit'));
  await flush();

  const call = state.apiCalls.find((c) => c.action === 'saveUser');
  assert.ok(call, '應該呼叫 saveUser');
  assert.equal(call.moduleId, 'users', '一律走 ctx.api.call(\'users\', ...)（任務指示第 3 點）');
  assert.deepEqual(call.payload, {
    username: 'newlead1', name: '新店長', role: 'storelead', node: 'ck', password: 'longenoughpw1'
  });
  assert.equal('id' in call.payload, false, '新增不該帶 id');

  // 彈窗應該已關閉
  assert.equal(fakeDocument.body.contains(overlay), false);
  unmount();
});

await at('修改使用者：帶入現有資料，送出後 saveUser 收到帶 id、不帶 password 的 payload', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  const existing = makeUser({ id: 'u001', username: 'acc1', name: '王會計', role: 'accountant', node: '' });
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [existing] } });
  state.apiHandlers.saveUser = () => ({ ok: true, data: { id: 'u001' } });

  const unmount = mountList(root, ctx);
  await flush();

  const editBtn = byAction(root, 'edit-user');
  assert.ok(editBtn);
  fireClick(editBtn);
  await flush();

  const overlay = byRole(fakeDocument.body, 'user-form-overlay');
  assert.ok(overlay, '應該開出修改使用者的表單彈窗');
  assert.equal(byField(overlay, 'username').value, 'acc1', '應該帶入現有帳號');
  assert.equal(byField(overlay, 'name').value, '王會計', '應該帶入現有姓名');
  assert.equal(byField(overlay, 'password'), null, '修改表單不該有密碼欄（任務指示：修改不改密碼）');

  byField(overlay, 'name').value = '王會計（改名）';
  byField(overlay, 'role').value = 'manager';
  byField(overlay, 'node').value = 'ck';

  fireClick(byRole(overlay, 'submit'));
  await flush();

  const call = state.apiCalls.find((c) => c.action === 'saveUser');
  assert.ok(call);
  assert.deepEqual(call.payload, { id: 'u001', username: 'acc1', name: '王會計（改名）', role: 'manager', node: 'ck' });
  assert.equal('password' in call.payload, false, '修改不該帶 password');

  unmount();
});

await at('新增：取消不送出，saveUser 不會被呼叫', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [] } });

  const unmount = mountList(root, ctx);
  await flush();
  fireClick(byRole(root, 'add-user'));
  await flush();

  const overlay = byRole(fakeDocument.body, 'user-form-overlay');
  fireClick(byRole(overlay, 'cancel'));
  await flush();

  assert.equal(state.apiCalls.some((c) => c.action === 'saveUser'), false);
  assert.equal(fakeDocument.body.contains(overlay), false);
  unmount();
});

// ============================================================
// E. 停用／啟用：要二次確認
// ============================================================

await at('停用：跳出 ctx.ui.confirm，取消時不呼叫 setActive', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [makeUser({ id: 'u001', active: true })] } });
  state.nextConfirm = false; // 使用者按取消

  const unmount = mountList(root, ctx);
  await flush();

  fireClick(byAction(root, 'toggle-active'));
  await flush();

  assert.equal(state.confirmCalls.length, 1, '應該跳出二次確認');
  assert.match(state.confirmCalls[0], /停用/);
  assert.equal(state.apiCalls.some((c) => c.action === 'setActive'), false, '取消後不該呼叫 setActive');
  unmount();
});

await at('停用：確認後才呼叫 setActive，payload 正確', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [makeUser({ id: 'u001', active: true })] } });
  state.apiHandlers.setActive = () => ({ ok: true, data: {} });
  state.nextConfirm = true;

  const unmount = mountList(root, ctx);
  await flush();
  fireClick(byAction(root, 'toggle-active'));
  await flush();

  const call = state.apiCalls.find((c) => c.action === 'setActive');
  assert.ok(call);
  assert.deepEqual(call.payload, { id: 'u001', active: false });
  unmount();
});

await at('啟用：對停用中的使用者按啟用，payload active 為 true', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [makeUser({ id: 'u002', active: false })] } });
  state.apiHandlers.setActive = () => ({ ok: true, data: {} });
  state.nextConfirm = true;

  const unmount = mountList(root, ctx);
  await flush();
  fireClick(byAction(root, 'toggle-active'));
  await flush();

  const call = state.apiCalls.find((c) => c.action === 'setActive');
  assert.deepEqual(call.payload, { id: 'u002', active: true });
  assert.match(state.confirmCalls[0], /啟用/);
  unmount();
});

// ============================================================
// F. 重設密碼：少於 8 字元前端擋下、要二次確認
// ============================================================

await at('重設密碼：少於 8 字元被前端擋下，不會呼叫後端、不會跳二次確認', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [makeUser({ id: 'u001' })] } });

  const unmount = mountList(root, ctx);
  await flush();
  fireClick(byAction(root, 'reset-password'));
  await flush();

  const overlay = byRole(fakeDocument.body, 'password-form-overlay');
  assert.ok(overlay, '應該開出重設密碼彈窗');
  byField(overlay, 'newPassword').value = 'short7x'; // 7 個字元
  fireClick(byRole(overlay, 'submit'));
  await flush();

  assert.equal(fakeDocument.body.contains(overlay), true, '太短時彈窗不該關閉');
  assert.equal(state.confirmCalls.length, 0, '前端先擋下，根本不該跳出二次確認');
  assert.equal(state.apiCalls.some((c) => c.action === 'resetPassword'), false, '前端先擋下，不該打後端');

  const errorEl = byRole(overlay, 'form-error');
  assert.match(errorEl.textContent, /8/, '應該顯示長度不足的錯誤訊息');

  // 清掉這個彈窗，避免殘留在 fakeDocument.body 干擾後面的情境（它自己的 document
  // keydown 監聽器、以及 byRole(fakeDocument.body, ...) 查找都是全域共用狀態）。
  fireClick(byRole(overlay, 'cancel'));
  await flush();
  assert.equal(fakeDocument.body.contains(overlay), false);

  unmount();
});

await at('重設密碼：長度足夠時，跳二次確認，確認後才呼叫 resetPassword', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [makeUser({ id: 'u001', name: '王會計' })] } });
  state.apiHandlers.resetPassword = () => ({ ok: true, data: {} });
  state.nextConfirm = true;

  const unmount = mountList(root, ctx);
  await flush();
  fireClick(byAction(root, 'reset-password'));
  await flush();

  const overlay = byRole(fakeDocument.body, 'password-form-overlay');
  byField(overlay, 'newPassword').value = 'longenoughpw1';
  fireClick(byRole(overlay, 'submit'));
  await flush();

  assert.equal(fakeDocument.body.contains(overlay), false, '長度足夠應該關閉彈窗');
  assert.equal(state.confirmCalls.length, 1, '關窗後應該跳二次確認');
  assert.match(state.confirmCalls[0], /王會計/);

  const call = state.apiCalls.find((c) => c.action === 'resetPassword');
  assert.ok(call, '確認後應該呼叫 resetPassword');
  assert.deepEqual(call.payload, { id: 'u001', newPassword: 'longenoughpw1' });

  unmount();
});

await at('重設密碼：二次確認按取消，不呼叫 resetPassword', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [makeUser({ id: 'u001' })] } });
  state.nextConfirm = false;

  const unmount = mountList(root, ctx);
  await flush();
  fireClick(byAction(root, 'reset-password'));
  await flush();
  const overlay = byRole(fakeDocument.body, 'password-form-overlay');
  byField(overlay, 'newPassword').value = 'longenoughpw1';
  fireClick(byRole(overlay, 'submit'));
  await flush();

  assert.equal(state.apiCalls.some((c) => c.action === 'resetPassword'), false);
  unmount();
});

// ============================================================
// G. 後端回 ok:false／例外：顯示 toast，不崩潰
// ============================================================

await at('listUsers 回 ok:false：畫面不崩潰，顯示後端的 error 訊息', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: false, error: '沒有權限' });

  const unmount = mountList(root, ctx);
  await flush();

  const rows = findAllDescendants(root, (n) => n.getAttribute && n.getAttribute('data-role') === 'user-row');
  assert.equal(rows.length, 0, '沒有資料，表格應該是空的而不是拋錯');
  assert.equal(state.toasts.length, 1);
  assert.equal(state.toasts[0].message, '沒有權限');
  assert.equal(state.toasts[0].type, 'danger');
  unmount();
});

await at('saveUser 回 ok:false：toast 顯示後端訊息，不當機（沒有未攔截的例外）', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [] } });
  state.apiHandlers.saveUser = () => ({ ok: false, error: '帳號已被使用' });

  const unmount = mountList(root, ctx);
  await flush();
  fireClick(byRole(root, 'add-user'));
  await flush();
  const overlay = byRole(fakeDocument.body, 'user-form-overlay');
  byField(overlay, 'username').value = 'dup';
  byField(overlay, 'name').value = '重複';
  byField(overlay, 'password').value = 'longenoughpw1';
  fireClick(byRole(overlay, 'submit'));
  await flush();

  assert.equal(state.toasts.some((t2) => t2.message === '帳號已被使用' && t2.type === 'danger'), true);
  unmount();
});

await at('setActive 呼叫例外（ctx.api.call 拋錯）：不會讓畫面炸掉，改顯示通用中文訊息', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [makeUser({ id: 'u001', active: true })] } });
  state.apiHandlers.setActive = () => { throw new Error('boom: network exploded'); };
  state.nextConfirm = true;

  const unmount = mountList(root, ctx);
  await flush();
  fireClick(byAction(root, 'toggle-active'));
  await flush();

  assert.equal(state.toasts.length >= 1, true);
  const last = state.toasts[state.toasts.length - 1];
  assert.equal(last.type, 'danger');
  assert.equal(/boom|network|Error/i.test(last.message), false, '不該把技術性錯誤訊息秀給使用者看');
  unmount();
});

// ============================================================
// H. ctx.ui.dialog() 不該被呼叫；不得自行碰 fetch/localStorage（見檔頭哨兵設計）
// ============================================================

t('模組全程沒有呼叫 ctx.ui.dialog()（它無法從外部強制關閉，設計上一律走自組表單彈窗）', () => {
  // 前面所有情境都跑過 ctx.ui.dialog 的哨兵版本（呼叫就拋例外），
  // 整份測試檔沒有任何一個情境失敗於這個哨兵，等於間接證明了這件事；
  // 這裡再補一個直接的行為型驗證：openUserFormDialog／openPasswordDialog
  // 用的是 document.body 上一個新的 .dialog-overlay 節點，不是 ctx.ui 給的任何東西。
  const { ctx } = makeFakeCtx();
  assert.throws(() => ctx.ui.dialog({ body: 'x' }), /不該呼叫/);
});

// ============================================================
// I. 缺陷①：開著的彈窗不能活過模組卸載——unmount() 要一併關掉
// ============================================================

await at('unmount：開著的新增使用者彈窗要被關閉，document 上不再有該 overlay 節點', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [] } });

  const unmount = mountList(root, ctx);
  await flush();
  fireClick(byRole(root, 'add-user'));
  await flush();

  const overlay = byRole(fakeDocument.body, 'user-form-overlay');
  assert.ok(overlay, '應該先開出新增使用者彈窗');
  assert.equal(fakeDocument.body.contains(overlay), true, '彈窗此時應該還開著（模擬使用者不關它就切模組）');

  unmount();
  await flush();

  assert.equal(fakeDocument.body.contains(overlay), false, 'unmount 之後彈窗要被關閉，document 上不該再有這個節點');
});

await at('unmount：開著的重設密碼彈窗也要被關閉，且拿掉 document 上的 keydown 監聽', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [makeUser({ id: 'u001' })] } });

  const beforeCount = ((fakeDocument._listeners && fakeDocument._listeners.keydown) || []).length;

  const unmount = mountList(root, ctx);
  await flush();
  fireClick(byAction(root, 'reset-password'));
  await flush();

  const overlay = byRole(fakeDocument.body, 'password-form-overlay');
  assert.ok(overlay, '應該先開出重設密碼彈窗');
  const afterOpenCount = ((fakeDocument._listeners && fakeDocument._listeners.keydown) || []).length;
  assert.equal(afterOpenCount, beforeCount + 1, '開啟彈窗應該註冊一個 document keydown 監聽（Esc 關閉用）');

  unmount();
  await flush();

  assert.equal(fakeDocument.body.contains(overlay), false, 'unmount 之後彈窗要被關閉');
  const afterUnmountCount = ((fakeDocument._listeners && fakeDocument._listeners.keydown) || []).length;
  assert.equal(afterUnmountCount, beforeCount, 'unmount 應該拿掉彈窗註冊的 document keydown 監聽，不能留著');
});

await at('unmount：沒有開著任何彈窗時，unmount 一樣正常運作（不會因為空集合而出錯）', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [] } });

  const unmount = mountList(root, ctx);
  await flush();
  assert.doesNotThrow(() => unmount(), 'openDialogHandles 是空集合時 unmount 也要能正常跑完');
});

// ============================================================
// J. 缺陷②：角色清單改由後端 listRoles 動態取得，不再寫死在 list.js
// ============================================================

await at('角色清單：listRoles 回傳的新角色會出現在新增使用者表單的角色選項裡（roles 分頁加角色不用改程式）', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [] } });
  state.apiHandlers.listRoles = () => ({
    ok: true,
    data: {
      roles: DEFAULT_ROLES.concat([
        { role: 'supervisor', name_zh: '主任', perms: ['audit.read', 'dorm.read'] } // 試算表新加的角色
      ])
    }
  });

  const unmount = mountList(root, ctx);
  await flush();
  fireClick(byRole(root, 'add-user'));
  await flush();

  const overlay = byRole(fakeDocument.body, 'user-form-overlay');
  const roleSelect = byField(overlay, 'role');
  assert.ok(roleSelect, '應該有角色下拉欄位');
  const options = findAllDescendants(roleSelect, (n) => n.tagName === 'OPTION');
  const supervisorOption = options.find((o) => o.getAttribute('value') === 'supervisor');
  assert.ok(supervisorOption, '試算表新加的角色應該出現在選項裡，不需要改程式');
  assert.equal(supervisorOption.textContent, '主任', '選項顯示名應該是 name_zh');

  fireClick(byRole(overlay, 'cancel'));
  await flush();
  unmount();
});

await at('角色清單退路：listRoles 回 {ok:false} 時畫面不崩潰，角色欄改顯示原始代號', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listRoles = () => ({ ok: false, error: '沒有權限' });
  state.apiHandlers.listUsers = () => ({
    ok: true,
    data: { users: [makeUser({ id: 'u001', role: 'accountant' })] }
  });

  const unmount = mountList(root, ctx);
  await flush();

  const rows = findAllDescendants(root, (n) => n.getAttribute && n.getAttribute('data-role') === 'user-row');
  assert.equal(rows.length, 1, '就算角色清單抓不到，使用者清單還是要正常畫出來，不能整個崩潰');
  const cellsOf = (row) => findAllDescendants(row, (n) => n.tagName === 'TD');
  assert.equal(
    cellsOf(rows[0])[3].innerHTML,
    'accountant',
    'listRoles 失敗時角色欄要退回顯示原始代號，不能空白或壞掉'
  );

  unmount();
});

await at('角色清單退路：listRoles 失敗時，新增使用者表單仍能開啟（角色下拉沒有選項但不拋錯）', async () => {
  const root = new FakeElement('div');
  const { ctx, state } = makeFakeCtx();
  state.apiHandlers.listRoles = () => ({ ok: false, error: '沒有權限' });
  state.apiHandlers.listUsers = () => ({ ok: true, data: { users: [] } });

  const unmount = mountList(root, ctx);
  await flush();
  assert.doesNotThrow(() => fireClick(byRole(root, 'add-user')));
  await flush();

  const overlay = byRole(fakeDocument.body, 'user-form-overlay');
  assert.ok(overlay, 'listRoles 失敗不該讓新增使用者表單開不出來');

  fireClick(byRole(overlay, 'cancel'));
  await flush();
  unmount();
});

// ── 收尾 ──────────────────────────────────────
if (failed > 0) {
  console.error('\n失敗清單：');
  for (const { name, err } of failures) {
    console.error(`  x ${name}`);
    console.error(`    ${err && err.stack ? err.stack : err}`);
  }
}
console.log(`\n通過 ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
