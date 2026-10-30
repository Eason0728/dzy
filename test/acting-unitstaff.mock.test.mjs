// node test/acting-unitstaff.mock.test.mjs —— 兼任店長（store.sm@<單位>）在兼任的店新增同仁（docs/acting-unitstaff/requirements.md，Eason 1A 2A）驗收
// 測試骨架照抄 att-hr-acting.mock.test.mjs（vm 載 .gs、world()）。⚠ 全部假資料（public repo）。

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
  ['DZY301', '光復正職甲', 'mzt-gf', '', 'ft', 'active', '2026-01-01'],   // 兼任金山店長（本身不是主管）
  ['DZY302', '光復計時', 'mzt-gf', '', 'pt', 'active', '2026-01-02'],
  ['DZY303', '光復店長', 'mzt-gf', '', 'sm', 'active', '2026-01-03'],     // 本身光復店長、又兼任金山
  ['DZY304', '金山正職', 'mzt-js', '', 'ft', 'active', '2026-01-04'],
  ['DZY305', '金山計時', 'mzt-js', '', 'pt', 'active', '2026-01-05'],
  ['DZY308', '金山區經理', 'mzt-js', '', 'am', 'active', '2026-01-08'],
  ['DZY309', '六張犁計時', 'mzt-lzl', '', 'pt', 'active', '2026-01-09'],
  ['DZY320', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-20']
];
const PILOT = 'ck,dzy-hq,mala-gf,mala-hq,mzt-gf,mzt-hq,mzt-js,mzt-lzl';

function setup() {
  const app = world(CAST, { pilot: PILOT });
  const { sb } = app;
  app.props.PERMS_ON = '1';
  app.tok = {};
  ['DZY301', 'DZY303', 'DZY320'].forEach((e) => { app.tok[e] = app.login(e); });
  app.ex = (emp, perm) => post(sb, 'permExSave', { emp_no: emp, perm, mode: 'add', until: '', note: '測試兼任店長' }, app.tok.DZY320);
  app.today = sb.clkTodayOf_(new Date());
  let seq = 0;
  app.add = (tok, title, unit) => post(sb, 'staffCreateByUnit', Object.assign({ name: '新人測試' + (++seq), title, hire_date: app.today, phone: '0912345' + String(100 + seq).slice(-3) }, unit ? { unit } : {}), tok);
  return app;
}

