// node test/dd/home_approvals_random.mjs —— 資料帶入測試：表單簽核後端（Approvals.gs＋ApprovalRoute.gs）＋我的資料（單位通訊錄／待審核）
// 每次執行全部重抽：組織人員（假名）、核決權限級距、單據金額（含 5,000／10,000／30,000 邊界與 .5 捨入）、空缺職位、兼任店長。
// 預期值由本檔照 docs/approvals/spec.md §2／§5／§14 獨立算（不 import amount.js／ApprovalRoute.gs 當預期值）。
// 重現：E2E_SEED=<種子> node test/dd/home_approvals_random.mjs
// ⚠ 全部假名、DZY9xx；dzy 是 public repo，不得出現真實同仁資料。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'apps-script', 'platform');
const FILES = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'StaffClock.gs', 'Perms.gs', 'PermActions.gs', 'StoreOps.gs', 'ApprovalRoute.gs', 'Approvals.gs', 'Code.gs'];
const SRC = FILES.map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

// ── 種子與亂數 ──────────────────────────────────────────
const SEED = Number(process.env.E2E_SEED) || (Date.now() % 1000000007);
console.log('SEED=' + SEED + '（重現：E2E_SEED=' + SEED + ' node test/dd/home_approvals_random.mjs）');
let rs = SEED >>> 0;
function rnd() { rs |= 0; rs = (rs + 0x6D2B79F5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

let passed = 0, failed = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; fails.push(label); console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}
const J = (x) => JSON.stringify(x);

// ── GAS 假物件（同 test/apv-actions.mock.test.mjs 的做法） ──
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
const bytes = (v) => (Buffer.isBuffer(v) ? v : typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => (b < 0 ? b + 256 : b) & 0xff)));
const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
function load(seed) {
  const sheets = {};
  Object.keys(seed).forEach((k) => { sheets[k] = makeSheet(seed[k]); });
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; } };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-dd-home' };
  const sandbox = {
    console,
    SpreadsheetApp: { getActive: () => ss },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (_a, v) => signed(crypto.createHash('sha256').update(bytes(v)).digest()),
      computeHmacSha256Signature: (v, k) => signed(crypto.createHmac('sha256', bytes(k)).update(bytes(v)).digest()),
      base64Encode: (d) => bytes(d).toString('base64'),
      base64Decode: (s) => signed(Buffer.from(String(s), 'base64')),
      getUuid: () => crypto.randomUUID()
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => { const e = cache.get(k); if (!e) return null; if (e.exp && Date.now() > e.exp) { cache.delete(k); return null; } return e.v; },
      put: (k, v, ttl) => cache.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null }), remove: (k) => cache.delete(k) }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  return { sb: sandbox, sheets, props };
}

// ── 隨機組織與人員（全部假名） ─────────────────────────────
const SUR = ['測', '試', '假', '虛', '擬', '樣', '範', '例'];
const GIV = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸', '子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
let empSeq = 900;
const usedNames = new Set();
function fakeName() { let n; do { n = pick(SUR) + pick(GIV) + pick(GIV); } while (usedNames.has(n)); usedNames.add(n); return n; }
function person(unit, dept, title, o) {
  o = o || {};
  empSeq++;
  return { emp: 'DZY' + empSeq, name: fakeName(), unit, dept: dept || '', title, status: o.status || 'active', role: o.role || 'staff', userActive: o.userActive !== false, extra: o.extra || '', birthday: `19${ri(70, 99)}-${String(ri(1, 12)).padStart(2, '0')}-${String(ri(1, 28)).padStart(2, '0')}`, phone: '09' + String(ri(10000000, 99999999)), address: '測試市假想路' + ri(1, 999) + '號' };
}

// 用種子 org 的代碼（不是個資）；人員全部隨機
const STORE_UNITS = { mzt: ['mzt-js', 'mzt-gf', 'mzt-lzl'], mala: ['mala-gf'], yiwu: ['yiwu-js', 'yiwu-wx'] };
const OFFICE = { mzt: 'mzt-hq', mala: 'mala-hq', yiwu: 'yiwu-hq' };
const HQ_DEPTS = ['fin', 'hr', 'it', 'eng', 'franchise', 'purchase', 'ops', 'training', 'marketing', 'mgmt', 'branddev'];

function buildPeople() {
  const P = [];
  const vac = {};   // 記下故意留空的職位，給預期值用
  for (const brand of Object.keys(STORE_UNITS)) {
    for (const u of STORE_UNITS[brand]) {
      if (chance(0.7)) P.push(person(u, '', 'sm')); else vac[u + '/sm'] = true;
      if (chance(0.3)) P.push(person(u, '', 'am'));
      P.push(person(u, '', 'ft'));
      P.push(person(u, '', 'pt'));
      if (chance(0.3)) P.push(person(u, '', 'pt', { status: 'unclaimed' }));   // 沒開通：永遠不算候選
    }
    const off = OFFICE[brand];
    if (chance(0.7)) P.push(person(off, '', 'odir')); else vac[off + '/odir'] = true;
    if (chance(0.5)) P.push(person(off, '', 'osv'));
    if (chance(0.5)) P.push(person(off, '', 'ofs'));
  }
  // 中央工廠
  if (chance(0.7)) P.push(person('ck', '', 'fm')); else vac['ck/fm'] = true;
  if (chance(0.6)) P.push(person('ck', '', 'rdd')); else vac['ck/rdd'] = true;
  P.push(person('ck', '', 'ft'));
  // 總部
  for (const d of HQ_DEPTS) {
    if (d !== 'mgmt' && chance(0.7)) P.push(person('dzy-hq', d, 'hm')); else vac['dzy-hq/' + d + '/hm'] = true;
    if (['fin', 'hr', 'purchase'].indexOf(d) !== -1 || chance(0.4)) P.push(person('dzy-hq', d, 'hs', { role: d === 'hr' ? 'hr' : 'staff' }));
  }
  // 人資主管一定要有一位 platform.staff 的人（指派用）
  const hrHm = P.find((p) => p.dept === 'hr' && p.title === 'hm');
  if (hrHm) hrHm.role = 'hr';
  // 高層：各 80%；董事長的 user 可能被停用（opened=false）
  const execDept = pick(HQ_DEPTS);
  if (chance(0.8)) P.push(person('dzy-hq', execDept, 'ceo')); else vac['ceo'] = true;
  if (chance(0.85)) P.push(person('dzy-hq', execDept, 'gm')); else vac['gm'] = true;
  if (chance(0.85)) { const c = person('dzy-hq', execDept, 'chair', { userActive: chance(0.8) }); P.push(c); if (!c.userActive) vac['chair-disabled'] = true; } else vac['chair'] = true;
  // 兼任店長：某品牌辦公室區督導兼任該品牌一家沒有店長的門市（或有店長的也行）
  const osvs = P.filter((p) => p.title === 'osv');
  let acting = null;
  if (osvs.length && chance(0.8)) {
    const a = pick(osvs);
    const brand = Object.keys(OFFICE).find((b) => OFFICE[b] === a.unit);
    const target = pick(STORE_UNITS[brand]);
    acting = { emp: a.emp, unit: target };
  }
  return { P, vac, acting };
}

// ── 隨機核決權限表 ────────────────────────────────────────
const ROLES = ['head', 'brand_dir', 'ceo', 'gm', 'chair'];
function buildTable() {
  if (chance(0.4)) return [{ seq: 1, max: 5000, store_role: 'head', hq_role: 'head' }, { seq: 2, max: 10000, store_role: 'brand_dir', hq_role: 'head' }, { seq: 3, max: 30000, store_role: 'gm', hq_role: 'gm' }, { seq: 4, max: null, store_role: 'chair', hq_role: 'chair' }];
  const n = ri(2, 5);
  const maxes = [];
  let cur = 0;
  const pool = [5000, 10000, 30000];
  for (let i = 0; i < n - 1; i++) { cur += ri(1, 20000); if (chance(0.5) && pool.length && pool[0] > cur) cur = pool.shift(); maxes.push(cur); }
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ seq: i + 1, max: i === n - 1 ? null : maxes[i], store_role: pick(ROLES), hq_role: pick(ROLES) });
  return rows;
}

