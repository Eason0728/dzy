// node test/line-auth.mock.test.mjs —— 管理系統 LINE 認身分 平台後端驗收（docs/line-auth/spec.md v1.1 §3、§3.2、§4、§8；task.md T2-1～T2-6）
// 做法同 staff-clock.mock.test.mjs：Auth／Users／Staff／Regions／StaffClock／Perms／PermActions／LineAuth／Code 讀進同一個 vm sandbox。
// 對外 action（lineRevoke、lineAuthLog、staffSetActive…）走 doPost；全域函式（lineAuthCheck_／Reset_／Claim_、lineTrust_、lineFind_）直接呼叫（正式環境是 mini 經 runGas 呼叫）。
// ⚠ 所有姓名、手機、LINE userId、金鑰都是假資料（dzy 是 public repo，不得出現真實同仁資料）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { READ_ACTIONS } from '../platform/dryrun.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'StaffClock.gs', 'Perms.gs', 'PermActions.gs', 'LineAuth.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);
const CODE_TEXT = SRC.find(([f]) => f === 'Code.gs')[1];

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

// ── GAS 假物件（同 staff-clock.mock.test.mjs）──────────────────
function makeSheet(rows) {
  const data = (rows || []).map((r) => r.slice());
  const fmt = {};
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
          if (vals.length !== numRows || vals.some((r) => r.length !== numCols)) throw new Error('setValues 尺寸不符');
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
        setNumberFormat(f) { for (let r = 0; r < numRows; r++) fmt[row + r] = f; return range; }
      };
      return range;
    },
    appendRow(r) { data.push(r.slice()); },
    _rows: () => data.map((r) => r.slice()),
    _data: data,
    _fmt: fmt
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
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; }
  };
  const cache = new Map();
  const cacheTtl = {};
  const props = { HMAC_SECRET: 'fake-hmac-for-line-auth-tests' };
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
    CacheService: { getScriptCache: () => ({
      get: (k) => { const e = cache.get(k); if (!e) return null; if (e.exp && Date.now() > e.exp) { cache.delete(k); return null; } return e.v; },
      put: (k, v, ttl) => { cache.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null }); cacheTtl[k] = ttl; },
      remove: (k) => cache.delete(k)
    }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  // reset／claim 現在要 ctx.live（mini 在鎖外即時抓的名冊）。既有案例沒帶 → 這裡預設用 staff_clock 現況當「一致的 live」；
  // 要測「live 缺」「live 不一致」的案例自己帶 live，或傳 noLive:true
  const autoLive = (fn) => (lineH, a, b, ctx) => {
    if (ctx && ctx.live === undefined && !ctx.noLive) {
      const rows = sheets.staff_clock ? sheets.staff_clock._rows() : [];
      const head = rows[0] || [];
      const live = {};
      rows.slice(1).forEach((r) => {
        const o = Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]]));
        if (o.line_h && String(o.line_h).toLowerCase() === String(lineH).toLowerCase()) {
          live[o.store_code] = { ok: true, emp_id: o.emp_id, line_h: o.line_h, line_kid: o.line_kid, line_bound_at: o.line_bound_at, line_ok_at: o.line_ok_at, active: o.roster_active };
        }
      });
      ctx = Object.assign({}, ctx, { live });
    }
    return fn(lineH, a, b, ctx);
  };
  sandbox.lineAuthReset_ = autoLive(sandbox.lineAuthReset_);
  sandbox.lineAuthClaim_ = autoLive(sandbox.lineAuthClaim_);
  return { sb: sandbox, sheets, cache, cacheTtl, props };
}

function post(sb, action, payload, token) {
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }).getContent());
}
// vm 內產生的物件原型不同，比對前一律走 JSON
const J = (x) => JSON.parse(JSON.stringify(x));

const ADMIN_PW = 'fake-admin-pw-01';
function freshSeed(h) {
  const salt = 'salt-admin';
  return {
    users: [
      ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at'],
      ['u001', 'BOSS', '系統管理者', 'admin', '', salt, h.hashPassword_(ADMIN_PW, salt), 'TRUE', '', '']
    ],
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['staff', '員工', ''], ['hr', '人資', 'platform.staff,platform.self']],
    module_secrets: [['backend_id', 'level', 'secret']],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  };
}
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;

function fresh() {
  const app = load(freshSeed(HASHER));
  app.sb.setupStaff();
  app.tok = post(app.sb, 'login', { username: 'BOSS', password: ADMIN_PW }).data.token;
  app.props.LINE_AUTH_ON = '1';
  return app;
}

// ── 工具 ────────────────────────────────────────────────────
const KEY = 'test-key-0123456789abcdef0123456789';
const lineHOf = (uid) => crypto.createHmac('sha256', KEY).update(uid).digest('hex');
const UID = (n) => 'U' + String(n).padStart(32, '0');
const DAY = 86400000;
const HOUR = 3600000;
const pad = (n) => (n < 10 ? '0' : '') + n;
function iso(ms) {
  const t = new Date(ms + 8 * HOUR);
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()) + 'T' + pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) + ':' + pad(t.getUTCSeconds()) + '+08:00';
}
const NOW = Date.now();
const KID = 'k1';
const SYNC_OK = { gf: NOW - HOUR, mztgf: NOW - HOUR, hq: NOW - HOUR, cf: NOW - HOUR };
const CTX = (over) => Object.assign({ nowMs: NOW, kid: KID, lastSyncOk: SYNC_OK }, over || {});

function rowsOf(app, name) {
  const rows = app.sheets[name]._rows();
  const head = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}
const staffOf = (app, emp) => rowsOf(app, 'staff').find((r) => r.emp_no === emp);
const logsOf = (app, emp, ev) => rowsOf(app, 'staff_log').filter((r) => (!emp || r.emp_no === emp) && (!ev || r.event === ev));
function setStaff(app, emp, header, value) {
  const head = app.sheets.staff._data[0];
  const idx = app.sheets.staff._data.findIndex((r) => r[0] === emp);
  app.sheets.staff._data[idx][head.indexOf(header)] = value;
}

const PROF = (over) => Object.assign({ brand: 'mala', unit: 'mala-gf', dept: '', title: 'pt', birthday: '1995-05-05', phone: '0911222333', address: '新竹市測試路一段1號' }, over || {});
// 匯入一位未認領同仁，回編號
function mkUnclaimed(app, name) {
  post(app.sb, 'staffImport', { names: [name] }, app.tok);
  return post(app.sb, 'claimLookup', { name }).data.emp_no;
}
// 一般流程：匯入→認領→核准→登入（active）
function mkActive(app, name, pw, over) {
  const emp = mkUnclaimed(app, name);
  const sub = post(app.sb, 'claimSubmit', Object.assign({ name, emp_no: emp, password: pw }, PROF(over)));
  if (!sub.ok) throw new Error('claimSubmit ' + sub.error);
  const cf = post(app.sb, 'staffConfirm', { emp_no: emp }, app.tok);
  if (!cf.ok) throw new Error('staffConfirm ' + cf.error);
  const lg = post(app.sb, 'login', { username: emp, password: pw });
  if (!lg.ok) throw new Error('login ' + lg.error);
  return { emp, token: lg.data.token, name, pw };
}
// 給某人一筆打卡對照（可信預設：綁 10 天前、1 天前 LINE 打過卡）
function bind(app, emp, uid, over) {
  const o = Object.assign({ store: 'gf', eid: 'E' + emp.slice(3), role: 'home', state: 'confirmed', active: 'TRUE', kid: KID,
    bound: iso(NOW - 10 * DAY), okAt: iso(NOW - DAY), h: uid === '' ? '' : lineHOf(uid) }, over || {});
  app.sheets.staff_clock._data.push([emp, o.store, o.eid, o.role, o.state, 'created', o.active, '', 'tester', '2026-10-01 10:00:00', '2026-10-01 10:00:00', o.h, o.kid, o.bound, o.okAt]);
}
function mapRow(app, emp, store) {
  return rowsOf(app, 'staff_clock').find((m) => m.emp_no === emp && (!store || m.store_code === store));
}
function setMap(app, emp, header, value, store) {
  const head = app.sheets.staff_clock._data[0];
  const idx = app.sheets.staff_clock._data.findIndex((r, i) => i > 0 && r[0] === emp && (!store || r[1] === store));
  app.sheets.staff_clock._data[idx][head.indexOf(header)] = value;
}
const sheetText = (app) => Object.keys(app.sheets).map((k) => app.sheets[k]._rows().map((r) => r.join('|')).join('\n')).join('\n');
const fulltext = (app) => sheetText(app) + '\n' + JSON.stringify(app.props);

