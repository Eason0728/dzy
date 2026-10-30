// node test/dd/mgmt_random.mjs —— 資料帶入測試・管理部門（資料層／授權層的隨機釘子測試）
//
// 每次全部重抽（店代碼、使用者、角色權限組合、節點、動作、組織／規則／區域），印出種子；E2E_SEED=<種子> 重現。
// 預期值全部由本檔照規格自己算（docs/spec.md §4.2／§4.3、platform/api.js 檔頭的裁切白名單、
// ~/dzy-minikit PROXY.md 第 2 節的代轉授權、docs/regions/spec.md 第 6 節的督導範圍），不呼叫系統函式來算預期。
// 受測物：platform/api.js __filterAuditData（前端裁切）、apps-script/platform/Auth.gs proxyAuthorize_（代轉授權）、
//        apps-script/platform/Perms.gs permCompute_（role staff 的稽核範圍：REGIONS 開／關）。
// ⚠ 帳密、通行碼全是假資料（FAKE- 開頭）。不打任何網路。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { __filterAuditData } from '../../platform/api.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GS_DIR = path.join(ROOT, 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'Perms.gs', 'PermActions.gs', 'StoreOps.gs', 'StaffClock.gs', 'Code.gs']
  .map((f) => [f, fs.readFileSync(path.join(GS_DIR, f), 'utf8')]);

// ---- 可重現亂數（mulberry32）----
const SEED = process.env.E2E_SEED ? Number(process.env.E2E_SEED) : (Date.now() % 1000000007);
console.log('E2E_SEED=' + SEED);
let st = SEED >>> 0;
function rnd() { st = (st + 0x6D2B79F5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const sample = (arr, n) => { const a = arr.slice(); const out = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]); return out; };
const chance = (p) => rnd() < p;

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ============================================================
// 1. 前端裁切 filterAuditData_：隨機資料 × 隨機 node（字串／陣列／空／不存在／數字店碼）
// ============================================================
const STORE_POOL = ['sxl-gf', 'ck', 'mzt-gf', 'mzt-js', 'mzt-lzl', 'st-01', 'st-02', '1', '2'];
const ROW_KEYS = ['items', 'records', 'details', 'ops_records', 'ops_details'];
const CFG_KEYS = ['reasons', 'change_fund_std', 'petty_cash_std', 'accountant_ok', 'stores'];

/** 規格（platform/api.js 檔頭＋ test/fixtures/filter-cases.json）照寫一份：白名單、String() 比對、空字串／空陣列全清、all_stores 刪。 */
function expectFilter(data, node) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const allowed = (store) => {
    if (store === undefined || store === null) return false;
    const s = String(store);
    if (typeof node === 'string') return node !== '' && s === node;
    if (Array.isArray(node)) return node.some((n) => String(n) === s);
    return false;
  };
  const out = {};
  if ('ok' in data) { out.ok = data.ok; if (data.ok === false && typeof data.error === 'string') out.error = data.error; }
  for (const k of ROW_KEYS) {
    if (!(k in data)) continue;
    out[k] = Array.isArray(data[k]) ? data[k].filter((r) => r && typeof r === 'object' && !Array.isArray(r) && allowed(r.store)) : [];
  }
  const cfg = data.config;
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    const c = {};
    for (const k of CFG_KEYS) {
      if (!(k in cfg)) continue;
      c[k] = k === 'stores' ? (Array.isArray(cfg.stores) ? cfg.stores.filter((r) => r && typeof r === 'object' && allowed(r.code)) : []) : cfg[k];
    }
    out.config = c;
  }
  if ('dry' in data) out.dry = data.dry;
  return out;
}

