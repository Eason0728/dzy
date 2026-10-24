// node test/purchase-sso.mock.test.mjs —— 貨單核對（財務部門）↔ 管理系統（PurchaseSso.gs）驗收
// 規格：docs/purchase-fin/spec.md §2。做法同 storeops.mock.test.mjs：後端 .gs 讀進同一個 vm sandbox，對外 action 全程走 doPost。
// ⚠ 所有姓名、編號、金鑰都是假資料（dzy 是 public repo）。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'StaffClock.gs', 'Perms.gs', 'PermActions.gs', 'StoreOps.gs', 'PurchaseSso.gs', 'Code.gs']
  .map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}
const J = (v) => JSON.stringify(v);
const eq = (a, b) => J(a) === J(b);
const keysOf = (o) => Object.keys(o);

// ── GAS 假物件 ───────────────────────────────────────────────
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
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; } };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-for-purchase-tests' };
  const hooks = { onGet: null, lockCalls: 0 };
  const lockState = { held: false };
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
      getUuid: () => 'fake-uuid-' + (++uuid) + '-' + crypto.randomBytes(4).toString('hex')
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => {
        const e = cache.get(k);
        let v = null;
        if (e && !(e.exp && Date.now() > e.exp)) v = e.v;
        if (hooks.onGet) { const h = hooks.onGet; hooks.onGet = null; h(k); }   // 模擬「另一個請求在這個請求 get 與 remove 之間插進來」
        return v;
      },
      put: (k, v, ttl) => cache.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null }),
      remove: (k) => cache.delete(k)
    }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    // 全域鎖假物件：已被持有時 tryLock 回 false（等同等不到鎖）
    LockService: { getScriptLock: () => ({
      tryLock: () => { hooks.lockCalls++; if (lockState.held) return false; lockState.held = true; return true; },
      releaseLock() { lockState.held = false; }
    }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  return { sb: sandbox, sheets, cache, props, hooks, lockState };
}
function post(sb, action, payload, token) {
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }).getContent());
}

// ── 假資料 ───────────────────────────────────────────────────
const PW = 'fake-purchase-pw-01';
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
const SALT = 'salt-purchase';
const SVC = 'fake-purchase-svc-key-0001';
const USERS_HEAD = ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at', 'token_after'];
// [emp, 姓名, unit, dept, title, status]
const CAST = [
  ['DZY022', '財務主管', 'dzy-hq', 'fin', 'hm', 'active'],
  ['DZY023', '財務同仁甲', 'dzy-hq', 'fin', 'hs', 'active'],
  ['DZY024', '財務同仁乙', 'dzy-hq', 'fin', 'hs', 'active'],
  ['DZY001', '門市店長', 'mzt-gf', '', 'sm', 'active'],
  ['DZY030', '已離職會計', 'dzy-hq', 'fin', 'hs', 'disabled'],
  ['DZY031', '待審同仁', 'dzy-hq', 'fin', 'hs', 'pending']
];
function staffRow(p, idx) {
  const row = new Array(27).fill('');
  row[0] = p[0]; row[1] = p[5] === 'pending' ? '' : 'u' + p[0].slice(3); row[2] = p[1]; row[3] = p[5];
  row[4] = p[2].startsWith('mzt') ? 'mzt' : 'dzy';
  row[5] = p[2]; row[6] = p[3]; row[7] = p[4];
  row[19] = '2026-02-0' + ((idx % 8) + 1) + ' 10:00:00';
  row[24] = '2026-01-05';
  return row;
}
function world() {
  const users = [USERS_HEAD, ['a001', 'BOSS', '系統管理者', 'admin', '', SALT, HASHER.hashPassword_(PW, SALT), 'TRUE', '', '', '']]
    .concat(CAST.filter((p) => p[5] !== 'pending').map((p) => ['u' + p[0].slice(3), p[0], p[1], 'staff', '', SALT, HASHER.hashPassword_(PW, SALT), p[5] === 'disabled' ? 'FALSE' : 'TRUE', '', '', '']));
  users.push(['u900', 'HRUSER', '人資帳號', 'hr', '', SALT, HASHER.hashPassword_(PW, SALT), 'TRUE', '', '', '']);
  const app = load({
    users,
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['staff', '員工', ''], ['hr', '人資', 'platform.staff,platform.self']],
    module_secrets: [['backend_id', 'level', 'secret']],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  });
  app.sb.setupStaff();
  CAST.forEach((p, i) => app.sheets.staff._data.push(staffRow(p, i)));
  app.props.PURCHASE_SVC_KEY = SVC;
  app.props.PERMS_ON = '1';
  app.login = (u) => { const r = post(app.sb, 'login', { username: u, password: PW }); return r.ok ? r.data.token : ''; };
  app.adminTok = app.login('BOSS');
  post(app.sb, 'permInit', {}, app.adminTok);
  app.grant = (emp, mode) => post(app.sb, 'permExSave', { emp_no: emp, perm: 'platform.purchase', mode: mode || 'add', until: '', note: '測試' }, app.adminTok);
  app.who = (sub, key) => post(app.sb, 'svcPurchaseWho', { svc_key: key === undefined ? SVC : key, sub });
  app.red = (p) => post(app.sb, 'svcPurchaseRedeem', Object.assign({ svc_key: SVC, aud: 'purchase' }, p));
  app.ticket = (tok) => post(app.sb, 'ssoTicket', { aud: 'purchase' }, tok);
  return app;
}

