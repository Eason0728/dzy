// test/dd/hr_lib.mjs —— 人資部門（甲組）資料帶入測試共用：把 apps-script/platform 的 .gs 載進 vm、
// 種子亂數（E2E_SEED 可重現）、假名產生器、分層抽樣。只給 test/dd/hr_*.mjs 與 test/e2e/dd_hr_*.py 用。
// ⚠ 全部假名、假日期；不碰任何正式後端。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'StaffClock.gs', 'Perms.gs', 'PermActions.gs',
  'ApprovalRoute.gs', 'Approvals.gs', 'EvalCalc.gs', 'Eval.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

// ── 種子亂數（mulberry32）──
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    f: next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle: (arr) => { const a2 = arr.slice(); for (let i = a2.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a2[i], a2[j]] = [a2[j], a2[i]]; } return a2; },
    chance: (p) => next() < p
  };
  return rng;
}
export function seedFromEnv() {
  const s = process.env.E2E_SEED;
  if (s && /^\d+$/.test(s)) return Number(s) >>> 0;
  return (Date.now() ^ (process.pid << 8)) >>> 0;
}

// 假名：姓＋兩字名，全部虛構（dzy 是 public repo，絕不用真名）
const SURNAMES = ['測', '試', '假', '虛', '擬', '樣', '範', '仿', '模', '演', '練', '習'];
const GIVEN = ['安', '平', '順', '和', '樂', '康', '寧', '祥', '瑞', '嘉', '佑', '恩', '語', '晴', '雲', '星', '辰', '光', '明', '亮'];
export function makeNamer(rng) {
  const used = new Set();
  return () => {
    for (let i = 0; i < 1000; i++) {
      const n = rng.pick(SURNAMES) + rng.pick(GIVEN) + rng.pick(GIVEN);
      if (!used.has(n)) { used.add(n); return n; }
    }
    throw new Error('假名用完');
  };
}
// 分層：先抽水準中心（低／中／高），星等在中心附近浮動
export function starsAround(rng, center, n) {
  const out = [];
  if (center === 5 && rng.chance(0.5)) { for (let i = 0; i < n; i++) out.push(5); return out; }   // 高水準的人一半機率全 5 星（讓滿分、上限 100 出現）
  for (let i = 0; i < n; i++) {
    let v = center + (rng.chance(0.35) ? (rng.chance(0.5) ? -1 : 1) : 0);
    if (rng.chance(0.08)) v += rng.chance(0.5) ? -2 : 2;
    out.push(Math.max(1, Math.min(5, v)));
  }
  return out;
}

// ── GAS 假物件（同 test/e2e/eval_backend.mjs）──
export function makeSheet(rows) {
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
        getValue() { return range.getValues()[0][0]; },
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
        setNumberFormat() { return range; },
        clearContent() { for (let r = 0; r < numRows; r++) { const ri = row - 1 + r; if (!data[ri]) continue; for (let c = 0; c < numCols; c++) if (data[ri][col - 1 + c] !== undefined) data[ri][col - 1 + c] = ''; } return range; }
      };
      return range;
    },
    appendRow(r) { data.push(r.slice()); },
    deleteRow(n) { data.splice(n - 1, 1); },
    insertRowsAfter() {},
    getName() { return sheet._name || ''; },
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

export function load(seed) {
  const sheets = {};
  Object.keys(seed).forEach((k) => { sheets[k] = makeSheet(seed[k]); sheets[k]._name = k; });
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet([]); sheets[n]._name = n; return sheets[n]; },
    getSheets: () => Object.values(sheets)
  };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-for-dd-hr' };
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
      base64EncodeWebSafe: (d) => bytes(d).toString('base64url'),
      getUuid: () => 'fake-uuid-' + (++uuid),
      formatDate: (d, tz, fmt) => { const x = new Date(d.getTime() + 8 * 3600 * 1000); const p = (n) => (n < 10 ? '0' : '') + n; return fmt.indexOf('HH') !== -1 ? `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}:${p(x.getUTCSeconds())}` : `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())}`; },
      sleep: () => {}
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props[k] === undefined ? null : props[k]), setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => { const e = cache.get(k); if (!e) return null; if (e.exp && Date.now() > e.exp) { cache.delete(k); return null; } return e.v; },
      put: (k, v, ttl) => cache.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null }),
      remove: (k) => cache.delete(k)
    }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    UrlFetchApp: { fetch: () => { throw new Error('dd-hr 測試不准打外網'); } }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  return { sb: sandbox, sheets, cache, props };
}
export function post(sb, action, payload, token) {
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }).getContent());
}

export const ADMIN_PW = 'fake-admin-pw-01';
export const STAFF_PW = 'fake-staff-pw-1';
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
export function freshSeed() {
  const salt = 'salt-admin';
  return {
    users: [
      ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at'],
      ['u001', 'BOSS', '系統管理者', 'admin', '', salt, HASHER.hashPassword_(ADMIN_PW, salt), 'TRUE', '', ''],
      ['u002', 'dormmgr', '假宿舍主管', 'manager', '', salt, HASHER.hashPassword_('fake-mgr-pw-01', salt), 'TRUE', '', '']
    ],
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['manager', '總監', 'audit.read,dorm.read,dorm.write'], ['staff', '員工', '']],
    module_secrets: [['backend_id', 'level', 'secret']],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  };
}
/** 全新平台：setupStaff（含 clock 分頁、regions 分頁）＋ admin token */
export function freshApp() {
  const app = load(freshSeed());
  app.sb.setupStaff();
  app.admin = post(app.sb, 'login', { username: 'BOSS', password: ADMIN_PW }).data.token;
  return app;
}

/** 匯入＋認領＋（人資）確認 → 已開通同仁；回 {emp, token}。org＝{brand, unit, dept, title} */
let seq = 0;
export function claim(app, name, org, extra) {
  const sb = app.sb;
  const imp = post(sb, 'staffImport', { names: [name] }, app.admin);
  if (!imp.ok) throw new Error('staffImport 失敗 ' + imp.error);
  const lk = post(sb, 'claimLookup', { name });
  if (!lk.ok) throw new Error('claimLookup 失敗 ' + lk.error);
  seq++;
  const prof = Object.assign({ dept: '', birthday: '1990-01-0' + (1 + (seq % 8)), phone: '09' + String(20000000 + seq), address: '測試市假想路' + seq + '號' }, org, extra || {});
  const sub = post(sb, 'claimSubmit', Object.assign({ name, emp_no: lk.data.emp_no, password: STAFF_PW }, prof));
  if (!sub.ok) throw new Error('claimSubmit 失敗 ' + sub.error + ' ' + JSON.stringify(org));
  return lk.data.emp_no;
}
export function activate(app, name, org, extra) {
  const emp = claim(app, name, org, extra);
  const cf = post(app.sb, 'staffConfirm', { emp_no: emp }, app.admin);
  if (!cf.ok) throw new Error('staffConfirm 失敗 ' + cf.error);
  return emp;
}
export function loginAs(app, emp) {
  const lg = post(app.sb, 'login', { username: emp, password: STAFF_PW });
  if (!lg.ok) throw new Error('登入失敗 ' + emp + ' ' + lg.error);
  return lg.data.token;
}
export function setHireDate(app, emp, hire) {
  const sb = app.sb;
  const col = sb.STF_COL_COUNT;   // hire_date（0-based）
  const row = app.sheets.staff._data.find((r) => r[sb.STF_COL.emp_no] === emp);
  if (!row) throw new Error('找不到 ' + emp);
  while (row.length <= col) row.push('');
  row[col] = hire;
}