function randomGetAll(codes) {
  const row = (extra) => Object.assign({ store: pick(codes.concat([undefined, null, 7, 'zzz'])) }, extra);
  const data = { ok: chance(0.9) ? true : false };
  if (data.ok === false) data.error = chance(0.5) ? '通行碼錯誤' : 42;
  for (const k of ROW_KEYS) {
    if (chance(0.85)) {
      const n = ri(0, 12);
      const arr = [];
      for (let i = 0; i < n; i++) arr.push(chance(0.9) ? row({ id: i }) : pick([null, 'str', 3, [1]]));
      data[k] = chance(0.9) ? arr : pick([null, 'x', { a: 1 }]);
    }
  }
  if (chance(0.9)) {
    data.config = chance(0.9) ? {
      reasons: ['a', 'b'], change_fund_std: ri(1000, 50000), petty_cash_std: 5000, accountant_ok: chance(0.5),
      stores: codes.map((c, i) => ({ code: c, name: 'N' + c, order: i })),
      all_stores: codes.map((c, i) => ({ code: c, name: 'N' + c, tab: 'T', active: true, order: i })),
      secret_thing: 'x'
    } : pick([[1], 'cfg', null]);
  }
  if (chance(0.5)) data.dry = chance(0.5);
  if (chance(0.5)) data.token = 't';
  if (chance(0.5)) data.evil = [1];
  return data;
}

{
  let n = 0;
  for (let round = 0; round < 120; round++) {
    const codes = sample(STORE_POOL, ri(2, 6));
    const data = randomGetAll(codes);
    const nodes = [pick(codes), '', 'nope', [], [pick(codes)], sample(codes, ri(1, codes.length)), sample(codes, 2).concat(['nope']), null, undefined, 7, { a: 1 }];
    for (const node of nodes) {
      const got = __filterAuditData(JSON.parse(JSON.stringify(data)), node);
      // node 不是字串／陣列（null、數字、物件）→ 規格：一律不允許任何店（往關的方向）
      const exp = expectFilter(data, (typeof node === 'string' || Array.isArray(node)) ? node : []);
      n++;
      ok(same(got, exp), '1: filterAuditData_ 隨機第 ' + n + ' 組（node=' + JSON.stringify(node) + '）', { got, exp });
    }
  }
  // 非物件 data
  for (const bad of [null, 'x', 3, [1, 2], undefined]) ok(same(__filterAuditData(bad, 'a'), {}), '1b: data=' + JSON.stringify(bad) + ' → {}');
  console.log('1: 前端裁切 ' + n + ' 組隨機比對完成');
}

// ============================================================
// GAS 假物件（抄 test/proxy-authorize.test.mjs 的最小集合）
// ============================================================
function makeSheet(rows) {
  const data = (rows || []).map((r) => r.slice());
  return {
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(row, col, numRows, numCols) {
      numRows = numRows || 1; numCols = numCols || 1;
      const range = {
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) { const src = data[row - 1 + r] || []; const o = []; for (let c = 0; c < numCols; c++) { const v = src[col - 1 + c]; o.push(v === undefined ? '' : v); } out.push(o); }
          return out;
        },
        setValue(v) { range.setValues([[v]]); },
        setValues(vals) {
          for (let r = 0; r < vals.length; r++) { const rI = row - 1 + r; while (data.length <= rI) data.push([]); for (let c = 0; c < vals[r].length; c++) { const cI = col - 1 + c; while (data[rI].length <= cI) data[rI].push(''); data[rI][cI] = vals[r][c]; } }
          return range;
        },
        setNumberFormat() { return range; }
      };
      return range;
    },
    appendRow(r) { data.push(r.slice()); },
    deleteRow(n) { data.splice(n - 1, 1); },
    deleteRows(s, n) { data.splice(s - 1, n); },
    _rows: () => data.map((r) => r.slice())
  };
}
const bytes = (v) => Buffer.isBuffer(v) ? v : (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => (b < 0 ? b + 256 : b) & 0xff)));
const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));

function load(seed) {
  const sheets = {};
  Object.keys(seed).forEach((k) => { sheets[k] = makeSheet(seed[k]); });
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; } };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-for-dd-tests' };
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
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => { const e = cache.get(k); if (!e) return null; if (e.exp && Date.now() > e.exp) { cache.delete(k); return null; } return e.v; },
      put: (k, v, ttl) => cache.set(k, { v: String(v), exp: ttl ? Date.now() + ttl * 1000 : null }),
      remove: (k) => cache.delete(k)
    }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  return { sb: sandbox, sheets, props };
}
function post(sb, action, payload, token) {
  const e = { postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } };
  return JSON.parse(sb.doPost(e).getContent());
}