// ── 預期值：照規格獨立算 ─────────────────────────────────
const TITLE = { pt: ['store', 1], ft: ['store', 2], sm: ['store', 3], am: ['store', 4], fm: ['store', 3], rdd: ['store', 4], ofs: ['office', 1], osv: ['office', 2], odir: ['office', 3], hs: ['hq', 1], hm: ['hq', 2], ceo: ['hq', 3], gm: ['hq', 4], chair: ['hq', 5] };
function ladderOf(unit) { return unit === 'dzy-hq' ? 'hq' : (/-hq$/.test(unit) ? 'office' : 'store'); }
function brandOf(unit) { if (unit === 'ck') return 'ck'; if (unit === 'dzy-hq') return 'dzy'; return unit.split('-')[0]; }
const opened = (p) => p.status === 'active' && p.userActive;

/** 某一種權限人的候選人（spec §5.2；排除 exclude；同階梯職級要比 of 高） */
function expCands(role, of, P, exclude, acting) {
  const lad = ladderOf(of.unit);
  const ofRank = TITLE[of.title][1];
  return P.filter((p) => {
    if (!opened(p) || exclude.indexOf(p.emp) !== -1) return false;
    const pl = TITLE[p.title][0], pr = TITLE[p.title][1];
    let hit = false;
    if (role === 'head') {
      if (lad === 'store') {
        hit = p.unit === of.unit && (p.title === 'sm' || p.title === 'fm');
        if (!hit && acting && acting.emp === p.emp && acting.unit === of.unit) return ofRank < 3;   // 兼任店長比照店長職級
      } else if (lad === 'hq') hit = of.dept !== '' && p.unit === of.unit && p.dept === of.dept && p.title === 'hm';
      else hit = p.unit === of.unit && pl === 'office' && pr === 2;
    } else if (role === 'brand_dir') {
      if (of.unit === 'ck') hit = p.unit === 'ck' && p.title === 'rdd';
      else hit = brandOf(of.unit) !== '' && p.title === 'odir' && p.unit === OFFICE[brandOf(of.unit)];
    } else hit = p.title === role;
    if (!hit) return false;
    if (pl === lad && pr <= ofRank) return false;
    return true;
  }).map((p) => p.emp).sort();
}
/** 請購請款的預期路線：{role, skips:[role...], cands, status} */
function expSpendRoute(sender, amount, rows, P, acting) {
  const row = rows.find((r) => r.max === null || amount <= r.max);
  let role = ladderOf(sender.unit) === 'hq' ? row.hq_role : row.store_role;
  const skips = [];
  for (;;) {
    const c = expCands(role, sender, P, [sender.emp], acting);
    if (c.length) return { row, firstRole: skips.length ? skips[0] : role, role, skips, cands: c, status: 'signing' };
    skips.push(role);
    const i = ROLES.indexOf(role);
    if (i === ROLES.length - 1) return { row, firstRole: skips[0], role: null, skips, cands: [], status: 'exception' };
    role = ROLES[i + 1];
  }
}
/** 金額（spec §14.6）：小計＝四捨五入(qty×price)，自己寫 floor(x+0.5)，不用 Math.round 也不用 JS 的 round */
function expAmount(items) { return items.reduce((s, it) => s + Math.floor(it.qty * it.price + 0.5), 0); }

// ── 建世界 ──────────────────────────────────────────────
const { P, vac, acting } = buildPeople();
const rows = buildTable();
const PW = 'fake-pw-dd-home';
function freshApp() {
  const hasher = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
  const salt = 'salt-dd';
  const hash = hasher.hashPassword_(PW, salt);
  const users = [['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at'],
    ['u001', 'BOSS', '系統管理者', 'admin', '', salt, hasher.hashPassword_('fake-admin-pw', salt), 'TRUE', '', '']];
  P.forEach((p) => { if (p.status !== 'unclaimed') users.push(['u' + p.emp.slice(3), p.emp, p.name, p.role, '', salt, hash, p.userActive ? 'TRUE' : 'FALSE', '', '']); });
  const app = load({
    users, roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['staff', '員工', 'platform.self'], ['hr', '人資', 'platform.staff,platform.self']],
    module_secrets: [['backend_id', 'level', 'secret']], login_log: [['at', 'username', 'ip_hash', 'result']]
  });
  const sb = app.sb;
  sb.setupStaff();
  const st = app.sheets.staff;
  P.forEach((p) => {
    const row = new Array(sb.STF_COL_COUNT).fill('');
    const put = (k, v) => { row[sb.STF_COL[k]] = v; };
    put('emp_no', p.emp); put('user_id', p.status === 'unclaimed' ? '' : 'u' + p.emp.slice(3)); put('name', p.name); put('status', p.status);
    put('brand', brandOf(p.unit)); put('unit', p.unit); put('dept', p.dept); put('title', p.title);
    put('birthday', p.birthday); put('phone', p.phone); put('address', p.address);
    st._data.push(row);
  });
  sb.setupApprovals();
  // 權限表換成本次隨機的（直接寫表，ver 1）
  const thr = app.sheets.apv_thresholds;
  thr._data.length = 1;
  rows.forEach((r) => thr._data.push(['spend', r.seq, r.max === null ? '' : r.max, r.store_role, r.hq_role, 1]));
  // 兼任店長：perm_ex 一列 store.sm@<單位>，試點單位含該店
  if (acting) {
    app.props.STORE_SSO_UNITS = ['ck', 'dzy-hq', 'mala-gf', 'mala-hq', 'mzt-gf', 'mzt-hq', 'mzt-js', 'mzt-lzl', 'yiwu-js', 'yiwu-wx', 'yiwu-hq'].join(',');
    const H = sb.PERM_EX_HEADERS;
    app.sheets.perm_ex = makeSheet([H, ['ex-dd-1', acting.emp, 'store.sm@' + acting.unit, 'add', '', '測試兼任', 'TRUE', Date.now(), 'BOSS', '', '']]);
    if (typeof sb.permActingReset_ === 'function') sb.permActingReset_();
  }
  app.tok = { admin: sb.issueToken_({ id: 'u001', role: 'admin', node: '' }) };
  P.forEach((p) => { app.tok[p.emp] = sb.issueToken_({ id: 'u' + p.emp.slice(3), role: p.role, node: '' }); });
  return app;
}
function post(app, who, action, payload) {
  return JSON.parse(app.sb.doPost({ postData: { contents: JSON.stringify({ action, token: app.tok[who] || who, payload: payload || {} }) } }).getContent());
}
const SHA = 'b'.repeat(64);
function upload(app, emp, kind) {
  const r = app.sb.apvFileRegister_(emp, { kind: kind || 'receipt', bytes: 1000, sha256: SHA });
  app.sb.apvFileCommit_(r.id);
  return r.id;
}
let cid = 0;
const newCid = () => 'dd-' + (++cid) + '-' + crypto.randomBytes(3).toString('hex');
const byEmp = {};
P.forEach((p) => { byEmp[p.emp] = p; });
const openedPeople = P.filter(opened);
const hrs = P.filter((p) => p.role === 'hr' && opened(p));
const HR = hrs[0] ? hrs[0].emp : null;

console.log(`人員 ${P.length} 位（已開通 ${openedPeople.length}）；空缺：${Object.keys(vac).join('、') || '無'}；兼任：${acting ? acting.emp + '→' + acting.unit : '無'}`);
console.log('權限表：' + J(rows));

const app = freshApp();
ok(post(app, 'admin', 'apvThresholdGet', {}).data.rows.length === rows.length, '後端讀回本次隨機權限表 ' + rows.length + ' 級');

