// node test/staff-apply.mock.test.mjs —— 新進同仁自行申請帳號（docs/self-apply/spec.md，Eason 1A 2A 3A 4B 5B，不做邀請碼）驗收
// 測試骨架照抄 staff-add-ex.mock.test.mjs（vm 載 .gs、world()）。⚠ 全部假資料（public repo）。

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
  ['DZY301', '光復正職甲', 'mzt-gf', '', 'ft', 'active', '2026-01-01'],   // 拿「可新增同仁」staff.add@mzt-gf
  ['DZY302', '光復計時', 'mzt-gf', '', 'pt', 'active', '2026-01-02'],
  ['DZY303', '光復店長', 'mzt-gf', '', 'sm', 'active', '2026-01-03'],
  ['DZY304', '金山店長', 'mzt-js', '', 'sm', 'active', '2026-01-04'],
  ['DZY305', '光復正職乙', 'mzt-gf', '', 'ft', 'active', '2026-01-05'],   // 沒有例外
  ['DZY306', '金山正職', 'mzt-js', '', 'ft', 'active', '2026-01-06'],     // 兼任六張犁店長 store.sm@mzt-lzl
  ['DZY307', '名冊新人', 'mzt-gf', '', 'pt', 'unclaimed', ''],
  ['DZY310', '墨竹亭總監', 'mzt-hq', '', 'odir', 'active', '2026-01-10'],
  ['DZY311', '墨竹亭行政', 'mzt-hq', '', 'ofs', 'active', '2026-01-11'],
  ['DZY320', '人資主管', 'dzy-hq', 'hr', 'hm', 'active', '2026-01-20'],
  ['DZY321', '財務主管', 'dzy-hq', 'fin', 'hm', 'active', '2026-01-21'],
  ['DZY322', '財務同仁', 'dzy-hq', 'fin', 'hs', 'active', '2026-01-22'],
  ['DZY330', '已離職計時', 'mzt-gf', '', 'pt', 'disabled', '2026-01-23'],   // 最大號是停用的人 → 新編號不回收
  ['DZY329', '停用同名', 'mzt-lzl', '', 'pt', 'disabled', '2026-01-24'],
  ['DZY323', '行銷總監', 'dzy-hq', 'marketing', 'hm', 'active', '2026-01-25']
];
const PILOT = 'ck,dzy-hq,mala-gf,mala-hq,mzt-gf,mzt-hq,mzt-js,mzt-lzl';
const APW = 'fake-apply-pw-01';

function setup() {
  const app = world(CAST, { pilot: PILOT });
  const { sb } = app;
  app.props.PERMS_ON = '1';
  app.tok = {};
  ['DZY301', 'DZY302', 'DZY303', 'DZY304', 'DZY305', 'DZY306', 'DZY310', 'DZY320', 'DZY321', 'DZY323'].forEach((e) => { app.tok[e] = app.login(e); });
  app.tok.HR = app.login('HRUSER');
  app.today = sb.clkTodayOf_(new Date());
  let seq = 0;
  app.form = (o) => Object.assign({ name: '申請新人' + (++seq), phone: '09330000' + String(10 + seq).slice(-2), birthday: '1998-03-04',
    address: '新竹市測試路一段1號', brand: 'mzt', unit: 'mzt-gf', dept: '', title: 'pt', password: APW }, o || {});
  app.submit = (o) => post(sb, 'applySubmit', app.form(o));
  app.rows = () => (app.sheets.staff_apply ? app.sheets.staff_apply._rows().slice(1) : []);
  app.col = (h) => sb.STF_APPLY_HEADERS.indexOf(h);
  app.idOf = (name) => { const r = app.rows().filter((x) => x[app.col('name')] === name).pop(); return r ? r[app.col('apply_id')] : ''; };
  app.pending = (tok) => post(sb, 'unitPending', {}, tok);
  app.sees = (tok, name) => { const r = app.pending(tok); return !!(r.ok && (r.data.applies || []).some((x) => x.name === name)); };
  return app;
}