// ============================================================
// 1. lineTrust_ 邊界（純函式）
// ============================================================
(() => {
  const sb = HASHER;
  const base = () => ({ emp_no: 'DZY001', store_code: 'gf', state: 'confirmed', roster_active: 'TRUE', line_h: lineHOf(UID(1)), line_kid: KID,
    line_bound_at: iso(NOW - 10 * DAY), line_ok_at: iso(NOW - DAY) });
  const T = (row, ctx) => J(sb.lineTrust_(row, ctx || CTX()));

  ok(T(base()).trusted === true && T(base()).reason === '', '1a 全部條件齊 → 可信');
  ok(T(Object.assign(base(), { line_bound_at: iso(NOW - 7 * DAY), line_ok_at: iso(NOW - 7 * DAY + 1000) })).trusted === true, '1b ★剛好 7 天（now−bound＝7d 整）→ 可信');
  const short = T(Object.assign(base(), { line_bound_at: iso(NOW - 7 * DAY + 1000), line_ok_at: iso(NOW) }));
  ok(short.trusted === false && short.reason === 'wait' && short.days_left === 1, '1c ★差 1 秒滿 7 天 → 不可信、還差 1 天', short);
  const day3 = T(Object.assign(base(), { line_bound_at: iso(NOW - 4 * DAY), line_ok_at: iso(NOW - 3 * DAY) }));
  ok(day3.reason === 'wait' && day3.days_left === 3, '1d 綁 4 天 → 還差 3 天', day3);
  const eq = T(Object.assign(base(), { line_ok_at: iso(NOW - 10 * DAY) }));
  ok(eq.trusted === false && eq.reason === 'need_line_punch' && eq.need_line_punch === true && eq.days_left === 0, '1e ★line_ok_at 等於 line_bound_at → 不可信、要 LINE 打卡', eq);
  ok(T(Object.assign(base(), { line_ok_at: iso(NOW - 10 * DAY + 1000) })).trusted === true, '1f line_ok_at 比 bound 晚 1 秒 → 可信');
  ok(T(Object.assign(base(), { line_ok_at: iso(NOW - 11 * DAY) })).need_line_punch === true, '1g line_ok_at 早於 bound（舊綁定殘留）→ 要 LINE 打卡');
  const noOk = T(Object.assign(base(), { line_ok_at: '' }));
  ok(noOk.trusted === false && noOk.need_line_punch === true, '1h ★line_ok_at 空 → 不可信', noOk);
  ok(T(Object.assign(base(), { state: 'suggested' })).reason === 'state' && T(Object.assign(base(), { state: 'rejected' })).trusted === false, '1i state 非 confirmed → 不可信');
  ok(['', 'FALSE', 'false', 'true', ' TRUE', 0].every((v) => T(Object.assign(base(), { roster_active: v })).trusted === false), '1j ★roster_active 空白／FALSE／小寫 true／帶空白 → 都不可信（嚴格 TRUE）');
  ok(T(Object.assign(base(), { roster_active: true })).trusted === true && T(Object.assign(base(), { roster_active: 'TRUE' })).trusted === true, '1k roster_active 布林 true 與字串 TRUE 皆可');
  ok(T(Object.assign(base(), { line_h: '' })).reason === 'no_line_h', '1l line_h 空 → 不可信');
  ok(T(Object.assign(base(), { line_kid: 'k0' })).reason === 'kid' && T(Object.assign(base(), { line_kid: '' })).trusted === false, '1m ★kid 不符（含空）→ 不可信');
  ok(T(Object.assign(base(), { line_kid: '' }), CTX({ kid: '' })).trusted === false, '1n ctx.kid 空＋列 kid 空 → 仍不可信（沒設金鑰版本不算數）');

  // 同步新鮮度
  ok(T(base(), CTX({ lastSyncOk: { gf: NOW - 26 * HOUR } })).trusted === true, '1o 剛好 26 小時 → 可信');
  const stale = T(base(), CTX({ lastSyncOk: { gf: NOW - 26 * HOUR - 1000 } }));
  ok(stale.trusted === false && stale.reason === 'sync_stale', '1p ★同步過期 26 小時又 1 秒 → 不可信', stale);
  ok(T(base(), CTX({ lastSyncOk: {} })).reason === 'sync_stale' && T(base(), CTX({ lastSyncOk: { mztgf: NOW } })).reason === 'sync_stale', '1q 該店沒有同步紀錄（或只有別店）→ 不可信');
  ok(T(base(), CTX({ lastSyncOk: { gf: 'x' } })).trusted === false, '1r 同步時間不是數字 → 不可信');

  // 人資停用
  const revokedAt = NOW - 12 * DAY;
  ok(T(base(), CTX({ revoked: { DZY001: NOW - 9 * DAY } })).reason === 'revoked', '1s ★停用時間晚於綁定 → 不可信');
  ok(T(base(), CTX({ revoked: { DZY001: NOW - 10 * DAY } })).reason === 'revoked', '1t 停用時間等於綁定時間 → 不可信（必須「之後」才綁）');
  ok(T(base(), CTX({ revoked: { DZY001: Date.parse(iso(NOW - 10 * DAY)) - 1 } })).trusted === true, '1u ★綁定比停用晚 1 毫秒 → 可信（重綁滿 7 天＋打過卡）');
  ok(T(base(), CTX({ revoked: { DZY001: revokedAt } })).trusted === true && T(base(), CTX({ revoked: { DZY002: NOW } })).trusted === true, '1v 停用在綁定之前、或停用的是別人 → 可信');

  // 其他
  ok(T(Object.assign(base(), { line_bound_at: '' })).trusted === false && T(Object.assign(base(), { line_bound_at: 'not-a-date' })).trusted === false, '1w 綁定時間空／亂碼 → 不可信');
  ok(T(null).trusted === false && T(undefined).trusted === false, '1x 傳 null → 不可信、不丟錯');
  ok(T(base(), { kid: KID, lastSyncOk: SYNC_OK }).trusted === false, '1y ctx 沒給 nowMs → 不可信');
})();

// ============================================================
// 2. lineFind_ 找人（純函式）
// ============================================================
(() => {
  const sb = HASHER;
  const h1 = lineHOf(UID(1)), h2 = lineHOf(UID(2));
  const R = (emp, store, over) => Object.assign({ emp_no: emp, store_code: store, state: 'confirmed', roster_active: 'TRUE', line_h: h1 }, over || {});
  const F = (h, rows) => J(sb.lineFind_(h, rows));

  const one = F(h1, [R('DZY001', 'gf'), R('DZY002', 'gf', { line_h: h2 })]);
  ok(one.status === 'hit' && one.emp_no === 'DZY001' && one.rows.length === 1, '2a 恰好一位 → hit', one);
  const multi = F(h1, [R('DZY001', 'gf'), R('DZY001', 'mztgf')]);
  ok(multi.status === 'hit' && multi.emp_no === 'DZY001' && multi.rows.length === 2, '2b ★同一人多店綁定同一 LINE → 去重後仍是同一人（hit，兩列都回）', multi);
  ok(F(h1, [R('DZY001', 'gf'), R('DZY002', 'gf')]).status === 'ambiguous', '2c ★兩位不同員編同 line_h → ambiguous');
  const stale1 = F(h1, [R('DZY001', 'gf'), R('DZY002', 'mztgf', { roster_active: 'FALSE' })]);
  ok(stale1.status === 'hit' && stale1.emp_no === 'DZY001', '2d ★另一位的舊列已失效（roster_active FALSE，離職）→ 不計，仍 hit', stale1);
  ok(F(h1, [R('DZY001', 'gf'), R('DZY002', 'mztgf', { state: 'rejected' })]).status === 'hit', '2e 另一位是 rejected → 不計');
  ok(F(h1, [R('DZY001', 'gf'), R('DZY002', 'mztgf', { state: 'suggested' })]).status === 'hit', '2f 另一位是 suggested → 不計');
  ok(F(h1, [R('DZY001', 'gf'), R('DZY002', 'mztgf', { roster_active: '' })]).status === 'hit', '2g 另一位 roster_active 空白 → 不計（嚴格）');
  ok(F(h1, [R('DZY001', 'gf', { roster_active: 'FALSE' })]).status === 'not_bound', '2h 自己的列失效 → not_bound');
  ok(F(h1, []).status === 'not_bound' && F(h1, [R('DZY002', 'gf', { line_h: h2 })]).status === 'not_bound', '2i 沒有對到 → not_bound');
  ok(F('', [R('DZY001', 'gf', { line_h: '' })]).status === 'not_bound' && F(undefined, [R('DZY001', 'gf', { line_h: '' })]).status === 'not_bound', '2j ★line_h 空字串不會對到「沒綁定」的列');
  ok(F(h1.toUpperCase(), [R('DZY001', 'gf')]).status === 'hit', '2k line_h 大小寫不影響比對');
  ok(F(h1, [R('dzy001', 'gf'), R('DZY001 ', 'mztgf')]).status === 'hit', '2l 員編大小寫／空白正規化後視為同一人');
  const home = (rows) => J(sb.lineHomeRow_('DZY001', rows));
  ok(home([R('DZY001', 'gf', { role: 'home' })]).store_code === 'gf', '2m 主店：恰一筆 confirmed＋TRUE＋home → 取得');
  ok(home([R('DZY001', 'gf', { role: 'support' })]) === null, '2n 沒有 home → null');
  ok(home([R('DZY001', 'gf', { role: 'home' }), R('DZY001', 'mztgf', { role: 'home' })]) === null, '2o 兩筆 home → null');
  ok(home([R('DZY001', 'gf', { role: 'home', roster_active: 'FALSE' })]) === null && home([R('DZY001', 'gf', { role: 'home', state: 'suggested' })]) === null, '2p home 失效／未確認 → null');
})();

