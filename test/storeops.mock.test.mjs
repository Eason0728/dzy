// node test/storeops.mock.test.mjs —— 門市營運系統 ↔ 管理系統（StoreOps.gs）驗收
// 規格：mala-store-ops-approver docs/approver/spec.md §10、§12、§13；task B7–B9。
// 契約唯一正本：test/fixtures/dzy-store-contract-v2.json（本檔逐欄比對）。
// 做法同 staff-clock.mock.test.mjs：把後端 .gs 讀進同一個 vm sandbox，對外 action 全程走 doPost；純函式直接呼叫。
// ⚠ 所有姓名、編號、金鑰都是假資料（dzy 是 public repo，不得出現真實同仁資料）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'StaffClock.gs', 'Perms.gs', 'PermActions.gs', 'StoreOps.gs', 'Code.gs']
  .map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dzy-store-contract-v2.json'), 'utf8'));

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
  const props = { HMAC_SECRET: 'fake-hmac-for-storeops-tests' };
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
const PW = 'fake-storeops-pw-01';
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
const SALT = 'salt-storeops';
const SVC = 'fake-store-svc-key-0001';
const USERS_HEAD = ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at', 'token_after'];

// 人：[emp, 姓名, unit, dept, title, status, hire, 打卡店, 打卡編號]
const CLK = { 'mzt-lzl': 'mztlzl', '': 'gf', 'mzt-wx': 'gf', 'mzt-gf': 'mztgf', 'mzt-js': 'mztjs', 'mala-gf': 'gf', ck: 'cf', 'mzt-hq': 'hq', 'mala-hq': 'hq', 'dzy-hq': 'hq' };
const BIG = [
  ['DZY001', '店長一', 'mzt-gf', '', 'sm', 'active', '2026-01-05'],
  ['DZY002', '陳小明', 'mzt-gf', '', 'ft', 'active', '2026-02-01'],
  ['DZY003', '李計時', 'mzt-gf', '', 'pt', 'active', '2026-02-02'],
  ['DZY004', '店長二', 'mzt-js', '', 'sm', 'active', '2026-01-06'],
  ['DZY005', '別店計時', 'mzt-js', '', 'pt', 'active', '2026-02-03'],
  ['DZY006', '央廚廠長', 'ck', '', 'fm', 'active', '2026-01-07'],   // 2026-10-20 起央廚不設店長，廠長＝店長同等
  ['DZY007', '央廚計時', 'ck', '', 'pt', 'active', '2026-02-04'],
  ['DZY008', '同店另一店長', 'mzt-gf', '', 'sm', 'active', '2026-01-08'],
  ['DZY010', '墨竹亭總監', 'mzt-hq', '', 'odir', 'active', '2026-01-09'],
  ['DZY011', '墨竹亭區經理', 'mzt-hq', '', 'oam', 'active', '2026-01-10'],   // 品牌辦公室區經理 oam 2026-10-20 停用（舊資料）
  ['DZY012', '墨竹亭督導', 'mzt-hq', '', 'osv', 'active', '2026-01-11'],
  ['DZY013', '墨竹亭行政', 'mzt-hq', '', 'ofs', 'active', '2026-01-12'],
  ['DZY014', '小辛辣總監', 'mala-hq', '', 'odir', 'active', '2026-01-13'],
  ['DZY015', '小辛辣行政', 'mala-hq', '', 'ofs', 'active', '2026-01-14'],
  ['DZY020', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-15'],
  ['DZY021', '人資同仁', 'dzy-hq', 'hr', 'hs', 'active', '2026-01-16'],
  ['DZY022', '財務主管', 'dzy-hq', 'fin', 'hm', 'active', '2026-01-17'],
  ['DZY023', '財務同仁', 'dzy-hq', 'fin', 'hs', 'active', '2026-01-18'],
  ['DZY024', '管理部同仁', 'dzy-hq', 'mgmt', 'hs', 'active', '2026-01-19'],
  ['DZY025', '執行長', 'dzy-hq', 'mgmt', 'ceo', 'active', '2026-01-20'],
  ['DZY026', '總經理', 'dzy-hq', 'mgmt', 'gm', 'active', '2026-01-21'],
  ['DZY027', '董事長', 'dzy-hq', 'mgmt', 'chair', 'active', '2026-01-22'],
  ['DZY030', '已離職店長', 'mzt-gf', '', 'sm', 'disabled', '2026-01-23'],
  ['DZY031', '待審計時', 'mzt-gf', '', 'pt', 'pending', ''],
  ['DZY040', '額外核定人', 'mala-gf', '', 'ft', 'active', '2026-03-01'],
  ['DZY041', '小辛辣計時', 'mala-gf', '', 'pt', 'active', '2026-03-02'],
  ['DZY042', '小辛辣店長', 'mala-gf', '', 'sm', 'active', '2026-03-03']
];
const PERMS_ALL_PILOT = 'ck,dzy-hq,mala-gf,mala-hq,mzt-gf,mzt-hq,mzt-js';

function staffRow(p, idx) {
  const row = new Array(27).fill('');
  row[0] = p[0]; row[1] = p[5] === 'pending' ? '' : 'u' + p[0].slice(3); row[2] = p[1]; row[3] = p[5];
  row[4] = p[2].startsWith('mzt') ? 'mzt' : p[2].startsWith('mala') ? 'mala' : p[2] === 'ck' ? 'ck' : 'dzy';
  row[5] = p[2]; row[6] = p[3]; row[7] = p[4];
  row[19] = '2026-02-0' + ((idx % 8) + 1) + ' 10:00:00';   // confirmed_at
  row[24] = p[6];                                            // hire_date
  return row;
}
function userRow(p) {
  return ['u' + p[0].slice(3), p[0], p[1], 'staff', '', SALT, HASHER.hashPassword_(PW, SALT), p[5] === 'disabled' ? 'FALSE' : 'TRUE', '', '', ''];
}

/** cast：人的清單；opts.admins：[[id, 帳號, 姓名]]；回已建好表、已登入 admin 的 app */
function world(cast, opts) {
  opts = opts || {};
  const admins = opts.admins || [['a001', 'BOSS', '系統管理者']];
  const users = [USERS_HEAD].concat(admins.map((a) => [a[0], a[1], a[2], 'admin', '', SALT, HASHER.hashPassword_(PW, SALT), 'TRUE', '', '', '']))
    .concat(cast.filter((p) => p[5] !== 'pending').map(userRow));
  users.push(['u900', 'HRUSER', '人資帳號', 'hr', '', SALT, HASHER.hashPassword_(PW, SALT), 'TRUE', '', '', '']);
  const app = load({
    users,
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['staff', '員工', ''], ['hr', '人資', 'platform.staff,platform.self']],
    module_secrets: [['backend_id', 'level', 'secret']],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  });
  app.sb.setupStaff();
  cast.forEach((p, i) => app.sheets.staff._data.push(staffRow(p, i)));
  // 打卡對照：每人一筆 confirmed（打卡編號＝店碼大寫＋流水）
  cast.forEach((p, i) => {
    const eid = CLK[p[2]].toUpperCase() + p[0].slice(3);
    app.sheets.staff_clock._data.push([p[0], CLK[p[2]], eid, 'staff', 'confirmed', 'created', 'TRUE', '', 'tester', '', '']);
  });
  app.props.STORE_SVC_KEY = SVC;
  app.props.STORE_SSO_UNITS = opts.pilot === undefined ? PERMS_ALL_PILOT : opts.pilot;
  app.login = (u) => { const r = post(app.sb, 'login', { username: u, password: PW }); return r.ok ? r.data.token : ''; };
  app.adminTok = app.login(admins[0][1]);
  if (opts.init !== false) post(app.sb, 'permInit', {}, app.adminTok);
  app.who = (sub) => post(app.sb, 'svcStoreWho', { svc_key: SVC, sub });
  app.ident = (sub) => { const r = app.who(sub); return r.ok ? r.data : r; };
  app.people = (sub) => app.ident(sub).att.people;
  app.subs = (sub) => app.people(sub).map((x) => x.sub);
  return app;
}
const has = (arr, x) => arr.indexOf(x) !== -1;

// ============================================================
// 1. 契約 fixture 逐欄比對
// ============================================================
(() => {
  // 1a. 復刻 fixture 的 ident_active 情境（sm 陳小明，店長，到職 2026-03-01，帶一位同店計時）
  const cast = [
    ['DZY023', '陳小明', 'mzt-gf', '', 'sm', 'active', '2026-03-01'],
    ['DZY031', '李計時', 'mzt-gf', '', 'pt', 'active', '2026-05-01']
  ];
  const app = world(cast, { pilot: 'mzt-gf', admins: [['u_admin01', 'BOSS', '系統管理員']] });
  // 打卡編號改成 fixture 的 MZTGF03／MZTGF07、店別 mztgf
  app.sheets.staff_clock._data.length = 1;
  app.sheets.staff_clock._data.push(['DZY023', 'mztgf', 'MZTGF03', 'staff', 'confirmed', 'created', 'TRUE', '', '', '', '']);
  app.sheets.staff_clock._data.push(['DZY031', 'mztgf', 'MZTGF07', 'staff', 'confirmed', 'created', 'TRUE', '', '', '', '']);
  app.sheets.staff_clock._data.push(['DZY023', 'hq', 'H001', 'staff', 'confirmed', 'created', 'TRUE', '', '', '', '']);   // 總部排班身分（ident.self）
  const fx = FIX.responses.ident_active.data;
  const got = app.ident('DZY023');
  const { pilot_units: fxPilot, ...fxRest } = fx;
  const { pilot_units: gotPilot, ...gotRest } = got;
  ok(eq(gotRest, fxRest), '1 契約 ident_active：除了 pilot_units 外逐欄相同（含欄位順序、att.people、att.view_people＝[]）', { got: gotRest, want: fxRest });
  ok(eq(keysOf(got), keysOf(fx)), '1 契約 ident_active：欄位名與順序逐字相同');
  ok(Array.isArray(gotPilot) && eq(gotPilot, ['mzt-gf']), '1 契約 ident_active：pilot_units 是陣列（本情境試點＝mzt-gf）');
  ok(FIX.responses.ident_active.ok === true && eq(Object.keys(FIX.responses.ident_active), ['ok', 'data']), '1 契約信封 {ok:true,data}');

  // 1a2. ident_osv_view：假督導（osv，REGIONS_ON=1、負責 A 區＝mzt-gf）逐欄相同（view_people 兩人、req_people 一位店長）
  const cast2 = [
    ['DZY061', '周督導', 'mzt-hq', '', 'osv', 'active', '2026-01-01'],
    ['DZY023', '陳小明', 'mzt-gf', '', 'sm', 'active', '2026-03-01'],
    ['DZY031', '李計時', 'mzt-gf', '', 'pt', 'active', '2026-05-01']
  ];
  const app2 = world(cast2, { pilot: 'mzt-gf,mzt-hq', admins: [['u_admin01', 'BOSS', '系統管理員']] });
  app2.sheets.staff_clock._data.length = 1;
  app2.sheets.staff_clock._data.push(['DZY061', 'hq', 'HQ01', 'staff', 'confirmed', 'created', 'TRUE', '', '', '', '']);
  app2.sheets.staff_clock._data.push(['DZY023', 'mztgf', 'MZTGF03', 'staff', 'confirmed', 'created', 'TRUE', '', '', '', '']);
  app2.sheets.staff_clock._data.push(['DZY031', 'mztgf', 'MZTGF07', 'staff', 'confirmed', 'created', 'TRUE', '', '', '', '']);
  app2.props.REGIONS_ON = '1';
  // 真資料：往 regions 分頁推一列 A 區（mzt-gf、督導 DZY061、active）；mock sandbox 的區域快取跨呼叫持久，改分頁後要 reset
  app2.sheets.regions._data.push(['r-mzt-a', 'A區', 'mzt', 'mzt-gf', 'DZY061', 'TRUE', '2026-10-25 09:00:00', 'tester']);
  app2.sb.regionCtxReset_();
  const fxO = FIX.responses.ident_osv_view.data;
  const gotO = app2.ident('DZY061');
  ok(eq(gotO, fxO), '1 契約 ident_osv_view：整份逐欄相同（含 pilot_units、att.req_people、att.view_people）', { got: gotO, want: fxO });
  ok(eq(keysOf(gotO), keysOf(fxO)) && FIX.responses.ident_osv_view.ok === true, '1 契約 ident_osv_view：欄位名與順序逐字相同');

  // 1a3. ident_support（2026-10-26 營運系統「支援（原單位）」標示）：墨光店長＋辛光計時到墨光支援 → 那一筆多 support／home_unit／home_unit_name
  const cast3 = [
    ['DZY023', '陳小明', 'mzt-gf', '', 'sm', 'active', '2026-03-01'],
    ['DZY031', '李計時', 'mzt-gf', '', 'pt', 'active', '2026-05-01'],
    ['DZY045', '王支援', 'mala-gf', '', 'pt', 'active', '2026-05-02']
  ];
  const app3 = world(cast3, { pilot: 'mzt-gf', admins: [['u_admin01', 'BOSS', '系統管理員']] });
  app3.sheets.staff_clock._data.length = 1;
  app3.sheets.staff_clock._data.push(['DZY023', 'mztgf', 'MZTGF03', 'staff', 'confirmed', 'created', 'TRUE', '', '', '', '']);
  app3.sheets.staff_clock._data.push(['DZY031', 'mztgf', 'MZTGF07', 'staff', 'confirmed', 'created', 'TRUE', '', '', '', '']);
  app3.sheets.staff_clock._data.push(['DZY045', 'gf', 'GF45', 'staff', 'confirmed', 'created', 'TRUE', '', '', '', '']);
  app3.sheets.staff_clock._data.push(['DZY045', 'mztgf', 'MZTGF09', 'support', 'confirmed', 'created', 'TRUE', '', '', '', '']);
  const fxS = FIX.responses.ident_support.data;
  const gotS = app3.ident('DZY023');
  ok(eq(gotS, fxS), '1 契約 ident_support：整份逐欄相同（支援帳號多 support／home_unit／home_unit_name，其他筆形狀不變）', { got: gotS, want: fxS });
  ok(eq(keysOf(gotS), keysOf(fxS)) && FIX.responses.ident_support.ok === true && typeof FIX.rules.att_support === 'string', '1 契約 ident_support：欄位名與順序逐字相同；rules.att_support 有說明');

  // 1b. admin 沒有同仁編號：整份逐欄相同（試點 mala-gf，那邊沒有人 → att.people 空）
  app.props.STORE_SSO_UNITS = 'mala-gf';
  const adm = app.ident('U:u_admin01');
  ok(eq(adm, FIX.responses.ident_admin_no_emp.data), '1 契約 ident_admin_no_emp：整份逐欄相同', { got: adm, want: FIX.responses.ident_admin_no_emp.data });

  // 1c. inactive、roster、ticket、錯誤
  ok(eq(app.ident('DZY999'), { sub: 'DZY999', active: false }) && eq(FIX.responses.ident_inactive.data, { sub: 'DZY023', active: false }), '1 契約 ident_inactive 形狀 {sub, active:false}');
  const r = post(app.sb, 'svcStoreRoster', { svc_key: SVC, unit: 'mzt-gf' });
  ok(eq(r, { ok: true, data: { staff: [{ sub: 'DZY023', emp_no: 'DZY023', name: '陳小明', title: 'sm', unit: 'mzt-gf', epoch: '2026-03-01' }, { sub: 'DZY031', emp_no: 'DZY031', name: '李計時', title: 'pt', unit: 'mzt-gf', epoch: '2026-05-01' }] } }) && eq(r, FIX.responses.roster), '1 契約 roster：逐欄相同、依 emp_no 排序', r);
  app.props.STORE_SSO_UNITS = 'mzt-gf';
  const tk = post(app.sb, 'ssoTicket', { aud: 'store' }, app.login('DZY023'));
  ok(tk.ok && eq(keysOf(tk), keysOf(FIX.responses.ssoTicket)) && eq(keysOf(tk.data), ['ticket', 'expires_in']) && /^[0-9a-f]{64}$/.test(tk.data.ticket) && tk.data.expires_in === 60 && /^[0-9a-f]{64}$/.test(FIX.responses.ssoTicket.data.ticket), '1 契約 ssoTicket：{ok,data:{ticket 64 hex, expires_in 60}}', tk);
  const bad = post(app.sb, 'svcStoreRedeem', { svc_key: SVC, ticket: 'x', aud: 'store' });
  ok(bad.ok === false && bad.error && bad.code === 'ticket_invalid' && Object.keys(FIX.errors).indexOf(bad.code) !== -1, '1 契約錯誤信封：ok:false、error（中文）、code 在契約 errors 內', bad);
  // 請求形狀：fixture 的 action 名稱都在分派白名單
  ok(['svcStoreRedeem', 'svcStoreWho', 'svcStoreRoster', 'ssoTicket'].every((a) => has(app.sb.CODE_ALLOWED_ACTIONS, a) && FIX.requests[a].action === a), '1 契約四個 action 名稱都在 CODE_ALLOWED_ACTIONS');
  // sub 格式
  const rx = (t) => new RegExp(t.slice(0, t.indexOf('$') + 1));
  const subRe = rx(FIX.sub.staff), admRe = rx(FIX.sub.admin_without_emp);
  ok(subRe.test('DZY023') && !subRe.test('dzy023') && admRe.test('U:u_admin01') && FIX.sub.example.every((s) => subRe.test(s) || admRe.test(s)), '1 契約 sub 格式（大寫 DZY 編號／U:id）');
  // 契約 rules 的陣列規則：units_managed／void_units／pilot_units 排序去重；att.people 依 clock、emp_id 排序
  app.props.STORE_SSO_UNITS = 'mzt-gf,mala-gf,mzt-gf, ck ,';
  const adm2 = app.ident('U:u_admin01');
  ok(eq(adm2.pilot_units, ['ck', 'mala-gf', 'mzt-gf']) && eq(adm2.units_managed, ['ck', 'mala-gf', 'mzt-gf']) && eq(adm2.void_units, adm2.units_managed), '1 契約 rules.arrays：pilot／units_managed／void_units 排序去重（admin 含 ck）', adm2);
  ok(eq(adm2.att.people.map((x) => x.clock + ':' + x.emp_id), adm2.att.people.map((x) => x.clock + ':' + x.emp_id).slice().sort()), '1 契約 rules.arrays：att.people 依 clock、emp_id 排序');
})();

