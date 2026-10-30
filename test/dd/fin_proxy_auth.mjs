// node test/dd/fin_proxy_auth.mjs — 財務部門四模組的平台後端守門（Auth.gs proxyAuthorize_／PurchaseSso.gs／Perms.gs）資料帶入測試。
// 做法同 test/proxy-authorize.test.mjs：把 .gs 讀進 vm sandbox，用假試算表；但帳號、角色、權限組合、動作全部隨機抽，
// 預期值照 docs/*-fin/spec.md 與 PROXY.md 的規則由本檔自己算。E2E_SEED=<n> 重現。⚠ 全是假帳密（FAKE-）。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { READ_ACTIONS, WRITE_ACTIONS } from '../../platform/dryrun.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'Perms.gs', 'PermActions.gs', 'StoreOps.gs', 'StaffClock.gs', 'PurchaseSso.gs', 'Code.gs']
  .map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

const SEED = Number(process.env.E2E_SEED) || (Math.floor(Math.random() * 1e9) + 1);
console.log('E2E_SEED=' + SEED);
let st = SEED >>> 0 || 1;
const rand = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 4294967296; };
const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (arr) => arr[ri(0, arr.length - 1)];

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

// ── GAS 假物件（抄 proxy-authorize.test.mjs） ──
function makeSheet(rows) {
  const data = (rows || []).map((r) => r.slice());
  return {
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(row, col, numRows, numCols) {
      numRows = numRows || 1; numCols = numCols || 1;
      const range = {
        getValues() { const out = []; for (let r = 0; r < numRows; r++) { const src = data[row - 1 + r] || []; const o = []; for (let c = 0; c < numCols; c++) { const v = src[col - 1 + c]; o.push(v === undefined ? '' : v); } out.push(o); } return out; },
        setValue(v) { range.setValues([[v]]); },
        setValues(vals) { for (let r = 0; r < vals.length; r++) { const ri_ = row - 1 + r; while (data.length <= ri_) data.push([]); for (let c = 0; c < vals[r].length; c++) { const ci = col - 1 + c; while (data[ri_].length <= ci) data[ri_].push(''); data[ri_][ci] = vals[r][c]; } } return range; },
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
function bytes(v) { if (Buffer.isBuffer(v)) return v; if (typeof v === 'string') return Buffer.from(v, 'utf8'); return Buffer.from(v.map((b) => (b < 0 ? b + 256 : b) & 0xff)); }
function signed(buf) { return Array.from(buf, (b) => (b > 127 ? b - 256 : b)); }
function load(seed, props) {
  const sheets = {};
  Object.keys(seed).forEach((k) => { sheets[k] = makeSheet(seed[k]); });
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; } };
  const cache = new Map();
  const P = Object.assign({ HMAC_SECRET: 'fake-hmac-dd-fin' }, props || {});
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
      getUuid: () => 'fake-uuid-' + (++uuid) + '-' + ri(0, 1e9)
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => P[k] || null, setProperty: (k, v) => { P[k] = v; } }) },
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
  return { sb: sandbox, sheets, cache };
}
function post(sb, action, payload, token) {
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }).getContent());
}
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
const H = (pw, salt) => HASHER.hashPassword_(pw, salt);

// ── 隨機帳號組：每個系統帳號一個隨機角色，角色權限隨機從財務相關碼挑 ──
const FIN_CODES = ['cashbook.write', 'transfer.write', 'pnl.read', 'pnl.write', 'pnl.admin', 'platform.purchase', 'audit.read', 'dorm.read', 'platform.self'];
const NS_ALL = ['cashbook', 'pnl', 'transfer'];
const SECRET = { cashbook: 'FAKE-CB-' + ri(1000, 9999), pnl: 'FAKE-PNL-' + ri(1000, 9999), transfer: 'FAKE-TR-' + ri(1000, 9999) };
const PURCHASE_KEY = 'FAKE-PURCHASE-SVC-' + ri(1000, 9999);