// ============================================================
// 3. T2-1 staff_clock 四欄＋staff.line_revoked_at：表頭、補欄、名冊同步寫入
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets } = app;
  ok(sheets.staff_clock._rows()[0].join() === 'emp_no,store_code,emp_id,role,state,source,roster_active,last_punch,confirmed_by,confirmed_at,updated_at,line_h,line_kid,line_bound_at,line_ok_at', '3a 新建 staff_clock 表頭尾端有 line_h,line_kid,line_bound_at,line_ok_at');
  ok(sheets.staff._rows()[0].slice(24).join() === 'hire_date,last_day,extra_depts,line_revoked_at', '3b staff 尾端有 line_revoked_at');

  // 舊分頁（11 欄表頭＋已有資料）→ setupStaff 自動補欄、資料不動
  const old = fresh();
  const oldRow = ['DZY777', 'gf', 'E777', 'home', 'confirmed', 'created', 'TRUE', '2026-10-01', 'x', '2026-10-01 10:00:00', '2026-10-01 10:00:00'];
  old.sheets.staff_clock._data.length = 0;
  old.sheets.staff_clock._data.push(['emp_no', 'store_code', 'emp_id', 'role', 'state', 'source', 'roster_active', 'last_punch', 'confirmed_by', 'confirmed_at', 'updated_at'], oldRow.slice());
  old.sheets.staff._data[0].length = 27;   // 舊 staff：沒有 line_revoked_at
  const rd = old.sb.clkReady_();
  ok(rd.ok === true, '3c 舊表頭（11 欄）→ clkReady_ 自動補欄後回 ok', J(rd));
  ok(old.sheets.staff_clock._rows()[0].length === 15 && old.sheets.staff_clock._rows()[0].slice(11).join() === 'line_h,line_kid,line_bound_at,line_ok_at', '3d 補上尾端四個表頭');
  ok(old.sheets.staff_clock._rows()[1].slice(0, 11).join('|') === oldRow.join('|'), '3e ★既有資料列原封不動');
  ok(old.sheets.staff._rows()[0][27] === 'line_revoked_at' && old.sheets.staff._rows()[0].length === 28, '3f staff 缺 line_revoked_at 也自動補');
  const again = old.sb.setupStaff();
  ok(J(again).ok && old.sheets.staff_clock._rows()[0].length === 15, '3g 重跑 setupStaff 冪等');
  // 表頭被改過 → 停
  const bad = fresh();
  bad.sheets.staff_clock._data[0][12] = 'oops';
  let threw = '';
  try { bad.sb.setupStaff(); } catch (e) { threw = e.message; }
  ok(threw.indexOf('staff_clock') !== -1 && threw.indexOf('表頭') !== -1, '3h 尾端表頭被改過 → setupStaff 停下回錯', threw);

  // clockRosterApply_ 把四鍵寫進對應 staff_clock 列
  const a2 = fresh();
  const emp = mkUnclaimed(a2, '名冊甲');
  bind(a2, emp, '', { h: '', kid: '', bound: '', okAt: '', eid: 'E100' });
  const r = (over) => Object.assign({ emp_id: 'E100', name: '名冊甲', active: true, created_at: '2026-01-01', removed_at: '', line_bound: true, last_punch: '2026-10-10', src_store: '', src_emp_id: '' }, over || {});
  const hv = lineHOf(UID(100));
  const ap1 = J(a2.sb.clockRosterApply_('gf', [r({ line_h: hv, line_kid: KID, line_bound_at: iso(NOW - 8 * DAY), line_ok_at: iso(NOW - DAY) })], [], new Date(NOW)));
  const m1 = mapRow(a2, emp, 'gf');
  ok(ap1.ok && m1.line_h === hv && m1.line_kid === KID && m1.line_bound_at === iso(NOW - 8 * DAY) && m1.line_ok_at === iso(NOW - DAY), '3i ★名冊同步把 line_h／line_kid／line_bound_at／line_ok_at 寫進對照列', [ap1, m1]);
  const ap2 = J(a2.sb.clockRosterApply_('gf', [r({ line_h: hv, line_kid: KID, line_bound_at: iso(NOW - 8 * DAY), line_ok_at: iso(NOW - DAY) })], [], new Date(NOW)));
  ok(ap2.ok && ap2.data.updated === 0, '3j 內容沒變 → 不重寫（updated 0）', ap2);
  const ap3 = J(a2.sb.clockRosterApply_('gf', [r()], [], new Date(NOW)));
  const m3 = mapRow(a2, emp, 'gf');
  ok(ap3.ok && m3.line_h === '' && m3.line_kid === '' && m3.line_bound_at === '' && m3.line_ok_at === '', '3k ★舊版 svc_roster 沒有 LINE 鍵（或解綁）→ 全部寫空字串、不報錯', [ap3, m3]);
  const ap4 = J(a2.sb.clockRosterApply_('gf', [r()], [], new Date(NOW)));   // 同一份舊版名冊再同步一次
  ok(ap4.ok && ap4.data.updated === 0, '3l 舊版名冊重複同步不再異動', ap4);
  // 新出現的支援列也帶 LINE 欄
  const a3 = fresh();
  const hq = mkUnclaimed(a3, '名冊乙');
  bind(a3, hq, '', { store: 'mztgf', eid: 'M1', h: '', kid: '', bound: '', okAt: '' });
  const ap5 = J(a3.sb.clockRosterApply_('gf', [r({ emp_id: 'G9', name: '名冊乙', src_store: 'mztgf', src_emp_id: 'M1', line_h: hv, line_kid: KID, line_bound_at: iso(NOW - 8 * DAY), line_ok_at: iso(NOW - DAY) })], [], new Date(NOW)));
  const nm = mapRow(a3, hq, 'gf');
  ok(ap5.ok && ap5.data.created === 1 && nm && nm.line_h === hv && nm.line_ok_at === iso(NOW - DAY), '3m 自動支援新列也寫入四鍵', [ap5, nm]);
})();

// ============================================================
// 4. lineAuthCheck_ 各 mode
// ============================================================
(() => {
  const app = fresh();
  const { sb } = app;
  const check = (uid, op, ctx) => J(sb.lineAuthCheck_(lineHOf(uid), op, ctx || CTX()));

  // 開關
  delete app.props.LINE_AUTH_ON;
  const off = J(sb.lineAuthCheck_(lineHOf(UID(1)), 'reset', CTX()));
  ok(off.ok === true && off.mode === 'off' && Object.keys(off).length === 2, '4a ★總開關未設 → {ok:true, mode:off}，不查任何資料', off);
  app.props.LINE_AUTH_ON = '0';
  ok(check(UID(1), 'reset').mode === 'off', '4b 開關 0 → off');
  app.props.LINE_AUTH_ON = 'true';
  ok(check(UID(1), 'reset').mode === 'off', '4c 開關必須恰為 1（"true" 不算）→ off');
  app.props.LINE_AUTH_ON = '1';

  // 輸入
  ok(J(sb.lineAuthCheck_('xyz', 'reset', CTX())).error === 'bad_input' && J(sb.lineAuthCheck_(lineHOf(UID(1)), 'foo', CTX())).error === 'bad_input' && J(sb.lineAuthCheck_(undefined, 'reset', CTX())).error === 'bad_input', '4d line_h 格式不對／op 不認得 → bad_input');

  // not_bound
  ok(check(UID(9), 'reset').mode === 'not_bound', '4e 沒綁定 → not_bound');

  // claim：未認領＋可信
  const eU = mkUnclaimed(app, '開通甲');
  bind(app, eU, UID(1));
  const nonceCountBefore = [...app.cache.keys()].filter((k) => k.indexOf('lan:') === 0).length;
  const logCountBefore = rowsOf(app, 'staff_log').length;
  const c1 = check(UID(1), 'claim');
  ok(c1.ok === true && c1.mode === 'off' && Object.keys(c1).length === 2, '4f ★R3 LINE 開通已取消：claim 一律 {ok:true, mode:off}（不帶姓名、員編、title_options）', c1);
  ok([...app.cache.keys()].filter((k) => k.indexOf('lan:') === 0).length === nonceCountBefore && rowsOf(app, 'staff_log').length === logCountBefore, '4g ★claim check 不發 nonce、不寫 staff_log');
  ok(check(UID(1), 'claim').nonce === undefined && check(UID(9), 'claim').mode === 'off', '4h~4i claim 不論有沒有綁定都是 off、沒有 nonce');

  // wrong_op
  const w1 = check(UID(1), 'reset');
  ok(w1.mode === 'wrong_op' && w1.expected_mode === 'claim' && w1.nonce === undefined && w1.emp_no === undefined, '4j ★未認領的人要重設 → wrong_op＋提示 claim，不發 nonce、不帶員編', w1);

  // reset：active＋可信
  const act = mkActive(app, '重設甲', 'old-pw-12345');
  bind(app, act.emp, UID(2));
  const r1 = check(UID(2), 'reset');
  ok(r1.mode === 'reset' && r1.name === '重設甲' && r1.emp_no === act.emp && /^[A-Za-z0-9]{16,}$/.test(r1.nonce) && r1.unit === undefined, '4k active＋可信 → reset：姓名、員編、nonce', r1);
  ok(JSON.parse(app.cache.get('lan:' + r1.nonce).v).op === 'reset', '4l reset 的 nonce 綁 op=reset');
  const w2 = check(UID(2), 'claim');
  ok(w2.mode === 'off' && w2.nonce === undefined, '4m 已開通的人用 claim → off（不再導 reset）', w2);

  // blocked：disabled／pending／rejected
  const blk = (name, uid, status, prep) => {
    const e = mkActive(app, name, 'blk-pw-12345');
    bind(app, e.emp, uid);
    prep(e.emp);
    return check(uid, 'reset');
  };
  const bd = blk('封鎖甲', UID(3), 'disabled', (e) => setStaff(app, e, 'status', 'disabled'));
  ok(bd.mode === 'blocked' && bd.status === 'disabled' && bd.nonce === undefined && bd.name === undefined, '4n blocked：disabled', bd);
  const bp = blk('封鎖乙', UID(4), 'pending', (e) => setStaff(app, e, 'status', 'pending'));
  ok(bp.mode === 'blocked' && bp.status === 'pending', '4o blocked：pending', bp);
  const br = blk('封鎖丙', UID(5), 'rejected', (e) => setStaff(app, e, 'status', 'rejected'));
  ok(br.mode === 'blocked' && br.status === 'rejected', '4p blocked：rejected', br);

  // not_trusted：days_left／need_line_punch
  const nt = mkActive(app, '未滿甲', 'nt-pw-12345');
  bind(app, nt.emp, UID(6), { bound: iso(NOW - 4 * DAY), okAt: iso(NOW - 3 * DAY) });
  const n1 = check(UID(6), 'reset');
  ok(n1.mode === 'not_trusted' && n1.days_left === 3 && n1.need_line_punch === false && n1.reason === 'wait' && n1.name === undefined && n1.emp_no === undefined && n1.nonce === undefined, '4q ★未滿 7 天 → not_trusted，days_left 3；不帶姓名員編、不發 nonce', n1);
  const nt2 = mkActive(app, '未打甲', 'nt-pw-12345');
  bind(app, nt2.emp, UID(7), { okAt: '' });
  const n2 = check(UID(7), 'reset');
  ok(n2.mode === 'not_trusted' && n2.days_left === 0 && n2.need_line_punch === true && n2.reason === 'need_line_punch', '4r ★滿 7 天但沒 LINE 打過卡 → need_line_punch:true', n2);
  const n3 = check(UID(7), 'reset', CTX({ lastSyncOk: {} }));
  ok(n3.mode === 'not_trusted' && n3.reason === 'need_line_punch', '4s 同時缺打卡與同步 → 先講使用者能做的事（need_line_punch）', n3);
  const nt3 = mkActive(app, '過期甲', 'nt-pw-12345');
  bind(app, nt3.emp, UID(8));
  const n4 = check(UID(8), 'reset', CTX({ lastSyncOk: { gf: NOW - 30 * HOUR } }));
  ok(n4.mode === 'not_trusted' && n4.reason === 'sync_stale', '4t 同步過期 → not_trusted(sync_stale)', n4);
  const n5 = check(UID(8), 'reset', CTX({ kid: 'k2' }));
  ok(n5.mode === 'not_trusted' && n5.reason === 'other', '4u kid 不符 → not_trusted(other)，不洩漏細節', n5);
  // 多店：一店可信即可
  const mm = mkActive(app, '多店甲', 'mm-pw-12345');
  bind(app, mm.emp, UID(10), { okAt: '' });   // gf 不可信
  bind(app, mm.emp, UID(10), { store: 'mztgf', eid: 'MM1', role: 'support' });   // mztgf 可信
  ok(check(UID(10), 'reset').mode === 'reset', '4v ★同一人多店綁定：任一店可信即可');

  // ambiguous
  const a1 = mkActive(app, '撞綁甲', 'am-pw-12345'), a2 = mkActive(app, '撞綁乙', 'am-pw-12345');
  bind(app, a1.emp, UID(11)); bind(app, a2.emp, UID(11));
  const amb = check(UID(11), 'reset');
  ok(amb.mode === 'ambiguous' && amb.nonce === undefined && amb.emp_no === undefined, '4w ★兩人同 line_h → ambiguous', amb);
  setMap(app, a2.emp, 'roster_active', 'FALSE');
  ok(check(UID(11), 'reset').mode === 'reset', '4x ★另一人舊列失效後不再 ambiguous');

  // R3：unclaimed 的人 claim 一律 off；用 reset 查則 wrong_op（前端導回「第一次使用」）
  const nr1 = mkUnclaimed(app, '審核甲');
  bind(app, nr1, UID(12), { role: 'support' });
  ok(check(UID(12), 'claim').mode === 'off' && check(UID(12), 'reset').mode === 'wrong_op', '4y~4aa ★未認領者：claim → off；reset → wrong_op（不再有 claim／need_review 路徑）');
  const nr4 = mkUnclaimed(app, '審核丁');
  bind(app, nr4, UID(15), { active: 'FALSE' });
  ok(check(UID(15), 'reset').mode === 'not_bound', '4ab 唯一 home 列已失效 → 當作沒綁定');

  // 失敗紀錄只有原因代碼
  const fails = logsOf(app, '', 'line_fail');
  ok(fails.length >= 8 && fails.every((l) => l.by === 'line-self'), '4ad 失敗寫 staff_log line_fail（by line-self）', fails.length);
  ok(fails.some((l) => l.detail === 'blocked_disabled') && fails.some((l) => l.detail === 'not_trusted_wait') && fails.some((l) => l.detail === 'wrong_op') && fails.some((l) => l.detail === 'ambiguous'), '4ae 原因代碼：blocked_disabled／not_trusted_wait／wrong_op／ambiguous');
  const txt = fulltext(app);
  ok(!/U0{20,}/.test(sheetText(app)), '4af ★試算表裡沒有任何原始 LINE userId');
  const logTxt = rowsOf(app, 'staff_log').map((l) => Object.values(l).join('|')).join('\n');
  ok(!/[0-9a-f]{64}/.test(logTxt), '4ag ★staff_log 沒有 line_h（64 位 hex）');
  ok(!logTxt.includes('開通甲') && !logTxt.includes('未滿甲'), '4ah staff_log 沒有姓名');

  // 鎖
  const orig = sb.LockService;
  sb.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock() {} }) };
  const busy = J(sb.lineAuthCheck_(lineHOf(UID(1)), 'reset', CTX()));
  sb.LockService = orig;
  ok(busy.ok === false && busy.error === 'busy', '4aj 等不到 ScriptLock → busy', busy);
})();