// ============================================================
// 2. proxyAuthorize_：隨機角色權限組合 × 隨機節點 × 隨機動作，預期照 PROXY.md 第 2 節自己算
// ============================================================
const PERM_POOL = ['audit.read', 'audit.write', 'audit.read.own', 'dorm.read', 'dorm.write', 'platform.users'];
const READ = { audit: ['getAll'], dorm: ['rooms', 'list', 'contract', 'handover'] };
const WRITE = { audit: ['submitAudit', 'markRest', 'submitOpsAudit', 'addStore', 'setStoreStatus', 'renameStore'], dorm: ['create', 'terminate', 'handoverCreate', 'handoverSign', 'handoverPdf'] };
const ACTIONS = ['getAll', 'getall', 'submitAudit', 'markRest', 'submitOpsAudit', 'addStore', 'setStoreStatus', 'renameStore', 'delete', 'cleanupTest', '',
  'rooms', 'list', 'contract', 'handover', 'create', 'terminate', 'handoverCreate', 'handoverSign', 'handoverPdf', 'proxyAuthorize_'];

function expectAuth(perms, node, secrets, ns, action) {
  const has = (p) => perms.indexOf('*') !== -1 || perms.indexOf(p) !== -1;
  // ns 必須是 module_secrets 分頁「出現過」的 backend_id：一列都沒有＝不認識這個系統
  if (!Object.prototype.hasOwnProperty.call(secrets, ns) || Object.keys(secrets[ns]).length === 0) return { ok: false, code: 'UNKNOWN_NS' };
  const isWrite = READ[ns].indexOf(action) === -1;
  if (isWrite && WRITE[ns].indexOf(action) === -1) return { ok: false, code: 'FORBIDDEN' };
  const canWrite = has(ns + '.write'), canRead = has(ns + '.read'), canOwn = has(ns + '.read.own');
  if (isWrite ? !canWrite : !(canWrite || canRead || canOwn)) return { ok: false, code: 'FORBIDDEN' };
  const level = canWrite ? 'write' : ((canRead || canOwn) ? 'read' : null);
  const raw = secrets[ns][level];
  const secret = (raw === undefined || raw === null || raw === '') ? '' : String(raw).trim();
  if (!secret) return { ok: false, code: 'NO_SECRET' };
  return { ok: true, secret, filterNode: (!canRead && canOwn) ? String(node || '') : null, isWrite };
}

