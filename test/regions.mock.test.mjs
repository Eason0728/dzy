// node test/regions.mock.test.mjs —— 區域（督導負責區，Regions.gs）驗收
// 規格：docs/regions/spec.md v1.0（第 3、4、5、6、7、9 節）。
// 做法同 storeops.mock.test.mjs：把後端 .gs 讀進同一個 vm sandbox，action 走 doPost；純函式直接呼叫。
// ⚠ 所有姓名、編號、金鑰都是假資料（dzy 是 public repo）。

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
const has = (arr, x) => arr.indexOf(x) !== -1;

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
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
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
const PW = 'fake-regions-pw-01';
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
const SALT = 'salt-regions';
const SVC = 'fake-regions-svc-key-01';
const USERS_HEAD = ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at', 'token_after'];
const CLK = { 'mzt-gf': 'mztgf', 'mzt-js': 'mztjs', 'mzt-lzl': 'mztlzl', 'mzt-hq': 'hq', 'mala-hq': 'hq', 'mala-gf': 'gf' };

// 「兩區兩督導」：A 區＝新竹光復 mzt-gf（督導 DZY101）、B 區＝新竹金山 mzt-js（督導 DZY102）、六張犁 mzt-lzl 沒劃區
// [emp, 姓名, unit, title, status]
const CAST = [
  ['DZY101', '測試甲', 'mzt-hq', 'osv', 'active'],
  ['DZY102', '測試乙', 'mzt-hq', 'osv', 'active'],
  ['DZY103', '測試丙', 'mzt-hq', 'odir', 'active'],
  ['DZY104', '測試丁', 'mzt-hq', 'osv', 'disabled'],   // 離職的督導
  ['DZY105', '測試戊', 'mzt-hq', 'ofs', 'active'],     // 行政，不是 osv
  ['DZY111', '測試店長甲', 'mzt-gf', 'sm', 'active'],
  ['DZY112', '測試店長乙', 'mzt-js', 'sm', 'active'],
  ['DZY113', '測試店長丙', 'mzt-lzl', 'sm', 'active'],
  ['DZY114', '測試區經理甲', 'mzt-gf', 'am', 'active'],
  ['DZY115', '測試計時甲', 'mzt-gf', 'pt', 'active'],
  ['DZY131', '測試己', 'mala-hq', 'osv', 'active']     // 別品牌辦公室的督導
];
// 認領待審的店長（status pending、p_* 有值、沒有登入帳號）
const PENDING = [['DZY121', '測試待審甲', 'mzt-gf'], ['DZY122', '測試待審乙', 'mzt-js'], ['DZY123', '測試待審丙', 'mzt-lzl']];
const ALL_NAMES = CAST.map((p) => p[1]).concat(PENDING.map((p) => p[1]));