// ============================================================
// 1. 權限碼：可給、鎖碼、中文名
// ============================================================
(() => {
  const { sb } = world();
  ok(sb.PERM_GRANTABLE.indexOf('platform.purchase') !== -1 && sb.PERM_LOCKED.indexOf('platform.purchase') === -1, '1 platform.purchase 可給、不是鎖碼（Eason 2026-10-24：財務部門自動有）');
  ok(sb.PERM_DEFAULT_RULES.some((r) => r.join() === 'hq,fin,*,platform.purchase'), '1 預設規則：總部財務部門全部職稱有 platform.purchase');
  ok(sb.permName_('platform.purchase') === '貨單核對', '1 中文名＝貨單核對');
  ok(['svcPurchaseRedeem', 'svcPurchaseWho'].every((a) => sb.CODE_ALLOWED_ACTIONS.indexOf(a) !== -1), '1 兩支服務 action 在分派白名單');
  const mut = /MUTATING_ACTIONS = \{([\s\S]*?)\};/.exec(SRC.find(([f]) => f === 'Code.gs')[1])[1];
  ok(!/svcPurchase/.test(mut), '1 svcPurchase* 不在 MUTATING_ACTIONS（兌換自己用 LockService）');
})();

// ============================================================
// 2. 發券：只有有 platform.purchase 的人
// ============================================================
(() => {
  const app = world();
  ok(app.ticket(app.login('DZY022')).ok, '2 財務部門主管自動拿得到券');
  const sm = app.login('DZY001');
  ok(app.ticket(sm).code === 'no_perm', '2 ★財務部門以外（門市店長）→ no_perm');
  const g = app.grant('DZY001');
  ok(g.ok && app.ticket(app.login('DZY001')).ok, '2 admin 個別例外加人 → 財務部門以外也拿得到券', g);
  const tk = app.ticket(app.login('DZY023'));
  ok(tk.ok && /^[0-9a-f]{64}$/.test(tk.data.ticket) && tk.data.expires_in === 60, '2 被開的人拿到券（64 hex、60 秒）', tk);
  const rec = JSON.parse(app.cache.get('sso_tkt:' + tk.data.ticket).v);
  ok(rec.sub === 'DZY023' && rec.aud === 'purchase' && Object.keys(rec).length === 2, '2 券只存 sub 與 aud', rec);
  const ta = app.ticket(app.adminTok);
  ok(ta.ok && JSON.parse(app.cache.get('sso_tkt:' + ta.data.ticket).v).sub === 'U:a001', '2 admin（*）→ sub＝U:users.id', ta);
  ok(app.ticket(app.login('HRUSER')).code === 'no_perm', '2 人資系統帳號沒有 platform.purchase → no_perm');
  ok(app.ticket('').ok === false, '2 沒登入 → 拒絕');
  // 人資主管（非 admin）不能開鎖碼
  const hr = post(app.sb, 'permExSave', { emp_no: 'DZY024', perm: 'platform.purchase', mode: 'add', until: '', note: '試' }, app.login('HRUSER'));
  ok(!hr.ok, '2 ★人資系統帳號不能設 platform.purchase 的個別例外', hr);
})();

