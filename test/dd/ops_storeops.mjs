// test/dd/ops_storeops.mjs —— 資料帶入測試：門市營運 ↔ 管理系統（StoreOps.gs：ident／三個閘門／名冊／入場券）
//
// 每次執行全部隨機重抽：試點門市（含空＝總開關關）、每店人數與職稱分布（店長／區經理／正職／計時；央廚廠長／廚藝總監）、
// 品牌辦公室（總監／督導／行政）、總部各部門（人資／財務／營運／管理部／執行長以上）、帳號狀態（在職／未認領／待審／退回／停用）、
// 到職日、打卡對照（有無、roster_active）。
// 預期值由本檔照 StoreOps.gs 檔頭與 docs/att-support/spec.md 的「誰核誰」規則表自己算（oracle；不呼叫系統的純函式），逐欄比對：
//   svcStoreWho／svcStoreRedeem 的 ident（active、units_managed、void_units、pilot_units、epoch、self、att.people／req_people／view_people）、
//   登入拿到的衍生權限 platform.storeops／platform.att／platform.sched、svcStoreRoster、停用／未開通者 inactive、總開關關全部收回。
// 刻意不碰：區域（REGIONS_ON）、兼任店長、值班主管、att.extra、支援打卡（打卡店 ≠ 本單位）——那些規則已有 test/storeops.mock.test.mjs 逐條驗。
// 用法：node test/dd/ops_storeops.mjs　　重現：E2E_SEED=<種子> node test/dd/ops_storeops.mjs
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'StaffClock.gs', 'Perms.gs', 'PermActions.gs', 'StoreOps.gs', 'Code.gs']
  .map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

// ── 種子與亂數 ──
const SEED = Number(process.env.E2E_SEED) || (Math.floor(Math.random() * 1e9) + 1);
console.log('E2E_SEED=' + SEED);
let _s = SEED >>> 0;
function rnd() { _s = (_s + 0x6D2B79F5) >>> 0; let t = _s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

let passed = 0, failed = 0; const fails = [];
function ok(cond, label, extra) { if (cond) passed++; else { failed++; fails.push(label); console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra).slice(0, 700) : '')); } }
const J = (v) => JSON.stringify(v);
const eq = (a, b) => J(a) === J(b);
const sortU = (a) => [...new Set(a)].sort();

// ── GAS 假物件（抄 test/storeops.mock.test.mjs，共用工具複製一份）──
function makeSheet(rows) {
  const data = (rows || []).map((r) => r.slice());
  const sheet = {
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(row, col, numRows, numCols) {
      numRows = numRows || 1; numCols = numCols || 1;
      const range = {
        getValues() { const out = []; for (let r = 0; r < numRows; r++) { const src = data[row - 1 + r] || []; const o = []; for (let c = 0; c < numCols; c++) { const v = src[col - 1 + c]; o.push(v === undefined ? '' : v); } out.push(o); } return out; },
        setValue(v) { range.setValues([[v]]); },
        setValues(vals) { for (let r = 0; r < vals.length; r++) { const ri2 = row - 1 + r; while (data.length <= ri2) data.push([]); for (let c = 0; c < vals[r].length; c++) { const ci = col - 1 + c; while (data[ri2].length <= ci) data[ri2].push(''); data[ri2][ci] = vals[r][c]; } } return range; },
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
const bytes = (v) => Buffer.isBuffer(v) ? v : (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => (b < 0 ? b + 256 : b) & 0xff)));
const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
function load(seed) {
  const sheets = {}; Object.keys(seed).forEach((k) => { sheets[k] = makeSheet(seed[k]); });
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; } };
  const cache = new Map(); const props = { HMAC_SECRET: 'fake-hmac-dd-ops' }; let uuid = 0; let held = false;
  const sandbox = {
    console, SpreadsheetApp: { getActive: () => ss },
    Utilities: { DigestAlgorithm: { SHA_256: 'SHA_256' }, computeDigest: (_a, v) => signed(crypto.createHash('sha256').update(bytes(v)).digest()), computeHmacSha256Signature: (v, k) => signed(crypto.createHmac('sha256', bytes(k)).update(bytes(v)).digest()), base64Encode: (d) => bytes(d).toString('base64'), base64Decode: (s) => signed(Buffer.from(String(s), 'base64')), getUuid: () => 'fake-uuid-' + (++uuid) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => { const e = cache.get(k); return e && !(e.exp && Date.now() > e.exp) ? e.v : null; }, put: (k, v, ttl) => cache.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null }), remove: (k) => cache.delete(k) }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (held) return false; held = true; return true; }, releaseLock() { held = false; } }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  return { sb: sandbox, sheets, cache, props };
}
const post = (sb, action, payload, token) => JSON.parse(sb.doPost({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }).getContent());

