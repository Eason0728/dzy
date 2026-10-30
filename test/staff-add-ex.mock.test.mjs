// node test/staff-add-ex.mock.test.mjs —— 個別例外「可新增同仁」staff.add@<本店>（docs/staff-add-ex/requirements.md，Eason 1A 2B 3A 4A）驗收
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
  ['DZY301', '光復正職甲', 'mzt-gf', '', 'ft', 'active', '2026-01-01'],   // 拿例外的人
  ['DZY302', '光復計時', 'mzt-gf', '', 'pt', 'active', '2026-01-02'],
  ['DZY303', '光復店長', 'mzt-gf', '', 'sm', 'active', '2026-01-03'],
  ['DZY304', '金山正職', 'mzt-js', '', 'ft', 'active', '2026-01-04'],
  ['DZY305', '光復正職乙', 'mzt-gf', '', 'ft', 'active', '2026-01-05'],   // 沒有例外
  ['DZY306', '央廚正職', 'ck', '', 'ft', 'active', '2026-01-06'],
  ['DZY307', '光復新人', 'mzt-gf', '', 'pt', 'pending', ''],
  ['DZY310', '墨竹亭行政', 'mzt-hq', '', 'ofs', 'active', '2026-01-10'],
  ['DZY320', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-20']
];
const PILOT = 'ck,dzy-hq,mala-gf,mala-hq,mzt-gf,mzt-hq,mzt-js';

function setup() {
  const app = world(CAST, { pilot: PILOT });
  const { sb, sheets } = app;
  app.props.PERMS_ON = '1';
  app.tok = {};
  ['DZY301', 'DZY303', 'DZY305', 'DZY306', 'DZY320'].forEach((e) => { app.tok[e] = app.login(e); });
  app.ex = (tok, emp, perm, extra) => post(sb, 'permExSave', Object.assign({ emp_no: emp, perm, mode: 'add', until: '', note: '測試可新增同仁' }, extra || {}), tok);
  app.perms = (emp) => { const r = post(sb, 'login', { username: emp, password: PW }); return r.ok ? r.data.perms : []; };
  app.today = sb.clkTodayOf_(new Date());
  let seq = 0;
  app.add = (tok, title, name) => post(sb, 'staffCreateByUnit', { name: name || ('新人測試' + (++seq)), title, hire_date: app.today, phone: '0912345' + String(100 + seq).slice(-3) }, tok);
  return app;
}