// ============================================================
// 3. 兌換與重查
// ============================================================
(() => {
  const app = world();
  const tok = app.login('DZY023');
  const t1 = app.ticket(tok).data.ticket;
  const r1 = app.red({ ticket: t1 });
  ok(r1.ok && eq(r1.data, { sub: 'DZY023', active: true, allowed: true, name: '財務同仁甲', emp_no: 'DZY023', token_after: 0 }), '3 兌換成功：身分逐欄', r1);
  ok(app.red({ ticket: t1 }).code === 'ticket_invalid', '3 ★同一張券第二次 → ticket_invalid');
  const t2 = app.ticket(tok).data.ticket;
  ok(app.red({ ticket: t2, svc_key: 'wrong' }).code === 'unauthorized' && app.cache.has('sso_tkt:' + t2), '3 ★錯金鑰 → unauthorized，券沒被用掉');
  ok(app.red({ ticket: t2, aud: 'store' }).code === 'bad_aud', '3 ★兌換時 aud 不是 purchase → bad_aud');
  // 門市營運的券不能拿來開貨單
  app.props.STORE_SVC_KEY = 'fake-store-key-0001';
  app.props.STORE_SSO_UNITS = 'mzt-gf';
  const ts = post(app.sb, 'ssoTicket', { aud: 'store' }, app.login('DZY001'));
  ok(ts.ok && app.red({ ticket: ts.data.ticket }).code === 'ticket_invalid', '3 ★門市營運的券拿來兌換貨單 → ticket_invalid', ts);
  ok(post(app.sb, 'svcStoreRedeem', { svc_key: 'fake-store-key-0001', ticket: t2, aud: 'store' }).code === 'ticket_invalid', '3 ★貨單的券拿去門市營運兌換 → ticket_invalid');
  const t3 = app.ticket(tok).data.ticket;
  app.cache.get('sso_tkt:' + t3).exp = Date.now() - 1;
  ok(app.red({ ticket: t3 }).code === 'ticket_invalid', '3 ★過期券 → ticket_invalid');
  ok(app.red({ ticket: 'abc' }).code === 'ticket_invalid', '3 券格式錯 → ticket_invalid');
  // 並發
  const t4 = app.ticket(tok).data.ticket;
  let inner = null;
  app.hooks.onGet = () => { inner = app.red({ ticket: t4 }); };
  const outer = app.red({ ticket: t4 });
  ok([outer, inner].filter((x) => x && x.ok).length === 1 && app.lockState.held === false, '3 ★並發兌換同一張券：恰一次成功、鎖已釋放', { outer, inner });
  delete app.props.PURCHASE_SVC_KEY;
  ok(app.red({ ticket: app.ticket(tok).data.ticket, svc_key: SVC }).code === 'unauthorized' && app.who('DZY023').code === 'unauthorized', '3 ★PURCHASE_SVC_KEY 沒設 → 兩支都 unauthorized');
  app.props.PURCHASE_SVC_KEY = SVC;

  // Who
  ok(app.who('DZY023').ok && app.who('DZY023').data.allowed === true, '3 Who：有權限 → allowed true');
  ok(app.who('DZY001').data.allowed === false && app.who('DZY001').data.active === true, '3 Who：在職沒權限（門市店長）→ active true、allowed false');
  ok(eq(app.who('DZY030').data, { sub: 'DZY030', active: false }), '3 Who：離職（disabled）→ inactive');
  ok(eq(app.who('DZY031').data, { sub: 'DZY031', active: false }), '3 Who：pending → inactive');
  ok(eq(app.who('DZY999').data, { sub: 'DZY999', active: false }) && eq(app.who('U:nobody').data, { sub: 'U:nobody', active: false }), '3 Who：查無 → inactive');
  ok(eq(app.who('U:u023').data, { sub: 'U:u023', active: false }), '3 ★同仁的帳號不能用 U:id 冒充（一律用 DZY 編號）');
  ok(app.who('U:a001').data.allowed === true && app.who('U:a001').data.emp_no === '', '3 Who：admin（U:id）allowed、沒有同仁編號');
  ok(app.who('dzy023').code === 'bad_input' && app.who(5).code === 'bad_input', '3 Who：sub 格式錯 → bad_input');
  ok(app.who('DZY023', 'wrong').code === 'unauthorized', '3 ★Who 錯金鑰 → unauthorized');
  // 個別例外拿掉 → allowed false
  app.grant('DZY001');
  ok(app.who('DZY001').data.allowed === true, '3 個別例外加上 → allowed true');
  app.grant('DZY001', 'remove');
  ok(app.who('DZY001').data.allowed === false, '3 ★Eason 拿掉個別例外 → 下一次重查 allowed false');
  // 登出全部裝置 → token_after 變大
  post(app.sb, 'logout', {}, app.login('DZY023'));
  ok(app.who('DZY023').data.token_after > 0, '3 登出全部裝置 → token_after 變大（貨單後端據此作廢）');
  // 停用登入帳號 → inactive
  app.sheets.users._data.find((r) => r[0] === 'u023')[7] = 'FALSE';
  ok(eq(app.who('DZY023').data, { sub: 'DZY023', active: false }), '3 ★登入帳號被停用 → inactive');
})();

// ============================================================
// 4. 原始碼守則
// ============================================================
(() => {
  const src = SRC.find(([f]) => f === 'PurchaseSso.gs')[1];
  ok(!/https?:\/\/|[A-Za-z0-9_-]{30,}/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), '4 PurchaseSso.gs 沒有網址或疑似金鑰字串');
  const dry = fs.readFileSync(path.join(__dirname, '..', 'platform', 'dryrun.js'), 'utf8');
  ok(!/svcPurchase/.test(dry), '4 svcPurchase* 不在前端 dryrun 清單');
  console.log('\n' + (failed ? '失敗' : '通過') + ' ' + passed + '／' + (passed + failed));
  if (failed) process.exit(1);
})();