// ── 組織（照 Staff.gs STF_DEFAULT_ORG 種子；只讀資料）──
const UNITS = {
  'mzt-js': { brand: 'mzt', ladder: 'store' }, 'mzt-gf': { brand: 'mzt', ladder: 'store' }, 'mzt-lzl': { brand: 'mzt', ladder: 'store' },
  'mala-gf': { brand: 'mala', ladder: 'store' }, 'yiwu-js': { brand: 'yiwu', ladder: 'store' }, 'yiwu-wx': { brand: 'yiwu', ladder: 'store' }, ck: { brand: 'ck', ladder: 'store' },
  'mzt-hq': { brand: 'mzt', ladder: 'office' }, 'mala-hq': { brand: 'mala', ladder: 'office' }, 'yiwu-hq': { brand: 'yiwu', ladder: 'office' }, 'dzy-hq': { brand: 'dzy', ladder: 'hq' }
};
const CLOCK = { 'mala-gf': 'gf', 'mzt-js': 'mztjs', 'mzt-gf': 'mztgf', 'mzt-lzl': 'mztlzl', ck: 'cf', 'dzy-hq': 'hq', 'mzt-hq': 'hq', 'mala-hq': 'hq', 'yiwu-hq': 'hq' };   // yiwu 門市沒有打卡店
const CLOCK_UNITS = { gf: ['mala-gf'], mztjs: ['mzt-js'], mztgf: ['mzt-gf'], mztlzl: ['mzt-lzl'], mztmc: ['mzt-mc'], hq: ['dzy-hq', 'mzt-hq', 'mala-hq', 'yiwu-hq'], cf: ['ck'] };
const TITLES = { pt: 'store', ft: 'store', sm: 'store', am: 'store', fm: 'store', rdd: 'store', ofs: 'office', osv: 'office', odir: 'office', hs: 'hq', hm: 'hq', ceo: 'hq', gm: 'hq', chair: 'hq' };
const DEPTS = ['fin', 'hr', 'it', 'eng', 'franchise', 'purchase', 'ops', 'training', 'marketing', 'mgmt', 'branddev'];
const NO_ATT = ['odir', 'hm', 'ceo', 'gm', 'chair'];
const LIST_STATUSES = ['active', 'unclaimed', 'pending', 'rejected'];
const STORE_UNITS = Object.keys(UNITS).filter((u) => UNITS[u].ladder === 'store');

// ── 隨機人員 ──
const cast = [];   // {emp, name, unit, dept, title, status, hire, clock:{store, eid, active}|null}
let n = 0;
function person(unit, title, dept, statusPool) {
  n++;
  const emp = 'DZY' + String(n).padStart(3, '0');
  const status = pick(statusPool || ['active', 'active', 'active', 'active', 'unclaimed', 'pending', 'rejected', 'disabled']);
  const hire = `2026-${String(ri(1, 9)).padStart(2, '0')}-${String(ri(1, 28)).padStart(2, '0')}`;
  const cs = CLOCK[unit];
  const clock = cs && chance(0.9) ? { store: cs, eid: cs.toUpperCase() + String(n).padStart(2, '0'), active: !chance(0.07) } : null;
  const p = { emp, name: '假' + title + n, unit, dept: dept || '', title, status, hire, clock };
  cast.push(p);
  return p;
}
for (const u of STORE_UNITS) {
  if (u === 'ck') { if (chance(0.7)) person(u, 'fm'); if (chance(0.5)) person(u, 'rdd'); }
  else { if (chance(0.7)) person(u, 'sm'); if (chance(0.4)) person(u, 'am'); if (chance(0.15)) person(u, 'sm'); }
  for (let i = 0; i < ri(0, 2); i++) person(u, 'ft');
  for (let i = 0; i < ri(0, 3); i++) person(u, 'pt');
}
for (const o of ['mzt-hq', 'mala-hq', 'yiwu-hq']) {
  if (chance(0.7)) person(o, 'odir');
  for (let i = 0; i < ri(0, 2); i++) person(o, 'osv');
  if (chance(0.4)) person(o, 'ofs');
}
if (chance(0.8)) person('dzy-hq', 'hm', 'hr', ['active', 'active', 'active', 'disabled']);
for (let i = 0; i < ri(0, 2); i++) person('dzy-hq', 'hs', 'hr');
if (chance(0.6)) person('dzy-hq', 'hm', 'fin');
for (let i = 0; i < ri(0, 2); i++) person('dzy-hq', 'hs', 'fin');
for (let i = 0; i < ri(0, 2); i++) person('dzy-hq', 'hs', 'ops');
if (chance(0.5)) person('dzy-hq', 'hm', 'ops');
for (let i = 0; i < ri(0, 2); i++) person('dzy-hq', 'hs', pick(DEPTS));
if (chance(0.6)) person('dzy-hq', 'hs', 'mgmt');
for (const t of ['ceo', 'gm', 'chair']) if (chance(0.5)) person('dzy-hq', t, 'mgmt');
// 保底：至少一位在職店長、一位在職計時、一位高層
if (!cast.some((p) => p.title === 'sm' && p.status === 'active')) person('mzt-gf', 'sm', '', ['active']);
if (!cast.some((p) => p.title === 'pt' && p.status === 'active')) person('mzt-gf', 'pt', '', ['active']);
if (!cast.some((p) => ['ceo', 'gm', 'chair'].includes(p.title) && p.status === 'active')) person('dzy-hq', 'ceo', 'mgmt', ['active']);