function world() {
  const users = [USERS_HEAD, ['a001', 'BOSS', '系統管理者', 'admin', '', SALT, HASHER.hashPassword_(PW, SALT), 'TRUE', '', '', '']]
    .concat(CAST.map((p) => ['u' + p[0].slice(3), p[0], p[1], 'staff', '', SALT, HASHER.hashPassword_(PW, SALT), p[4] === 'active' ? 'TRUE' : 'FALSE', '', '', '']));
  users.push(['u900', 'HRUSER', '人資帳號', 'hr', '', SALT, HASHER.hashPassword_(PW, SALT), 'TRUE', '', '', '']);
  const app = load({
    users,
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['staff', '員工', ''], ['hr', '人資', 'platform.staff,platform.self']],
    module_secrets: [['backend_id', 'level', 'secret']],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  });
  const { sb } = app;
  sb.setupStaff();
  const C = sb.STF_COL;
  const brandOf = (u) => u.split('-')[0];
  CAST.forEach((p, i) => {
    const r = new Array(27).fill('');
    r[C.emp_no] = p[0]; r[C.user_id] = 'u' + p[0].slice(3); r[C.name] = p[1]; r[C.status] = p[4];
    r[C.brand] = brandOf(p[2]); r[C.unit] = p[2]; r[C.title] = p[3];
    r[C.phone] = '09000001' + String(i).padStart(2, '0'); r[C.birthday] = '1990-01-01'; r[C.address] = '測試地址' + i;
    r[C.confirmed_at] = '2026-02-01 10:00:00'; r[24] = '2026-01-05';
    app.sheets.staff._data.push(r);
    app.sheets.staff_clock._data.push([p[0], CLK[p[2]], CLK[p[2]].toUpperCase() + p[0].slice(3), 'staff', 'confirmed', 'created', 'TRUE', '', 'tester', '', '']);
  });
  PENDING.forEach((p) => {
    const r = new Array(27).fill('');
    r[C.emp_no] = p[0]; r[C.name] = p[1]; r[C.status] = 'pending';
    r[C.p_brand] = 'mzt'; r[C.p_unit] = p[2]; r[C.p_title] = 'sm'; r[C.claimed_at] = '2026-10-20 10:00:00';
    app.sheets.staff._data.push(r);
  });
  app.props.STORE_SVC_KEY = SVC;
  app.props.STORE_SSO_UNITS = 'mzt-gf,mzt-hq,mzt-js,mzt-lzl';
  app.login = (u) => { const r = post(sb, 'login', { username: u, password: PW }); return r.ok ? r.data.token : ''; };
  app.adminTok = app.login('BOSS');
  post(sb, 'permInit', {}, app.adminTok);
  app.hrTok = app.login('HRUSER');
  app.ident = (sub) => { const r = post(sb, 'svcStoreWho', { svc_key: SVC, sub }); return r.ok ? r.data : r; };
  app.req = (sub) => app.ident(sub).att.req_people.map((x) => x.sub).sort();
  app.hours = (sub) => app.ident(sub).att.people.map((x) => x.sub).sort();
  app.pending = (emp) => { const r = post(sb, 'unitPending', {}, app.login(emp)); return r.ok ? r.data.people.map((x) => x.emp_no).sort() : r; };
  app.list = () => post(sb, 'regionList', {}, app.hrTok).data;
  app.save = (region, extra) => post(sb, 'regionSave', Object.assign({ region, expected_ver: app.list().ver }, extra || {}), app.hrTok);
  app.setOn = (on) => { if (on) app.props.REGIONS_ON = '1'; else delete app.props.REGIONS_ON; };
  return app;
}

