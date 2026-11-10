// node test/batch-read.mock.test.mjs —— 首頁少等：後端 batchRead（2026-11-10）
// 做法同 perms-actions.mock.test.mjs：Auth／Users／Staff／Regions／Perms／PermActions／Code 讀進同一個 vm sandbox，全程走 doPost。
// 驗：每筆各自驗權限（沒權限的那筆回拒絕、不影響其他筆）、白名單外／寫入／巢狀 batchRead 被拒、上限 20、
//     回傳形狀與單筆逐字相同、白名單與前端 dryrun.js 一致、白名單內沒有 UrlFetchApp、不拿鎖。
// ⚠ 姓名、生日、手機、地址全是假資料（dzy 是 public repo）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'Perms.gs', 'PermActions.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

// ── GAS 假物件 ──────────────────────────────────────────────
function makeSheet(rows) {
  const data = (rows || []).map((r) => r.slice());
  const sheet = {
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(row, col, numRows, numCols) {
      numRows = numRows || 1; numCols = numCols || 1;
      const range = {
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const src = data[row - 1 + r] || [];
            const o = [];
            for (let c = 0; c < numCols; c++) { const v = src[col - 1 + c]; o.push(v === undefined ? '' : v); }
            out.push(o);
          }
          return out;
        },
        setValue(v) { range.setValues([[v]]); },
        setValues(vals) {
          if (vals.length !== numRows || vals.some((r) => r.length !== numCols)) throw new Error('setValues 尺寸不符');
          for (let r = 0; r < vals.length; r++) {
            const ri = row - 1 + r;
            while (data.length <= ri) data.push([]);
            for (let c = 0; c < vals[r].length; c++) {
              const ci = col - 1 + c;
              while (data[ri].length <= ci) data[ri].push('');
              data[ri][ci] = vals[r][c];
            }
          }
          return range;
        },
        setNumberFormat() { return range; }
      };
      return range;
    },
    appendRow(r) { data.push(r.slice()); },
    _rows: () => data.map((r) => r.slice()),
    _data: data
  };
  return sheet;
}
function bytes(v) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  return Buffer.from(v.map((b) => (b < 0 ? b + 256 : b) & 0xff));
}
function signed(buf) { return Array.from(buf, (b) => (b > 127 ? b - 256 : b)); }

function load(seed) {
  const sheets = {};
  Object.keys(seed).forEach((k) => { sheets[k] = makeSheet(seed[k]); });
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; }
  };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-for-perm-actions' };
  const counters = { locks: 0 };
  let uuid = 0;
  const sandbox = {
    console,
    SpreadsheetApp: { getActive: () => ss },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (_a, v) => signed(crypto.createHash('sha256').update(bytes(v)).digest()),
      computeHmacSha256Signature: (v, k) => signed(crypto.createHmac('sha256', bytes(k)).update(bytes(v)).digest()),
      base64Encode: (d) => bytes(d).toString('base64'),
      base64Decode: (s) => signed(Buffer.from(String(s), 'base64')),
      getUuid: () => 'fake-uuid-' + (++uuid)
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props[k] === undefined ? null : props[k]), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => { const e = cache.get(k); if (!e) return null; if (e.exp && Date.now() > e.exp) { cache.delete(k); return null; } return e.v; },
      put: (k, v, ttl) => cache.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null }),
      remove: (k) => cache.delete(k)
    }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { counters.locks++; return true; }, releaseLock() {} }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  return { sb: sandbox, sheets, cache, props, counters };
}
function post(sb, action, payload, token) {
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }).getContent());
}