// 試點：隨機子集（有時空）
const PILOT_POOL = [...STORE_UNITS, 'dzy-hq', 'mzt-hq', 'mala-hq', 'yiwu-hq'];
const pilot = chance(0.1) ? [] : sortU(PILOT_POOL.filter(() => chance(0.6)));
if (!pilot.length && chance(0.5)) pilot.push('mzt-gf');
console.log(`人員 ${cast.length} 位（在職 ${cast.filter((p) => p.status === 'active').length}）；試點 [${pilot.join(',')}]`);
console.log('職稱分布 ' + Object.entries(cast.reduce((m, p) => { m[p.title] = (m[p.title] || 0) + 1; return m; }, {})).map(([k, v]) => k + '×' + v).join(' '));

// ── 建世界 ──
const PW = 'fake-dd-pw-01', SALT = 'salt-dd', SVC = 'fake-store-svc-key-dd';
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
const USERS_HEAD = ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at', 'token_after'];
const hasUser = (p) => p.status === 'active' || p.status === 'disabled';
const users = [USERS_HEAD, ['a001', 'BOSS', '系統管理者', 'admin', '', SALT, HASHER.hashPassword_(PW, SALT), 'TRUE', '', '', '']]
  .concat(cast.filter(hasUser).map((p) => ['u' + p.emp.slice(3), p.emp, p.name, 'staff', '', SALT, HASHER.hashPassword_(PW, SALT), p.status === 'disabled' ? 'FALSE' : 'TRUE', '', '', '']));
const app = load({ users, roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['staff', '員工', '']], module_secrets: [['backend_id', 'level', 'secret']], login_log: [['at', 'username', 'ip_hash', 'result']] });
const { sb } = app;
sb.setupStaff();
cast.forEach((p, i) => {
  const row = new Array(27).fill('');
  row[0] = p.emp; row[1] = hasUser(p) ? 'u' + p.emp.slice(3) : ''; row[2] = p.name; row[3] = p.status;
  row[4] = UNITS[p.unit].brand; row[5] = p.unit; row[6] = p.dept; row[7] = p.title;
  row[19] = '2026-02-0' + ((i % 8) + 1) + ' 10:00:00'; row[24] = p.hire;
  app.sheets.staff._data.push(row);
  if (p.clock) app.sheets.staff_clock._data.push([p.emp, p.clock.store, p.clock.eid, 'home', 'confirmed', 'created', p.clock.active ? 'TRUE' : 'FALSE', '', 'tester', '', '']);
});
app.props.STORE_SVC_KEY = SVC;
app.props.STORE_SSO_UNITS = pilot.join(',');
const adminTok = post(sb, 'login', { username: 'BOSS', password: PW }).data.token;
ok(post(sb, 'permInit', {}, adminTok).ok, '0 permInit（預設規則：店長／區經理／廠長／廚藝總監 store.void）');
const who = (sub) => post(sb, 'svcStoreWho', { svc_key: SVC, sub });
const login = (p) => post(sb, 'login', { username: p.emp, password: PW });