// ============================================================
// 1. 設定 action：regionSave 驗證、expected_ver、preview、staff_log、regionSwitch
// ============================================================
const app = world();
const { sb } = app;
(() => {
  ok(app.sheets.regions && eq(app.sheets.regions._rows()[0], sb.REG_HEADERS), '1 setupStaff 建 regions 分頁、表頭八欄');
  sb.setupStaff();
  ok(app.sheets.regions._rows().length === 1, '1 setupStaff 重跑只補不覆蓋');
  const l0 = app.list();
  ok(l0 && eq(l0.regions, []) && typeof l0.ver === 'string' && l0.on === false, '1 regionList：空、有 ver、開關關', l0);
  ok(eq(l0.candidates.map((c) => c.emp_no).sort(), ['DZY101', 'DZY102', 'DZY131']) && l0.candidates.every((c) => eq(Object.keys(c), ['emp_no', 'name', 'unit', 'unit_name', 'brand'])), '1 regionList 督導候選人＝在職 osv（不含離職、行政）、只給五欄', l0.candidates);
  ok(post(sb, 'regionList', {}, app.login('DZY101')).ok === false, '1 regionList 沒有 platform.staff → 拒絕');

  const a = app.save({ name: '北區', brand: 'mzt', stores: ['mzt-gf'], supervisor: 'dzy101', active: true });
  ok(a.ok && a.data.region.code === 'r-mzt-1' && a.data.region.supervisor === 'DZY101', '1 新增 A 區：代碼 r-mzt-1、督導編號轉大寫', a);
  ok(post(sb, 'regionSave', { region: { name: '南區', brand: 'mzt', stores: ['mzt-js'], supervisor: 'DZY102' }, expected_ver: l0.ver }, app.hrTok).code === 'conflict', '1 ★expected_ver 過期 → conflict（不寫）');
  ok(app.list().regions.length === 1, '1 conflict 沒有寫入');
  const pv = app.save({ name: '南區', brand: 'mzt', stores: ['mzt-js'], supervisor: 'DZY102' }, { preview: true });
  ok(pv.ok && pv.data.preview === true && eq(pv.data.diff, [{ emp_no: 'DZY102', name: '測試乙', gained: [{ unit: 'mzt-js', unit_name: '新竹金山' }], lost: [] }]), '1 preview：列出督導乙多看到金山', pv);
  ok(app.list().regions.length === 1, '1 preview 不寫');
  const b = app.save({ name: '南區', brand: 'mzt', stores: ['mzt-js'], supervisor: 'DZY102' });
  ok(b.ok && b.data.region.code === 'r-mzt-2', '1 新增 B 區 r-mzt-2', b);

  const bad = (region, code, label) => { const r = app.save(region); ok(r.ok === false && r.code === code, label, r); };
  bad({ name: '東區', brand: 'mzt', stores: ['mzt-gf'], supervisor: '' }, 'store_taken', '1 ★一店一區：光復已在北區 → store_taken');
  bad({ name: '北區', brand: 'mzt', stores: ['mzt-lzl'] }, 'name_dup', '1 ★同品牌重名 → name_dup');
  bad({ name: '一二三四五六七八九十一二三', brand: 'mzt', stores: [] }, 'bad_input', '1 名稱 13 字 → 拒絕');
  bad({ name: '', brand: 'mzt', stores: [] }, 'bad_input', '1 名稱空白 → 拒絕');
  bad({ name: '東區', brand: 'nope', stores: [] }, 'bad_input', '1 品牌不存在 → 拒絕');
  bad({ name: '東區', brand: 'mzt', stores: ['ck'] }, 'bad_store', '1 ★中央工廠不能劃區');
  bad({ name: '東區', brand: 'mzt', stores: ['mala-gf'] }, 'bad_store', '1 ★別品牌門市不能劃區');
  bad({ name: '東區', brand: 'mzt', stores: ['mzt-wx'] }, 'bad_store', '1 ★停用門市不能劃進 active 區');
  bad({ name: '東區', brand: 'mzt', stores: ['mzt-hq'] }, 'bad_store', '1 品牌辦公室本身不能劃區');
  bad({ name: '東區', brand: 'mzt', stores: [], supervisor: 'DZY105' }, 'bad_supervisor', '1 ★督導職稱不是 osv → 拒絕');
  bad({ name: '東區', brand: 'mzt', stores: [], supervisor: 'DZY104' }, 'bad_supervisor', '1 ★離職督導 → 拒絕');
  bad({ name: '東區', brand: 'mzt', stores: [], supervisor: 'DZY131' }, 'bad_supervisor', '1 ★別品牌辦公室的督導 → 拒絕');
  bad({ code: 'r-mzt-9', name: '東區', brand: 'mzt', stores: [] }, 'not_found', '1 改不存在的代碼 → not_found');
  bad({ code: 'r-mzt-1', name: '北區', brand: 'mala', stores: [] }, 'bad_input', '1 建立後不能改品牌');
  ok(post(sb, 'regionSave', { region: { name: '東區', brand: 'mzt', stores: [] } }, app.hrTok).code === 'bad_input', '1 沒帶 expected_ver → bad_input');
  ok(post(sb, 'regionSave', { region: { name: '東區', brand: 'mzt', stores: [] }, expected_ver: app.list().ver }, app.login('DZY103')).ok === false, '1 regionSave 沒有 platform.staff（總監）→ 拒絕');
  // 一位督導多區（Q3）：先建再停用，停用的區不擋一店一區
  const c = app.save({ name: '試驗區', brand: 'mzt', stores: [], supervisor: 'DZY101' });
  ok(c.ok && c.data.region.code === 'r-mzt-3', '1 一位督導可以負責多區（Q3）', c);
  const c2 = app.save({ code: 'r-mzt-3', name: '試驗區', brand: 'mzt', stores: [], supervisor: 'DZY101', active: false });
  ok(c2.ok && c2.data.region.active === false, '1 停用一區（不刪）', c2);

  const logs = app.sheets.staff_log._rows().slice(1);
  const rs = logs.filter((r) => r[2] === 'region_save');
  ok(rs.length === 4, '1 每次存檔寫 staff_log region_save（預覽與失敗不寫）', rs);
  ok(/^r-mzt-1 new brand:mzt name stores:\+mzt-gf supervisor:->DZY101 active:TRUE$/.test(rs[0][4]), '1 log detail 只寫代碼與欄位差異', rs[0][4]);
  ok(rs[3][4] === 'r-mzt-3 active:TRUE>FALSE', '1 停用 log 只寫 active 差異', rs[3][4]);
  const logText = J(app.sheets.staff_log._rows());
  ok(ALL_NAMES.every((n) => logText.indexOf(n) === -1) && logText.indexOf('北區') === -1, '1 ★staff_log 不含任何姓名（也不含區名）');

  // regionSwitch：只有 role admin
  ok(post(sb, 'regionSwitch', { on: true }, app.hrTok).code === 'forbidden', '1 ★regionSwitch：人資 → forbidden');
  ok(post(sb, 'regionSwitch', { on: true }, app.login('DZY103')).code === 'forbidden', '1 ★regionSwitch：總監 → forbidden');
  ok(!('REGIONS_ON' in app.props), '1 被拒時沒有設屬性');
  ok(post(sb, 'regionSwitch', { on: 'yes' }, app.adminTok).code === 'bad_input', '1 regionSwitch on 不是布林 → bad_input');
  const on = post(sb, 'regionSwitch', { on: true }, app.adminTok);
  ok(on.ok && on.data.on === true && app.props.REGIONS_ON === '1', '1 admin 打開 → REGIONS_ON=1', on);
  const off = post(sb, 'regionSwitch', { on: false }, app.adminTok);
  ok(off.ok && off.data.on === false && !('REGIONS_ON' in app.props), '1 admin 關閉 → 刪掉屬性', off);
  const sw = app.sheets.staff_log._rows().slice(1).filter((r) => r[2] === 'regions_on' || r[2] === 'regions_off').map((r) => r[2]);
  ok(eq(sw, ['regions_on', 'regions_off']), '1 開／關都寫 staff_log', sw);
  app.props.REGIONS_ON = 'true';
  ok(app.list().on === false, '1 REGIONS_ON 不是恰好 1 → 視為關');
  delete app.props.REGIONS_ON;

  // 分派與 dryrun 清單
  ok(['regionList', 'regionSave', 'regionCheck', 'regionSwitch'].every((x) => has(sb.CODE_ALLOWED_ACTIONS, x)), '1 四個 action 都在 CODE_ALLOWED_ACTIONS');
  const mut = /MUTATING_ACTIONS = \{([\s\S]*?)\};/.exec(SRC.find(([f]) => f === 'Code.gs')[1])[1];
  ok(/regionSave: 1/.test(mut) && /regionSwitch: 1/.test(mut) && !/regionList/.test(mut) && !/regionCheck/.test(mut), '1 寫入 action 上全域鎖、讀取不上鎖');
})();