{
  const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
  const H = (pw, salt) => HASHER.hashPassword_(pw, salt);
  let total = 0;
  for (let round = 0; round < 6; round++) {
    const nRoles = ri(3, 6);
    const roles = [['role', 'name_zh', 'perms'], ['admin', '管理者', '*'], ['staff', '員工', '']];
    const rolePerms = { admin: ['*'], staff: [] };
    for (let i = 0; i < nRoles; i++) {
      const name = 'role' + i;
      const ps = sample(PERM_POOL, ri(0, 4));
      roles.push([name, '角色' + i, ps.join(',')]);
      rolePerms[name] = ps;
    }
    const secrets = { audit: {}, dorm: {} };
    if (chance(0.9)) secrets.audit.read = chance(0.3) ? ri(100000, 999999) : 'FAKE-AR-' + round;
    if (chance(0.9)) secrets.audit.write = chance(0.5) ? ' FAKE-AW-' + round + ' ' : 'FAKE-AW-' + round;
    if (chance(0.5)) secrets.dorm.read = 'FAKE-DR-' + round;
    if (chance(0.9)) secrets.dorm.write = 'FAKE-DW-' + round;
    if (chance(0.3)) secrets.payroll = { read: 'FAKE-PR' };
    const secretRows = [['backend_id', 'level', 'secret']];
    Object.keys(secrets).forEach((ns) => Object.keys(secrets[ns]).forEach((lv) => secretRows.push([ns, lv, secrets[ns][lv]])));
    const users = [['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at', 'token_after']];
    const nUsers = ri(5, 10);
    const pw = {};
    for (let i = 0; i < nUsers; i++) {
      const u = 'u' + round + '_' + i;
      const role = pick(Object.keys(rolePerms).filter((r) => r !== 'staff'));
      const node = pick(STORE_POOL.concat(['', '', '']));
      pw[u] = { pw: 'FAKE-pw-' + i, role, node };
      users.push(['u' + String(100 + i), u, '假' + i, role, node, 's' + i, H('FAKE-pw-' + i, 's' + i), 'TRUE', '', '', '']);
    }
    const { sb } = load({ users, roles, module_secrets: secretRows, login_log: [['at', 'username', 'ip_hash', 'result']] });
    sb.setupStaff();
    for (const u of Object.keys(pw)) {
      const lr = post(sb, 'login', { username: u, password: pw[u].pw });
      ok(lr.ok === true, '2: ' + u + ' 登入', lr);
      if (!lr.ok) continue;
      const tok = lr.data.token;
      ok(!('secrets' in lr.data) && !/FAKE-(AR|AW|DR|DW)/.test(JSON.stringify(lr)), '2: ' + u + ' login 回應不含通行碼');
      const perms = rolePerms[pw[u].role];
      for (const ns of ['audit', 'dorm', 'platform', 'AUDIT', '__proto__']) {
        for (const action of sample(ACTIONS, 8)) {
          const got = sb.proxyAuthorize_(tok, ns, action);
          const exp = expectAuth(perms, pw[u].node, secrets, ns, action);
          total++;
          const slim = got.ok ? { ok: true, secret: got.secret, filterNode: got.filterNode, isWrite: got.isWrite } : { ok: false, code: got.code };
          ok(same(slim, exp), '2: ' + u + '(' + pw[u].role + ' ' + JSON.stringify(perms) + ' node=' + pw[u].node + ') ' + ns + '.' + action, { got, exp });
          if (!got.ok) ok(!/FAKE-(AR|AW|DR|DW)/.test(JSON.stringify(got)), '2: 失敗訊息不含通行碼');
        }
      }
    }
    ok(sb.proxyAuthorize_('bad.token', 'audit', 'getAll').code === 'BAD_TOKEN', '2: 壞 token → BAD_TOKEN');
    ok(sb.proxyAuthorize_('', 'audit', 'getAll').code === 'NO_TOKEN', '2: 空 token → NO_TOKEN');
  }
  console.log('2: proxyAuthorize_ ' + total + ' 組隨機比對完成');
}

// ============================================================
// 3. permCompute_（role staff 的稽核範圍）：隨機組織／規則／區域，REGIONS 開／關各算一次
// ============================================================
const BRANDS = ['mala', 'mzt', 'yiwu'];
const TITLES = { pt: { parent: 'store', rank: 1 }, sm: { parent: 'store', rank: 3 }, osv: { parent: 'office', rank: 3 }, oam: { parent: 'office', rank: 3 }, odir: { parent: 'office', rank: 4 } };
const GRANTABLE = ['audit.read.own', 'audit.read.brand', 'audit.read', 'audit.write', 'dorm.read', 'dorm.write'];

function expectScope(input) {
  const s = input.staff, org = input.org;
  const unit = org.units[s.unit];
  if (!unit || unit.active === false) return { perms: [], scope: 'none' };
  const tdef = org.titles[s.title];
  if (!tdef || tdef.active === false || tdef.parent !== unit.ladder) return { perms: [], scope: 'none' };
  const brand = unit.parent;
  const granted = new Set();
  for (const r of input.rules) {
    if (GRANTABLE.indexOf(r.perm) === -1) continue;
    if (r.ladder !== unit.ladder) continue;
    if (r.title !== '*' && r.title !== s.title) continue;
    if (r.dept !== '') continue; // 本測試不給部門
    granted.add(r.perm);
  }
  const perms = [...granted].sort((a, b) => GRANTABLE.indexOf(a) - GRANTABLE.indexOf(b)).sort();
  const has = (p) => granted.has(p);
  let scope = 'none';
  const sm = input.storeMap;
  if (has('audit.read') || has('audit.write')) scope = 'all';
  else if (has('audit.read.brand')) {
    const list = [];
    const rc = input.regionCtx;
    if (rc && rc.on && (s.title === 'osv' || s.title === 'oam')) {
      for (const code of (rc.idx.bySupervisor[s.emp_no] || [])) {
        for (const u of (rc.idx.byRegion[code] ? rc.idx.byRegion[code].stores : [])) {
          if (!org.units[u] || org.units[u].active === false) continue;
          if (sm[u]) list.push(sm[u]);
        }
      }
    } else {
      for (const code of Object.keys(org.units)) {
        if (org.units[code].active === false || org.units[code].parent !== brand) continue;
        if (sm[code]) list.push(sm[code]);
      }
    }
    scope = [...new Set(list)].sort();
  } else if (has('audit.read.own')) {
    scope = sm[s.unit] ? [sm[s.unit]] : [];
  }
  return { perms, scope };
}

