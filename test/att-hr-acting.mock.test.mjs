// node test/att-hr-acting.mock.test.mjs —— 財務部改人資主管核＋兼任店長（docs/att-hr-acting/spec.md）驗收
// 測試骨架照抄 storeops.mock.test.mjs（vm 載 .gs、world()）；多載 ApprovalRoute.gs／Approvals.gs 驗請購第一關。
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
  ['DZY201', '兼任甲', 'mzt-hq', '', 'osv', 'active', '2026-01-01'],      // 主要身分：墨竹亭辦公室督導；兼任六張犁店長
  ['DZY202', '六張犁正職', 'mzt-lzl', '', 'ft', 'active', '2026-01-02'],
  ['DZY203', '六張犁計時', 'mzt-lzl', '', 'pt', 'active', '2026-01-03'],
  ['DZY204', '六張犁值班正職', 'mzt-lzl', '', 'ft', 'active', '2026-01-04'],
  ['DZY205', '六張犁新人', 'mzt-lzl', '', 'pt', 'pending', ''],
  ['DZY206', '六張犁區經理', 'mzt-lzl', '', 'am', 'active', '2026-01-06'],
  ['DZY210', '墨竹亭總監', 'mzt-hq', '', 'odir', 'active', '2026-01-10'],
  ['DZY220', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-20'],
  ['DZY221', '財務總監', 'dzy-hq', 'fin', 'hm', 'active', '2026-01-21'],
  ['DZY222', '財務同仁', 'dzy-hq', 'fin', 'hs', 'active', '2026-01-22'],
  ['DZY223', '資訊總監', 'dzy-hq', 'it', 'hm', 'active', '2026-01-23'],
  ['DZY224', '資訊同仁', 'dzy-hq', 'it', 'hs', 'active', '2026-01-24'],
  ['DZY230', '光復計時', 'mzt-gf', '', 'pt', 'active', '2026-01-30'],
  ['DZY231', '光復店長', 'mzt-gf', '', 'sm', 'active', '2026-01-31'],
  ['DZY232', '金山店長', 'mzt-js', '', 'sm', 'active', '2026-02-01']
];
const PILOT = 'ck,dzy-hq,mala-gf,mala-hq,mzt-gf,mzt-hq,mzt-js,mzt-lzl';

function setup() {
  const app = world(CAST, { pilot: PILOT });
  const { sb, sheets } = app;
  app.props.PERMS_ON = '1';   // 第二期已開（稽核範圍、績效評核權限走 permSessionCompute_）
  // 兼任甲在六張犁另有一個打卡帳號（主要是總部 hq）；光復計時到六張犁支援
  sheets.staff_clock._data.push(['DZY201', 'mztlzl', 'MZTLZL201', 'staff', 'confirmed', 'created', 'TRUE', '', 'tester', '', '']);
  sheets.staff_clock._data.push(['DZY230', 'mztlzl', 'MZTLZL230', 'staff', 'confirmed', 'created', 'TRUE', '', 'tester', '', '']);
  // 新人送認領：p_* 填六張犁計時
  const row = sheets.staff._data.find((r) => r[0] === 'DZY205');
  row[sb.STF_COL.p_brand] = 'mzt'; row[sb.STF_COL.p_unit] = 'mzt-lzl'; row[sb.STF_COL.p_title] = 'pt';
  row[sb.STF_COL.unit] = ''; row[sb.STF_COL.title] = ''; row[sb.STF_COL.brand] = '';
  app.tok = {};
  ['DZY201', 'DZY220', 'DZY221', 'DZY223', 'DZY224', 'DZY231'].forEach((e) => { app.tok[e] = app.login(e); });
  app.setDuty = (emp, store, v) => {
    const r = sheets.staff_clock._data.find((x) => x[0] === emp && x[1] === store);
    while (r.length < 16) r.push('');
    r[15] = v;
  };
  app.ex = (tok, emp, perm, extra) => {
    const r = post(sb, 'permExSave', Object.assign({ emp_no: emp, perm, mode: 'add', until: '', note: '測試兼任' }, extra || {}), tok);
    sb.permActingReset_();
    return r;
  };
  app.H = (sub) => app.ident(sub).att.people.map((x) => x.clock + ':' + x.sub);
  app.R = (sub) => app.ident(sub).att.req_people.map((x) => x.clock + ':' + x.sub);
  app.V = (sub) => app.ident(sub).att.view_people.map((x) => x.clock + ':' + x.sub);
  app.perms = (emp) => { const r = post(sb, 'login', { username: emp, password: PW }); return r.ok ? r.data.perms : []; };
  app.me = (emp) => post(sb, 'me', {}, app.login(emp)).data;
  return app;
}