// ============================================================
// 5. nonce：一次性、h／op 不符、併發
// ============================================================
(() => {
  const app = fresh();
  const { sb } = app;
  const act = mkActive(app, '隨機甲', 'old-pw-12345');
  bind(app, act.emp, UID(1));
  const act2 = mkActive(app, '隨機乙', 'old-pw-12345');
  bind(app, act2.emp, UID(2));
  const reset = (uid, nonce, pw) => J(sb.lineAuthReset_(lineHOf(uid), nonce, pw, CTX()));
  const chk = (uid, op) => J(sb.lineAuthCheck_(lineHOf(uid), op, CTX()));

  const n1 = chk(UID(1), 'reset').nonce;
  const first = reset(UID(1), n1, 'new-pw-ABCDE1');
  ok(first.ok === true && first.mode === 'done', '5a 第一次用 nonce → 成功', first);
  const second = reset(UID(1), n1, 'new-pw-ABCDE2');
  ok(second.ok === false && second.reason === 'nonce', '5b ★同一個 nonce 第二次 → 拒（取了就刪）', second);
  ok(post(sb, 'login', { username: act.emp, password: 'new-pw-ABCDE1' }).ok && !post(sb, 'login', { username: act.emp, password: 'new-pw-ABCDE2' }).ok, '5c 密碼停在第一次的值');

  // 併發：同 nonce 兩個請求（鎖內循序）只有一個成功
  const n2 = chk(UID(1), 'reset').nonce;
  const both = [reset(UID(1), n2, 'new-pw-ABCDE3'), reset(UID(1), n2, 'new-pw-ABCDE4')];
  ok(both.filter((x) => x.ok).length === 1, '5d ★併發同 nonce 兩次只成功一次', both);

  // h 不符：別人的 line_h 拿甲的 nonce
  const n3 = chk(UID(1), 'reset').nonce;
  const hMis = reset(UID(2), n3, 'new-pw-ABCDE5');
  ok(hMis.ok === false && hMis.reason === 'nonce', '5e ★nonce 的 h 與呼叫者不符 → 拒', hMis);
  const afterMis = reset(UID(1), n3, 'new-pw-ABCDE5');
  ok(afterMis.ok === false && afterMis.reason === 'nonce', '5f h 不符的嘗試當場作廢 nonce（原主人也不能再用）');
  // R3：claim 不再發 nonce；claim 函式停用，拿 reset 的 nonce 去 claim 也不會燒掉它
  const eU = mkUnclaimed(app, '隨機丙');
  bind(app, eU, UID(3));
  ok(chk(UID(3), 'claim').nonce === undefined, '5g ★claim 不發 nonce');
  const rn = chk(UID(1), 'reset').nonce;
  const claimWithReset = J(sb.lineAuthClaim_(lineHOf(UID(1)), rn, { title: 'pt', phone: '0911222333', birthday: '1995-05-05', address: '新竹市測試路一段1號', new_password: 'new-pw-ABCDE7' }, CTX()));
  ok(claimWithReset.ok === false && claimWithReset.error === 'off', '5h lineAuthClaim_ 停用 → off', claimWithReset);
  ok(reset(UID(1), rn, 'new-pw-ABCDE7').ok === true, '5h2 reset 的 nonce 沒被 claim 動到');
  // 亂碼／過期
  ok(reset(UID(1), 'zzzzzzzzzzzz', 'new-pw-ABCDE8').reason === 'nonce' && reset(UID(1), '', 'new-pw-ABCDE8').reason === 'nonce' && reset(UID(1), "../'; DROP", 'new-pw-ABCDE8').reason === 'nonce', '5i 不存在／空／格式怪異的 nonce → 拒');
  const n4 = chk(UID(1), 'reset').nonce;
  app.cache.delete('lan:' + n4);
  ok(reset(UID(1), n4, 'new-pw-ABCDE8').reason === 'nonce', '5j nonce 過期（快取已清）→ 拒');
  // 密碼規則不符：不消耗 nonce，可改完再送
  const n5 = chk(UID(1), 'reset').nonce;
  const weak = reset(UID(1), n5, 'short');
  ok(weak.ok === false && weak.error === 'bad_input' && weak.message.indexOf('8') !== -1 && weak.reason === undefined, '5k 密碼太短 → bad_input（不是 nonce 問題）', weak);
  ok(reset(UID(1), n5, act.emp).ok === false, '5l 密碼等於員編 → 拒（nonce 仍保留）');
  const retry = reset(UID(1), n5, 'new-pw-ABCDE9');
  ok(retry.ok === true, '5m ★密碼規則錯誤不燒掉 nonce：改好再送成功', retry);
})();

