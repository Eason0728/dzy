// test/sign-page.test.mjs —— T3-5 驗收：~/dzy/sign.html（宿舍簽約頁，殼外，去重）
// 跑法：node test/sign-page.test.mjs
//
// sign.html 是唯讀舊檔 ~/mala-dorm-contract/sign.html 複製過來，只做兩件替換
// （esc() 改 import platform/fmt.js、簽名板改 import platform/ui.js 的 signaturePad()）
// 加上 API_URL 改從 platform/config.js 的 BACKENDS.dorm 取，流程邏輯一行不改
// （見檔頭與 docs/task.md T3-5）。
//
// 這支頁面跟 modules/dorm/views/*.js 不同：它不是「mount(el,ctx) 用 createElement
// 組 DOM」的模組，而是舊式「一大段 innerHTML 樣板字串塞進 #app」的寫法（殼外頁，
// 不能改寫法，見紅線）。因此不能沿用 dorm-handover.test.mjs 那種「元素本來就用
// createElement 建好」的最小 DOM stub——那種 stub 的 innerHTML setter 只存字串，不會
// 真的長出子節點，getElementById 找不到東西。這裡另外刻一個「夠用的最小 HTML 片段
// 解析器」，把 render 出來的 HTML 字串真的長成可以 getElementById／querySelectorAll
// 查詢的節點樹（只支援本頁實際會用到的語法：一般標籤、void 標籤 input/img、
// 屬性含 boolean 屬性 checked/disabled、id/class/data-*），不是一個通用 HTML5 parser。
//
// 為了讓「同一個 token 開啟、同樣的操作」這件事可以被驗證，這裡是把 sign.html 裡
// <script type="module"> 的原始碼整段抽出來、把三個 import 路徑改寫成指向真正的
// platform/fmt.js／ui.js／config.js（同一份原始碼，只是路徑改絕對路徑，邏輯字元
// 不變），再包成 data: URL 動態 import 執行——不落地寫任何暫存檔（任務只准新建
// sign.html 與這支測試檔兩個檔案）。
//
// 全程不打真實網路：globalThis.fetch 整個替換成假的，見 makeFakeFetch()。

'use strict';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

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

// ============================================================
// 0. 找檔案、抽 <script type="module">、改寫 import 路徑
// ============================================================

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DZY_ROOT = path.resolve(TEST_DIR, '..');
const SIGN_HTML_PATH = path.join(DZY_ROOT, 'sign.html');

function extractModuleScript(html) {
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('sign.html：找不到 <script type="module"> 區塊，測試前提假設不成立（頁面是否還是用 type="module"？）');
  return m[1];
}

function rewriteImports(src) {
  const fmtUrl = pathToFileURL(path.join(DZY_ROOT, 'platform/fmt.js')).href;
  const uiUrl = pathToFileURL(path.join(DZY_ROOT, 'platform/ui.js')).href;
  const configUrl = pathToFileURL(path.join(DZY_ROOT, 'platform/config.js')).href;
  let out = src;
  out = out.replace("from './platform/fmt.js';", `from ${JSON.stringify(fmtUrl)};`);
  out = out.replace("from './platform/ui.js';", `from ${JSON.stringify(uiUrl)};`);
  out = out.replace("from './platform/config.js';", `from ${JSON.stringify(configUrl)};`);
  if (out === src) throw new Error('rewriteImports：三個 import 路徑一個都沒換到，正規表達式可能跟原始碼對不上');
  return out;
}

let importNonce = 0;
async function importSignPageScript() {
  const html = readFileSync(SIGN_HTML_PATH, 'utf8');
  const raw = extractModuleScript(html);
  const rewritten = rewriteImports(raw);
  // 每次都要是全新模組實例（各測試場景彼此獨立、互不沾染狀態），
  // data: URL 內容必須不同，Node 才不會用模組快取重複舊實例。
  const withNonce = `${rewritten}\n// __test_nonce__=${importNonce++}\n`;
  const dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(withNonce);
  return import(dataUrl);
}

