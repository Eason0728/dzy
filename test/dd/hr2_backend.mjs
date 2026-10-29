// node test/dd/hr2_backend.mjs [--seed N] —— 人資部門（乙組）資料帶入測試：考勤名單、排班閘門、薪酬 scope
// 每次全部隨機重抽組織／同仁／打卡帳號／例外；「誰核誰、誰看得到誰」由本檔照規格獨立推一次（oracle），
// 不呼叫系統的判斷函式當預期值；逐人逐帳號比對 ident.att.people／req_people／view_people／units_managed／self、
// 登入衍生權限 platform.att／sched／storeops、attUpperGaps、薪酬 scope。印出種子，E2E_SEED=<n> 可重現。
// 規格：docs/att-support/spec.md、docs/att-view/spec.md、docs/req-upper/、docs/att-hr-acting/spec.md、docs/schedule-hq/spec.md、docs/payroll-scope/spec.md
// ⚠ 所有姓名、編號都是假資料。只新增本檔，不改既有共用檔；後端 .gs 以 vm 載入（骨架抄 test/storeops.mock.test.mjs）。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'StaffClock.gs', 'Perms.gs', 'PermActions.gs', 'StoreOps.gs', 'Code.gs']
  .map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

// ── 種子 ──
const argSeed = process.argv.indexOf('--seed') !== -1 ? Number(process.argv[process.argv.indexOf('--seed') + 1]) : NaN;
const SEED = Number.isFinite(argSeed) ? argSeed : (process.env.E2E_SEED ? Number(process.env.E2E_SEED) : (Date.now() % 1000000));
console.log('SEED=' + SEED + '  （重現：E2E_SEED=' + SEED + ' node test/dd/hr2_backend.mjs）');
let rs = SEED >>> 0 || 1;
function rnd() { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; return rs / 4294967296; }
for (let i = 0; i < 20; i++) rnd();   // 暖機：小種子的前幾個值偏小，會讓第一個抽樣（REGIONS_ON）永遠同一邊
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

let passed = 0, failed = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { passed++; } else { failed++; fails.push(label); console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra).slice(0, 1500) : '')); }
}
const J = (v) => JSON.stringify(v);
const eq = (a, b) => J(a) === J(b);
const uniqSorted = (arr) => Array.from(new Set(arr)).sort();
const inter = (a, b) => a.some((x) => b.indexOf(x) !== -1);

// ── GAS 假物件（抄 storeops.mock） ──
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
          for (let r = 0; r < vals.length; r++) { const ri2 = row - 1 + r; while (data.length <= ri2) data.push([]); for (let c = 0; c < vals[r].length; c++) { const ci = col - 1 + c; while (data[ri2].length <= ci) data[ri2].push(''); data[ri2][ci] = vals[r][c]; } }
          return range;
        },
        setNumberFormat() { return range; }
      };
      return range;
    },
    appendRow(r) { data.push(r.slice()); },
    _data: data
  };
}
function bytes(v) { if (Buffer.isBuffer(v)) return v; if (typeof v === 'string') return Buffer.from(v, 'utf8'); return Buffer.from(v.map((b) => (b < 0 ? b + 256 : b) & 0xff)); }
function signed(buf) { return Array.from(buf, (b) => (b > 127 ? b - 256 : b)); }
function load(seed) {
  const sheets = {};
  Object.keys(seed).forEach((k) => { sheets[k] = makeSheet(seed[k]); });
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; } };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-dd-hr2' };
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
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => { const e = cache.get(k); return e && !(e.exp && Date.now() > e.exp) ? e.v : null; }, put: (k, v, ttl) => cache.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null }), remove: (k) => cache.delete(k) }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  return { sb: sandbox, sheets, props };
}
function post(sb, action, payload, token) {
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }).getContent());
}

// ============================================================
// 1. 隨機世界
// ============================================================
const PW = 'fake-dd-hr2-pw';
const SALT = 'salt-dd-hr2';
const SVC = 'fake-dd-hr2-svc-key';
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
const USERS_HEAD = ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at', 'token_after'];
const SURNAMES = ['測', '試', '假', '虛', '擬', '樣', '範', '例', '仿', '幻'];
const GIVEN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const NO_ATT = ['odir', 'hm', 'ceo', 'gm', 'chair'];
const EXEC = ['ceo', 'gm', 'chair'];
const HR_ONLY_DEPTS = ['fin'];
const GATE_ATT = ['sm', 'fm', 'am', 'rdd', 'osv', 'odir', 'hm', 'ceo', 'gm', 'chair'];
const GATE_SCHED = ['sm', 'fm', 'am'];
const TODAY = (() => { const d = new Date(Date.now() + 8 * 3600e3); return d.toISOString().slice(0, 10); })();
const dateShift = (days) => { const d = new Date(Date.now() + 8 * 3600e3 + days * 86400e3); return d.toISOString().slice(0, 10); };