const sec1 = [];
// ============================================================
// 1. 金額：amount.js 與 apvCalcAmount_ 逐字一致；隨機品項（含 .5 邊界）金額照規格算
// ============================================================
{
  const gs = fs.readFileSync(path.join(DIR, 'ApprovalRoute.gs'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'modules', 'approvals-shared', 'amount.js'), 'utf8');
  const bodyOf = (src, name) => { const i = src.indexOf('function ' + name); const s = src.indexOf('{', i); let d = 0, j = s; for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) break; } } return src.slice(s, j + 1).replace(/\s+/g, ' '); };
  ok(bodyOf(gs, 'apvCalcAmount_') === bodyOf(js, 'apvCalcAmount'), '★amount.js 與 apvCalcAmount_ 函式本體逐字相同');
  // 送件人：隨便一位已開通門市同仁（非店長），每張單一到數列，含 .5 邊界（qty x.5 × 奇數價）
  const senders = openedPeople.filter((p) => ladderOf(p.unit) === 'store' && TITLE[p.title][1] <= 2);
  for (let t = 0; t < 6; t++) {
    const s = pick(senders);
    const n = ri(1, 4);
    const items = [];
    for (let i = 0; i < n; i++) {
      const edge = chance(0.5);
      const qty = edge ? ri(1, 20) + 0.5 : (chance(0.5) ? ri(1, 50) : Math.round(rnd() * 999) / 100 + 0.01);
      const price = edge ? ri(1, 500) * 2 + 1 : ri(1, 3000);
      items.push({ name: '測試品' + i, qty: Number(qty.toFixed(2)), unit: '個', price });
    }
    const exp = expAmount(items);
    const r = post(app, s.emp, 'apvSubmit', { client_id: newCid(), type: 'purchase', body: { items, purpose: '測試用途', need_date: '2026-12-01' }, files: [] });
    const g = r.ok ? post(app, s.emp, 'apvGet', { id: r.data.id }) : null;
    ok(r.ok && g.ok && g.data.form.amount === exp, `請購金額 ${J(items.map((i) => [i.qty, i.price]))} → 預期 ${exp}（實際 ${g && g.data.form.amount}）`, r);
    if (r.ok) {
      const er = expSpendRoute(s, exp, rows, P, acting);
      ok(g.data.form.status === er.status, `  同單狀態 ${er.status}（實際 ${g.data.form.status}）`, g.data.form.route);
      sec1.push({ id: g.data.form.id, sender: s, amount: exp, exp: er, type: 'purchase', form: g.data.form });
    }
  }
  // 反例
  const s = pick(senders);
  const badCases = [[{ qty: 0, price: 10 }], [{ qty: 1, price: 0 }], [{ qty: 1.234, price: 10 }], [{ qty: 1, price: 10.5 }], [{ qty: -1, price: 10 }], [{ qty: 10000, price: 1 }], [{ qty: 1, price: 1000001 }], [{ qty: '1', price: 10 }]];
  badCases.forEach((items) => {
    const r = post(app, s.emp, 'apvSubmit', { client_id: newCid(), type: 'purchase', body: { items: items.map((x) => Object.assign({ name: 'x', unit: 'u' }, x)), purpose: 'p', need_date: '2026-12-01' }, files: [] });
    ok(!r.ok && r.error === 'bad_amount', '反例 ' + J(items) + ' → bad_amount（實際 ' + (r.ok ? 'ok' : r.error) + '）');
  });
  const big = post(app, s.emp, 'apvSubmit', { client_id: newCid(), type: 'purchase', body: { items: [{ name: 'x', unit: 'u', qty: 9999, price: 1000000 }, { name: 'y', unit: 'u', qty: 9999, price: 1000000 }], purpose: 'p', need_date: '2026-12-01' }, files: [] });
  ok(!big.ok && big.error === 'bad_amount', '合計超過 10,000,000 → bad_amount');
  const e0 = post(app, s.emp, 'apvSubmit', { client_id: newCid(), type: 'expense', body: { spend_date: '2026-10-01', category: 'misc', amount: 0, desc: 'd', payee: 'self' }, files: [upload(app, s.emp)] });
  ok(!e0.ok && e0.error === 'bad_amount', '請款金額 0 → bad_amount');
  const e5 = post(app, s.emp, 'apvSubmit', { client_id: newCid(), type: 'expense', body: { spend_date: '2026-10-01', category: 'misc', amount: 100.5, desc: 'd', payee: 'self' }, files: [upload(app, s.emp)] });
  ok(!e5.ok && e5.error === 'bad_amount', '請款金額 100.5 → bad_amount');
  const nf = post(app, s.emp, 'apvSubmit', { client_id: newCid(), type: 'expense', body: { spend_date: '2026-10-01', category: 'misc', amount: 100, desc: 'd', payee: 'self' }, files: [] });
  ok(!nf.ok && nf.error === 'no_files', '請款沒收據 → no_files');
}

// ============================================================
// 2. 核決權限級距與簽核路線：每一列 max／max+1／區間內隨機；門市、央廚、品牌辦公室、總部四種送件人；空缺往上；自己不能簽
// ============================================================
const sendersAll = openedPeople.filter((p) => !(p.title === 'chair'));
function amountsFor(rows) {
  const out = [1];
  rows.forEach((r, i) => { if (r.max !== null) { out.push(r.max); out.push(r.max + 1); } const lo = i === 0 ? 1 : rows[i - 1].max + 1; const hi = r.max === null ? lo + ri(1000, 200000) : r.max; out.push(ri(lo, hi)); });
  return out;
}
const submitted = sec1.slice();   // {id, sender, amount, exp, type}（含第 1 節的請購單）
{
  const groups = { store: sendersAll.filter((p) => ladderOf(p.unit) === 'store' && p.unit !== 'ck'), ck: sendersAll.filter((p) => p.unit === 'ck'), office: sendersAll.filter((p) => ladderOf(p.unit) === 'office'), hq: sendersAll.filter((p) => ladderOf(p.unit) === 'hq') };
  // 分層：每一種送件人階梯都抽；店長／區經理／總監／執行長／總經理也要當送件人（自己不能簽）
  const want = [];
  for (const k of Object.keys(groups)) if (groups[k].length) want.push(pick(groups[k]));
  ['sm', 'am', 'odir', 'ceo', 'gm', 'hm', 'fm', 'rdd', 'osv'].forEach((t) => { const c = sendersAll.filter((p) => p.title === t); if (c.length) want.push(pick(c)); });
  if (acting) { const c = sendersAll.filter((p) => p.unit === acting.unit && TITLE[p.title][1] <= 2); if (c.length) want.push(pick(c)); }
  for (const s of want) {
    for (const amount of amountsFor(rows)) {
      const type = chance(0.5) ? 'expense' : 'purchase';
      const body = type === 'expense' ? { spend_date: '2026-10-20', category: pick(['repair', 'food', 'misc', 'transport', 'supplies', 'other']), amount, desc: '測試說明', payee: 'self' }
        : { items: [{ name: '測試品', qty: 1, unit: '個', price: amount }], purpose: '測試', need_date: '2026-12-01' };
      const files = type === 'expense' ? [upload(app, s.emp)] : [];
      const r = post(app, s.emp, 'apvSubmit', { client_id: newCid(), type, body, files });
      const exp = expSpendRoute(s, amount, rows, P, acting);
      if (!r.ok) { ok(false, `送單失敗 ${s.emp}(${s.unit}/${s.title}) ${amount}`, r); continue; }
      const g = post(app, s.emp, 'apvGet', { id: r.data.id }).data;
      const f = g.form;
      const steps = f.route.steps;
      const pendingStep = steps[f.step] || null;
      const actualCands = pendingStep && pendingStep.candidates ? pendingStep.candidates.map((c) => c.emp).sort() : [];
      const actualSkips = steps.filter((st) => st.status === 'skipped').map((st) => st.role);
      const label = `${s.unit}/${s.title}${acting && acting.unit === s.unit ? '(兼任店)' : ''} 送 ${amount} → 第${exp.row.seq}級 ${exp.firstRole}` + (exp.skips.length ? ` 空缺跳過 ${exp.skips.join('→')}` : '') + ` → ${exp.status}${exp.role ? ' ' + exp.role : ''}`;
      const good = f.status === exp.status && f.route.row.seq === exp.row.seq && f.route.row.role === exp.firstRole && J(actualSkips) === J(exp.skips) && J(actualCands) === J(exp.cands) && (exp.status !== 'signing' || pendingStep.role === exp.role) && f.amount === amount;
      ok(good, '★' + label + `｜候選 ${J(exp.cands)}`, { status: f.status, row: f.route.row, steps: steps.map((x) => [x.role, x.status, (x.candidates || []).map((c) => c.emp)]) });
      submitted.push({ id: f.id, sender: s, amount, exp, type, form: f });
    }
  }
}