// ============================================================
// 1. 財務部同仁改由人資主管核
// ============================================================
(() => {
  const app = setup();
  const { sb } = app;
  ok(eq(app.H('DZY221'), []) && eq(app.R('DZY221'), []), '1 ★財務總監核定工時、申請名單都空');
  ok(has(app.H('DZY220'), 'hq:DZY222') && has(app.R('DZY220'), 'hq:DZY222'), '1 人資主管核財務同仁（工時＋申請）');
  ok(has(app.H('U:a001'), 'hq:DZY222'), '1 admin 照舊可核');
  ok(eq(app.H('DZY223'), ['hq:DZY224']) && eq(app.R('DZY223'), ['hq:DZY224']), '1 其他部門照舊：資訊總監核資訊同仁、不含財務');
  const org = sb.stfReadOrg_();
  ok(sb.attNeedOf_({ unit: 'dzy-hq', dept: 'fin', title: 'hs' }, org, 'req').kind === 'hr_only', '1 attNeedOf_ 財務部 → hr_only（申請）');
  ok(sb.attApproverOf_({ emp: 'DZY221', status: 'active', unit: 'dzy-hq', dept: 'fin', title: 'hm' }, { emp: 'DZY222', status: 'active', unit: 'dzy-hq', dept: 'fin', title: 'hs' }, org, 'hours') === false, '1 attApproverOf_ 財務總監 → false');
  // att.extra（同單位 dzy-hq）照舊可核
  ok(app.ex(app.adminTok, 'DZY224', 'att.extra').ok, '1 前置：資訊同仁設 att.extra');
  ok(has(app.H('DZY224'), 'hq:DZY222'), '1 att.extra 例外仍可核財務同仁');
  // 選單：財務總監拿掉、其他部門總監照舊、財務總監有其他來源照舊有
  ok(!has(app.perms('DZY221'), 'platform.att'), '1 ★財務總監沒有考勤管理選單');
  ok(has(app.perms('DZY223'), 'platform.att') && has(app.perms('DZY220'), 'platform.att'), '1 資訊總監、人資主管照舊有');
  const before = app.perms('DZY221').filter((p) => p !== 'platform.att');
  ok(app.ex(app.adminTok, 'DZY221', 'att.extra').ok && has(app.perms('DZY221'), 'platform.att'), '1 財務總監有 att.extra 時照舊有選單（其他來源不受影響）');
  ok(before.every((p) => has(app.perms('DZY221'), p)), '1 財務總監其他權限沒被拿掉');
})();