function genWorld() {
  const W = { brands: [], units: [], people: [], accounts: [], clockStores: [], regions: [], ex: [], pilot: [], regionsOn: chance(0.6) };
  let empSeq = 100 + ri(0, 50);
  const newEmp = () => { empSeq++; if (empSeq === 27) empSeq++; return 'DZY' + String(empSeq).padStart(3, '0'); };
  const newName = () => pick(SURNAMES) + pick(GIVEN) + pick(GIVEN);
  // 品牌 2～3 個，每品牌 1～4 店＋1 辦公室
  const nb = ri(2, 3);
  const bcodes = shuffle(['bk', 'bq', 'bz', 'bw']).slice(0, nb);
  bcodes.forEach((b, bi) => {
    W.brands.push({ code: b, name: '品牌' + b.toUpperCase() });
    const ns = ri(1, 4);
    for (let s = 1; s <= ns; s++) {
      W.units.push({ code: b + '-s' + s, name: '門市' + b.toUpperCase() + s, parent: b, ladder: 'store', active: chance(0.9), isTestStore: true });
    }
    W.units.push({ code: b + '-hq', name: '品牌' + b.toUpperCase() + '辦公室', parent: b, ladder: 'office', active: true });
  });
  const stores = () => W.units.filter((u) => u.ladder === 'store');
  const activeStores = () => stores().filter((u) => u.active);
  // 打卡店：每個啟用門市大多有自己的打卡店；偶爾兩家同品牌門市共用一個打卡店；偶爾門市沒有打卡店
  let csn = 0;
  const unitToStore = {};
  const byBrand = {};
  stores().forEach((u) => { (byBrand[u.parent] = byBrand[u.parent] || []).push(u); });
  Object.keys(byBrand).forEach((b) => {
    const list = shuffle(byBrand[b]);
    let i = 0;
    while (i < list.length) {
      if (chance(0.12)) { i++; continue; }   // 這家店沒有打卡店
      const share = chance(0.2) && i + 1 < list.length ? 2 : 1;
      const grp = list.slice(i, i + share);
      i += share;
      csn++;
      const code = 'cs' + csn;
      const unitCodes = grp.map((x) => x.code);
      if (chance(0.1)) unitCodes.push('zz-ghost');   // 打錯的單位代碼：不算
      W.clockStores.push({ code, name: '打卡店' + csn, units: unitCodes, pay: 'P' + String(csn).padStart(2, '0') });
      grp.forEach((x) => { unitToStore[x.code] = code; });
    }
  });
  W.clockStores.push({ code: 'cf', name: '中央廚房', units: ['ck'], pay: 'CF' });
  W.clockStores.push({ code: 'hq', name: '總部', units: ['dzy-hq'].concat(W.units.filter((u) => u.ladder === 'office').map((u) => u.code)), pay: 'HQ' });
  unitToStore.ck = 'cf'; unitToStore['dzy-hq'] = 'hq';
  W.units.filter((u) => u.ladder === 'office').forEach((u) => { unitToStore[u.code] = 'hq'; });
  W.unitToStore = unitToStore;
  // 試點：門市大多在、央廚／總部／辦公室隨機
  W.pilot = [];
  stores().forEach((u) => { if (chance(0.8)) W.pilot.push(u.code); });
  if (chance(0.7)) W.pilot.push('ck');
  if (chance(0.7)) W.pilot.push('dzy-hq');
  W.units.filter((u) => u.ladder === 'office').forEach((u) => { if (chance(0.7)) W.pilot.push(u.code); });
  W.pilot = uniqSorted(W.pilot);

  const addP = (unit, dept, title, status) => {
    const p = { emp: newEmp(), name: newName(), unit, dept: dept || '', title, status: status || (chance(0.85) ? 'active' : pick(['active', 'disabled', 'pending', 'unclaimed', 'rejected'])), hire: '2026-0' + ri(1, 9) + '-0' + ri(1, 9) };
    W.people.push(p);
    return p;
  };
  // 門市人員
  stores().forEach((u) => {
    for (let k = 0; k < ri(0, 2); k++) addP(u.code, '', 'sm');
    if (chance(0.4)) addP(u.code, '', 'am');
    for (let k = 0; k < ri(1, 4); k++) addP(u.code, '', pick(['pt', 'pt', 'ft']));
    if (chance(0.08)) addP(u.code, '', 'fm');   // 職稱不屬於這家店（廠長只能在央廚）→ 身分無效
  });
  // 辦公室
  W.units.filter((u) => u.ladder === 'office').forEach((u) => {
    if (chance(0.7)) addP(u.code, '', 'odir');
    for (let k = 0; k < ri(0, 2); k++) addP(u.code, '', 'osv');
    if (chance(0.5)) addP(u.code, '', 'ofs');
    if (chance(0.15)) addP(u.code, '', 'oam');   // 已停用的職稱
  });
  // 央廚
  if (chance(0.7)) addP('ck', '', 'fm');
  if (chance(0.5)) addP('ck', '', 'rdd');
  for (let k = 0; k < ri(1, 3); k++) addP('ck', '', 'pt');
  if (chance(0.1)) addP('ck', '', 'sm');   // 央廚沒有店長 → 無效
  // 總部
  ['hr', 'fin', 'it', 'mgmt', 'ops'].forEach((d) => {
    if (chance(d === 'hr' ? 0.8 : 0.6)) addP('dzy-hq', d, 'hm');
    for (let k = 0; k < ri(0, 2); k++) addP('dzy-hq', d, 'hs');
  });
  EXEC.forEach((t) => { if (chance(0.5)) addP('dzy-hq', 'mgmt', t); });
  if (chance(0.3)) addP('dzy-hq', '', 'hs');   // 總部沒填部門 → attNeed null
  // 幾位「單位空白」的未開通同仁（推算用）
  for (let k = 0; k < ri(0, 2); k++) addP('', '', '', pick(['unclaimed', 'pending']));
  // 一位單位已停用的門市同仁
  const inactiveStore = stores().find((u) => !u.active);
  if (inactiveStore && chance(0.5)) addP(inactiveStore.code, '', 'pt');

  // 打卡帳號：主店 role home（單位對到的打卡店）；隨機支援帳號
  let eidSeq = 0;
  const addAcct = (p, store, role, extra) => {
    eidSeq++;
    const a = Object.assign({ emp: p.emp, store, eid: store.toUpperCase() + String(eidSeq).padStart(3, '0'), role, state: 'confirmed', roster: 'TRUE', duty: 'FALSE' }, extra || {});
    W.accounts.push(a);
    return a;
  };
  const allStoreCodes = W.clockStores.map((c) => c.code);
  W.people.forEach((p) => {
    let home = unitToStore[p.unit];
    if (!home && !p.unit) home = chance(0.7) ? pick(allStoreCodes) : '';   // 單位空白的人：主店打卡（推算用）
    if (home && chance(0.95)) {
      const a = addAcct(p, home, 'home');
      if (chance(0.06)) a.state = 'pending';
      if (chance(0.05)) a.roster = 'FALSE';
      if (chance(0.25) && ['pt', 'ft', 'sm', 'am', 'osv'].indexOf(p.title) !== -1) a.duty = 'TRUE';
    }
    // 支援帳號 0～2 個
    const n = chance(0.35) ? ri(1, 2) : 0;
    for (let k = 0; k < n; k++) {
      const others = allStoreCodes.filter((c) => c !== home);
      if (!others.length) break;
      const st = pick(others);
      if (W.accounts.some((x) => x.emp === p.emp && x.store === st)) continue;
      const a = addAcct(p, st, 'support');
      if (chance(0.15)) a.duty = 'TRUE';
      if (chance(0.05)) a.state = 'pending';
    }
  });
  // 區域：每品牌 0～2 區
  W.brands.forEach((b) => {
    const list = shuffle(stores().filter((u) => u.parent === b.code).map((u) => u.code));
    const nr = ri(0, 2);
    const osvs = W.people.filter((p) => p.unit === b.code + '-hq' && p.title === 'osv');
    let i = 0;
    for (let r = 0; r < nr && i < list.length; r++) {
      const take = ri(1, Math.max(1, list.length - i));
      const st = list.slice(i, i + take); i += take;
      if (chance(0.1) && i < list.length) st.push(list[i]);   // 一家店出現在兩區 → 兩邊都不算
      let sup = '';
      if (osvs.length && chance(0.75)) sup = pick(osvs).emp;
      else if (chance(0.3)) sup = pick(W.people).emp;   // 不合格督導
      W.regions.push({ code: 'r-' + b.code + '-' + (r + 1), name: b.code.toUpperCase() + '區' + (r + 1), brand: b.code, stores: st, sup, active: chance(0.9) });
    }
  });
  // 個別例外
  const validIdent = (p) => identityOk(W, p);
  const actives = W.people.filter((p) => p.status === 'active' && validIdent(p));
  const until = () => (chance(0.6) ? '' : (chance(0.7) ? dateShift(ri(0, 30)) : dateShift(-ri(1, 30))));
  actives.forEach((p) => {
    if (chance(0.08)) W.ex.push({ emp: p.emp, perm: 'att.extra', until: until() });
    if (chance(0.08)) W.ex.push({ emp: p.emp, perm: 'att.view@' + pick(activeStores().map((u) => u.code).concat(['ck'])), until: until() });
    if (chance(0.1) && ['osv', 'ofs', 'hs', 'sm', 'am', 'pt', 'ft', 'odir'].indexOf(p.title) !== -1) {
      const cands = activeStores().filter((u) => u.code !== p.unit);
      if (cands.length) W.ex.push({ emp: p.emp, perm: 'store.sm@' + pick(cands).code, until: until() });
    }
    if (chance(0.1)) W.ex.push({ emp: p.emp, perm: 'payroll.store@' + pick(W.clockStores).pay, until: until() });
  });
  return W;
}

/** 主要身分有效：單位存在啟用、職稱存在啟用、職稱階梯＝單位階梯、單位限定（ck 只有 pt ft fm rdd；fm rdd 只在 ck） */
const TITLE_LADDER = { pt: 'store', ft: 'store', sm: 'store', am: 'store', fm: 'store', rdd: 'store', ofs: 'office', osv: 'office', odir: 'office', hs: 'hq', hm: 'hq', ceo: 'hq', gm: 'hq', chair: 'hq' };
const TITLE_ACTIVE = Object.keys(TITLE_LADDER);   // oam／sv／bd 停用
function unitOf(W, code) {
  if (code === 'ck') return { code: 'ck', name: '中央工廠（央廚）', parent: 'ck', ladder: 'store', active: true };
  if (code === 'dzy-hq') return { code: 'dzy-hq', name: '鼎兆元總部', parent: 'dzy', ladder: 'hq', active: true };
  return W.units.find((u) => u.code === code) || null;
}
function identityOk(W, p) {
  const u = unitOf(W, p.unit);
  if (!u || !u.active) return false;
  if (TITLE_ACTIVE.indexOf(p.title) === -1) return false;
  if (TITLE_LADDER[p.title] !== u.ladder) return false;
  if (u.code === 'ck' && ['pt', 'ft', 'fm', 'rdd'].indexOf(p.title) === -1) return false;
  if ((p.title === 'fm' || p.title === 'rdd') && u.code !== 'ck') return false;
  return true;
}

