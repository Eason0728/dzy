// test/shell.test.mjs —— T1-8 驗收：platform/shell.js（殼：路由、導覽、掛載／卸載模組）
//
// shell.js 唯一認識的東西是 registry.js 給的清單（見 platform/registry.js 的 MODULES
// 陣列），所以這裡「注入假模組」的做法是：從 registry.js import 出 MODULES（它是
// export const，但陣列本身可變），在 import shell.js 之前把假 manifest push 進去——
// 完全不改 registry.js 這個檔案的原始碼，只是在測試當下讓它多幾筆假資料。
//
// shell.js 是「自啟動」模組（index.html 只有 <script type="module" src="platform/shell.js">，
// 沒有任何 inline JS 呼叫它），所以它在被 import 的當下就會自己找 <div id="app"> 開機。
// 這代表每個測試情境要先把 document/window/localStorage/MODULES 佈置好，
// 再用「帶查詢字串」的動態 import（例如 '../platform/shell.js?case=xxx'）取得一個
// 全新的模組實例（繞過 Node 的模組快取），讓每個情境都拿到一次全新的自啟動流程，
// 同時 auth.js／ui.js／api.js／registry.js 這些依賴仍然是同一份單例（本來就該共用）。
//
// platform/views/login.js 是「已完成、不准修改」的檔案，它用 innerHTML 建表單、
// 再用 querySelector 找欄位——所以這裡的 DOM stub 比 test/ui.test.mjs 那份更進一步，
// 多實作了一個很單純的 HTML 解析器＋querySelector（只需要撐住 login.js 那組簡單、
// 良好格式的樣板），讓 showLogin() 真的能呼叫到未修改的 login.js 而不會炸掉。
//
// 測試全程不打真實網路：預設 fetch 是一個「呼叫了就記一筆並丟錯」的哨兵函式，
// 只有需要驗證 ctx.api.call 轉接的那個測試會暫時換成假 fetch，用完立刻換回哨兵。

'use strict';

import assert from 'node:assert/strict';

// ============================================================
// 0. 事件系統（addEventListener／dispatchEvent，含手刻的冒泡邏輯）
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
// 1. 最小 DOM stub：FakeElement／FakeDocument／FakeWindow
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

// login.js 的樣板是良好格式的簡單巢狀 HTML（見 platform/views/login.js），
// 這個解析器只求撐住那種寫法：標籤／屬性（雙引號、單引號、無引號、布林屬性都支援）／
// 文字節點／void 元素（input 等自動不需要對應的關閉標籤）。
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function parseAttrString(s) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1];
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    attrs[name] = value;
  }
  return attrs;
}

function parseHtmlToNodes(doc, html) {
  const rootHolder = doc.createElement('x-root');
  const stack = [rootHolder];
  const tokenRe =
    /<!--[\s\S]*?-->|<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>|<\s*([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)\s*>|([^<]+)/g;
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    if (m[1]) {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tagName.toLowerCase() === m[1].toLowerCase()) {
          stack.length = i;
          break;
        }
      }
    } else if (m[2]) {
      const tagName = m[2];
      const attrs = parseAttrString(m[3] || '');
      const node = doc.createElement(tagName);
      for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
      stack[stack.length - 1].appendChild(node);
      const selfClosing = m[4] === '/' || VOID_TAGS.has(tagName.toLowerCase());
      if (!selfClosing) stack.push(node);
    } else if (m[5] !== undefined) {
      const text = m[5];
      if (text.trim()) {
        const parent = stack[stack.length - 1];
        parent._textContent = (parent._textContent || '') + text;
      }
    }
  }
  return rootHolder.children;
}

function elementMatchesSelector(node, selector) {
  const s = selector.trim();
  if (s.startsWith('#')) return node.getAttribute('id') === s.slice(1);
  if (s.startsWith('[')) {
    const m = /^\[([a-zA-Z0-9_:-]+)(?:="([^"]*)")?\]$/.exec(s);
    if (!m) return false;
    const [, name, val] = m;
    if (val === undefined) return node.hasAttribute(name);
    return node.getAttribute(name) === val;
  }
  if (s.startsWith('.')) return node.classList && node.classList.contains(s.slice(1));
  return typeof node.tagName === 'string' && node.tagName.toLowerCase() === s.toLowerCase();
}

let fakeDocument; // 前置宣告，FakeElement 的方法透過 closure 在「呼叫當下」才用到，晚宣告沒關係

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
    if (!this._innerHTML) return;
    const nodes = parseHtmlToNodes(fakeDocument, this._innerHTML);
    for (const n of nodes) {
      n.parentNode = this;
      this.children.push(n);
    }
  }

  querySelector(selector) {
    return findDescendant(this, (n) => elementMatchesSelector(n, selector));
  }

  focus() {}
  blur() {}
}

class FakeDocument extends withEvents(Object) {
  constructor() {
    super();
    this.documentElement = new FakeElement('html');
    this.body = new FakeElement('body');
    this.activeElement = this.body;
  }
  createElement(tag) {
    return new FakeElement(tag);
  }
  getElementById(id) {
    if (this.body.getAttribute('id') === id) return this.body;
    return findDescendant(this.body, (n) => n.getAttribute && n.getAttribute('id') === id);
  }
}