// ============================================================
// 2. 兼任店長：設定
// ============================================================
(() => {
  const app = setup();
  const { sb } = app;
  ok(!app.H('DZY201').some((x) => x.indexOf('mztlzl:') === 0) && !app.R('DZY201').some((x) => /mztlzl:DZY20[234]/.test(x)), '2 前置：沒設兼任時督導不核六張犁計時正職');
  ok(app.ex(app.tok.DZY231, 'DZY201', 'store.sm@mzt-lzl').code === 'no_perm', '2 ★店長不能設兼任店長');
  ok(app.ex(app.tok.DZY220, 'DZY220', 'store.sm@mzt-lzl').code === 'perm_self', '2 ★人資主管不能設給自己');
  ok(app.ex(app.tok.DZY220, 'DZY201', 'store.sm@ck').code === 'bad_target', '2 ★央廚不適用');
  ok(app.ex(app.tok.DZY220, 'DZY201', 'store.sm@mzt-hq').code === 'bad_target', '2 品牌辦公室不適用');
  ok(app.ex(app.tok.DZY220, 'DZY201', 'store.sm@mzt-lzl', { mode: 'remove' }).code === 'bad_mode', '2 只能多給');
  ok(app.ex(app.tok.DZY220, 'DZY205', 'store.sm@mzt-lzl').code === 'bad_target', '2 ★沒開通（pending）的人不能設');
  ok(sb.permIsGrantable_('store.sm@mzt-lzl') === false, '2 不在 PERM_GRANTABLE（對照表不收）');
  const list = post(sb, 'permExList', {}, app.tok.DZY220);
  ok(list.ok && list.data.acting_units.some((u) => u.code === 'mzt-lzl') && !list.data.acting_units.some((u) => u.code === 'ck') && list.data.att_view_units === undefined, '2 人資主管拿得到兼任門市清單（不含央廚）、拿不到只看考勤清單', list.data);
  const s = app.ex(app.tok.DZY220, 'DZY201', 'store.sm@mzt-lzl');
  ok(s.ok, '2 ★人資主管能設兼任店長', s);
  const list2 = post(sb, 'permExList', {}, app.tok.DZY220);
  ok(list2.data.items.some((x) => x.perm === 'store.sm@mzt-lzl' && x.emp_no === 'DZY201'), '2 人資主管看得到這筆例外');
  ok(sb.permName_('store.sm@mzt-lzl').indexOf('兼任店長') === 0, '2 顯示名稱「兼任店長（…）」', sb.permName_('store.sm@mzt-lzl'));
  ok(eq(sb.permActingUnitsOf_('DZY201'), ['mzt-lzl']), '2 permActingUnitsOf_');
  // 撤銷（人資主管可撤）
  const rv = post(sb, 'permExRevoke', { ex_id: s.data.ex_id }, app.tok.DZY220);
  sb.permActingReset_();
  ok(rv.ok && eq(sb.permActingUnitsOf_('DZY201'), []), '2 人資主管能撤銷，撤銷後立刻沒有', rv);
})();