// ============================================================
// 1. 最小 DOM stub＋「夠用」的 innerHTML 片段解析器
// ============================================================

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

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
  toggle(name, force) {
    const on = force === undefined ? !this._set.has(name) : !!force;
    if (on) this._set.add(name);
    else this._set.delete(name);
    return on;
  }
  contains(name) {
    return this._set.has(name);
  }
  toString() {
    return [...this._set].join(' ');
  }
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
    this.dataset = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.width = 300;
    this.height = 150;
    this._rect = { width: 300, height: 150, left: 0, top: 0 };
  }

  get parentElement() {
    return this.parentNode;
  }

  get id() {
    return this._attrs.id || '';
  }
  set id(v) {
    this.setAttribute('id', v);
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
    if (name === 'class') {
      this.className = value;
    } else if (name.indexOf('data-') === 0) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = value;
    } else if (name === 'checked') {
      this.checked = true;
    } else if (name === 'disabled') {
      this.disabled = true;
    } else if (name === 'value') {
      this.value = value;
    }
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name);
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

  set innerHTML(html) {
    this.children = [];
    parseHTMLInto(this, String(html));
  }
  get innerHTML() {
    // 這裡不重建字串（測試用不到），有取用需求前先報錯，避免默默回傳假資料。
    throw new Error('FakeElement.innerHTML 這個 stub 只實作 setter（供 sign.html 塞畫面用），沒實作 getter');
  }

  getBoundingClientRect() {
    return this._rect;
  }
  getContext(type) {
    if (type !== '2d') return null;
    if (!this._ctx) this._ctx = makeFakeCanvasContext();
    return this._ctx;
  }
  toDataURL() {
    return 'data:image/png;base64,FAKE';
  }
  focus() {}
  blur() {}
}

/**
 * 「夠用的最小 HTML 片段解析器」：只處理 sign.html render 函式實際會產出的語法——
 * 一般巢狀標籤、void 標籤（input/img 不需要對應的關閉標籤）、雙引號屬性值、
 * boolean 屬性（checked/disabled，沒有 `=值`）。文字節點本身不建節點存放
 * （sign.html 的邏輯沒有任何地方會讀取渲染後的文字內容，只有寫入 textContent，
 * 見檔頭），只建元素樹，getElementById／querySelectorAll 才有東西可查。
 */
function parseHTMLInto(root, html) {
  const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g;
  const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const stack = [root];
  let m;
  while ((m = TAG_RE.exec(html))) {
    const closing = !!m[1];
    const tagName = m[2].toLowerCase();
    const attrsRaw = m[3] || '';
    const explicitSelfClose = !!m[4];

    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const el = new FakeElement(tagName);
    let am;
    ATTR_RE.lastIndex = 0;
    while ((am = ATTR_RE.exec(attrsRaw))) {
      if (!am[1]) continue;
      const name = am[1];
      const hasValue = am[2] !== undefined || am[3] !== undefined || am[4] !== undefined;
      const value = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : '';
      el.setAttribute(name, hasValue ? value : '');
    }

    stack[stack.length - 1].appendChild(el);
    if (!explicitSelfClose && !VOID_TAGS.has(tagName)) {
      stack.push(el);
    }
  }
}

function descendants(el) {
  const out = [];
  const walk = (node) => {
    for (const c of node.children) {
      out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

function matchesSimpleSelector(el, sel) {
  if (sel[0] === '.') return el.classList.contains(sel.slice(1));
  if (sel[0] === '#') return el.id === sel.slice(1);
  return el.tagName.toLowerCase() === sel.toLowerCase();
}

/** 只支援簡單選擇器＋空白後代組合子（sign.html 只用到 '.equip input'） */
function queryAll(root, selector) {
  const parts = selector.trim().split(/\s+/);
  let candidates = [root];
  for (const part of parts) {
    const next = [];
    const seen = new Set();
    for (const c of candidates) {
      for (const d of descendants(c)) {
        if (matchesSimpleSelector(d, part) && !seen.has(d)) {
          seen.add(d);
          next.push(d);
        }
      }
    }
    candidates = next;
  }
  return candidates;
}

class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.documentElement = new FakeElement('html');
    this.body = new FakeElement('body');
  }
  createElement(tag) {
    return new FakeElement(tag);
  }
  getElementById(id) {
    if (this.body.id === id) return this.body;
    for (const d of descendants(this.body)) {
      if (d.id === id) return d;
    }
    return null;
  }
  querySelectorAll(selector) {
    return queryAll(this.body, selector);
  }
}

class FakeWindow extends EventTarget {
  constructor() {
    super();
    this.devicePixelRatio = 2;
  }
}

function fireMouse(el, type, x, y) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  e.clientX = x;
  e.clientY = y;
  el.dispatchEvent(e);
}