// ============================================================
// 2. ssoTicket aud store ＋ 三支服務 action
// ============================================================
(() => {
  const app = world(BIG);
  const { sb, props, cache, hooks } = app;
  const red = (p) => post(sb, 'svcStoreRedeem', Object.assign({ svc_key: SVC, aud: 'store' }, p));
  const staffTok = app.login('DZY001');
  // 發券：同仁→DZY 編號；admin 沒有同仁編號→U:id；其他 no_emp
  const t1 = post(sb, 'ssoTicket', { aud: 'store' }, staffTok);
  ok(t1.ok && /^[0-9a-f]{64}$/.test(t1.data.ticket) && t1.data.expires_in === 60, '2 在職同仁拿到券（64 hex、60 秒）', t1);
  const rec = JSON.parse(cache.get('sso_tkt:' + t1.data.ticket).v);
  ok(rec.sub === 'DZY001' && rec.aud === 'store', '2 券存法沿用 sso_tkt: 前綴、sub＝DZY 編號', rec);
  const ta = post(sb, 'ssoTicket', { aud: 'store' }, app.adminTok);
  ok(ta.ok && JSON.parse(cache.get('sso_tkt:' + ta.data.ticket).v).sub === 'U:a001', '2 admin 沒有 DZY 編號 → sub＝U:users.id', ta);
  ok(post(sb, 'ssoTicket', { aud: 'store' }, app.login('HRUSER')).code === 'no_emp', '2 其他角色（非同仁非 admin）→ no_emp');
  ok(post(sb, 'ssoTicket', { aud: 'storeX' }, staffTok).code === 'bad_aud', '2 aud 不支援 → bad_aud');
  // 兌換
  const r1 = red({ ticket: t1.data.ticket });
  ok(r1.ok && r1.data.sub === 'DZY001' && r1.data.active === true && r1.data.unit === 'mzt-gf', '2 兌換成功回 ident', r1);
  ok(red({ ticket: t1.data.ticket }).code === 'ticket_invalid', '2 同一張券第二次 → ticket_invalid');
  const ra = red({ ticket: ta.data.ticket });
  ok(ra.ok && ra.data.sub === 'U:a001' && ra.data.admin === true && ra.data.emp_no === '', '2 admin 券兌換回 ident_admin_no_emp 形狀', ra);
  // 錯金鑰／未設金鑰
  const t2 = post(sb, 'ssoTicket', { aud: 'store' }, staffTok).data.ticket;
  ok(red({ ticket: t2, svc_key: 'wrong' }).code === 'unauthorized', '2 ★錯金鑰 → unauthorized');
  ok(cache.has('sso_tkt:' + t2), '2 錯金鑰不會把券用掉');
  ok(red({ ticket: t2, svc_key: '' }).code === 'unauthorized' && post(sb, 'svcStoreRedeem', { ticket: t2, aud: 'store' }).code === 'unauthorized', '2 ★沒帶金鑰 → unauthorized');
  ok(post(sb, 'svcStoreWho', { svc_key: 'wrong', sub: 'DZY001' }).code === 'unauthorized' && post(sb, 'svcStoreRoster', { svc_key: 'wrong', unit: 'mzt-gf' }).code === 'unauthorized', '2 ★Who／Roster 錯金鑰 → unauthorized');
  delete props.STORE_SVC_KEY;
  ok(red({ ticket: t2, svc_key: SVC }).code === 'unauthorized' && post(sb, 'svcStoreWho', { svc_key: SVC, sub: 'DZY001' }).code === 'unauthorized' && post(sb, 'svcStoreRoster', { svc_key: SVC, unit: 'mzt-gf' }).code === 'unauthorized', '2 ★STORE_SVC_KEY 沒設 → 三支全 unauthorized');
  props.STORE_SVC_KEY = SVC;
  // aud 不符：bulletin 的券不能拿來開門市；門市的券不能拿來開佈告欄
  ok(red({ ticket: t2, aud: 'bulletin' }).code === 'bad_aud', '2 ★兌換時 aud 不是 store → bad_aud');
  props.BULLETIN_SVC_KEY = 'fake-bulletin-key-0001';
  ok(post(sb, 'svcSsoRedeem', { svc_key: 'fake-bulletin-key-0001', ticket: t2, aud: 'bulletin' }).code === 'ticket_invalid', '2 ★門市券拿去佈告欄兌換 → ticket_invalid');
  const tb = post(sb, 'ssoTicket', { aud: 'bulletin' }, staffTok).data.ticket;
  ok(red({ ticket: tb }).code === 'ticket_invalid', '2 ★佈告欄券拿去門市兌換 → ticket_invalid');
  // 過期
  const t3 = post(sb, 'ssoTicket', { aud: 'store' }, staffTok).data.ticket;
  cache.get('sso_tkt:' + t3).exp = Date.now() - 1;
  ok(red({ ticket: t3 }).code === 'ticket_invalid', '2 ★過期券 → ticket_invalid');
  ok(red({ ticket: 'abc' }).code === 'ticket_invalid' && red({ ticket: ['x'] }).code === 'ticket_invalid' && red({ ticket: 'A'.repeat(64) }).code === 'ticket_invalid', '2 券格式不對 → ticket_invalid');
  // 並發：同一張券兩個請求交錯（第二個在第一個 get 與 remove 之間進來）→ 恰一個成功
  const t4 = post(sb, 'ssoTicket', { aud: 'store' }, staffTok).data.ticket;
  let inner = null;
  hooks.onGet = () => { inner = red({ ticket: t4 }); };
  const outer = red({ ticket: t4 });
  const oks = [outer, inner].filter((x) => x && x.ok).length;
  ok(oks === 1, '2 ★並發兩次兌換同一張券：恰一次成功（LockService 包住 get＋remove）', { outer, inner });
  ok(app.lockState.held === false, '2 兌換完成後鎖已釋放');
  ok(red({ ticket: t4 }).code === 'ticket_invalid', '2 並發之後再換一次仍是 ticket_invalid');
  // 其他兩支的輸入驗證
  ok(post(sb, 'svcStoreWho', { svc_key: SVC, sub: 'dzy001' }).code === 'bad_input' && post(sb, 'svcStoreWho', { svc_key: SVC, sub: 'U:' }).code === 'bad_input' && post(sb, 'svcStoreWho', { svc_key: SVC, sub: 5 }).code === 'bad_input', '2 Who：sub 格式錯 → bad_input');
  ok(post(sb, 'svcStoreRoster', { svc_key: SVC, unit: 'a b' }).code === 'bad_input' && post(sb, 'svcStoreRoster', { svc_key: SVC }).code === 'bad_input', '2 Roster：unit 格式錯 → bad_input');
  // Who：停用、離職、查無、pending 都算 inactive
  ok(eq(app.ident('DZY030'), { sub: 'DZY030', active: false }), '2 Who：已離職（disabled）→ inactive');
  ok(eq(app.ident('DZY031'), { sub: 'DZY031', active: false }), '2 Who：pending → inactive');
  ok(eq(app.ident('DZY998'), { sub: 'DZY998', active: false }) && eq(app.ident('U:nobody'), { sub: 'U:nobody', active: false }), '2 Who：查無此人 → inactive');
  app.sheets.users._data.find((r) => r[0] === 'u002')[7] = 'FALSE';
  ok(eq(app.ident('DZY002'), { sub: 'DZY002', active: false }), '2 Who：登入帳號被停用 → inactive');
  // Roster：只有 active、依 emp_no
  const ro = post(sb, 'svcStoreRoster', { svc_key: SVC, unit: 'mzt-gf' });
  ok(eq(ro.data.staff.map((x) => x.sub), ['DZY001', 'DZY002', 'DZY003', 'DZY008']) && ro.data.staff.every((x) => eq(keysOf(x), ['sub', 'emp_no', 'name', 'title', 'unit', 'epoch'])), '2 Roster：只有 active、依 emp_no 排序、欄位六個', ro);
  ok(eq(post(sb, 'svcStoreRoster', { svc_key: SVC, unit: 'nowhere' }).data.staff, []), '2 Roster：沒有這個單位 → 空名單');
  // 分派：三支不上全域寫入鎖（自己控制鎖）；不在 dryrun READ_ACTIONS
  const mut = /MUTATING_ACTIONS = \{([\s\S]*?)\};/.exec(SRC.find(([f]) => f === 'Code.gs')[1])[1];
  ok(!/svcStore/.test(mut), '2 三支 svcStore* 不在 MUTATING_ACTIONS（兌換自己用 LockService 包 get＋remove）');
})();

// ============================================================
// 3. att 負向測試（spec §12 表格）
// ============================================================
(() => {
  const app = world(BIG);
  const subs = (s) => app.subs(s);
  // 店長
  const sm = subs('DZY001');
  ok(has(sm, 'DZY001'), '3 店長名單含自己');
  ok(has(sm, 'DZY002') && has(sm, 'DZY003'), '3 店長名單含同店正職與計時');
  ok(!has(sm, 'DZY004') && !has(sm, 'DZY005') && !has(sm, 'DZY006') && !has(sm, 'DZY007'), '3 別店（含央廚）的人不出現');
  ok(has(sm, 'DZY008'), '3 核定工時：店長核同店所有打卡的人（含同店另一位店長；2026-10-21）');
  ok(!has(app.ident('DZY001').att.req_people.map((x) => x.sub), 'DZY008') && !has(app.ident('DZY001').att.req_people.map((x) => x.sub), 'DZY001'), '3 申請：店長不能核同店另一位店長、也不能核自己');
  ok(!has(sm, 'DZY030') && !has(sm, 'DZY031'), '3 已離職、待審的人不出現');
  ok(!has(sm, 'DZY010') && !has(sm, 'DZY020'), '3 店長看不到品牌辦公室／總部的人');
  ok(app.people('DZY001').every((x) => x.clock === 'mztgf'), '3 店長名單只有本店打卡店別');
  ok(has(subs('DZY006'), 'DZY006') && has(subs('DZY006'), 'DZY007') && !has(subs('DZY006'), 'DZY001'), '3 央廚店長比照：含自己與央廚人員');
  // 品牌辦公室
  ok(subs('DZY011').length === 0, '3 ★區經理不能核行政／督導（也不能核任何人）');
  ok(subs('DZY012').length === 0, '3 督導名單空');
  ok(subs('DZY013').length === 0, '3 行政名單空');
  const dir = subs('DZY010');
  ok(eq(dir, ['DZY012', 'DZY013']), '3 總監核同辦公室的督導、行政（不含自己、不含別人；停用的區經理 oam 不列）', dir);
  ok(!has(dir, 'DZY014') && !has(dir, 'DZY015'), '3 ★總監不能核別品牌辦公室的人');
  ok(eq(subs('DZY014'), ['DZY015']), '3 另一品牌總監只核自己辦公室的行政', subs('DZY014'));
  // 總部
  const fin = subs('DZY022');
  ok(eq(fin, ['DZY023']), '3 部門主管只核同部門同仁（不含自己、不含別部門）', fin);
  ok(!has(subs('DZY022'), 'DZY021') && !has(subs('DZY022'), 'DZY024'), '3 財務主管看不到人資與管理部同仁');
  ok(eq(subs('DZY025'), ['DZY024']) && eq(subs('DZY026'), ['DZY024']) && eq(subs('DZY027'), ['DZY024']), '3 管理部同仁由執行長／總經理／董事長核', subs('DZY025'));
  ok(subs('DZY021').length === 0 && subs('DZY023').length === 0, '3 一般同仁名單空');
  // 人資主管
  const hr = subs('DZY020');
  ok(!has(hr, 'DZY020'), '3 ★人資主管名單不含自己');
  ok(has(hr, 'DZY001') && has(hr, 'DZY013') && has(hr, 'DZY021') && has(hr, 'DZY024') && has(hr, 'DZY042'), '3 人資主管看得到全部要考勤的人');
  const NOATT = ['DZY010', 'DZY014', 'DZY020', 'DZY022', 'DZY025', 'DZY026', 'DZY027'];
  ok(NOATT.every((e) => !has(hr, e)), '3 ★責任制職稱（odir hm ceo gm chair）不出現在人資主管名單');
  const admin = app.subs('U:a001');
  ok(NOATT.every((e) => !has(admin, e)) && has(admin, 'DZY001') && has(admin, 'DZY024') && !has(admin, 'DZY030') && !has(admin, 'DZY031'), '3 admin 名單：全部要考勤的人、責任制不出現、離職待審不出現');
  ok(eq(admin.slice().sort(), hr.slice().sort()), '3 admin 與人資主管名單是同一批人（都是全部要考勤的人）');
  // 純函式：人資主管旗標＋本人是要考勤的人 → 仍不含自己
  const org = app.sb.stfReadOrg_();
  const mk = (e, u, d, t) => ({ emp: e, status: 'active', unit: u, dept: d, title: t, name: e });
  const people = [mk('DZY021', 'dzy-hq', 'hr', 'hs'), mk('DZY023', 'dzy-hq', 'fin', 'hs'), mk('DZY001', 'mzt-gf', '', 'sm')];
  const t1 = app.sb.storeAttTargets_(people[0], { hrHead: true }, people, org).map((x) => x.emp);
  ok(eq(t1, ['DZY023', 'DZY001']), '3 純函式：hrHead 旗標＋本人要考勤 → 名單不含自己', t1);
  const t2 = app.sb.storeAttTargets_(people[0], { admin: true }, people, org).map((x) => x.emp);
  ok(eq(t2, ['DZY023', 'DZY001']), '3 純函式：admin 若同時是要考勤的同仁 → 名單不含自己');
  const smAdmin = mk('DZY001', 'mzt-gf', '', 'sm');
  const t3 = app.sb.storeAttTargets_(smAdmin, { admin: true }, [smAdmin, people[1]], org).map((x) => x.emp);
  ok(eq(t3, ['DZY001', 'DZY023']), '3 純函式：兼 admin 的店長 → 名單含自己（店長核自己）', t3);
  const t4 = app.sb.storeAttTargets_(smAdmin, { hrHead: true }, [smAdmin, people[1]], org).map((x) => x.emp);
  ok(eq(t4, ['DZY001', 'DZY023']), '3 純函式：兼人資主管的店長 → 名單含自己', t4);
  const t5 = app.sb.storeAttTargets_(people[1], { admin: true }, [people[1], smAdmin], org).map((x) => x.emp);
  ok(eq(t5, ['DZY001']), '3 純函式：兼 admin 的非店長（hs）→ 仍不含自己', t5);
  // attNeedOf_／attApproverOf_ 直接驗
  const need = (t) => app.sb.attNeedOf_(t, org);
  ok(need({ unit: 'mzt-hq', title: 'odir' }) === null && need({ unit: 'dzy-hq', dept: 'hr', title: 'hm' }) === null && need({ unit: 'dzy-hq', dept: 'mgmt', title: 'chair' }) === null, '3 attNeedOf_：責任制職稱回 null');
  ok(need({ unit: 'mzt-gf', title: 'sm' }).kind === 'unit' && need({ unit: 'mzt-gf', title: 'pt' }).kind === 'unit' && need({ unit: 'mzt-hq', title: 'osv' }).kind === 'office' && need({ unit: 'dzy-hq', dept: 'fin', title: 'hs' }).kind === 'dept' && need({ unit: 'dzy-hq', dept: 'mgmt', title: 'hs' }).kind === 'mgmt', '3 attNeedOf_：五種被核者');
  ok(need({ unit: 'mzt-gf', title: 'odir' }) === null && need({ unit: 'nope', title: 'pt' }) === null && need({ unit: 'mzt-wx', title: 'pt' }) === null, '3 attNeedOf_：職稱與階梯不合、單位不存在、單位停用 → null');
  const ap = (a, t) => app.sb.attApproverOf_(a, t, org);
  ok(ap(mk('DZY011', 'mzt-hq', '', 'oam'), mk('DZY013', 'mzt-hq', '', 'ofs')) === false && ap(mk('DZY011', 'mzt-hq', '', 'oam'), mk('DZY012', 'mzt-hq', '', 'osv')) === false, '3 attApproverOf_：區經理核行政／督導 → false');
  ok(ap(mk('DZY010', 'mzt-hq', '', 'odir'), mk('DZY013', 'mzt-hq', '', 'ofs')) === true && ap(mk('DZY010', 'mzt-hq', '', 'odir'), mk('DZY015', 'mala-hq', '', 'ofs')) === false, '3 attApproverOf_：總監核本辦公室行政 true、別辦公室 false');
  ok(ap(mk('DZY001', 'mzt-gf', '', 'sm'), mk('DZY001', 'mzt-gf', '', 'sm')) === true && ap(mk('DZY003', 'mzt-gf', '', 'pt'), mk('DZY003', 'mzt-gf', '', 'pt')) === false, '3 attApproverOf_：只有店長核自己，計時核自己 false');
  ok(ap({ emp: 'DZY030', status: 'disabled', unit: 'mzt-gf', title: 'sm' }, mk('DZY003', 'mzt-gf', '', 'pt')) === false, '3 attApproverOf_：核定人已離職 → false');
  // 2026-10-20 職稱調整（docs/org/spec.md 第 15 節）：區經理 am、中央工廠廠長 fm／研發總監 rdd
  const am = mk('DZY090', 'mzt-gf', '', 'am'), fm = mk('DZY091', 'ck', '', 'fm'), rdd = mk('DZY092', 'ck', '', 'rdd');
  ok(['am', 'sm', 'pt'].every((t) => need({ unit: 'mzt-gf', title: t }).kind === 'unit') && ['fm', 'rdd'].every((t) => need({ unit: 'ck', title: t }).kind === 'unit'), '15 attNeedOf_ 核定工時：區經理、廠長、研發總監都要考勤，由本單位店長／廠長核（2026-10-21）');
  ok(need({ unit: 'ck', title: 'sm' }) === null && need({ unit: 'ck', title: 'am' }) === null && need({ unit: 'mzt-gf', title: 'fm' }) === null && need({ unit: 'mzt-gf', title: 'rdd' }) === null, '15 attNeedOf_：中央工廠店長／區經理、門市廠長／研發總監 → 不合規（null）');
  ok(ap(am, mk('DZY003', 'mzt-gf', '', 'pt')) === false && ap(am, mk('DZY002', 'mzt-gf', '', 'ft')) === false && ap(am, am) === false && ap(am, mk('DZY001', 'mzt-gf', '', 'sm')) === false, '15 核定工時：區經理不核任何人的工時（含自己、同店店長）');
  ok(ap(mk('DZY001', 'mzt-gf', '', 'sm'), am) === true && ap(mk('DZY004', 'mzt-js', '', 'sm'), am) === false, '15 核定工時：區經理的工時由同店店長核、別店店長不行');
  ok(ap(fm, mk('DZY007', 'ck', '', 'pt')) && ap(fm, fm) && ap(fm, rdd), '15 核定工時：廠長核央廚同仁、自己與研發總監');
  ok(ap(rdd, mk('DZY007', 'ck', '', 'pt')) === false && ap(rdd, fm) === false && ap(rdd, rdd) === false, '15 核定工時：研發總監不核任何人的工時（含廠長、自己）');
  ok(ap(rdd, mk('DZY003', 'mzt-gf', '', 'pt')) === false, '15 研發總監不核門市');
  ok(ap(mk('DZY006', 'ck', '', 'sm'), mk('DZY007', 'ck', '', 'pt')) === false, '15 切換後還掛中央工廠的店長 → 不能核（要改廠長）');
  ok(['fm', 'am', 'rdd', 'osv'].every((t) => app.sb.STORE_ATT_GATE_TITLES.indexOf(t) !== -1) && ['fm', 'am', 'rdd'].every((t) => app.sb.STORE_NO_ATT_TITLES.indexOf(t) === -1), '15 廠長／區經理／研發總監／區督導有考勤管理選單；前三者要打卡（不是責任制）');
  const tAm = app.sb.storeAttTargets_(am, { admin: true }, [am], org).map((x) => x.emp);
  ok(eq(tAm, []), '15 兼 admin 的區經理 → 名單不含自己（區經理不再核自己的工時）', tAm);
  const tSmA = app.sb.storeAttTargets_(smAdmin, { admin: true }, [smAdmin], org, null, 'req').map((x) => x.emp);
  ok(eq(tSmA, []), '15 兼 admin 的店長：申請名單不含自己', tSmA);
  // 打卡對照條件
  app.sheets.staff_clock._data.push(['DZY002', 'mztgf', 'MZTGF002B', 'staff', 'confirmed', 'created', 'TRUE', '', '', '', '']);
  const idx = (e) => app.sheets.staff_clock._data.findIndex((r, i) => i > 0 && r[0] === e && r[2].indexOf('B') === -1);
  app.sheets.staff_clock._data[idx('DZY003')][6] = 'FALSE';
  app.sheets.staff_clock._data[idx('DZY001')][4] = 'pending';
  const p2 = app.people('DZY001');
  ok(!p2.some((x) => x.sub === 'DZY003') && !p2.some((x) => x.sub === 'DZY001'), '3 roster_active=FALSE、state 不是 confirmed 的對照不出現');
  ok(p2.filter((x) => x.sub === 'DZY002').length === 2 && eq(p2.map((x) => x.clock + ':' + x.emp_id), p2.map((x) => x.clock + ':' + x.emp_id).slice().sort()), '3 同一人多筆對照各一列、依 clock／emp_id 排序');
  app.sheets.staff_clock._data[idx('DZY003')][6] = '';
  ok(app.people('DZY001').some((x) => x.sub === 'DZY003'), '3 roster_active 空白視為在名冊內');
  // 沒有 confirmed 對照的人不出現
  app.sheets.staff_clock._data.splice(app.sheets.staff_clock._data.findIndex((r, i) => i > 0 && r[0] === 'DZY007'), 1);
  ok(!app.subs('DZY006').includes('DZY007'), '3 沒有打卡對照的人不出現');
  // att.extra：本人單位內所有要考勤的人（不含自己）
  const ex0 = app.subs('DZY040');
  ok(ex0.length === 0, '3 沒有 att.extra 的一般正職名單空');
  const sv = post(app.sb, 'permExSave', { emp_no: 'DZY040', perm: 'att.extra', mode: 'add', until: '', note: '測試額外核定' }, app.adminTok);
  ok(sv.ok, '3 admin 設 att.extra 例外', sv);
  const ex1 = app.subs('DZY040');
  ok(eq(ex1, ['DZY041', 'DZY042']), '3 att.extra：本單位要考勤的人、不含自己、不含別單位', ex1);
  ok(!ex1.includes('DZY040'), '3 att.extra 名單不含自己');
  post(app.sb, 'permExSave', { emp_no: 'DZY040', perm: 'att.extra', mode: 'remove', until: '', note: '測試拿掉' }, app.adminTok);
  ok(app.subs('DZY040').length === 0, '3 att.extra 被拿掉後名單回空');
})();