// ============================================================
// 3. 兼任店長：考勤（工時、申請、值班主管、支援、營運系統）
// ============================================================
(() => {
  const app = setup();
  const { sb } = app;
  app.ex(app.tok.DZY220, 'DZY201', 'store.sm@mzt-lzl');
  const H = app.H('DZY201'), R = app.R('DZY201');
  ok(['mztlzl:DZY202', 'mztlzl:DZY203', 'mztlzl:DZY204', 'mztlzl:DZY206'].every((x) => has(H, x)), '3 ★核定工時：六張犁全店（含區經理工時，同店長）', H);
  ok(['mztlzl:DZY202', 'mztlzl:DZY203', 'mztlzl:DZY204'].every((x) => has(R, x)), '3 ★申請：六張犁計時正職', R);
  ok(has(R, 'mztlzl:DZY206') && has(R, 'mztgf:DZY231'), '3 區經理、各店店長的申請本來就由督導（主要身分）核，不受兼任影響', R);
  ok(!H.some((x) => x.indexOf(':DZY201') !== -1) && !R.some((x) => x.indexOf(':DZY201') !== -1), '3 ★不核自己（含自己的六張犁帳號）');
  ok(!H.some((x) => /DZY23[012]/.test(x) && x.indexOf('mztlzl:') !== 0), '3 不核別店');
  // 他自己照原身分：辦公室總監核他的工時（兩個帳號）
  ok(has(app.H('DZY210'), 'hq:DZY201') && has(app.H('DZY210'), 'mztlzl:DZY201'), '3 ★兼任者本人的工時照原身分由辦公室總監核（含六張犁帳號）');
  // 值班主管：兼任者與 DZY204 都是六張犁值班主管
  app.setDuty('DZY201', 'mztlzl', 'TRUE');
  app.setDuty('DZY204', 'mztlzl', 'TRUE');
  const R2 = app.R('DZY201');
  ok(has(R2, 'mztlzl:DZY202') && has(R2, 'mztlzl:DZY203'), '3 ★兼任者是值班主管也照核一般同仁的申請（不被值班規則擋）', R2);
  ok(!has(R2, 'mztlzl:DZY204'), '3 ★值班正職的申請往上送，兼任者（同店值班主管）不核', R2);
  ok(has(app.R('DZY206'), 'mztlzl:DZY204'), '3 值班正職的申請給區經理');
  ok(has(app.H('DZY201'), 'mztlzl:DZY204'), '3 值班正職的工時兼任者照核（hours 不受值班規則影響）');
  // 兼任者本人的申請：照原身分（辦公室總監），值班規則不改變
  ok(has(app.R('DZY210'), 'mztlzl:DZY201') || has(app.R('DZY210'), 'hq:DZY201'), '3 兼任者本人的申請由辦公室總監核');
  // 支援：光復計時到六張犁打卡 → 兼任者核；光復店長只看
  ok(has(app.H('DZY201'), 'mztlzl:DZY230') && has(app.R('DZY201'), 'mztlzl:DZY230'), '3 ★支援到六張犁的帳號由兼任者核（Q2 A）');
  ok(!has(app.H('DZY231'), 'mztlzl:DZY230') && has(app.V('DZY231'), 'mztlzl:DZY230'), '3 原單位店長對支援帳號只看');
  ok(has(app.H('DZY231'), 'mztgf:DZY230'), '3 光復本店帳號照舊光復店長核');
  // 營運系統：units_managed、選單
  const id = app.ident('DZY201');
  ok(has(id.units_managed, 'mzt-lzl'), '3 ★ident units_managed 含六張犁（營運系統＝店長：整店功能、排班）', id.units_managed);
  ok(!has(id.void_units, 'mzt-lzl'), '3 收支作廢不給');
  const p = app.perms('DZY201');
  ok(['platform.att', 'platform.sched', 'platform.storeops', 'platform.review'].every((x) => has(p, x)), '3 ★選單：考勤、排班、門市營運、待審核', p);
  // attUpperGaps：設兼任前後一樣
  const gaps = post(sb, 'attUpperGaps', {}, app.adminTok).data.items.map((x) => x.emp);
  ok(!has(gaps, 'DZY201') && eq(gaps, []), '3 attUpperGaps 不受影響（沒有誤報）', gaps);
})();