function buildEnv() {
  const roles = [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['staff', '員工', '']];
  const users = [['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at', 'token_after']];
  const people = [];
  const nRoles = ri(3, 7);
  for (let i = 0; i < nRoles; i++) {
    const perms = FIN_CODES.filter(() => rand() < 0.45);
    if (rand() < 0.15) perms.push('*');
    roles.push(['r' + i, '角色' + i, perms.join(',')]);
    const n = ri(1, 2);
    for (let k = 0; k < n; k++) {
      const uname = 'u' + i + '_' + k + pick(['', 'X', 'ab']);
      const pw = 'FAKE-pw-' + i + '-' + k;
      const name = pick(['王會計', '李出納', '陳主管', '（怪）名字', 'A B']);
      const active = rand() < 0.9;
      users.push(['id' + i + '_' + k, uname, name, 'r' + i, pick(['', 'sxl-gf']), 's' + i + k, H(pw, 's' + i + k), active ? 'TRUE' : 'FALSE', '', '', '']);
      people.push({ uname, pw, name, perms: perms.includes('*') ? ['*'] : perms, active, id: 'id' + i + '_' + k });
    }
  }
  users.push(['idboss', 'BOSS', '老板', 'admin', '', 'sb', H('FAKE-boss', 'sb'), 'TRUE', '', '', '']);
  people.push({ uname: 'BOSS', pw: 'FAKE-boss', name: '老板', perms: ['*'], active: true, id: 'idboss' });
  // module_secrets：隨機漏掉某個 ns（→ UNKNOWN_NS）
  const secrets = [['backend_id', 'level', 'secret']];
  const dropNs = rand() < 0.5 ? pick(NS_ALL) : null;   // 隨機最多漏掉一個 ns 的金鑰（→ UNKNOWN_NS），其餘要測得到放行
  const haveNs = NS_ALL.filter((ns) => ns !== dropNs);
  haveNs.forEach((ns) => secrets.push([ns, 'write', SECRET[ns]]));
  if (haveNs.includes('pnl')) secrets.push(['pnl', 'read', 'FAKE-PNL-READ']);
  const env = load({ users, roles, module_secrets: secrets, login_log: [['at', 'username', 'ip_hash', 'result']] }, { PURCHASE_SVC_KEY: PURCHASE_KEY });
  env.sb.setupStaff();
  return { env, people, haveNs };
}

const has = (perms, p) => perms.includes('*') || perms.includes(p);
function expectAuth(person, ns, action, haveNs) {
  if (!person.active) return { code: 'BAD_TOKEN' };
  if (!haveNs.includes(ns)) return { code: 'UNKNOWN_NS' };
  const isWrite = !READ_ACTIONS[ns].includes(action);
  if (isWrite && !WRITE_ACTIONS[ns].includes(action)) return { code: 'FORBIDDEN' };
  let perms = person.perms.slice();
  if (ns === 'pnl') {
    if (has(perms, 'pnl.admin') && !has(perms, 'pnl.write')) perms.push('pnl.write');
    if (['finalize', 'unlock', 'saveSettings', 'createDraft', 'refreshConnectors', 'refreshFixed', 'loadGroupUnits'].includes(action) && !has(perms, 'pnl.admin')) return { code: 'FORBIDDEN' };
  }
  const canWrite = has(perms, ns + '.write'), canRead = has(perms, ns + '.read');
  if (isWrite ? !canWrite : !(canWrite || canRead)) return { code: 'FORBIDDEN' };
  const level = has(perms, 'pnl.admin') ? 'admin' : has(perms, 'pnl.write') ? 'write' : has(perms, 'pnl.read') ? 'read' : '';
  // 金鑰：有 <ns>.write（pnl.admin 隱含）→ write 碼；只有 .read → read 碼（pickSecretFor_）
  const secret = canWrite ? SECRET[ns] : (ns === 'pnl' ? 'FAKE-PNL-READ' : SECRET[ns]);
  return { ok: true, isWrite, operator: (person.name || person.uname) + '（' + person.uname + '）（管理系統）', level, account: person.uname, secret };
}