// location.hash 用 getter/setter 模擬真實瀏覽器的行為：設成「不同的值」才會觸發
// hashchange；設成「目前這個值」不會（這正是 shell.js 的 navigateTo() 修正①要依賴的
// 前提——見 platform/shell.js 檔頭「導覽只跑一次路由」那段說明，以及 T1-8 缺陷①的修法）。
// 真實瀏覽器的 hashchange 是非同步（下一個 task）才觸發，這裡簡化成同步觸發：shell.js
// 的 navigateTo() 本身不假設「同步或非同步」，只看「hash 到底有沒有變」，所以同步觸發
// 不影響它的正確性，卻讓測試不必引入假的巨集任務排程就能斷言呼叫次數。
class FakeWindow extends withEvents(Object) {
  constructor() {
    super();
    let hashValue = '';
    const self = this;
    this.location = {
      get hash() {
        return hashValue;
      },
      set hash(v) {
        const next = String(v === undefined || v === null ? '' : v);
        if (next === hashValue) return; // 同真實瀏覽器：設成同一個值不觸發 hashchange
        hashValue = next;
        self.dispatchEvent(makeEvent('hashchange', { bubbles: false }));
      }
    };
    this.devicePixelRatio = 1;
  }
}

// ============================================================
// 2. 樹狀查找小工具（給測試自己用；shell.js 內部有它自己的一份，不共用）
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

function dispatchClick(node) {
  node.dispatchEvent(makeEvent('click', { bubbles: true }));
}

// ============================================================
// 3. localStorage polyfill（同 test/perm.test.mjs 的做法）
// ============================================================

class MemoryStorage {
  constructor() {
    this._map = new Map();
  }
  getItem(key) {
    return this._map.has(key) ? this._map.get(key) : null;
  }
  setItem(key, value) {
    this._map.set(key, String(value));
  }
  removeItem(key) {
    this._map.delete(key);
  }
  clear() {
    this._map.clear();
  }
}

// ============================================================
// 4. 全域裝配
// ============================================================

let fakeWindow;

globalThis.localStorage = new MemoryStorage();
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });

const realNetworkCalls = [];
function armFetchGuard() {
  globalThis.fetch = async (url) => {
    realNetworkCalls.push(String(url));
    throw new Error('GUARD: 這次呼叫沒有被 mock，攔截下來避免真的打網路。url=' + url);
  };
}
armFetchGuard();

// ============================================================
// 5. 依賴 import（auth／registry／config 是單例；shell.js 每個情境各自動態 import）
// ============================================================

import { __setTransport, logout as authLogout } from '../platform/auth.js';
import { MODULES } from '../platform/registry.js';
import { BACKENDS } from '../platform/config.js';

// ============================================================
// 6. 測試小工具（沿用 test/ui.test.mjs 的 t()/at() 風格）
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

/** 等待微任務／setImmediate 佇列跑過幾輪，讓 async 函式鏈（例如 badge 的 await）有機會落地。 */
function flush(rounds = 8) {
  return new Promise((resolve) => {
    let n = rounds;
    (function step() {
      if (n-- <= 0) return resolve();
      setImmediate(step);
    })();
  });
}

const TOKEN_KEY = 'dzy.token';

/** 直接種一份「已登入」狀態：localStorage 放 token，auth transport 的 me 回這份身分。
 *  這樣 shell.js 自啟動時 auth.restore() 就會成功，不必真的跑一次 login.js 的表單流程。 */
function seedSession(user, perms, secrets) {
  localStorage.setItem(TOKEN_KEY, 'tok-' + user.id);
  __setTransport(async (req) => {
    if (req.action === 'me') return { ok: true, data: { user, perms, secrets: secrets || {} } };
    return { ok: false, error: '(mock) 未預期的 action：' + req.action };
  });
}

/**
 * 每個測試情境開始前呼叫：清乾淨 MODULES／localStorage／auth 狀態，並且換一份全新的
 * fakeDocument／fakeWindow——shell.js 每個情境都用帶查詢字串的動態 import 拿一份全新
 * 模組實例，它會在自己的 window 上再掛一次 hashchange 監聽器；如果每個情境共用同一個
 * window，舊情境（例如「未登入」那個從沒建過殼 DOM 的實例）的監聽器會一直留著，
 * 之後任何情境 dispatch hashchange 都會連帶觸發它、用它那份永遠是 null 的
 * navMobileEl 炸掉。換一份全新的 window／document 就讓舊監聽器綁在一個沒人再送事件
 * 進去的物件上，自然不會再被觸發。
 */
function resetGlobalState() {
  MODULES.length = 0;
  localStorage.clear();
  authLogout();
  armFetchGuard();

  fakeDocument = new FakeDocument();
  fakeWindow = new FakeWindow();
  globalThis.document = fakeDocument;
  globalThis.window = fakeWindow;

  const appDiv = fakeDocument.createElement('div');
  appDiv.setAttribute('id', 'app');
  fakeDocument.body.appendChild(appDiv);
}

