// node test/batch-read-front.test.mjs —— 首頁少等：前端併請求、開關、上次件數（2026-11-10）
// 全程假 fetch／假 storage，一次真實網路都不打。帳號、token 都是測試自造的假值。

'use strict';

class MemoryStorage {
  constructor() { this._map = new Map(); this.ops = []; }
  getItem(k) { this.ops.push(['get', k]); return this._map.has(k) ? this._map.get(k) : null; }
  setItem(k, v) { this.ops.push(['set', k]); this._map.set(k, String(v)); }
  removeItem(k) { this.ops.push(['remove', k]); this._map.delete(k); }
  clear() { this._map.clear(); }
  get length() { return this._map.size; }
  key(i) { return [...this._map.keys()][i] ?? null; }
}
globalThis.localStorage = new MemoryStorage();
Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true, writable: true });

import { login, logout, __setTransport } from '../platform/auth.js';
import { call, __setHomeFast, __setTimeoutMs, beginHomeBatch } from '../platform/api.js';
import { homeFastAllowed, HOME_FAST } from '../platform/config.js';
import { BATCH_READ_ACTIONS } from '../platform/dryrun.js';
import { __setDryRun } from '../platform/dryrun.js';
import { homeBadgeKey, readHomeBadges, writeHomeBadges, clearHomeBadges, sanitizeCounts, HOME_BADGE_MAX_AGE_MS } from '../platform/home-cache.js';

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}
// 開關開 + 首頁載入期間（shell 呼叫 beginHomeBatch）才併請求
let endHome = null;
function fastOn() { __setHomeFast(true); endHome = beginHomeBatch(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT = 160;   // 比併請求視窗（80ms）久一點

// ---- 真實網路守衛：沒被自己的 mock 蓋掉的 fetch 一律丟錯 ----
const realCalls = [];
function arm() { globalThis.fetch = async (u) => { realCalls.push(String(u)); throw new Error('GUARD ' + u); }; }
arm();

/** 假後端：batchRead 依 handlers 逐筆回；單筆照 handlers 回。calls 記每次 fetch 的 body。 */
function makeBackend(handlers, opts) {
  const calls = [];
  const o = opts || {};
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (body.action === 'batchRead') {
      if (o.fail === 'throw') throw new Error('network down');
      if (o.fail === 'notok') return { json: async () => ({ ok: false, error: '不支援的操作' }) };
      if (o.fail === 'badjson') return { json: async () => { throw new Error('bad json'); } };
      if (o.fail === 'short') return { json: async () => ({ ok: true, data: { results: [] } }) };
      if (o.fail === 'status') return { status: 502, json: async () => ({}) };
      const results = body.payload.items.map((it) => (handlers[it.action] ? handlers[it.action](it.payload, body.token) : { ok: false, error: '不支援的操作' }));
      return { json: async () => ({ ok: true, data: { results } }) };
    }
    const h = handlers[body.action];
    return { json: async () => (h ? h(body.payload, body.token) : { ok: false, error: '（mock）未預期：' + body.action }) };
  };
  return calls;
}

async function loginAs(id, token, perms) {
  __setTransport(async (req) => (req.action === 'login' ? { ok: true, data: { token, user: { id, name: '測試' + id, role: 'staff', node: '' }, perms: perms || ['*'] } } : { ok: false, error: 'x' }));
  const r = await login('u', 'pw');
  __setTransport(null);
  if (!r.ok) throw new Error('測試登入失敗');
}
async function quietLogout() {
  __setTransport(async () => ({ ok: true, data: {} }));
  try { await logout(); } finally { __setTransport(null); }
}

const H = {
  staffList: () => ({ ok: true, data: { staff: [{ emp_no: 'DZY901' }] } }),
  clockAlerts: () => ({ ok: true, data: { counts: { a: 1 } } }),
  regionList: () => ({ ok: false, error: '沒有權限', code: 'no_perm' }),
  evMe: () => ({ ok: true, data: { evaluable: true } }),
  apvTodo: (p) => ({ ok: true, data: { sign: [], handle: [], echo: p } })
};
const reads = (n) => ['staffList', 'clockAlerts', 'regionList', 'evMe', 'apvTodo'].slice(0, n);

// ============================================================
// 1. homeFastAllowed
// ============================================================
{
  const ss = new MemoryStorage();
  const loc = (o) => Object.assign({ hostname: 'dzy.mozhuting.com', port: '', search: '' }, o);
  ok(HOME_FAST === true, '1: config.js HOME_FAST 已對全公司開（2026-11-10）');
  ok(homeFastAllowed(loc(), ss) === true, '1: 正式網址、沒帶參數 → 照總開關 true');
  ok(homeFastAllowed(loc({ hostname: 'localhost', port: '8862' }), ss) === true, '1: localhost:8862 → true');
  ok(homeFastAllowed(loc({ hostname: '127.0.0.1', port: '8862' }), ss) === true, '1: 127.0.0.1:8862 → true');
  ok(homeFastAllowed(loc({ hostname: 'localhost', port: '8777' }), ss) === true, '1: localhost 其他埠 → 照總開關 true');
  ok(homeFastAllowed(loc({ hostname: 'evil.localhost.example.com', port: '8862' }), ss) === true, '1: 其他主機 → 照總開關 true');
  ok(ss.ops.length === 0 || ss.ops.every((o) => o[0] === 'get'), '1: 以上都沒寫 sessionStorage');
  ok(homeFastAllowed(loc({ search: '?homefast=1' }), ss) === true, '1: ?homefast=1 → true');
  ok(ss.getItem('dzy.homefast') === '1', '1: ?homefast=1 記進 sessionStorage');
  ok(homeFastAllowed(loc({ search: '' }), ss) === true, '1: 之後網址沒帶參數（換頁、登出重載）仍 true（讀 sessionStorage）');
  ok(homeFastAllowed(loc({ search: '?x=1&homefast=1' }), new MemoryStorage()) === true, '1: 參數不在第一個也認');
  ok(homeFastAllowed(loc({ search: '?homefast=0' }), ss) === false && ss.getItem('dzy.homefast') === '0', '1: ?homefast=0 → false 並記住這個分頁關');
  ok(homeFastAllowed(loc({ search: '' }), ss) === false, '1: 之後網址沒帶參數仍 false（這個分頁關掉了）');
  ok(homeFastAllowed(loc({ search: '?homefast=2' }), new MemoryStorage()) === true, '1: ?homefast=2（不認得）→ 照總開關 true');
  ok(homeFastAllowed(loc({ search: '?nothomefast=0' }), new MemoryStorage()) === true, '1: 名稱只是結尾相同 → 不當成關閉');
  const broken = { getItem() { throw new Error('locked'); }, setItem() { throw new Error('locked'); }, removeItem() { throw new Error('locked'); } };
  ok(homeFastAllowed(loc(), broken) === true, '1: sessionStorage 被鎖 → 照總開關，不拋例外');
  ok(homeFastAllowed(loc({ search: '?homefast=1' }), broken) === true, '1: sessionStorage 被鎖但網址帶 ?homefast=1 → 這次網址有效');
  ok(homeFastAllowed(null, null) === true, '1: 沒有 location（node）→ 照總開關');
}

// ============================================================
// 2. 開關關閉 = 與以前完全相同：不併、不碰 storage
// ============================================================
{
  await loginAs('u901', 'tok-A');
  __setHomeFast(false);
  const before = localStorage.ops.length;
  const calls = makeBackend(H);
  const rs = await Promise.all(reads(5).map((a) => call('platform', a, {})));
  ok(calls.length === 5 && calls.every((c) => c.body.action !== 'batchRead'), '2: 關閉：5 筆讀取 → 5 次獨立 fetch，沒有 batchRead', calls.map((c) => c.body.action));
  ok(rs[0].ok && rs[2].ok === false && rs[2].error === '沒有權限', '2: 關閉：回傳形狀照舊');
  await sleep(WAIT);
  ok(calls.length === 5, '2: 關閉：等過視窗也沒有多出請求');
  ok(calls.every((c) => c.body.token === 'tok-A' && c.body.payload && typeof c.body.payload === 'object' && Object.keys(c.body).sort().join() === 'action,payload,token'), '2: 關閉：請求形狀 {action,token,payload} 與以前一樣');
  ok(localStorage.ops.length === before + 0 || localStorage.ops.slice(before).every((o) => o[0] === 'get'), '2: 關閉：api 沒有寫 localStorage（只可能讀登入 token）', localStorage.ops.slice(before));
  ok(![...localStorage._map.keys()].some((k) => /home_badges|homefast/.test(k)), '2: 關閉：localStorage 沒有任何 home_badges／homefast');
  ok(globalThis.sessionStorage.ops.length === 0, '2: 關閉：完全沒有碰 sessionStorage', globalThis.sessionStorage.ops);
  arm(); await quietLogout();
}

// ============================================================
// 3. 開關開啟：同一輪讀取併成一次 batchRead
// ============================================================
{
  await loginAs('u901', 'tok-A');
  fastOn();
  let calls = makeBackend(H);
  const t0 = Date.now();
  const ps = reads(5).map((a) => call('platform', a, a === 'apvTodo' ? { k: 1 } : {}));
  await sleep(10);
  ok(calls.length === 0, '3: 視窗內還沒送出（等同一輪的都到齊）');
  const rs = await Promise.all(ps);
  ok(calls.length === 1 && calls[0].body.action === 'batchRead', '3: 5 筆併成 1 次 batchRead', calls.map((c) => c.body.action));
  ok(calls[0].body.token === 'tok-A' && calls[0].body.payload.items.map((i) => i.action).join() === reads(5).join(), '3: token 在外層、items 依序且 action 正確');
  ok(JSON.stringify(calls[0].body.payload.items[4]) === JSON.stringify({ action: 'apvTodo', payload: { k: 1 } }), '3: 每筆 payload 原樣帶上');
  ok(rs[0].ok && rs[0].data.staff[0].emp_no === 'DZY901' && rs[1].data.counts.a === 1 && rs[4].data.echo.k === 1, '3: 各自 resolve 到自己的結果');
  ok(rs[2].ok === false && rs[2].error === '沒有權限' && rs[2].data && rs[2].data.code === 'no_perm', '3: 沒權限那筆照單筆形狀回 {ok:false,error,data:{code}}，不影響別筆');
  ok(Date.now() - t0 < 1000, '3: 沒有拖很久');

  // 與單筆逐字同形：用同一組 handler，關掉開關再送一次單筆，結果相同
  __setHomeFast(false);
  makeBackend(H);
  const direct = await Promise.all(reads(5).map((a) => call('platform', a, a === 'apvTodo' ? { k: 1 } : {})));
  ok(JSON.stringify(direct) === JSON.stringify(rs), '3: 併請求的回傳與單筆回傳逐字相同');
  fastOn();

  // 同一輪完全相同的讀取只送一筆，各拿到一份副本
  calls = makeBackend(H);
  const [a1, a2, a3] = await Promise.all([call('platform', 'staffList', {}), call('platform', 'staffList', {}), call('platform', 'clockAlerts', {})]);
  ok(calls.length === 1 && calls[0].body.payload.items.length === 2, '3: 相同讀取去重：3 個呼叫只送 2 筆', calls[0] && calls[0].body.payload.items);
  ok(JSON.stringify(a1) === JSON.stringify(a2) && a1 !== a2 && a1.data !== a2.data && a3.ok, '3: 去重的兩個呼叫各拿一份獨立副本（改了一份不影響另一份）');
  a1.data.staff.push('x');
  ok(a2.data.staff.length === 1, '3: 改副本不影響另一份');
  // payload 不同不去重
  calls = makeBackend(H);
  await Promise.all([call('platform', 'apvTodo', { a: 1 }), call('platform', 'apvTodo', { a: 2 })]);
  ok(calls[0].body.payload.items.length === 2, '3: payload 不同 → 不去重');

  // 只有一筆 → 照原樣單筆送
  calls = makeBackend(H);
  const one = await call('platform', 'staffList', {});
  ok(calls.length === 1 && calls[0].body.action === 'staffList' && one.ok, '3: 視窗內只有一筆 → 單筆送出，不包 batchRead');

  // 連續兩輪（間隔超過視窗）→ 兩次
  calls = makeBackend(H);
  const p1 = Promise.all([call('platform', 'staffList', {}), call('platform', 'evMe', {})]);
  await sleep(WAIT);
  const p2 = Promise.all([call('platform', 'clockAlerts', {}), call('platform', 'apvTodo', {})]);
  await Promise.all([p1, p2]);
  ok(calls.length === 2 && calls.every((c) => c.body.action === 'batchRead'), '3: 隔了一個視窗的兩輪 → 各一次 batchRead');

  // 超過 20 個不同的讀取 → 切成兩批
  calls = makeBackend({ apvTodo: (p) => ({ ok: true, data: { n: p.i } }) });
  const many = await Promise.all(Array.from({ length: 25 }, (_, i) => call('platform', 'apvTodo', { i })));
  const sizes = calls.filter((c) => c.body.action === 'batchRead').map((c) => c.body.payload.items.length);
  ok(sizes.join() === '6,6,6,6' && calls.length === 5 && calls[4].body.action === 'apvTodo', '3: 25 筆 → 每批最多 6 筆（6,6,6,6，剩 1 筆單送）', sizes);
  ok(many.every((r, i) => r.ok && r.data.n === i), '3: 25 筆各自拿到對的結果');
  arm(); await quietLogout();
}

// ============================================================
// 4. 寫入、白名單外、代轉 ns 永遠不併
// ============================================================
{
  await loginAs('u901', 'tok-A');
  fastOn();
  const calls = makeBackend({ ...H, saveUser: () => ({ ok: true, data: { saved: 1 } }), listUsers: () => ({ ok: true, data: { users: [] } }), ssoTicket: () => ({ ok: true, data: { ticket: 't' } }), getAll: () => ({ ok: true }) });
  const ps = [call('platform', 'staffList', {}), call('platform', 'saveUser', { name: 'x' }), call('platform', 'evMe', {}), call('platform', 'listUsers', {}), call('platform', 'ssoTicket', {}), call('audit', 'getAll', {}), call('cashbook', 'adminList', {})];
  await Promise.all(ps);
  const acts = calls.map((c) => c.body.action);
  ok(acts.filter((a) => a === 'batchRead').length === 1, '4: 同一輪只有可併的兩筆進 batchRead', acts);
  const batchItems = calls.find((c) => c.body.action === 'batchRead').body.payload.items.map((i) => i.action);
  ok(batchItems.join() === 'staffList,evMe', '4: batchRead 裡只有 staffList、evMe', batchItems);
  ok(['saveUser', 'listUsers', 'ssoTicket'].every((a) => acts.includes(a)), '4: 寫入（saveUser）、白名單外讀取（listUsers）、ssoTicket 各自單筆送出');
  const proxyCalls = calls.filter((c) => c.body.ns);
  ok(proxyCalls.length === 2 && proxyCalls.every((c) => c.url.endsWith('/proxy')), '4: 代轉 ns（audit、cashbook）走原本的 proxy、不併', proxyCalls.map((c) => c.body.ns));
  ok(!calls.some((c) => c.body.action === 'batchRead' && c.body.payload.items.some((i) => !BATCH_READ_ACTIONS.includes(i.action))), '4: batchRead 裡沒有任何白名單外的 action');
  // 寫入不會被排隊等視窗：立刻送
  const t = Date.now();
  const c2 = makeBackend({ saveUser: () => ({ ok: true, data: {} }) });
  await call('platform', 'saveUser', {});
  ok(Date.now() - t < 60 && c2.length === 1, '4: 寫入立刻送出，不等併請求視窗');
  arm(); await quietLogout();
}

// ============================================================
// 5. 整批失敗 → 退回逐筆送；舊後端不用每次白繞
// ============================================================
for (const mode of ['throw', 'notok', 'badjson', 'short', 'status']) {
  await loginAs('u901', 'tok-A');
  fastOn();
  let calls = makeBackend(H, { fail: mode });
  const rs = await Promise.all(reads(3).map((a) => call('platform', a, {})));
  const acts = calls.map((c) => c.body.action);
  const okAll = rs[0].ok && rs[0].data.staff && rs[1].ok && rs[1].data.counts && rs[2].ok === false && rs[2].error === '沒有權限';
  ok(acts[0] === 'batchRead' && acts.slice(1).sort().join() === reads(3).sort().join() && okAll, '5: 整批失敗（' + mode + '）→ 逐筆退回，各自拿到正確結果', acts);
  // 冷卻：失敗後 5 分鐘內不再嘗試併
  calls = makeBackend(H);
  await Promise.all(reads(3).map((a) => call('platform', a, {})));
  if (mode === 'notok') ok(calls.length === 3 && calls.every((c) => c.body.action !== 'batchRead'), '5: 後端明說不支援（' + mode + '）之後暫停併請求，直接逐筆送');
  else ok(calls.length === 1 && calls[0].body.action === 'batchRead', '5: 暫時性錯誤（' + mode + '）不停併：下一輪照常 batchRead', calls.map((c) => c.body.action));
  arm(); await quietLogout();
}
{
  // 某一筆被後端說「不支援的操作」（前後端白名單差一點）→ 只有那一筆退回單筆送
  await loginAs('u901', 'tok-A');
  fastOn();
  const partial = { ...H }; delete partial.evMe;   // 後端 batch 不認得 evMe；單筆路徑認得
  const calls = (() => {
    const cs = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body); cs.push(body);
      if (body.action === 'batchRead') return { json: async () => ({ ok: true, data: { results: body.payload.items.map((it) => (partial[it.action] ? partial[it.action](it.payload) : { ok: false, error: '不支援的操作' })) } }) };
      return { json: async () => (H[body.action] ? H[body.action](body.payload) : { ok: false, error: 'x' }) };
    };
    return cs;
  })();
  const rs = await Promise.all([call('platform', 'staffList', {}), call('platform', 'evMe', {})]);
  ok(rs[0].ok && rs[1].ok && rs[1].data.evaluable === true && calls.map((c) => c.action).join() === 'batchRead,evMe', '5: 單筆被當白名單外 → 只那一筆退回單筆送', calls.map((c) => c.action));
  arm(); await quietLogout();
}