// ============================================================
// 2. 假環境：一頁一套全新 document/window/fetch（模擬「重新開一次連結」）
// ============================================================

const CONTRACT_FIXTURE = {
  ok: true,
  state: 'pending',
  contract: {
    name: '測試員',
    room_bed: '三樓1號房 雙人床位A',
    rent: 2000,
    property_addr: '新竹市光復路一段435號',
    term_start: '2026-08-01',
    term_end: '2027-01-31'
  },
  equip: ['書桌', '椅子'],
  terms: {
    version: 'test-v1',
    clauses: [{ no: '第一條', title: '租賃標的', body: '測試條文內容' }],
    annex1: { title: '附件一　附屬設備賠償單價表', prices: [{ item: '書桌', qty: 1, price: 500 }], footer: '測試附註' },
    annex2: { sections: [{ title: '住宿須知', body: '測試須知內容' }] }
  }
};

function makeFakeFetch(calls, { contractResponse = CONTRACT_FIXTURE, signResponse = { ok: true, pdf_url: 'https://example.test/fake.pdf' } } = {}) {
  return async (url, init) => {
    const record = { url: String(url), init };
    calls.push(record);
    if (!init || !init.method) {
      return { ok: true, json: async () => contractResponse };
    }
    if (init.method === 'POST') {
      try {
        record.parsedBody = JSON.parse(init.body);
      } catch (e) {
        record.parsedBody = null;
      }
      return { ok: true, json: async () => signResponse };
    }
    throw new Error('GUARD: 沒有預期到的 fetch 呼叫方式，url=' + url);
  };
}

async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor：逾時仍未成立');
    await new Promise((r) => setTimeout(r, 4));
  }
}

/**
 * 開一次「全新分頁」：換一組全新的 document/window/fetch，動態載入 sign.html 的
 * module script，等它把表單畫出來（submit 鈕出現）為止，回傳常用元素與呼叫紀錄。
 */
async function openSignPage({ token = 'TEST-TOKEN-001', fetchOptions, readyCheck } = {}) {
  const doc = new FakeDocument();
  const win = new FakeWindow();
  const appDiv = doc.createElement('div');
  appDiv.setAttribute('id', 'app');
  appDiv.setAttribute('class', 'wrap');
  doc.body.appendChild(appDiv);

  const calls = [];
  const alerts = [];

  globalThis.document = doc;
  globalThis.window = win;
  // Node 內建的 navigator／location 是唯讀 getter（Node 21+），得用 defineProperty 蓋掉。
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'FakeUA/1.0 (test)' }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: { search: '?t=' + encodeURIComponent(token) }, configurable: true, writable: true });
  globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => (name === '--ink' ? '#1c1a19' : '') });
  globalThis.alert = (msg) => alerts.push(msg);
  globalThis.fetch = makeFakeFetch(calls, fetchOptions);

  await importSignPageScript();
  await waitFor(readyCheck || (() => doc.getElementById('submit') !== null));

  return {
    doc,
    win,
    calls,
    alerts,
    submit: doc.getElementById('submit'),
    status: doc.getElementById('status'),
    canvas: doc.getElementById('pad'),
    clearBtn: doc.getElementById('clear'),
    idInput: doc.getElementById('f_id_no'),
    phoneInput: doc.getElementById('f_phone'),
    mailInput: doc.getElementById('f_mail_addr')
  };
}