// ============================================================
// 3. 誰看得到（spec §14.7）、待我簽、核准／退回／撤回／改派／作廢／承辦
// ============================================================
{
  const handlerDept = { purchase: 'purchase', expense: 'fin' };
  const signing = submitted.filter((x) => x.exp.status === 'signing');
  const exceptions = submitted.filter((x) => x.exp.status === 'exception');
  ok(signing.length > 0, '至少有一張簽核中的單（' + signing.length + ' 張）');
  // 待我簽：每位已開通的人，apvTodo.sign 應該恰好＝他是候選人的那些單
  for (const p of openedPeople) {
    const exp = signing.filter((x) => x.exp.cands.indexOf(p.emp) !== -1).map((x) => x.id).sort();
    const r = post(app, p.emp, 'apvTodo', {});
    const got = r.ok ? r.data.sign.map((f) => f.id).sort() : null;
    if (exp.length || (got && got.length)) ok(J(got) === J(exp), `待我簽 ${p.emp}(${p.unit}/${p.title}) 預期 ${exp.length} 張`, { exp, got });
    if (p.role === 'hr') ok(r.ok && J((r.data.exception || []).map((f) => f.id).sort()) === J(exceptions.map((x) => x.id).sort()), `人資 ${p.emp} 待辦 exception 清單＝${exceptions.length} 張`, r.data && r.data.exception && r.data.exception.map((f) => f.id));
    else ok(r.ok && r.data.exception === undefined, `非人資 ${p.emp} 看不到 exception 清單`);
  }
  // apvGet 可見度
  for (const x of signing.slice(0, 8)) {
    const stranger = openedPeople.find((p) => p.emp !== x.sender.emp && x.exp.cands.indexOf(p.emp) === -1 && p.role !== 'hr' && !(p.dept === handlerDept[x.type]) && p.title !== 'chair');
    if (stranger) ok(post(app, stranger.emp, 'apvGet', { id: x.id }).error === 'forbidden', `無關同仁 ${stranger.emp} 看 ${x.id} → forbidden`);
    const handler = openedPeople.find((p) => p.dept === handlerDept[x.type] && x.exp.cands.indexOf(p.emp) === -1 && p.role !== 'hr' && p.emp !== x.sender.emp);
    if (handler) ok(post(app, handler.emp, 'apvGet', { id: x.id }).error === 'forbidden', `承辦部門 ${handler.emp} 在簽核中看 ${x.id} → forbidden（還沒到承辦）`);
    ok(post(app, x.sender.emp, 'apvGet', { id: x.id }).ok, `送件人看自己的 ${x.id} ok`);
    ok(post(app, x.exp.cands[0], 'apvGet', { id: x.id }).ok, `候選人 ${x.exp.cands[0]} 看 ${x.id} ok`);
    if (HR) ok(post(app, HR, 'apvGet', { id: x.id }).ok, `人資看 ${x.id} ok`);
    ok(post(app, 'admin', 'apvGet', { id: x.id }).ok, `admin 看 ${x.id} ok`);
  }
  // 非候選人核准 → forbidden；候選人退回沒原因 → bad_request；撤回（無人核准）ok；核准後不能撤回
  const A = signing[0];
  const nonCand = openedPeople.find((p) => A.exp.cands.indexOf(p.emp) === -1 && p.emp !== A.sender.emp && p.role !== 'hr');
  if (nonCand) {
    const r = post(app, nonCand.emp, 'apvDecide', { id: A.id, rev: 1, step: A.form.step, decision: 'approve' });
    ok(!r.ok && (r.error === 'forbidden' || r.error === 'not_found'), `非候選人 ${nonCand.emp} 核准 ${A.id} → 擋（${r.error}）`);
  }
  const c0 = A.exp.cands[0];
  ok(post(app, c0, 'apvDecide', { id: A.id, rev: 1, step: A.form.step, decision: 'reject' }).error === 'bad_request', '退回沒寫原因 → bad_request');
  ok(post(app, c0, 'apvDecide', { id: A.id, rev: 2, step: A.form.step, decision: 'approve' }).error === 'conflict', 'rev 不符 → conflict');
  ok(post(app, A.sender.emp, 'apvWithdraw', { id: A.id, rev: 1, step: A.form.step }).ok, `送件人撤回 ${A.id}（尚無人核准）ok`);
  ok(post(app, A.sender.emp, 'apvGet', { id: A.id }).data.form.status === 'withdrawn', '撤回後狀態 withdrawn');
  ok(post(app, c0, 'apvDecide', { id: A.id, rev: 1, step: A.form.step, decision: 'approve' }).error === 'conflict', '撤回後再核准 → conflict');

  // 核准 → handling → 承辦部門看得到、處理 → done → 匯出
  const B = signing[1] || signing[0];
  if (B !== A) {
    const cB = pick(B.exp.cands);
    const d = post(app, cB, 'apvDecide', { id: B.id, rev: 1, step: B.form.step, decision: 'approve' });
    ok(d.ok && d.data.status === 'handling', `候選人 ${cB} 核准 ${B.id} → handling（實際 ${d.ok ? d.data.status : d.error}）`, d);
    ok(post(app, B.sender.emp, 'apvWithdraw', { id: B.id, rev: 1, step: null }).error === 'conflict' || post(app, B.sender.emp, 'apvWithdraw', { id: B.id, rev: 1, step: null }).error === 'forbidden', '已核准的單不能撤回');
    const dept = handlerDept[B.type];
    const hs = openedPeople.filter((p) => p.dept === dept || (p.extra || '').split(',').indexOf(dept) !== -1);
    const notH = openedPeople.find((p) => p.dept !== dept && p.role !== 'hr' && p.emp !== B.sender.emp && B.exp.cands.indexOf(p.emp) === -1);
    for (const h of hs) ok(post(app, h.emp, 'apvTodo', {}).data.handle.some((f) => f.id === B.id), `承辦 ${h.emp}(${dept}) 待我辦看到 ${B.id}`);
    if (notH) ok(!post(app, notH.emp, 'apvTodo', {}).data.handle.some((f) => f.id === B.id), `非承辦 ${notH.emp} 待我辦看不到 ${B.id}`);
    if (notH) ok(post(app, notH.emp, 'apvHandle', { id: B.id, rev: 1, step: null, result: 'done' }).error !== undefined, `非承辦 ${notH.emp} 按已處理 → 擋`);
    if (hs.length) {
      const h = pick(hs);
      ok(post(app, h.emp, 'apvHandle', { id: B.id, rev: 1, step: null, result: 'return' }).error === 'bad_request', '承辦退回沒原因 → bad_request');
      const hd = post(app, h.emp, 'apvHandle', { id: B.id, rev: 1, step: null, result: 'done', note: '已辦' });
      ok(hd.ok && hd.data.status === 'done', `承辦 ${h.emp} 已處理 → done`);
      const month = (() => { const d2 = new Date(Date.now() + 8 * 3600e3); return d2.getUTCFullYear() + '-' + String(d2.getUTCMonth() + 1).padStart(2, '0'); })();
      const fin = openedPeople.find((p) => p.dept === 'fin');
      const nonFin = openedPeople.find((p) => p.dept !== 'fin' && p.role !== 'hr');
      if (fin) {
        const ex = post(app, fin.emp, 'apvExport', { month });
        const row = ex.ok && ex.data.rows.find((r) => r.id === B.id);
        ok(!!row && row.amount === B.amount && row.sender_name === B.sender.name && row.handle_note === '已辦' && !!row.approved_at && !!row.done_at, `財務匯出含 ${B.id}：金額 ${B.amount}、送件人、備註、核准日、處理日`, row);
      }
      if (nonFin) ok(post(app, nonFin.emp, 'apvExport', { month }).error === 'forbidden', `非財務 ${nonFin.emp} 匯出 → forbidden`);
      // 承辦部門 apvList 只看自己部門且 handling/done
      const lst = post(app, h.emp, 'apvList', {});
      ok(lst.ok && lst.data.forms.every((f) => f.handler_dept === dept && (f.status === 'handling' || f.status === 'done')) && lst.data.forms.some((f) => f.id === B.id), `承辦 ${h.emp} 全部單據只列 ${dept} 的 handling／done`);
    }
    // 承辦部門在 done 後看得到明細
    if (hs.length) ok(post(app, hs[0].emp, 'apvGet', { id: B.id }).ok, `承辦 ${hs[0].emp} 看 done 單 ok`);
  }

  // 退回 → 送件人改完再送 → rev 2、路線重算、重新從第一關
  const C = signing[2];
  if (C) {
    const cC = pick(C.exp.cands);
    const rj = post(app, cC, 'apvDecide', { id: C.id, rev: 1, step: C.form.step, decision: 'reject', note: '收據看不清楚' });
    ok(rj.ok && rj.data.status === 'rejected', `退回 ${C.id} → rejected`);
    const mine = post(app, C.sender.emp, 'apvMine', {});
    const mf = mine.data.forms.find((f) => f.id === C.id);
    ok(mf && mf.status === 'rejected' && mf.reject_note && mf.reject_note.note === '收據看不清楚' && mf.reject_note.by === byEmp[cC].name && mf.can.resubmit === true, '我的單帶退回原因與退回人、can.resubmit', mf && mf.reject_note);
    const other = openedPeople.find((p) => p.emp !== C.sender.emp && p.role !== 'hr');
    const body2 = C.type === 'expense' ? { spend_date: '2026-10-20', category: 'misc', amount: C.amount, desc: '改好了', payee: 'self' } : { items: [{ name: '測試品', qty: 1, unit: '個', price: C.amount }], purpose: '改好了', need_date: '2026-12-01' };
    const files2 = C.type === 'expense' ? [upload(app, C.sender.emp)] : [];
    ok(post(app, other.emp, 'apvResubmit', { id: C.id, rev: 1, step: null, body: body2, files: files2 }).ok === false, `別人 ${other.emp} 不能替送件人再送`);
    const rs2 = post(app, C.sender.emp, 'apvResubmit', { id: C.id, rev: 1, step: null, body: body2, files: C.type === 'expense' ? [upload(app, C.sender.emp)] : [] });
    ok(rs2.ok && rs2.data.rev === 2 && rs2.data.status === C.exp.status, `送件人再送 ${C.id} → rev 2、${C.exp.status}`, rs2);
    const g2 = post(app, C.sender.emp, 'apvGet', { id: C.id }).data;
    ok(g2.revisions.length === 2 && g2.form.route.steps.filter((s) => s.status === 'pending').length >= 1, '再送後 revisions 2 版、路線重算');
  }

  // 人資改派：合格對象（該關 role 或更高）ok；送件人／不合格 → bad_request；非人資 → forbidden
  const D = signing[3];
  if (D && HR) {
    const stepRole = D.exp.role;
    const higher = ROLES.slice(ROLES.indexOf(stepRole));
    let target = null;
    for (const r of higher) { const c = expCands(r, D.sender, P, [D.sender.emp], acting).filter((e) => D.exp.cands.indexOf(e) === -1); if (c.length) { target = c[0]; break; } }
    const lowPerson = openedPeople.find((p) => TITLE[p.title][1] === 1 && p.emp !== D.sender.emp);
    ok(post(app, lowPerson.emp, 'apvReassign', { id: D.id, rev: 1, step: D.form.step, to: D.exp.cands[0], reason: 'x' }).error !== undefined, `非人資 ${lowPerson.emp} 改派 → 擋`);
    ok(post(app, HR, 'apvReassign', { id: D.id, rev: 1, step: D.form.step, to: lowPerson.emp, reason: '測試' }).error === 'bad_request', `改派給不合格的 ${lowPerson.emp}(${lowPerson.title}) → bad_request`);
    ok(post(app, HR, 'apvReassign', { id: D.id, rev: 1, step: D.form.step, to: D.sender.emp, reason: '測試' }).error === 'bad_request', '改派給送件人 → bad_request');
    if (target) {
      const ra = post(app, HR, 'apvReassign', { id: D.id, rev: 1, step: D.form.step, to: target, reason: '原簽核人請假' });
      ok(ra.ok && ra.data.status === 'signing', `人資改派 ${D.id} 給 ${target}(${byEmp[target].title}) ok`, ra);
      const todoT = post(app, target, 'apvTodo', {}).data.sign.map((f) => f.id);
      ok(todoT.indexOf(D.id) !== -1, `改派後 ${target} 待我簽看到 ${D.id}`);
      const orig = D.exp.cands[0];
      ok(post(app, orig, 'apvTodo', {}).data.sign.map((f) => f.id).indexOf(D.id) === -1, `改派後原候選人 ${orig} 待我簽不再有 ${D.id}`);
      const dd = post(app, orig, 'apvDecide', { id: D.id, rev: 1, step: D.form.step, decision: 'approve' });
      ok(!dd.ok, `改派後原候選人 ${orig} 核准 → 擋（${dd.error}）`);
      ok(post(app, target, 'apvDecide', { id: D.id, rev: 1, step: D.form.step, decision: 'approve' }).ok, `被指派的 ${target} 核准 ok`);
    }
  }
  // 作廢：一般同仁 forbidden；admin 要原因；done 的單 conflict
  const E = signing[4];
  if (E) {
    const g = post(app, 'admin', 'apvGet', { id: E.id }).data.form;
    const some = openedPeople.find((p) => p.role !== 'hr');
    ok(post(app, some.emp, 'apvVoid', { id: E.id, rev: g.rev, step: g.step, reason: 'x' }).ok === false, `一般同仁 ${some.emp} 作廢 → 擋`);
    ok(post(app, 'admin', 'apvVoid', { id: E.id, rev: g.rev, step: g.step }).error === 'bad_request', 'admin 作廢沒原因 → bad_request');
    ok(post(app, 'admin', 'apvVoid', { id: E.id, rev: g.rev, step: g.step, reason: '重複送單' }).ok, `admin 作廢 ${E.id} ok`);
    ok(post(app, 'admin', 'apvVoid', { id: E.id, rev: g.rev, step: null, reason: '再一次' }).error === 'conflict', '已作廢再作廢 → conflict');
  }
  // exception：人資指派總經理／董事長
  for (const x of exceptions.slice(0, 2)) {
    const todoSender = post(app, x.sender.emp, 'apvMine', {}).data.forms.find((f) => f.id === x.id);
    ok(todoSender && todoSender.status === 'exception' && todoSender.stuck === true, `${x.id}（${x.sender.title} 送 ${x.amount}）exception 且 stuck`);
    if (HR) {
      const gmOrChair = openedPeople.find((p) => (p.title === 'gm' || p.title === 'chair') && p.emp !== x.sender.emp);
      if (gmOrChair) {
        const ra = post(app, HR, 'apvReassign', { id: x.id, rev: 1, step: x.form.step, to: gmOrChair.emp, reason: '找不到人' });
        ok(ra.ok, `exception 單 ${x.id} 人資指派 ${gmOrChair.emp}(${gmOrChair.title}) ok`, ra);
        if (ra.ok) ok(post(app, gmOrChair.emp, 'apvTodo', {}).data.sign.some((f) => f.id === x.id), `指派後 ${gmOrChair.emp} 待我簽看到 ${x.id}`);
      }
    }
  }
  // 董事長送單 → 一律 exception（沒有更高的人）
  const chair = openedPeople.find((p) => p.title === 'chair');
  if (chair) {
    const r = post(app, chair.emp, 'apvSubmit', { client_id: newCid(), type: 'expense', body: { spend_date: '2026-10-20', category: 'misc', amount: ri(1, 50000), desc: '董事長支出', payee: 'self' }, files: [upload(app, chair.emp)] });
    ok(r.ok && r.data.status === 'exception', '★董事長送支出單 → exception', r);
  }
  // client_id 重送回原單
  const s = pick(sendersAll.filter((p) => ladderOf(p.unit) === 'store'));
  const cidX = newCid();
  const r1 = post(app, s.emp, 'apvSubmit', { client_id: cidX, type: 'purchase', body: { items: [{ name: 'a', qty: 1, unit: 'u', price: 10 }], purpose: 'p', need_date: '2026-12-01' }, files: [] });
  const r2 = post(app, s.emp, 'apvSubmit', { client_id: cidX, type: 'purchase', body: { items: [{ name: 'a', qty: 1, unit: 'u', price: 999 }], purpose: 'p', need_date: '2026-12-01' }, files: [] });
  ok(r1.ok && r2.ok && r1.data.id === r2.data.id, '同 client_id 重送回原單號');
}