// ============================================================
// 2. regionIndex_ 各種失效情況（純函式）
// ============================================================
(() => {
  const org = sb.stfReadOrg_();
  const staff = sb.stfAllRows_();
  const R = (code, name, stores, sup, active) => [code, name, 'mzt', stores, sup, active === false ? 'FALSE' : 'TRUE', '', ''];
  const idx = sb.regionIndex_([
    R('r-mzt-1', '甲', 'mzt-gf,mzt-wx,ck,mala-gf', 'DZY101'),   // 停用門市、ck、別品牌被濾掉
    R('r-mzt-2', '乙', 'mzt-js,mzt-lzl', 'DZY104'),             // 督導離職 → ''
    R('r-mzt-3', '丙', 'mzt-lzl', 'DZY105'),                     // 督導是行政；六張犁同店兩區 → 兩邊都不算
    R('r-mzt-4', '丁', '', 'DZY131'),                            // 別品牌辦公室 → ''
    R('r-mzt-5', '戊', 'mzt-rg', 'DZY101', false),               // 停用的區不收
    R('r-mzt-6', '己', '', 'DZY101')                             // 一督導多區
  ], org, staff);
  ok(eq(Object.keys(idx), ['byStore', 'byRegion', 'bySupervisor']), '2 回傳形狀：byStore／byRegion／bySupervisor（契約）');
  ok(eq(idx.byRegion['r-mzt-1'], { code: 'r-mzt-1', name: '甲', brand: 'mzt', stores: ['mzt-gf'], supervisorEmp: 'DZY101' }), '2 ★停用門市、ck、別品牌門市被濾掉', idx.byRegion['r-mzt-1']);
  ok(idx.byRegion['r-mzt-2'].supervisorEmp === '', '2 ★督導離職 → 清成空');
  ok(idx.byRegion['r-mzt-3'].supervisorEmp === '', '2 ★督導職稱不是 osv → 清成空');
  ok(idx.byRegion['r-mzt-4'].supervisorEmp === '', '2 ★督導在別品牌辦公室 → 清成空');
  ok(eq(idx.byRegion['r-mzt-2'].stores, ['mzt-js']) && eq(idx.byRegion['r-mzt-3'].stores, []) && !('mzt-lzl' in idx.byStore), '2 ★同店兩區（手改試算表）→ 兩邊都不算、視同沒劃區');
  ok(!('r-mzt-5' in idx.byRegion) && !('mzt-rg' in idx.byStore), '2 停用的區不收');
  ok(eq(idx.bySupervisor, { DZY101: ['r-mzt-1', 'r-mzt-6'] }), '2 bySupervisor：只有合格督導、一人多區', idx.bySupervisor);
  ok(eq(idx.byStore, { 'mzt-gf': 'r-mzt-1', 'mzt-js': 'r-mzt-2' }), '2 byStore', idx.byStore);
  const fl = sb.regionFlags_([R('r-mzt-1', '甲', 'mzt-gf,mzt-wx', ''), R('r-mzt-2', '乙', 'mzt-js', 'DZY104')], org, sb.regionIndex_([R('r-mzt-1', '甲', 'mzt-gf,mzt-wx', ''), R('r-mzt-2', '乙', 'mzt-js', 'DZY104')], org, staff));
  ok(eq(fl.region_no_supervisor.map((x) => x.code + ':' + x.reason), ['r-mzt-1:empty', 'r-mzt-2:invalid']), '2 旗標 region_no_supervisor（空／失效）', fl);
  ok(eq(fl.region_store_inactive, [{ code: 'r-mzt-1', name: '甲', brand: 'mzt', stores: ['mzt-wx'] }]), '2 旗標 region_store_inactive', fl);
  ok(has(fl.store_no_region.map((x) => x.unit), 'mzt-lzl') && !has(fl.store_no_region.map((x) => x.unit), 'ck') && !has(fl.store_no_region.map((x) => x.unit), 'mzt-gf'), '2 旗標 store_no_region（不含 ck、不含已劃區）');

  // regionOfficeCovers_
  const cv = sb.regionOfficeCovers_;
  const onC = { on: true, idx }, offC = { on: false, idx };
  ok(cv({ emp: 'DZY102', title: 'osv' }, 'mzt-gf', offC) === true && cv({ emp: 'DZY102', title: 'osv' }, 'mzt-gf') === true, '2 開關關（或沒給 rctx）→ 一律 true');
  ok(cv({ emp: 'dzy101', title: 'osv' }, 'mzt-gf', onC) === true, '2 開：本區督導 → true（編號大小寫不拘）');
  ok(cv({ emp: 'DZY102', title: 'osv' }, 'mzt-gf', onC) === false, '2 ★開：別區督導 → false');
  ok(cv({ emp: 'DZY101', title: 'osv' }, 'mzt-lzl', onC) === false, '2 ★開：沒劃區的店 → false');
  ok(cv({ emp: 'DZY104', title: 'osv' }, 'mzt-js', onC) === false, '2 ★開：區沒督導 → false');
  ok(cv({ emp: 'DZY101', title: 'oam' }, 'mzt-gf', onC) === true && cv({ emp: 'DZY109', title: 'oam' }, 'mzt-gf', onC) === false, '2 開：oam 同 osv 處理');
  ok(cv({ emp: 'DZY103', title: 'odir' }, 'mzt-lzl', onC) === true, '2 開：總監 → true');
})();