(async () => {
  // ============================================================
  // 1. 本身不是主管、兼任金山店長
  // ============================================================
  {
    const app = setup();
    const { sb } = app;
    const t = app.tok.DZY301;
    ok(app.add(t, 'pt').code === 'no_perm', '1 前置：兼任之前不能新增');
    const ex = app.ex('DZY301', 'store.sm@mzt-js');
    ok(ex.ok, '1 前置：人資主管給兼任金山店長', ex);
    const a1 = app.add(t, 'pt');
    ok(a1.ok && a1.data.unit === 'mzt-js', '1 ★新增計時 → 進金山（兼任的店）', a1);
    ok(app.add(t, 'sm').ok, '1 ★可新增店長（1A 比照店長職級，本人只是正職）');
    ok(app.add(t, 'am').code === 'no_perm', '1 不能新增比店長高的區經理');
    ok(app.add(t, 'pt', 'mzt-gf').data?.unit === 'mzt-js', '1 ★本人的店（光復）不是兼任的店 → 夾帶也只會進金山');
    ok(app.add(t, 'pt', 'mzt-lzl').data?.unit === 'mzt-js', '1 夾帶別家門市 → 照舊忽略（進金山）');
    const ul = post(sb, 'staffUnitList', {}, t);
    ok(ul.ok && ul.data.unit === 'mzt-js' && ul.data.people.some((x) => x.emp_no === 'DZY304') && !ul.data.people.some((x) => x.emp_no === 'DZY302'), '1 名單＝金山', ul.ok ? ul.data.unit : ul);
    ok(ul.ok && ul.data.units.length === 1 && !!ul.data.unit_name, '1 只管一家 → 不需切換（units 一筆）、有店名');
    ok(post(sb, 'staffLeave', { emp_no: 'DZY305', last_day: app.today }, t).ok, '1 ★可對金山計時登記離職');
    ok(post(sb, 'staffLeave', { emp_no: 'DZY304', last_day: app.today }, t).ok, '1 ★可對金山正職登記離職（店長職級高於正職）');
    ok(post(sb, 'staffLeave', { emp_no: 'DZY308', last_day: app.today }, t).code === 'no_perm', '1 不能對區經理登記離職');
    ok(post(sb, 'staffLeave', { emp_no: 'DZY302', last_day: app.today }, t).code === 'no_perm', '1 不能動光復的人');
    ok(post(sb, 'staffRename', { emp_no: 'DZY305', name: '改名' }, t).code === 'no_perm', '1 改名照舊只有總部');
    app.sheets.staff_clock._data.find((r) => r[0] === 'DZY304')[3] = 'home';
    const lk = post(sb, 'clockLink', { emp_no: 'DZY304' }, t);
    ok(lk.ok && lk.data.job_id, '1 可拿金山同仁的打卡連結', lk);
    ok(post(sb, 'clockJobStatus', { job_id: lk.data.job_id }, t).ok, '1 看得到自己要的待辦單');
    // 收回
    ok(post(sb, 'permExRevoke', { ex_id: ex.data.ex_id }, app.tok.DZY320).ok, '1 前置：撤銷兼任');
    ok(app.add(t, 'pt').code === 'no_perm', '1 ★撤銷後下一個請求就不能新增');
  }

  // ============================================================
  // 2. 本身光復店長、又兼任金山（2A 門市切換）
  // ============================================================
  {
    const app = setup();
    const { sb, sheets } = app;
    const t = app.tok.DZY303;
    ok(app.add(t, 'pt', 'mzt-js').data?.unit === 'mzt-gf', '2 前置：兼任之前帶金山也只會進光復');
    ok(app.ex('DZY303', 'store.sm@mzt-js').ok, '2 前置：給兼任金山店長');
    const u0 = post(sb, 'staffUnitList', {}, t);
    ok(u0.ok && u0.data.unit === 'mzt-gf' && u0.data.units.map((x) => x.code).join() === 'mzt-gf,mzt-js', '2 ★預設本店、units 兩家（前端畫切換）', u0.ok ? u0.data.units : u0);
    const u1 = post(sb, 'staffUnitList', { unit: 'mzt-js' }, t);
    ok(u1.ok && u1.data.unit === 'mzt-js' && u1.data.people.some((x) => x.emp_no === 'DZY304') && !u1.data.people.some((x) => x.emp_no === 'DZY302'), '2 ★切到金山 → 金山名單');
    ok(post(sb, 'staffUnitList', { unit: 'mzt-lzl' }, t).data?.unit === 'mzt-gf', '2 帶管不到的店 → 忽略、回本店');
    ok(app.add(t, 'pt', 'mzt-lzl').data?.unit === 'mzt-gf', '2 新增夾帶管不到的店 → 忽略、進本店');
    const a = app.add(t, 'pt', 'mzt-js');
    ok(a.ok && a.data.unit === 'mzt-js', '2 ★帶金山 → 新增到金山', a);
    const b = app.add(t, 'pt');
    ok(b.ok && b.data.unit === 'mzt-gf', '2 不帶單位 → 本店（舊前端相容）', b);
    ok(app.add(t, 'pt', 'mzt-gf').ok, '2 帶本店 → 本店');
    ok(post(sb, 'staffLeave', { emp_no: 'DZY305', last_day: app.today }, t).ok, '2 可對金山計時登記離職');
    ok(post(sb, 'staffLeave', { emp_no: 'DZY302', last_day: app.today }, t).ok, '2 可對光復計時登記離職');
    ok(post(sb, 'staffLeave', { emp_no: 'DZY309', last_day: app.today }, t).code === 'no_perm', '2 不能動六張犁的人');
    // 打卡對照：兩家店的「待確認」都看得到、都能確認
    sheets.staff_clock._data.push(['DZY305', 'mztjs', 'MZTJS905', 'staff', 'suggested', 'created', 'TRUE', '', '', '', '']);
    sheets.staff_clock._data.push(['DZY309', 'mztlzl', 'MZTLZL909', 'staff', 'suggested', 'created', 'TRUE', '', '', '', '']);
    const ml = post(sb, 'clockMapList', {}, t);
    ok(ml.ok && ml.data.suggested.some((m) => m.store_code === 'mztjs') && !ml.data.suggested.some((m) => m.store_code === 'mztlzl'), '2 ★打卡對照看得到金山、看不到六張犁', ml.ok ? ml.data.suggested : ml);
    ok(post(sb, 'clockMapDecide', { store_code: 'mztlzl', emp_id: 'MZTLZL909', decision: 'confirm' }, t).code === 'no_perm', '2 不能決定六張犁的對照');
    const md = post(sb, 'clockMapDecide', { store_code: 'mztjs', emp_id: 'MZTJS905', decision: 'reject' }, t);
    ok(md.ok && md.data.escalated === true, '2 ★可處理金山的對照（按「不對」轉總部）', md);
    const al = post(sb, 'clockAlerts', {}, t);
    ok(al.ok, '2 首頁提醒照常', al);
  }

  // ============================================================
  // 2b. 代理店長：兼任設在本人主要單位（dzy#67，Eason 2026-10-30 選 A）
  // ============================================================
  {
    const app = setup();
    const { sb } = app;
    const t = app.tok.DZY301;
    const ex = app.ex('DZY301', 'store.sm@mzt-gf');
    ok(ex.ok, '2b 前置：光復正職兼任光復店長（代理店長）', ex);
    const a = app.add(t, 'sm');
    ok(a.ok && a.data.unit === 'mzt-gf', '2b ★代理店長在本店可新增店長（店長職級）', a);
    ok(post(sb, 'staffLeave', { emp_no: 'DZY302', last_day: app.today }, t).ok, '2b 可對本店計時登記離職');
    const ul = post(sb, 'staffUnitList', {}, t);
    ok(ul.ok && ul.data.unit === 'mzt-gf' && ul.data.units.length === 1, '2b 只管一家 → 不需切換');
    ok(app.ex('DZY303', 'store.sm@mzt-gf').ok !== true, '2b 本人已是該店店長 → 不能再設（PermActions 擋）');
  }

  // ============================================================
  // 3. 前端：我的單位門市切換（字串檢查，畫面另有真瀏覽器實測）
  // ============================================================
  {
    const ui = fs.readFileSync(path.join(__dirname, '..', 'modules', 'staff-shared', 'clock-ui.js'), 'utf8');
    ok(ui.indexOf('data-role="unit-switch"') !== -1 && ui.indexOf("myUnits.length < 2") !== -1, '3 管兩家以上才畫門市切換');
    ok(/staffUnitList', pickUnit \? \{ unit: pickUnit \}/.test(ui), '3 切換後帶 unit 重讀名單');
    ok(ui.indexOf('if (env.myUnit) payload.unit = env.myUnit;') !== -1, '3 新增帶目前門市');
  }

  console.log('\n' + (failed ? '失敗' : '通過') + ' ' + passed + '／' + (passed + failed));
  if (failed) process.exit(1);
})();