// ============================================================
// 4. 快照：改權限表後，已送出的單路線不變；新單用新表（spec §5.4）
// ============================================================
{
  const s = pick(sendersAll.filter((p) => ladderOf(p.unit) === 'store' && TITLE[p.title][1] <= 2));
  const before = post(app, s.emp, 'apvSubmit', { client_id: newCid(), type: 'purchase', body: { items: [{ name: 'a', qty: 1, unit: 'u', price: 7777 }], purpose: 'p', need_date: '2026-12-01' }, files: [] });
  const g0 = post(app, s.emp, 'apvGet', { id: before.data.id }).data.form;
  const t = post(app, 'admin', 'apvThresholdGet', {}).data;
  const newRows = [{ seq: 1, max: 1000, store_role: 'chair', hq_role: 'chair' }, { seq: 2, max: null, store_role: 'gm', hq_role: 'gm' }];
  ok(post(app, s.emp, 'apvThresholdSave', { expected_ver: t.ver, rows: newRows }).error === 'forbidden', '一般同仁改權限表 → forbidden');
  ok(post(app, 'admin', 'apvThresholdSave', { expected_ver: t.ver + 5, rows: newRows }).error === 'conflict', 'expected_ver 不符 → conflict');
  ok(post(app, 'admin', 'apvThresholdSave', { expected_ver: t.ver, rows: [{ seq: 1, max: 5000, store_role: 'head', hq_role: 'head' }, { seq: 2, max: 4000, store_role: 'gm', hq_role: 'gm' }, { seq: 3, max: null, store_role: 'chair', hq_role: 'chair' }] }).error === 'bad_request', '金額沒遞增 → bad_request');
  ok(post(app, 'admin', 'apvThresholdSave', { expected_ver: t.ver, rows: [{ seq: 1, max: 5000, store_role: 'head', hq_role: 'head' }] }).error === 'bad_request', '最後一列不是空 → bad_request');
  const sv = post(app, 'admin', 'apvThresholdSave', { expected_ver: t.ver, rows: newRows });
  ok(sv.ok && sv.data.ver === t.ver + 1, 'admin 儲存新表 ver+1', sv);
  const g1 = post(app, s.emp, 'apvGet', { id: before.data.id }).data.form;
  ok(J(g1.route.row) === J(g0.route.row) && g1.route.thr_ver === t.ver, '★改表後舊單路線快照不變（thr_ver 仍 ' + t.ver + '）');
  const after = post(app, s.emp, 'apvSubmit', { client_id: newCid(), type: 'purchase', body: { items: [{ name: 'a', qty: 1, unit: 'u', price: 7777 }], purpose: 'p', need_date: '2026-12-01' }, files: [] });
  const g2 = post(app, s.emp, 'apvGet', { id: after.data.id }).data.form;
  const expRole2 = ladderOf(s.unit) === 'hq' ? 'gm' : 'gm';
  ok(g2.route.thr_ver === t.ver + 1 && g2.route.row.role === expRole2 && g2.route.row.seq === 2, '新單用新表（第 2 級 gm）', g2.route);
  // 還原
  post(app, 'admin', 'apvThresholdSave', { expected_ver: t.ver + 1, rows: rows });
}