(async () => {
  // ============================================================
  // 1. 送出：驗證（沿用認領）、限流、擋
  // ============================================================
  {
    const app = setup();
    const { sb, cache } = app;
    const flood = () => { const e = cache.get('stf_g_apply_' + Math.floor(sb.stfNowSec_() / 600)); return e ? e.v : undefined; };
    ok(!app.sheets.staff_apply, '1 前置：還沒有 staff_apply 分頁');
    const st0 = post(sb, 'applyStatus', { name: '還沒申請', phone: '0933999999' });
    ok(st0.ok && st0.data.status === 'none' && !app.sheets.staff_apply, '1 查進度：分頁不存在 → none、不建表', st0);
    const bads = [
      [{ password: 'short' }, '密碼'], [{ phone: '12345' }, '手機'], [{ birthday: '1998-02-30' }, '生日'], [{ address: '短' }, '地址'],
      [{ unit: 'mzt-wx' }, '停用單位'], [{ title: 'fm' }, '職稱不合單位'], [{ unit: 'mzt-hq', title: 'ofs', dept: 'hr' }, '辦公室不用部門'],
      [{ brand: 'dzy', unit: 'dzy-hq', title: 'hs', dept: '' }, '總部要選部門'], [{ name: '超'.repeat(21) }, '姓名超過 20 字'],
      [{ name: '=公式' }, '姓名開頭公式'], [{ name: '' }, '姓名空白'], [{ brand: 'mala', unit: 'mzt-gf' }, '品牌與單位不合'],
      [{ password: 'x'.repeat(129) }, '密碼過長']
    ];
    bads.forEach(([o, label]) => { const r = app.submit(o); ok(r.ok === false && typeof r.error === 'string', '1 ★格式擋：' + label, r); });
    ok(!flood(), '1 ★格式錯不計入全域額度', flood());
    ok(!app.sheets.staff_apply, '1 格式錯不建表');
    const r1 = app.submit({ name: '新人甲' });
    ok(r1.ok && r1.data.pending === true && r1.data.apply_id === undefined && r1.data.token === undefined && keysOf(r1.data).join() === 'pending', '1 ★送出成功：只回 pending（不回 apply_id、token）', r1);
    const head = app.sheets.staff_apply._rows()[0];
    ok(eq(head, sb.STF_APPLY_HEADERS) && head.length === 18 && head[0] === 'apply_id' && head[17] === 'hire_date', '1 ★自動建表、表頭順序固定', head);
    const row = app.rows()[0];
    ok(/^APL\d{18}$/.test(row[app.col('apply_id')]) && row[app.col('status')] === 'pending' && row[app.col('unit')] === 'mzt-gf', '1 一列 pending', row);
    ok(row[app.col('salt')] && row[app.col('hash')] === sb.hashPassword_(APW, row[app.col('salt')]), '1 ★密碼只存 salt＋hash');
    ok(JSON.stringify(app.sheets.staff_apply._rows()).indexOf(APW) === -1, '1 ★試算表裡沒有明碼');
    ok(!app.sheets.staff._data.some((x) => x[2] === '新人甲') && !app.sheets.users._data.some((x) => x[2] === '新人甲'), '1 ★不寫 staff／users');
    ok(flood() === '1', '1 成功送出計 1 次');
    // 擋
    const phoneOf = row[app.col('phone')];
    ok(app.submit({ name: '換名字', phone: phoneOf }).code === 'dup_pending', '1 ★同手機已有待審 → 擋');
    ok(app.submit({ name: '新人甲' }).code === 'dup_pending', '1 ★同姓名＋同單位已有待審 → 擋');
    ok(app.submit({ name: '新 人甲' }).code === 'dup_pending', '1 姓名去空白後相同也算');
    ok(app.submit({ name: '新人甲', unit: 'mzt-js' }).ok, '1 同姓名但不同單位 → 收');
    const ro = app.submit({ name: '名冊新人', unit: 'mzt-js' });
    ok(ro.code === 'name_in_roster' && ro.error.indexOf('第一次使用') !== -1, '1 ★名冊有同名未認領 → 導回認領（不分單位）', ro);
    ok(app.submit({ name: '光復計時' }).code === 'duplicate_name', '1 ★同單位已有同名在職同仁 → 擋');
    ok(app.submit({ name: '光復計時', unit: 'mzt-js' }).ok, '1 別單位同名在職 → 收');
    ok(app.submit({ name: '停用同名', unit: 'mzt-lzl' }).ok, '1 同單位同名但已停用 → 收');
    ok(app.submit({ name: '總部新人', brand: 'dzy', unit: 'dzy-hq', dept: 'fin', title: 'hs' }).ok, '1 ★總部部門也開放（Q5 B）');
    ok(app.submit({ name: '辦公室新人', brand: 'mzt', unit: 'mzt-hq', title: 'ofs' }).ok, '1 ★品牌辦公室也開放（Q5 B）');
    // 全域限流
    cache.set('stf_g_apply_' + Math.floor(sb.stfNowSec_() / 600), { v: '600', exp: null });
    const fl = app.submit({ name: '洪水' });
    ok(fl.ok === false && fl.error === sb.STF_MSG.TOO_MANY, '1 ★全域桶 apply 滿 600 → 擋', fl);
    ok(!app.rows().some((x) => x[app.col('name')] === '洪水'), '1 被擋不寫');
    ok(cache.get('stf_g_lookup_' + Math.floor(sb.stfNowSec_() / 600)) === undefined && post(sb, 'claimLookup', { name: '名冊新人' }).ok, '1 申請的桶跟認領分開');
  }
  {
    const app = setup();
    const { sb } = app;
    ok(app.submit({ name: '先建表' }).ok, '1b 前置：建表');
    for (let i = 0; i < 299; i++) app.sheets.staff_apply._data.push(['APL2026110600000' + String(1000 + i).slice(-3) + '0000', 'pending', '', '灌水' + i, '0944' + String(100000 + i).slice(-6), '', '', 'mzt', 'mzt-gf', '', 'pt', 's', 'h', '', '', '', '', '']);
    const r = app.submit({ name: '第三百零一' });
    ok(r.code === 'too_many', '1b ★全部待審 ≥ 300 → 擋', r);
    app.sheets.staff_apply._data[1][1] = 'rejected';
    ok(app.submit({ name: '第三百零一' }).ok, '1b 有一筆處理掉就能再收');
    // 表頭不一致 → 停
    app.sheets.staff_apply._data[0][3] = 'xname';
    const bad = app.submit({ name: '表頭錯' });
    ok(bad.ok === false && bad.error.indexOf('表頭') !== -1, '1b ★表頭不一致 → 停止寫入', bad);
    ok(post(sb, 'applyStatus', { name: '先建表', phone: '0933000011' }).data.status === 'none', '1b 表頭不一致：讀取當空');
  }

  // ============================================================
  // 2. 審核者聯集（Q2 A＋Q5 B）與清單
  // ============================================================
  {
    const app = setup();
    const { sb } = app;
    ok(post(sb, 'permExSave', { emp_no: 'DZY301', perm: 'staff.add@mzt-gf', mode: 'add', until: '', note: '測試' }, app.adminTok).ok, '2 前置：DZY301 可新增同仁（光復）');
    ok(post(sb, 'permExSave', { emp_no: 'DZY306', perm: 'store.sm@mzt-lzl', mode: 'add', until: '', note: '測試' }, app.adminTok).ok, '2 前置：DZY306 兼任六張犁店長');
    app.tok.DZY301 = app.login('DZY301'); app.tok.DZY306 = app.login('DZY306');
    ok(app.submit({ name: '光復計時新人' }).ok && app.submit({ name: '光復店長新人', title: 'sm' }).ok &&
      app.submit({ name: '辦公室行政新人', unit: 'mzt-hq', title: 'ofs' }).ok &&
      app.submit({ name: '財務新人', brand: 'dzy', unit: 'dzy-hq', dept: 'fin', title: 'hs' }).ok &&
      app.submit({ name: '六張犁新人', unit: 'mzt-lzl' }).ok &&
      app.submit({ name: '管理部新人', brand: 'dzy', unit: 'dzy-hq', dept: 'mgmt', title: 'hs' }).ok, '2 前置：六筆申請');
    const names = (tok) => { const r = app.pending(tok); return r.ok ? (r.data.applies || []).map((x) => x.name).sort().join(',') : 'ERR:' + r.error; };
    ok(names(app.tok.DZY303) === ['光復店長新人', '光復計時新人'].sort().join(), '2 ★店長：本店、職稱不高於自己（含同級店長）', names(app.tok.DZY303));
    ok(names(app.tok.DZY301) === '光復計時新人', '2 ★可新增同仁的正職：本店、不高於自己（看不到店長）', names(app.tok.DZY301));
    const p301 = app.pending(app.tok.DZY301);
    ok(p301.ok && eq(p301.data.people, []), '2 可新增同仁的正職：認領待審照舊看不到（people 空）', p301);
    ok(names(app.tok.DZY306) === '六張犁新人', '2 ★兼任店長：兼任的店', names(app.tok.DZY306));
    ok(names(app.tok.DZY304) === '', '2 別店店長看不到', names(app.tok.DZY304));
    ok(names(app.tok.DZY310) === ['光復店長新人', '辦公室行政新人'].sort().join(), '2 ★品牌總監：辦公室同仁＋門市店長', names(app.tok.DZY310));
    ok(names(app.tok.DZY321) === '財務新人', '2 ★部門總監：同部門', names(app.tok.DZY321));
    ok(names(app.tok.HR).split(',').length === 6, '2 ★人資：全部', names(app.tok.HR));
    ok(names(app.adminTok).split(',').length === 6, '2 admin：全部');
    ok(app.pending(app.tok.DZY305).ok === false || names(app.tok.DZY305) === '', '2 ★無關的正職被拒', app.pending(app.tok.DZY305));
    ok(app.pending(app.tok.DZY302).ok === false, '2 ★計時被拒');
    const one = app.pending(app.tok.HR).data.applies[0];
    ok(eq(keysOf(one).sort(), ['apply_id', 'brand', 'created_at', 'dept', 'dept_name', 'name', 'phone', 'title', 'title_name', 'unit', 'unit_name'].sort()), '2 ★清單欄位不含生日／地址／salt／hash', keysOf(one));
    ok(one.unit_name && one.title_name, '2 清單帶中文名');
    // 既有認領清單照舊在 people
    const p303 = app.pending(app.tok.DZY303);
    ok(p303.ok && Array.isArray(p303.data.people), '2 店長的 unitPending 照舊回 people');
  }

  // ============================================================
  // 3. 核准：編號、三處寫入、改職稱、到職日、不高於自己、重複核准
  // ============================================================
  {
    const app = setup();
    const { sb, sheets } = app;
    ok(post(sb, 'permExSave', { emp_no: 'DZY301', perm: 'staff.add@mzt-gf', mode: 'add', until: '', note: '測試' }, app.adminTok).ok, '3 前置：DZY301 可新增同仁');
    app.tok.DZY301 = app.login('DZY301');
    ok(app.submit({ name: '核准甲', phone: '0955000001', birthday: '1999-09-09', address: '新竹市測試路二段2號' }).ok, '3 前置：申請');
    const id = app.idOf('核准甲');
    const saltBefore = app.rows()[0][app.col('salt')];
    const hashBefore = app.rows()[0][app.col('hash')];
    const ap = (tok, o) => post(sb, 'applyApprove', Object.assign({ apply_id: id, hire_date: app.today }, o || {}), tok);
    ok(ap(app.tok.DZY301, { title: 'sm' }).code === 'no_perm', '3 ★改成比自己高的職稱 → 擋');
    ok(ap(app.tok.DZY304).code === 'no_perm', '3 ★別店店長 → 擋');
    ok(ap(app.tok.DZY305).code === 'no_perm', '3 ★無關的人 → 擋');
    ok(ap(app.tok.DZY301, { hire_date: '' }).code === 'bad_input', '3 ★到職日必填');
    ok(ap(app.tok.DZY301, { hire_date: '1999-12-31' }).code === 'bad_input', '3 到職日太早');
    ok(ap(app.tok.DZY301, { hire_date: sb.clkAddDays_(app.today, 366) }).code === 'bad_input', '3 到職日超過一年後');
    ok(ap(app.tok.DZY301, { title: 'fm' }).code === 'bad_input', '3 改的職稱要合單位');
    ok(ap(app.tok.DZY301, { apply_id: 'APL1' }).code === 'not_found', '3 apply_id 格式錯');
    ok(post(sb, 'applyApprove', { apply_id: id, hire_date: app.today }, '').ok === false, '3 沒登入 → 擋');
    ok(app.rows()[0][app.col('status')] === 'pending' && !sheets.users._data.some((x) => x[1] === 'DZY331'), '3 前面被擋的都沒寫');
    const r = ap(app.tok.DZY301, { title: 'ft' });
    ok(r.ok && r.data.emp_no === 'DZY331' && r.data.name === '核准甲', '3 ★可新增同仁的正職核准（改成正職）→ DZY331（停用的 DZY330 不回收）', r);
    const u = sheets.users._data.find((x) => x[1] === 'DZY331');
    ok(u && u[3] === 'staff' && u[7] === 'TRUE' && u[5] === saltBefore && u[6] === hashBefore, '3 ★users 列：staff、active、帶申請的 salt／hash', u);
    const s = sheets.staff._data.find((x) => x[0] === 'DZY331');
    ok(s && s[1] === u[0] && s[2] === '核准甲' && s[3] === 'active' && s[4] === 'mzt' && s[5] === 'mzt-gf' && s[7] === 'ft', '3 ★staff 列：active、組織正式欄、職稱改後', s);
    ok(s && s[12] === '1999-09-09' && s[13] === '0955000001' && s[14] === '新竹市測試路二段2號' && s[24] === app.today && s[18] && s[19], '3 ★staff 列：個資、到職日、claimed_at／confirmed_at', s);
    ok(s && ['p_brand', 'p_unit', 'p_dept', 'p_title'].every((f) => s[sb.STF_COL[f]] === ''), '3 p_* 空白（不是待確認）');
    const job = sheets.clock_outbox._data.find((x) => x[2] === 'DZY331');
    ok(job && job[1] === 'add' && job[3] === 'mztgf' && job[5] === '核准甲', '3 ★打卡 add 單（光復）', job);
    const lg = sheets.staff_log._data.find((x) => x[1] === 'DZY331' && x[2] === 'apply_approve');
    ok(lg && JSON.stringify(lg).indexOf('0955000001') === -1 && JSON.stringify(lg).indexOf('1999-09-09') === -1 && JSON.stringify(lg).indexOf('測試路') === -1, '3 ★staff_log apply_approve、不寫個資', lg);
    const ar = app.rows()[0];
    ok(ar[app.col('status')] === 'approved' && ar[app.col('emp_no')] === 'DZY331' && ar[app.col('salt')] === '' && ar[app.col('hash')] === '' && ar[app.col('reviewed_by')] === 'u301' && ar[app.col('reviewed_at')] && ar[app.col('title')] === 'ft' && ar[app.col('hire_date')] === app.today, '3 ★申請列 approved、清 salt／hash', ar);
    const lt = post(sb, 'login', { username: 'DZY331', password: APW });
    ok(lt.ok && lt.data.token, '3 ★新人用新編號＋申請時的密碼登入', lt);
    const me = post(sb, 'myProfile', {}, lt.data && lt.data.token);
    ok(me.ok && me.data.emp_no === 'DZY331' && me.data.status === 'active' && me.data.title === 'ft', '3 新人的我的資料', me);
    ok(ap(app.tok.DZY301).code === 'not_pending', '3 ★重複核准 → 擋');
    ok(post(sb, 'applyReject', { apply_id: id, reason: '晚了' }, app.tok.HR).code === 'not_pending', '3 已核准不能再退回');
    const st = post(sb, 'applyStatus', { name: '核准甲', phone: '0955000001' });
    ok(st.ok && st.data.status === 'approved' && st.data.emp_no === 'DZY331', '3 ★查進度：approved＋編號（Q1 A）', st);
    ok(post(sb, 'applyStatus', { name: '核准甲', phone: '0955000009' }).data.status === 'none', '3 手機不對 → none');
    // 第二筆：店長核准 → DZY332；沒有打卡的單位（辦公室）不開單
    ok(app.submit({ name: '核准乙' }).ok && app.submit({ name: '辦公室乙', unit: 'mzt-hq', title: 'ofs' }).ok, '3 前置：再兩筆');
    const r2 = post(sb, 'applyApprove', { apply_id: app.idOf('核准乙'), hire_date: app.today }, app.tok.DZY303);
    ok(r2.ok && r2.data.emp_no === 'DZY332', '3 ★店長核准 → 下一號', r2);
    const r3 = post(sb, 'applyApprove', { apply_id: app.idOf('辦公室乙'), hire_date: app.today }, app.tok.DZY310);
    ok(r3.ok && r3.data.emp_no === 'DZY333', '3 ★品牌總監核准辦公室同仁', r3);
    ok(r3.ok && (r3.data.job_id === null || sheets.clock_outbox._data.some((x) => x[2] === 'DZY333')), '3 辦公室：單位有打卡店才開單', r3.data);
    // 核准當下姓名衝突再查
    ok(app.submit({ name: '後來撞名', unit: 'mzt-js' }).ok, '3 前置：金山申請');
    ok(post(sb, 'staffCreateByUnit', { name: '後來撞名', unit: 'mzt-js', title: 'pt', hire_date: app.today, phone: '0912000777' }, app.adminTok).ok, '3 前置：admin 先在金山新增同名');
    const dn = post(sb, 'applyApprove', { apply_id: app.idOf('後來撞名'), hire_date: app.today }, app.tok.DZY304);
    ok(dn.code === 'name_in_roster' && dn.error.indexOf('退回') !== -1, '3 ★核准時再查：名冊已有同名未認領 → 擋（請退回）', dn);
    app.sheets.staff._data.find((x) => x[2] === '後來撞名')[3] = 'active';
    const dn2 = post(sb, 'applyApprove', { apply_id: app.idOf('後來撞名'), hire_date: app.today }, app.tok.DZY304);
    ok(dn2.code === 'duplicate_name', '3 ★核准時再查：同單位同名在職 → 擋', dn2);
    // 編號用完
    ok(app.submit({ name: '滿號' }).ok, '3 前置：滿號申請');
    const full = sb.CAST_FULL_ROW = new Array(27).fill(''); full[0] = 'DZY999'; full[2] = '佔號'; full[3] = 'disabled'; full[5] = 'mzt-lzl';
    sheets.staff._data.push(full);
    ok(post(sb, 'applyApprove', { apply_id: app.idOf('滿號'), hire_date: app.today }, app.tok.DZY303).code === 'full', '3 ★編號用到 999 → full');
  }

  // ============================================================
  // 4. 退回、查進度、部門總監、鎖碼
  // ============================================================
  {
    const app = setup();
    const { sb, sheets } = app;
    ok(app.submit({ name: '退回甲', phone: '0966000001', unit: 'mzt-hq', title: 'ofs' }).ok, '4 前置：辦公室申請');
    const id = app.idOf('退回甲');
    const rj = (tok, reason) => post(sb, 'applyReject', { apply_id: id, reason }, tok);
    ok(rj(app.tok.DZY310, '').ok === false, '4 ★原因必填');
    ok(rj(app.tok.DZY310, '長'.repeat(101)).ok === false, '4 原因最多 100 字');
    ok(rj(app.tok.DZY303, '不是我的').code === 'no_perm', '4 ★不是這單位的審核者 → 擋');
    ok(post(sb, 'applyStatus', { name: '退回甲', phone: '0966000001' }).data.status === 'pending', '4 查進度：pending');
    const r = rj(app.tok.DZY310, '單位選錯了');
    ok(r.ok, '4 ★品牌總監退回', r);
    const row = app.rows()[0];
    ok(row[app.col('status')] === 'rejected' && row[app.col('reject_reason')] === '單位選錯了' && row[app.col('salt')] === '' && row[app.col('hash')] === '' && row[app.col('birthday')] === '' && row[app.col('address')] === '', '4 ★退回清密碼與生日地址', row);
    ok(row[app.col('name')] === '退回甲' && row[app.col('phone')] === '0966000001' && row[app.col('unit')] === 'mzt-hq' && row[app.col('emp_no')] === '', '4 保留姓名、手機、單位；不產生編號', row);
    const st = post(sb, 'applyStatus', { name: '退回甲', phone: '0966000001' });
    ok(st.ok && st.data.status === 'rejected' && st.data.reason === '單位選錯了', '4 ★查進度：rejected＋原因', st);
    ok(rj(app.tok.DZY310, '再退').code === 'not_pending', '4 重複退回 → 擋');
    ok(app.submit({ name: '退回甲', phone: '0966000001', unit: 'mzt-hq', title: 'ofs' }).ok, '4 ★退回後可以重新申請');
    ok(post(sb, 'applyStatus', { name: '退回甲', phone: '0966000001' }).data.status === 'pending', '4 查進度看最新一筆');
    ok(!sheets.staff._data.some((x) => x[2] === '退回甲'), '4 退回不寫 staff');
    // 查進度：同姓名查無 5 次鎖 10 分鐘
    for (let i = 0; i < 5; i++) post(sb, 'applyStatus', { name: '亂猜', phone: '09770000' + String(10 + i) });
    const lock = post(sb, 'applyStatus', { name: '亂猜', phone: '0977000099' });
    ok(lock.ok === false && lock.error === sb.STF_MSG.TOO_MANY, '4 ★查進度同姓名查無 5 次 → 擋', lock);
    ok(post(sb, 'applyStatus', { name: '亂猜', phone: '123' }).error.indexOf('手機') !== -1, '4 查進度格式錯');
    ok(post(sb, 'applyStatus', { name: '退回甲', phone: '0966000001' }).ok, '4 別的姓名不受影響');
    // 部門總監核准
    ok(app.submit({ name: '行銷乙', brand: 'dzy', unit: 'dzy-hq', dept: 'marketing', title: 'hs' }).ok, '4 前置：行銷部申請');
    ok(post(sb, 'applyApprove', { apply_id: app.idOf('行銷乙'), hire_date: app.today }, app.tok.DZY321).code === 'no_perm', '4 別部門總監 → 擋');
    const fr = post(sb, 'applyApprove', { apply_id: app.idOf('行銷乙'), hire_date: app.today }, app.tok.DZY323);
    ok(fr.ok && /^DZY\d{3}$/.test(fr.data.emp_no), '4 ★部門總監核准同部門', fr);
    ok(post(sb, 'applyApprove', { apply_id: app.idOf('行銷乙'), hire_date: app.today }, app.tok.DZY323).code === 'not_pending', '4 重複核准 → 擋');
    // 財務部同仁：財務部帶鎖碼權限（稽核填單）→ 財務總監（非 admin）核准被 perm_admin_only 擋、admin 可以（同新增同仁）
    ok(app.submit({ name: '財務乙', brand: 'dzy', unit: 'dzy-hq', dept: 'fin', title: 'hs' }).ok, '4 前置：財務申請');
    const fb = post(sb, 'applyApprove', { apply_id: app.idOf('財務乙'), hire_date: app.today }, app.tok.DZY321);
    ok(fb.code === 'perm_admin_only', '4 ★非 admin 造出含鎖碼身分 → perm_admin_only', fb);
    ok(app.rows().find((x) => x[app.col('name')] === '財務乙')[app.col('status')] === 'pending', '4 被鎖碼擋下：申請照舊 pending');
    ok(post(sb, 'applyApprove', { apply_id: app.idOf('財務乙'), hire_date: app.today }, app.adminTok).ok, '4 admin 可核准');
    // 人資部同仁：非 admin 造出含鎖碼身分 → perm_admin_only（admin 可以）
    ok(app.submit({ name: '人資乙', brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' }).ok, '4 前置：人資部申請');
    const hr = post(sb, 'applyApprove', { apply_id: app.idOf('人資乙'), hire_date: app.today }, app.tok.HR);
    const hrAdmin = hr.code === 'perm_admin_only' ? post(sb, 'applyApprove', { apply_id: app.idOf('人資乙'), hire_date: app.today }, app.adminTok) : hr;
    ok((hr.code === 'perm_admin_only' && hrAdmin.ok) || hr.ok, '4 鎖碼身分：非 admin 擋、admin 可（或該身分本來就不含鎖碼）', [hr, hrAdmin]);
  }

  // ============================================================
  // 5. 接線：Code.gs 分派、寫入鎖、dryrun 清單、認領查無 code
  // ============================================================
  {
    const app = setup();
    const { sb } = app;
    ['applySubmit', 'applyStatus', 'applyApprove', 'applyReject'].forEach((a) => ok(sb.CODE_ALLOWED_ACTIONS.indexOf(a) !== -1, '5 白名單有 ' + a));
    const code = fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8');
    const mut = /var MUTATING_ACTIONS = \{([\s\S]*?)\};/.exec(code)[1];
    ['applySubmit', 'applyApprove', 'applyReject'].forEach((a) => ok(new RegExp('\\b' + a + ': 1').test(mut), '5 ★' + a + ' 進 MUTATING_ACTIONS'));
    ok(!/\bapplyStatus: 1/.test(mut), '5 applyStatus 是讀取');
    app.lockState.held = true;
    ok(app.submit({ name: '鎖住' }).ok === false, '5 寫入鎖拿不到 → 不寫');
    app.lockState.held = false;
    const D = await import('../platform/dryrun.js');
    ok(D.READ_ACTIONS.platform.indexOf('applyStatus') !== -1, '5 ★dryrun：applyStatus 是讀取');
    ['applySubmit', 'applyApprove', 'applyReject'].forEach((a) => ok(D.READ_ACTIONS.platform.indexOf(a) === -1, '5 ★dryrun：' + a + ' 試跑會攔'));
    const lk = post(sb, 'claimLookup', { name: '沒有這個人' });
    ok(lk.ok === false && lk.code === 'not_in_roster' && lk.error === sb.STF_MSG.NOT_IN_ROSTER, '5 ★claimLookup 查無回 code not_in_roster', lk);
  }

  // ============================================================
  // 6. 前端（純字串／原始碼層；真瀏覽器另外點過）
  // ============================================================
  {
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const login = src('platform/views/login.js');
    ok(login.indexOf("'#/apply-status'") !== -1 && login.indexOf("'#/apply-status'") < login.indexOf("startsWith('#/apply')"), '6 login.js：先比 #/apply-status 再比 #/apply');
    ok(/renderApply\(card/.test(login) && /renderApplyStatus\(card/.test(login), '6 login.js 掛上兩個畫面');
    ok(/moduleId === 'apply' \|\| moduleId === 'apply-status'/.test(src('platform/shell.js')), '6 shell.js：登入後停在申請網址 → 首頁');
    const claim = src('platform/views/claim.js');
    ok(claim.indexOf("lk.code === 'not_in_roster'") !== -1 && claim.indexOf('#/apply') !== -1 && claim.indexOf('#/apply-status') !== -1, '6 ★claim.js：查無名字 → 申請帳號、查申請進度');
    const apply = src('platform/views/apply.js');
    ok(apply.indexOf("publicCall('applySubmit'") !== -1 && apply.indexOf("orgFieldsHtml('apply')") !== -1 && apply.indexOf('apply-pw2') !== -1, '6 apply.js：送 applySubmit、組織欄共用 org-fields、密碼兩次');
    ok(src('platform/views/apply-status.js').indexOf("publicCall('applyStatus'") !== -1, '6 apply-status.js：送 applyStatus');
    globalThis.document = globalThis.document || { createElement: () => ({}) };
    const { createApplies } = await import('../modules/me/views/applies.js');
    const { esc } = await import('../platform/fmt.js');
    const ap = createApplies({ fmt: { esc }, ui: {}, api: {} }, async () => {});
    ap.setOrg({ units: [{ code: 'mzt-gf', name: '新竹光復', parent: 'mzt', ladder: 'store' }],
      titles: [{ code: 'pt', name: '計時同仁', parent: 'store', rank: 1 }, { code: 'ft', name: '正職同仁', parent: 'store', rank: 2 }, { code: 'ofs', name: '行政同仁', parent: 'office', rank: 1 }], unit_titles: {}, title_units: {} });
    const h = ap.html([{ apply_id: 'APL202611060000001234', name: '<b>新人</b>', phone: '0933000001', unit: 'mzt-gf', unit_name: '新竹光復', dept: '', dept_name: '', title: 'pt', title_name: '計時同仁', created_at: '2026-11-06 10:00:00' }]);
    ok(h.indexOf('data-role="apply-row"') !== -1 && h.indexOf('data-act="apply-approve"') !== -1 && h.indexOf('data-act="apply-reject"') !== -1, '6 ★申請卡片：通過、退回');
    ok(h.indexOf('value="pt" selected') !== -1 && h.indexOf('value="ft"') !== -1 && h.indexOf('value="ofs"') === -1, '6 ★職稱下拉只列合單位的職稱、預選申請的職稱');
    ok(/data-role="apply-hire"[^>]*value="\d{4}-\d{2}-\d{2}"/.test(h), '6 到職日預設今天');
    ok(h.indexOf('<b>新人</b>') === -1 && h.indexOf('&lt;b&gt;') !== -1, '6 姓名有跳脫');
    ok(ap.html([]) === '', '6 沒有申請 → 不顯示');
    const meIndex = (await import('../modules/me/index.js')).default;
    const mk = (perms, applies) => ({ can: (p) => perms.indexOf(p) !== -1, api: { call: async (m, a) => (a === 'myProfile' ? { ok: true, data: { none: true } } : a === 'unitPending' ? { ok: true, data: { people: [], applies } } : { ok: false }) } });
    let al = await meIndex.alerts(mk(['platform.self', 'platform.unitstaff'], [{ apply_id: 'x' }, { apply_id: 'y' }]));
    ok(al.some((x) => x.text === '有 2 位新進同仁申請等你審核' && x.view === 'team'), '6 ★可新增同仁：首頁提醒 → 我的單位', al);
    al = await meIndex.alerts(mk(['platform.self', 'platform.review'], [{ apply_id: 'x' }]));
    ok(al.some((x) => x.text === '有 1 位新進同仁申請等你審核' && x.view === 'review'), '6 ★店長：首頁提醒 → 待審核', al);
    const team = src('modules/me/views/team.js');
    ok(team.indexOf('mountApplies') !== -1 && /platform\.unitstaff'\) && !ctx\.can\('platform\.review'\)/.test(team), '6 team.js：只有 unitstaff 的人在我的單位上方看申請');
    ok(src('modules/me/views/review.js').indexOf('ap.html(applies)') !== -1, '6 review.js：待審核多一區新進同仁申請');
  }

  console.log('\n' + (failed ? '失敗' : '通過') + ' ' + passed + '／' + (passed + failed));
  if (failed) process.exit(1);
})();