// ============================================================
// 3. 兩區兩督導：認領審核、人事異動直屬主管、考勤 req／hours、稽核範圍
// ============================================================
(() => {
  const ALLP = ['DZY121', 'DZY122', 'DZY123'];
  // 開關關：全部照舊
  ok(eq(app.pending('DZY101'), ALLP) && eq(app.pending('DZY102'), ALLP), '3 關：兩位督導都看得到全品牌店長認領');
  const reqOffA = app.req('DZY101'), hoursOffA = app.hours('DZY101');
  ok(eq(reqOffA, ['DZY111', 'DZY112', 'DZY113', 'DZY114']), '3 關：督導甲 req＝全品牌店長＋區經理', reqOffA);

  app.setOn(true);
  ok(eq(app.pending('DZY101'), ['DZY121']), '3 ★開：督導甲只審得到 A 區（光復）店長認領');
  ok(eq(app.pending('DZY102'), ['DZY122']), '3 ★開：督導乙只審得到 B 區（金山）、審不到沒劃區的六張犁');
  ok(eq(app.pending('DZY103'), ALLP), '3 開：總監兩區＋沒劃區都審得到');
  ok(eq(app.pending('DZY114'), ['DZY121']), '3 開：同店區經理照舊審得到本店店長');
  const hr = post(sb, 'unitPending', {}, app.hrTok);
  ok(hr.ok && hr.data.people.length === 3, '3 開：人資照舊全部', hr);

  // 考勤 req
  ok(eq(app.req('DZY101'), ['DZY111', 'DZY114']), '3 ★開：督導甲 req＝A 區店長＋A 區區經理', app.req('DZY101'));
  ok(eq(app.req('DZY102'), ['DZY112']), '3 ★開：督導乙 req＝B 區店長（光復區經理、六張犁店長都不在）', app.req('DZY102'));
  ok(has(app.req('DZY114'), 'DZY111'), '3 開：A 區店長請假，同店區經理照舊能核');
  ok(has(app.req('DZY103'), 'DZY114') && !has(app.req('DZY103'), 'DZY111'), '3 開：區經理申請＝總監能核（總監照舊不核店長）');
  ok(eq(app.hours('DZY101'), hoursOffA), '3 開：核定工時（hours）不受影響');
  ok(has(app.hours('DZY111'), 'DZY115') && has(app.hours('DZY111'), 'DZY111'), '3 開：店長核定工時照舊');

  // 人事異動單直屬主管（apvDirectMembers_）
  const org = sb.stfReadOrg_();
  const people = sb.stfAllRows_().map((r) => sb.apvPerson_(r.values, org, [], true));
  const byEmp = {}; people.forEach((p) => { byEmp[p.emp] = p; });
  const direct = (emp, rctx) => sb.apvDirectMembers_(byEmp[emp], { org, people, byEmp, exclude: [], regionCtx: rctx }).map((p) => p.emp).sort();
  sb.regionCtxReset_();
  const rc = sb.regionCtx_();
  ok(rc.on === true && rc.idx.byStore['mzt-gf'] === 'r-mzt-1', '3 regionCtx_ 讀到開關與索引');
  ok(eq(direct('DZY111', rc), ['DZY101', 'DZY103', 'DZY114']), '3 ★開：A 區店長直屬主管＝督導甲、總監、同店區經理', direct('DZY111', rc));
  ok(eq(direct('DZY113', rc), ['DZY103']), '3 ★開：沒劃區店長直屬主管只剩總監', direct('DZY113', rc));
  ok(eq(direct('DZY111', { on: false, idx: rc.idx }), ['DZY101', 'DZY102', 'DZY103', 'DZY114']), '3 關：直屬主管照舊（全品牌督導）');
  ok(eq(sb.apvDirectMembers_(byEmp.DZY111, { org, people, byEmp, exclude: [] }).map((p) => p.emp).sort(), ['DZY101', 'DZY103', 'DZY114']), '3 ctx 沒帶 regionCtx → 自己讀 regionCtx_()');

  // 稽核範圍 auditScope
  const ctx = sb.permLoadCtx_(true);
  const storeMap = ctx.storeMap;
  const vals = (emp) => sb.stfFindByEmp_(emp).values;
  const mztAll = Object.keys(storeMap).filter((u) => org.unit[u] && org.unit[u].parent === 'mzt' && org.unit[u].active).map((u) => storeMap[u]).filter(Boolean).sort();
  ok(ctx.regionCtx && ctx.regionCtx.on === true, '3 permLoadCtx_ 帶 regionCtx');
  ok(storeMap['mzt-gf'] && eq(sb.permComputeRow_(ctx, vals('DZY101'), []).auditScope, [storeMap['mzt-gf']]), '3 ★開：督導甲 auditScope＝A 區門市', sb.permComputeRow_(ctx, vals('DZY101'), []).auditScope);
  ok(eq(sb.permComputeRow_(ctx, vals('DZY103'), []).auditScope, mztAll), '3 開：總監 auditScope＝全品牌', { got: sb.permComputeRow_(ctx, vals('DZY103'), []).auditScope, mztAll });
  ok(eq(sb.permComputeRow_(ctx, vals('DZY131'), []).auditScope, []), '3 開：沒有區域的督導 → []');
  const offCtx = Object.assign({}, ctx, { regionCtx: { on: false, idx: ctx.regionCtx.idx } });
  ok(eq(sb.permComputeRow_(offCtx, vals('DZY101'), []).auditScope, mztAll), '3 關：督導甲 auditScope＝全品牌');
  ok(eq(sb.permComputeRow_(Object.assign({}, ctx, { regionCtx: null }), vals('DZY101'), []).auditScope, mztAll), '3 沒有 regionCtx（純函式舊呼叫）→ 全品牌');
  ok(sb.PERM_NAMES['audit.read.brand'] === '稽核：自己品牌的店（區督導只看自己區）', '3 權限說明文字已更新');

  app.setOn(false);
  ok(eq(app.req('DZY101'), reqOffA) && eq(app.pending('DZY102'), ALLP), '3 再關：全部回到全品牌');
})();