// ============================================================
// 5. 人事異動（spec §14.4）：離職本人送（送出即簽）→ 直屬主管；主管替送調職；調薪一律總經理；別店店長不能送
// ============================================================
{
  const gm = openedPeople.find((p) => p.title === 'gm');
  const stores = Object.values(STORE_UNITS).flat();
  const staffer = pick(openedPeople.filter((p) => stores.indexOf(p.unit) !== -1 && TITLE[p.title][1] <= 2));
  const sm = openedPeople.find((p) => p.unit === staffer.unit && p.title === 'sm');
  const am = openedPeople.find((p) => p.unit === staffer.unit && p.title === 'am');
  const brandDir = openedPeople.find((p) => p.title === 'odir' && p.unit === OFFICE[brandOf(staffer.unit)]);
  const brandOsv = openedPeople.find((p) => p.title === 'osv' && p.unit === OFFICE[brandOf(staffer.unit)]);
  // 直屬主管（stfReviewNeed_ 的「只往上一層」）：門市一般同仁 → 同店 rank≥3（店長／區經理）＋兼任該店店長
  const directExp = openedPeople.filter((p) => p.unit === staffer.unit && TITLE[p.title][0] === 'store' && TITLE[p.title][1] >= 3).map((p) => p.emp)
    .concat(acting && acting.unit === staffer.unit && opened(byEmp[acting.emp]) ? [acting.emp] : []).sort();
  // 本人離職：送出即簽；下一關直屬主管（找不到 → brand_dir → ... ）
  const sign = upload(app, staffer.emp, 'sign');
  const r = post(app, staffer.emp, 'apvSubmit', { client_id: newCid(), type: 'personnel', body: { kind: 'leave', effective: '2026-12-31', from: { unit: staffer.unit, title: staffer.title }, to: {}, reason: '個人規劃', sign_file: sign }, files: [] });
  const g = r.ok ? post(app, staffer.emp, 'apvGet', { id: r.data.id }).data.form : null;
  let expSt = 'signing', expCandsL = directExp, skipsL = [];
  if (!directExp.length) {
    let role = 'brand_dir';
    skipsL = ['direct'];
    for (;;) { const c = expCands(role, staffer, P, [staffer.emp], acting); if (c.length) { expCandsL = c; break; } skipsL.push(role); const i = ROLES.indexOf(role); if (i === ROLES.length - 1) { expSt = 'exception'; expCandsL = []; break; } role = ROLES[i + 1]; }
  }
  if (g) {
    const steps = g.route.steps;
    const cands = g.status === 'signing' ? (steps[g.step].candidates || []).map((c) => c.emp).sort() : [];
    ok(steps[0].role === 'self_sign' && steps[0].status === 'done' && steps[0].by === staffer.emp, `本人離職 ${staffer.emp}(${staffer.unit}/${staffer.title})：第一關本人簽名已完成`);
    ok(g.status === expSt && J(cands) === J(expCandsL) && J(steps.filter((s) => s.status === 'skipped').map((s) => s.role)) === J(skipsL), `★離職單下一關＝直屬主管 ${J(expCandsL)}${skipsL.length ? '（跳過 ' + skipsL.join('→') + '）' : ''} 狀態 ${expSt}`, steps.map((x) => [x.role, x.status, (x.candidates || []).map((c) => c.emp)]));
    ok(g.handler_dept === 'hr', '人事單承辦＝hr');
  } else ok(false, '本人離職送單失敗', r);
  // 別店店長替送 → forbidden；同店店長替送調職 → 直屬主管＝送件人本人 → 改成送件人的直屬主管（品牌辦公室）
  const otherSm = openedPeople.find((p) => p.title === 'sm' && p.unit !== staffer.unit);
  if (otherSm) ok(post(app, otherSm.emp, 'apvSubmit', { client_id: newCid(), type: 'personnel', subject: staffer.emp, body: { kind: 'transfer', effective: '2026-12-01', from: { unit: staffer.unit }, to: { unit: otherSm.unit }, reason: '支援' }, files: [] }).error === 'forbidden', `別店店長 ${otherSm.emp} 替 ${staffer.emp} 送調職 → forbidden`);
  const peer = openedPeople.find((p) => p.unit === staffer.unit && p.emp !== staffer.emp && TITLE[p.title][1] <= 2);
  if (peer) ok(post(app, peer.emp, 'apvSubmit', { client_id: newCid(), type: 'personnel', subject: staffer.emp, body: { kind: 'transfer', effective: '2026-12-01', from: { unit: staffer.unit }, to: { unit: 'mala-gf' }, reason: '支援' }, files: [] }).error === 'forbidden', `同店同仁 ${peer.emp} 替 ${staffer.emp} 送調職 → forbidden`);
  if (sm) {
    const tr = post(app, sm.emp, 'apvSubmit', { client_id: newCid(), type: 'personnel', subject: staffer.emp, body: { kind: 'transfer', effective: '2026-12-01', from: { unit: staffer.unit, title: staffer.title }, to: { unit: pick(stores.filter((u) => u !== staffer.unit)), title: staffer.title }, reason: '支援' }, files: [] });
    const gt = tr.ok ? post(app, sm.emp, 'apvGet', { id: tr.data.id }).data.form : null;
    // 店長的直屬主管：品牌辦公室 rank≥2（總監／區督導，區域開關關＝不限區）或同店職級更高（區經理）
    const smDirect = openedPeople.filter((p) => (p.unit === OFFICE[brandOf(sm.unit)] && TITLE[p.title][1] >= 2) || (p.unit === sm.unit && TITLE[p.title][0] === 'store' && TITLE[p.title][1] > 3)).map((p) => p.emp).sort();
    let st2 = 'signing', c2 = smDirect, sk2 = [];
    if (!smDirect.length) { let role = 'brand_dir'; sk2 = ['direct']; for (;;) { const c = expCands(role, sm, P, [sm.emp, staffer.emp], acting); if (c.length) { c2 = c; break; } sk2.push(role); const i = ROLES.indexOf(role); if (i === ROLES.length - 1) { st2 = 'exception'; c2 = []; break; } role = ROLES[i + 1]; } }
    if (gt) {
      const cands = gt.status === 'signing' ? (gt.route.steps[gt.step].candidates || []).map((c) => c.emp).sort() : [];
      ok(gt.status === st2 && J(cands) === J(c2) && gt.route.steps[0].of === sm.emp, `★店長 ${sm.emp} 替 ${staffer.emp} 送調職：直屬主管＝自己 → 改成店長的直屬主管 ${J(c2)}${sk2.length ? '（跳過 ' + sk2.join('→') + '）' : ''}`, gt.route.steps.map((x) => [x.role, x.of, x.status, (x.candidates || []).map((c) => c.emp)]));
      ok(post(app, staffer.emp, 'apvGet', { id: tr.data.id }).error === 'forbidden', `對象同仁 ${staffer.emp} 不是送件人也不在路線上 → 看不到自己的調職單（forbidden）`);
    } else ok(false, '店長替送調職失敗', tr);
    // 調職到停用單位 → bad_request
    ok(post(app, sm.emp, 'apvSubmit', { client_id: newCid(), type: 'personnel', subject: staffer.emp, body: { kind: 'transfer', effective: '2026-12-01', from: {}, to: { unit: 'mzt-wx' }, reason: 'x' }, files: [] }).error === 'bad_request', '調職到停用單位 mzt-wx → bad_request');
    // 調薪：一律總經理；gm 不在 → 董事長；都不在 → exception
    const rz = post(app, sm.emp, 'apvSubmit', { client_id: newCid(), type: 'personnel', subject: staffer.emp, body: { kind: 'raise', effective: '2026-12-01', from: { pay: 30000 }, to: { pay: 32000 }, reason: '表現優良' }, files: [] });
    const gz = rz.ok ? post(app, sm.emp, 'apvGet', { id: rz.data.id }).data.form : null;
    const gmC = expCands('gm', staffer, P, [sm.emp, staffer.emp], acting);
    const chC = expCands('chair', staffer, P, [sm.emp, staffer.emp], acting);
    const expZ = gmC.length ? { st: 'signing', c: gmC, sk: [] } : chC.length ? { st: 'signing', c: chC, sk: ['gm'] } : { st: 'exception', c: [], sk: ['gm', 'chair'] };
    if (gz) {
      const cands = gz.status === 'signing' ? (gz.route.steps[gz.step].candidates || []).map((c) => c.emp).sort() : [];
      ok(gz.status === expZ.st && J(cands) === J(expZ.c) && J(gz.route.steps.filter((s) => s.status === 'skipped').map((s) => s.role)) === J(expZ.sk), `★調薪 → 總經理 ${J(expZ.c)}${expZ.sk.length ? '（跳過 ' + expZ.sk.join('→') + '）' : ''}`, gz.route.steps);
      // 薪資只有路線上的人、人資、送件人看得到：無關的人 forbidden
      const stranger = openedPeople.find((p) => p.emp !== sm.emp && p.emp !== staffer.emp && expZ.c.indexOf(p.emp) === -1 && p.role !== 'hr' && p.dept !== 'hr');
      if (stranger) ok(post(app, stranger.emp, 'apvGet', { id: rz.data.id }).error === 'forbidden', `無關同仁 ${stranger.emp} 看調薪單 → forbidden`);
      if (gm && gz.status === 'signing' && expZ.c.indexOf(gm.emp) !== -1) {
        const d = post(app, gm.emp, 'apvDecide', { id: rz.data.id, rev: 1, step: gz.step, decision: 'approve' });
        ok(d.ok && d.data.status === 'handling', `總經理核准調薪 → handling（人資承辦）`);
        const hrPeople = openedPeople.filter((p) => p.dept === 'hr');
        if (hrPeople.length) ok(post(app, hrPeople[0].emp, 'apvTodo', {}).data.handle.some((f) => f.id === rz.data.id), `人資部 ${hrPeople[0].emp} 待我辦看到調薪單`);
      }
    } else ok(false, '調薪送單失敗', rz);
    ok(post(app, sm.emp, 'apvSubmit', { client_id: newCid(), type: 'personnel', subject: staffer.emp, body: { kind: 'raise', effective: '2026-12-01', from: {}, to: {}, reason: 'x' }, files: [] }).error === 'bad_request', '調薪沒填新薪資 → bad_request');
  }
  // 主管替送離職：對象已開通 → 第一關 self_sign 由對象簽；帶紙本 → bad_request；對象未開通 → 要紙本 1～2 張
  if (sm) {
    const lv = post(app, sm.emp, 'apvSubmit', { client_id: newCid(), type: 'personnel', subject: staffer.emp, body: { kind: 'leave', effective: '2026-12-31', from: { unit: staffer.unit }, to: {}, reason: '離職', paper_files: [upload(app, sm.emp)] }, files: [] });
    ok(lv.error === 'bad_request', '對象已開通卻附紙本 → bad_request');
    const lv2 = post(app, sm.emp, 'apvSubmit', { client_id: newCid(), type: 'personnel', subject: staffer.emp, body: { kind: 'leave', effective: '2026-12-31', from: { unit: staffer.unit }, to: {}, reason: '離職' }, files: [] });
    const gl = lv2.ok ? post(app, sm.emp, 'apvGet', { id: lv2.data.id }).data.form : null;
    ok(gl && gl.status === 'signing' && gl.route.steps[0].role === 'self_sign' && gl.step === 0 && J(gl.route.steps[0].candidates.map((c) => c.emp)) === J([staffer.emp]), `主管替送離職：第一關本人簽名，候選＝對象 ${staffer.emp}`, gl && gl.route.steps);
    if (gl) {
      ok(post(app, staffer.emp, 'apvTodo', {}).data.sign.some((f) => f.id === lv2.data.id && f.can.sign === true && f.can.decide === false), `對象 ${staffer.emp} 待我簽看到離職單、can.sign`);
      ok(post(app, sm.emp, 'apvDecide', { id: lv2.data.id, rev: 1, step: 0, decision: 'approve' }).error === 'forbidden', '本人簽名關不能用核准');
      ok(post(app, sm.emp, 'apvSign', { id: lv2.data.id, rev: 1, step: 0, sign_file: upload(app, sm.emp, 'sign') }).error === 'forbidden', '主管替本人簽名 → forbidden');
      const sg = post(app, staffer.emp, 'apvSign', { id: lv2.data.id, rev: 1, step: 0, sign_file: upload(app, staffer.emp, 'sign') });
      ok(sg.ok && sg.data.step >= 1 && (sg.data.status === 'signing' || sg.data.status === 'exception'), `對象本人簽名 → 離開第 1 關（step ${sg.ok && sg.data.step}，直屬主管空缺會往上跳）`, sg);
      const stepNow = sg.ok ? sg.data.step : 1;
      ok(post(app, staffer.emp, 'apvWithdraw', { id: lv2.data.id, rev: 1, step: stepNow }).ok === false, '對象不是送件人不能撤回');
      // 本人簽名不算「核准」，送件人仍可撤回（apvHasDoneStep_ 排除 self_sign）
      if (sg.ok && sg.data.status === 'signing') ok(post(app, sm.emp, 'apvWithdraw', { id: lv2.data.id, rev: 1, step: stepNow }).ok, '只簽了本人簽名、尚無人核准 → 送件人仍可撤回');
    }
    const unc = P.find((p) => p.status === 'unclaimed');
    if (unc) {
      // 未開通對象：同店店長才能送
      const smU = openedPeople.find((p) => p.unit === unc.unit && p.title === 'sm');
      if (smU) {
        ok(post(app, smU.emp, 'apvSubmit', { client_id: newCid(), type: 'personnel', subject: unc.emp, body: { kind: 'leave', effective: '2026-12-31', from: {}, to: {}, reason: 'x' }, files: [] }).error === 'file_invalid', '對象未開通沒附紙本 → file_invalid');
        const lu = post(app, smU.emp, 'apvSubmit', { client_id: newCid(), type: 'personnel', subject: unc.emp, body: { kind: 'leave', effective: '2026-12-31', from: {}, to: {}, reason: 'x', paper_files: [upload(app, smU.emp), upload(app, smU.emp)] }, files: [] });
        const gu = lu.ok ? post(app, smU.emp, 'apvGet', { id: lu.data.id }).data.form : null;
        ok(gu && gu.route.steps[0].role !== 'self_sign' && gu.files.length === 2, '對象未開通附兩張紙本 → 免本人簽名關、兩張檔', gu && gu.route.steps);
      }
    }
  }
}