// ============================================================
// 5b. 只有首頁載入期間才併
// ============================================================
{
  await loginAs('u901', 'tok-A');
  __setHomeFast(true);   // 開關開，但沒有 beginHomeBatch（在模組內頁）
  let calls = makeBackend(H);
  const t0 = Date.now();
  await Promise.all(reads(3).map((a) => call('platform', a, {})));
  ok(calls.length === 3 && calls.every((c) => c.body.action !== 'batchRead') && Date.now() - t0 < 60, '5b: 沒在首頁載入期間：立刻逐筆送，不等 80ms、不併');
  const end = beginHomeBatch();
  calls = makeBackend(H);
  await Promise.all(reads(3).map((a) => call('platform', a, {})));
  ok(calls.length === 1 && calls[0].body.action === 'batchRead', '5b: 首頁載入期間：併');
  end(); end();
  calls = makeBackend(H);
  await Promise.all(reads(3).map((a) => call('platform', a, {})));
  ok(calls.length === 3, '5b: 首頁讀取結束（end 可重複呼叫）後又回到立刻送');
  arm(); await quietLogout();
}

// ============================================================
// 6. 換人不混身分：每個 token 各排各的
// ============================================================
{
  await loginAs('u901', 'tok-A');
  fastOn();
  const calls = makeBackend({ staffList: (p, tok) => ({ ok: true, data: { who: tok } }), evMe: (p, tok) => ({ ok: true, data: { who: tok } }) });
  const pa = [call('platform', 'staffList', {}), call('platform', 'evMe', {})];   // 以 A 排隊
  await quietLogout();
  await loginAs('u902', 'tok-B');                                                 // 視窗內換成 B
  const pb = [call('platform', 'staffList', {}), call('platform', 'evMe', {})];
  const [ra, rb] = [await Promise.all(pa), await Promise.all(pb)];
  ok(calls.length === 2 && calls.map((c) => c.body.token).sort().join() === 'tok-A,tok-B', '6: A、B 各一次 batchRead，token 各自帶自己的', calls.map((c) => c.body.token));
  ok(ra.every((r) => r.data.who === 'tok-A') && rb.every((r) => r.data.who === 'tok-B'), '6: A 排的請求用 A 的 token、B 的用 B 的（沒有被送出當下的身分蓋掉）');
  arm(); await quietLogout();
}