function getAppEl() {
  return fakeDocument.getElementById('app');
}

let caseCounter = 0;
/** 帶查詢字串動態 import shell.js，繞過模組快取，每個情境拿到全新的自啟動實例。 */
async function freshShellImport() {
  caseCounter += 1;
  return import(`../platform/shell.js?case=${caseCounter}`);
}

function makeManifest({ id, ns, name, desc, requires, views, body }) {
  return {
    id,
    ns,
    backend: ns,
    name: name || '示範模組',
    desc: desc || '示範描述',
    icon: id,
    requires,
    views,
    entry: () => Promise.resolve({ default: body })
  };
}

function findToastStack() {
  return findDescendant(fakeDocument.body, (n) => n.className === 'toast-stack');
}

function assertLatestToast(expectedText, expectedType) {
  const stack = findToastStack();
  assert.ok(stack, '應該已經有 toast-stack 容器');
  const last = stack.children[stack.children.length - 1];
  assert.ok(last, '應該至少有一則 toast');
  assert.equal(last.className, `toast toast-${expectedType}`, `toast 的 class 應該是 toast toast-${expectedType}`);
  assert.equal(last.innerHTML, expectedText, `toast 內容應該是「${expectedText}」`);
}

// ============================================================
// 測試 1：未登入時把 hash 改成 #/anything/x 仍停在登入畫面（任務指示第 8 點）
// ============================================================

await at('未登入時：boot 顯示登入頁；手動改 hash 仍停在登入畫面', async () => {
  resetGlobalState(); // 沒有呼叫 seedSession() → localStorage 沒有 token，restore() 會失敗

  await freshShellImport();
  await flush();

  const appEl = getAppEl();
  assert.ok(appEl.querySelector('#login-username'), '開機後應該顯示登入表單（帳號欄位存在）');
  assert.equal(appEl.querySelector('[data-role="nav-mobile"]'), null, '未登入時不該出現殼的導覽列');

  // 模擬「手動改網址列的 hash」：真實瀏覽器會在 hash 真的變動時自動觸發 hashchange，
  // FakeWindow.location 的 setter（見上方定義）已經模擬了這個行為，不必再手動 dispatch。
  fakeWindow.location.hash = '#/anything/x';
  await flush();

  assert.ok(appEl.querySelector('#login-username'), '手動改 hash 之後仍然是登入表單');
  assert.equal(appEl.querySelector('[data-role="nav-mobile"]'), null, '手動改 hash 之後仍然沒有殼的導覽列（沒有離開登入畫面）');
});

// ============================================================
// 測試 2：沒有權限的模組不出現在首頁；沒有權限的分頁不出現在導覽
// ============================================================

await at('沒有權限的模組不出現在首頁；沒有權限的分頁不出現在導覽', async () => {
  resetGlobalState();

  const manifestA = makeManifest({
    id: 'demo-a',
    ns: 'demoa',
    name: '示範Ａ',
    desc: 'Ａ模組說明',
    requires: ['demoa.read'],
    views: [
      { id: 'overview', name: '總覽', requires: [] },
      { id: 'edit', name: '編輯', requires: ['demoa.write'] }
    ],
    body: { mount: async () => undefined }
  });
  const manifestB = makeManifest({
    id: 'demo-b',
    ns: 'demob',
    name: '示範Ｂ',
    desc: 'Ｂ模組說明',
    requires: ['demob.read'],
    views: [{ id: 'overview', name: '總覽', requires: [] }],
    body: { mount: async () => undefined }
  });
  MODULES.push({ load: () => Promise.resolve({ default: manifestA }) }, { load: () => Promise.resolve({ default: manifestB }) });

  // 只有 demoa.read，沒有 demob.read，也沒有 demoa.write
  seedSession({ id: 'u100', name: '測試員', role: 'storelead', node: '' }, ['demoa.read']);

  await freshShellImport();
  await flush();

  const appEl = getAppEl();
  const cards = findAllDescendants(appEl, (n) => n.getAttribute && n.getAttribute('data-role') === 'module-card');
  assert.equal(cards.length, 1, '首頁應該只有一張卡片（沒有權限的 demo-b 不出現）');
  assert.equal(cards[0].getAttribute('data-module'), 'demo-a', '唯一那張卡片應該是有權限的 demo-a');

  const cardTitle = findDescendant(cards[0], (n) => n.className === 'card-title');
  assert.equal(cardTitle && cardTitle.textContent, '示範Ａ', '卡片標題應該顯示 manifest.name');

  // 點卡片，應該進 demo-a 第一個「使用者有權限」的分頁（overview，因為沒有 demoa.write 所以不是 edit）
  dispatchClick(cards[0]);
  await flush();

  assert.equal(fakeWindow.location.hash, '#/demo-a/overview', '點卡片應該導到第一個有權限的分頁');

  const viewNav = appEl.querySelector('[data-role="view-nav"]');
  const viewButtons = findAllDescendants(viewNav, (n) => n.getAttribute && n.getAttribute('data-view'));
  assert.equal(viewButtons.length, 1, '第二層導覽只該出現 1 個分頁按鈕（edit 沒有權限，不該出現）');
  assert.equal(viewButtons[0].getAttribute('data-view'), 'overview', '唯一出現的分頁是使用者有權限的 overview');
});

