// test/e2e/inspect_backend.mjs —— 營運巡檢的本機測試後端（2026-10-27）：把 apps-script/platform 的 .gs 載進 vm（做法同 eval_backend.mjs），
// 種假人員（全集團各種職稱），包成 http://127.0.0.1:<PORT>/platform/api，另外模擬 Mac mini 的照片路由 /platform/svc/apv-file-put|get。
// 全部假資料、只聽 127.0.0.1。⚠ dzy 是 public repo：姓名、生日、手機、地址一律假的。
// 用法：node test/e2e/inspect_backend.mjs（PORT 預設 8840）；test/inspection.mock.test.mjs 直接 import buildWorld()。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Perms.gs', 'PermActions.gs', 'ApprovalRoute.gs', 'Approvals.gs', 'Inspect.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

// ── GAS 假物件 ──────────────────────────────────────────────
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
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; }
  };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-for-eval-actions' };
  const counters = { locks: 0 };
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
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props[k] === undefined ? null : props[k]), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => { const e = cache.get(k); if (!e) return null; if (e.exp && Date.now() > e.exp) { cache.delete(k); return null; } return e.v; },
      put: (k, v, ttl) => cache.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null }),
      remove: (k) => cache.delete(k)
    }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { counters.locks++; return true; }, releaseLock() {} }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  return { sb: sandbox, sheets, cache, props, counters };
}
function post(sb, action, payload, token) {
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }).getContent());
}

const ADMIN_PW = 'fake-admin-pw-01';
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
function freshSeed() {
  const salt = 'salt-admin';
  return {
    users: [
      ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at'],
      ['u001', 'BOSS', '系統管理者', 'admin', '', salt, HASHER.hashPassword_(ADMIN_PW, salt), 'TRUE', '', ''],
      ['u002', 'acc1', '假會計', 'accountant', '', salt, HASHER.hashPassword_('fake-acc-pw-01', salt), 'TRUE', '', ''],
      ['u003', 'hr1', '系統人資', 'hrsys', '', salt, HASHER.hashPassword_('fake-hr-pw-01', salt), 'TRUE', '', '']
    ],
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['accountant', '會計', 'audit.read,audit.write'], ['hrsys', '系統人資', 'platform.staff'], ['staff', '員工', '']],
    module_secrets: [['backend_id', 'level', 'secret']],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  };
}
function fresh() {
  const app = load(freshSeed());
  app.sb.setupStaff();
  // 沒載入 StaffClock.gs：兼任欄表頭手動補
  app.sheets.staff.getRange(1, app.sb.STF_EXTRA_DEPTS_COL_NO).setValue('extra_depts');
  return app;
}
const adminTok = (sb) => post(sb, 'login', { username: 'BOSS', password: ADMIN_PW }).data.token;

let seq = 0;
function claim(sb, name, org, pw) {
  post(sb, 'staffImport', { names: [name] }, sb.__admin);
  const lk = post(sb, 'claimLookup', { name });
  seq++;
  const prof = Object.assign({ dept: '', birthday: '1990-01-0' + (1 + (seq % 8)), phone: '09' + String(20000000 + seq), address: '新竹市測試路' + seq + '號' }, org);
  const sub = post(sb, 'claimSubmit', Object.assign({ name, emp_no: lk.data.emp_no, password: pw || 'fake-staff-pw-1' }, prof));
  if (!sub.ok) throw new Error('claimSubmit 失敗 ' + sub.error);
  return lk.data.emp_no;
}
function mk(sb, name, org, pw) {
  const emp = claim(sb, name, org, pw);
  const cf = post(sb, 'staffConfirm', { emp_no: emp }, sb.__admin);
  if (!cf.ok) throw new Error('staffConfirm 失敗 ' + cf.error);
  const lg = post(sb, 'login', { username: emp, password: pw || 'fake-staff-pw-1' });
  if (!lg.ok) throw new Error('登入失敗 ' + lg.error);
  return { emp, token: lg.data.token };
}
const HQ = (dept, title) => ({ brand: 'dzy', unit: 'dzy-hq', dept, title });


export const MALA = (unit, title) => ({ brand: 'mala', unit, title });
export const MZT = (unit, title) => ({ brand: 'mzt', unit, title });