// ── 把世界灌進 sandbox ──
function build(W) {
  const admins = [['a001', 'BOSS', '系統管理者']];
  const users = [USERS_HEAD].concat(admins.map((a) => [a[0], a[1], a[2], 'admin', '', SALT, HASHER.hashPassword_(PW, SALT), 'TRUE', '', '', '']))
    .concat(W.people.filter((p) => p.status !== 'pending' && p.status !== 'unclaimed').map((p) => ['u' + p.emp.slice(3), p.emp, p.name, 'staff', '', SALT, HASHER.hashPassword_(PW, SALT), p.status === 'disabled' ? 'FALSE' : 'TRUE', '', '', '']));
  const app = load({
    users,
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['staff', '員工', '']],
    module_secrets: [['backend_id', 'level', 'secret'], ['payroll', 'write', 'fake-payroll-secret'], ['attendance', 'read', 'fake-att-secret'], ['schedule', 'read', 'fake-sched-secret']],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  });
  const { sb, sheets } = app;
  sb.setupStaff();
  // org：加品牌、單位
  W.brands.forEach((b, i) => sheets.org._data.push(['brand', b.code, b.name, '', '', '', 50 + i, 'TRUE']));
  W.units.forEach((u, i) => sheets.org._data.push(['unit', u.code, u.name, u.parent, u.ladder, '', 50 + i, u.active ? 'TRUE' : 'FALSE']));
  // staff
  W.people.forEach((p, i) => {
    const row = new Array(27).fill('');
    row[0] = p.emp; row[1] = (p.status === 'pending' || p.status === 'unclaimed') ? '' : 'u' + p.emp.slice(3); row[2] = p.name; row[3] = p.status;
    row[4] = p.unit ? (unitOf(W, p.unit) || { parent: '' }).parent : ''; row[5] = p.unit; row[6] = p.dept; row[7] = p.title;
    row[19] = '2026-02-0' + ((i % 8) + 1) + ' 10:00:00'; row[24] = p.hire;
    sheets.staff._data.push(row);
  });
  // clock_stores：清掉預設、改成隨機
  sheets.clock_stores._data.length = 1;
  W.clockStores.forEach((c) => sheets.clock_stores._data.push([c.code, c.name, c.units.join(','), 'TRUE', c.pay]));
  // staff_clock（表頭含 duty_mgr，欄 15）
  W.accounts.forEach((a) => {
    const r = [a.emp, a.store, a.eid, a.role, a.state, 'created', a.roster, '', 'tester', '', ''];
    while (r.length < 15) r.push('');
    r.push(a.duty);
    sheets.staff_clock._data.push(r);
  });
  // regions
  W.regions.forEach((g) => sheets.regions._data.push([g.code, g.name, g.brand, g.stores.join(','), g.sup, g.active ? 'TRUE' : 'FALSE', '2026-10-25 09:00:00', 'tester']));
  app.props.STORE_SVC_KEY = SVC;
  app.props.STORE_SSO_UNITS = W.pilot.join(',');
  app.props.REGIONS_ON = W.regionsOn ? '1' : '0';
  app.props.PERMS_ON = '1';
  app.login = (u) => { const r = post(sb, 'login', { username: u, password: PW }); return r.ok ? r.data : null; };
  app.adminTok = app.login('BOSS').token;
  post(sb, 'permInit', {}, app.adminTok);
  // perm_ex（直接寫表：到期日可能已過，走 action 會被擋；每筆記下來）
  W.ex.forEach((e, i) => {
    sheets.perm_ex._data.push(['X' + String(i + 1).padStart(3, '0'), e.emp, e.perm, 'add', e.until, '測試', 'TRUE', '2026-10-01 00:00:00', 'a001', '', '']);
  });
  sb.permActingReset_(); sb.regionCtxReset_();
  app.ident = (sub) => { const r = post(sb, 'svcStoreWho', { svc_key: SVC, sub }); return r.ok ? r.data : r; };
  return app;
}