// ============================================================
// oracle
// ============================================================
function validOrg(p) {
  const u = UNITS[p.unit]; const tl = TITLES[p.title];
  if (!u || !tl || tl !== u.ladder) return false;
  if (p.unit === 'ck' && !['pt', 'ft', 'fm', 'rdd'].includes(p.title)) return false;
  if ((p.title === 'fm' || p.title === 'rdd') && p.unit !== 'ck') return false;
  return true;
}
function need(t, mode) {
  if (!validOrg(t) || NO_ATT.includes(t.title)) return null;
  const u = UNITS[t.unit];
  if (u.ladder === 'store') {
    if (!['pt', 'ft', 'sm', 'am', 'fm', 'rdd'].includes(t.title)) return null;
    if (mode === 'hours') return { kind: 'unit', unit: t.unit };
    if (t.title === 'pt' || t.title === 'ft') return { kind: 'unit', unit: t.unit };
    if (t.title === 'sm' || t.title === 'fm') return { kind: 'head', unit: t.unit, brand: u.brand };
    if (t.title === 'am') return { kind: 'brand_office', brand: u.brand };
    return { kind: 'hq_exec' };
  }
  if (u.ladder === 'office') return ['ofs', 'osv'].includes(t.title) ? { kind: 'office', unit: t.unit } : null;
  if (t.title !== 'hs' || !DEPTS.includes(t.dept)) return null;
  if (t.dept === 'mgmt') return { kind: 'mgmt' };
  if (t.dept === 'fin') return { kind: 'hr_only' };
  return { kind: 'dept', dept: t.dept };
}
function approves(a, t, mode) {
  if (a.status !== 'active' || !LIST_STATUSES.includes(t.status) || !validOrg(a)) return false;
  const nd = need(t, mode); if (!nd) return false;
  const al = UNITS[a.unit].ladder, ab = UNITS[a.unit].brand;
  const same = a.emp === t.emp;
  if (nd.kind === 'unit') { if (same && mode !== 'hours') return false; return al === 'store' && ['sm', 'fm'].includes(a.title) && a.unit === nd.unit; }
  if (same) return false;
  if (nd.kind === 'head') return (al === 'store' && ['am', 'rdd'].includes(a.title) && a.unit === nd.unit) || (al === 'office' && ab === nd.brand && a.title === 'osv');
  if (nd.kind === 'brand_office') return al === 'office' && ['osv', 'odir'].includes(a.title) && ab === nd.brand;
  if (nd.kind === 'hq_exec') return al === 'hq' && ['ceo', 'gm', 'chair'].includes(a.title);
  if (nd.kind === 'office') return al === 'office' && a.title === 'odir' && a.unit === nd.unit;
  if (nd.kind === 'dept') return al === 'hq' && a.title === 'hm' && a.dept === nd.dept;
  if (nd.kind === 'mgmt') return al === 'hq' && ['ceo', 'gm', 'chair'].includes(a.title);
  return false;
}
const isHrHead = (p) => p.status === 'active' && p.dept === 'hr' && p.title === 'hm';
function targets(me, flags, mode) {
  const out = [];
  for (const t of cast) {
    if (!LIST_STATUSES.includes(t.status) || !need(t, mode)) continue;
    const notSelf = !(me.emp && me.emp === t.emp);
    let okT;
    if (flags.admin || flags.hrHead) okT = notSelf || (mode === 'hours' && ['sm', 'fm'].includes(me.title));
    else okT = approves(me, t, mode);
    if (okT) out.push(t);
  }
  return out;
}
function rows(ts) {
  const out = [];
  for (const t of ts) {
    if (!pilot.includes(t.unit) || !t.clock || !t.clock.active) continue;
    if (!CLOCK_UNITS[t.clock.store].includes(t.unit)) continue;   // 支援帳號不在本測試範圍
    out.push({ clock: t.clock.store, emp_id: t.clock.eid, sub: t.emp, name: t.name });
  }
  return out.sort((a, b) => a.clock !== b.clock ? (a.clock < b.clock ? -1 : 1) : (a.emp_id < b.emp_id ? -1 : a.emp_id > b.emp_id ? 1 : 0));
}
function expectIdent(p) {
  const admin = !p;
  const me = p || { emp: '', title: '', status: 'active' };
  const flags = { admin, hrHead: p ? isHrHead(p) : false };
  const activeStores = (u) => UNITS[u].ladder === 'store';
  let managed = [], voids = [];
  if (admin) { managed = pilot.filter(activeStores); voids = managed.slice(); }
  else if (validOrg(p) && ['sm', 'fm', 'am', 'rdd'].includes(p.title) && pilot.includes(p.unit)) { managed = [p.unit]; voids = [p.unit]; }
  const self = p && p.clock && p.clock.active && p.clock.store === 'hq' ? [{ clock: 'hq', emp_id: p.clock.eid, approval: need(p, 'hours') !== null }] : [];
  return {
    sub: p ? p.emp : 'U:a001', active: true, emp_no: p ? p.emp : '', name: p ? p.name : '系統管理者', admin, hr_head: flags.hrHead,
    unit: p ? p.unit : '', title: p ? p.title : '', epoch: p ? p.hire : '', token_after: 0, pilot_units: pilot,
    units_managed: sortU(managed), void_units: sortU(voids),
    att: pilot.length ? { people: rows(targets(me, flags, 'hours')), req_people: rows(targets(me, flags, 'req')), view_people: [] } : { people: [], req_people: [], view_people: [] },
    self
  };
}
function expectGates(p) {
  if (!pilot.length || p.status !== 'active') return { storeops: false, att: false, sched: false };
  const hr = isHrHead(p);
  const storeops = NO_ATT.includes(p.title) || (pilot.includes(p.unit) && validOrg(p) && UNITS[p.unit].ladder === 'store');
  // 職稱那條（2026-10-29 比照 storeOpsGate_）：身分有效，且門市階梯的人本人單位要在試點；總部／辦公室職稱只看身分有效
  const titleOk = validOrg(p) && (UNITS[p.unit].ladder !== 'store' || pilot.includes(p.unit));
  const att = (['sm', 'fm', 'am', 'rdd', 'osv', 'odir', 'hm', 'ceo', 'gm', 'chair'].includes(p.title) && !(p.title === 'hm' && p.dept === 'fin') && titleOk) || hr;
  const sched = (['sm', 'fm', 'am'].includes(p.title) && titleOk) || hr || (['hq', 'office'].includes(UNITS[p.unit].ladder) && !!(p.clock && p.clock.active && p.clock.store === 'hq'));
  return { storeops, att, sched };
}