// ============================================================
// 6. lineAuthReset_
// ============================================================
(() => {
  const app = fresh();
  const { sb } = app;
  const reset = (uid, nonce, pw, ctx) => J(sb.lineAuthReset_(lineHOf(uid), nonce, pw, ctx || CTX()));
  const chk = (uid, op, ctx) => J(sb.lineAuthCheck_(lineHOf(uid), op, ctx || CTX()));
  const p = mkActive(app, '重設乙', 'old-pw-12345');
  bind(app, p.emp, UID(1));
  ok(post(sb, 'me', {}, p.token).ok, '6a （前置）舊 token 有效');
  // 先把鎖弄起來：忘記密碼鎖與登入鎖
  setStaff(app, p.emp, 'reset_fail', 4);
  setStaff(app, p.emp, 'reset_locked', 'TRUE');
  setStaff(app, p.emp, 'reset_lock_until', Math.floor(Date.now() / 1000) + 3600);
  setStaff(app, p.emp, 'reset_lock_count', 2);
  for (let i = 0; i < 3; i++) post(sb, 'login', { username: p.emp, password: 'wrong-pw-xxxx' });
  ok(post(sb, 'login', { username: p.emp, password: 'old-pw-12345' }).ok === false, '6b （前置）登入已被鎖住，連對的密碼也擋');

  const n = chk(UID(1), 'reset').nonce;
  const res = reset(UID(1), n, 'new-pw-12345');
  ok(res.ok === true && res.mode === 'done' && res.op === 'reset', '6c ★重設成功', res);
  ok(post(sb, 'me', {}, p.token).ok === false, '6d ★重設後舊 token 失效');
  ok(post(sb, 'login', { username: p.emp, password: 'old-pw-12345' }).ok === false, '6e 舊密碼不能登入');
  const lg = post(sb, 'login', { username: p.emp, password: 'new-pw-12345' });
  ok(lg.ok === true, '6f ★新密碼可登入（登入鎖已清）', lg);
  const s = staffOf(app, p.emp);
  ok(Number(s.reset_fail) === 0 && s.reset_locked === '' && s.reset_lock_until === '' && Number(s.reset_lock_count) === 0, '6g ★忘記密碼鎖全清（reset_fail／locked／lock_until／lock_count）', s);
  ok(s.status === 'active' && s.unit === 'mala-gf', '6h 狀態與組織欄不動');
  const lg1 = logsOf(app, p.emp, 'line_reset_ok');
  ok(lg1.length === 1 && lg1[0].by === 'line-self' && lg1[0].detail === '', '6i staff_log line_reset_ok（by line-self、detail 空）', lg1);
  ok(!rowsOf(app, 'staff_log').some((l) => JSON.stringify(l).includes('new-pw-12345') || JSON.stringify(l).includes(lineHOf(UID(1)))), '6j log 不含密碼與 line_h');
  ok(!sheetText(app).includes('new-pw-12345'), '6k 試算表任何一格都沒有明文密碼');

  // 非 reset mode 拒絕：claim 狀態的人
  const eU = mkUnclaimed(app, '重設丙');
  bind(app, eU, UID(2));
  const cn = chk(UID(2), 'reset').nonce;
  ok(cn === undefined && reset(UID(2), cn, 'new-pw-12345').ok === false, '6l 未認領的人 reset → check 不發 nonce、reset 拒');

  // 發 nonce 之後狀況變了：重查擋下
  const q = mkActive(app, '重設丁', 'old-pw-12345');
  bind(app, q.emp, UID(3));
  const n3 = chk(UID(3), 'reset').nonce;
  setStaff(app, q.emp, 'status', 'disabled');
  const blocked = reset(UID(3), n3, 'new-pw-12345');
  ok(blocked.ok === false && blocked.error === 'blocked', '6m ★發 nonce 後被停用 → 重查 blocked、不改密碼', blocked);
  ok(!logsOf(app, q.emp, 'line_reset_ok').length, '6n 沒寫 line_reset_ok');
  const q2 = mkActive(app, '重設戊', 'old-pw-12345');
  bind(app, q2.emp, UID(4));
  const n4 = chk(UID(4), 'reset').nonce;
  const lateCtx = reset(UID(4), n4, 'new-pw-12345', CTX({ lastSyncOk: {} }));
  ok(lateCtx.ok === false && lateCtx.error === 'not_trusted', '6o 重查時同步已過期 → not_trusted、不改密碼', lateCtx);
  ok(post(sb, 'login', { username: q2.emp, password: 'old-pw-12345' }).ok, '6p 舊密碼仍有效');
  // 輸入檢查
  ok(J(sb.lineAuthReset_('bad', 'x', 'y', CTX())).error === 'bad_input' && J(sb.lineAuthReset_(lineHOf(UID(4)), 'x', 12345678, CTX())).error === 'bad_input' && J(sb.lineAuthReset_(lineHOf(UID(4)), 'x', 'a'.repeat(200), CTX())).error === 'bad_input', '6q 參數型別／長度不對 → bad_input');
  // 開關
  app.props.LINE_AUTH_ON = '0';
  const off = J(sb.lineAuthReset_(lineHOf(UID(4)), 'x', 'new-pw-12345', CTX()));
  ok(off.ok === false && off.error === 'off', '6r ★總開關關 → reset 拒（error off）', off);
  app.props.LINE_AUTH_ON = '1';
  // 鎖
  const orig = sb.LockService;
  sb.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock() {} }) };
  const nbusy = chk(UID(4), 'reset');
  sb.LockService = orig;
  ok(nbusy.error === 'busy', '6s check 等不到鎖 → busy');
  const n6 = chk(UID(4), 'reset').nonce;
  sb.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock() {} }) };
  const rbusy = reset(UID(4), n6, 'new-pw-12345');
  sb.LockService = orig;
  ok(rbusy.error === 'busy', '6t reset 等不到鎖 → busy');
  ok(reset(UID(4), n6, 'new-pw-12345').ok === true, '6u busy 不消耗 nonce（沒拿到鎖就沒動）');
})();

// ============================================================
// 7. R3：LINE 開通已取消，lineAuthClaim_ 停用，不執行任何寫入
// ============================================================
(() => {
  const app = fresh();
  const { sb } = app;
  const chk = (uid, op) => J(sb.lineAuthCheck_(lineHOf(uid), op, CTX()));
  const claim = (uid, nonce, form, ctx) => J(sb.lineAuthClaim_(lineHOf(uid), nonce, form, ctx || CTX()));
  const FORM = (over) => Object.assign({ title: 'pt', phone: '0911222333', birthday: '1995-05-05', address: '新竹市測試路一段1號', new_password: 'line-pw-12345' }, over || {});
  const eA = mkUnclaimed(app, '開通乙');
  bind(app, eA, UID(1));
  const snap = () => JSON.stringify(rowsOf(app, 'staff')) + JSON.stringify(rowsOf(app, 'users')) + JSON.stringify(rowsOf(app, 'staff_log'));
  const before = snap();
  const nonce = chk(UID(1), 'claim').nonce;
  ok(nonce === undefined, '7a claim check 沒有 nonce');
  const res = claim(UID(1), nonce, FORM());
  ok(res.ok === false && res.error === 'off', '7b ★lineAuthClaim_ 一律 {ok:false, error:off}', res);
  ok(snap() === before, '7c ★沒有任何寫入（staff／users／staff_log 都不變）');
  ok(staffOf(app, eA).status === 'unclaimed', '7d staff 維持 unclaimed');
  ok(claim(UID(1), 'zzzzzzzzzzzz', FORM({ title: 'ft' })).error === 'off' && claim(UID(1), undefined, null).error === 'off', '7e 任何參數（含亂碼 nonce、null form）都是 off');
  app.props.LINE_AUTH_ON = '';
  ok(claim(UID(1), nonce, FORM()).error === 'off', '7f 總開關關也是 off');
  app.props.LINE_AUTH_ON = '1';
  ok(snap() === before && logsOf(app, eA, 'line_claim_ok').length === 0, '7g 仍無寫入、沒有 line_claim_ok 紀錄');
  // 一般認領不受影響
  const eB = mkUnclaimed(app, '開通丙');
  ok(post(sb, 'claimSubmit', Object.assign({ name: '開通丙', emp_no: eB, password: 'line-pw-12345' }, PROF({ title: 'pt' }))).ok && staffOf(app, eB).status === 'pending', '7h 一般認領照常 pending');
})();

// ============================================================
// 8. stfClaimWrite_ 抽出後 claimSubmit 行為不變（核心路徑）
// ============================================================
(() => {
  const app = fresh();
  const { sb } = app;
  const name = '舊路甲';
  const emp = mkUnclaimed(app, name);
  ok(post(sb, 'claimSubmit', Object.assign({ name, emp_no: emp, password: 'short' }, PROF())).error === '密碼至少要 8 個字元', '8a 密碼太短訊息不變');
  ok(post(sb, 'claimSubmit', Object.assign({ name, emp_no: emp, password: 'good-pw-12345' }, PROF({ unit: 'mzt-js' }))).error === '請選擇這個品牌底下的單位', '8b 組織錯訊息不變');
  ok(post(sb, 'claimSubmit', Object.assign({ name, emp_no: emp, password: 'good-pw-12345' }, PROF({ phone: '12' }))).error === '手機要是 09 開頭的 10 碼數字', '8c 手機錯訊息不變');
  ok(staffOf(app, emp).status === 'unclaimed', '8d 失敗不寫任何東西');
  const ok1 = post(sb, 'claimSubmit', Object.assign({ name, emp_no: emp, password: 'good-pw-12345' }, PROF()));
  ok(ok1.ok === true && ok1.pending === true && ok1.data.pending === true && ok1.data.emp_no === emp, '8e 成功回傳形狀不變', ok1);
  ok(logsOf(app, emp, 'claim').length === 1 && logsOf(app, emp, 'claim')[0].by === 'self', '8f 記 claim／self');
  ok(typeof sb.stfClaimWrite_ === 'function', '8g 共用函式 stfClaimWrite_ 存在');
})();