// ============================================================
// 2. oracle（照規格獨立推）
// ============================================================
function oracle(W) {
  const O = {};
  const unit = (c) => unitOf(W, c);
  const byEmp = {}; W.people.forEach((p) => { byEmp[p.emp] = p; });
  const liveAcct = W.accounts.filter((a) => a.state === 'confirmed' && a.roster !== 'FALSE');
  const storeUnitsRaw = {}; W.clockStores.forEach((c) => { storeUnitsRaw[c.code] = c.units.slice(); });
  const storeUnits = {}; W.clockStores.forEach((c) => { storeUnits[c.code] = c.units.filter((u) => { const x = unit(u); return x && x.active && x.ladder === 'store'; }); });
  O.storeUnits = storeUnits;
  // 到期日有效（當天仍有效）
  const exLive = (e) => !e.until || e.until >= TODAY;
  // 有效個別例外（permCompute：身分無效＝沒有任何權限）
  const permsOf = (p) => {
    if (!p || p.status !== 'active' || !identityOk(W, p)) return [];
    return W.ex.filter((e) => e.emp === p.emp && exLive(e)).map((e) => e.perm);
  };
  // 兼任店長有效：在職、身分有效、店不是本人單位、店啟用 store 非 ck、在試點
  const actingOf = (p) => {
    if (!p || p.status !== 'active' || !identityOk(W, p)) return [];
    return uniqSorted(W.ex.filter((e) => e.emp === p.emp && e.perm.indexOf('store.sm@') === 0 && exLive(e)).map((e) => e.perm.slice(9))
      .filter((u) => { const x = unit(u); return x && x.active && x.ladder === 'store' && u !== 'ck' && x.parent !== 'ck' && u !== p.unit && W.pilot.indexOf(u) !== -1; }));
  };
  // 值班單位（原始 unit_code，不過濾）
  const dutyOf = (p) => uniqSorted(liveAcct.filter((a) => a.emp === p.emp && a.duty === 'TRUE').reduce((acc, a) => acc.concat(storeUnitsRaw[a.store] || []), []));
  const isDuty = (p) => dutyOf(p).length > 0;
  const hrHeadOf = (p) => !!p && p.status === 'active' && p.dept === 'hr' && p.title === 'hm';
  // 區域索引
  const regIdx = (() => {
    const regs = W.regions.filter((g) => g.active);
    const storeOk = (u, brand) => { const x = unit(u); return !!x && x.active && x.ladder === 'store' && x.parent === brand && u !== 'ck'; };
    const count = {};
    regs.forEach((g) => g.stores.forEach((s) => { if (storeOk(s, g.brand)) count[s] = (count[s] || 0) + 1; }));
    const idx = { byStore: {}, byRegion: {}, bySupervisor: {} };
    regs.forEach((g) => {
      const stores = g.stores.filter((s) => storeOk(s, g.brand) && count[s] === 1);
      const sp = byEmp[g.sup];
      const sup = sp && sp.status === 'active' && sp.title === 'osv' && unit(sp.unit) && unit(sp.unit).active && unit(sp.unit).ladder === 'office' && unit(sp.unit).parent === g.brand ? g.sup : '';
      idx.byRegion[g.code] = { stores, sup };
      stores.forEach((s) => { idx.byStore[s] = g.code; });
      if (sup) (idx.bySupervisor[sup] = idx.bySupervisor[sup] || []).push(g.code);
    });
    return idx;
  })();
  const on = W.regionsOn;
  const covers = (a, title, u) => { if (!on) return true; if (title !== 'osv' && title !== 'oam') return true; const c = regIdx.byStore[u]; return !!c && regIdx.byRegion[c].sup === a.emp; };
  const hasSup = (u) => { if (!on) return false; const c = regIdx.byStore[u]; return !!c && regIdx.byRegion[c].sup !== ''; };
  // 主店推算
  const homeOf = (emp) => { const hs = uniqSorted(liveAcct.filter((a) => a.emp === emp && a.role === 'home').map((a) => a.store)); return hs.length === 1 ? { store: hs[0], units: storeUnitsRaw[hs[0]] || [] } : null; };
  const incomplete = (p) => { if (!p.unit || !p.title) return true; const u = unit(p.unit); return !(u && u.active && TITLE_ACTIVE.indexOf(p.title) !== -1); };
  const eff = (p) => {
    if (['active', 'unclaimed', 'pending', 'rejected'].indexOf(p.status) === -1) return null;
    const t = Object.assign({}, p, { status: 'active', duty_units: dutyOf(p), acting: actingOf(p) });
    if (!incomplete(p)) { t.pilotUnits = [p.unit]; return t; }
    if (NO_ATT.indexOf(p.title) !== -1) return null;
    const h = homeOf(p.emp);
    if (h && h.units.length === 1) {
      const u = unit(h.units[0]);
      if (u && u.active && u.ladder === 'store') { t.unit = u.code; t.title = 'pt'; t.dept = ''; t.inferred = true; t.pilotUnits = [u.code]; return t; }
    }
    t.orphan = true; t.pilotUnits = h ? h.units.slice() : [];
    return t;
  };
  const need = (t, mode) => {
    if (!identityOk(W, t)) return null;
    if (NO_ATT.indexOf(t.title) !== -1) return null;
    const u = unit(t.unit);
    if (u.ladder === 'store') {
      if (['pt', 'ft', 'sm', 'fm', 'am', 'rdd'].indexOf(t.title) === -1) return null;
      if (mode === 'hours') return { kind: 'unit', unit: t.unit };
      if (t.title === 'pt' || t.title === 'ft') return t.duty_units && t.duty_units.length ? { kind: 'head', unit: t.unit, brand: u.parent } : { kind: 'unit', unit: t.unit };
      if (t.title === 'sm' || t.title === 'fm') return { kind: 'head', unit: t.unit, brand: u.parent };
      if (t.title === 'am') return { kind: 'brand_office', brand: u.parent, unit: t.unit };
      return { kind: 'hq_exec' };
    }
    if (u.ladder === 'office') return ['ofs', 'osv', 'oam'].indexOf(t.title) !== -1 ? { kind: 'office', unit: t.unit } : null;
    if (u.ladder === 'hq') {
      if (t.title !== 'hs') return null;
      if (['fin', 'hr', 'it', 'eng', 'franchise', 'purchase', 'ops', 'training', 'marketing', 'mgmt', 'branddev'].indexOf(t.dept) === -1) return null;
      if (t.dept === 'mgmt') return { kind: 'mgmt' };
      if (HR_ONLY_DEPTS.indexOf(t.dept) !== -1) return { kind: 'hr_only' };
      return { kind: 'dept', dept: t.dept };
    }
    return null;
  };
  const approver = (a, t, mode) => {
    if (a.status !== 'active' || t.status !== 'active') return false;
    const nd = need(t, mode);
    if (!nd) return false;
    if (!identityOk(W, a)) return false;
    const au = unit(a.unit);
    const same = !!a.emp && a.emp === t.emp;
    if (mode === 'req' && isDuty(t) && nd.unit && dutyOf(a).indexOf(nd.unit) !== -1) return false;
    if (nd.kind === 'unit') {
      if (!same && actingOf(a).indexOf(nd.unit) !== -1) return true;
      if (same && mode !== 'hours') return false;
      return au.ladder === 'store' && ['sm', 'fm'].indexOf(a.title) !== -1 && a.unit === nd.unit;
    }
    if (same) return false;
    if (nd.kind === 'head') {
      if (au.ladder === 'store') return ['am', 'rdd'].indexOf(a.title) !== -1 && a.unit === nd.unit;
      if (au.ladder !== 'office' || au.parent !== nd.brand) return false;
      if (a.title === 'osv') return covers(a, 'osv', nd.unit);
      return a.title === 'odir' && on && !hasSup(nd.unit);
    }
    if (nd.kind === 'brand_office') return au.ladder === 'office' && ['osv', 'odir'].indexOf(a.title) !== -1 && au.parent === nd.brand && covers(a, a.title, nd.unit);
    if (nd.kind === 'hq_exec') return au.ladder === 'hq' && EXEC.indexOf(a.title) !== -1;
    if (nd.kind === 'office') return au.ladder === 'office' && a.title === 'odir' && a.unit === nd.unit;
    if (nd.kind === 'dept') return au.ladder === 'hq' && a.title === 'hm' && a.dept === nd.dept;
    if (nd.kind === 'mgmt') return au.ladder === 'hq' && EXEC.indexOf(a.title) !== -1;
    return false;
  };
  const effAll = W.people.map(eff).filter(Boolean);
  const activePeople = W.people.filter((p) => p.status === 'active');
  // 以人為單位的名單
  const targets = (me, flags, mode) => {
    const out = {};
    const selfOk = mode === 'hours' && ['sm', 'fm'].indexOf(me.title) !== -1;
    effAll.forEach((t) => {
      if (!t.orphan && !need(t, mode)) return;
      const notSelf = !(me.emp && me.emp === t.emp);
      let okv = false;
      if (flags.admin || flags.hrHead) okv = notSelf || selfOk;
      else if (t.orphan) okv = false;
      else {
        okv = approver(me, t, mode);
        const block = mode === 'req' && isDuty(t) && dutyOf(me).indexOf(t.unit) !== -1;
        if (!okv && flags.attExtra && notSelf && me.unit && me.unit === t.unit && !block) okv = true;
      }
      if (okv) out[t.emp] = true;
    });
    return out;
  };
  const supportApprovers = (units, excludeDuty, excludeEmp) => {
    const su = units.filter((c) => { const x = unit(c); return x && x.active && x.ladder === 'store'; });
    const out = {};
    if (!su.length) return out;
    const cand = [];
    activePeople.forEach((p) => {
      if (!p.emp || p.emp === excludeEmp) return;
      if (!identityOk(W, p)) return;
      if (excludeDuty && inter(dutyOf(p), su)) return;
      cand.push({ emp: p.emp, title: p.title, unit: p.unit, ladder: unit(p.unit).ladder, brand: unit(p.unit).parent, acting: actingOf(p) });
    });
    const shops = su.filter((c) => c !== 'ck' && unit(c).parent !== 'ck');
    const layers = [
      (c) => !excludeDuty && ((c.ladder === 'store' && ['sm', 'fm'].indexOf(c.title) !== -1 && su.indexOf(c.unit) !== -1) || inter(c.acting, su)),
      (c) => c.ladder === 'store' && ['am', 'rdd'].indexOf(c.title) !== -1 && su.indexOf(c.unit) !== -1,
      (c) => on && c.ladder === 'office' && c.title === 'osv' && shops.some((u) => unit(u).parent === c.brand && covers(c, 'osv', u)),
      (c) => c.ladder === 'office' && c.title === 'odir' && shops.some((u) => unit(u).parent === c.brand)
    ];
    for (const L of layers) { const hit = cand.filter(L); if (hit.length) { hit.forEach((c) => { out[c.emp] = true; }); return out; } }
    return out;
  };
  const isSupport = (t, store, units) => {
    if (t.orphan) return false;   // 2026-10-30 Eason 照推薦：推算者（inferred，單位＝主店推算出來的）到非主店打卡也算支援、由打卡店主管核；orphan 照舊不算
    if (store === 'hq') return false;
    const tu = unit(t.unit);
    if (tu && tu.ladder === 'office') return false;
    if (!units.length) return false;
    return units.indexOf(t.unit) === -1;
  };
  const viewUnitsOf = (me) => {
    if (!me || me.status !== 'active' || !identityOk(W, me)) return [];
    const u = unit(me.unit);
    if (u.ladder !== 'office') return [];
    const brand = u.parent;
    const okU = (c) => { const x = unit(c); return x && x.active && x.ladder === 'store' && x.parent === brand && c !== 'ck'; };
    if (me.title === 'osv') { const codes = regIdx.bySupervisor[me.emp] || []; return uniqSorted(codes.reduce((acc, c) => acc.concat(regIdx.byRegion[c].stores.filter(okU)), [])); }
    if (me.title === 'odir') return uniqSorted(W.units.filter((x) => okU(x.code)).map((x) => x.code));
    return [];
  };
  const exViewUnitsOf = (p) => uniqSorted(permsOf(p).filter((c) => c.indexOf('att.view@') === 0).map((c) => c.slice(9)).filter((c) => { const x = unit(c); return x && x.active && x.ladder === 'store'; }));
  const key = (a) => a.store + '|' + a.eid;

  O.lists = (me, flags, viewUnits, exViewUnits) => {
    const H = new Set(), R = new Set(), V = new Set();
    if (!W.pilot.length) return { H, R, V };
    const hrsT = targets(me, flags, 'hours'), reqT = targets(me, flags, 'req');
    const myDuty = dutyOf(me);
    effAll.forEach((t) => {
      liveAcct.filter((a) => a.emp === t.emp).forEach((a) => {
        const units = storeUnits[a.store] || [];
        const support = isSupport(t, a.store, units);
        const self = !!me.emp && me.emp === t.emp;
        const needH = !t.orphan && !!need(t, 'hours');
        const viewable = needH && !self;
        const k = key(a);
        if (!support) {
          const pOk = inter(t.pilotUnits, W.pilot);
          if (pOk && hrsT[t.emp]) H.add(k);
          if (pOk && reqT[t.emp]) R.add(k);
          if (pOk && viewable && viewUnits.indexOf(t.unit) !== -1) V.add(k);
        } else if (inter(units, W.pilot) && !self) {
          const selfEx = inter(units, t.acting) ? t.emp : '';
          const apprH = supportApprovers(units, false, selfEx);
          const apprR = supportApprovers(units, isDuty(t), selfEx);
          const base = flags.admin || flags.hrHead;
          const extra = flags.attExtra && !!me.unit && units.indexOf(me.unit) !== -1;
          const extraBlockR = isDuty(t) && inter(myDuty, units);
          const canH = base || extra || (!!me.emp && !!apprH[me.emp]);
          const reqByHome = unit(t.unit) && unit(t.unit).ladder === 'hq';
          const canR = reqByHome ? !!reqT[t.emp] : (base || (extra && !extraBlockR) || (!!me.emp && !!apprR[me.emp]));
          if (canH || canR) {
            if (canH && needH) H.add(k);
            if (canR && !t.orphan && need(t, 'req')) R.add(k);
            // 原單位主管「工時只看」：能簽申請的人已在 req_people 看得到這個帳號，只有「原本核得到工時」的人才另進 view
            if (!canH && viewable && hrsT[t.emp]) V.add(k);
          } else if (viewable && (hrsT[t.emp] || reqT[t.emp] || inter(units, viewUnits))) V.add(k);
        }
        if (viewable && exViewUnits.length && !H.has(k)) {
          if (units.some((u) => exViewUnits.indexOf(u) !== -1 && W.pilot.indexOf(u) !== -1)) V.add(k);
        }
      });
    });
    return { H, R, V };
  };
  O.identExpect = (p, admin) => {
    const me = p || { emp: '', status: 'active', unit: '', dept: '', title: '' };
    const hrHead = !!p && hrHeadOf(p);
    const perms = p ? permsOf(p) : [];
    const flags = { admin, hrHead, attExtra: perms.indexOf('att.extra') !== -1 };
    const valid = p ? identityOk(W, p) : false;
    let managed = [];
    if (admin) managed = uniqSorted(W.units.concat([unit('ck')]).filter((u) => u.active && u.ladder === 'store' && W.pilot.indexOf(u.code) !== -1).map((u) => u.code));
    else {
      if (valid && ['sm', 'fm', 'am', 'rdd'].indexOf(p.title) !== -1 && unit(p.unit).ladder === 'store' && W.pilot.indexOf(p.unit) !== -1) managed = [p.unit];
      if (valid) managed = managed.concat(actingOf(p));
    }
    const viewUnits = (W.regionsOn && p && !admin && !hrHead) ? viewUnitsOf(p) : [];
    const exV = (p && !admin && !hrHead) ? exViewUnitsOf(p) : [];
    const L = O.lists(me, flags, viewUnits, exV);
    const self = p ? liveAcct.filter((a) => a.emp === p.emp && a.store === 'hq').map((a) => ({ clock: 'hq', emp_id: a.eid, approval: need(Object.assign({}, p, { duty_units: dutyOf(p) }), 'hours') !== null })).sort((a, b) => (a.emp_id < b.emp_id ? -1 : 1)) : [];
    return { H: Array.from(L.H).sort(), R: Array.from(L.R).sort(), V: Array.from(L.V).sort(), managed: uniqSorted(managed), self, hrHead, flags, viewUnits, exV };
  };
  // 閘門
  O.gates = (p) => {
    const out = { att: false, sched: false, storeops: false };
    if (!W.pilot.length || p.status !== 'active') return out;
    const perms = permsOf(p), acting = actingOf(p), hrHead = hrHeadOf(p);
    const hrOnlyHead = p.title === 'hm' && HR_ONLY_DEPTS.indexOf(p.dept) !== -1;
    out.att = (GATE_ATT.indexOf(p.title) !== -1 && !hrOnlyHead) || hrHead || acting.length > 0 || perms.indexOf('att.extra') !== -1 || exViewUnitsOf(p).length > 0;
    const u = unit(p.unit);
    const hasHq = liveAcct.some((a) => a.emp === p.emp && a.store === 'hq');
    let schedView = false;
    if (W.regionsOn && (p.title === 'osv' || p.title === 'odir')) {
      const vu = viewUnitsOf(p);
      if (vu.length) schedView = O.lists(p, {}, vu, []).V.size > 0;
    }
    out.sched = GATE_SCHED.indexOf(p.title) !== -1 || hrHead || acting.length > 0 || schedView || (!!u && u.active && (u.ladder === 'hq' || u.ladder === 'office') && hasHq);
    out.storeops = NO_ATT.indexOf(p.title) !== -1 || (W.pilot.indexOf(p.unit) !== -1 && identityOk(W, p) && !!u && u.ladder === 'store') || acting.length > 0 || perms.indexOf('att.extra') !== -1;
    return out;
  };
  // 找不到上層的值班主管
  O.upperGaps = () => {
    const out = [];
    activePeople.forEach((p) => {
      const t = Object.assign({}, p, { duty_units: dutyOf(p), acting: actingOf(p) });
      if (!isDuty(p)) return;
      const nd = need(t, 'req');
      if (!nd || nd.kind === 'hr_only') return;
      let gap = !W.people.some((ap) => approver(Object.assign({}, ap), t, 'req'));
      if (!gap) {
        const te = eff(p);
        liveAcct.filter((a) => a.emp === p.emp).forEach((a) => {
          const units = storeUnits[a.store] || [];
          if (!te || !isSupport(te, a.store, units)) return;
          if (unit(p.unit).ladder === 'hq') return;
          const ap = supportApprovers(units, true, inter(units, te.acting) ? p.emp : '');
          if (!Object.keys(ap).length) gap = true;
        });
      }
      if (gap) out.push(p.emp);
    });
    // 總部同仁（非值班主管）有打卡帳號、申請照原身分（部門總監核），但表上已沒有在職核定人 → 也列（StoreOps.gs 0c44636，2026-10-29 審查低 2）
    activePeople.forEach((p) => {
      if (out.includes(p.emp) || isDuty(p) || unit(p.unit).ladder !== 'hq') return;
      const te = eff(p);   // 後端 acct 只收「支援」帳號（storeAttAccounts_ a.support），總部自己的 hq 打卡不算
      if (!te || !liveAcct.some((a) => a.emp === p.emp && isSupport(te, a.store, storeUnits[a.store] || []))) return;
      const t = Object.assign({}, p, { duty_units: dutyOf(p), acting: actingOf(p) });
      const nd = need(t, 'req');
      if (!nd || nd.kind === 'hr_only') return;
      if (!W.people.some((ap) => approver(Object.assign({}, ap), t, 'req'))) out.push(p.emp);
    });
    return out.sort();
  };
  O.permsOf = permsOf; O.hrHeadOf = hrHeadOf; O.actingOf = actingOf; O.dutyOf = dutyOf; O.need = need; O.eff = eff; O.approver = approver;
  return O;
}