// ============================================================
// 測試 3：badge 拋錯時該卡片無數字、其他卡片正常、首頁沒壞
// ============================================================

await at('badge 拋錯時該卡片無數字、其他卡片正常、首頁沒壞', async () => {
  resetGlobalState();

  const manifestErr = makeManifest({
    id: 'demo-err',
    ns: 'demoerr',
    requires: ['demoerr.read'],
    views: [{ id: 'overview', name: '總覽', requires: [] }],
    body: {
      mount: async () => undefined,
      badge: () => {
        throw new Error('boom');
      }
    }
  });
  const manifestOk = makeManifest({
    id: 'demo-ok',
    ns: 'demook',
    requires: ['demook.read'],
    views: [{ id: 'overview', name: '總覽', requires: [] }],
    body: {
      mount: async () => undefined,
      badge: async () => 7
    }
  });
  MODULES.push({ load: () => Promise.resolve({ default: manifestErr }) }, { load: () => Promise.resolve({ default: manifestOk }) });
  seedSession({ id: 'u101', name: '測試員', role: 'manager', node: '' }, ['demoerr.read', 'demook.read']);

  await freshShellImport();
  await flush();

  const appEl = getAppEl();
  const cards = findAllDescendants(appEl, (n) => n.getAttribute && n.getAttribute('data-role') === 'module-card');
  assert.equal(cards.length, 2, '首頁沒壞：兩張卡片都還在');

  const errBadge = findDescendant(appEl, (n) => n.getAttribute && n.getAttribute('data-role') === 'badge' && n.getAttribute('data-module') === 'demo-err');
  const okBadge = findDescendant(appEl, (n) => n.getAttribute && n.getAttribute('data-role') === 'badge' && n.getAttribute('data-module') === 'demo-ok');

  assert.equal(errBadge.textContent, '', 'badge 拋錯的卡片不顯示任何數字');
  assert.equal(okBadge.textContent, '7', '另一張卡片的 badge 正常顯示數字');
});

// ============================================================
// 測試 4：badge 逾時（模擬 6 秒不回）→ 5 秒後放棄，首頁正常
// ============================================================