// ============================================================
// 1. ident 逐人逐欄
// ============================================================
for (const p of cast) {
  const r = who(p.emp);
  const tag = `${p.emp} ${p.title}@${p.unit}${p.dept ? '/' + p.dept : ''} ${p.status}`;
  if (p.status !== 'active') { ok(r.ok && eq(r.data, { sub: p.emp, active: false }), `1a 非在職 → inactive ${tag}`, r); continue; }
  const want = expectIdent(p);
  ok(r.ok, `1b who 成功 ${tag}`, r);
  if (!r.ok) continue;
  const got = r.data;
  ok(eq(Object.keys(got), Object.keys(want)), `1c 欄位名與順序 ${tag}`, { got: Object.keys(got), want: Object.keys(want) });
  for (const k of ['active', 'emp_no', 'name', 'admin', 'hr_head', 'unit', 'title', 'epoch', 'token_after', 'pilot_units', 'units_managed', 'void_units', 'self']) {
    ok(eq(got[k], want[k]), `1d ${k} ${tag}`, { got: got[k], want: want[k] });
  }
  ok(eq(got.att.people, want.att.people), `1e att.people（核定工時）${tag}：${want.att.people.length} 位`, { got: got.att.people, want: want.att.people });
  ok(eq(got.att.req_people, want.att.req_people), `1f att.req_people（申請）${tag}：${want.att.req_people.length} 位`, { got: got.att.req_people, want: want.att.req_people });
  ok(eq(got.att.view_people, []), `1g view_people 空（沒開區域）${tag}`, got.att.view_people);
}
{
  const r = who('U:a001');
  const want = expectIdent(null);
  ok(r.ok && eq(r.data, want), '1h admin（沒有同仁編號）ident 整份逐欄相同', { got: r.data, want });
  ok(eq(who('DZY999').data, { sub: 'DZY999', active: false }) && who('dzy001').code === 'bad_input' && who('U:').code === 'bad_input', '1i 查無／格式錯');
  ok(post(sb, 'svcStoreWho', { svc_key: 'wrong', sub: 'DZY001' }).code === 'unauthorized', '1j 錯金鑰 → unauthorized');
}