(async () => {
  // ============================================================
  // 1. 設定
  // ============================================================
  {
    const app = setup();
    const { sb } = app;
    ok(app.ex(app.tok.DZY303, 'DZY301', 'staff.add@mzt-gf').code === 'no_perm', '1 ★店長不能設');
    ok(app.ex(app.tok.DZY320, 'DZY320', 'staff.add@dzy-hq').code === 'perm_self', '1 ★人資主管不能設給自己');
    ok(app.ex(app.tok.DZY320, 'DZY301', 'staff.add@mzt-js').code === 'bad_target', '1 ★單位不是本人所屬的店 → 擋');
    ok(app.ex(app.tok.DZY320, 'DZY310', 'staff.add@mzt-hq').code === 'bad_target', '1 品牌辦公室不適用');
    ok(app.ex(app.tok.DZY320, 'DZY301', 'staff.add@mzt-gf', { mode: 'remove' }).code === 'bad_mode', '1 只能多給');
    ok(app.ex(app.tok.DZY320, 'DZY307', 'staff.add@mzt-gf').code === 'bad_target', '1 沒開通（pending）的人不能設');
    ok(sb.permIsGrantable_('staff.add@mzt-gf') === false, '1 不在 PERM_GRANTABLE（對照表不收）');
    const r = app.ex(app.tok.DZY320, 'DZY301', 'staff.add@mzt-gf');
    ok(r.ok, '1 ★人資主管可設給光復正職', r);
    ok(app.ex(app.tok.DZY320, 'DZY301', 'staff.add@mzt-gf').code === 'dup', '1 同人同店重複 → 擋');
    ok(app.ex(app.adminTok, 'DZY306', 'staff.add@ck').ok, '1 央廚可設（admin）');
    const list = post(sb, 'permExList', {}, app.tok.DZY320);
    ok(list.ok && list.data.items.some((x) => x.perm === 'staff.add@mzt-gf') && Array.isArray(list.data.staff_add_units) && list.data.staff_add_units.some((u) => u.code === 'ck') && !list.data.staff_add_units.some((u) => u.code === 'mzt-hq'), '1 人資主管看得到這筆例外與可選門市（含央廚、不含辦公室）');
    ok(sb.permName_('staff.add@mzt-gf').indexOf('可新增同仁（') === 0, '1 中文名');
    ok(app.sheets.perm_audit._data.some((x) => x.indexOf('staff.add@mzt-gf') !== -1), '1 權限異動有紀錄');
  }

  // ============================================================
  // 2. 效果（Q2 B：跟店長一樣；Q3 A：不高於自己）
  // ============================================================
  {
    const app = setup();
    const { sb } = app;
    ok(app.add(app.tok.DZY301, 'pt').code === 'no_perm', '2 前置：沒設之前正職不能新增');
    ok(!has(app.perms('DZY301'), 'platform.unitstaff'), '2 前置：沒設之前沒有「我的單位」');
    ok(app.ex(app.tok.DZY320, 'DZY301', 'staff.add@mzt-gf').ok, '2 前置：設例外');
    const p = app.perms('DZY301');
    ok(has(p, 'platform.unitstaff') && !has(p, 'platform.review'), '2 ★多「我的單位」權限、沒有待審核', p);
    ok(!has(app.perms('DZY305'), 'platform.unitstaff'), '2 同店其他正職不受影響');
    const t = app.login('DZY301');
    const a1 = app.add(t, 'pt');
    ok(a1.ok && a1.data.unit === 'mzt-gf', '2 ★新增計時 → 單位固定光復', a1);
    ok(app.add(t, 'ft').ok, '2 ★新增正職（不高於自己）');
    ok(app.add(t, 'sm').code === 'no_perm', '2 ★不能新增店長（比自己高）');
    ok(post(sb, 'staffCreateByUnit', { name: '夾帶單位', title: 'pt', hire_date: app.today, phone: '0912000999', unit: 'mzt-js' }, t).data?.unit === 'mzt-gf', '2 夾帶別店單位一律忽略');
    ok(app.add(app.tok.DZY305, 'pt').code === 'no_perm', '2 沒例外的正職照舊不能新增');
    const ul = post(sb, 'staffUnitList', {}, t);
    ok(ul.ok && ul.data.unit === 'mzt-gf' && ul.data.people.some((x) => x.emp_no === 'DZY302') && !ul.data.people.some((x) => x.emp_no === 'DZY304'), '2 名單只有本店');
    ok(post(sb, 'staffLeave', { emp_no: 'DZY302', last_day: app.today }, t).ok, '2 可對計時登記離職');
    ok(post(sb, 'staffLeave', { emp_no: 'DZY305', last_day: app.today }, t).code === 'no_perm', '2 不能對同職級（正職）登記離職');
    ok(post(sb, 'staffLeave', { emp_no: 'DZY304', last_day: app.today }, t).code === 'no_perm', '2 不能動別店的人');
    ok(post(sb, 'staffRename', { emp_no: 'DZY302', name: '改名' }, t).code === 'no_perm', '2 改名照舊只有總部');
    ok(post(sb, 'staffReinstate', { emp_no: 'DZY302' }, t).code === 'no_perm', '2 復職照舊只有總部');
    app.sheets.staff_clock._data.find((r) => r[0] === 'DZY305')[3] = 'home';   // 主店帳號才給連結
    const lk = post(sb, 'clockLink', { emp_no: 'DZY305' }, t);
    ok(lk.ok && lk.data.job_id, '2 ★可拿本店同仁的打卡連結（跟店長一樣）', lk);
    const pend = post(sb, 'unitPending', {}, t);
    ok(!pend.ok || !(pend.data.people || []).length, '2 ★不能看待審核名單', pend);
    ok(post(sb, 'unitApprove', { emp_no: 'DZY307' }, t).ok !== true, '2 ★不能審核開通');
    ok(app.add(app.tok.DZY303, 'ft').ok, '2 店長照舊能新增');
    // 央廚
    ok(app.ex(app.adminTok, 'DZY306', 'staff.add@ck').ok, '2 前置：央廚正職設例外');
    const ck = app.add(app.login('DZY306'), 'pt');
    ok(ck.ok && ck.data.unit === 'ck', '2 央廚正職可新增央廚計時', ck);
  }

  // ============================================================
  // 3. 收回：撤銷、到期、調店（Q4 A）、停用
  // ============================================================
  {
    const app = setup();
    const { sb, sheets } = app;
    const id = app.ex(app.tok.DZY320, 'DZY301', 'staff.add@mzt-gf').data.ex_id;
    const t = app.login('DZY301');
    ok(app.add(t, 'pt').ok, '3 前置：可新增');
    ok(post(sb, 'permExRevoke', { ex_id: id }, app.tok.DZY320).ok, '3 人資主管可撤銷');
    ok(app.add(t, 'pt').code === 'no_perm' && !has(app.perms('DZY301'), 'platform.unitstaff'), '3 ★撤銷後下一個請求就不能新增、分頁消失');

    const id2 = app.ex(app.tok.DZY320, 'DZY301', 'staff.add@mzt-gf').data.ex_id;
    ok(app.add(t, 'pt').ok, '3 重設後又可以');
    const row = sheets.perm_ex._data.find((r) => r[0] === id2);   // 到期日改成前天
    const y = new Date(Date.now() - 86400000 * 2); row[4] = y.toISOString().slice(0, 10);
    ok(app.add(t, 'pt').code === 'no_perm', '3 ★過期就失效');
    row[4] = '';
    ok(app.add(t, 'pt').ok, '3 前置：恢復不到期');
    const srow = sheets.staff._data.find((r) => r[0] === 'DZY301');
    srow[sb.STF_COL.unit] = 'mzt-js';
    ok(app.add(t, 'pt').code === 'no_perm' && !has(app.perms('DZY301'), 'platform.unitstaff'), '3 ★調到別店自動失效（Q4 A）');
    ok(row[6] === 'TRUE' || row[6] === true, '3 例外列本身沒被改（調回來會恢復）');
    srow[sb.STF_COL.unit] = 'mzt-gf';
    ok(app.add(t, 'pt').ok, '3 調回原店恢復');
    srow[sb.STF_COL.title] = 'xx';
    ok(app.add(t, 'pt').code !== undefined && app.add(t, 'pt').ok !== true, '3 主要身分無效（職稱不存在）→ 不給');
  }

  // ============================================================
  // 4. 前端
  // ============================================================
  const L = await import('../modules/perms/lib.js');
  ok(L.staffAddCode('mzt-gf') === 'staff.add@mzt-gf' && L.staffAddCode('a b') === '' && L.staffAddUnitOf('staff.add@mzt-gf') === 'mzt-gf', '4 staffAddCode／staffAddUnitOf');
  ok(L.featureName('staff.add@mzt-gf', [{ code: 'mzt-gf', name: '墨竹亭 新竹光復' }]) === '可新增同仁（墨竹亭 新竹光復）', '4 featureName');
  const V = await import('../modules/staff-shared/viewer.js');
  const mk = (perms) => ({ can: (p) => perms.indexOf(p) !== -1, user: {} });
  ok(V.viewerOf(mk(['platform.unitstaff'])).isLead === true && V.viewerOf(mk([])).isLead === false, '4 viewerOf：platform.unitstaff 算單位主管畫面');
  console.log('\n' + (failed ? '失敗' : '通過') + ' ' + passed + '／' + (passed + failed));
  if (failed) process.exit(1);
})();