await at('badge 逾時（模擬 6 秒不回）→ 5 秒後放棄，首頁正常', async () => {
  resetGlobalState();

  const manifestTimeout = makeManifest({
    id: 'demo-timeout',
    ns: 'demotimeout',
    requires: ['demotimeout.read'],
    views: [{ id: 'overview', name: '總覽', requires: [] }],
    body: {
      mount: async () => undefined,
      badge: () => new Promise(() => {}) // 永遠不 resolve，模擬 6 秒都不回應
    }
  });
  MODULES.push({ load: () => Promise.resolve({ default: manifestTimeout }) });
  seedSession({ id: 'u102', name: '測試員', role: 'manager', node: '' }, ['demotimeout.read']);

  const capturedTimers = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => {
    const id = { fn, ms };
    capturedTimers.push(id);
    return id;
  };
  globalThis.clearTimeout = () => {};

  try {
    await freshShellImport();
    await flush();

    const timer = capturedTimers.find((c) => c.ms === 5000);
    assert.ok(timer, 'badge 逾時應該註冊一個 5 秒的計時器');
    timer.fn(); // 手動觸發逾時，不真的等 5 秒
    await flush();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  const appEl = getAppEl();
  const cards = findAllDescendants(appEl, (n) => n.getAttribute && n.getAttribute('data-role') === 'module-card');
  assert.equal(cards.length, 1, '首頁正常：卡片還在，沒有因為逾時而壞掉');

  const badgeEl = findDescendant(appEl, (n) => n.getAttribute && n.getAttribute('data-role') === 'badge' && n.getAttribute('data-module') === 'demo-timeout');
  assert.equal(badgeEl.textContent, '', '逾時放棄後不顯示數字');
});

// ============================================================
// 測試 5：非法路由（模組不存在／分頁不存在／權限不足）→ 導回 home 並出現 toast
// ============================================================

await at('非法路由：模組不存在／分頁不存在／權限不足 → 導回 #/home 並 toast(沒有權限,warn)', async () => {
  resetGlobalState();

  const manifestX = makeManifest({
    id: 'demo-x',
    ns: 'demox',
    requires: ['demox.read'],
    views: [
      { id: 'pub', name: '公開', requires: [] },
      { id: 'priv', name: '私有', requires: ['demox.write'] }
    ],
    body: { mount: async () => undefined }
  });
  MODULES.push({ load: () => Promise.resolve({ default: manifestX }) });
  seedSession({ id: 'u103', name: '測試員', role: 'storelead', node: '' }, ['demox.read']); // 沒有 demox.write

  await freshShellImport();
  await flush();

  // 案例一：模組不存在（直接改 hash 模擬手動改網址列；FakeWindow.location 的 setter
  // 在 hash 真的變動時會自動觸發 hashchange，不必再手動 dispatch）
  fakeWindow.location.hash = '#/no-such-module/overview';
  await flush();
  assert.equal(fakeWindow.location.hash, '#/home', '模組不存在應導回 #/home');
  assertLatestToast('沒有權限', 'warn');

  // 案例二：分頁不存在
  fakeWindow.location.hash = '#/demo-x/no-such-view';
  await flush();
  assert.equal(fakeWindow.location.hash, '#/home', '分頁不存在應導回 #/home');
  assertLatestToast('沒有權限', 'warn');

  // 案例三：權限不足（有 demo-x 模組權限，但沒有 priv 分頁需要的 demox.write）
  fakeWindow.location.hash = '#/demo-x/priv';
  await flush();
  assert.equal(fakeWindow.location.hash, '#/home', '權限不足應導回 #/home');
  assertLatestToast('沒有權限', 'warn');
});

// ============================================================
// 測試 6：切換模組時前一個模組的 unmount 有被呼叫；mount 回傳的函式也視同 unmount
// ============================================================

await at('切換模組時前一個模組的 unmount 有被呼叫；mount 回傳的函式也視同 unmount 呼叫', async () => {
  resetGlobalState();

  const callLog = { aUnmountCalls: 0, aReturnedUnmountCalls: 0, bMountCalls: 0 };

  const manifestA = makeManifest({
    id: 'demo-a',
    ns: 'demoa',
    requires: ['demoa.read'],
    views: [{ id: 'overview', name: '總覽', requires: [] }],
    body: {
      mount: async () => {
        return () => {
          callLog.aReturnedUnmountCalls += 1;
        };
      },
      unmount: () => {
        callLog.aUnmountCalls += 1;
      }
    }
  });
  const manifestB = makeManifest({
    id: 'demo-b',
    ns: 'demob',
    requires: ['demob.read'],
    views: [{ id: 'overview', name: '總覽', requires: [] }],
    body: {
      mount: async () => {
        callLog.bMountCalls += 1;
      }
    }
  });
  MODULES.push({ load: () => Promise.resolve({ default: manifestA }) }, { load: () => Promise.resolve({ default: manifestB }) });
  seedSession({ id: 'u104', name: '測試員', role: 'manager', node: '' }, ['demoa.read', 'demob.read']);

  await freshShellImport();
  await flush();

  const appEl = getAppEl();

  // 進 demo-a
  const cardA = findDescendant(appEl, (n) => n.getAttribute && n.getAttribute('data-module') === 'demo-a' && n.getAttribute('data-role') === 'module-card');
  dispatchClick(cardA);
  await flush();
  assert.equal(callLog.aUnmountCalls, 0, 'A 剛掛載，unmount 不該被呼叫');
  assert.equal(callLog.aReturnedUnmountCalls, 0, 'A 剛掛載，mount 回傳的函式也不該被呼叫');

  // 切到 demo-b（用第一層導覽點擊）
  const navBtnB = findDescendant(appEl, (n) => n.getAttribute && n.getAttribute('data-nav') === 'demo-b');
  assert.ok(navBtnB, '第一層導覽應該有 demo-b 的按鈕');
  dispatchClick(navBtnB);
  await flush();

  assert.equal(callLog.aUnmountCalls, 1, '切走 A 時，A 本體的 unmount() 應該被呼叫一次');
  assert.equal(callLog.aReturnedUnmountCalls, 1, 'A 的 mount() 回傳的函式也應該被當成 unmount 呼叫一次');
  assert.equal(callLog.bMountCalls, 1, 'B 的 mount() 被呼叫了一次');
  assert.equal(fakeWindow.location.hash, '#/demo-b/overview', '路由確實切到 demo-b');
});

// ============================================================
// 測試 7：ctx.api.call('假模組id', ...) 會轉成用該 manifest 的 backend 呼叫
// ============================================================

await at("ctx.api.call('假模組id', ...) 會轉成用該 manifest 的 backend 呼叫", async () => {
  resetGlobalState();

  let capturedCall = null;

  const manifestCaller = makeManifest({
    id: 'demo-caller',
    ns: 'audit', // 刻意借用 config.js 真的有設定 URL 的 backend 名稱，方便驗證打對網址
    requires: ['audit.read'],
    views: [{ id: 'overview', name: '總覽', requires: [] }],
    body: {
      mount: async (mountEl, ctx) => {
        // 呼叫「別的模組」demo-target 的後端，驗證殼是拿 moduleId 去查 manifest，不是用自己的 backend
        ctx.api.call('demo-target', 'ping', { x: 1 });
      }
    }
  });
  const manifestTarget = makeManifest({
    id: 'demo-target',
    ns: 'dorm',
    requires: ['dorm.read'],
    views: [{ id: 'overview', name: '總覽', requires: [] }],
    body: { mount: async () => undefined }
  });
  MODULES.push({ load: () => Promise.resolve({ default: manifestCaller }) }, { load: () => Promise.resolve({ default: manifestTarget }) });
  seedSession({ id: 'u105', name: '測試員', role: 'manager', node: '' }, ['audit.read', 'dorm.read']);

  await freshShellImport();
  await flush();

  globalThis.fetch = async (url, opts) => {
    capturedCall = { url: String(url), body: JSON.parse((opts && opts.body) || '{}') };
    return { json: async () => ({ ok: true }) };
  };

  const appEl = getAppEl();
  const cardCaller = findDescendant(
    appEl,
    (n) => n.getAttribute && n.getAttribute('data-module') === 'demo-caller' && n.getAttribute('data-role') === 'module-card'
  );
  dispatchClick(cardCaller);
  await flush();

  armFetchGuard();

  assert.ok(capturedCall, 'ctx.api.call 應該真的送出了一次請求');
  assert.equal(capturedCall.url, BACKENDS.dorm, 'ctx.api.call("demo-target",...) 應該查到 demo-target 的 manifest.backend=dorm，打對網址（不是呼叫端自己的 backend）');
  assert.equal(capturedCall.body.action, 'ping', '送出的 action 正確帶到');
});

// ============================================================
// 測試 7b：ctx.api.call('backend名', ...) 也要通（2026-08-17 修的缺陷）
//
// spec §6.4 規定 audit-stock／audit-ops 共用 modules/audit-shared/api.js，那支共用層
// 不隸屬任何單一模組、傳的是 backend 名 'audit'。修法前殼只按 moduleId 查 manifest，
// 兩個稽核模組的每一次後端呼叫（含首頁 badge）都拿到「殼找不到這個模組」——
// dorm 因為 id 恰好等於 backend 才沒中。這條釘住 fallback：按 id 查不到就按 backend 查。
// ============================================================

await at("ctx.api.call('backend名', ...)（共用資料層的呼叫方式）也解析得到後端", async () => {
  resetGlobalState();

  let capturedCall = null;

  const manifestNsCaller = makeManifest({
    id: 'demo-ns-caller',
    ns: 'audit', // backend===ns（spec §4.1），模組 id 與 backend 名不同——正是稽核兩模組的形狀
    requires: ['audit.read'],
    views: [{ id: 'overview', name: '總覽', requires: [] }],
    body: {
      mount: async (mountEl, ctx) => {
        // 模仿 modules/audit-shared/api.js：用 backend 名呼叫，不是用自己的 moduleId
        ctx.api.call('audit', 'getAll', {});
      }
    }
  });
  MODULES.push({ load: () => Promise.resolve({ default: manifestNsCaller }) });
  seedSession({ id: 'u106', name: '測試員', role: 'accountant', node: '' }, ['audit.read']);

  await freshShellImport();
  await flush();

  globalThis.fetch = async (url, opts) => {
    capturedCall = { url: String(url), body: JSON.parse((opts && opts.body) || '{}') };
    return { json: async () => ({ ok: true }) };
  };

  const appEl = getAppEl();
  const cardNs = findDescendant(
    appEl,
    (n) => n.getAttribute && n.getAttribute('data-module') === 'demo-ns-caller' && n.getAttribute('data-role') === 'module-card'
  );
  dispatchClick(cardNs);
  await flush();

  armFetchGuard();

  assert.ok(capturedCall, "ctx.api.call('audit',...) 應該真的送出了一次請求（修法前這裡拿到「殼找不到這個模組」）");
  assert.equal(capturedCall.url, BACKENDS.audit, "backend 名 'audit' 應該 fallback 解析到 BACKENDS.audit 的網址");
  assert.equal(capturedCall.body.action, 'getAll', '送出的 action 正確帶到');
});

// ============================================================
// 測試 8：缺陷①——一次導覽只會讓模組 mount 一次
//
// 修法前：navigateTo() 先 window.location.hash = hash 再立刻呼叫 route()，但檔案最後也
// 註冊了 hashchange 監聽器會再呼叫一次 route()。hash 真的改變時，兩邊都會跑，模組被
// mount 兩次。FakeWindow.location 的 setter（見上方定義）在 hash 真的變動時會自動觸發
// hashchange，如同真實瀏覽器，所以這裡不必手動 dispatch 就能驗證這件事。
// ============================================================

await at('缺陷①：一次導覽（點卡片進模組）只會讓模組 mount 一次', async () => {
  resetGlobalState();

  let mountCalls = 0;
  const manifestOnce = makeManifest({
    id: 'demo-once',
    ns: 'demoonce',
    requires: ['demoonce.read'],
    views: [{ id: 'overview', name: '總覽', requires: [] }],
    body: {
      mount: async () => {
        mountCalls += 1;
      }
    }
  });
  MODULES.push({ load: () => Promise.resolve({ default: manifestOnce }) });
  seedSession({ id: 'u200', name: '測試員', role: 'manager', node: '' }, ['demoonce.read']);

  await freshShellImport();
  await flush();

  const appEl = getAppEl();
  const card = findDescendant(
    appEl,
    (n) => n.getAttribute && n.getAttribute('data-module') === 'demo-once' && n.getAttribute('data-role') === 'module-card'
  );
  dispatchClick(card); // 這一次點擊＝一次導覽：hash 從 '' 變成 '#/demo-once/overview'
  await flush();

  assert.equal(fakeWindow.location.hash, '#/demo-once/overview', '確實導到目標路由');
  assert.equal(
    mountCalls,
    1,
    '一次導覽只應該讓模組 mount 一次（不是被 hashchange 監聽器與 navigateTo 內部各觸發一次、掛載兩次）'
  );
});

// ============================================================
// 測試 9：缺陷①——hash 沒有變化時（點目前已經在的那一頁）仍然會正確重跑一次路由
// ============================================================

await at('缺陷①：hash 沒有變化（點目前已經在的那一頁）仍然會正確重跑一次路由', async () => {
  resetGlobalState();

  let mountCalls = 0;
  const onRouteLog = [];
  const manifestSame = makeManifest({
    id: 'demo-same',
    ns: 'demosame',
    requires: ['demosame.read'],
    views: [{ id: 'overview', name: '總覽', requires: [] }],
    body: {
      mount: async () => {
        mountCalls += 1;
      },
      onRoute: (ctx) => {
        onRouteLog.push(ctx.viewId);
      }
    }
  });
  MODULES.push({ load: () => Promise.resolve({ default: manifestSame }) });
  seedSession({ id: 'u201', name: '測試員', role: 'manager', node: '' }, ['demosame.read']);

  await freshShellImport();
  await flush();

  const appEl = getAppEl();
  const card = findDescendant(
    appEl,
    (n) => n.getAttribute && n.getAttribute('data-module') === 'demo-same' && n.getAttribute('data-role') === 'module-card'
  );
  dispatchClick(card);
  await flush();

  assert.equal(mountCalls, 1, '第一次進模組，mount 一次');
  assert.equal(onRouteLog.length, 0, '第一次掛載本身不該額外觸發 onRoute()（spec §4.6）');

  // 點目前已經在的那個分頁按鈕：hash 會被設成跟目前一模一樣的值，瀏覽器不會觸發
  // hashchange，必須由 navigateTo() 自己補呼叫一次 route()，否則畫面卡死、不會重跑路由。
  const viewNav = appEl.querySelector('[data-role="view-nav"]');
  const overviewBtn = findDescendant(viewNav, (n) => n.getAttribute && n.getAttribute('data-view') === 'overview');
  assert.ok(overviewBtn, '應該有 overview 分頁按鈕');
  dispatchClick(overviewBtn);
  await flush();

  assert.equal(fakeWindow.location.hash, '#/demo-same/overview', 'hash 沒有改變');
  assert.equal(mountCalls, 1, '同一個分頁再點一次，不該重新 mount（模組已經掛著）');
  assert.equal(onRouteLog.length, 1, '路由確實有重跑一次：模組的 onRoute() 應該被呼叫了一次');
  assert.equal(onRouteLog[0], 'overview', 'onRoute() 拿到的 viewId 正確');
});

// ============================================================
// 測試 10：缺陷②——同模組從 A 分頁切到 B 分頁 → 模組手上那個 ctx 的 viewId 變成 B、
// params 同步更新（原地更新同一個物件，不是換一個新物件——模組可能已經把 ctx 存起來）
// ============================================================

await at('缺陷②：同模組換分頁 → 模組手上那個 ctx 物件的 viewId／params 原地更新', async () => {
  resetGlobalState();

  let capturedCtx = null;
  const manifestTabs = makeManifest({
    id: 'demo-tabs',
    ns: 'demotabs',
    requires: ['demotabs.read'],
    views: [
      { id: 'tab-a', name: 'Ａ分頁', requires: [] },
      { id: 'tab-b', name: 'Ｂ分頁', requires: [] }
    ],
    body: {
      mount: async (mountEl, ctx) => {
        capturedCtx = ctx; // 模組把 ctx 存起來，之後不該再拿到一個新的
      }
    }
  });
  MODULES.push({ load: () => Promise.resolve({ default: manifestTabs }) });
  seedSession({ id: 'u202', name: '測試員', role: 'manager', node: '' }, ['demotabs.read']);

  await freshShellImport();
  await flush();

  const appEl = getAppEl();
  const card = findDescendant(
    appEl,
    (n) => n.getAttribute && n.getAttribute('data-module') === 'demo-tabs' && n.getAttribute('data-role') === 'module-card'
  );
  dispatchClick(card);
  await flush();

  assert.ok(capturedCtx, '模組應該已經拿到 ctx');
  assert.equal(capturedCtx.viewId, 'tab-a', 'mount 當下 ctx.viewId 是掛載的那一頁');
  assert.deepEqual(capturedCtx.params, {}, '掛載當下沒有 query，params 是空物件');
  const ctxRefBeforeSwitch = capturedCtx;

  // 換分頁＋帶 query（模擬使用者手動改網址列，或模組呼叫 ctx.nav 之後瀏覽器觸發 hashchange）
  fakeWindow.location.hash = '#/demo-tabs/tab-b?month=8';
  await flush();

  assert.equal(capturedCtx, ctxRefBeforeSwitch, '模組手上那個 ctx 應該還是同一個物件（沒有被換掉）');
  assert.equal(capturedCtx.viewId, 'tab-b', '同一個物件的 viewId 應該被原地更新成 B');
  assert.deepEqual(capturedCtx.params, { month: '8' }, '同一個物件的 params 應該同步更新');
});

// ============================================================
// 測試 11：缺陷②——模組有實作 onRoute → 切分頁時被呼叫且拿到新的 viewId
// ============================================================

await at('缺陷②：模組有實作 onRoute(ctx) → 換分頁時被呼叫一次，拿到新的 viewId', async () => {
  resetGlobalState();

  const onRouteCalls = [];
  const manifestTabs = makeManifest({
    id: 'demo-onroute',
    ns: 'demoonroute',
    requires: ['demoonroute.read'],
    views: [
      { id: 'tab-a', name: 'Ａ分頁', requires: [] },
      { id: 'tab-b', name: 'Ｂ分頁', requires: [] }
    ],
    body: {
      mount: async () => undefined,
      onRoute: (ctx) => {
        onRouteCalls.push({ viewId: ctx.viewId, params: { ...ctx.params } });
      }
    }
  });
  MODULES.push({ load: () => Promise.resolve({ default: manifestTabs }) });
  seedSession({ id: 'u203', name: '測試員', role: 'manager', node: '' }, ['demoonroute.read']);

  await freshShellImport();
  await flush();

  const appEl = getAppEl();
  const card = findDescendant(
    appEl,
    (n) => n.getAttribute && n.getAttribute('data-module') === 'demo-onroute' && n.getAttribute('data-role') === 'module-card'
  );
  dispatchClick(card);
  await flush();

  assert.equal(onRouteCalls.length, 0, '第一次掛載不該觸發 onRoute()');

  fakeWindow.location.hash = '#/demo-onroute/tab-b?x=1';
  await flush();

  assert.equal(onRouteCalls.length, 1, '換分頁應該讓 onRoute() 被呼叫一次');
  assert.equal(onRouteCalls[0].viewId, 'tab-b', 'onRoute() 拿到的 ctx.viewId 是新的分頁');
  assert.deepEqual(onRouteCalls[0].params, { x: '1' }, 'onRoute() 拿到的 ctx.params 是新的 query');
});

// ============================================================
// 測試 12：缺陷②——模組沒有實作 onRoute → 切分頁不會拋錯（向後相容）
// ============================================================

await at('缺陷②：模組沒有實作 onRoute → 切分頁不會拋錯，行為不變（向後相容）', async () => {
  resetGlobalState();

  let mountCalls = 0;
  const manifestNoOnRoute = makeManifest({
    id: 'demo-no-onroute',
    ns: 'demonoonroute',
    requires: ['demonoonroute.read'],
    views: [
      { id: 'tab-a', name: 'Ａ分頁', requires: [] },
      { id: 'tab-b', name: 'Ｂ分頁', requires: [] }
    ],
    body: {
      // 刻意不實作 onRoute，模擬既有模組（例如目前的 modules/users）
      mount: async () => {
        mountCalls += 1;
      }
    }
  });
  MODULES.push({ load: () => Promise.resolve({ default: manifestNoOnRoute }) });
  seedSession({ id: 'u204', name: '測試員', role: 'manager', node: '' }, ['demonoonroute.read']);

  await freshShellImport();
  await flush();

  const appEl = getAppEl();
  const card = findDescendant(
    appEl,
    (n) => n.getAttribute && n.getAttribute('data-module') === 'demo-no-onroute' && n.getAttribute('data-role') === 'module-card'
  );
  dispatchClick(card);
  await flush();

  // 換分頁：模組沒有 onRoute，殼只是「有實作才呼叫」，不該拋錯、也不該把畫面弄壞
  fakeWindow.location.hash = '#/demo-no-onroute/tab-b';
  await flush();

  assert.equal(fakeWindow.location.hash, '#/demo-no-onroute/tab-b', '路由確實切到 tabB');
  assert.equal(mountCalls, 1, '同模組換分頁不會重新 mount');

  const viewNav = appEl.querySelector('[data-role="view-nav"]');
  const activeBtn = findDescendant(viewNav, (n) => n.classList && n.classList.contains('is-active'));
  assert.equal(activeBtn && activeBtn.getAttribute('data-view'), 'tab-b', '第二層導覽的 active 狀態正確切到 tabB');
});

// ============================================================
// 收尾
// ============================================================

t('全程沒有任何一次呼叫落到未被 mock 的真實 fetch', () => {
  assert.equal(realNetworkCalls.length, 0, JSON.stringify(realNetworkCalls));
});

if (failed > 0) {
  console.error('\n失敗清單：');
  for (const { name, err } of failures) {
    console.error(`  x ${name}`);
    console.error(`    ${err && err.stack ? err.stack : err}`);
  }
}
console.log(`\n通過 ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