// ============================================================
// 4. 通訊錄「我的區域」（handleMyUnit_，不受開關影響）
// ============================================================
(() => {
  const mu = (emp) => post(sb, 'myUnit', {}, app.login(emp));
  const a = mu('DZY101');
  ok(a.ok && a.data.people.length > 0 && a.data.private === false, '4 督導原本的辦公室同事那段不變', a);
  ok(eq(a.data.regions.map((r) => r.code), ['r-mzt-1']) && eq(a.data.regions[0].stores.map((s) => s.unit), ['mzt-gf']), '4 ★開關關時督導甲也拿到自己的區（停用的區不算）', a.data.regions);
  const ppl = a.data.regions[0].stores[0].people;
  ok(eq(ppl.map((p) => p.emp_no).sort(), ['DZY111', 'DZY114', 'DZY115']), '4 區內門市只列 active 同仁', ppl);
  ok(ppl.every((p) => eq(Object.keys(p), ['emp_no', 'name', 'title', 'title_name', 'phone'])), '4 ★people 只有姓名、職稱、手機（沒有 birthday／address）', ppl);
  const d = mu('DZY103');
  ok(d.ok && eq(d.data.regions.map((r) => r.code + ':' + r.name), ['r-mzt-1:北區', 'r-mzt-2:南區', ':未劃區']), '4 總監：全品牌依區分組＋未劃區', d.data.regions);
  ok(eq(d.data.regions[2].stores.map((s) => s.unit), ['mzt-lzl']), '4 總監「未劃區」＝六張犁（不含 ck、停用門市）', d.data.regions[2]);
  ok(J(d.data.regions).indexOf('birthday') === -1 && J(d.data.regions).indexOf('address') === -1, '4 總監的區域也不含生日地址');
  app.setOn(true);
  ok(eq(mu('DZY101').data.regions, a.data.regions), '4 開關開關結果一樣');
  app.setOn(false);
  const s = mu('DZY111');
  ok(s.ok && eq(s.data.regions, []) && s.data.private === true && s.data.people[0].birthday !== undefined, '4 店長：regions 空、原本的生日地址邏輯不動', s.data);
})();