function fillField(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function drawSignature(canvas, win) {
  fireMouse(canvas, 'mousedown', 10, 10);
  fireMouse(canvas, 'mousemove', 30, 30);
  win.dispatchEvent(new Event('mouseup'));
}

// ============================================================
// 3. 測試本體
// ============================================================

await at('渲染完成：頁面骨架、設備清單都長出來了（確認 DOM 解析器本身是可信的）', async () => {
  const page = await openSignPage();
  assert.equal(page.submit.tagName, 'BUTTON');
  assert.equal(page.submit.disabled, true, '一開始（欄位、簽名都還沒填）送出鈕應為停用');
  const equipInputs = page.doc.querySelectorAll('.equip input');
  assert.equal(equipInputs.length, 2, 'CONTRACT_FIXTURE.equip 有兩項，應該渲染出兩個 checkbox');
  assert.equal(equipInputs[0].dataset.k, '書桌');
  assert.equal(equipInputs[0].checked, true, '設備預設全部勾選（對應舊版 checked 屬性）');
});

await at('簽名為空時擋：欄位都合法，但沒簽名 → 送出鈕仍為停用', async () => {
  const page = await openSignPage();
  fillField(page.idInput, 'a123456789');
  fillField(page.phoneInput, '0912345678');
  assert.equal(page.submit.disabled, true, '沒簽名不該讓送出鈕開放');
  assert.equal(page.status.textContent, '請先簽名（已點收 2 項設備）');
});

await at('必填欄位缺漏擋：已簽名，但身分證／手機任一沒填或格式不對 → 送出鈕仍為停用', async () => {
  const page = await openSignPage();
  drawSignature(page.canvas, page.win);
  assert.equal(page.submit.disabled, true, '簽了名但欄位都還沒填，仍應停用');
  assert.equal(page.status.textContent, '請填身分證字號');

  fillField(page.idInput, '不合法格式');
  assert.equal(page.submit.disabled, true);
  assert.equal(page.status.textContent, '身分證格式：英文字母開頭，共 10 碼');

  fillField(page.idInput, 'A123456789');
  assert.equal(page.submit.disabled, true, '身分證合法但手機還沒填，仍應停用');
  assert.equal(page.status.textContent, '請填聯絡電話');

  fillField(page.phoneInput, '0812345678'); // 09 開頭才合法
  assert.equal(page.submit.disabled, true);
  assert.equal(page.status.textContent, '手機格式：09 開頭共 10 碼');
});

await at('欄位＋簽名都合法 → 送出鈕開放，且送出 payload 的欄位名與舊版一致', async () => {
  const page = await openSignPage({ token: 'PAYLOAD-TEST-TOKEN' });
  fillField(page.idInput, 'a123456789');
  fillField(page.phoneInput, '0912345678');
  fillField(page.mailInput, '新竹市某路1號');
  drawSignature(page.canvas, page.win);

  assert.equal(page.submit.disabled, false, '欄位合法＋已簽名，送出鈕應開放');
  assert.equal(page.status.textContent, '確認無誤即可送出（點收 2 項設備）');

  assert.equal(typeof page.submit.onclick, 'function');
  await page.submit.onclick();

  const postCall = page.calls.find((c) => c.init && c.init.method === 'POST');
  assert.ok(postCall, '應該送出一次 POST 請求');
  const body = postCall.parsedBody;
  // 逐欄位核對：與舊版 /Users/guoeason/mala-dorm-contract/sign.html 249-260 行 submit() 組出的 payload 一致
  // （action/token/equip/sign_png/ua/id_no/phone/mail_addr，型別與大小寫規則都不變）。
  assert.deepEqual(Object.keys(body).sort(), ['action', 'equip', 'id_no', 'mail_addr', 'phone', 'sign_png', 'token', 'ua'].sort());
  assert.equal(body.action, 'sign');
  assert.equal(body.token, 'PAYLOAD-TEST-TOKEN');
  assert.equal(body.id_no, 'A123456789', '身分證要 trim + 轉大寫');
  assert.equal(body.phone, '0912345678');
  assert.equal(body.mail_addr, '新竹市某路1號');
  assert.equal(body.ua, 'FakeUA/1.0 (test)');
  assert.equal(typeof body.sign_png, 'string');
  assert.ok(body.sign_png.startsWith('data:image/png'));
  assert.deepEqual(body.equip, [
    { item: '書桌', ok: true },
    { item: '椅子', ok: true }
  ]);

  // 送出後 GET 合約用的網址仍然是打 BACKENDS.dorm（config.js），不是頁面自己刻的網址。
  const getCall = page.calls.find((c) => !c.init || !c.init.method);
  assert.ok(getCall.url.startsWith('https://script.google.com/macros/s/AKfycbyxyhJ35MWTjtvzKr54_9JzGfLZlclyqn2fYLWXgz0muTFzL_tu81nR1r3W332J1igm/exec'));
});

await at('清除重簽：清掉之後又變回「未簽名」，送出鈕重新停用', async () => {
  const page = await openSignPage();
  fillField(page.idInput, 'a123456789');
  fillField(page.phoneInput, '0912345678');
  drawSignature(page.canvas, page.win);
  assert.equal(page.submit.disabled, false);

  assert.equal(typeof page.clearBtn.onclick, 'function');
  page.clearBtn.onclick();
  assert.equal(page.submit.disabled, true, '清除重簽後應該又變回停用');
  assert.equal(page.status.textContent, '請先簽名（已點收 2 項設備）');

  // 清掉之後再簽一次，應該又能正常開放（padWasEmpty 旗標要正確重置）
  drawSignature(page.canvas, page.win);
  assert.equal(page.submit.disabled, false, '重簽一次之後應該又能開放送出');
});

await at('離開頁面（pagehide）呼叫 signaturePad.destroy()：解除監聽後畫布事件不再生效', async () => {
  const page = await openSignPage();
  fillField(page.idInput, 'a123456789');
  fillField(page.phoneInput, '0912345678');
  drawSignature(page.canvas, page.win);
  assert.equal(page.submit.disabled, false, '離開前應該已經是簽好、可送出的狀態');

  page.win.dispatchEvent(new Event('pagehide'));

  // destroy() 之後，畫布上的監聽（含掛在 window 的 mouseup）應該都解除了。
  // 用「清除重簽」把狀態重置回未簽名，再試著畫一次：如果 destroy() 真的生效，
  // 這次畫圖不該再讓送出鈕重新開放。
  page.clearBtn.onclick();
  assert.equal(page.submit.disabled, true);
  drawSignature(page.canvas, page.win);
  assert.equal(page.submit.disabled, true, 'destroy() 之後畫布事件不該再讓簽名生效');
});

await at('已簽署狀態（state==="signed"）：直接顯示完成摘要，不進入表單流程', async () => {
  const page = await openSignPage({
    fetchOptions: {
      contractResponse: {
        ok: true,
        state: 'signed',
        contract: { ...CONTRACT_FIXTURE.contract, signed_at: '2026-08-10 09:00:00', pdf_url: 'https://example.test/signed.pdf' },
        terms: CONTRACT_FIXTURE.terms
      }
    },
    // 這個場景不會渲染出 #submit（狀態摘要卡片沒有表單），改等 .done 卡片出現。
    readyCheck: () => globalThis.document.querySelectorAll('.done').length > 0
  });
  const done = page.doc.querySelectorAll('.done');
  assert.equal(done.length > 0, true, '已簽署狀態應該顯示 .done 摘要卡片，而不是簽署表單');
  assert.equal(page.doc.getElementById('submit'), null, '已簽署狀態不該再出現送出鈕');
});

// ── 收尾：印出結果 ──────────────────────────────────────
if (failed > 0) {
  console.error('\n失敗清單：');
  for (const { name, err } of failures) {
    console.error(`  x ${name}`);
    console.error(`    ${err.stack || err.message}`);
  }
}
console.log(`\n通過 ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