// ---------- 1. proxyAuthorize_ 隨機 400 組 ----------
{
  const { env, people, haveNs } = buildEnv();
  const sb = env.sb;
  const tokens = {};
  for (const p of people) { const r = post(sb, 'login', { username: p.uname, password: p.pw }); if (r.ok) tokens[p.uname] = r.data.token; else if (p.active) throw new Error('login 失敗 ' + p.uname + ' ' + r.error); }
  ok(people.filter((p) => !p.active).every((p) => !tokens[p.uname]), '1a: 停用帳號登入不了');
  let bad = [];
  let counts = { ok: 0, FORBIDDEN: 0, UNKNOWN_NS: 0, BAD_TOKEN: 0 };
  for (let i = 0; i < 400; i++) {
    const p = pick(people);
    const ns = pick(NS_ALL);
    const action = pick(READ_ACTIONS[ns].concat(WRITE_ACTIONS[ns], ['delete', 'adminLogin', 'wipeData', 'login', 'setSetting', '']));
    const tok = p.active ? tokens[p.uname] : 'garbage.' + ri(1, 1e6);
    const got = sb.proxyAuthorize_(tok, ns, action);
    const want = expectAuth(p, ns, action, haveNs);
    const s = JSON.stringify(got);
    let good;
    if (want.ok) {
      good = got.ok === true && got.secret === want.secret && got.isWrite === want.isWrite && got.operator === want.operator && got.filterNode === null
        && (ns !== 'pnl' || (got.level === want.level && got.account === want.account)) && (ns === 'pnl' || (got.level === undefined && got.account === undefined));
      counts.ok++;
    } else {
      good = got.ok === false && got.code === want.code && !Object.values(SECRET).some((x) => s.includes(x));
      counts[want.code] = (counts[want.code] || 0) + 1;
    }
    if (!good) bad.push({ user: p.uname, perms: p.perms, active: p.active, ns, action, got, want });
  }
  ok(bad.length === 0, `1b: proxyAuthorize_ 400 組隨機（帳號×ns×動作）＝規格：${JSON.stringify(counts)}`, bad.slice(0, 3));
  ok(counts.ok > 20 && counts.FORBIDDEN > 20, '1c: 抽樣有分層（放行與 FORBIDDEN 都夠多）', counts);
  // operator 不受姓名裡的全形括號影響的證據：account 永遠＝登入帳號
  const weird = people.find((p) => p.active && p.name === '（怪）名字' && (has(p.perms, 'pnl.write') || has(p.perms, 'pnl.admin')));
  if (weird && haveNs.includes('pnl')) {
    const r = sb.proxyAuthorize_(tokens[weird.uname], 'pnl', 'getMonth');
    ok(r.ok && r.account === weird.uname && r.operator === '（怪）名字（' + weird.uname + '）（管理系統）', '1d: 姓名含全形括號：影子帳號鍵 account 仍是登入帳號', r);
  }
  // proxyAuthorize_ 不可經 doPost 叫到
  const r = post(sb, 'proxyAuthorize_', { ns: 'cashbook', action: 'adminStores' }, tokens.BOSS);
  ok(r.ok === false && !JSON.stringify(r).includes(SECRET.cashbook), '1e: doPost 叫不到 proxyAuthorize_、回應不含金鑰');
}

// ---------- 2. 貨單入場券：ssoTicket aud purchase 隨機身分；一次性兌換；錯金鑰 ----------
{
  const { env, people } = buildEnv();
  const sb = env.sb;
  let bad = [];
  let issued = 0;
  for (const p of people.filter((x) => x.active)) {
    const tok = post(sb, 'login', { username: p.uname, password: p.pw }).data.token;
    const r = post(sb, 'ssoTicket', { aud: 'purchase' }, tok);
    const allowed = has(p.perms, 'platform.purchase');
    if (allowed) {
      if (!(r.ok && /^[0-9a-f]{64}$/.test(r.data.ticket) && r.data.expires_in === 60)) { bad.push({ p: p.uname, r }); continue; }
      issued++;
      // 兌換：錯金鑰 → unauthorized；對金鑰 → 身分；再兌換一次 → ticket_invalid
      const bad1 = post(sb, 'svcPurchaseRedeem', { svc_key: 'WRONG', ticket: r.data.ticket, aud: 'purchase' });
      const good = post(sb, 'svcPurchaseRedeem', { svc_key: PURCHASE_KEY, ticket: r.data.ticket, aud: 'purchase' });
      const again = post(sb, 'svcPurchaseRedeem', { svc_key: PURCHASE_KEY, ticket: r.data.ticket, aud: 'purchase' });
      const wantSub = 'U:' + p.id;
      if (!(bad1.ok === false && bad1.code === 'unauthorized')) bad.push({ p: p.uname, bad1 });
      if (!(good.ok && good.data.sub === wantSub && good.data.active === true && good.data.allowed === true && good.data.name === p.name && good.data.emp_no === '')) bad.push({ p: p.uname, good, wantSub });
      if (!(again.ok === false && again.code === 'ticket_invalid')) bad.push({ p: p.uname, again });
      const who = post(sb, 'svcPurchaseWho', { svc_key: PURCHASE_KEY, sub: wantSub });
      if (!(who.ok && who.data.allowed === true && who.data.active === true)) bad.push({ p: p.uname, who });
    } else if (!(r.ok === false && r.code === 'no_perm')) {
      bad.push({ p: p.uname, perms: p.perms, r });
    }
  }
  ok(bad.length === 0, `2a: ssoTicket{aud:purchase}：有 platform.purchase 才發券（發了 ${issued} 張）；錯金鑰 unauthorized；券只能兌一次；svcPurchaseWho 回 allowed`, bad.slice(0, 3));
  ok(post(sb, 'svcPurchaseRedeem', { svc_key: PURCHASE_KEY, ticket: 'f'.repeat(64), aud: 'purchase' }).code === 'ticket_invalid', '2b: 沒發過的券 → ticket_invalid');
  ok(post(sb, 'svcPurchaseRedeem', { svc_key: PURCHASE_KEY, ticket: 'f'.repeat(64), aud: 'store' }).code === 'bad_aud', '2c: aud 不是 purchase → bad_aud');
  ok(post(sb, 'svcPurchaseWho', { svc_key: PURCHASE_KEY, sub: 'garbage' }).code === 'bad_input', '2d: sub 格式錯 → bad_input');
  // 停用後 who 回 active:false
  const target = people.find((x) => x.active && has(x.perms, 'platform.purchase') && x.uname !== 'BOSS');
  if (target) {
    const rows = env.sheets.users._rows();
    const idx = rows.findIndex((r) => r[1] === target.uname);
    env.sheets.users.getRange(idx + 1, 8).setValue('FALSE');
    const who = post(sb, 'svcPurchaseWho', { svc_key: PURCHASE_KEY, sub: 'U:' + target.id });
    ok(who.ok && who.data.active === false, '2e: 帳號停用後 svcPurchaseWho → active:false（貨單後端會踢 session）', who);
  }
  ok(!READ_ACTIONS.platform.includes('svcPurchaseRedeem') && !READ_ACTIONS.platform.includes('svcPurchaseWho'), '2f: 兌換服務動作不在試跑讀取白名單（ssoTicket 刻意在：試跑也要能換券）');
}