{
  const { sb } = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] });
  let total = 0;
  for (let round = 0; round < 60; round++) {
    const units = {};
    const unitCodes = [];
    for (const b of BRANDS) {
      units[b + '-office'] = { ladder: 'office', parent: b, active: true };
      const n = ri(1, 4);
      for (let i = 0; i < n; i++) { const c = b + '-s' + i; units[c] = { ladder: 'store', parent: b, active: chance(0.9) }; unitCodes.push(c); }
    }
    const org = { units, titles: Object.fromEntries(Object.entries(TITLES).map(([k, v]) => [k, Object.assign({ active: true }, v)])), depts: {} };
    const storeMap = {};
    for (const c of unitCodes) if (chance(0.85)) storeMap[c] = pick(STORE_POOL) + '-' + c;
    const rules = [];
    for (let i = 0; i < ri(2, 8); i++) rules.push({ rule_id: 'r' + i, ladder: pick(['store', 'office']), dept: '', title: pick(['*', 'pt', 'sm', 'osv', 'oam', 'odir']), perm: pick(GRANTABLE.concat(['bogus.perm'])) });
    // 區域：每品牌 0–2 區，各劃 1–3 家店（不重複），督導隨機
    const idx = { byStore: {}, byRegion: {}, bySupervisor: {} };
    const sups = ['DZY101', 'DZY102', 'DZY103'];
    for (const b of BRANDS) {
      const stores = unitCodes.filter((c) => c.startsWith(b + '-'));
      let left = stores.slice();
      for (let k = 0; k < ri(0, 2) && left.length; k++) {
        const take = sample(left, ri(1, Math.min(3, left.length)));
        left = left.filter((x) => take.indexOf(x) === -1);
        const code = 'r-' + b + '-' + k;
        const sup = chance(0.7) ? pick(sups) : '';
        idx.byRegion[code] = { code, name: '區' + k, brand: b, stores: take, supervisorEmp: sup };
        take.forEach((s) => { idx.byStore[s] = code; });
        if (sup) (idx.bySupervisor[sup] = idx.bySupervisor[sup] || []).push(code);
      }
    }
    const n = ri(3, 6);
    for (let i = 0; i < n; i++) {
      const title = pick(Object.keys(TITLES));
      const brand = pick(BRANDS);
      const unit = chance(0.15) ? pick(['ghost', brand + '-office', pick(unitCodes)]) : (TITLES[title].parent === 'office' ? brand + '-office' : pick(unitCodes.filter((c) => c.startsWith(brand))));
      const staff = { status: chance(0.9) ? 'active' : 'pending', brand, unit, dept: '', title, extra_depts: [], emp_no: pick(sups.concat(['DZY900'])) };
      for (const on of [false, true]) {
        const input = { staff, org, rules, exs: [], storeMap, today: '2026-10-29', regionCtx: { on, idx } };
        const got = sb.permCompute_(JSON.parse(JSON.stringify(input)));
        const exp = staff.status !== 'active' ? { perms: [], scope: 'none' } : expectScope(input);
        total++;
        const slim = { perms: got.perms, scope: got.auditScope };
        ok(same(slim, exp), '3: permCompute_ 第 ' + total + ' 組（REGIONS ' + (on ? '開' : '關') + '，' + staff.title + '@' + staff.unit + ' ' + staff.emp_no + '）', { got: slim, exp, rules });
      }
    }
  }
  console.log('3: permCompute_ ' + total + ' 組隨機比對完成（REGIONS 開／關各半）');
}

console.log('\nE2E_SEED=' + SEED + '  共 ' + (passed + failed) + ' 項檢查，通過 ' + passed + '，失敗 ' + failed);
process.exit(failed ? 1 : 0);