/** 建一個世界：admin＋各職稱假同仁、權限開、表單簽核（照片庫）與營運巡檢都初始化 */
export function buildWorld() {
  const app = load(freshSeed());
  const { sb } = app;
  sb.setupStaff();
  app.sheets.staff.getRange(1, sb.STF_EXTRA_DEPTS_COL_NO).setValue('extra_depts');
  // 種子只有小辛辣光復：補美村、南昌兩店（假資料，代碼照正式命名習慣）
  app.sheets.org.appendRow(['unit', 'mala-mc', '台中美村', 'mala', 'store', '', 3, 'TRUE']);
  app.sheets.org.appendRow(['unit', 'mala-nc', '員林南昌', 'mala', 'store', '', 4, 'TRUE']);
  sb.__admin = adminTok(sb);
  const people = {
    ops: mk(sb, '測試營運部同仁', HQ('ops', 'hs')),
    hr: mk(sb, '測試人資同仁', HQ('hr', 'hs')),
    malaOdir: mk(sb, '測試小辛辣總監', { brand: 'mala', unit: 'mala-hq', title: 'odir' }),
    malaOsv: mk(sb, '測試小辛辣督導', { brand: 'mala', unit: 'mala-hq', title: 'osv' }),
    mztOsv: mk(sb, '測試墨竹亭督導', { brand: 'mzt', unit: 'mzt-hq', title: 'osv' }),
    gfSm: mk(sb, '測試光復店長', MALA('mala-gf', 'sm')),
    mcSm: mk(sb, '測試美村店長', MALA('mala-mc', 'sm')),
    gfPt: mk(sb, '測試光復計時', MALA('mala-gf', 'pt')),
    mztAm: mk(sb, '測試墨竹亭區經理', MZT('mzt-gf', 'am')),
    ceo: mk(sb, '測試執行長', HQ('mgmt', 'ceo'))
  };
  post(sb, 'permInit', {}, sb.__admin);
  app.props.PERMS_ON = '1';
  const apv = post(sb, 'apvSetup', {}, sb.__admin);
  if (!apv.ok) throw new Error('apvSetup 失敗 ' + JSON.stringify(apv));
  // 照片檔：模擬 Mac mini apv.js（登記→落地→commit），bytes 存記憶體
  const files = new Map();
  function filePut(body) {
    const a = sb.apvFileAuthorize_(body.token);
    if (!a.ok) return { ok: false, error: a.error };
    const raw = Buffer.from(String(body.b64 || ''), 'base64');
    if (!raw.length) return { ok: false, error: 'file_invalid' };
    const reg = sb.apvFileRegister_(a.emp, { kind: 'receipt', mime: 'image/jpeg', bytes: raw.length, sha256: crypto.createHash('sha256').update(raw).digest('hex'), ext: 'jpg' });
    if (!reg.ok) return { ok: false, error: reg.error };
    files.set(reg.id, raw);
    sb.apvFileCommit_(reg.id);
    return { ok: true, data: { id: reg.id, bytes: raw.length } };
  }
  function fileGet(body) {
    const r = sb.apvFileCanRead_(body.token, body.id);
    if (!r.ok) return { ok: false, error: r.error };
    const raw = files.get(String(body.id));
    return raw ? { ok: true, data: { b64: raw.toString('base64'), mime: r.mime } } : { ok: false, error: 'not_found' };
  }
  return { app, sb, people, post: (action, payload, token) => post(sb, action, payload, token), filePut, fileGet };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const PORT = Number(process.env.PORT || 8840);
  const w = buildWorld();
  console.log('inspSetup', JSON.stringify(w.post('inspSetup', {}, w.sb.__admin)).slice(0, 120));
  console.log('ACCOUNTS ' + JSON.stringify(Object.fromEntries(Object.entries(w.people).map(([k, v]) => [k, v.emp]))));
  console.log('密碼一律 fake-staff-pw-1；admin＝BOSS / ' + ADMIN_PW);
  http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let out;
      try {
        if (req.url.indexOf('/platform/svc/apv-file-put') === 0) out = JSON.stringify(w.filePut(JSON.parse(body || '{}')));
        else if (req.url.indexOf('/platform/svc/apv-file-get') === 0) out = JSON.stringify(w.fileGet(JSON.parse(body || '{}')));
        else out = w.sb.doPost({ postData: { contents: body } }).getContent();
      } catch (e) { out = JSON.stringify({ ok: false, error: String(e) }); }
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(out);
    });
  }).listen(PORT, '127.0.0.1', () => console.log('營運巡檢測試後端 http://127.0.0.1:' + PORT + '/platform/api'));
}