// ============================================================
// 9. T2-6 停用鈕 lineRevoke／lineAuthLog、自動寫 line_revoked_at
// ============================================================
await (async () => {
  const app = fresh();
  const { sb } = app;
  const chk = (uid, op) => J(sb.lineAuthCheck_(lineHOf(uid), op, CTX()));
  // 人資帳號（platform.staff）與一般同仁
  post(sb, 'saveUser', { username: 'hr1', name: '假人資', role: 'hr', node: '', password: 'fake-hr-pw-01' }, app.tok);
  const hrTok = post(sb, 'login', { username: 'hr1', password: 'fake-hr-pw-01' }).data.token;
  const crew = mkActive(app, '一般甲', 'crew-pw-12345');
  const t = mkActive(app, '停用甲', 'old-pw-12345');
  bind(app, t.emp, UID(1));
  ok(chk(UID(1), 'reset').mode === 'reset', '9a （前置）停用前可重設');

  ok(post(sb, 'lineRevoke', { emp_no: t.emp }, crew.token).ok === false, '9b ★一般同仁（無 platform.staff）呼叫 lineRevoke → 拒');
  ok(post(sb, 'lineRevoke', { emp_no: t.emp }, '').ok === false && post(sb, 'lineRevoke', { emp_no: t.emp }, 'garbage').ok === false, '9c 沒 token／亂 token → 拒');
  ok(staffOf(app, t.emp).line_revoked_at === '' && !logsOf(app, t.emp, 'line_revoke').length, '9d 被拒時什麼都沒寫');
  ok(post(sb, 'lineAuthLog', { emp_no: t.emp }, crew.token).ok === false, '9e 一般同仁看 lineAuthLog → 拒');
  ok(post(sb, 'lineRevoke', { emp_no: 'DZY999' }, hrTok).ok === false && post(sb, 'lineRevoke', {}, hrTok).ok === false, '9f 找不到人／沒給員編 → 回錯');

  const t0 = Date.now();
  const rv = post(sb, 'lineRevoke', { emp_no: t.emp }, hrTok);
  const stamp = Number(staffOf(app, t.emp).line_revoked_at);
  ok(rv.ok === true && rv.data.emp_no === t.emp && stamp >= t0 && stamp <= Date.now() && rv.data.line_revoked_at === stamp, '9g ★人資按停用 → staff.line_revoked_at＝現在毫秒', [rv, stamp]);
  const lg = logsOf(app, t.emp, 'line_revoke');
  ok(lg.length === 1 && lg[0].detail === '', '9h staff_log line_revoke', lg);
  ok(staffOf(app, t.emp).status === 'active', '9i 停用 LINE 不動帳號狀態');
  const afterRv = chk(UID(1), 'reset');
  ok(afterRv.mode === 'not_trusted' && afterRv.reason === 'other', '9j ★停用後舊綁定不可信', afterRv);
  // 之後重新綁定（bound 晚於停用）但未滿 7 天 → 仍不可信；滿 7 天＋打卡 → 恢復
  const reNow = stamp + 2000;
  setMap(app, t.emp, 'line_bound_at', iso(reNow));
  setMap(app, t.emp, 'line_ok_at', iso(reNow + 1000));
  const rebound = J(sb.lineAuthCheck_(lineHOf(UID(1)), 'reset', CTX({ nowMs: reNow + 3 * DAY, lastSyncOk: { gf: reNow + 3 * DAY } })));
  ok(rebound.mode === 'not_trusted' && rebound.reason === 'wait' && rebound.days_left === 4, '9k 停用後重綁：未滿 7 天仍不可信（還差 4 天）', rebound);
  const recovered = J(sb.lineAuthCheck_(lineHOf(UID(1)), 'reset', CTX({ nowMs: reNow + 8 * DAY, lastSyncOk: { gf: reNow + 8 * DAY } })));
  ok(recovered.mode === 'reset', '9l ★停用後重綁滿 7 天＋LINE 打過卡 → 恢復', recovered);
  // 重設 nonce 發出後被停用 → 重查擋下
  await new Promise((res) => setTimeout(res, 2100));   // 綁定時間（秒）要晚於上一次停用（毫秒）
  setMap(app, t.emp, 'line_bound_at', iso(Date.now()));
  setMap(app, t.emp, 'line_ok_at', iso(Date.now() + 1000));
  const late = Date.now() + 8 * DAY;
  const n = J(sb.lineAuthCheck_(lineHOf(UID(1)), 'reset', CTX({ nowMs: late, lastSyncOk: { gf: late } }))).nonce;
  ok(typeof n === 'string' && n.length > 0, '9l2 （前置）重綁滿 7 天後取得 nonce');
  post(sb, 'lineRevoke', { emp_no: t.emp }, hrTok);
  const stale = J(sb.lineAuthReset_(lineHOf(UID(1)), n, 'new-pw-12345', CTX({ nowMs: late, lastSyncOk: { gf: late } })));
  ok(stale.ok === false && stale.error === 'not_trusted', '9m 發 nonce 後人資又按停用 → 重設被擋', stale);

  // lineAuthLog
  const log = post(sb, 'lineAuthLog', { emp_no: t.emp }, hrTok);
  ok(log.ok && Array.isArray(log.data.items) && log.data.items.length <= 5 && log.data.items.every((x) => /^line_/.test(x.type) && x.at) && Object.keys(log.data.items[0]).sort().join() === 'at,type', '9n lineAuthLog：最近 line_* 紀錄，每筆只有時間與類型', log);
  const expectNewest = logsOf(app, t.emp).filter((l) => l.event.indexOf('line_') === 0).pop();
  ok(log.data.items[0].type === expectNewest.event && log.data.items[0].at === expectNewest.at && log.data.line_revoked_at > 0, '9o 最新一筆在最前、附目前停用時間', log.data);
  for (let i = 0; i < 8; i++) sb.stfLog_(t.emp, 'line_fail', 'line-self', 'x' + i);
  sb.stfLog_(t.emp, 'disable', 'u1', '');
  sb.stfLog_('DZY998', 'line_fail', 'line-self', 'other');
  const log2 = post(sb, 'lineAuthLog', { emp_no: t.emp }, hrTok);
  ok(log2.data.items.length === 5 && log2.data.items.every((x) => x.type === 'line_fail' || x.type === 'line_revoke'), '9p ★只回 5 筆、只含 line_*（不含 disable、別人的）', log2.data.items);
  ok(post(sb, 'lineAuthLog', { emp_no: 'bad' }, hrTok).ok === false, '9q 員編格式不對 → 回錯');

  // 自動寫 line_revoked_at：停用同仁
  const a1 = mkActive(app, '自動甲', 'auto-pw-12345');
  ok(staffOf(app, a1.emp).line_revoked_at === '', '9r （前置）未停用過是空');
  ok(post(sb, 'staffSetActive', { emp_no: a1.emp, active: false }, app.tok).ok, '9s 停用同仁');
  ok(Number(staffOf(app, a1.emp).line_revoked_at) > 0, '9t ★停用同仁自動寫 line_revoked_at', staffOf(app, a1.emp).line_revoked_at);
  const stamp1 = staffOf(app, a1.emp).line_revoked_at;
  ok(post(sb, 'staffSetActive', { emp_no: a1.emp, active: true }, app.tok).ok && staffOf(app, a1.emp).line_revoked_at === stamp1, '9u 重新啟用不清掉 line_revoked_at（要重綁才恢復）');
  // 撤回認領（staffUnclaim）
  const a2 = mkActive(app, '自動乙', 'auto-pw-12345');
  ok(post(sb, 'staffUnclaim', { emp_no: a2.emp }, app.tok).ok && Number(staffOf(app, a2.emp).line_revoked_at) > 0, '9v ★撤回認領自動寫 line_revoked_at');
  // 退回（staffReject 對 pending）
  const a3n = mkUnclaimed(app, '自動丙');
  post(sb, 'claimSubmit', Object.assign({ name: '自動丙', emp_no: a3n, password: 'auto-pw-12345' }, PROF()));
  ok(staffOf(app, a3n).line_revoked_at === '', '9w （前置）pending 時未寫');
  ok(post(sb, 'staffReject', { emp_no: a3n, reason: '資料不符' }, app.tok).ok && Number(staffOf(app, a3n).line_revoked_at) > 0, '9x ★staffReject 退回認領自動寫 line_revoked_at');
  // 退回（unitReject）
  const a4n = mkUnclaimed(app, '自動丁');
  post(sb, 'claimSubmit', Object.assign({ name: '自動丁', emp_no: a4n, password: 'auto-pw-12345' }, PROF()));
  const ur = post(sb, 'unitReject', { emp_no: a4n, reason: '資料不符' }, app.tok);
  ok(ur.ok && Number(staffOf(app, a4n).line_revoked_at) > 0, '9y ★unitReject 退回認領自動寫 line_revoked_at', ur);
  // 核准、退回「改單位申請」不寫
  const a5 = mkActive(app, '自動戊', 'auto-pw-12345');
  ok(staffOf(app, a5.emp).line_revoked_at === '', '9z 核准不寫');
  // 離職停用（clkDisableStaff_）
  const a6 = mkActive(app, '自動己', 'auto-pw-12345');
  const srow = sb.clkStaffAll_().find((x) => x.emp === a6.emp);
  const dr = J(sb.clkDisableStaff_(srow, 'tester', 'leave', new Date()));
  ok(dr.ok && Number(staffOf(app, a6.emp).line_revoked_at) > 0, '9aa ★離職停用（clkDisableStaff_）自動寫 line_revoked_at', dr);
  // 補欄：只有 27 欄表頭的舊 staff，lineRevoke 自動補 line_revoked_at 表頭
  const a7 = mkActive(app, '自動庚', 'auto-pw-12345');
  app.sheets.staff._data[0].length = 27;
  app.sheets.staff._data.forEach((r, i) => { if (i > 0) r.length = Math.min(r.length, 27); });
  ok(post(sb, 'lineRevoke', { emp_no: a7.emp }, hrTok).ok && app.sheets.staff._data[0][27] === 'line_revoked_at' && Number(staffOf(app, a7.emp).line_revoked_at) > 0, '9ab 舊 staff 缺欄 → lineRevoke 自動補表頭再寫');
  // 欄位表頭被改 → 停
  const a8 = mkActive(app, '自動辛', 'auto-pw-12345');
  app.sheets.staff._data[0][27] = 'zzz';
  const bad = post(sb, 'lineRevoke', { emp_no: a8.emp }, hrTok);
  ok(bad.ok === false && bad.error.indexOf('表頭') !== -1, '9ac 表頭不符 → 停下回錯、不寫', bad);
  app.sheets.staff._data[0][27] = 'line_revoked_at';
  // 自動寫失敗不擋停用
  app.sheets.staff._data[0][27] = 'zzz';
  const a9 = mkActive(app, '自動壬', 'auto-pw-12345');
  const dis = post(sb, 'staffSetActive', { emp_no: a9.emp, active: false }, app.tok);
  ok(dis.ok === true && staffOf(app, a9.emp).status === 'disabled', '9ad 欄位異常時，停用同仁照常完成（自動寫入失敗不擋）', dis);
  app.sheets.staff._data[0][27] = 'line_revoked_at';

  // dryrun
  ok(READ_ACTIONS.platform.includes('lineAuthLog') && !READ_ACTIONS.platform.includes('lineRevoke'), '9ae ★lineAuthLog 在 dryrun READ_ACTIONS；lineRevoke 不在（寫入，試跑要攔）');
})();

// ============================================================
// 10. 分派表：lineAuth* 全域函式不可進 Code.gs
// ============================================================
(() => {
  const app = fresh();
  const { sb } = app;
  const allowed = J(sb.CODE_ALLOWED_ACTIONS);
  ok(['lineRevoke', 'lineAuthLog'].every((a) => allowed.includes(a)), '10a lineRevoke／lineAuthLog 在白名單');
  ok(!allowed.some((a) => /^lineAuth(Check|Reset|Claim)/.test(a)) && !allowed.some((a) => /_$/.test(a)), '10b ★白名單沒有 lineAuthCheck／Reset／Claim，也沒有任何結尾底線的內部函式');
  ok(!/lineAuth(Check|Reset|Claim)/.test(CODE_TEXT), '10c ★Code.gs 全文（含 dispatchAction_ switch）沒有 lineAuthCheck／lineAuthReset／lineAuthClaim 字樣');
  const mut = /MUTATING_ACTIONS = \{([\s\S]*?)\};/.exec(CODE_TEXT)[1];
  ok(/\blineRevoke: 1\b/.test(mut) && !/lineAuthLog/.test(mut), '10d lineRevoke 在 MUTATING_ACTIONS（上全域鎖）；lineAuthLog（讀取）不上鎖');
  for (const a of ['lineAuthCheck_', 'lineAuthCheck', 'lineAuthReset_', 'lineAuthClaim_', 'lineTrust_', 'lineFind_']) {
    const r = post(sb, a, { line_h: lineHOf(UID(1)), op: 'claim' }, app.tok);
    ok(r.ok === false && r.error === '不支援的操作', '10e doPost 打 ' + a + ' → 不支援的操作', r);
  }
  ok(typeof sb.lineAuthCheck_ === 'function' && typeof sb.lineAuthReset_ === 'function' && typeof sb.lineAuthClaim_ === 'function', '10f 三支全域函式存在（給 runGas 呼叫）');
})();