const ADMIN_PW = 'fake-admin-pw-01';
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
function freshSeed() {
  const salt = 'salt-admin';
  return {
    users: [
      ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at'],
      ['u001', 'BOSS', '系統管理者', 'admin', '', salt, HASHER.hashPassword_(ADMIN_PW, salt), 'TRUE', '', ''],
      ['u002', 'acc1', '假會計', 'accountant', '', salt, HASHER.hashPassword_('fake-acc-pw-01', salt), 'TRUE', '', ''],
      ['u003', 'hr1', '系統人資', 'hrsys', '', salt, HASHER.hashPassword_('fake-hr-pw-01', salt), 'TRUE', '', '']
    ],
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['accountant', '會計', 'audit.read,audit.write'], ['hrsys', '系統人資', 'platform.staff'], ['staff', '員工', '']],
    module_secrets: [['backend_id', 'level', 'secret']],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  };
}
function fresh() {
  const app = load(freshSeed());
  app.sb.setupStaff();
  // 沒載入 StaffClock.gs：兼任欄表頭手動補
  app.sheets.staff.getRange(1, app.sb.STF_EXTRA_DEPTS_COL_NO).setValue('extra_depts');
  return app;
}
const adminTok = (sb) => post(sb, 'login', { username: 'BOSS', password: ADMIN_PW }).data.token;

let seq = 0;
function claim(sb, name, org, pw) {
  post(sb, 'staffImport', { names: [name] }, sb.__admin);
  const lk = post(sb, 'claimLookup', { name });
  seq++;
  const prof = Object.assign({ dept: '', birthday: '1990-01-0' + (1 + (seq % 8)), phone: '09' + String(20000000 + seq), address: '新竹市測試路' + seq + '號' }, org);
  const sub = post(sb, 'claimSubmit', Object.assign({ name, emp_no: lk.data.emp_no, password: pw || 'fake-staff-pw-1' }, prof));
  if (!sub.ok) throw new Error('claimSubmit 失敗 ' + sub.error);
  return lk.data.emp_no;
}
function mk(sb, name, org, pw) {
  const emp = claim(sb, name, org, pw);
  const cf = post(sb, 'staffConfirm', { emp_no: emp }, sb.__admin);
  if (!cf.ok) throw new Error('staffConfirm 失敗 ' + cf.error);
  const lg = post(sb, 'login', { username: emp, password: pw || 'fake-staff-pw-1' });
  if (!lg.ok) throw new Error('登入失敗 ' + lg.error);
  return { emp, token: lg.data.token };
}
const HQ = (dept, title) => ({ brand: 'dzy', unit: 'dzy-hq', dept, title });
const rowsOf = (sheets, n) => (sheets[n] ? sheets[n]._rows() : null);
const hasCols = (r, o) => Object.keys(o).every((k) => String(r[k]) === String(o[k]));
const dayShift = (sb, n) => { const t = new Date(Date.now() + 8 * 3600 * 1000 + n * 86400000); return t.toISOString().slice(0, 10); };

// 通用場景：admin、人資主管、人資同仁、店長、財務、資訊、計時、美村店長
function scene() {
  const app = fresh();
  const { sb } = app;
  sb.__admin = adminTok(sb);
  const P = {
    hrHm: mk(sb, '人資主管', HQ('hr', 'hm')),
    hrHs: mk(sb, '人資同仁', HQ('hr', 'hs')),
    sm: mk(sb, '店長一', { brand: 'mala', unit: 'mala-gf', title: 'sm' }),
    fin: mk(sb, '財務同仁', HQ('fin', 'hs')),
    it: mk(sb, '資訊同仁', HQ('it', 'hs')),
    pt: mk(sb, '計時同仁', { brand: 'mala', unit: 'mala-gf', title: 'pt' }),
    smY: mk(sb, '一悟店長', { brand: 'yiwu', unit: 'yiwu-js', title: 'sm' }),
    ceo: mk(sb, '執行長', HQ('mgmt', 'ceo'))
  };
  return Object.assign(app, { P });
}

const init = (app) => post(app.sb, 'permInit', {}, app.sb.__admin);
const on = (app) => { app.props.PERMS_ON = '1'; };

// ── 記下 console.error（一筆拋例外會寫 console.error，測試要安靜）──
const CODE = fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const batch = (sb, items, token) => post(sb, 'batchRead', { items }, token);
const single = (sb, action, payload, token) => post(sb, action, payload || {}, token);

import { BATCH_READ_ACTIONS, READ_ACTIONS } from '../platform/dryrun.js';