// ============================================================
// 7. 沒登入（沒有 token）不併；試跑模式照常
// ============================================================
{
  fastOn();
  await quietLogout();
  const calls = makeBackend(H);
  await Promise.all([call('platform', 'staffList', {}), call('platform', 'evMe', {})]);
  ok(calls.length === 2 && calls.every((c) => c.body.action !== 'batchRead'), '7: 沒有 token → 不併（照舊單筆送）');
  await loginAs('u901', 'tok-A');
  __setDryRun(true);
  const c2 = makeBackend({ ...H, saveUser: () => ({ ok: true }) });
  const [r1, r2, w] = await Promise.all([call('platform', 'staffList', {}), call('platform', 'evMe', {}), call('platform', 'saveUser', {})]);
  ok(c2.length === 1 && c2[0].body.action === 'batchRead' && r1.ok && r2.ok, '7: 試跑模式：讀取照併');
  ok(w.dryrun === true && !c2.some((c) => c.body.action === 'saveUser'), '7: 試跑模式：寫入照樣被攔，沒送出');
  __setDryRun(null);
  arm(); await quietLogout();
}

// ============================================================
// 8. 上次件數（home-cache）：只有數字、key 帶使用者 id、登出清除、換人不外洩
// ============================================================
{
  const st = new MemoryStorage();
  ok(homeBadgeKey('u901') === 'dzy.u.u901.home_badges' && homeBadgeKey('') === null && homeBadgeKey(null) === null, '8: key 格式 dzy.u.<user id>.home_badges；沒有 id 不存');
  const dirty = { staff: 3, approvals: 2, 'ai-help': 0, pnl: '請款單 王小明 12,000 元', eval: { text: '待考核 張三' }, cashbook: ['x'], bad: -1, nan: NaN, inf: Infinity, 'Has Space': 5, huge: 1e12, frac: 2.7 };
  ok(writeHomeBadges(st, 'u901', dirty, 1000) === true, '8: 寫入成功');
  const raw = st.getItem('dzy.u.u901.home_badges');
  const parsed = JSON.parse(raw);
  ok(JSON.stringify(Object.keys(parsed).sort()) === '["at","n","v"]', '8: 存的欄位只有 v、at、n');
  ok(Object.values(parsed.n).every((v) => typeof v === 'number'), '8: n 裡面每個值都是數字');
  ok(!/王小明|請款單|張三|待考核|12,000/.test(raw), '8: 提醒文字、姓名完全沒進 storage（字串值被丟掉）', raw);
  ok(parsed.n.staff === 3 && parsed.n.approvals === 2 && parsed.n['ai-help'] === 0 && parsed.n.frac === 2 && parsed.n.huge === 99999, '8: 數字照存（小數無條件捨去、上限 99999）', parsed.n);
  ok(!('pnl' in parsed.n) && !('eval' in parsed.n) && !('cashbook' in parsed.n) && !('bad' in parsed.n) && !('nan' in parsed.n) && !('inf' in parsed.n) && !('Has Space' in parsed.n), '8: 字串、物件、陣列、負數、NaN、Infinity、不合規的模組代號都被丟掉');
  ok(JSON.stringify(readHomeBadges(st, 'u901', 2000)) === JSON.stringify(parsed.n), '8: 讀回來同一份');
  ok(Object.keys(readHomeBadges(st, 'u902', 2000)).length === 0, '8: 換成別人（u902）讀不到 u901 的件數');
  ok(readHomeBadges(st, 'u901', 1000 + HOME_BADGE_MAX_AGE_MS + 1) && Object.keys(readHomeBadges(st, 'u901', 1000 + HOME_BADGE_MAX_AGE_MS + 1)).length === 0, '8: 超過 12 小時的件數不顯示');
  ok(Object.keys(readHomeBadges(st, 'u901', 1000 - 2 * 3600 * 1000)).length === 0, '8: 時間在未來太多（時鐘亂跳）不顯示');
  writeHomeBadges(st, 'u902', { staff: 9 }, 1000);
  ok(readHomeBadges(st, 'u902', 2000).staff === 9 && readHomeBadges(st, 'u901', 2000).staff === 3, '8: 兩個人各自一份，互不覆蓋');
  clearHomeBadges(st, 'u901');
  ok(st.getItem('dzy.u.u901.home_badges') === null && st.getItem('dzy.u.u902.home_badges') !== null, '8: 登出清除只清自己的，不動別人的');
  // 壞資料、被鎖的 storage 都不拋例外
  st.setItem('dzy.u.u903.home_badges', '{bad json');
  ok(Object.keys(readHomeBadges(st, 'u903')).length === 0, '8: 壞掉的 JSON → 空');
  st.setItem('dzy.u.u903.home_badges', JSON.stringify({ v: 2, at: Date.now(), n: { staff: 1 } }));
  ok(Object.keys(readHomeBadges(st, 'u903')).length === 0, '8: 版本不符 → 空');
  const locked = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  ok(readHomeBadges(locked, 'u1') && writeHomeBadges(locked, 'u1', { a: 1 }) === false && clearHomeBadges(locked, 'u1') === false, '8: storage 被鎖（私密瀏覽）→ 不拋例外');
  ok(writeHomeBadges(null, 'u1', { a: 1 }) === false && writeHomeBadges(st, '', { a: 1 }) === false, '8: 沒有 storage 或沒有使用者 id → 不寫');
  ok(JSON.stringify(sanitizeCounts(null)) === '{}' && JSON.stringify(sanitizeCounts([1, 2])) === '{}', '8: sanitizeCounts 對非物件回 {}');
}

ok(realCalls.length === 0, '9: 全程沒有任何真實網路請求（未被 mock 的 fetch）', realCalls);
console.log(`\n${passed} 項通過，${failed} 項失敗`);
process.exit(failed ? 1 : 0);