// ============================================================
// 4. 兼任店長：認領審核、請購第一關、人事異動直屬主管、績效評核、稽核
// ============================================================
(() => {
  const app = setup();
  const { sb } = app;
  const org = sb.stfReadOrg_();
  const valuesOf = (e) => app.sheets.staff._data.find((r) => r[0] === e);
  const pend0 = post(sb, 'unitPending', {}, app.tok.DZY201);
  ok(!pend0.ok || !pend0.data.people.some((x) => x.emp_no === 'DZY205'), '4 前置：沒兼任前看不到六張犁新人的認領');
  app.ex(app.tok.DZY220, 'DZY201', 'store.sm@mzt-lzl');
  const pend = post(sb, 'unitPending', {}, app.login('DZY201'));
  ok(pend.ok && pend.data.people.some((x) => x.emp_no === 'DZY205'), '4 ★認領審核：看得到六張犁新人', pend);
  ok(!pend.data.people.some((x) => x.emp_no !== 'DZY205'), '4 只有六張犁的認領');
  const sc = sb.stfReviewScope_(valuesOf('DZY201'), org);
  const need = (u, t) => sb.stfReviewNeed_(org, u, '', t);
  ok(sb.stfScopeMeets_(sc, need('mzt-lzl', 'pt'), null) && sb.stfScopeMeets_(sc, need('mzt-lzl', 'ft'), null), '4 人事異動直屬主管／績效：六張犁計時正職');
  ok(!sb.stfScopeMeets_(sc, need('mzt-gf', 'pt'), null), '4 別店計時不歸兼任者');
  // 職級比照店長：用沒有主要審核資格的人（資訊同仁）兼任來驗
  app.ex(app.tok.DZY220, 'DZY224', 'store.sm@mzt-lzl');
  const sc2 = sb.stfReviewScope_(valuesOf('DZY224'), org);
  ok(!!sc2 && eq(sc2.kinds, []) && sb.stfScopeMeets_(sc2, need('mzt-lzl', 'pt'), null), '4 一般同仁兼任：只靠兼任就有審核範圍');
  ok(!sb.stfScopeMeets_(sc2, need('mzt-lzl', 'sm'), null) && !sb.stfScopeMeets_(sc2, need('mzt-lzl', 'am'), null), '4 ★店長、區經理不歸兼任者（職級比照店長）');
  ok(!sb.stfScopeMeets_(sc2, need('mzt-gf', 'pt'), null) && !sb.stfScopeMeets_(sc2, sb.stfReviewNeed_(org, 'dzy-hq', 'it', 'hs'), null), '4 兼任不外溢到別店、總部');
  const exId224 = post(sb, 'permExList', {}, app.adminTok).data.items.find((x) => x.emp_no === 'DZY224').ex_id;
  post(sb, 'permExRevoke', { ex_id: exId224 }, app.adminTok); sb.permActingReset_();
  // 請購／請款第一關 head
  const dir = sb.apvDirectory_();
  const heads = (e) => sb.apvRoleMembers_('head', dir.byEmp[e], dir, null).map((p) => p.emp);
  ok(has(heads('DZY202'), 'DZY201'), '4 ★請購第一關：六張犁正職送的單兼任者可簽', heads('DZY202'));
  ok(!has(heads('DZY206'), 'DZY201'), '4 區經理送的單兼任者不能簽（職級）');
  ok(!has(heads('DZY230'), 'DZY201'), '4 別店的單不能簽');
  ok(eq(sb.apvDirectMembers_(dir.byEmp.DZY202, dir).map((p) => p.emp).filter((e) => e === 'DZY201'), ['DZY201']), '4 人事異動直屬主管含兼任者');
  // 績效評核、稽核（login 的權限與範圍）
  post(sb, 'permStoreSave', { unit: 'mzt-lzl', audit_store: 'mzt-lzl-a' }, app.adminTok);
  const me = app.me('DZY201');
  ok(has(me.perms, 'platform.eval-manage'), '4 ★績效評核：有替所屬同仁打分');
  ok(me.audit_scope === 'all' || (Array.isArray(me.audit_scope) && has(me.audit_scope, 'mzt-lzl-a')), '4 ★稽核範圍含六張犁', me.audit_scope);
  // 一般人（沒有任何稽核權限）兼任 → 補看自己店
  app.ex(app.tok.DZY220, 'DZY224', 'store.sm@mzt-lzl');
  const me2 = app.me('DZY224');
  ok(has(me2.perms, 'audit.read.own') && eq(me2.audit_scope, ['mzt-lzl-a']), '4 ★沒有稽核權限的人兼任 → 只看兼任店', me2);
  ok(has(me2.perms, 'platform.eval-manage') && has(me2.perms, 'platform.review'), '4 也有績效評核與待審核');
  // 撤銷 → 立即收回（下一次請求）
  const exId = post(sb, 'permExList', {}, app.adminTok).data.items.find((x) => x.emp_no === 'DZY224' && x.status === 'active').ex_id;
  post(sb, 'permExRevoke', { ex_id: exId }, app.adminTok);
  sb.permActingReset_();
  const me3 = app.me('DZY224');
  ok(!has(me3.perms, 'audit.read.own') && !has(me3.perms, 'platform.eval-manage') && me3.audit_scope !== 'all' && (!Array.isArray(me3.audit_scope) || me3.audit_scope.length === 0), '4 ★撤銷後稽核、績效立刻收回', me3);
  ok(!has(app.perms('DZY224'), 'platform.storeops') && !has(app.ident('DZY224').units_managed, 'mzt-lzl'), '4 ★撤銷後門市營運、營運系統店長收回（排班管理他本來就有總部自填）');
})();