// ============================================================
// 3b. 核定工時 vs 申請（Eason 2026-10-21，docs/org/spec.md 第 15.1 節）：att.people＝工時、att.req_people＝加班單／請假單／忘刷單
// ============================================================
(() => {
  const cast = [
    ['DZY101', '甲店長', 'mzt-gf', '', 'sm', 'active', '2026-01-01'],
    ['DZY102', '甲區經理', 'mzt-gf', '', 'am', 'active', '2026-01-01'],
    ['DZY103', '甲正職', 'mzt-gf', '', 'ft', 'active', '2026-01-01'],
    ['DZY104', '甲計時', 'mzt-gf', '', 'pt', 'active', '2026-01-01'],
    ['DZY105', '乙店長', 'mzt-js', '', 'sm', 'active', '2026-01-01'],
    ['DZY106', '乙區經理', 'mzt-js', '', 'am', 'active', '2026-01-01'],
    ['DZY107', '乙計時', 'mzt-js', '', 'pt', 'active', '2026-01-01'],
    ['DZY108', '丙店長', 'mala-gf', '', 'sm', 'active', '2026-01-01'],
    ['DZY110', '央廚廠長', 'ck', '', 'fm', 'active', '2026-01-01'],
    ['DZY111', '研發總監', 'ck', '', 'rdd', 'active', '2026-01-01'],
    ['DZY112', '央廚計時', 'ck', '', 'pt', 'active', '2026-01-01'],
    ['DZY120', '墨竹亭總監', 'mzt-hq', '', 'odir', 'active', '2026-01-01'],
    ['DZY121', '墨竹亭區督導', 'mzt-hq', '', 'osv', 'active', '2026-01-01'],
    ['DZY122', '墨竹亭行政', 'mzt-hq', '', 'ofs', 'active', '2026-01-01'],
    ['DZY123', '小辛辣區督導', 'mala-hq', '', 'osv', 'active', '2026-01-01'],
    ['DZY124', '小辛辣總監', 'mala-hq', '', 'odir', 'active', '2026-01-01'],
    ['DZY130', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-01'],
    ['DZY131', '財務主管', 'dzy-hq', 'fin', 'hm', 'active', '2026-01-01'],
    ['DZY132', '財務同仁', 'dzy-hq', 'fin', 'hs', 'active', '2026-01-01'],
    ['DZY133', '管理部同仁', 'dzy-hq', 'mgmt', 'hs', 'active', '2026-01-01'],
    ['DZY134', '執行長', 'dzy-hq', 'mgmt', 'ceo', 'active', '2026-01-01'],
    ['DZY135', '總經理', 'dzy-hq', 'mgmt', 'gm', 'active', '2026-01-01'],
    ['DZY136', '董事長', 'dzy-hq', 'mgmt', 'chair', 'active', '2026-01-01']
  ];
  const app = world(cast);
  const H = (s) => app.ident(s).att.people.map((x) => x.sub).sort();
  const R = (s) => app.ident(s).att.req_people.map((x) => x.sub).sort();
  const g = (label, got, want) => ok(eq(got, want), label, { got, want });
  // 契約形狀：兩份名單同一種項目、各自排序
  const id1 = app.ident('DZY101');
  ok(eq(Object.keys(id1.att), ['people', 'req_people', 'view_people']) && id1.att.req_people.every((x) => eq(Object.keys(x), ['clock', 'emp_id', 'sub', 'name'])), '3b att 有 people 與 req_people，項目欄位相同');
  // 核定工時
  g('3b 工時：店長核本店所有打卡的人（計時、正職、區經理、自己）', H('DZY101'), ['DZY101', 'DZY102', 'DZY103', 'DZY104']);
  g('3b 工時：別店店長只核別店（不含甲店區經理）', H('DZY105'), ['DZY105', 'DZY106', 'DZY107']);
  g('3b 工時：區經理不核任何人的工時（含自己）', H('DZY102'), []);
  g('3b 工時：廠長核央廚所有人（含研發總監、自己）', H('DZY110'), ['DZY110', 'DZY111', 'DZY112']);
  g('3b 工時：研發總監不核工時（不再核廠長）', H('DZY111'), []);
  g('3b 工時：區督導不核工時', H('DZY121'), []);
  g('3b 工時：總監核同辦公室行政、督導（不變）', H('DZY120'), ['DZY121', 'DZY122']);
  g('3b 工時：部門主管核同部門同仁（不變）', H('DZY131'), ['DZY132']);
  g('3b 工時：管理部同仁由執行長以上核（不變）', H('DZY134'), ['DZY133']);
  // 申請
  g('3b 申請：店長核本店計時、正職；不含自己、不含區經理', R('DZY101'), ['DZY103', 'DZY104']);
  g('3b 申請：區經理核同店店長；不核別店店長、不核計時正職、不核自己', R('DZY102'), ['DZY101']);
  g('3b 申請：另一店區經理只核自己那店的店長', R('DZY106'), ['DZY105']);
  g('3b 申請：區督導核品牌內所有店長與區經理；不核別品牌、不核辦公室同仁', R('DZY121'), ['DZY101', 'DZY102', 'DZY105', 'DZY106']);
  g('3b 申請：別品牌區督導只核自己品牌的店長', R('DZY123'), ['DZY108']);
  g('3b 申請：總監核區經理（預設）與同辦公室行政、督導；不核店長', R('DZY120'), ['DZY102', 'DZY106', 'DZY121', 'DZY122']);
  g('3b 申請：小辛辣總監只核自己辦公室', R('DZY124'), ['DZY123']);
  g('3b 申請：廠長核央廚計時正職；不含自己、不含研發總監', R('DZY110'), ['DZY112']);
  g('3b 申請：研發總監核廠長；不核央廚計時、不核自己', R('DZY111'), ['DZY110']);
  g('3b 申請：執行長核研發總監（預設）與管理部同仁', R('DZY134'), ['DZY111', 'DZY133']);
  ok(eq(R('DZY135'), ['DZY111', 'DZY133']) && eq(R('DZY136'), ['DZY111', 'DZY133']), '3b 申請：總經理、董事長同執行長');
  g('3b 申請：部門主管核同部門同仁（同工時）', R('DZY131'), ['DZY132']);
  g('3b 申請：一般同仁名單空', R('DZY104'), []);
  // 人資主管與 admin：兩份都是全部要考勤的人、不含自己（工時含不含自己同既有規則，申請一律不含）
  const ALL = cast.map((p) => p[0]).filter((e) => ['DZY120', 'DZY124', 'DZY130', 'DZY131', 'DZY134', 'DZY135', 'DZY136'].indexOf(e) === -1).sort();
  g('3b 人資主管：申請名單＝全部要考勤的人', R('DZY130'), ALL);
  g('3b 人資主管：工時名單＝全部要考勤的人', H('DZY130'), ALL);
  g('3b admin：申請名單＝全部要考勤的人', R('U:a001'), ALL);
  // 純函式：各規則正反例
  const org = app.sb.stfReadOrg_();
  const P = Object.fromEntries(cast.map((c) => [c[0], { emp: c[0], status: 'active', unit: c[2], dept: c[3], title: c[4], name: c[1] }]));
  const hrs = (a, t) => app.sb.attApproverOf_(P[a], P[t], org, 'hours');
  const req = (a, t) => app.sb.attApproverOf_(P[a], P[t], org, 'req');
  ok(hrs('DZY101', 'DZY101') === true && req('DZY101', 'DZY101') === false, '3b 店長：可核自己的工時、不能核自己的申請');
  ok(hrs('DZY110', 'DZY110') === true && req('DZY110', 'DZY110') === false, '3b 廠長：可核自己的工時、不能核自己的申請');
  ok(req('DZY102', 'DZY101') === true && req('DZY102', 'DZY105') === false && hrs('DZY102', 'DZY101') === false && hrs('DZY102', 'DZY104') === false, '3b 區經理：核同店店長申請、不核別店；不核任何工時');
  ok(req('DZY121', 'DZY101') === true && req('DZY121', 'DZY108') === false && hrs('DZY121', 'DZY101') === false, '3b 區督導：核本品牌店長申請、不核別品牌；不核工時');
  ok(req('DZY111', 'DZY110') === true && hrs('DZY111', 'DZY110') === false && hrs('DZY110', 'DZY111') === true, '3b 研發總監核廠長申請、不核廠長工時；廠長核研發總監工時');
  ok(req('DZY121', 'DZY102') === true && req('DZY120', 'DZY102') === true && req('DZY123', 'DZY102') === false && req('DZY101', 'DZY102') === false, '3b 區經理本人的申請：本品牌區督導／總監可、別品牌與同店店長不行');
  ok(req('DZY134', 'DZY111') === true && req('DZY110', 'DZY111') === false && req('DZY120', 'DZY111') === false && hrs('DZY134', 'DZY111') === false, '3b 研發總監本人的申請：執行長以上可、廠長與品牌總監不行；執行長不核工時');
  ok(req('DZY101', 'DZY104') === true && req('DZY105', 'DZY104') === false && req('DZY102', 'DZY104') === false, '3b 計時申請：同店店長可、別店店長與區經理不行');
  ok(req('DZY120', 'DZY122') === true && req('DZY121', 'DZY122') === false && req('DZY131', 'DZY132') === true && req('DZY130', 'DZY132') === false && req('DZY134', 'DZY133') === true, '3b 品牌辦公室／部門／管理部的申請同工時規則');
  ok(app.sb.attApproverOf_(P.DZY101, P.DZY104, org) === true && app.sb.attApproverOf_(P.DZY102, P.DZY101, org) === false, '3b mode 省略＝核定工時');
  ok(app.sb.attNeedOf_(P.DZY101, org, 'req').kind === 'head' && app.sb.attNeedOf_(P.DZY102, org, 'req').kind === 'brand_office' && app.sb.attNeedOf_(P.DZY111, org, 'req').kind === 'hq_exec' && app.sb.attNeedOf_(P.DZY104, org, 'req').kind === 'unit', '3b attNeedOf_ req：店長 head、區經理 brand_office、研發總監 hq_exec、計時 unit');
  // att.extra：兩份名單都是本單位要考勤的人、不含自己
  post(app.sb, 'permExSave', { emp_no: 'DZY103', perm: 'att.extra', mode: 'add', until: '', note: '測試額外核定' }, app.adminTok);
  g('3b att.extra 工時：本單位、不含自己', H('DZY103'), ['DZY101', 'DZY102', 'DZY104']);
  g('3b att.extra 申請：本單位、不含自己', R('DZY103'), ['DZY101', 'DZY102', 'DZY104']);
  // 區督導有考勤管理選單
  const r = post(app.sb, 'login', { username: 'DZY121', password: PW });
  ok(r.ok && has(r.data.perms, 'platform.att'), '3b 區督導登入有 platform.att');
})();


// ============================================================
// 3c. 督導／總監只看考勤名單 att.view_people（docs/att-view/spec.md；掛 REGIONS_ON）
// ============================================================
(() => {
  const cast = [
    ['DZY201', '督導甲', 'mzt-hq', '', 'osv', 'active', '2026-01-01'],
    ['DZY202', '督導乙未劃區', 'mzt-hq', '', 'osv', 'active', '2026-01-01'],
    ['DZY203', '總監甲', 'mzt-hq', '', 'odir', 'active', '2026-01-01'],
    ['DZY204', '行政甲', 'mzt-hq', '', 'ofs', 'active', '2026-01-01'],
    ['DZY210', 'A區店長1', 'mzt-gf', '', 'sm', 'active', '2026-01-01'],
    ['DZY211', 'A區計時1', 'mzt-gf', '', 'pt', 'active', '2026-01-01'],
    ['DZY212', 'A區店長2', 'mzt-js', '', 'sm', 'active', '2026-01-01'],
    ['DZY213', 'A區正職2', 'mzt-js', '', 'ft', 'active', '2026-01-01'],
    ['DZY220', 'B區店長', 'mzt-lzl', '', 'sm', 'active', '2026-01-01'],
    ['DZY230', '別品牌店長', 'mala-gf', '', 'sm', 'active', '2026-01-01'],
    ['DZY231', '別品牌督導', 'mala-hq', '', 'osv', 'active', '2026-01-01'],
    ['DZY240', '央廚廠長', 'ck', '', 'fm', 'active', '2026-01-01'],
    ['DZY250', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-01'],
    ['DZY251', '財務同仁', 'dzy-hq', 'fin', 'hs', 'active', '2026-01-01'],
    ['DZY260', '停用督導', 'mzt-hq', '', 'osv', 'disabled', '2026-01-01']
  ];
  const mkIdx = (m) => {
    const byRegion = { A: { stores: ['mzt-gf', 'mzt-js'] }, B: { stores: ['mzt-lzl'] } };
    return { byRegion, bySupervisor: m };
  };
  const app = world(cast, { pilot: PERMS_ALL_PILOT + ',mzt-lzl' });
  const V = (s) => app.ident(s).att.view_people.map((x) => x.sub).sort();
  const g = (label, got, want) => ok(eq(got, want), label, { got, want });
  const people = cast.map((c) => ({ emp: c[0], name: c[1], unit: c[2], dept: c[3], title: c[4], status: c[5] }));
  const O = app.sb.stfReadOrg_();
  ok(!!O, '3c 取得 org 物件');
  const P = (e) => people.find((x) => x.emp === e);
  const idxA = mkIdx({ DZY201: ['A'] });
  g('3c units：督導甲負責 A 區 → 兩家店', app.sb.attViewUnitsOf_(P('DZY201'), O, idxA), ['mzt-gf', 'mzt-js']);
  g('3c units：督導負責兩區 → 聯集排序去重', app.sb.attViewUnitsOf_(P('DZY201'), O, mkIdx({ DZY201: ['B', 'A', 'A'] })), ['mzt-gf', 'mzt-js', 'mzt-lzl']);
  g('3c units：未劃區督導 → []', app.sb.attViewUnitsOf_(P('DZY202'), O, idxA), []);
  g('3c units：regionIdx=null → []', app.sb.attViewUnitsOf_(P('DZY201'), O, null), []);
  // 區域索引被污染：別品牌店、ck、品牌辦公室、停用店、不存在的店 → 全被濾掉，只剩同品牌 active 門市
  const dirtyIdx = { byRegion: { A: { stores: ['mzt-gf', 'mala-gf', 'ck', 'mzt-hq', 'mzt-wx', 'no-such', ''] } }, bySupervisor: { DZY201: ['A'], DZY231: ['A'], DZY260: ['A'] } };
  g('3c units：索引塞別品牌店／ck／品牌辦公室／停用店／不存在店 → 都被濾掉', app.sb.attViewUnitsOf_(P('DZY201'), O, dirtyIdx), ['mzt-gf']);
  g('3c units：督導已調到別品牌辦公室但索引仍掛舊品牌區 → []', app.sb.attViewUnitsOf_(P('DZY231'), O, mkIdx({ DZY231: ['A', 'B'] })), []);
  const dirUnits = app.sb.attViewUnitsOf_(P('DZY203'), O, null);
  ok(dirUnits.indexOf('mzt-gf') !== -1 && dirUnits.indexOf('mzt-js') !== -1 && dirUnits.indexOf('mzt-lzl') !== -1 && dirUnits.every((u) => u.indexOf('mzt-') === 0 && u !== 'mzt-hq' && u !== 'mzt-wx'), '3c units：總監＝全品牌 active 門市，不含辦公室、停用店、別品牌、ck', { dirUnits });
  g('3c units：一般同仁／店長 → []', [app.sb.attViewUnitsOf_(P('DZY210'), O, idxA), app.sb.attViewUnitsOf_(P('DZY211'), O, idxA), app.sb.attViewUnitsOf_(P('DZY250'), O, idxA)], [[], [], []]);
  g('3c units：停用狀態 → []', app.sb.attViewUnitsOf_(P('DZY260'), O, mkIdx({ DZY260: ['A'] })), []);

  // 沒有 regionIndexLive_、REGIONS_ON 未設／0 → 全空
  g('3c 開關未設：督導 view_people=[]', V('DZY201'), []);
  app.props.REGIONS_ON = '0';
  app.sb.regionIndexLive_ = () => idxA;
  g('3c 開關 0：督導／總監 view_people=[]', [V('DZY201'), V('DZY203')], [[], []]);
  app.props.REGIONS_ON = '1';
  g('3c 開關 1：督導甲＝A 區兩店需核工時的人（含店長），不含 B 區、辦公室、ck、總部、別品牌', V('DZY201'), ['DZY210', 'DZY211', 'DZY212', 'DZY213']);
  g('3c 未劃區督導 → []', V('DZY202'), []);
  app.sb.regionIndexLive_ = () => null;
  g('3c regionIndexLive_ 回 null → []', V('DZY201'), []);
  app.sb.regionIndexLive_ = () => { throw new Error('boom'); };
  g('3c regionIndexLive_ 丟例外 → []（不拖垮 ident）', V('DZY201'), []);
  delete app.sb.regionIndexLive_;
  g('3c 沒有 regionIndexLive_（regions 未合併）→ 督導 []', V('DZY201'), []);
  app.sb.regionIndexLive_ = () => idxA;
  const dv = V('DZY203');
  ok(has(dv, 'DZY210') && has(dv, 'DZY220') && !has(dv, 'DZY230') && !has(dv, 'DZY240') && !has(dv, 'DZY201') && !has(dv, 'DZY203') && !has(dv, 'DZY204'), '3c 總監＝全品牌門市（含 B 區店長）、不含別品牌、ck、辦公室、本人', { dv });
  g('3c 別品牌督導未劃區 → []', V('DZY231'), []);
  g('3c 一般同仁／店長 → []', [V('DZY210'), V('DZY211'), V('DZY240')], [[], [], []]);
  g('3c 停用督導 → 停用', app.ident('DZY260').active, false);
  g('3c admin／人資主管 view_people=[]', [app.ident('U:a001').att.view_people, V('DZY250')], [[], []]);
  // 項目形狀與 people 相同、各自排序
  const vp = app.ident('DZY201').att.view_people;
  ok(vp.length === 4 && vp.every((x) => eq(Object.keys(x), ['clock', 'emp_id', 'sub', 'name'])), '3c view_people 項目形狀同 people');

  // 現有 people／req_people 不受影響：同一組資料，開關 0 與 1 逐欄相同
  // （regions 設計下 REGIONS_ON=1 時督導的 req_people 本來就縮到該區，所以這裡只釘 people；req_people 另斷言）
  const snap = () => cast.map((c) => { const i = app.ident(c[0]); return i.att ? JSON.stringify([i.att.people]) : ''; });
  app.sheets.regions._data.push(['r-mzt-a', 'A區', 'mzt', 'mzt-gf,mzt-js', 'DZY201', 'TRUE', '2026-10-25 09:00:00', 'tester']);
  app.props.REGIONS_ON = '0';
  app.sb.regionCtxReset_();
  const before = snap();
  app.props.REGIONS_ON = '1';
  app.sb.regionCtxReset_();
  const after = snap();
  ok(eq(before, after), '3c 開關 0／1：每個人的 people 完全相同');
  const reqOf = (e) => app.ident(e).att.req_people.map((x) => x.sub).sort();
  g('3c REGIONS_ON=1：督導甲 req_people 只剩 A 區店長（DZY210、DZY212），不含 B 區店長', reqOf('DZY201'), ['DZY210', 'DZY212']);

  // 3d. 只看考勤的人也有排班管理選單（platform.sched，2026-10-25 Eason：總監唯讀看班表，跟只看考勤同一批）
  //     先拿掉所有 hq 打卡對照（那條是總部自填排班的路），這裡只測「只看名單」這條新路
  const row = (e) => staffRow(cast.find((c) => c[0] === e), 0);
  const scd = app.sheets.staff_clock ? app.sheets.staff_clock._data : null;
  if (scd) for (let i = scd.length - 1; i > 0; i--) if (scd[i][1] === 'hq') scd.splice(i, 1);
  app.sb.regionIndexLive_ = () => idxA;
  app.props.REGIONS_ON = '1';
  app.sb.regionCtxReset_();
  ok(app.sb.storeSchedGate_(row('DZY201')) === true, '3d 開關 1：負責 A 區的督導 → 有排班管理');
  ok(app.sb.storeSchedGate_(row('DZY203')) === true, '3d 開關 1：品牌總監 → 有排班管理');
  ok(app.sb.storeSchedGate_(row('DZY202')) === false, '3d 未劃區督導 → 沒有');
  ok(app.sb.storeSchedGate_(row('DZY204')) === false, '3d 品牌辦公室行政（ofs，沒有 hq 對照）→ 沒有');
  ok(app.sb.storeSchedGate_(row('DZY260')) === false, '3d 停用督導 → 沒有');
  ok(app.sb.storeSchedGate_(row('DZY211')) === false && app.sb.storeSchedGate_(row('DZY251')) === false, '3d 計時同仁、財務同仁 → 沒有');
  app.props.REGIONS_ON = '0';
  app.sb.regionCtxReset_();
  ok(app.sb.storeSchedGate_(row('DZY201')) === false && app.sb.storeSchedGate_(row('DZY203')) === false, '3d 開關 0：督導、總監都沒有（只看名單也是空的）');
  app.props.REGIONS_ON = '1';
  app.sb.regionIndexLive_ = () => { throw new Error('boom'); };
  ok(app.sb.storeSchedGate_(row('DZY201')) === false && app.sb.storeSchedGate_(row('DZY203')) === true, '3d 區域索引壞掉：督導 false（不拖垮登入），總監照常');
  app.sb.regionIndexLive_ = () => idxA;
  // 選單與 ident 一致：gate 為真 ⇔ view_people 非空
  ['DZY201', 'DZY202', 'DZY203', 'DZY204', 'DZY231'].forEach((e) => ok(app.sb.storeSchedViewGate_(row(e)) === (V(e).length > 0), '3d gate ⇔ view_people 非空：' + e, { gate: app.sb.storeSchedViewGate_(row(e)), view: V(e) }));
  // 區內門市都不在試點 → 只看名單空 → 沒有選單（不會出現點進去是空的）
  const pilotKeep = app.props.STORE_SSO_UNITS;
  app.props.STORE_SSO_UNITS = 'mala-gf';
  ok(app.sb.storeSchedViewGate_(row('DZY201')) === false && V('DZY201').length === 0, '3d 區內門市不在試點 → 督導沒有選單');
  app.props.STORE_SSO_UNITS = pilotKeep;
})();

// ============================================================
// 4. units_managed、void_units、epoch
// ============================================================
(() => {
  const app = world(BIG);
  const sm = app.ident('DZY001');
  ok(eq(sm.units_managed, ['mzt-gf']) && eq(sm.void_units, ['mzt-gf']), '4 店長：units_managed／void_units＝本人單位（預設規則 store sm → store.void）', sm);
  const ft = app.ident('DZY002');
  ok(eq(ft.units_managed, []) && eq(ft.void_units, []), '4 正職：沒有管理單位、沒有作廢權');
  const ck = app.ident('DZY006');
  ok(eq(ck.units_managed, ['ck']) && eq(ck.void_units, ['ck']), '4 央廚店長：單位 ck');
  const adm = app.ident('U:a001');
  ok(eq(adm.units_managed, ['ck', 'mala-gf', 'mzt-gf', 'mzt-js']) && eq(adm.void_units, adm.units_managed), '4 admin：試點內全部 store 階梯單位（含 ck、不含辦公室與總部）', adm);
  ok(eq(app.ident('DZY010').units_managed, []) && eq(app.ident('DZY020').void_units, []), '4 總監／人資主管預設無管理單位、無作廢權');
  // 人資主管給正職作廢權 → void_units
  const hrTok = app.login('DZY020');
  const sv = post(app.sb, 'permExSave', { emp_no: 'DZY002', perm: 'store.void', mode: 'add', until: '', note: '代班店長' }, hrTok);
  ok(sv.ok && eq(app.ident('DZY002').void_units, ['mzt-gf']), '4 store.void 例外 → void_units＝本人單位', sv);
  const rm = post(app.sb, 'permExSave', { emp_no: 'DZY001', perm: 'store.void', mode: 'remove', until: '', note: '暫停作廢' }, hrTok);
  ok(rm.ok && eq(app.ident('DZY001').void_units, []) && eq(app.ident('DZY001').units_managed, ['mzt-gf']), '4 店長被拿掉 store.void → void_units 空、units_managed 不變', rm);
  // epoch
  ok(app.ident('DZY001').epoch === '2026-01-05', '4 epoch＝到職日');
  ok(app.ident('DZY001').token_after === 0 && app.ident('U:a001').token_after === 0, '4 token_after：沒有＝0');
  app.sheets.users._data.find((r) => r[0] === 'a001')[10] = 1790000000123;
  const ux = app.sheets.users._data.find((r) => r[1] === 'DZY001'); ux[10] = '1790000009999';
  ok(app.ident('U:a001').token_after === 1790000000123 && app.ident('DZY001').token_after === 1790000009999 && typeof app.ident('DZY001').token_after === 'number', '4 token_after＝users 第 11 欄整數毫秒（admin、同仁皆是）');
  const rs0 = post(app.sb, 'svcStoreRoster', { svc_key: SVC, unit: 'mzt-gf' }).data.staff.find((x) => x.sub === 'DZY001');
  ok(rs0 && rs0.unit === 'mzt-gf' && rs0.epoch === '2026-01-05', '4 roster 每筆有 unit、epoch（到職日）');
  app.sheets.staff_log._data.push(['2026-09-01 09:00:00', 'DZY001', 'enable', 'u001', 'reinstate']);
  app.sheets.staff_log._data.push(['2026-10-05 09:00:00', 'DZY002', 'disable', 'u001', '']);
  ok(app.ident('DZY001').epoch === '2026-09-01' && app.ident('DZY002').epoch === '2026-02-01', '4 epoch＝到職與最近一次復職（enable／reinstate）較晚者；停用不算');
  const rsAll = post(app.sb, 'svcStoreRoster', { svc_key: SVC, unit: 'mzt-gf' }).data.staff;
  ok(rsAll.find((x) => x.sub === 'DZY001').epoch === '2026-09-01' && rsAll.every((x) => x.epoch === app.ident(x.sub).epoch), '4 roster epoch 與 ident 一致（復職較晚者）');
  const logSh = app.sheets.staff_log; const origGet = logSh.getRange.bind(logSh); let logReads = 0;
  logSh.getRange = (...a) => { logReads++; return origGet(...a); };
  post(app.sb, 'svcStoreRoster', { svc_key: SVC, unit: 'mzt-gf' });
  ok(logReads <= 1, '4 roster 整批只讀 staff_log 一次（不是每人一次）：讀了 ' + logReads + ' 次');
  logSh.getRange = origGet;
  app.sheets.staff._data.find((r) => r[0] === 'DZY003')[24] = '';
  ok(app.ident('DZY003').epoch === '2026-02-03', '4 沒有到職日 → 退回開通日（confirmed_at）');
  ok(app.ident('U:a001').epoch === '' && app.ident('U:a001').emp_no === '' && app.ident('U:a001').unit === '' && app.ident('U:a001').title === '', '4 admin 無同仁編號：epoch、emp_no、unit、title 皆空字串');
  // 停用的 admin → inactive
  app.sheets.users._data.find((r) => r[0] === 'a001')[7] = 'FALSE';
  ok(eq(app.ident('U:a001'), { sub: 'U:a001', active: false }), '4 admin 帳號停用 → inactive');
})();

// ============================================================
// 5. 試點開關 STORE_SSO_UNITS
// ============================================================
(() => {
  const app = world(BIG, { pilot: '' });
  const closed = app.ident('DZY001');
  ok(closed.active === true && closed.name === '店長一' && closed.sub === 'DZY001', '5 開關空＝全關：ident 照發（active、name 照回）');
  ok(eq(closed.pilot_units, []) && eq(closed.units_managed, []) && eq(closed.void_units, []) && eq(closed.att.people, []), '5 開關空：pilot_units、units_managed、void_units、att.people 全空', closed);
  ok(eq(app.ident('U:a001').units_managed, []) && eq(app.ident('U:a001').att.people, []), '5 開關空：admin 也是空');
  const t = post(app.sb, 'ssoTicket', { aud: 'store' }, app.login('DZY001'));
  ok(t.ok, '5 開關空仍發券（身分照發，spec §13.2-11）');
  const rd = post(app.sb, 'svcStoreRedeem', { svc_key: SVC, ticket: t.data.ticket, aud: 'store' });
  ok(rd.ok && rd.data.active === true, '5 開關空仍可兌換', rd);
  // 試點只含 mzt-gf
  app.props.STORE_SSO_UNITS = ' mzt-gf , mzt-gf,bad unit!,';
  ok(eq(app.ident('DZY001').pilot_units, ['mzt-gf']), '5 pilot_units 去空白、去重、丟掉格式錯的');
  ok(eq(app.ident('DZY001').units_managed, ['mzt-gf']) && eq(app.ident('DZY001').void_units, ['mzt-gf']), '5 試點內的店長：units_managed、void_units 保留');
  ok(eq(app.ident('DZY004').units_managed, []) && eq(app.ident('DZY004').void_units, []) && eq(app.ident('DZY004').att.people, []), '5 試點外的店長：身分照發、管理單位與名單全空');
  ok(app.ident('DZY004').active === true && eq(app.ident('DZY004').pilot_units, ['mzt-gf']), '5 試點外的店長 active 仍 true');
  const hr = app.people('DZY020');
  ok(hr.length > 0 && hr.every((x) => x.clock === 'mztgf'), '5 att.people 只留「被核的人」單位在試點內的（人資主管只剩 mzt-gf）', hr.map((x) => x.sub));
  ok(!app.subs('DZY020').includes('DZY004') && !app.subs('DZY020').includes('DZY013'), '5 試點外的人（別店、辦公室）不出現');
  ok(eq(app.ident('U:a001').units_managed, ['mzt-gf']) && eq(app.ident('U:a001').void_units, ['mzt-gf']) && app.people('U:a001').every((x) => x.clock === 'mztgf'), '5 admin：只剩試點內單位與人');
  // 人在試點、核定人不在試點：以「被核的人」所屬單位判斷（總部人資主管核試點店的人，仍可見）
  ok(app.subs('DZY020').includes('DZY001'), '5 核定人單位不在試點、被核的人在試點 → 仍可見（spec §13.2-11）');
  // 試點裡有 ck（含 ck 的 store 階梯）
  app.props.STORE_SSO_UNITS = 'ck,mzt-hq';
  ok(eq(app.ident('U:a001').units_managed, ['ck']), '5 admin：辦公室單位不算 store 階梯、ck 算');
  ok(eq(app.subs('DZY010'), ['DZY012', 'DZY013']), '5 辦公室在試點時總監名單照常（停用的 oam 不列）');
})();

// ============================================================
// 6. 人資主管可設 store.void／att.extra／platform.bulletin 例外；其他碼不行（2026-10-26 加公告管理）
// ============================================================
(() => {
  const app = world(BIG);
  const { sb } = app;
  const hrTok = app.login('DZY020');
  const ex = (tok, emp, perm, mode, extra) => post(sb, 'permExSave', Object.assign({ emp_no: emp, perm, mode: mode || 'add', until: '', note: '測試原因' }, extra || {}), tok);
  const audits = () => app.sheets.perm_audit._rows().slice(1);
  const a0 = audits().length;
  const s1 = ex(hrTok, 'DZY002', 'store.void');
  ok(s1.ok && /^X\d+/.test(s1.data.ex_id), '6 人資主管能設 store.void 例外', s1);
  const au = audits();
  ok(au.length === a0 + 1 && au[au.length - 1][1] === 'u020' && au[au.length - 1][2] === 'DZY002' && au[au.length - 1][3] === 'store.void' && au[au.length - 1][5] === 'perm_ex', '6 寫 perm_audit（誰、對誰、加了什麼、cause=perm_ex）', au[au.length - 1]);
  const s2 = ex(hrTok, 'DZY003', 'att.extra', 'add', { until: '2099-12-31' });
  ok(s2.ok, '6 人資主管能設 att.extra 例外（含到期日）', s2);
  // 2026-10-26：公告管理從同仁名單勾選搬進權限設定，人資主管可在個別例外給／拿掉
  const s3 = ex(hrTok, 'DZY004', 'platform.bulletin', 'add', { until: '2099-12-31' });
  ok(s3.ok && /^X\d+/.test(s3.data.ex_id), '6 人資主管能設 platform.bulletin 例外（公告管理）', s3);
  const au3 = audits();
  ok(au3[au3.length - 1][1] === 'u020' && au3[au3.length - 1][2] === 'DZY004' && au3[au3.length - 1][3] === 'platform.bulletin' && au3[au3.length - 1][5] === 'perm_ex', '6 platform.bulletin 例外寫 perm_audit', au3[au3.length - 1]);
  ok(ex(hrTok, 'DZY004', 'platform.bulletin', 'remove', { note: '暫停公告' }).ok, '6 人資主管能設 platform.bulletin 的 remove 例外');
  ok(ex(hrTok, 'DZY020', 'platform.bulletin').code === 'perm_self', '6 人資主管不能對自己設 platform.bulletin 例外');
  ok(ex(app.login('DZY021'), 'DZY004', 'platform.bulletin').code === 'no_perm' && ex(app.login('DZY001'), 'DZY004', 'platform.bulletin').code === 'no_perm', '6 人資同仁／店長不能設 platform.bulletin 例外');
  ok(ex(hrTok, 'DZY003', 'audit.read').code === 'no_perm', '6 ★人資主管不能設 audit.read');
  ok(ex(hrTok, 'DZY003', 'audit.write').code === 'no_perm' && ex(hrTok, 'DZY003', 'platform.staff').code === 'no_perm' && ex(hrTok, 'DZY003', 'platform.users').code === 'no_perm', '6 ★人資主管不能設其他任何碼（audit.write、platform.staff、platform.users）');
  ok(ex(hrTok, 'DZY003', 'payroll.write').code === 'no_perm' && ex(hrTok, 'DZY003', 'cashbook.write').code === 'no_perm' && ex(hrTok, 'DZY003', 'platform.permmap').code === 'no_perm', '6 ★人資主管不能設 payroll.write、cashbook.write、platform.permmap');
  ok(JSON.stringify(sb.STORE_HR_GRANTABLE) === JSON.stringify(['store.void', 'att.extra', 'platform.bulletin']), '6 STORE_HR_GRANTABLE＝store.void、att.extra、platform.bulletin');
  const audit = ex(hrTok, 'DZY003', 'audit.read.own');
  ok(audit.ok === false, '6 ★audit.* 例外被拒（不能設 audit.read.own）', audit);
  ok(ex(hrTok, 'DZY020', 'store.void').code === 'perm_self', '6 人資主管不能對自己設例外');
  ok(ex(app.login('DZY021'), 'DZY002', 'store.void').code === 'no_perm', '6 人資同仁（非主管）不能設');
  ok(ex(app.login('DZY001'), 'DZY002', 'store.void').code === 'no_perm', '6 店長不能設');
  ok(ex(app.login('DZY022'), 'DZY002', 'store.void').code === 'no_perm', '6 其他部門主管不能設');
  ok(ex(app.adminTok, 'DZY003', 'audit.read').ok === true, '6 admin 照舊可設任何碼');
  // 列表：人資主管只看得到自己管得到的兩碼
  const ls = post(sb, 'permExList', {}, hrTok);
  ok(ls.ok && ls.data.items.length >= 2 && ls.data.items.every((i) => ['store.void', 'att.extra', 'platform.bulletin'].includes(i.perm)) && ls.data.items.some((i) => i.perm === 'platform.bulletin'), '6 permExList：人資主管只看到 store.void／att.extra／platform.bulletin 例外', ls.data && ls.data.items.map((i) => i.perm));
  ok(post(sb, 'permExList', {}, app.login('DZY021')).code === 'no_perm', '6 permExList：非人資主管 no_perm');
  ok(post(sb, 'permExList', {}, app.adminTok).data.items.some((i) => i.perm === 'audit.read'), '6 permExList：admin 看全部');
  // 撤銷
  const adminEx = post(sb, 'permExList', {}, app.adminTok).data.items.find((i) => i.perm === 'audit.read');
  ok(post(sb, 'permExRevoke', { ex_id: adminEx.ex_id }, hrTok).code === 'no_perm', '6 ★人資主管不能撤銷 audit.read 例外');
  const a1 = audits().length;
  const rv = post(sb, 'permExRevoke', { ex_id: s1.data.ex_id }, hrTok);
  ok(rv.ok && audits().length === a1 + 1 && audits()[a1][4] === 'store.void' && audits()[a1][5] === 'perm_ex', '6 人資主管能撤銷 store.void 例外並寫 perm_audit', rv);
  ok(post(sb, 'permExRevoke', { ex_id: s1.data.ex_id }, hrTok).code === 'bad_state', '6 重複撤銷 → bad_state');
  ok(post(sb, 'permExRevoke', { ex_id: s2.data.ex_id }, app.login('DZY021')).code === 'no_perm', '6 非人資主管不能撤銷');
  ok(post(sb, 'permExRevoke', { ex_id: s3.data.ex_id }, hrTok).ok, '6 人資主管能撤銷 platform.bulletin 例外');
  // 人資主管給自己的例外：撤銷自己被別人設的也擋（perm_self）
  const toHr = post(sb, 'permExSave', { emp_no: 'DZY020', perm: 'att.extra', mode: 'add', until: '', note: '給人資主管' }, app.adminTok);
  ok(toHr.ok && post(sb, 'permExRevoke', { ex_id: toHr.data.ex_id }, hrTok).code === 'perm_self', '6 人資主管不能撤銷對自己的例外');
  // PERM_GRANTABLE／名稱／預設規則
  ok(has(sb.PERM_GRANTABLE, 'store.void') && has(sb.PERM_GRANTABLE, 'att.extra') && sb.permName_('store.void') === '收支作廢' && sb.permName_('att.extra') === '額外考勤核定', '6 PERM_GRANTABLE 含兩碼、中文名「收支作廢」「額外考勤核定」');
  ok(has(sb.PERM_GRANTABLE, 'platform.bulletin') && sb.PERM_LOCKED.indexOf('platform.bulletin') === -1, '6 PERM_GRANTABLE 含 platform.bulletin、不是鎖碼');
  ok(sb.PERM_DEFAULT_RULES.some((r) => r.join('|') === 'store||sm|store.void') && !sb.PERM_DEFAULT_RULES.some((r) => r[3] === 'att.extra'), '6 預設規則：store 階梯 sm → store.void；att.extra 只走例外');
  ok(sb.PERM_LOCKED.indexOf('store.void') === -1 && sb.PERM_LOCKED.indexOf('att.extra') === -1, '6 兩碼不是鎖碼');
  // 已初始化環境：補預設規則（只補不覆蓋）
  const old = world(BIG, { init: true });
  const mapRows = old.sheets.perm_map._data;
  const r20 = mapRows.findIndex((r, i) => i > 0 && r[3] === 'sm' && r[4] === 'store.void');
  mapRows.splice(r20, 1);                                       // 模擬少了店長 store.void 那一條
  ok(old.sb.permLoadTables_().rules.length === 35, '6 模擬正式環境：perm_map 少一條（新預設規則不會自動生效）');
  ok(eq(old.ident('DZY001').void_units, []), '6 正式環境未補規則前：店長沒有 store.void');
  ok(old.sb.storeopsPermSeed_({ role: 'staff', id: 'u1' }).error === 'no_perm', '6 補規則函式只有 admin');
  const sd = old.sb.storeopsPermSeed_({ role: 'admin', id: 'a001' });
  ok(sd.ok && eq(sd.added, ['R037']) && old.sheets.perm_map._data.length === 37, '6 補預設規則：只補缺的一條，流水號接在最大號後', sd);
  ok(eq(old.ident('DZY001').void_units, ['mzt-gf']), '6 補完後店長有 store.void');
  ok(eq(old.sb.storeopsPermSeed_({ role: 'admin', id: 'a001' }).added, []), '6 重跑不重複');
  old.sheets.perm_map._data.find((r, i) => i > 0 && r[3] === 'sm' && r[4] === 'store.void')[5] = 'FALSE';
  ok(eq(old.sb.storeopsPermSeed_({ role: 'admin', id: 'a001' }).added, []) && eq(old.ident('DZY001').void_units, []), '6 被人工停用的規則不會被補回（只補不覆蓋）');
})();

// ============================================================
// 7. platform.att 衍生權限
// ============================================================
(() => {
  const app = world(BIG);
  const { sb } = app;
  const perms = (u) => { const r = post(sb, 'login', { username: u, password: PW }); return r.ok ? r.data.perms : null; };
  const att = (u) => { const p = perms(u); return !!p && has(p, 'platform.att'); };
  ok(att('DZY001'), '7 店長（sm）有 platform.att');
  ok(att('DZY010'), '7 總監（odir）有');
  ok(att('DZY020') && att('DZY022'), '7 人資主管、部門主管（hm）有');
  ok(att('DZY025') && att('DZY026') && att('DZY027'), '7 ceo／gm／chair 有');
  ok(!att('DZY002') && !att('DZY003') && !att('DZY011') && !att('DZY013') && !att('DZY021') && !att('DZY023'), '7 正職、計時、停用的品牌辦公室區經理、行政、人資同仁、部門同仁沒有');
  ok(att('DZY012'), '7 區督導（osv）有（2026-10-21 起核品牌內店長的申請）');
  ok(has(perms('BOSS'), '*'), '7 admin 本來就是 *（前端 can 全過）');
  ok(!att('DZY040'), '7 有 att.extra 之前沒有');
  post(sb, 'permExSave', { emp_no: 'DZY040', perm: 'att.extra', mode: 'add', until: '', note: '額外核定' }, app.adminTok);
  ok(att('DZY040'), '7 有 att.extra 例外的人有 platform.att');
  const me = post(sb, 'me', {}, app.login('DZY040'));
  ok(me.ok && has(me.data.perms, 'platform.att'), '7 me 也回 platform.att', me.data && me.data.perms);
  // 離職後沒有（登入就被擋）
  ok(perms('DZY030') === null, '7 離職者登入被擋');
  // 不寫進 roles
  ok(!app.sheets.roles._rows().some((r) => String(r[2]).indexOf('platform.att') !== -1), '7 platform.att 沒有寫進 roles 分頁');
  // 沒有 StoreOps.gs 時（舊沙盒）閘門安全略過
  ok(typeof sb.storeAttGate_ === 'function', '7 storeAttGate_ 存在');
})();

// ============================================================
// 7b. 總開關 STORE_SSO_UNITS：platform.att／platform.storeops 兩個衍生權限
// ============================================================
(() => {
  const app = world(BIG, { pilot: '' });
  const { sb } = app;
  const perms = (u) => { const r = post(sb, 'login', { username: u, password: PW }); return r.ok ? r.data.perms : null; };
  const both = (u) => { const p = perms(u); return { att: has(p, 'platform.att'), ops: has(p, 'platform.storeops') }; };
  const none = { att: false, ops: false };
  // 總開關空：誰都沒有（含總監、店長）
  ok(['DZY001', 'DZY002', 'DZY010', 'DZY020', 'DZY025', 'DZY022'].every((u) => eq(both(u), none)), '7b 總開關空：店長、同仁、總監、人資主管、執行長都沒有 platform.att／platform.storeops');
  ok(has(perms('BOSS'), '*'), '7b 總開關空：admin 仍是 *（全權限，選單由 * 放行）');
  const me0 = post(sb, 'me', {}, app.login('DZY010'));
  ok(me0.ok && !has(me0.data.perms, 'platform.att') && !has(me0.data.perms, 'platform.storeops'), '7b 總開關空：me 也沒有');
  // 打開（只開 mzt-gf）
  app.props.STORE_SSO_UNITS = 'mzt-gf';
  ok(eq(both('DZY001'), { att: true, ops: true }), '7b 開了：試點店店長有 platform.att 與 platform.storeops');
  ok(eq(both('DZY002'), { att: false, ops: true }), '7b 開了：試點店正職只有 platform.storeops');
  ok(eq(both('DZY003'), { att: false, ops: true }), '7b 開了：試點店計時有 platform.storeops');
  ok(eq(both('DZY010'), { att: true, ops: true }), '7b 開了：總監有 platform.att 與 platform.storeops');
  ok(eq(both('DZY025'), { att: true, ops: true }), '7b 開了：執行長兩個都有');
  ok(eq(both('DZY023'), none) && eq(both('DZY021'), none) && eq(both('DZY024'), none), '7b 開了：總部財務同仁、人資同仁、管理部同仁沒有');
  ok(eq(both('DZY004'), { att: true, ops: false }) && eq(both('DZY005'), none), '7b 開了：試點外的店，店長只有 platform.att（既有規則）、計時沒有 platform.storeops');
  ok(eq(both('DZY042'), { att: true, ops: false }), '7b 開了：試點外另一品牌店長沒有 platform.storeops');
  ok(eq(both('DZY011'), none) && eq(both('DZY013'), none), '7b 開了：品牌辦公室區經理、行政沒有');
  const me1 = post(sb, 'me', {}, app.login('DZY002'));
  ok(me1.ok && has(me1.data.perms, 'platform.storeops'), '7b 開了：me 也回 platform.storeops');
  // att.extra 例外
  ok(eq(both('DZY040'), none), '7b 有 att.extra 之前沒有');
  post(sb, 'permExSave', { emp_no: 'DZY040', perm: 'att.extra', mode: 'add', until: '', note: '額外核定' }, app.adminTok);
  ok(eq(both('DZY040'), { att: true, ops: true }), '7b 有 att.extra 例外：兩個都有');
  // 再關掉
  app.props.STORE_SSO_UNITS = '';
  ok(eq(both('DZY001'), none) && eq(both('DZY040'), none), '7b 再關掉：立刻都沒有');
  ok(!app.sheets.roles._rows().some((r) => String(r[2]).indexOf('platform.storeops') !== -1), '7b platform.storeops 沒有寫進 roles 分頁');
  ok(typeof sb.storeOpsGate_ === 'function', '7b storeOpsGate_ 存在');
})();

// ============================================================
// 7c. platform.sched 衍生權限（排班管理，2026-10-24 Eason：只給能排班的人）
// ============================================================
(() => {
  const app = world(BIG);
  const { sb } = app;
  const perms = (u) => { const r = post(sb, 'login', { username: u, password: PW }); return r.ok ? r.data.perms : null; };
  const att_has = (s2, u) => { const r = post(s2, 'login', { username: u, password: PW }); return r.ok && has(r.data.perms, 'platform.att'); };
  const sched = (u) => { const p = perms(u); return !!p && has(p, 'platform.sched'); };
  ok(sb.STORE_SCHED_GATE_TITLES.slice().sort().join() === 'am,fm,sm', '7c STORE_SCHED_GATE_TITLES＝sm／fm／am');
  ok(sb.STORE_SCHED_GATE_LADDERS.slice().sort().join() === 'hq,office', '7c STORE_SCHED_GATE_LADDERS＝hq／office（2026-10-25 總部自填排班）');
  ok(sched('DZY001') && sched('DZY004') && sched('DZY008') && sched('DZY042'), '7c 店長（sm）有 platform.sched');
  ok(sched('DZY006'), '7c 廠長（fm）有');
  ok(sched('DZY020'), '7c 人資主管有');
  ok(sched('DZY010') && sched('DZY014'), '7c 品牌辦公室總監（odir，ladder office）有（2026-10-25 起）');
  ok(sched('DZY012') && sched('DZY013') && sched('DZY015') && sched('DZY011'), '7c 品牌辦公室區督導（osv）、行政（ofs）、舊資料 oam 有');
  ok(sched('DZY022'), '7c 非人資的部門主管（hm，ladder hq）有');
  ok(sched('DZY025') && sched('DZY026') && sched('DZY027'), '7c ceo／gm／chair（ladder hq）有');
  ok(sched('DZY021') && sched('DZY023') && sched('DZY024'), '7c 總部人資同仁、部門同仁、管理部同仁（hs）有');
  ok(!sched('DZY002') && !sched('DZY003') && !sched('DZY007') && !sched('DZY005') && !sched('DZY041'), '7c 門市／央廚正職、計時（ladder store 非 sm／fm／am）沒有');
  ok(sched('DZY001') && att_has(sb, 'DZY010') && sched('DZY010'), '7c 對照：總監兩個都有');
  ok(perms('DZY030') === null, '7c 停用（離職）者登入被擋、拿不到');
  ok(has(perms('BOSS'), '*'), '7c admin 靠 * 全過');
  ok(!sched('DZY040'), '7c 有 att.extra 之前沒有');
  post(sb, 'permExSave', { emp_no: 'DZY040', perm: 'att.extra', mode: 'add', until: '', note: '額外核定' }, app.adminTok);
  ok(!sched('DZY040') && att_has(sb, 'DZY040'), '7c att.extra 例外不給 platform.sched（只給 platform.att）');
  const me = post(sb, 'me', {}, app.login('DZY001'));
  ok(me.ok && has(me.data.perms, 'platform.sched'), '7c me 也回 platform.sched', me.data && me.data.perms);
  ok(!app.sheets.roles._rows().some((r) => String(r[2]).indexOf('platform.sched') !== -1), '7c platform.sched 沒有寫進 roles 分頁');
  ok(typeof sb.storeSchedGate_ === 'function', '7c storeSchedGate_ 存在');
  // 停用 → 閘門直接 false（不經登入）
  const row = BIG.find((p) => p[0] === 'DZY001');
  const dead = staffRow(['DZY001', row[1], row[2], row[3], 'sm', 'disabled', row[6]], 0);
  ok(sb.storeSchedGate_(dead) === false && sb.storeSchedGate_(null) === false, '7c 停用的店長、空列 → false');
  const hqRow = BIG.find((p) => p[0] === 'DZY023');
  ok(sb.storeSchedGate_(staffRow(hqRow, 0)) === true, '7c 總部同仁（ladder hq）→ true');
  ok(sb.storeSchedGate_(staffRow([hqRow[0], hqRow[1], hqRow[2], hqRow[3], hqRow[4], 'disabled', hqRow[6]], 0)) === false, '7c 停用的總部同仁 → false');
  // 總部／辦公室同仁還要有 hq 打卡對照（confirmed、roster_active 不是 FALSE、store_code=hq），跟 ident.self 同一套
  const scd = app.sheets.staff_clock._data;
  const hqIdx = (e) => scd.findIndex((r, i) => i > 0 && r[0] === e && r[1] === 'hq');
  const i23 = hqIdx('DZY023');
  ok(i23 > 0 && sched('DZY023'), '7c 總部同仁有 hq 對照 → 有');
  scd[i23][6] = 'FALSE';
  ok(!sched('DZY023') && sb.storeSchedGate_(staffRow(hqRow, 0)) === false, '7c hq 對照 roster_active=FALSE → 沒有');
  scd[i23][6] = ''; scd[i23][4] = 'pending';
  ok(!sched('DZY023'), '7c hq 對照還沒確認（pending）→ 沒有');
  scd[i23][4] = 'confirmed';
  ok(sched('DZY023'), '7c 對照恢復 → 又有');
  const keep = scd.splice(i23, 1)[0];
  ok(!sched('DZY023'), '7c 完全沒有 hq 對照 → 沒有選單');
  ok(sched('DZY001') && sched('DZY020'), '7c 店長、人資主管不受 hq 對照影響');
  scd.splice(i23, 0, keep);
  // 總開關空 → 沒有
  app.props.STORE_SSO_UNITS = '';
  ok(!sched('DZY001') && !sched('DZY020') && !sched('DZY006') && !sched('DZY023') && !sched('DZY010'), '7c 試點空：店長、人資主管、廠長、總部同仁、辦公室總監都沒有');
  ok(has(perms('BOSS'), '*'), '7c 試點空：admin 仍是 *');
  app.props.STORE_SSO_UNITS = 'mzt-gf';
  ok(sched('DZY001'), '7c 試點開回來：店長又有');
})();

// ============================================================
// 7c. 主店打卡推算（2026-10-18 Eason 選 A）：沒單位職稱的同仁，用 staff_clock 的主店（role=home）推算單位
// ============================================================
(() => {
  const E = (emp, name, status, unit, title) => [emp, name, unit, '', title, status, '2026-03-01'];
  const cast = [
    E('DZY101', '光復店長', 'active', 'mala-gf', 'sm'),
    E('DZY102', '未認領甲', 'unclaimed', '', ''),         // 主店 gf → mala-gf
    E('DZY103', '總部無職稱', 'unclaimed', '', ''),       // 主店 hq（四個單位）→ 不推算
    E('DZY104', '正式計時', 'active', 'mala-gf', 'pt'),   // 正式資料
    E('DZY105', '央廚未認領', 'unclaimed', '', ''),       // 主店 cf → ck
    E('DZY106', '只有支援店', 'unclaimed', '', ''),       // 沒有 home → 不推算
    E('DZY107', '正式資料在別店', 'active', 'mzt-gf', 'ft'),   // 主店 gf，但正式資料是 mzt-gf → 不受推算影響
    E('DZY108', '責任制無單位', 'unclaimed', '', 'hm'),   // 有職稱且責任制 → 不列
    E('DZY109', '已離職無資料', 'disabled', '', ''),      // 離職 → 不列
    E('DZY110', '單位停用', 'unclaimed', 'mzt-wx', 'pt'), // 單位已停用視為不完整，主店 gf → mala-gf
    E('DZY120', '人資主管', 'active', 'dzy-hq', 'hm'),
    E('DZY121', '財務主管', 'active', 'dzy-hq', 'hm'),
    E('DZY122', '總監', 'active', 'mala-hq', 'odir')
  ];
  cast[10][3] = 'hr'; cast[11][3] = 'fin';
  const build = (pilot) => {
    const app = world(cast, { pilot });
    const sc = app.sheets.staff_clock._data;
    const homeOf = { DZY101: 'gf', DZY102: 'gf', DZY103: 'hq', DZY104: 'gf', DZY105: 'cf', DZY107: 'gf', DZY108: 'gf', DZY109: 'gf', DZY110: 'gf' };
    sc.length = 1;
    Object.keys(homeOf).forEach((e) => sc.push([e, homeOf[e], homeOf[e].toUpperCase() + e.slice(3), 'home', 'confirmed', 'created', 'TRUE', '', '', '', '']));
    sc.push(['DZY106', 'gf', 'GF106', 'support', 'confirmed', 'created', 'TRUE', '', '', '', '']);   // 只有支援
    sc.push(['DZY120', 'hq', 'HQ120', 'home', 'confirmed', 'created', 'TRUE', '', '', '', '']);
    return app;
  };
  const app = build(PERMS_ALL_PILOT);
  const sm = app.subs('DZY101');
  ok(has(sm, 'DZY102'), '7c 光復店長名單含未認領、無單位職稱但主店是 gf 的同仁', sm);
  ok(has(sm, 'DZY110'), '7c 單位代碼已停用也算不完整，改用主店推算', sm);
  ok(has(sm, 'DZY104') && has(sm, 'DZY101'), '7c 正式資料的計時與店長自己照舊在名單');
  ok(!has(sm, 'DZY103') && !has(sm, 'DZY105') && !has(sm, 'DZY106') && !has(sm, 'DZY108') && !has(sm, 'DZY109'), '7c 店長名單不含：主店 hq、主店 cf、無主店、責任制、離職', sm);
  // 2026-10-26 支援打卡（docs/att-support/spec.md §1）：DZY107 正式單位 mzt-gf、打卡帳號在 gf（mala-gf）＝支援帳號 → 改由打卡店 mala-gf 店長核。
  //   推算本身仍不影響他：以人為單位的名單（storeAttTargets_）沒有他；他出現在光復店長名單是因為支援規則，不是推算。
  const org7 = app.sb.stfReadOrg_();
  const pp7 = () => app.sb.storePeople_();
  const smMe = pp7().find((x) => x.emp === 'DZY101');
  ok(!app.sb.storeAttTargets_(smMe, {}, pp7(), org7, app.sb.storeHomeFn_(), 'hours').some((x) => x.emp === 'DZY107'), '7c 有正式單位職稱的人不受推算影響（以人為單位的名單不含正式資料是 mzt-gf 的人）');
  ok(has(sm, 'DZY107') && app.people('DZY101').filter((x) => x.sub === 'DZY107').every((x) => x.clock === 'gf'), '7c （2026-10-26 起）他在 gf 的打卡帳號是支援帳號 → 由光復店長核（支援規則，不是推算）');
  const inf = app.people('DZY101').find((x) => x.sub === 'DZY102');
  ok(inf && inf.clock === 'gf' && inf.emp_id === 'GF102', '7c 推算出的人換成打卡帳號（店別 gf、編號 GF102）', inf);
  // 只有人資主管與管理員看得到不推算的人
  const hr = app.subs('DZY120'), adm = app.subs('U:a001');
  ok(has(hr, 'DZY103') && has(adm, 'DZY103'), '7c 主店 hq 的無職稱同仁出現在人資主管與管理員名單', { hr, adm });
  ok(has(hr, 'DZY102') && has(adm, 'DZY102') && has(hr, 'DZY105') && has(adm, 'DZY105'), '7c 人資主管與管理員也看得到推算出的人');
  ok(!has(hr, 'DZY108') && !has(adm, 'DZY108') && !has(hr, 'DZY109') && !has(adm, 'DZY109'), '7c 責任制職稱、離職不因為沒單位就被帶進全部名單');
  ok(!has(app.subs('DZY122'), 'DZY103') && !has(app.subs('DZY121'), 'DZY103') && !has(app.subs('DZY101'), 'DZY103'), '7c 主店 hq 的無職稱同仁不在總監、部門主管、店長名單');
  ok(!has(hr, 'DZY106') && !has(adm, 'DZY106'), '7c 沒有主店打卡（只有支援）的人不推算也沒有可列的主店帳號');
  // 補上正式單位＋職稱後完全用正式資料：DZY102 改成 mzt-gf 正職 → 不再出現在光復名單
  const row = app.sheets.staff._data.find((r) => r[0] === 'DZY102');
  row[3] = 'active'; row[5] = 'mzt-gf'; row[7] = 'ft';
  // 2026-10-26：補完後他在 gf 的帳號變成「支援帳號」（正式單位 mzt-gf），仍由打卡店光復店長核——但已不是推算（inferred），以人為單位的名單沒有他
  ok(!app.sb.storeAttTargets_(smMe, {}, pp7(), org7, app.sb.storeHomeFn_(), 'hours').some((x) => x.emp === 'DZY102'), '7c 補上正式 unit＋title 後不再推算（以人為單位的 mala-gf 店長名單沒有他）');
  ok(app.sb.storeEffectiveTarget_(pp7().find((x) => x.emp === 'DZY102'), org7, app.sb.storeHomeFn_()).inferred !== true && has(app.subs('DZY101'), 'DZY102'), '7c （2026-10-26 起）補完後他的 gf 帳號是支援帳號 → 光復店長照支援規則核');
  // 推算單位不在試點清單 → 不出現
  const app2 = build('mzt-gf');
  ok(!has(app2.subs('U:a001'), 'DZY102') && !has(app2.subs('U:a001'), 'DZY105') && !has(app2.subs('DZY120'), 'DZY103'), '7c 推算單位不在試點清單時不出現（admin 與人資主管也一樣）');
  const app3 = build('ck');
  ok(has(app3.subs('U:a001'), 'DZY105') && !has(app3.subs('U:a001'), 'DZY102'), '7c 試點只開 ck：只剩推算為 ck 的人');
  // 不能核自己的規則照舊；沒給 home 就不推算
  const org = app.sb.stfReadOrg_();
  const me = { emp: 'DZY102', status: 'unclaimed', unit: '', dept: '', title: '' };
  const home = () => ({ units: ['mala-gf'] });
  const pp = [me, { emp: 'DZY103', status: 'unclaimed', unit: '', dept: '', title: '' }];
  ok(eq(app.sb.storeAttTargets_(me, { admin: true }, pp, org, home).map((x) => x.emp), ['DZY103']), '7c 不能核自己的規則照舊（推算的人也不含自己）');
  ok(app.sb.storeAttTargets_({ emp: 'DZY101', status: 'active', unit: 'mala-gf', dept: '', title: 'sm' }, {}, pp, org, null).length === 0, '7c 沒給 home 對照就不推算');
})();

// ============================================================
// 7d. ident.self（總部排班身分，2026-10-25 docs/schedule-hq/spec.md §3.1）
// ============================================================
(() => {
  const app = world(BIG, { pilot: 'mala-gf', admins: [['u_admin01', 'BOSS', '系統管理員']] });   // 試點只有 mala-gf：總部不在試點內，self 也要照給
  const sc = app.sheets.staff_clock._data;
  sc.length = 1;
  const row = (emp, store, id, role, state, active) => sc.push([emp, store, id, role, state, 'created', active, '', '', '', '']);
  row('DZY023', 'hq', 'H023', 'staff', 'confirmed', 'TRUE');     // 部門同仁
  row('DZY022', 'hq', 'H022', 'staff', 'confirmed', 'TRUE');     // 部門總監（hm）
  row('DZY025', 'hq', 'H025', 'staff', 'confirmed', 'TRUE');     // 執行長
  row('DZY024', 'hq', 'H024', 'home', 'confirmed', 'TRUE');      // 管理部同仁（role home 也算）
  row('DZY021', 'hq', 'H021', 'staff', 'pending', 'TRUE');       // 未確認 → 不列
  row('DZY015', 'hq', 'H015', 'staff', 'confirmed', 'FALSE');    // roster_active FALSE → 不列
  row('DZY013', 'hq', 'H013', 'staff', 'confirmed', 'TRUE');     // 品牌辦公室行政
  row('DZY013', 'hq', 'H013', 'staff', 'confirmed', 'TRUE');     // 重複列只算一筆
  row('DZY001', 'mztgf', 'MZTGF01', 'staff', 'confirmed', 'TRUE');   // 只有門市打卡 → []
  row('DZY020', 'hq', 'H020', 'staff', 'confirmed', 'TRUE');     // 人資主管
  row('DZY020', 'hq', 'H020B', 'staff', 'confirmed', 'TRUE');
  row('DZY020', 'gf', 'G020', 'staff', 'confirmed', 'TRUE');     // 非 hq 的對照不列
  const self = (sub) => app.ident(sub).self;
  ok(eq(self('DZY023'), [{ clock: 'hq', emp_id: 'H023', approval: true }]), '7d 部門同仁：self 一筆、approval true（同部門總監核）', self('DZY023'));
  ok(eq(self('DZY022'), [{ clock: 'hq', emp_id: 'H022', approval: false }]), '7d 部門總監：approval false（考勤沒人核他）', self('DZY022'));
  ok(eq(self('DZY025'), [{ clock: 'hq', emp_id: 'H025', approval: false }]), '7d 執行長：approval false', self('DZY025'));
  ok(eq(self('DZY024'), [{ clock: 'hq', emp_id: 'H024', approval: true }]), '7d 管理部同仁（role home）：approval true（執行長以上核）', self('DZY024'));
  ok(eq(self('DZY013'), [{ clock: 'hq', emp_id: 'H013', approval: true }]), '7d 品牌辦公室行政：approval true；重複對照只算一筆', self('DZY013'));
  ok(eq(self('DZY021'), []), '7d 未確認（state≠confirmed）的對照不列');
  ok(eq(self('DZY015'), []), '7d roster_active＝FALSE 的對照不列');
  ok(eq(self('DZY001'), []), '7d 只有門市打卡、沒有 hq 對照 → []');
  ok(eq(self('DZY020'), [{ clock: 'hq', emp_id: 'H020', approval: false }, { clock: 'hq', emp_id: 'H020B', approval: false }]), '7d 人資主管（hm）approval false；多筆 hq 依 emp_id 排序、非 hq（gf）不列', self('DZY020'));
  ok(eq(self('U:u_admin01'), []), '7d admin 沒有同仁編號 → []');
  ok(Array.isArray(app.ident('DZY023').self) && keysOf(app.ident('DZY023')).slice(-2).join() === 'att,self', '7d self 是 ident 最後一個欄位（att 之後）');
  // 沒有任何同仁用打卡資料時（打卡分頁沒建）不炸
  const sbNoClk = world(BIG, { pilot: 'mala-gf' });
  ok(Array.isArray(sbNoClk.ident('DZY023').self), '7d 沒有任何對照列 → self 仍是陣列');
})();

// ============================================================
// 9. 支援打卡誰來核（2026-10-26 Eason 定案，docs/att-support/spec.md §1）：名單依「每一個打卡帳號所在的店」算
// ============================================================
(() => {
  const P = (emp, name, unit, dept, title, status) => ({ emp, name, unit, dept, title, status: status || 'active' });
  const BASE = [
    P('DZY301', '辛光店長', 'mala-gf', '', 'sm'),
    P('DZY302', '辛光計時', 'mala-gf', '', 'pt'),
    P('DZY303', '墨光店長', 'mzt-gf', '', 'sm'),
    P('DZY304', '墨光計時', 'mzt-gf', '', 'pt'),
    P('DZY305', '金山店長', 'mzt-js', '', 'sm'),
    P('DZY306', '金山區經理', 'mzt-js', '', 'am'),
    P('DZY307', '六張犁計時', 'mzt-lzl', '', 'pt'),
    P('DZY308', '墨督導', 'mzt-hq', '', 'osv'),
    P('DZY309', '墨總監', 'mzt-hq', '', 'odir'),
    P('DZY310', '央廚廠長', 'ck', '', 'fm'),
    P('DZY311', '廚藝總監', 'ck', '', 'rdd'),
    P('DZY312', '央廚計時', 'ck', '', 'pt'),
    P('DZY313', '資訊同仁', 'dzy-hq', 'it', 'hs'),
    P('DZY314', '資訊總監', 'dzy-hq', 'it', 'hm'),
    P('DZY315', '人資主管', 'dzy-hq', 'hr', 'hm'),
    P('DZY316', '辛總監', 'mala-hq', '', 'odir'),
    P('DZY317', '辛行政', 'mala-hq', '', 'ofs'),
    P('DZY318', '墨光額外核定', 'mzt-gf', '', 'ft')
  ];
  const M = (emp, store, id) => ({ emp_no: emp, store_code: store, emp_id: id, role: 'staff', state: 'confirmed', roster_active: 'TRUE' });
  const MAPS = [
    M('DZY301', 'gf', 'GF01'), M('DZY302', 'gf', 'GF02'), M('DZY302', 'mztgf', 'MG02'),
    M('DZY303', 'mztgf', 'MG03'), M('DZY303', 'mztjs', 'MJ03'),
    M('DZY304', 'mztgf', 'MG04'), M('DZY304', 'mztlzl', 'ML04'),
    M('DZY305', 'mztjs', 'MJ05'), M('DZY306', 'mztjs', 'MJ06'), M('DZY307', 'mztlzl', 'ML07'),
    M('DZY308', 'hq', 'H08'), M('DZY310', 'cf', 'CF10'), M('DZY311', 'cf', 'CF11'), M('DZY312', 'cf', 'CF12'), M('DZY312', 'mztgf', 'MG12'),
    M('DZY313', 'hq', 'H13'), M('DZY313', 'gf', 'GF13'), M('DZY314', 'hq', 'H14'), M('DZY317', 'hq', 'H17'), M('DZY318', 'mztgf', 'MG18')
  ];
  const app = world([['DZY399', '佔位', 'mala-gf', '', 'pt', 'active', '2026-01-01']]);
  const sb = app.sb;
  const org = sb.stfReadOrg_();
  const SU = sb.storeClockUnits_();
  ok(eq(SU.gf, ['mala-gf']) && eq(SU.mztgf, ['mzt-gf']) && eq(SU.cf, ['ck']) && SU.hq.indexOf('mzt-hq') !== -1, '9 預設 clock_stores：gf=mala-gf、mztgf=mzt-gf、cf=ck、hq 多單位', SU);
  const ALL = ['ck', 'dzy-hq', 'mala-gf', 'mala-hq', 'mzt-gf', 'mzt-hq', 'mzt-js', 'mzt-lzl'];
  const keys = (arr) => arr.map((x) => x.clock + ':' + x.emp_id);
  const run = (meEmp, o) => {
    o = o || {};
    const people = o.people || BASE;
    const me = meEmp ? people.find((p) => p.emp === meEmp) : { emp: '', status: 'active', unit: '', dept: '', title: '' };
    const r = sb.storeAttLists_(me, o.flags || {}, people, org, null, o.maps || MAPS, o.su || SU, o.rctx || null, o.pilot || ALL, o.opt || {});
    return { h: keys(r.people), r: keys(r.req_people), v: keys(r.view_people), raw: r };
  };
  const g = (label, got, want) => ok(eq(got, want), label, { got, want });

  // 9a. 支援帳號判斷
  const T = (unit, extra) => Object.assign({ emp: 'X', unit }, extra || {});
  ok(sb.storeAttIsSupport_(T('mala-gf'), 'mztgf', ['mzt-gf']) === true, '9a 打卡店單位不含本人單位 → 支援（不看 role）');
  ok(sb.storeAttIsSupport_(T('mzt-gf'), 'mztgf', ['mzt-gf']) === false, '9a 在自己單位的店打卡 → 不是支援');
  ok(sb.storeAttIsSupport_(T('dzy-hq'), 'hq', ['mzt-hq']) === false && sb.storeAttIsSupport_(T('mala-gf'), 'hq', ['dzy-hq', 'mzt-hq', 'mala-hq']) === false, '9a ★總部打卡 hq 一律不算支援（就算單位不在 hq 的清單裡）');
  ok(sb.storeAttIsSupport_(T('mala-gf', { inferred: true }), 'mztgf', ['mzt-gf']) === false && sb.storeAttIsSupport_(T('', { orphan: true }), 'mztgf', ['mzt-gf']) === false, '9a 推算／orphan 的人不套支援規則');
  ok(sb.storeAttIsSupport_(T('mzt-js'), 'mztlzl', ['mzt-lzl', 'mzt-js']) === false && sb.storeAttIsSupport_(T('mzt-gf'), 'mztlzl', ['mzt-lzl', 'mzt-js']) === true, '9a 多單位的店：本人單位在清單任一個 → 不是支援；都不在 → 支援');
  ok(sb.storeAttIsSupport_(T('mzt-gf'), 'zz', []) === false, '9a 打卡店沒填單位（或不在 clock_stores）→ 照舊不算支援');
  ok(sb.storeAttIsSupport_(T('mzt-hq'), 'mztgf', ['mzt-gf'], org) === false && sb.storeAttIsSupport_(T('mzt-hq'), 'mztgf', ['mzt-gf']) === true,
    '9a ★2026-10-26 品牌辦公室同仁到門市打卡不算支援（給 org 時）');
  {
    const maps = MAPS.concat([M('DZY308', 'mztgf', 'MG08'), M('DZY317', 'gf', 'GF17')]);
    const s303 = run('DZY303', { maps }), s309 = run('DZY309', { maps }), s301 = run('DZY301', { maps }), s316 = run('DZY316', { maps });
    ok(s303.h.indexOf('mztgf:MG08') === -1 && s303.r.indexOf('mztgf:MG08') === -1 && s303.v.indexOf('mztgf:MG08') === -1, '9a ★督導在墨光打卡：墨光店長不核也不看', s303);
    ok(s309.h.indexOf('mztgf:MG08') !== -1 && s309.r.indexOf('mztgf:MG08') !== -1, '9a ★督導在墨光打卡：照原規則由墨竹亭總監核（工時與申請）', s309);
    ok(s301.h.indexOf('gf:GF17') === -1 && s316.h.indexOf('gf:GF17') !== -1, '9a ★小辛辣行政在光復打卡：光復店長不核、小辛辣總監核', { s301: s301.h, s316: s316.h });
  }
  const ac = sb.storeAttAccounts_(BASE, org, null, MAPS.concat([Object.assign(M('DZY301', 'mztgf', 'MGX'), { state: 'pending' }), Object.assign(M('DZY301', 'mztjs', 'MJX'), { roster_active: 'FALSE' })]), SU);
  ok(!ac.some((a) => a.m.emp_id === 'MGX' || a.m.emp_id === 'MJX'), '9a 帳號只算 confirmed、roster_active 不是 FALSE');
  ok(eq(ac.filter((a) => a.support).map((a) => a.m.emp_id).sort(), ['GF13', 'MG02', 'MG12', 'MJ03', 'ML04']), '9a 這份資料的支援帳號：辛光計時在墨光、墨光店長在金山、墨光計時在六張犁、央廚計時在墨光、資訊同仁在辛光');

  // 9b. 支援帳號由打卡店主管核（工時＋申請）、原單位主管只看
  const s301 = run('DZY301');
  g('9b 辛光店長 工時：自己、本店計時、到本店支援的資訊同仁（總部同仁到門市也一樣，5A）；不含本店計時在墨光的帳號', s301.h, ['gf:GF01', 'gf:GF02', 'gf:GF13']);
  g('9b 辛光店長 申請：本店計時、資訊同仁在本店的帳號（不含自己）', s301.r, ['gf:GF02', 'gf:GF13']);
  g('9b ★原單位主管只看（4B）：辛光店長看得到本店計時在墨光的帳號，只看不核', s301.v, ['mztgf:MG02']);
  const s303 = run('DZY303');
  g('9b 墨光店長 工時：自己、本店計時、到墨光支援的辛光計時與央廚計時；不含自己在金山的支援帳號', s303.h, ['mztgf:MG02', 'mztgf:MG03', 'mztgf:MG04', 'mztgf:MG12', 'mztgf:MG18']);
  g('9b 墨光店長 申請：同上但不含自己', s303.r, ['mztgf:MG02', 'mztgf:MG04', 'mztgf:MG12', 'mztgf:MG18']);
  g('9b 墨光店長 只看：本店計時在六張犁的支援帳號；自己的支援帳號不列', s303.v, ['mztlzl:ML04']);
  const s305 = run('DZY305');
  g('9b ★店長去別店支援：金山店長核墨光店長在金山的工時', s305.h, ['mztjs:MJ03', 'mztjs:MJ05', 'mztjs:MJ06']);
  g('9b ★店長去別店支援：申請也由金山店長核（2A）；店長本人與區經理的申請照舊不歸他', s305.r, ['mztjs:MJ03']);
  g('9b 區經理：第一層有店長就不輪到區經理；自己店店長的申請照舊', [run('DZY306').h, run('DZY306').r, run('DZY306').v], [[], ['mztjs:MJ05'], []]);
  g('9b ★總部同仁去門市：資訊總監只核總部帳號，門市那個帳號只看', [run('DZY314').h, run('DZY314').r, run('DZY314').v], [['hq:H13'], ['hq:H13'], ['gf:GF13']]);
  g('9b 一般同仁沒有名單', [run('DZY302').h, run('DZY302').r, run('DZY302').v], [[], [], []]);

  // 9c. 打卡店沒有店長時往上找（3A）：六張犁沒有店長／區經理
  const s309 = run('DZY309');
  ok(has(s309.h, 'mztlzl:ML04') && has(s309.r, 'mztlzl:ML04'), '9c 第 4 層：店長、區經理都沒有、區域開關關 → 品牌總監核（工時＋申請）', s309);
  ok(!has(run('DZY308').h, 'mztlzl:ML04') && !has(run('DZY308').r, 'mztlzl:ML04'), '9c 區域開關關：督導不核支援帳號（跳過第 3 層）');
  const idx = { byStore: { 'mzt-lzl': 'r1' }, byRegion: { r1: { code: 'r1', stores: ['mzt-lzl'], supervisorEmp: 'DZY308' } }, bySupervisor: { DZY308: ['r1'] } };
  const on = { on: true, idx };
  g('9c 第 3 層：區域開關開、負責那區的督導 → 督導核（工時＋申請）', [run('DZY308', { rctx: on }).h, run('DZY308', { rctx: on }).r], [['mztlzl:ML04'], ['mztlzl:ML04']]);
  ok(!has(run('DZY309', { rctx: on }).h, 'mztlzl:ML04') && !has(run('DZY309', { rctx: on }).r, 'mztlzl:ML04'), '9c 第 3 層有人 → 總監不核');
  const noSup = { on: true, idx: { byStore: { 'mzt-lzl': 'r1' }, byRegion: { r1: { code: 'r1', stores: ['mzt-lzl'], supervisorEmp: '' } }, bySupervisor: {} } };
  ok(has(run('DZY309', { rctx: noSup }).h, 'mztlzl:ML04') && !has(run('DZY308', { rctx: noSup }).h, 'mztlzl:ML04'), '9c 區沒督導（或沒劃區）→ 跳過第 3 層，總監核');
  const otherReg = { on: true, idx: { byStore: { 'mzt-lzl': 'r2' }, byRegion: { r2: { code: 'r2', stores: ['mzt-lzl'], supervisorEmp: 'DZY399' } }, bySupervisor: { DZY399: ['r2'] } } };
  ok(!has(run('DZY308', { rctx: otherReg }).h, 'mztlzl:ML04') && has(run('DZY309', { rctx: otherReg }).h, 'mztlzl:ML04'), '9c 那區的督導是別人且不在職（不在 people）→ 本督導不核；第 3 層沒人 → 總監核');
  const plusAm = BASE.concat([P('DZY320', '六張犁區經理', 'mzt-lzl', '', 'am')]);
  g('9c 第 2 層：沒有店長、有區經理 → 區經理核（工時＋申請）', [run('DZY320', { people: plusAm }).h, run('DZY320', { people: plusAm }).r], [['mztlzl:ML04'], ['mztlzl:ML04']]);
  ok(!has(run('DZY309', { people: plusAm }).h, 'mztlzl:ML04'), '9c 第 2 層有人 → 總監不核');
  const plusSm = plusAm.concat([P('DZY321', '六張犁店長', 'mzt-lzl', '', 'sm')]);
  ok(has(run('DZY321', { people: plusSm }).h, 'mztlzl:ML04') && !has(run('DZY320', { people: plusSm }).h, 'mztlzl:ML04') && !has(run('DZY320', { people: plusSm }).r, 'mztlzl:ML04'), '9c 第 1 層：有店長 → 只有店長核（區經理不核支援帳號）');
  const offSm = plusSm.map((p) => (p.emp === 'DZY321' ? Object.assign({}, p, { status: 'disabled' }) : p));
  ok(has(run('DZY320', { people: offSm }).h, 'mztlzl:ML04'), '9c 店長已停用 → 不算有人，往下一層（區經理）');
  // 央廚：廠長 → 廚藝總監；沒有就只剩人資主管／admin（央廚沒有督導、總監這兩層）
  const ckMaps = MAPS.concat([M('DZY302', 'cf', 'CF02')]);
  ok(has(run('DZY310', { maps: ckMaps }).h, 'cf:CF02') && has(run('DZY310', { maps: ckMaps }).r, 'cf:CF02') && !has(run('DZY311', { maps: ckMaps }).h, 'cf:CF02'), '9c 門市同仁去央廚：廠長核（工時＋申請），廚藝總監不核');
  const noFm = BASE.filter((p) => p.emp !== 'DZY310');
  ok(has(run('DZY311', { people: noFm, maps: ckMaps }).h, 'cf:CF02') && has(run('DZY311', { people: noFm, maps: ckMaps }).r, 'cf:CF02'), '9c 央廚沒有廠長 → 廚藝總監核');
  const noCk = noFm.filter((p) => p.emp !== 'DZY311');
  ok(!has(run('DZY309', { people: noCk, maps: ckMaps }).h, 'cf:CF02') && !has(run('DZY316', { people: noCk, maps: ckMaps }).h, 'cf:CF02') && has(run('DZY315', { people: noCk, maps: ckMaps, flags: { hrHead: true } }).h, 'cf:CF02'), '9c 央廚兩層都沒人 → 品牌總監不補，只剩人資主管');
  g('9c 央廚同仁去門市：墨光店長核（工時＋申請）', [has(s303.h, 'mztgf:MG12'), has(s303.r, 'mztgf:MG12'), has(run('DZY310').h, 'mztgf:MG12')], [true, true, false]);
  ok(has(run('DZY310').v, 'mztgf:MG12'), '9c 央廚同仁去門市：廠長（原單位）只看');

  // 9d. 多單位的店：每一層把店的所有單位合起來看
  const su2 = Object.assign({}, SU, { mztlzl: ['mzt-lzl', 'mzt-js'] });
  ok(has(run('DZY305', { su: su2 }).h, 'mztlzl:ML04') && !has(run('DZY309', { su: su2 }).h, 'mztlzl:ML04'), '9d 店有兩個單位：任一單位有店長就是第 1 層（金山店長核），總監不核');
  ok(has(run('DZY305', { su: su2 }).h, 'mztlzl:ML07') === false && has(run('DZY305', { su: su2 }).h, 'mztjs:MJ05'), '9d 六張犁計時在自己單位的店（多單位）→ 不是支援，照舊（金山店長不核他）');

  // 9e. 試點看打卡店單位
  const noGf = ALL.filter((u) => u !== 'mzt-gf');
  ok(!has(run('DZY303', { pilot: noGf }).h, 'mztgf:MG02') && !has(run('DZY301', { pilot: noGf }).v, 'mztgf:MG02'), '9e 打卡店單位不在試點 → 支援帳號不列（核定與只看都不列）');
  g('9e 試點只有墨光：墨光店長仍核辛光計時在墨光的帳號（不看人所屬單位）', run('DZY303', { pilot: ['mzt-gf'] }).h, ['mztgf:MG02', 'mztgf:MG03', 'mztgf:MG04', 'mztgf:MG12', 'mztgf:MG18']);
  g('9e 試點只有墨光：辛光店長的本店名單照舊被試點擋掉', [run('DZY301', { pilot: ['mzt-gf'] }).h, run('DZY301', { pilot: ['mzt-gf'] }).v], [[], ['mztgf:MG02']]);
  g('9e 試點空 → 全空', [run('DZY303', { pilot: [] }).h, run('DZY303', { pilot: [] }).v], [[], []]);

  // 9f. 人資主管／admin：全部帳號（含支援），不含自己；自己是店長時「核自己工時」不適用於支援帳號
  const hr = run('DZY315', { flags: { hrHead: true } });
  ok(['gf:GF13', 'mztgf:MG02', 'mztjs:MJ03', 'mztlzl:ML04', 'mztgf:MG12'].every((k) => has(hr.h, k) && has(hr.r, k)) && hr.v.length === 0, '9f 人資主管：支援帳號工時與申請都可核、沒有只看', hr);
  const adm = run('', { flags: { admin: true } });
  ok(eq(adm.h, hr.h) && eq(adm.r, hr.r), '9f admin（沒有同仁編號）與人資主管同一批');
  const smAdm = run('DZY303', { flags: { admin: true } });
  ok(has(smAdm.h, 'mztgf:MG03') && !has(smAdm.h, 'mztjs:MJ03') && !has(smAdm.r, 'mztjs:MJ03') && !has(smAdm.v, 'mztjs:MJ03'), '9f ★兼 admin 的店長：自己本店帳號照舊可核；自己的支援帳號不核也不列', smAdm);
  ok(!has(run('DZY313', { flags: { hrHead: true } }).h, 'gf:GF13') && !has(run('DZY313', { flags: { hrHead: true } }).h, 'hq:H13'), '9f 人資主管旗標＋自己有支援帳號 → 不含自己');

  // 9g. 任何人都不核自己（防呆）：讓墨光店長同時是六張犁的唯一第一層（多單位店），他在六張犁的帳號也是支援帳號
  const su3 = Object.assign({}, SU, { mztlzl: ['mzt-lzl', 'mzt-gf'] });
  const selfMaps = MAPS.concat([M('DZY305', 'mztlzl', 'ML05')]);
  const su4 = Object.assign({}, SU, { mztlzl: ['mzt-lzl', 'mzt-js'] });
  ok(!has(run('DZY305', { maps: selfMaps, su: su3 }).h, 'mztlzl:ML05') && has(run('DZY303', { maps: selfMaps, su: su3 }).h, 'mztlzl:ML05'), '9g 支援帳號：打卡店（多單位）的店長核得到、本人（不是那家店的主管）核不到');
  ok(has(run('DZY305', { maps: selfMaps, su: su4 }).h, 'mztlzl:ML05') && !has(run('DZY305', { maps: selfMaps, su: su4 }).r, 'mztlzl:ML05'), '9g 多單位店含自己單位 → 不是支援帳號，照舊（店長核自己工時、不核自己申請）');
  // 督導（要考勤的職稱）在六張犁打卡，自己又是六張犁那區的第 3 層 → 不能核自己；同一層沒有別人 → 這個帳號只剩人資主管／admin
  const osvMaps = MAPS.concat([M('DZY308', 'mztlzl', 'ML08')]);
  const o308 = run('DZY308', { maps: osvMaps, rctx: on });
  ok(!has(o308.h, 'mztlzl:ML08') && !has(o308.r, 'mztlzl:ML08') && !has(o308.v, 'mztlzl:ML08') && has(o308.h, 'mztlzl:ML04'), '9g ★督導是自己支援帳號那層的核定人 → 仍不能核自己（同店別人照核）', o308);
  ok(has(run('DZY315', { maps: osvMaps, rctx: on, flags: { hrHead: true } }).h, 'mztlzl:ML08') && has(run('DZY309', { maps: osvMaps, rctx: on }).h, 'mztlzl:ML08') && has(run('DZY309', { maps: osvMaps, rctx: on }).h, 'hq:H08'), '9g 那個帳號由人資主管核；2026-10-26 起督導在門市打卡不算支援 → 辦公室總監照原規則核（含總部帳號）');
  const odirClock = MAPS.concat([M('DZY309', 'mztlzl', 'ML09')]);
  ok(!has(run('DZY309', { maps: odirClock }).h, 'mztlzl:ML09') && !has(run('DZY309', { maps: odirClock }).v, 'mztlzl:ML09'), '9g 責任制職稱就算有門市打卡帳號也不列（不用核）、總監是第 4 層也不核自己');

  // 9h. att.extra：支援帳號看「打卡店單位＝我的單位」
  const ex = run('DZY318', { flags: { attExtra: true } });
  g('9h att.extra 工時：同單位的人（照舊）＋到本店支援的帳號；不含本人', ex.h, ['mztgf:MG02', 'mztgf:MG03', 'mztgf:MG04', 'mztgf:MG12']);
  g('9h att.extra 申請：同上', ex.r, ['mztgf:MG02', 'mztgf:MG03', 'mztgf:MG04', 'mztgf:MG12']);
  g('9h att.extra 只看：同單位的人在別店的支援帳號', ex.v, ['mztjs:MJ03', 'mztlzl:ML04']);

  // 9i. 督導／總監只看（REGIONS_ON）：看打卡店單位
  const mzStores = sb.attViewUnitsOf_(BASE.find((p) => p.emp === 'DZY309'), org, null);
  const v309 = run('DZY309', { opt: { viewUnits: mzStores } });
  ok(has(v309.v, 'mztgf:MG02') && has(v309.v, 'mztgf:MG03') && has(v309.v, 'mztjs:MJ03'), '9i ★墨竹亭總監：看得到小辛辣同仁在墨竹亭的支援帳號（依打卡店）', v309.v);
  ok(!has(v309.v, 'mztlzl:ML04') && has(v309.h, 'mztlzl:ML04'), '9i 總監自己是第 4 層核定人的帳號只在核定名單');
  const v316 = run('DZY316', { opt: { viewUnits: ['mala-gf'] } });
  g('9i ★小辛辣總監：只看辛光這家店的帳號（含資訊同仁支援），不再看到小辛辣同仁在墨竹亭的打卡', v316.v, ['gf:GF01', 'gf:GF02', 'gf:GF13']);
  ok(eq(v316.h, ['hq:H17']), '9i 品牌辦公室行政在總部打卡（hq）→ 照舊由總監核', v316.h);

  // 9j. 非支援帳號完全照舊：沒有任何支援帳號時，新算法＝舊算法（storeAttTargets_／storeAttViewTargets_ 再逐人展開所有帳號，即 10-26 前的 storeAttPeople_）逐筆相同
  const homeMaps = MAPS.filter((m) => ['MG02', 'MJ03', 'ML04', 'MG12', 'GF13'].indexOf(m.emp_id) === -1);
  const legacy = (me, flags, units, mode) => {
    const ts = mode === 'view' ? sb.storeAttViewTargets_(me, BASE, org, null, units) : sb.storeAttTargets_(me, flags, BASE, org, null, mode, null);
    const seen = {}, out = [];
    ts.forEach((t) => {
      if (!(t.pilotUnits || [t.unit]).some((u) => ALL.indexOf(u) !== -1)) return;
      homeMaps.forEach((m) => { if (m.emp_no !== t.emp) return; const k = m.store_code + '|' + m.emp_id; if (seen[k]) return; seen[k] = true; out.push(m.store_code + ':' + m.emp_id); });
    });
    return out.sort();
  };
  let same = 0, diff = [];
  BASE.concat([{ emp: '', status: 'active', unit: '', dept: '', title: '', admin: true }]).forEach((me) => {
    [{}, { hrHead: true }, { attExtra: true }, { admin: true }].forEach((flags) => {
      const units = sb.attViewUnitsOf_(me, org, null);
      const r = sb.storeAttLists_(me, flags, BASE, org, null, homeMaps, SU, null, ALL, { viewUnits: units });
      const got = [keys(r.people).sort(), keys(r.req_people).sort(), keys(r.view_people).sort()];
      const want = [legacy(me, flags, units, 'hours'), legacy(me, flags, units, 'req'), legacy(me, {}, units, 'view')];
      if (eq(got, want)) same++; else diff.push({ me: me.emp, flags, got, want });
    });
  });
  ok(diff.length === 0 && same === (BASE.length + 1) * 4, '9j ★沒有支援帳號時：每個人 × 四種旗標，三份名單與舊算法逐筆相同', diff.slice(0, 3));
})();

// ============================================================
// 9k. 支援打卡接到 ident（整條路：staff_clock＋clock_stores＋試點＋區域開關）
// ============================================================
(() => {
  const cast = [
    ['DZY331', '辛光店長', 'mala-gf', '', 'sm', 'active', '2026-01-01'],
    ['DZY332', '辛光計時', 'mala-gf', '', 'pt', 'active', '2026-01-01'],
    ['DZY333', '墨光店長', 'mzt-gf', '', 'sm', 'active', '2026-01-01'],
    ['DZY334', '墨光計時', 'mzt-gf', '', 'pt', 'active', '2026-01-01'],
    ['DZY335', '墨總監', 'mzt-hq', '', 'odir', 'active', '2026-01-01'],
    ['DZY336', '辛總監', 'mala-hq', '', 'odir', 'active', '2026-01-01'],
    ['DZY337', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-01'],
    ['DZY338', '資訊同仁', 'dzy-hq', 'it', 'hs', 'active', '2026-01-01'],
    ['DZY339', '資訊總監', 'dzy-hq', 'it', 'hm', 'active', '2026-01-01']
  ];
  const app = world(cast, { pilot: 'mala-gf,mzt-gf,dzy-hq,mzt-hq,mala-hq' });
  const sc = app.sheets.staff_clock._data;
  sc.push(['DZY332', 'mztgf', 'MZTGF332', 'support', 'confirmed', 'created', 'TRUE', '', 'tester', '', '']);
  sc.push(['DZY338', 'gf', 'GF338', 'support', 'confirmed', 'created', 'TRUE', '', 'tester', '', '']);
  const K = (s, k) => app.ident(s).att[k].map((x) => x.clock + ':' + x.emp_id);
  const g = (label, got, want) => ok(eq(got, want), label, { got, want });
  g('9k ident 墨光店長 people：多了辛光計時在墨光的帳號', K('DZY333', 'people'), ['mztgf:MZTGF332', 'mztgf:MZTGF333', 'mztgf:MZTGF334']);
  g('9k ident 墨光店長 req_people', K('DZY333', 'req_people'), ['mztgf:MZTGF332', 'mztgf:MZTGF334']);
  g('9k ident 辛光店長：本店兩人＋資訊同仁在本店；辛光計時在墨光的帳號只看', [K('DZY331', 'people'), K('DZY331', 'req_people'), K('DZY331', 'view_people')],
    [['gf:GF331', 'gf:GF332', 'gf:GF338'], ['gf:GF332', 'gf:GF338'], ['mztgf:MZTGF332']]);
  g('9k ident 資訊總監：總部帳號照核、門市帳號只看', [K('DZY339', 'people'), K('DZY339', 'view_people')], [['hq:HQ338'], ['gf:GF338']]);
  const vp = app.ident('DZY331').att;
  const SUPK = ['clock', 'emp_id', 'sub', 'name', 'support', 'home_unit', 'home_unit_name'];
  const isSup = (x) => (x.clock === 'mztgf' && x.emp_id === 'MZTGF332') || (x.clock === 'gf' && x.emp_id === 'GF338');
  ok(['people', 'req_people', 'view_people'].every((k) => vp[k].every((x) => eq(Object.keys(x), isSup(x) ? SUPK : ['clock', 'emp_id', 'sub', 'name']))) && vp.view_people[0].sub === 'DZY332' && vp.view_people[0].name === '辛光計時',
    '9k ident 名單項目：非支援帳號形狀不變 {clock, emp_id, sub, name}；支援帳號多 support／home_unit／home_unit_name（接在後面）', vp);
  // 9k2. 營運系統「支援（原單位）」標示（2026-10-26 Eason）：只在支援帳號；三份名單都帶；名稱同 att.view@ 的「品牌 單位」
  const sup = (s, k, ck, id) => app.ident(s).att[k].find((x) => x.clock === ck && x.emp_id === id);
  ok(eq(sup('DZY333', 'people', 'mztgf', 'MZTGF332'), { clock: 'mztgf', emp_id: 'MZTGF332', sub: 'DZY332', name: '辛光計時', support: true, home_unit: 'mala-gf', home_unit_name: '麻的小辛辣 新竹光復' }),
    '9k2 ★墨光店長核的辛光計時（支援）：support:true、home_unit mala-gf、home_unit_name「麻的小辛辣 新竹光復」', sup('DZY333', 'people', 'mztgf', 'MZTGF332'));
  ok(eq(sup('DZY333', 'req_people', 'mztgf', 'MZTGF332'), sup('DZY333', 'people', 'mztgf', 'MZTGF332')), '9k2 申請名單同一筆、同樣帶標示');
  ok(sup('DZY331', 'view_people', 'mztgf', 'MZTGF332').home_unit_name === '麻的小辛辣 新竹光復' && sup('DZY331', 'view_people', 'mztgf', 'MZTGF332').support === true, '9k2 原單位主管只看的那筆也帶標示');
  const it338 = sup('DZY331', 'people', 'gf', 'GF338');
  ok(it338.support === true && it338.home_unit === 'dzy-hq' && typeof it338.home_unit_name === 'string' && it338.home_unit_name.length > 0 && it338.home_unit_name.indexOf('dzy-hq') === -1, '9k2 總部同仁到門市：home_unit dzy-hq、名稱是中文（不是代碼）', it338);
  ok(['gf:GF331', 'gf:GF332'].every((k) => eq(Object.keys(app.ident('DZY331').att.people.find((x) => x.clock + ':' + x.emp_id === k)), ['clock', 'emp_id', 'sub', 'name'])) && !('support' in sup('DZY339', 'people', 'hq', 'HQ338')),
    '9k2 本店同仁、總部打卡（hq）帳號不帶 support 欄位');
  const org9 = app.sb.stfReadOrg_();
  ok(app.sb.storeUnitLabel_('mzt-gf', org9) === '墨竹亭 新竹光復' && app.sb.storeUnitLabel_('ck', org9) === '中央工廠（央廚）' && app.sb.storeUnitLabel_('nope', org9) === 'nope' && app.sb.storeUnitLabel_('', org9) === '', '9k2 storeUnitLabel_：品牌＋單位、央廚不加品牌、查不到＝代碼、空＝空');
  ok(has(K('DZY337', 'people'), 'mztgf:MZTGF332') && has(K('DZY337', 'people'), 'gf:GF338') && has(K('U:a001', 'req_people'), 'mztgf:MZTGF332'), '9k ident 人資主管、admin 核得到支援帳號');
  // REGIONS_ON：總監依打卡店看
  app.props.REGIONS_ON = '1';
  app.sb.regionCtxReset_();
  ok(has(K('DZY335', 'view_people'), 'mztgf:MZTGF332') && !has(K('DZY336', 'view_people'), 'mztgf:MZTGF332') && has(K('DZY336', 'view_people'), 'gf:GF338') && has(K('DZY336', 'view_people'), 'gf:GF332'), '9k ident REGIONS_ON：墨總監看得到辛光計時在墨光的帳號、辛總監看不到；辛總監看得到資訊同仁在辛光的帳號');
  // 試點只開墨光：辛光計時在墨光的帳號仍給墨光店長
  app.props.STORE_SSO_UNITS = 'mzt-gf';
  g('9k ident 試點只開墨光：支援帳號依打卡店單位列入', K('DZY333', 'people'), ['mztgf:MZTGF332', 'mztgf:MZTGF333', 'mztgf:MZTGF334']);
  // 營運系統契約 fixture 沒有支援帳號 → 原本兩份 ident fixture 不受影響（第 1 節逐欄比對仍通過）
})();

// ============================================================
// 10. 指定門市只看考勤 att.view@<單位>（2026-10-26 spec §2，Eason 7A）
// ============================================================
(() => {
  const cast = [
    ['DZY351', '辛光店長', 'mala-gf', '', 'sm', 'active', '2026-01-01'],
    ['DZY352', '辛光計時', 'mala-gf', '', 'pt', 'active', '2026-01-01'],
    ['DZY353', '墨光計時', 'mzt-gf', '', 'pt', 'active', '2026-01-01'],
    ['DZY354', '總部總監', 'dzy-hq', 'it', 'hm', 'active', '2026-01-01'],
    ['DZY355', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-01'],
    ['DZY356', '財務同仁', 'dzy-hq', 'fin', 'hs', 'active', '2026-01-01'],
    ['DZY357', '辛總監', 'mala-hq', '', 'odir', 'active', '2026-01-01']
  ];
  const app = world(cast);
  const { sb } = app;
  const sc = app.sheets.staff_clock._data;
  sc.push(['DZY353', 'gf', 'GF353', 'support', 'confirmed', 'created', 'TRUE', '', 'tester', '', '']);   // 墨光計時到辛光支援
  sc.push(['DZY354', 'gf', 'GF354', 'support', 'confirmed', 'created', 'TRUE', '', 'tester', '', '']);   // 總監本人在辛光也有帳號（不用核）
  const exSave = (tok, emp, perm, extra) => post(sb, 'permExSave', Object.assign({ emp_no: emp, perm, mode: 'add', until: '', note: '只看考勤' }, extra || {}), tok);
  const pidx = sb.permOrgIndex_();
  const ve = (perm, mode, o) => sb.permValidateEx_({ perm, mode: mode || 'add', until: '', note: '原因' }, '2026-10-26', o === undefined ? pidx : o);
  // 驗證
  ok(ve('att.view@mala-gf') === null && ve('att.view@ck') === null && ve('att.view@mzt-gf') === null, '10 合法：門市與央廚 ck');
  ok(['att.view@mzt-wx', 'att.view@mala-hq', 'att.view@dzy-hq', 'att.view@no-such'].every((c) => (ve(c) || {}).error === 'bad_target'), '10 ★單位停用、品牌辦公室、總部、不存在 → bad_target');
  ok((ve('att.view@mala-gf', 'remove') || {}).error === 'bad_mode', '10 只能「多給」（remove → bad_mode）');
  ok((ve('att.view@mala-gf', 'add', null) || {}).error === 'bad_target', '10 沒給 org → 不合法（fail closed）');
  ok(['att.view@', 'att.view@a b', 'att.view', 'att.view@x@y', 'att.view@' + 'a'.repeat(41)].every((c) => (ve(c) || {}).error === 'bad_perm'), '10 格式不對 → bad_perm');
  ok(sb.permIsGrantable_('att.view@mala-gf') === false && sb.PERM_GRANTABLE.every((p) => p.indexOf('@') === -1), '10 不在 PERM_GRANTABLE（對照表與權限開關畫面不會出現）');
  ok((sb.permValidateRule_({ ladder: 'store', dept: '', title: 'sm', perm: 'att.view@mala-gf' }, pidx, true) || {}).error === 'bad_perm', '10 ★對照表規則不收（admin 也一樣）');
  const ms = post(sb, 'permMapSave', { add: [{ ladder: 'hq', dept: 'it', title: 'hm', perm: 'att.view@mala-gf' }] }, app.adminTok);
  ok(ms.ok === false && ms.code === 'bad_perm', '10 ★permMapSave 加 att.view@ 規則 → bad_perm', ms);
  ok(sb.STORE_HR_GRANTABLE.every((p) => p.indexOf('att.view') === -1), '10 不在 STORE_HR_GRANTABLE');
  // 誰能設
  const hrTok = app.login('DZY355');
  ok(exSave(hrTok, 'DZY354', 'att.view@mala-gf').code === 'no_perm', '10 ★人資主管不能設');
  ok(exSave(app.login('DZY351'), 'DZY354', 'att.view@mala-gf').code === 'no_perm', '10 店長不能設');
  const bad = exSave(app.adminTok, 'DZY354', 'att.view@mala-hq');
  ok(bad.ok === false && bad.code === 'bad_target', '10 admin 設品牌辦公室 → bad_target', bad);
  ok(exSave(app.adminTok, 'DZY354', 'att.view@mala-gf', { mode: 'remove' }).code === 'bad_mode', '10 admin 設 remove → bad_mode');
  // 設之前
  const perms = (u) => { const r = post(sb, 'login', { username: u, password: PW }); return r.ok ? r.data.perms : null; };
  ok(!has(perms('DZY356'), 'platform.att') && eq(app.ident('DZY356').att.view_people, []), '10 設之前：財務同仁沒有考勤管理、沒有只看名單');
  const s1 = exSave(app.adminTok, 'DZY356', 'att.view@mala-gf');
  ok(s1.ok, '10 admin 能設 att.view@mala-gf', s1);
  ok(app.sheets.perm_audit._rows().slice(-1)[0][3] === 'att.view@mala-gf', '10 寫 perm_audit（added＝att.view@mala-gf）');
  // permCompute_ 把它帶進 perms
  const who = post(sb, 'permWho', { q: 'DZY356' }, app.adminTok);
  ok(who.ok && has(who.data.items[0].perms, 'att.view@mala-gf') && who.data.items[0].sources.some((x) => x.perm === 'att.view@mala-gf' && x.source === 'exception'), '10 permCompute_：perms 帶出 att.view@mala-gf（來源個別例外）', who.data);
  // 效果：只看名單＝辛光店的全部帳號（含到辛光支援的人；不含不用核的總監帳號）、不進核定名單
  const id = app.ident('DZY356');
  ok(eq(id.att.view_people.map((x) => x.clock + ':' + x.emp_id), ['gf:GF351', 'gf:GF352', 'gf:GF353']) && eq(id.att.people, []) && eq(id.att.req_people, []), '10 ★ident：view_people＝辛光打卡帳號全部（含支援、不含責任制），只看不核', id.att);
  ok(has(perms('DZY356'), 'platform.att'), '10 ★持有者有考勤管理（platform.att）');
  app.props.PERMS_ON = '1';
  const meR = post(sb, 'myPerms', {}, app.login('DZY356'));
  delete app.props.PERMS_ON;
  ok(meR.ok && meR.data.items.some((i) => i.perm === 'att.view@mala-gf' && i.name_zh === '只看考勤（麻的小辛辣 新竹光復）'), '10 myPerms 中文名「只看考勤（麻的小辛辣 新竹光復）」', meR.data);
  ok(sb.permName_('att.view@ck') === '只看考勤（中央工廠（央廚））' && sb.permName_('att.view@nope') === '只看考勤（nope）', '10 permName_：央廚不加品牌、查不到顯示代碼');
  // 不看本人
  exSave(app.adminTok, 'DZY352', 'att.view@mala-gf');
  ok(!app.ident('DZY352').att.view_people.some((x) => x.sub === 'DZY352'), '10 只看名單不含本人');
  // 試點不含那家店 → 沒有（考勤管理仍給，選單照營運系統）
  app.props.STORE_SSO_UNITS = 'mzt-gf';
  ok(eq(app.ident('DZY356').att.view_people, []), '10 那家店不在試點 → 只看名單空');
  app.props.STORE_SSO_UNITS = PERMS_ALL_PILOT;
  // 單位之後停用 → permCompute_ 不給、閘門也關
  const orgRow = app.sheets.org._data.find((r) => r[0] === 'unit' && r[1] === 'mala-gf');
  orgRow[7] = 'FALSE';
  ok(!has(perms('DZY356'), 'platform.att'), '10 單位停用後 → 不再有考勤管理');
  orgRow[7] = 'TRUE';
  // 人資主管看不到這種例外；admin 的列表多回可選門市
  const lsHr = post(sb, 'permExList', {}, hrTok);
  ok(lsHr.ok && !lsHr.data.items.some((i) => i.perm.indexOf('att.view@') === 0) && lsHr.data.att_view_units === undefined, '10 人資主管 permExList 看不到 att.view@、也不回門市清單');
  const lsAd = post(sb, 'permExList', {}, app.adminTok);
  const codes = (lsAd.data.att_view_units || []).map((u) => u.code);
  ok(has(codes, 'mala-gf') && has(codes, 'ck') && has(codes, 'mzt-gf') && !has(codes, 'mala-hq') && !has(codes, 'dzy-hq') && !has(codes, 'mzt-wx') && lsAd.data.att_view_units.find((u) => u.code === 'mzt-gf').name === '墨竹亭 新竹光復', '10 admin permExList.att_view_units：active 門市＋央廚（名稱含品牌）', lsAd.data.att_view_units);
  const hrEx = lsAd.data.items.find((i) => i.perm === 'att.view@mala-gf' && i.emp_no === 'DZY356');
  ok(post(sb, 'permExRevoke', { ex_id: hrEx.ex_id }, hrTok).code === 'no_perm', '10 人資主管不能撤銷');
  ok(post(sb, 'permExRevoke', { ex_id: hrEx.ex_id }, app.adminTok).ok && !has(perms('DZY356'), 'platform.att') && eq(app.ident('DZY356').att.view_people, []), '10 admin 撤銷後 → 沒有考勤管理、只看名單空');
  // admin／人資主管：已經全核，不另外加只看
  exSave(app.adminTok, 'DZY355', 'att.view@mala-gf');
  ok(eq(app.ident('DZY355').att.view_people, []), '10 人資主管持有也不另外列只看（本來就全部可核）');
  // 已有考勤職稱的人（辛總監）持有：多看那家店
  exSave(app.adminTok, 'DZY357', 'att.view@mzt-gf');
  ok(eq(app.ident('DZY357').att.view_people.map((x) => x.emp_id), ['MZTGF353']), '10 總監持有墨光的只看 → 多看墨光店的帳號');
  // 鎖碼家族：非 admin 的調動若會改變有無 att.view@ → 擋；訊息有「只看考勤」
  ok(sb.permLockedMsg_(['att.view@mala-gf']).indexOf('只看考勤') !== -1, '10 鎖碼訊息：只看考勤');
  // 純函式：storeAttViewExUnits_ 過濾不合法單位
  ok(eq(sb.storeAttViewExUnits_(['att.view@mala-gf', 'att.view@mala-gf', 'att.view@mala-hq', 'att.view@mzt-wx', 'att.view@ck', 'store.void'], sb.stfReadOrg_()), ['ck', 'mala-gf']), '10 storeAttViewExUnits_：只留存在、啟用、store 階梯的單位，排序去重');
  // permCompute_：只走例外、只認 add、單位要合法
  const base = { staff: { status: 'active', unit: 'dzy-hq', dept: 'fin', title: 'hs', emp_no: 'DZY356' }, org: pidx, rules: [{ rule_id: 'R1', ladder: 'hq', dept: '', title: '*', perm: 'att.view@mala-gf' }], today: '2026-10-26' };
  const pc = (exs) => sb.permCompute_(Object.assign({}, base, { exs })).perms;
  ok(eq(pc([]), []), '10 permCompute_：規則裡的 att.view@ 一律不採用');
  ok(eq(pc([{ emp_no: 'DZY356', perm: 'att.view@mala-gf', mode: 'add', until: '' }]), ['att.view@mala-gf']), '10 permCompute_：例外 add → perms 有');
  ok(eq(pc([{ emp_no: 'DZY356', perm: 'att.view@mala-gf', mode: 'remove', until: '' }, { emp_no: 'DZY356', perm: 'att.view@mala-hq', mode: 'add', until: '' }, { emp_no: 'DZY999', perm: 'att.view@ck', mode: 'add', until: '' }, { emp_no: 'DZY356', perm: 'att.view@ck', mode: 'add', until: '2020-01-01' }]), []), '10 permCompute_：remove、不合法單位、別人的、過期 → 都不給');
})();

// ============================================================
// 8. 分派與 dryrun
// ============================================================
(async () => {
  const code = SRC.find(([f]) => f === 'Code.gs')[1];
  ok(/case 'svcStoreRedeem': return handleSvcStoreRedeem_\(payload\);/.test(code) && /case 'svcStoreWho': return handleSvcStoreWho_\(payload\);/.test(code) && /case 'svcStoreRoster': return handleSvcStoreRoster_\(payload\);/.test(code), '8 Code.gs 分派三支 svcStore*');
  const { READ_ACTIONS } = await import('../platform/dryrun.js');
  const plat = READ_ACTIONS.platform;
  ok(['svcStoreRedeem', 'svcStoreWho', 'svcStoreRoster'].every((a) => plat.indexOf(a) === -1), '8 ★svcStoreRedeem／svcStoreWho／svcStoreRoster 不在 dryrun READ_ACTIONS');
  const mini = (() => { try { return JSON.parse(fs.readFileSync(path.join(process.env.HOME, 'dzy-minikit/apps/dzy-platform/app.json'), 'utf8')); } catch (e) { return null; } })();
  if (mini) ok(['svcStoreRedeem', 'svcStoreWho', 'svcStoreRoster'].every((a) => mini.readActions.indexOf(a) === -1), '8 ★三支不在 minikit readActions（本機有 minikit 才驗）');
  // 沒有任何真實姓名：本檔與 StoreOps.gs 只用假名（人工把關；這裡擋明顯的格式外洩）
  const so = SRC.find(([f]) => f === 'StoreOps.gs')[1];
  ok(!/https?:\/\/|[A-Za-z0-9_-]{30,}/.test(so.replace(/\/\*[\s\S]*?\*\//g, '')), '8 StoreOps.gs 沒有網址或疑似金鑰字串');

  console.log('\n' + (failed ? '失敗' : '通過') + ' ' + passed + '／' + (passed + failed));
  if (failed) process.exit(1);
})();