// ---------- 3. Perms.gs：四模組權限碼、鎖碼、預設規則、標籤 ----------
{
  const { env } = buildEnv();
  const sb = env.sb;
  const codes = ['cashbook.write', 'transfer.write', 'pnl.read', 'pnl.write', 'pnl.admin', 'platform.purchase'];
  ok(codes.every((c) => sb.PERM_GRANTABLE.includes(c)), '3a: 六個財務權限碼都可給（PERM_GRANTABLE）', sb.PERM_GRANTABLE);
  ok(sb.PERM_LOCKED.includes('pnl.admin') && !sb.PERM_LOCKED.includes('cashbook.write') && !sb.PERM_LOCKED.includes('transfer.write') && !sb.PERM_LOCKED.includes('platform.purchase') && !sb.PERM_LOCKED.includes('pnl.write'), '3b: 只有 pnl.admin 是鎖碼（Eason 2026-10-27 改回：其餘四碼人資可開）', sb.PERM_LOCKED);
  const names = sb.PERM_NAMES || sb.PERM_LABELS || {};
  ok(names['cashbook.write'] === '收支管理' && names['platform.purchase'] === '貨單核對' && names['transfer.write'] === '調撥管理' && /損益/.test(names['pnl.write'] || ''), '3c: 中文名稱', names);
  // 預設規則：hq／fin／* 要含四碼（cashbook.write、platform.purchase、pnl.write、transfer.write）
  const rules = sb.PERM_DEFAULT_RULES || (typeof sb.permDefaultRules_ === 'function' ? sb.permDefaultRules_() : null);
  if (Array.isArray(rules)) {
    const finPerms = new Set();
    rules.forEach((r) => { const unit = r.unit || r[0], dept = r.dept || r[1], title = r.title || r[2], perms = r.perms || r[3]; if (unit === 'hq' && dept === 'fin' && title === '*') (Array.isArray(perms) ? perms : String(perms).split(',')).forEach((p) => finPerms.add(p)); });
    ok(['cashbook.write', 'platform.purchase', 'pnl.write', 'transfer.write'].every((p) => finPerms.has(p)) && !finPerms.has('pnl.admin') && !finPerms.has('pnl.read'), '3d: 財務部門預設規則有四模組（填損益不含管／看）', Array.from(finPerms));
  } else {
    ok(false, '3d: 找不到 PERM_DEFAULT_RULES 形狀', Object.keys(sb).filter((k) => /PERM/.test(k)));
  }
}

console.log(`\n共 ${passed + failed} 項，通過 ${passed}，失敗 ${failed}（E2E_SEED=${SEED}）`);
process.exit(failed ? 1 : 0);