// ============================================================
// 5. 兼任店長：到期、停用、單位停用
// ============================================================
(() => {
  const app = setup();
  const { sb, sheets } = app;
  const s = app.ex(app.tok.DZY220, 'DZY201', 'store.sm@mzt-lzl', { until: '2099-12-31' });
  ok(s.ok && has(app.H('DZY201'), 'mztlzl:DZY202'), '5 前置：設到期日 2099 有效');
  const exRow = sheets.perm_ex._data.find((r) => r[0] === s.data.ex_id);
  exRow[4] = '2020-01-01'; sb.permActingReset_();
  ok(!has(app.H('DZY201'), 'mztlzl:DZY202') && !has(app.ident('DZY201').units_managed, 'mzt-lzl'), '5 ★過期 → 失效');
  exRow[4] = sb.permTodayTaipei_(); sb.permActingReset_();
  ok(has(app.H('DZY201'), 'mztlzl:DZY202'), '5 到期日當天仍有效');
  exRow[4] = 'bad-date'; sb.permActingReset_();
  ok(!has(app.H('DZY201'), 'mztlzl:DZY202'), '5 壞日期 → 不給（fail closed）');
  exRow[4] = ''; sb.permActingReset_();
  // 單位停用
  const orgRow = sheets.org._data.find((r) => r[0] === 'unit' && r[1] === 'mzt-lzl');
  orgRow[7] = 'FALSE'; sb.permActingReset_();
  ok(eq(sb.permActingUnitsOf_('DZY201'), []), '5 ★六張犁停用 → 兼任失效');
  orgRow[7] = 'TRUE'; sb.permActingReset_();
  // 兼任者停用
  const st = sheets.staff._data.find((r) => r[0] === 'DZY201');
  st[sb.STF_COL.status] = 'disabled'; sb.permActingReset_();
  ok(!sb.storePeople_().find((p) => p.emp === 'DZY201').acting_units.length, '5 ★兼任者停用 → 不再當核定人');
  ok(!has(app.H('DZY210'), 'mztlzl:DZY202'), '5 對照組：總監本來就不核六張犁同仁工時');
})();

// ============================================================
// 6. 前端純函式
// ============================================================
(async () => {
  const L = await import('../modules/perms/lib.js');
  ok(L.actingCode('mzt-lzl') === 'store.sm@mzt-lzl' && L.actingCode('a b') === '' && L.actingUnitOf('store.sm@mzt-lzl') === 'mzt-lzl', '6 actingCode／actingUnitOf');
  ok(L.featureName('store.sm@mzt-lzl', [{ code: 'mzt-lzl', name: '墨竹亭 台北六張犁' }]) === '兼任店長（墨竹亭 台北六張犁）', '6 featureName 兼任店長');
  const B = await import('../modules/me/perm-block.js');
  const txt = fs.readFileSync(path.join(__dirname, '..', 'modules', 'me', 'perm-block.js'), 'utf8');
  ok(/case 'acting'/.test(txt) && /case 'acting'/.test(fs.readFileSync(path.join(__dirname, '..', 'modules', 'perms', 'lib.js'), 'utf8')), '6 權限來源「因為兼任店長」兩處都有');
  void B;
  console.log('\n' + (failed ? '失敗' : '通過') + ' ' + passed + '／' + (passed + failed));
  if (failed) process.exit(1);
})();