// ============================================================
// 1. 白名單：與前端一致、都是純讀取、不碰 UrlFetchApp
// ============================================================
{
  const m = /var CODE_BATCH_READ_ACTIONS = \[([^\]]*)\]/.exec(CODE);
  const backend = m ? [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]) : [];
  ok(backend.length > 0 && JSON.stringify(backend) === JSON.stringify(BATCH_READ_ACTIONS), '1: 後端 CODE_BATCH_READ_ACTIONS 與前端 dryrun.js BATCH_READ_ACTIONS 逐字相同（含順序）', [backend, BATCH_READ_ACTIONS]);
  ok(READ_ACTIONS.platform.includes('batchRead'), '1: batchRead 列在 dryrun.js READ_ACTIONS.platform');
  ok(BATCH_READ_ACTIONS.every((a) => READ_ACTIONS.platform.includes(a)), '1: 白名單每一項都在 dryrun READ_ACTIONS.platform（純讀取）', BATCH_READ_ACTIONS.filter((a) => !READ_ACTIONS.platform.includes(a)));
  ok(!BATCH_READ_ACTIONS.includes('batchRead'), '1: 白名單不含 batchRead 自己（不能巢狀）');
  ok(new Set(BATCH_READ_ACTIONS).size === BATCH_READ_ACTIONS.length, '1: 白名單沒有重複');
  const allowed = /var CODE_ALLOWED_ACTIONS = \[([\s\S]*?)\];/.exec(CODE)[1];
  const allowedList = [...allowed.matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]);
  ok(allowedList.includes('batchRead'), '1: batchRead 在 CODE_ALLOWED_ACTIONS');
  const mut = /var MUTATING_ACTIONS = \{([\s\S]*?)\};/.exec(CODE)[1];
  const mutList = [...mut.matchAll(/([A-Za-z0-9_]+):\s*1/g)].map((x) => x[1]);
  ok(mutList.length > 50 && !mutList.includes('batchRead'), '1: batchRead 不在 MUTATING_ACTIONS（不拿全域鎖）');
  ok(BATCH_READ_ACTIONS.every((a) => allowedList.includes(a) && new RegExp("case '" + a + "':").test(CODE)), '1: 白名單每一項都在分派表且有 case');
  ok(BATCH_READ_ACTIONS.every((a) => !mutList.includes(a)), '1: 白名單沒有任何一項在 MUTATING_ACTIONS（不是寫入）', BATCH_READ_ACTIONS.filter((a) => mutList.includes(a)));
  const banned = /Save|Submit|Approve|Reject|Decide|Create|Import|Revoke|Void|Setup|Init|Add|Delete|Update|Reset|Link|Redeem|ssoTicket|login|logout|change|svc/i;
  ok(BATCH_READ_ACTIONS.every((a) => !banned.test(a)), '1: 白名單沒有寫入／登入／入場券／機器用的動詞或名稱', BATCH_READ_ACTIONS.filter((a) => banned.test(a)));

  // 全部 .gs：不准有 UrlFetchApp 的呼叫（註解不算）；白名單 handler 的呼叫鏈（名稱層級，寧可多抓）也不能碰到
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.gs')).map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);
  const bad = files.filter(([, t]) => /UrlFetchApp/.test(stripComments(t))).map(([f]) => f);
  ok(bad.length === 0, '1: apps-script/platform 底下沒有任何 .gs 呼叫 UrlFetchApp', bad);
  const fns = Object.create(null);
  for (const [, t] of files) {
    const idx = [...t.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((x) => [x[1], x.index]);
    idx.forEach(([n, i], k) => { fns[n] = stripComments(t.slice(i, k + 1 < idx.length ? idx[k + 1][1] : t.length)); });
  }
  const handlerOf = (a) => { const m2 = new RegExp("case '" + a + "':\\s*return (\\w+)\\(").exec(CODE); return m2 && m2[1]; };
  const touching = [];
  for (const a of BATCH_READ_ACTIONS) {
    const root = handlerOf(a);
    if (!root || !fns[root]) { touching.push(a + ':找不到 handler'); continue; }
    const seen = new Set(); const q = [root];
    while (q.length) {
      const n = q.pop();
      if (seen.has(n) || !fns[n]) continue;
      seen.add(n);
      for (const mm of fns[n].matchAll(/[A-Za-z0-9_$]+(?=\s*\()/g)) q.push(mm[0]);
    }
    if ([...seen].some((n) => /UrlFetchApp/.test(fns[n]))) touching.push(a);
  }
  ok(touching.length === 0, '1: 白名單每個 handler 的呼叫鏈都沒碰到 UrlFetchApp', touching);
}

// ============================================================
// 2. 每筆各自驗權限；回傳形狀與單筆逐字相同
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, P } = app;
  const errs = [];
  sb.console = { log() {}, error: (...a) => errs.push(a.join(' ')) };
  const A = sb.__admin;
  const locks0 = app.counters.locks;

  // 人資主管：permMapGet／permStoreGet 可以，permAuditList 只有 admin → 同一批裡只有那一筆被拒
  const items = [{ action: 'permMapGet' }, { action: 'permAuditList', payload: {} }, { action: 'permStoreGet', payload: {} }];
  const r = batch(sb, items, P.hrHm.token);
  ok(r.ok === true && Array.isArray(r.data.results) && r.data.results.length === 3, '2: 回 {ok:true,data:{results:[3 筆]}}', r);
  ok(r.data.results[0].ok === true && r.data.results[2].ok === true, '2: 有權限的兩筆照常回資料（沒被那筆拒絕拖累）');
  ok(r.data.results[1].ok === false && r.data.results[1].code === 'no_perm', '2: 沒權限的那筆回拒絕（no_perm）', r.data.results[1]);
  const direct = items.map((it) => single(sb, it.action, it.payload, P.hrHm.token));
  ok(JSON.stringify(r.data.results) === JSON.stringify(direct), '2: 每一筆的內容與單筆呼叫逐字相同（形狀一致）');

  // 店長：permMapGet 也被拒；admin 全過
  const r2 = batch(sb, items, P.sm.token);
  ok(r2.data.results.every((x) => x.ok === false && x.code === 'no_perm'), '2: 店長三筆都 no_perm', r2.data.results);
  const r3 = batch(sb, items, A);
  ok(r3.data.results.every((x) => x.ok === true), '2: admin 三筆都成功');
  // 同一種 action 重複放兩次、順序保留
  const r4 = batch(sb, [{ action: 'permStoreGet' }, { action: 'permMapGet' }, { action: 'permStoreGet' }], A);
  ok(r4.data.results.length === 3 && JSON.stringify(r4.data.results[0]) === JSON.stringify(r4.data.results[2]) && r4.data.results[1].data.rules, '2: 結果與 items 一對一同序');

  // 沒 token／亂 token：整批外層 ok，但每一筆都被各自 handler 拒絕
  for (const tk of ['', undefined, 'garbage-token']) {
    const x = batch(sb, items, tk);
    ok(x.ok === true && x.data.results.every((y) => y.ok === false), '2: token=' + JSON.stringify(tk) + '：每筆都被拒絕，不洩漏資料', x);
  }
  ok(app.counters.locks === locks0, '2: batchRead 沒有拿 LockService（純讀取）');
  ok(errs.length === 0, '2: 前面這些都沒有拋例外', errs);
}