// ============================================================
// 6. 我的資料：單位通訊錄（生日地址只給門市與央廚主管）、待審核
// ============================================================
{
  const stores = Object.values(STORE_UNITS).flat().concat(['ck']);
  for (const p of openedPeople) {
    const r = post(app, p.emp, 'myUnit', {});
    const lad = ladderOf(p.unit);
    const rank = TITLE[p.title][1];
    const isMgr = (lad === 'store' && rank >= 3) || (lad === 'office' && rank >= 2) || (lad === 'hq' && rank >= 2 && p.dept !== '');
    const expPriv = lad === 'store' && rank >= 3 && stores.indexOf(p.unit) !== -1;
    if (!isMgr) { ok(!r.ok, `${p.emp}(${p.unit}/${p.title}) 不是主管 → 看不到通訊錄`, r.ok ? r.data : undefined); continue; }
    if (!r.ok) { ok(false, `${p.emp}(${p.unit}/${p.title}) 主管卻讀不到通訊錄`, r); continue; }
    const expPeople = openedPeople.concat(P.filter((q) => q.status === 'active' && !q.userActive)).filter((q) => q.status === 'active' && q.unit === p.unit && (lad !== 'hq' || q.dept === p.dept)).map((q) => q.emp).sort();
    const got = r.data.people.map((q) => q.emp_no).sort();
    ok(r.data.private === expPriv && J(got) === J(expPeople), `★通訊錄 ${p.emp}(${p.unit}/${p.title})：private=${expPriv}、${expPeople.length} 位`, { priv: r.data.private, got });
    // 逐欄：門市主管看得到生日地址且值正確；其他人這兩欄不存在
    r.data.people.forEach((q) => {
      const src = byEmp[q.emp_no];
      if (expPriv) ok(q.birthday === src.birthday && q.address === src.address && q.phone === src.phone, `  ${q.emp_no} 生日 ${src.birthday}、地址、手機正確`, q);
      else ok(!('birthday' in q) && !('address' in q) && q.phone === src.phone, `  ${q.emp_no} 沒有生日／地址欄、手機正確`, q);
    });
  }
  // 待審核：隨機一位門市新人認領中（pending），同店店長看得到＋生日地址、別店店長看不到；人資全可
  const unit = pick(Object.values(STORE_UNITS).flat().filter((u) => openedPeople.some((p) => p.unit === u && p.title === 'sm')));
  const newbie = person(unit, '', 'pt', { status: 'pending' });
  {
    const row = new Array(app.sb.STF_COL_COUNT).fill('');
    const put = (k, v) => { row[app.sb.STF_COL[k]] = v; };
    put('emp_no', newbie.emp); put('user_id', 'u' + newbie.emp.slice(3)); put('name', newbie.name); put('status', 'pending');
    put('p_brand', brandOf(unit)); put('p_unit', unit); put('p_title', 'pt'); put('birthday', newbie.birthday); put('phone', newbie.phone); put('address', newbie.address); put('claimed_at', '2026-10-28 10:00:00');
    app.sheets.staff._data.push(row);
    app.sheets.users._data.push(['u' + newbie.emp.slice(3), newbie.emp, newbie.name, 'staff', '', 'salt-dd', 'x', 'TRUE', '', '']);
  }
  const smU = openedPeople.find((p) => p.unit === unit && p.title === 'sm');
  const otherSm = openedPeople.find((p) => p.title === 'sm' && p.unit !== unit);
  const pt = openedPeople.find((p) => p.unit === unit && TITLE[p.title][1] <= 2);
  const pend = post(app, smU.emp, 'unitPending', {});
  const row = pend.ok && pend.data.people.find((x) => x.emp_no === newbie.emp);
  ok(!!row && row.birthday === newbie.birthday && row.address === newbie.address && row.phone === newbie.phone && row.unit === unit && pend.data.scope_name !== '', `同店店長 ${smU.emp} 待審核看到 ${newbie.emp}（生日、地址、手機、填的單位）`, pend);
  if (otherSm) { const o = post(app, otherSm.emp, 'unitPending', {}); ok(!o.ok || !o.data.people.some((x) => x.emp_no === newbie.emp), `別店店長 ${otherSm.emp} 看不到 ${newbie.emp}`); }
  if (pt) ok(!post(app, pt.emp, 'unitPending', {}).ok, `一般同仁 ${pt.emp} 沒有審核資格`);
  if (HR) { const h = post(app, HR, 'unitPending', {}); ok(h.ok && h.data.all_units === true && h.data.people.some((x) => x.emp_no === newbie.emp), `人資 ${HR} 全單位看得到 ${newbie.emp}`); }
  if (otherSm) ok(!post(app, otherSm.emp, 'unitApprove', { emp_no: newbie.emp }).ok, `別店店長 ${otherSm.emp} 通過 ${newbie.emp} → 擋`);
  ok(!post(app, smU.emp, 'unitReject', { emp_no: newbie.emp }).ok, '退回沒原因 → 擋');
  const ap = post(app, smU.emp, 'unitApprove', { emp_no: newbie.emp });
  ok(ap.ok, `同店店長通過 ${newbie.emp}`, ap);
  const after = post(app, smU.emp, 'myUnit', {}).data.people.find((x) => x.emp_no === newbie.emp);
  ok(!!after && after.title === 'pt' && after.birthday === newbie.birthday, '通過後出現在單位通訊錄（職稱 pt、生日）', after);
  ok(!post(app, smU.emp, 'unitApprove', { emp_no: newbie.emp }).ok, '已通過再通過 → 擋');
  // 再一位新人：退回 → 個資清空
  const nb2 = person(unit, '', 'ft', { status: 'pending' });
  {
    const r2 = new Array(app.sb.STF_COL_COUNT).fill('');
    const put = (k, v) => { r2[app.sb.STF_COL[k]] = v; };
    put('emp_no', nb2.emp); put('user_id', 'u' + nb2.emp.slice(3)); put('name', nb2.name); put('status', 'pending'); put('p_brand', brandOf(unit)); put('p_unit', unit); put('p_title', 'ft'); put('birthday', nb2.birthday); put('phone', nb2.phone); put('address', nb2.address);
    app.sheets.staff._data.push(r2);
    app.sheets.users._data.push(['u' + nb2.emp.slice(3), nb2.emp, nb2.name, 'staff', '', 'salt-dd', 'x', 'TRUE', '', '']);
  }
  const rj = post(app, smU.emp, 'unitReject', { emp_no: nb2.emp, reason: '資料不符' });
  ok(rj.ok, `退回 ${nb2.emp} ok`, rj);
  const rowAfter = app.sheets.staff._data.find((r) => r[app.sb.STF_COL.emp_no] === nb2.emp);
  ok(rowAfter && rowAfter[app.sb.STF_COL.status] === 'unclaimed' && rowAfter[app.sb.STF_COL.birthday] === '' && rowAfter[app.sb.STF_COL.address] === '', '退回後狀態 unclaimed、生日地址清空', rowAfter && [rowAfter[app.sb.STF_COL.status], rowAfter[app.sb.STF_COL.birthday]]);
}

console.log(`\nSEED=${SEED}｜共 ${passed + failed} 項檢查，通過 ${passed}，失敗 ${failed}`);
if (failed) { console.error('失敗項目：\n  - ' + fails.join('\n  - ')); process.exit(1); }