// ============================================================
// 2. 登入衍生權限（三個閘門）
// ============================================================
for (const p of cast.filter(hasUser)) {
  const r = login(p);
  const tag = `${p.emp} ${p.title}@${p.unit}${p.dept ? '/' + p.dept : ''} ${p.status}`;
  if (p.status === 'disabled') { ok(!r.ok, `2a 停用者登入被擋 ${tag}`); continue; }
  ok(r.ok, `2b 登入 ${tag}`, r);
  if (!r.ok) continue;
  const g = expectGates(p);
  const has = (x) => r.data.perms.includes(x);
  ok(has('platform.storeops') === g.storeops, `2c platform.storeops＝${g.storeops} ${tag}`, r.data.perms);
  ok(has('platform.att') === g.att, `2d platform.att＝${g.att} ${tag}`, r.data.perms);
  ok(has('platform.sched') === g.sched, `2e platform.sched＝${g.sched} ${tag}`, r.data.perms);
  const me = post(sb, 'me', {}, r.data.token);
  ok(me.ok && eq(sortU(me.data.perms), sortU(r.data.perms)), `2f me 的 perms＝login ${tag}`);
  // 入場券 → 兌換 → ident 與 who 相同；券只能用一次
  if (g.storeops || g.att || g.sched || chance(0.3)) {
    const tk = post(sb, 'ssoTicket', { aud: 'store' }, r.data.token);
    ok(tk.ok && /^[0-9a-f]{64}$/.test(tk.data.ticket) && tk.data.expires_in === 60, `2g 入場券 ${tag}`, tk);
    const red = post(sb, 'svcStoreRedeem', { svc_key: SVC, aud: 'store', ticket: tk.data.ticket });
    ok(red.ok && eq(red.data, who(p.emp).data), `2h 兌換 ident＝who ${tag}`, red);
    ok(post(sb, 'svcStoreRedeem', { svc_key: SVC, aud: 'store', ticket: tk.data.ticket }).code === 'ticket_invalid', `2i 券第二次失效 ${tag}`);
  }
}
ok(!app.sheets.roles._rows().some((r) => /platform\.(storeops|att|sched)/.test(String(r[2]))), '2j 衍生權限沒寫進 roles');

// ============================================================
// 3. 名冊
// ============================================================
for (const u of [...STORE_UNITS, 'mzt-hq', 'dzy-hq']) {
  const r = post(sb, 'svcStoreRoster', { svc_key: SVC, unit: u });
  const want = cast.filter((p) => p.status === 'active' && p.unit === u).sort((a, b) => a.emp < b.emp ? -1 : 1).map((p) => ({ sub: p.emp, emp_no: p.emp, name: p.name, title: p.title, unit: u, epoch: p.hire }));
  ok(r.ok && eq(r.data.staff, want), `3a roster ${u}：${want.length} 位在職（依編號排序、epoch＝到職日）`, { got: r.data, want });
}
ok(post(sb, 'svcStoreRoster', { svc_key: SVC, unit: 'no such' }).code === 'bad_input' && eq(post(sb, 'svcStoreRoster', { svc_key: SVC, unit: 'nowhere' }).data.staff, []), '3b 名冊：單位格式錯 bad_input、不存在單位空陣列');

// ============================================================
// 4. 總開關關 → 全收回；再開 → 回來
// ============================================================
{
  app.props.STORE_SSO_UNITS = '';
  const act = cast.filter((p) => p.status === 'active');
  const p = pick(act);
  const r = who(p.emp).data;
  ok(r.active === true && eq(r.pilot_units, []) && eq(r.units_managed, []) && eq(r.void_units, []) && eq(r.att, { people: [], req_people: [], view_people: [] }), `4a 開關空：${p.emp} 身分照發、名單與單位全空`, r);
  ok(eq(who('U:a001').data.units_managed, []) && eq(who('U:a001').data.att.people, []), '4b 開關空：admin 也空');
  const lg = login(p);
  ok(lg.ok && !lg.data.perms.some((x) => /platform\.(storeops|att|sched)/.test(x)), `4c 開關空：${p.emp} 三個衍生權限都沒有`, lg.data && lg.data.perms);
  ok(post(sb, 'login', { username: 'BOSS', password: PW }).data.perms.includes('*'), '4d 開關空：admin 仍是 *');
  app.props.STORE_SSO_UNITS = pilot.join(',');
  ok(eq(who(p.emp).data, expectIdent(p)), `4e 開回來：${p.emp} ident 又與 oracle 相同`);
}

console.log(`\n門市營運資料帶入（seed ${SEED}）：${passed} 通過，${failed} 失敗；人員 ${cast.length}、試點 ${pilot.length} 個單位`);
if (failed) { console.error('失敗項目：\n  ' + fails.slice(0, 30).join('\n  ')); process.exit(1); }