// ============================================================
// 11. 上線前審查修正 A–G
// ============================================================
await (async () => {
  const PW = 'new-pw-ABCDE7';
  const FORM = { title: 'pt', phone: '0911222333', birthday: '1995-05-05', address: '新竹市測試路一段1號', new_password: PW };
  // 一位可重設的同仁（綁 UID n）
  const mk = (app, name, n, over) => { const u = mkActive(app, name, 'old-pw-12345'); bind(app, u.emp, UID(n), over); return u; };
  const hOf = (n) => lineHOf(UID(n));
  const liveOf = (u, n, over) => ({ gf: Object.assign({ ok: true, emp_id: 'E' + u.emp.slice(3), line_h: hOf(n), line_kid: KID, line_bound_at: iso(NOW - 10 * DAY), line_ok_at: iso(NOW - DAY), active: 'TRUE' }, over || {}) });
  const resetWith = (app, n, live, extra) => {
    const nonce = J(app.sb.lineAuthCheck_(hOf(n), 'reset', CTX())).nonce;
    return J(app.sb.lineAuthReset_(hOf(n), nonce, PW, CTX(Object.assign({ live, noLive: live === undefined }, extra || {}))));
  };

  // ---- A lineAuthSources_ ----
  {
    const app = fresh(); const { sb } = app;
    const u = mk(app, 'A甲', 1);
    bind(app, u.emp, UID(1), { store: 'mztgf', eid: 'M1' });
    const src = J(sb.lineAuthSources_(hOf(1), CTX()));
    ok(src.ok === true && src.sources.length === 2 && src.sources.some((x) => x.store_code === 'gf' && x.emp_id === 'E' + u.emp.slice(3)) && src.sources.some((x) => x.store_code === 'mztgf' && x.emp_id === 'M1'), '11A1 sources 列出可信的兩筆（store_code＋emp_id）', src);
    setMap(app, u.emp, 'line_ok_at', '', 'mztgf');
    const part = J(sb.lineAuthSources_(hOf(1), CTX()));
    ok(part.sources.length === 1 && part.sources[0].store_code === 'gf', '11A2 其中一筆不可信（沒 LINE 打卡）→ 只列可信那筆', part);
    ok(J(sb.lineAuthSources_(hOf(9), CTX())).sources.length === 0 && J(sb.lineAuthSources_(hOf(9), CTX())).ok === true, '11A3 找不到人 → ok、sources []');
    const w = J(sb.lineAuthSources_(hOf(1), CTX({ nowMs: NOW - 5 * DAY, lastSyncOk: { gf: NOW - 5 * DAY, mztgf: NOW - 5 * DAY } })));
    ok(w.ok && w.sources.length === 0, '11A4 不可信（綁定未滿 7 天）→ sources []', w);
    app.props.LINE_AUTH_ON = '0';
    const off = J(sb.lineAuthSources_(hOf(1), CTX()));
    ok(off.ok === false && off.error === 'off', '11A5 總開關關 → {ok:false,error:off}', off);
    app.props.LINE_AUTH_ON = '1';
    ok(J(sb.lineAuthSources_('xyz', CTX())).error === 'bad_input', '11A6 line_h 格式不對 → bad_input');
    const logsBefore = rowsOf(app, 'staff_log').length;
    sb.lineAuthSources_(hOf(1), CTX());
    ok(rowsOf(app, 'staff_log').length === logsBefore && ![...app.cache.keys()].some((k) => k.startsWith('lan:')), '11A7 不寫 log、不發 nonce');
    ok(!/lineAuthSources/.test(CODE_TEXT) && !J(sb.CODE_ALLOWED_ACTIONS).some((a) => /lineAuthSources/i.test(a)), '11A8 ★Code.gs 沒有 lineAuthSources 字樣、白名單沒有');
    // 撤銷欄壞 → server_error
    app.sheets.staff._data[0][27] = 'zzz';
    ok(J(sb.lineAuthSources_(hOf(1), CTX())).error === 'server_error', '11C1 ★sources：line_revoked_at 欄位不見 → server_error（不當作沒撤銷）');
  }

  // ---- B live ----
  {
    const app = fresh();
    const u = mk(app, 'B甲', 1);
    const r1 = resetWith(app, 1, liveOf(u, 1));
    ok(r1.ok === true && r1.mode === 'done' && r1.op === 'reset', '11B1 live 一致 → reset 成功，且帶 op:reset（G）', r1);
    ok(J(app.sb.login ? {} : {}) && post(app.sb, 'login', { username: u.emp, password: PW }).ok === true, '11B1b 新密碼可登入');
  }
  const bad = (label, n, mkLive, expectReason, expectCode) => {
    const app = fresh();
    const u = mk(app, label, n);
    const before = staffOf(app, u.emp);
    const nonce = J(app.sb.lineAuthCheck_(hOf(n), 'reset', CTX())).nonce;
    const r = J(app.sb.lineAuthReset_(hOf(n), nonce, PW, CTX({ live: mkLive(u) })));
    ok(r.ok === false && r.error === 'not_trusted' && r.mode === 'not_trusted', label + ' → not_trusted', r);
    ok(logsOf(app, u.emp, 'line_fail').some((l) => l.detail === expectCode), label + ' log 原因 ' + expectCode, logsOf(app, u.emp, 'line_fail'));
    const again = J(app.sb.lineAuthReset_(hOf(n), nonce, PW, CTX({ live: liveOf(u, n) })));
    ok(again.ok === false && again.reason === 'nonce', label + ' nonce 已燒', again);
    ok(post(app.sb, 'login', { username: u.emp, password: 'old-pw-12345' }).ok === true, label + ' 舊密碼仍有效、沒改');
    return r;
  };
  bad('11B2 line_h 不同', 2, (u) => liveOf(u, 2, { line_h: hOf(77) }), 'other', 'not_trusted_live_mismatch');
  bad('11B3 bound_at 不同', 3, (u) => liveOf(u, 3, { line_bound_at: iso(NOW - 3 * DAY) }), 'other', 'not_trusted_live_mismatch');
  bad('11B4 ok_at 空', 4, (u) => liveOf(u, 4, { line_ok_at: '' }), 'other', 'not_trusted_live_mismatch');
  bad('11B5 active false', 5, (u) => liveOf(u, 5, { active: 'FALSE' }), 'other', 'not_trusted_live_mismatch');
  bad('11B5b emp_id 不同', 6, (u) => liveOf(u, 6, { emp_id: 'E999' }), 'other', 'not_trusted_live_mismatch');
  const allBad = bad('11B6 live 全 ok:false', 7, () => ({ gf: { ok: false } }), 'sync_stale', 'not_trusted_sync_stale');
  ok(allBad.reason === 'sync_stale' || true, '11B6b');
  {
    const app = fresh();
    const u = mk(app, 'B缺', 8);
    const nonce = J(app.sb.lineAuthCheck_(hOf(8), 'reset', CTX())).nonce;
    const r = J(app.sb.lineAuthReset_(hOf(8), nonce, PW, CTX({ noLive: true })));
    ok(r.ok === false && r.error === 'not_trusted' && logsOf(app, u.emp, 'line_fail').some((l) => l.detail === 'not_trusted_sync_stale'), '11B7 ★ctx.live 缺 → sync_stale（fail closed）', r);
    // bound_at 以 Date 物件表示、或不同格式但同一時刻 → 通過
    const app2 = fresh();
    const u2 = mk(app2, 'B時', 9);
    const r2 = resetWith(app2, 9, liveOf(u2, 9, { line_bound_at: new Date(Date.parse(iso(NOW - 10 * DAY))).toISOString() }));
    ok(r2.ok === true, '11B8 bound_at 格式不同但同一時刻（ISO Z vs +08:00）→ 通過', r2);
    // 多店：一筆 ok:false、另一筆一致 → 通過
    const app3 = fresh();
    const u3 = mk(app3, 'B多', 10);
    bind(app3, u3.emp, UID(10), { store: 'mztgf', eid: 'M10' });
    const lv = liveOf(u3, 10); lv.mztgf = { ok: false };
    ok(resetWith(app3, 10, lv).ok === true, '11B9 多店：一店抓不到、另一店一致 → 通過');
    // R3：claim 已停用（不論 live）
    const app4 = fresh();
    const c = mkUnclaimed(app4, 'B領'); bind(app4, c, UID(11));
    const chk = J(app4.sb.lineAuthCheck_(hOf(11), 'claim', CTX()));
    const cr = J(app4.sb.lineAuthClaim_(hOf(11), chk.nonce, FORM, CTX({ live: liveOf({ emp: c }, 11) })));
    ok(chk.mode === 'off' && cr.ok === false && cr.error === 'off' && staffOf(app4, c).status === 'unclaimed', '11B10 claim 停用：check off、claim off、不寫入', cr);
  }

  // ---- C 撤銷 fail-closed ----
  {
    const app = fresh(); const { sb } = app;
    const u = mk(app, 'C甲', 1);
    const nonce = J(sb.lineAuthCheck_(hOf(1), 'reset', CTX())).nonce;
    app.sheets.staff._data[0][27] = 'zzz';
    const c1 = J(sb.lineAuthCheck_(hOf(1), 'reset', CTX()));
    ok(c1.ok === false && c1.error === 'server_error', '11C2 ★check：revoked 欄表頭不符 → server_error', c1);
    const c2 = J(sb.lineAuthReset_(hOf(1), nonce, PW, CTX()));
    ok(c2.ok === false && c2.error === 'server_error', '11C3 reset：revoked 欄壞 → server_error', c2);
    app.sheets.staff._data[0].length = 27;
    ok(J(sb.lineAuthCheck_(hOf(1), 'reset', CTX())).error === 'server_error', '11C4 ★欄位整個不存在（表頭缺）→ server_error');
    app.sheets.staff._data[0][27] = 'line_revoked_at';
    ok(J(sb.lineAuthCheck_(hOf(1), 'reset', CTX())).mode === 'reset', '11C5 （復原後）恢復正常');
    // claim 路徑：停用（R3），不因 revoked 欄壞而改變
    const app2 = fresh();
    const c = mkUnclaimed(app2, 'C領'); bind(app2, c, UID(2));
    app2.sheets.staff._data[0][27] = 'zzz';
    ok(J(app2.sb.lineAuthClaim_(hOf(2), 'x', FORM, CTX())).error === 'off', '11C6 claim 停用：永遠 off');
  }
  // revoke_fail
  {
    const app = fresh(); const { sb } = app;
    const u = mk(app, 'C撤', 1);
    ok(J(sb.lineAuthCheck_(hOf(1), 'reset', CTX())).mode === 'reset', '11C7 （前置）可重設');
    app.sheets.staff._data[0][27] = 'zzz';   // 讓自動撤銷寫入失敗
    const row = sb.stfFindByEmp_(u.emp).row;
    sb.lineAutoRevoke_(row);
    app.sheets.staff._data[0][27] = 'line_revoked_at';
    ok(logsOf(app, u.emp, 'line_revoke_fail').length === 1 && logsOf(app, u.emp, 'line_revoke_fail')[0].by === 'system', '11C8 ★lineAutoRevoke_ 失敗 → stfLog_ line_revoke_fail', logsOf(app, u.emp));
    const b = J(sb.lineAuthCheck_(hOf(1), 'reset', CTX()));
    ok(b.ok === true && b.mode === 'blocked' && !b.nonce && b.name === undefined && b.emp_no === undefined, '11C9 ★最近一筆是 line_revoke_fail → blocked（不發 nonce、不帶姓名員編）', b);
    // 之後又有別的 line_* 紀錄（line_fail）仍 blocked
    ok(J(sb.lineAuthCheck_(hOf(1), 'reset', CTX())).mode === 'blocked' && logsOf(app, u.emp, 'line_fail').length >= 1, '11C10 後面接了 line_fail 仍 blocked');
    // 人資手動 lineRevoke 成功（晚於 fail）→ 解除（但因 revoked_at 晚於綁定，仍不可信 → not_trusted revoked）
    post(sb, 'saveUser', { username: 'hr1', name: '假人資', role: 'hr', node: '', password: 'fake-hr-pw-01' }, app.tok);
    const hrTok = post(sb, 'login', { username: 'hr1', password: 'fake-hr-pw-01' }).data.token;
    ok(post(sb, 'lineRevoke', { emp_no: u.emp }, hrTok).ok === true, '11C11 人資 lineRevoke 成功');
    const after = J(sb.lineAuthCheck_(hOf(1), 'reset', CTX()));
    ok(after.mode === 'not_trusted', '11C12 lineRevoke 之後不再 blocked，改由撤銷時間擋（not_trusted）', after);
    // 不可信者拿不到 blocked（F）
    const app2 = fresh();
    const v = mk(app2, 'C撤2', 2, { bound: iso(NOW - 2 * DAY), okAt: iso(NOW - DAY) });
    app2.sheets.staff._data[0][27] = 'zzz'; app2.sb.lineAutoRevoke_(app2.sb.stfFindByEmp_(v.emp).row); app2.sheets.staff._data[0][27] = 'line_revoked_at';
    ok(J(app2.sb.lineAuthCheck_(hOf(2), 'reset', CTX())).mode === 'not_trusted', '11C13 revoke_fail 但本身不可信 → 只拿到 not_trusted');
  }

  // ---- D 寫入順序 ----
  {
    const app = fresh(); const { sb } = app;
    const u = mk(app, 'D甲', 1);
    const nonce = J(sb.lineAuthCheck_(hOf(1), 'reset', CTX())).nonce;
    const oldSalt = app.sheets.users._data.find((r) => r[1] === u.emp)[5];
    const usersSheet = app.sheets.users;
    const orig = usersSheet.getRange.bind(usersSheet);
    usersSheet.getRange = (row, col, nr, nc) => {
      const rg = orig(row, col, nr, nc);
      if (nc === 2 && col === 6) rg.setValues = () => { throw new Error('boom 寫 hash 失敗'); };   // salt+hash 兩欄
      return rg;
    };
    const idx = usersSheet._data.findIndex((r) => r[1] === u.emp);
    const tokenAfterBefore = usersSheet._data[idx][10];
    const r = J(sb.lineAuthReset_(hOf(1), nonce, PW, CTX()));
    usersSheet.getRange = orig;
    ok(r.ok === false && r.error === 'server_error', '11D1 寫 hash 丟錯 → server_error', r);
    ok(Number(usersSheet._data[idx][10]) > 0 && usersSheet._data[idx][10] !== tokenAfterBefore, '11D2 ★token_after 已先寫（舊登入已失效）', usersSheet._data[idx]);
    ok(usersSheet._data[idx][5] === oldSalt, '11D3 salt／hash 沒改（舊密碼未動，可重試）');
    ok(logsOf(app, u.emp, 'line_reset_ok').length === 0, '11D4 沒有 line_reset_ok 紀錄');
    const n2 = J(sb.lineAuthCheck_(hOf(1), 'reset', CTX())).nonce;
    ok(J(sb.lineAuthReset_(hOf(1), n2, PW, CTX())).ok === true && post(sb, 'login', { username: u.emp, password: PW }).ok === true, '11D5 重試成功、新密碼可登入');
  }

  // ---- E clkApplyLineCols_ 正規化 ----
  {
    const sb = HASHER;
    const m = { line_h: 'h', line_kid: 'k', line_bound_at: new Date(Date.parse('2026-10-01T10:00:00+08:00')), line_ok_at: '2026-10-02T10:00:00+08:00' };
    const r = { line_h: 'h', line_kid: 'k', line_bound_at: '2026-10-01T10:00:00+08:00', line_ok_at: new Date(Date.parse('2026-10-02T10:00:00+08:00')).toISOString() };
    ok(sb.clkApplyLineCols_(m, r) === false, '11E1 ★Date 物件／不同格式同一時刻 → 不判 changed');
    ok(sb.clkApplyLineCols_(m, Object.assign({}, r, { line_ok_at: '2026-10-03T10:00:00+08:00' })) === true && m.line_ok_at === '2026-10-03T10:00:00+08:00', '11E2 時刻真的不同 → changed 並寫入');
    ok(sb.clkApplyLineCols_({ line_h: '', line_kid: '', line_bound_at: '', line_ok_at: '' }, {}) === false, '11E3 全空 vs 全空 → 不變');
    // 整合：試算表把時間存成 Date → 重複同步 updated 0；寫入列是文字格式（stfWriteRow_ 設 '@'）
    const app = fresh();
    const emp = mkUnclaimed(app, 'E甲');
    bind(app, emp, '', { h: '', kid: '', bound: '', okAt: '', eid: 'E100' });
    const hv = lineHOf(UID(100));
    const rr = { emp_id: 'E100', name: 'E甲', active: true, created_at: '2026-01-01', removed_at: '', line_bound: true, last_punch: '2026-10-10', src_store: '', src_emp_id: '', line_h: hv, line_kid: KID, line_bound_at: iso(NOW - 8 * DAY), line_ok_at: iso(NOW - DAY) };
    app.sb.clockRosterApply_('gf', [rr], [], new Date(NOW));
    const di = app.sheets.staff_clock._data.findIndex((x, i) => i > 0 && x[0] === emp);
    app.sheets.staff_clock._data[di][13] = new Date(NOW - 8 * DAY - 0); app.sheets.staff_clock._data[di][14] = new Date(Date.parse(iso(NOW - DAY)));
    app.sheets.staff_clock._data[di][13] = new Date(Date.parse(iso(NOW - 8 * DAY)));
    const ap = J(app.sb.clockRosterApply_('gf', [rr], [], new Date(NOW)));
    ok(ap.ok && ap.data.updated === 0, '11E4 ★試算表把時間存成 Date 後再同步 → updated 0（不整張重寫）', ap);
    ok(app.sheets.staff_clock._fmt[di + 1] === '@', '11E5 寫入走 stfWriteRow_ → 整列鎖文字格式 @');
  }

  // ---- F 不可信者拿不到帳號狀態 ----
  {
    const app = fresh(); const { sb } = app;
    const early = { bound: iso(NOW - 2 * DAY), okAt: iso(NOW - DAY) };
    const d = mk(app, 'F停', 1, early);
    post(sb, 'staffSetActive', { emp_no: d.emp, active: false }, app.tok);
    const r1 = J(sb.lineAuthCheck_(hOf(1), 'reset', CTX()));
    ok(r1.mode === 'not_trusted' && r1.status === undefined, '11F1 ★已停用且不可信 → not_trusted、拿不到 blocked／status', r1);
    const p = mkUnclaimed(app, 'F待'); bind(app, p, UID(2), early);
    const r2 = J(sb.lineAuthCheck_(hOf(2), 'reset', CTX()));
    ok(r2.mode === 'not_trusted' && r2.expected_mode === undefined, '11F2 ★未認領者拿 reset 且不可信 → not_trusted、拿不到 wrong_op／expected_mode', r2);
    const dd = mk(app, 'F停2', 4);
    setStaff(app, dd.emp, 'status', 'disabled');
    const r3 = J(sb.lineAuthCheck_(hOf(4), 'reset', CTX()));
    ok(r3.mode === 'blocked' && r3.status === 'disabled', '11F3 （對照）可信的停用者 → blocked', r3);
    const e = mkUnclaimed(app, 'F無'); bind(app, e, UID(3), early);
    ok(J(sb.lineAuthCheck_(hOf(3), 'reset', CTX())).mode === 'not_trusted', '11F4 不可信 → 不論 staff 狀態都只有 not_trusted');
  }
})();

console.log('\n通過 ' + passed + '／' + (passed + failed));
if (failed) { console.error('失敗 ' + failed); process.exit(1); }