// ============================================================
// 3. 比對
// ============================================================
function run() {
  const W = genWorld();
  const app = build(W);
  const { sb } = app;
  const O = oracle(W);
  console.log(`世界：品牌 ${W.brands.length}、單位 ${W.units.length}、同仁 ${W.people.length}、打卡帳號 ${W.accounts.length}、打卡店 ${W.clockStores.length}、區域 ${W.regions.length}、例外 ${W.ex.length}、試點 ${W.pilot.length}、REGIONS_ON=${W.regionsOn ? 1 : 0}`);
  const summary = { paths: {} };
  const pathHit = (k) => { summary.paths[k] = (summary.paths[k] || 0) + 1; };

  // 3a. 每位可登入的同仁＋admin 的 ident
  const viewers = W.people.filter((p) => p.status === 'active' && ['pending', 'unclaimed'].indexOf(p.status) === -1);
  const idents = {};
  viewers.concat([null]).forEach((p) => {
    const sub = p ? p.emp : 'U:a001';
    const got = app.ident(sub);
    idents[sub] = got;
    const exp = O.identExpect(p, !p);
    const label = sub + (p ? `（${p.unit}/${p.title}${p.dept ? '/' + p.dept : ''}${exp.flags.attExtra ? ' +extra' : ''}${exp.hrHead ? ' HR' : ''}）` : '（admin）');
    if (!got.active) {
      // 身分無效的人 ident 仍 active（只要 staff active 且帳號在）；這裡只有 user 停用才 inactive
      ok(false, `${label} ident 應為 active`, got);
      return;
    }
    const gH = got.att.people.map((x) => x.clock + '|' + x.emp_id).sort();
    const gR = got.att.req_people.map((x) => x.clock + '|' + x.emp_id).sort();
    const gV = got.att.view_people.map((x) => x.clock + '|' + x.emp_id).sort();
    const extraH = gH.filter((k) => exp.H.indexOf(k) === -1), missH = exp.H.filter((k) => gH.indexOf(k) === -1);
    const extraR = gR.filter((k) => exp.R.indexOf(k) === -1), missR = exp.R.filter((k) => gR.indexOf(k) === -1);
    const extraV = gV.filter((k) => exp.V.indexOf(k) === -1), missV = exp.V.filter((k) => gV.indexOf(k) === -1);
    ok(!extraH.length, `${label} 核定工時：看到不該看的人`, { extra: extraH });
    ok(!missH.length, `${label} 核定工時：漏了該核的人`, { miss: missH });
    ok(!extraR.length, `${label} 申請審核：看到不該看的人`, { extra: extraR });
    ok(!missR.length, `${label} 申請審核：漏了該核的人`, { miss: missR });
    ok(!extraV.length, `${label} 只看：看到不該看的人`, { extra: extraV });
    ok(!missV.length, `${label} 只看：漏了`, { miss: missV });
    ok(eq(got.units_managed, exp.managed), `${label} units_managed`, { got: got.units_managed, exp: exp.managed });
    ok(eq(got.self, exp.self), `${label} self（總部排班身分）`, { got: got.self, exp: exp.self });
    ok(got.hr_head === exp.hrHead, `${label} hr_head`);
    // 形狀：三份名單每筆都有 clock/emp_id/sub/name；支援帳號多 support/home_unit
    ['people', 'req_people', 'view_people'].forEach((k) => {
      got.att[k].forEach((row) => {
        ok(typeof row.clock === 'string' && typeof row.emp_id === 'string' && /^DZY\d{3,}$/.test(row.sub) && typeof row.name === 'string', `${label} ${k} 形狀`, row);
        if (row.support) ok(typeof row.home_unit === 'string' && row.home_unit !== '' && typeof row.home_unit_name === 'string', `${label} ${k} 支援帳號要帶 home_unit`, row);
      });
    });
    // 不可核自己的申請；工時只有 sm/fm 核自己
    if (p) {
      ok(!got.att.req_people.some((x) => x.sub === p.emp), `${label} 申請名單不含自己`);
      if (['sm', 'fm'].indexOf(p.title) === -1) ok(!got.att.people.some((x) => x.sub === p.emp), `${label} 非店長／廠長：工時名單不含自己`);
      ok(!got.att.view_people.some((x) => x.sub === p.emp), `${label} 只看名單不含自己`);
    }
    // 統計覆蓋到的路徑
    if (exp.flags.attExtra) pathHit('att.extra'); if (exp.hrHead) pathHit('hr_head'); if (exp.viewUnits.length) pathHit('view_units'); if (exp.exV.length) pathHit('att.view@');
    if (O.actingOf(p || {}).length) pathHit('acting'); if (p && O.dutyOf(p).length) pathHit('duty_mgr');
    if (got.att.people.some((x) => x.support)) pathHit('support_in_people');
    if (got.att.view_people.length) pathHit('view_people_nonempty');
  });

  // 3b. 沒人能核：每個在試點、要考勤的帳號，至少要有一位非 admin／非人資主管的人能核工時或申請（否則列出）
  const allH = new Set(), allR = new Set();
  viewers.forEach((p) => { const g = idents[p.emp]; if (!g || !g.active) return; if (!g.admin && !g.hr_head) { g.att.people.forEach((x) => allH.add(x.clock + '|' + x.emp_id)); g.att.req_people.forEach((x) => allR.add(x.clock + '|' + x.emp_id)); } });
  const adminI = idents['U:a001'];
  const noApproverH = adminI.att.people.filter((x) => !allH.has(x.clock + '|' + x.emp_id));
  const noApproverR = adminI.att.req_people.filter((x) => !allR.has(x.clock + '|' + x.emp_id));
  summary.noApproverH = noApproverH.map((x) => x.clock + ':' + x.sub);
  summary.noApproverR = noApproverR.map((x) => x.clock + ':' + x.sub);
  // 這些「只剩 admin／人資」的帳號：照規格哪些算合理（hr_only 部門、orphan、店裡真的沒主管鏈）？把不合理的挑出來
  const byEmp = {}; W.people.forEach((p) => { byEmp[p.emp] = p; });
  const unreasonable = [];
  noApproverH.forEach((x) => {
    const p = byEmp[x.sub]; const t = O.eff(p);
    const nd = t && !t.orphan ? O.need(t, 'hours') : null;
    if (!t || t.orphan || t.inferred || !nd || nd.kind === 'hr_only' || nd.kind === 'mgmt') return;   // 推算的人照舊只給推算店店長（att-support §1：不套支援規則）
    // 品牌辦公室／總部同仁到門市打卡不算支援（att-support §5）：工時照原身分由辦公室總監／部門總監核，店長不核 → 辦公室沒總監時只剩人資，是規格、不是漏洞
    const tu = unitOf(W, t.unit);
    if (tu && tu.ladder !== 'store') return;
    // 門市人：店裡有在職店長／廠長或兼任者卻沒人核 → 不合理
    const store = x.clock; const units = O.storeUnits[store] || [];
    // 非支援帳號：只有「本人單位」的在職店長／廠長（身分有效）或兼任本單位的人；支援帳號：打卡店任一單位的店長／兼任者
    const support = units.length && units.indexOf(t.unit) === -1;
    const headUnits = support ? units : [t.unit];
    const heads = W.people.filter((q) => q.status === 'active' && q.emp !== x.sub && identityOk(W, q) && ((['sm', 'fm'].indexOf(q.title) !== -1 && headUnits.indexOf(q.unit) !== -1) || inter(O.actingOf(q), headUnits)));
    if (heads.length && byEmp[heads[0].emp] && W.people.some((q) => q.emp === heads[0].emp && q.status === 'active') && viewers.some((v) => v.emp === heads[0].emp)) unreasonable.push({ acct: x.clock + ':' + x.sub, heads: heads.map((h) => h.emp) });
  });
  ok(!unreasonable.length, '沒人能核：店裡有在職店長／兼任者卻只剩 admin／人資能核工時', unreasonable);

  // 3c. 登入衍生權限
  viewers.forEach((p) => {
    const d = app.login(p.emp);
    ok(!!d, `${p.emp} 可登入`);
    if (!d) return;
    const g = O.gates(p);
    const has = (c) => d.perms.indexOf(c) !== -1;
    ok(has('platform.att') === g.att, `${p.emp}（${p.unit}/${p.title}${p.dept ? '/' + p.dept : ''}）platform.att`, { got: has('platform.att'), exp: g.att, perms: d.perms });
    ok(has('platform.sched') === g.sched, `${p.emp}（${p.unit}/${p.title}）platform.sched`, { got: has('platform.sched'), exp: g.sched });
    ok(has('platform.storeops') === g.storeops, `${p.emp}（${p.unit}/${p.title}）platform.storeops`, { got: has('platform.storeops'), exp: g.storeops });
    // 排班閘門與 ident 一致：有 platform.sched 的總部同仁一定有 self 對照或是能排班的人
    const id = idents[p.emp];
    if (has('platform.sched') && id && id.active && GATE_SCHED.indexOf(p.title) === -1 && !id.hr_head && !id.units_managed.length && !id.att.view_people.length) {
      ok(id.self.length > 0, `${p.emp} 有排班管理選單但 ident 沒有 self／units_managed／view_people（營運系統沒有入口）`, id);
    }
    // 財務部總監：不因職稱拿到考勤
    if (p.title === 'hm' && p.dept === 'fin' && !g.att) pathHit('fin_head_no_att');
  });

  // 3d. attUpperGaps（人資主管／admin 才有內容；其他人回空）
  const gapsAdmin = post(sb, 'attUpperGaps', {}, app.adminTok);
  ok(gapsAdmin.ok && Array.isArray(gapsAdmin.data.items), 'attUpperGaps admin 回 items');
  const gotGaps = gapsAdmin.data.items.map((x) => x.emp).sort();
  const expGaps = O.upperGaps();
  ok(eq(gotGaps, expGaps), 'attUpperGaps：找不到上層的值班主管名單', { got: gotGaps, exp: expGaps });
  gapsAdmin.data.items.forEach((x) => ok(typeof x.unit_name === 'string' && typeof x.name === 'string', 'attUpperGaps 列形狀', x));
  const hrHead = viewers.find((p) => O.hrHeadOf(p));
  if (hrHead) {
    const g2 = post(sb, 'attUpperGaps', {}, app.login(hrHead.emp).token);
    ok(g2.ok && eq(g2.data.items.map((x) => x.emp).sort(), expGaps), 'attUpperGaps 人資主管同 admin');
    pathHit('gaps_hr');
  }
  const nonHr = viewers.find((p) => !O.hrHeadOf(p) && O.gates(p).att);
  if (nonHr) {
    const g3 = post(sb, 'attUpperGaps', {}, app.login(nonHr.emp).token);
    ok(g3.ok && g3.data.items.length === 0 && !g3.data.unmapped, `attUpperGaps 非人資（${nonHr.emp}）回空`, g3);
  }
  if (expGaps.length) pathHit('upper_gap_nonempty');

  // 3e. 薪酬 scope：proxyWithOperator_（代轉 payroll）；payrollStaffRoster 的 scope_forbidden；誰能設 payroll.store@／att.view@／store.sm@
  viewers.forEach((p) => {
    const d = app.login(p.emp);
    if (!d) return;
    const res = sb.proxyWithOperator_({ ok: true }, 'payroll', { name: p.name, username: p.emp }, d.perms);
    const codes = uniqSorted(O.permsOf(p).filter((c) => c.indexOf('payroll.store@') === 0).map((c) => c.slice(14)));
    ok(eq(res.scope, codes), `${p.emp} payroll scope`, { got: res.scope, exp: codes });
    ok(res.operator.indexOf(p.emp) !== -1 && res.operator.indexOf('（管理系統）') !== -1, `${p.emp} payroll operator 由平台決定`);
    const other = sb.proxyWithOperator_({ ok: true }, 'audit', { name: p.name, username: p.emp }, d.perms);
    ok(other.scope === undefined, `${p.emp} 其他 ns 不帶 scope`);
    if (codes.length) {
      pathHit('payroll_scope');
      // payrollStaffRoster：清單內放行（不是 not_ready 以外的 forbidden）、清單外 scope_forbidden；沒有 payroll.write → FORBIDDEN
      const inS = post(sb, 'payrollStaffRoster', { store: codes[0] }, d.token);
      const outS = post(sb, 'payrollStaffRoster', { store: 'ZZ99' }, d.token);
      const hasWrite = d.perms.indexOf('payroll.write') !== -1 || d.perms.indexOf('*') !== -1;
      if (!hasWrite) { ok(!inS.ok && inS.code === 'FORBIDDEN' && inS.error !== 'scope_forbidden', `${p.emp} 沒有 payroll.write：差異清單先擋權限`, inS); }
      else { ok(!outS.ok && outS.error === 'scope_forbidden', `${p.emp} 差異清單：負責範圍外門市 scope_forbidden`, outS); ok(inS.ok || inS.error !== 'scope_forbidden', `${p.emp} 差異清單：負責門市放行`, inS); }
    }
  });
  const adminScope = sb.proxyWithOperator_({ ok: true }, 'payroll', { name: 'BOSS', username: 'BOSS' }, ['*']);
  ok(adminScope.scope === '*', 'admin payroll scope=*');
  // 誰能設：人資主管只能 STORE_HR_GRANTABLE＋store.sm@；admin 全部
  const target = viewers.find((p) => hrHead && p.emp !== hrHead.emp && identityOk(W, p) && p.unit !== 'ck');
  if (hrHead && target) {
    const ht = app.login(hrHead.emp).token;
    const stCode = W.clockStores[0].pay;
    const r1 = post(sb, 'permExSave', { emp_no: target.emp, perm: 'payroll.store@' + stCode, mode: 'add', until: '', note: '測試' }, ht);
    ok(!r1.ok && r1.code === 'no_perm', '人資主管不能設 payroll.store@', r1);
    const r2 = post(sb, 'permExSave', { emp_no: target.emp, perm: 'att.view@ck', mode: 'add', until: '', note: '測試' }, ht);
    ok(!r2.ok && r2.code === 'no_perm', '人資主管不能設 att.view@', r2);
    const r3 = post(sb, 'permExSave', { emp_no: target.emp, perm: 'payroll.store@' + stCode, mode: 'add', until: '', note: '測試' }, app.adminTok);
    ok(r3.ok, 'admin 能設 payroll.store@', r3);
    const r4 = post(sb, 'permExSave', { emp_no: target.emp, perm: 'payroll.store@' + stCode, mode: 'remove', until: '', note: '測試' }, app.adminTok);
    ok(!r4.ok && r4.code === 'bad_mode', 'payroll.store@ 只能多給', r4);
    const r5 = post(sb, 'permExSave', { emp_no: target.emp, perm: 'payroll.store@bad-code', mode: 'add', until: '', note: '測試' }, app.adminTok);
    ok(!r5.ok, 'payroll.store@ 小寫／連字號代碼不收', r5);
    sb.permActingReset_();
    const after = app.login(target.emp);
    const sc = sb.proxyWithOperator_({ ok: true }, 'payroll', { name: target.name, username: target.emp }, after.perms).scope;
    ok(Array.isArray(sc) && sc.indexOf(stCode) !== -1, 'admin 設完後 scope 立刻含該店', { sc, perms: after.perms });
    // att.view@：admin 設給 target 後，target 的 view_people 含該店全部帳號（打卡店單位＝該單位、在試點、需核工時、非本人）
    const ckInPilot = W.pilot.indexOf('ck') !== -1;
    const r6 = post(sb, 'permExSave', { emp_no: target.emp, perm: 'att.view@ck', mode: 'add', until: '', note: '測試' }, app.adminTok);
    ok(r6.ok, 'admin 能設 att.view@ck', r6);
    sb.permActingReset_();
    const id2 = app.ident(target.emp);
    const cfAccts = W.accounts.filter((a) => a.store === 'cf' && a.state === 'confirmed' && a.roster !== 'FALSE' && a.emp !== target.emp).filter((a) => { const t = O.eff(byEmp[a.emp]); return t && !t.orphan && O.need(t, 'hours'); }).map((a) => 'cf|' + a.eid).sort();
    const seenCf = uniqSorted(id2.att.people.concat(id2.att.view_people).filter((x) => x.clock === 'cf').map((x) => x.clock + '|' + x.emp_id));
    if (ckInPilot && !id2.admin && !id2.hr_head) ok(eq(seenCf, cfAccts), 'att.view@ck：央廚全部要核工時的帳號都看得到（people∪view）', { got: seenCf, exp: cfAccts });
    else if (!ckInPilot) ok(!id2.att.view_people.some((x) => x.clock === 'cf' && !id2.att.people.some((y) => y.emp_id === x.emp_id)), 'att.view@ck：央廚不在試點 → 不多看');
    ok(app.login(target.emp).perms.indexOf('platform.att') !== -1 || !ckInPilot === false || true, 'att.view@ 給了考勤管理入口');
    if (identityOk(W, target)) ok(app.login(target.emp).perms.indexOf('platform.att') !== -1, 'att.view@ck 後 target 有 platform.att');
  }

  // 3f. 不照程式結構、直接從規格句子寫的不變量（抓「看到不該看的人」）
  const unitLadder = (c) => { const u = unitOf(W, c); return u ? u.ladder : ''; };
  viewers.forEach((p) => {
    const g = idents[p.emp];
    if (!g || !g.active || g.admin || g.hr_head) return;
    const perms = O.permsOf(p);
    const plainSm = ['sm', 'fm'].indexOf(p.title) !== -1 && !O.actingOf(p).length && perms.indexOf('att.extra') === -1 && !perms.some((c) => c.indexOf('att.view@') === 0);
    if (plainSm && identityOk(W, p)) {
      // 店長只核：本店人的非支援帳號、或打卡店單位含本店的支援帳號
      g.att.people.concat(g.att.req_people).forEach((x) => {
        const units = O.storeUnits[x.clock] || [];
        const owner = byEmp[x.sub];
        const okRow = (owner && owner.unit === p.unit) || units.indexOf(p.unit) !== -1 || (O.eff(owner) && O.eff(owner).inferred && O.eff(owner).unit === p.unit);
        ok(okRow, `${p.emp}（店長 ${p.unit}）核到別店的帳號 ${x.clock}:${x.sub}`, x);
        // 品牌辦公室／總部同仁到本店打卡：工時可核（總部）／不可核（辦公室）；申請一律不是店長核
        if (owner && unitLadder(owner.unit) === 'office') ok(false, `${p.emp}（店長）核到品牌辦公室同仁 ${x.sub} 的帳號（att-support §5：店長不核也不看）`, x);
      });
      g.att.req_people.forEach((x) => { const owner = byEmp[x.sub]; if (owner && unitLadder(owner.unit) === 'hq') ok(false, `${p.emp}（店長）核到總部同仁 ${x.sub} 的申請（應照原身分簽）`, x); });
      g.att.view_people.forEach((x) => { const owner = byEmp[x.sub]; if (owner && unitLadder(owner.unit) === 'office') ok(false, `${p.emp}（店長）看到品牌辦公室同仁 ${x.sub}`, x); });
    }
    // 財務部同仁只有人資主管／admin／同單位 att.extra 能核
    g.att.people.concat(g.att.req_people).forEach((x) => {
      const owner = byEmp[x.sub];
      if (owner && owner.unit === 'dzy-hq' && owner.title === 'hs' && owner.dept === 'fin') {
        const viaExtra = perms.indexOf('att.extra') !== -1 && p.unit === 'dzy-hq';
        const viaStore = x.clock !== 'hq' && g.att.people.some((y) => y.clock === x.clock && y.emp_id === x.emp_id) && !g.att.req_people.some((y) => y.clock === x.clock && y.emp_id === x.emp_id);
        ok(viaExtra || viaStore, `${p.emp} 核到財務部同仁 ${x.sub}（${x.clock}）：只有人資主管／att.extra／支援店工時才可以`, x);
      }
    });
    // 值班主管本人的申請：同店也是值班主管的人不核
    g.att.req_people.forEach((x) => {
      const owner = byEmp[x.sub];
      if (!owner || !O.dutyOf(owner).length) return;
      const units = O.storeUnits[x.clock] || [];
      const myDuty = O.dutyOf(p);
      if (inter(myDuty, [owner.unit]) || inter(myDuty, units)) ok(false, `${p.emp}（同店值班主管）核到值班主管 ${x.sub} 的申請（req-upper）`, { x, myDuty });
    });
    // 督導只看：view_people 裡的門市帳號只能在自己負責區（REGIONS_ON）或 att.view@ 指定店、或原單位主管的支援帳號
    if (p.title === 'osv' && W.regionsOn) {
      const myUnits = O.identExpect(p, false).viewUnits;
      const exV = O.identExpect(p, false).exV;
      g.att.view_people.forEach((x) => {
        const units = O.storeUnits[x.clock] || [];
        const owner = byEmp[x.sub];
        const okRow = inter(units, myUnits) || inter(units, exV) || (owner && myUnits.indexOf(owner.unit) !== -1) || (owner && O.approver(p, Object.assign({}, owner, { duty_units: O.dutyOf(owner) }), 'req'))
          || (owner && O.actingOf(p).indexOf(owner.unit) !== -1);   // 兼任店長＝原單位主管：對支援帳號只看
        ok(okRow, `${p.emp}（督導）看到非負責區的帳號 ${x.clock}:${x.sub}`, { x, myUnits });
      });
    }
    // 沒有 platform.att 的人：三份名單都要空（不然營運系統有資料、管理系統卻沒入口）
    const d = app.login(p.emp);
    if (d && d.perms.indexOf('platform.att') === -1 && d.perms.indexOf('*') === -1) {
      ok(!g.att.people.length && !g.att.req_people.length && !g.att.view_people.length, `${p.emp}（${p.unit}/${p.title}）沒有考勤管理選單但 ident 有名單`, g.att);
    }
  });

  // 3g. 資訊（不算失敗）：有考勤／排班選單、但 ident 三份名單與 units_managed／self 都空的人（選單點進去沒東西）
  //     目前規格就是「職稱在名單上就給選單」（storeAttGate_／storeSchedGate_ 只看 STORE_SSO_UNITS 非空，不看本人單位在不在試點；storeOpsGate_ 有看）
  const emptyMenu = [];
  viewers.forEach((p) => {
    const d = app.login(p.emp); const g = idents[p.emp];
    if (!d || !g || !g.active || g.admin || g.hr_head) return;
    const listsEmpty = !g.att.people.length && !g.att.req_people.length && !g.att.view_people.length;
    if (d.perms.indexOf('platform.att') !== -1 && listsEmpty) emptyMenu.push(`att:${p.emp}(${p.unit}/${p.title}${W.pilot.indexOf(p.unit) === -1 ? ',非試點' : ''})`);
    if (d.perms.indexOf('platform.sched') !== -1 && !g.units_managed.length && !g.self.length && !g.att.view_people.length) emptyMenu.push(`sched:${p.emp}(${p.unit}/${p.title}${W.pilot.indexOf(p.unit) === -1 ? ',非試點' : ''})`);
  });
  console.log('資訊｜有選單但內容全空：' + J(emptyMenu));

  console.log('覆蓋路徑：' + J(summary.paths));
  console.log('只剩 admin／人資能核工時的帳號：' + J(summary.noApproverH) + '；申請：' + J(summary.noApproverR));
  return W;
}

const W = run();
console.log(`\n結果：${passed + failed} 項檢查／通過 ${passed}／失敗 ${failed}（SEED=${SEED}）`);
if (failed) {
  fs.mkdirSync(path.join(__dirname, 'artifacts', 'hr2'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'artifacts', 'hr2', `world-${SEED}.json`), JSON.stringify(W, null, 1));
  console.error('世界已存：test/dd/artifacts/hr2/world-' + SEED + '.json');
  process.exit(1);
}
