// node test/sched-admin-ex.mock.test.mjs —— 個別例外「排班管理（指定門市）」sched.admin@<門市> 驗收（docs/sched-admin-ex）
// 測試骨架照抄 att-hr-acting.mock.test.mjs（vm 載 .gs、world()、走 doPost 的 action）。
// ⚠ 所有姓名、編號、金鑰都是假資料（dzy 是 public repo，不得出現真實同仁資料）。


'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'StaffClock.gs', 'Perms.gs', 'PermActions.gs', 'StoreOps.gs', 'ApprovalRoute.gs', 'Approvals.gs', 'Code.gs']
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


// ── 這支的假人（全部假名） ──
const CAST = [
  ['DZY201', '督導甲', 'mzt-hq', '', 'osv', 'active', '2026-01-01'],      // 品牌辦公室區督導
  ['DZY202', '六張犁正職', 'mzt-lzl', '', 'ft', 'active', '2026-01-02'],
  ['DZY203', '六張犁計時', 'mzt-lzl', '', 'pt', 'active', '2026-01-03'],
  ['DZY210', '墨竹亭總監', 'mzt-hq', '', 'odir', 'active', '2026-01-10'],
  ['DZY220', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-20'],
  ['DZY221', '人資同仁', 'dzy-hq', 'hr', 'hs', 'active', '2026-01-21'],
  ['DZY222', '財務同仁', 'dzy-hq', 'fin', 'hs', 'active', '2026-01-22'],
  ['DZY224', '資訊同仁', 'dzy-hq', 'it', 'hs', 'active', '2026-01-24'],
  ['DZY230', '光復計時', 'mzt-gf', '', 'pt', 'active', '2026-01-30'],
  ['DZY231', '光復店長', 'mzt-gf', '', 'sm', 'active', '2026-01-31'],
  ['DZY232', '金山店長', 'mzt-js', '', 'sm', 'active', '2026-02-01'],
  ['DZY233', '離職前同仁', 'dzy-hq', 'it', 'hs', 'active', '2026-02-02'],
  ['DZY240', '小辛辣行政', 'mala-hq', '', 'ofs', 'active', '2026-02-03'],
  ['DZY241', '央廚廠長', 'ck', '', 'fm', 'active', '2026-02-04']
];
const PILOT = 'ck,dzy-hq,mala-gf,mala-hq,mzt-gf,mzt-hq,mzt-js,mzt-lzl';

function setup() {
  const app = world(CAST, { pilot: PILOT });
  const { sb, sheets } = app;
  app.props.PERMS_ON = '1';
  app.tok = {};
  ['DZY201', 'DZY220', 'DZY221', 'DZY222', 'DZY231', 'DZY210'].forEach((e) => { app.tok[e] = app.login(e); });
  app.ex = (tok, emp, perm, extra) => {
    const r = post(sb, 'permExSave', Object.assign({ emp_no: emp, perm, mode: 'add', until: '', note: '測試排班管理' }, extra || {}), tok);
    sb.permActingReset_();
    return r;
  };
  app.units = (emp) => app.ident(emp).sched_units;
  app.perms = (emp) => { const r = post(sb, 'login', { username: emp, password: PW }); return r.ok ? r.data.perms : []; };
  app.myPerms = (emp) => post(sb, 'myPerms', {}, app.login(emp));
  app.setUnitActive = (code, v) => { const r = sheets.org._data.find((x) => x[0] === 'unit' && x[1] === code); r[7] = v; sb.permActingReset_(); };
  return app;
}
const SCH = (u) => 'sched.admin@' + u;

// ============================================================
// 1. 誰能設
// ============================================================
(() => {
  const app = setup();
  const { sb } = app;
  ok(app.ex(app.tok.DZY221, 'DZY201', SCH('mzt-gf')).code === 'no_perm', '1 ★人資同仁（非主管）不能設');
  ok(app.ex(app.tok.DZY231, 'DZY201', SCH('mzt-gf')).code === 'no_perm', '1 ★店長不能設');
  ok(app.ex(app.tok.DZY222, 'DZY201', SCH('mzt-gf')).code === 'no_perm', '1 ★一般同仁不能設');
  ok(app.ex(app.tok.DZY220, 'DZY220', SCH('mzt-gf')).code === 'perm_self', '1 ★人資主管不能設給自己');
  const a = app.ex(app.adminTok, 'DZY201', SCH('mzt-gf'));
  ok(a.ok, '1 ★admin 能設', a);
  const b = app.ex(app.tok.DZY220, 'DZY224', SCH('mzt-js'));
  ok(b.ok, '1 ★人資主管能設', b);
  ok(sb.permIsGrantable_(SCH('mzt-gf')) === false, '1 不在 PERM_GRANTABLE（對照表不收）');
  const list = post(sb, 'permExList', {}, app.tok.DZY220);
  ok(list.ok && Array.isArray(list.data.sched_admin_units) && list.data.sched_admin_units.some((u) => u.code === 'mzt-gf') && !list.data.sched_admin_units.some((u) => u.code === 'ck') && !list.data.sched_admin_units.some((u) => u.code === 'mzt-hq'), '1 permExList 回 sched_admin_units（門市、不含央廚與辦公室）', list.data && list.data.sched_admin_units);
  ok(list.data.items.some((x) => x.perm === SCH('mzt-js') && x.emp_no === 'DZY224') && list.data.items.some((x) => x.perm === SCH('mzt-gf')), '1 人資主管看得到這些例外列');
  const listA = post(sb, 'permExList', {}, app.adminTok);
  ok(listA.ok && Array.isArray(listA.data.sched_admin_units), '1 admin 也拿得到 sched_admin_units');
  ok(sb.permName_(SCH('mzt-gf')).indexOf('排班管理（') === 0, '1 permName_「排班管理（…）」', sb.permName_(SCH('mzt-gf')));
})();

// ============================================================
// 2. 設定檢查
// ============================================================
(() => {
  const app = setup();
  const { sb, sheets } = app;
  const HR = app.tok.DZY220;
  const r1 = app.ex(HR, 'DZY201', SCH('mzt-gf'));
  const r2 = app.ex(HR, 'DZY201', SCH('mzt-js'));
  ok(r1.ok && r2.ok && r1.data.ex_id !== r2.data.ex_id, '2 ★本人主要單位以外的門市：osv 設兩家＝兩筆');
  ok(sheets.perm_ex._data.filter((r) => r[1] === 'DZY201' && /^sched\.admin@/.test(r[2])).length === 2, '2 perm_ex 兩列');
  ok(app.ex(HR, 'DZY201', SCH('ck')).code === 'bad_target', '2 ★央廚 ck → bad_target');
  ok(app.ex(HR, 'DZY201', SCH('mzt-hq')).code === 'bad_target', '2 ★品牌辦公室 → bad_target');
  ok(app.ex(HR, 'DZY201', SCH('dzy-hq')).code === 'bad_target', '2 ★總部 → bad_target');
  ok(app.ex(HR, 'DZY201', SCH('zzz-nope')).code === 'bad_target', '2 ★不存在的單位 → bad_target');
  app.setUnitActive('mzt-lzl', 'FALSE');
  ok(app.ex(HR, 'DZY201', SCH('mzt-lzl')).code === 'bad_target', '2 ★停用的單位 → bad_target');
  app.setUnitActive('mzt-lzl', 'TRUE');
  ok(app.ex(HR, 'DZY201', SCH('mzt-lzl'), { mode: 'remove' }).code === 'bad_mode', '2 ★mode remove → bad_mode');
  ok(app.ex(HR, 'DZY201', SCH('mzt-gf')).code === 'dup' && app.ex(app.adminTok, 'DZY201', SCH('mzt-gf')).code === 'dup', '2 ★同人同店生效中重複 → dup（admin、人資都擋）');
  { const r = app.ex(HR, 'DZY232', SCH('mzt-js')); ok(r.code === 'bad_target' && /本來就是這家店的店長/.test(r.message || r.error_message || JSON.stringify(r)), '2 ★本來就是該店店長（sm）設本店 → bad_target', r); }
  ok(app.ex(HR, 'DZY232', SCH('mzt-gf')).ok, '2 店長設別家店可以（本店店長只擋本店）');
  ok(app.ex(HR, 'DZY231', SCH('mzt-gf')).code === 'bad_target', '2 光復店長設光復 → bad_target');
  ok(app.ex(HR, 'DZY230', SCH('mzt-gf')).ok, '2 本店計時同仁設本店可以（不是店長）');
  ok(app.ex(HR, 'DZY999', SCH('mzt-gf')).ok === false, '2 查無此人 → 失敗');
  // 離職者不能設
  const st = sheets.staff._data.find((r) => r[0] === 'DZY233'); st[sb.STF_COL.status] = 'disabled';
  ok(app.ex(HR, 'DZY233', SCH('mzt-gf')).code === 'bad_target', '2 ★不在職不能設 → bad_target');
  st[sb.STF_COL.status] = 'active';
  // 重複擋掉的沒有多寫列；過期那筆不算生效中，可重設
  const ex1 = sheets.perm_ex._data.find((r) => r[0] === r2.data.ex_id); ex1[4] = '2020-01-01';
  ok(app.ex(HR, 'DZY201', SCH('mzt-js')).ok, '2 舊的已過期 → 同人同店可重設');
  // 寫 perm_audit
  ok(sheets.perm_audit._data.some((r) => r[3] === SCH('mzt-gf')), '2 新增寫 perm_audit（added＝排班管理碼）');
})();

// ============================================================
// 3. 生效：ident.sched_units、登入權限、myPerms
// ============================================================
(() => {
  const app = setup();
  const { sb } = app;
  const HR = app.tok.DZY220;
  ok(eq(app.units('DZY201'), []) && eq(app.units('DZY203'), []) && !has(app.perms('DZY203'), 'platform.sched'), '3 前置：沒設時 sched_units 空；門市同仁（DZY203）沒有排班選單（總部同仁本來就有自填排班選單，不當對照）');
  app.ex(HR, 'DZY201', SCH('mzt-js'));
  app.ex(HR, 'DZY201', SCH('mzt-gf'));
  ok(eq(app.units('DZY201'), ['mzt-gf', 'mzt-js']), '3 ★sched_units 含兩家（排序）', app.units('DZY201'));
  app.ex(HR, 'DZY203', SCH('mzt-gf'));
  ok(eq(app.units('DZY203'), ['mzt-gf']) && has(app.perms('DZY203'), 'platform.sched'), '3 ★門市同仁設後登入權限有 platform.sched', app.perms('DZY203'));
  // 舊資料重複列不會讓 sched_units 重複
  app.sheets.perm_ex._data.push(['X950', 'DZY201', SCH('mzt-gf'), 'add', '', '舊資料重複', 'TRUE', '', 'tester', '', '']); sb.permActingReset_();
  ok(eq(app.units('DZY201'), ['mzt-gf', 'mzt-js']), '3 ★重複列去重', app.units('DZY201'));
  app.sheets.perm_ex._data.pop(); sb.permActingReset_();
  // myPerms 來源
  const mp = app.myPerms('DZY201');
  const srcs = ((mp.data && mp.data.items) || []);
  const hit = srcs.filter((s) => /^sched\.admin@/.test(s.perm || s.code || ''));
  ok(mp.ok && hit.length === 2 && hit.every((s) => s.source === 'exception'), '3 ★myPerms 有兩筆 sched.admin 來源 exception', mp.data);
  ok(hit.every((s) => s.until === undefined), '3 沒到期日 → 不帶 until');
  ok(hit.every((s) => /^排班管理（/.test(s.name_zh || '')), '3 myPerms 顯示名「排班管理（…）」', hit);
  // 到期日
  app.ex(HR, 'DZY224', SCH('mzt-lzl'), { until: '2099-12-31' });
  const mp2 = app.myPerms('DZY224');
  const h2 = ((mp2.data && mp2.data.items) || []).filter((s) => /^sched\.admin@/.test(s.perm || s.code || ''));
  ok(h2.length === 1 && h2[0].until === '2099-12-31' && h2[0].source === 'exception', '3 ★有到期日 → 帶 until', h2);
  ok(eq(app.units('DZY224'), ['mzt-lzl']), '3 sched_units 依單位');
  // 不在試點的店不出現
  app.props.STORE_SSO_UNITS = PILOT.split(',').filter((u) => u !== 'mzt-js').join(','); sb.permActingReset_();
  ok(eq(app.units('DZY201'), ['mzt-gf']), '3 ★不在試點的店不出現', app.units('DZY201'));
  app.props.STORE_SSO_UNITS = PILOT.split(',').filter((u) => u !== 'mzt-js' && u !== 'mzt-gf').join(','); sb.permActingReset_();
  ok(eq(app.units('DZY201'), []) && eq(app.units('DZY203'), []) && !has(app.perms('DZY203'), 'platform.sched'), '3 ★都不在試點 → 沒有 sched_units、門市同仁沒有排班選單', app.perms('DZY203'));
  app.props.STORE_SSO_UNITS = PILOT; sb.permActingReset_();
  // 其他人沒被影響
  ok(eq(app.units('DZY231'), []) && eq(app.units('DZY230'), []), '3 別人 sched_units 不變');
})();

// ============================================================
// 4. 撤銷、到期、離職
// ============================================================
(() => {
  const app = setup();
  const { sb, sheets } = app;
  const HR = app.tok.DZY220;
  // 4a 撤銷
  const s1 = app.ex(HR, 'DZY203', SCH('mzt-gf'));
  const s2 = app.ex(HR, 'DZY203', SCH('mzt-js'));
  ok(eq(app.units('DZY203'), ['mzt-gf', 'mzt-js']) && has(app.perms('DZY203'), 'platform.sched'), '4 前置：兩家生效');
  const rv = post(sb, 'permExRevoke', { ex_id: s1.data.ex_id }, HR); sb.permActingReset_();
  ok(rv.ok && eq(app.units('DZY203'), ['mzt-js']) && has(app.perms('DZY203'), 'platform.sched'), '4 ★撤一家：下個請求不含那家、還有另一家的排班選單', app.units('DZY203'));
  const rv2 = post(sb, 'permExRevoke', { ex_id: s2.data.ex_id }, HR); sb.permActingReset_();
  ok(rv2.ok && eq(app.units('DZY203'), []) && !has(app.perms('DZY203'), 'platform.sched'), '4 ★全撤：sched_units 空、platform.sched 消失（沒有其他排班理由）', app.perms('DZY203'));
  ok(sheets.perm_audit._data.some((r) => r[4] === SCH('mzt-gf')), '4 撤銷寫 perm_audit（removed＝排班管理碼）');
  // 撤銷同碼重複列一起撤
  const d1 = app.ex(HR, 'DZY203', SCH('mzt-gf'));
  sheets.perm_ex._data.push(['X951', 'DZY203', SCH('mzt-gf'), 'add', '', '舊資料重複', 'TRUE', '', 'tester', '', '']);
  post(sb, 'permExRevoke', { ex_id: d1.data.ex_id }, HR); sb.permActingReset_();
  ok(eq(app.units('DZY203'), []), '4 ★同人同店重複列撤一筆＝全撤');
  // 4b 到期
  const e = app.ex(HR, 'DZY203', SCH('mzt-gf'), { until: '2099-12-31' });
  const row = sheets.perm_ex._data.find((r) => r[0] === e.data.ex_id);
  ok(eq(app.units('DZY203'), ['mzt-gf']), '4 前置：到期日 2099 有效');
  row[4] = '2020-01-01'; sb.permActingReset_();
  ok(eq(app.units('DZY203'), []) && !has(app.perms('DZY203'), 'platform.sched'), '4 ★到期日已過 → 不生效、排班選單收回', app.units('DZY203'));
  row[4] = sb.permTodayTaipei_(); sb.permActingReset_();
  ok(eq(app.units('DZY203'), ['mzt-gf']) && has(app.perms('DZY203'), 'platform.sched'), '4 ★到期日當天仍生效');
  row[4] = 'bad-date'; sb.permActingReset_();
  ok(eq(app.units('DZY203'), []), '4 壞日期 → 不給（fail closed）');
  row[4] = ''; sb.permActingReset_();
  ok(eq(app.units('DZY203'), ['mzt-gf']), '4 到期日清空 → 生效');
  // 4c 離職
  const st = sheets.staff._data.find((r) => r[0] === 'DZY203');
  st[sb.STF_COL.status] = 'disabled'; sb.permActingReset_();
  ok(eq(sb.permSchedAdminUnitsOf_('DZY203'), []), '4 ★同仁離職（status 非 active）→ permSchedAdminUnitsOf_ 空');
  const idr = app.who('DZY203');
  ok(!idr.ok || eq(idr.data.sched_units || [], []), '4 離職者 ident 沒有 sched_units', idr);
  st[sb.STF_COL.status] = 'active'; sb.permActingReset_();
  ok(eq(app.units('DZY203'), ['mzt-gf']), '4 復職後恢復');
  // 4d 單位停用
  app.setUnitActive('mzt-gf', 'FALSE');
  ok(eq(app.units('DZY203'), []), '4 單位停用 → 失效');
  app.setUnitActive('mzt-gf', 'TRUE');
  // 4e 例外 active=FALSE 的列不生效
  row[6] = 'FALSE'; sb.permActingReset_();
  ok(eq(app.units('DZY203'), []), '4 active=FALSE 的列不生效');
  row[6] = 'TRUE'; sb.permActingReset_();
  // 4f mode remove 的硬寫列不生效
  row[3] = 'remove'; sb.permActingReset_();
  ok(eq(app.units('DZY203'), []), '4 硬寫 mode remove 不生效（只認 add）');
  row[3] = 'add'; sb.permActingReset_();
})();

// ============================================================
// 5. 不可降：設例外前後，除了被設的人，其他人 sched_units 零差異
// ============================================================
(() => {
  const app = setup();
  const { sb } = app;
  const snap = () => { const o = {}; CAST.forEach((p) => { const r = app.who(p[0]); o[p[0]] = r.ok ? J(r.data.sched_units || []) : 'ERR'; }); o['U:a001'] = J((app.who('U:a001').data || {}).sched_units || []); return o; };
  const before = snap();
  const r = app.ex(app.tok.DZY220, 'DZY201', SCH('mzt-gf'));
  ok(r.ok, '5 前置：設例外成功');
  const after = snap();
  const diff = Object.keys(before).filter((k) => before[k] !== after[k]);
  const others = diff.filter((k) => k !== 'DZY201');
  console.log('  5 比對人數：' + Object.keys(before).length + '，有差異：' + J(diff));
  ok(diff.length === 1 && diff[0] === 'DZY201' && others.length === 0, '5 ★不可降：被設的那位以外差異人數＝0', others);
  // 撤銷後全部回到原狀
  post(sb, 'permExRevoke', { ex_id: r.data.ex_id }, app.tok.DZY220); sb.permActingReset_();
  const back = snap();
  ok(Object.keys(before).every((k) => before[k] === back[k]), '5 撤銷後全員回到設定前（比對 ' + Object.keys(before).length + ' 人）');
  // 登入權限也只有被設的人多 platform.sched
  const pb = {}; CAST.forEach((p) => { pb[p[0]] = J(app.perms(p[0])); });
  app.ex(app.tok.DZY220, 'DZY203', SCH('mzt-gf'));
  const pdiff = CAST.map((p) => p[0]).filter((e) => J(app.perms(e)) !== pb[e]);
  ok(eq(pdiff, ['DZY203']), '5 登入權限：只有被設的人不同', pdiff);
})();

// ============================================================
// 6. 總監原本的 sched_units 照舊；例外與總監的店合併去重
// ============================================================
(() => {
  const app = setup();
  const base = app.units('DZY210');
  ok(Array.isArray(base) && base.length > 0 && base.every((u) => u.indexOf('mzt-') === 0 && u !== 'mzt-hq'), '6 前置：墨竹亭總監本來就有試點內的墨竹亭門市', base);
  ok(has(app.perms('DZY210'), 'platform.sched'), '6 總監本來就有排班選單');
  // 例外給總監一家他本來就有的店 → 不重複
  const r = app.ex(app.tok.DZY220, 'DZY210', SCH('mzt-gf'));
  ok(r.ok, '6 設給總監（他的店）成功', r);
  ok(eq(app.units('DZY210'), base), '6 ★與總監的店合併去重、清單不變', app.units('DZY210'));
  // 例外給總監別品牌的店 → 併上、排序
  const r2 = app.ex(app.tok.DZY220, 'DZY210', SCH('mala-gf'));
  ok(r2.ok, '6 設給總監別品牌的店成功', r2);
  const merged = base.concat(['mala-gf']).sort();
  ok(eq(app.units('DZY210'), merged), '6 ★總監原本的店＋例外的別品牌店（排序去重）', app.units('DZY210'));
  // 撤銷後回到原本
  post(app.sb, 'permExRevoke', { ex_id: r2.data.ex_id }, app.tok.DZY220); app.sb.permActingReset_();
  ok(eq(app.units('DZY210'), base), '6 撤銷別品牌那筆後回到原本的總監清單');
  // 另一位總監不受影響
  ok(eq(app.units('DZY240'), []), '6 別人不受影響（小辛辣行政）');
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