// ============================================================
// 3. 白名單外／寫入／巢狀 batchRead／格式錯：只有那一筆回錯
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, sheets, P } = app;
  const A = sb.__admin;
  const snap = () => JSON.stringify(['users', 'staff', 'perm_map', 'perm_ex', 'staff_log'].map((n) => (sheets[n] ? sheets[n]._rows() : null)));
  const before = snap();
  const bad = [
    { action: 'saveUser', payload: { username: 'zz', name: '駭', role: 'admin', password: 'fake-pass-1234' } },   // 寫入
    { action: 'permMapSave', payload: { add: [{ ladder: 'store', dept: '', title: 'sm', perm: 'dorm.read' }] } },   // 寫入
    { action: 'staffAdd', payload: { name: '假人' } },
    { action: 'resetPassword', payload: { id: 'u002', password: 'fake-pass-5678' } },
    { action: 'listUsers' },            // 讀取但不在白名單
    { action: 'login', payload: { username: 'BOSS', password: ADMIN_PW } },
    { action: 'ssoTicket', payload: { aud: 'bulletin' } },
    { action: 'batchRead', payload: { items: [{ action: 'permMapGet' }] } },   // 巢狀
    { action: 'nope' },
    { action: 'proxyAuthorize_' },
    { action: 'staffImport', payload: { names: ['x'], preview: true } }
  ];
  const r = batch(sb, [{ action: 'permMapGet' }].concat(bad, [{ action: 'permStoreGet' }]), A);
  ok(r.ok === true && r.data.results.length === bad.length + 2, '3: 外層 ok、筆數對', r.ok);
  ok(r.data.results[0].ok === true && r.data.results[r.data.results.length - 1].ok === true, '3: 前後兩筆合法的照常成功（壞的不影響好的）');
  const mids = r.data.results.slice(1, -1);
  ok(mids.every((x) => x.ok === false && x.error === '不支援的操作' && !x.data), '3: 白名單外／寫入／登入／入場券／巢狀 batchRead／未知 action 逐筆回「不支援的操作」', mids);
  ok(snap() === before, '3: 用 admin token 送寫入也完全沒動到任何分頁（users／staff／perm_*／staff_log 逐列相同）');
  // 格式錯
  const f = batch(sb, [null, 'permMapGet', 5, [], {}, { action: '' }, { action: 123 }, { action: 'permMapGet', payload: 'x' }, { action: 'permMapGet', payload: [1] }], A);
  ok(f.ok === true && f.data.results.slice(0, 7).every((x) => x.ok === false && x.error === '請求格式錯誤'), '3: 格式錯的項目逐筆回「請求格式錯誤」', f.data.results);
  ok(f.data.results[7].ok === true && f.data.results[8].ok === true, '3: payload 不是物件／是陣列 → 當 {} 照常執行（同單筆）');
  // 整批結構錯
  for (const [label, p] of [['沒有 items', {}], ['items 不是陣列', { items: 'x' }], ['items 是物件', { items: { a: 1 } }], ['空陣列', { items: [] }]]) {
    const x = post(sb, 'batchRead', p, A);
    ok(x.ok === false && x.error === '請求格式錯誤', '3: ' + label + ' → 整批回請求格式錯誤', x);
  }
  // 上限 20
  const mk = (n) => Array.from({ length: n }, () => ({ action: 'permStoreGet' }));
  const x20 = batch(sb, mk(20), A);
  ok(x20.ok === true && x20.data.results.length === 20 && x20.data.results.every((y) => y.ok), '3: 剛好 20 筆可以');
  const x21 = batch(sb, mk(21), A);
  ok(x21.ok === false && /20/.test(x21.error) && !x21.data, '3: 21 筆整批拒絕', x21);
  const x200 = batch(sb, mk(200), A);
  ok(x200.ok === false, '3: 200 筆整批拒絕');
  // 試跑／讀取分類不影響：batchRead 本身不是寫入（不被 MUTATING 鎖）
  ok(snap() === before, '3: 全部跑完分頁仍逐列相同');
}

// ============================================================
// 4. 一筆拋例外只讓那一筆回通用錯誤（sandbox 沒載入 Eval.gs → evMe 是 ReferenceError）
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, P } = app;
  const errs = [];
  sb.console = { log() {}, error: (...a) => errs.push(a.join(' ')) };
  const r = batch(sb, [{ action: 'permStoreGet' }, { action: 'evMe' }, { action: 'permMapGet' }], sb.__admin);
  ok(r.ok === true && r.data.results[0].ok === true && r.data.results[2].ok === true, '4: 拋例外那筆前後的兩筆照常成功', r);
  ok(r.data.results[1].ok === false && r.data.results[1].error === '系統忙碌中，請稍後再試' && !/Eval|ReferenceError|evMe/.test(JSON.stringify(r.data.results[1])), '4: 例外那筆只回通用錯誤訊息（不洩漏函式名）', r.data.results[1]);
  ok(errs.length === 1, '4: 例外只寫伺服器端 console.error 一次', errs);
}

console.log(`\n${passed} 項通過，${failed} 項失敗`);
process.exit(failed ? 1 : 0);