// ============================================================
// 5. regionCheck 切換檢查四項
// ============================================================
(() => {
  ok(post(sb, 'regionCheck', {}, app.login('DZY101')).ok === false, '5 regionCheck 沒有 platform.staff → 拒絕');
  const c = post(sb, 'regionCheck', {}, app.hrTok);
  ok(c.ok, '5 regionCheck ok', c);
  const d = c.data;
  const mzt = d.stores_no_region.find((g) => g.brand === 'mzt');
  ok(mzt && eq(mzt.stores.map((s) => s.unit), ['mzt-lzl']), '5 第 1 項：墨竹亭沒劃區＝六張犁（按品牌列）', d.stores_no_region);
  ok(eq(d.regions_no_supervisor, []), '5 第 2 項：目前沒有失效督導');
  ok(!d.no_director.some((g) => g.brand === 'mzt') && d.no_director.some((g) => g.brand === 'mala'), '5 第 3 項：墨竹亭有總監不列；小辛辣沒總監、店沒劃區 → 列', d.no_director);
  ok(eq(d.pending_moves, [
    { unit: 'mzt-gf', unit_name: '新竹光復', count: 1, supervisors: ['DZY102'] },
    { unit: 'mzt-js', unit_name: '新竹金山', count: 1, supervisors: ['DZY101'] },
    { unit: 'mzt-lzl', unit_name: '台北六張犁', count: 1, supervisors: ['DZY101', 'DZY102'] }
  ]), '5 第 4 項：打開後會從哪些督導清單移走（只列人數與店名）', d.pending_moves);
  ok(J(d.pending_moves).indexOf('測試') === -1, '5 第 4 項不含被審者姓名');
  ok(d.warn === true && d.on === false, '5 有沒劃區的店 → warn（不擋）');
  // 督導離職後：區還在、旗標亮
  const row = app.sheets.staff._data.find((r) => r[0] === 'DZY102');
  row[sb.STF_COL.status] = 'disabled';
  const c2 = post(sb, 'regionCheck', {}, app.hrTok).data;
  ok(eq(c2.regions_no_supervisor.map((x) => x.code + ':' + x.reason), ['r-mzt-2:invalid']), '5 督導離職 → 第 2 項列出 B 區', c2.regions_no_supervisor);
  ok(eq(app.list().flags.region_no_supervisor.map((x) => x.code), ['r-mzt-2']), '5 regionList 旗標同步');
  row[sb.STF_COL.status] = 'active';
})();

// ============================================================
// 6. dryrun 清單（platform/dryrun.js）
// ============================================================
(async () => {
  const dr = await import('../platform/dryrun.js');
  ok(has(dr.READ_ACTIONS.platform, 'regionList') && has(dr.READ_ACTIONS.platform, 'regionCheck'), '6 regionList／regionCheck 在 dryrun READ_ACTIONS');
  ok(!dr.isReadAction('platform', 'regionSave', { preview: false }) && !dr.isReadAction('platform', 'regionSwitch', { on: true }), '6 regionSave／regionSwitch 試跑時被攔');
  ok(dr.isReadAction('platform', 'regionSave', { preview: true }), '6 regionSave preview:true 視為讀取');
  const rg = SRC.find(([f]) => f === 'Regions.gs')[1];
  ok(!/https?:\/\/|[A-Za-z0-9_-]{30,}/.test(rg.replace(/\/\*[\s\S]*?\*\//g, '')), '6 Regions.gs 沒有網址或疑似金鑰字串');

  console.log('\n' + (failed ? '失敗' : '通過') + ' ' + passed + '／' + (passed + failed));
  if (failed) process.exit(1);
})();
