// test/e2e/eval_backend.mjs —— 績效評核 e2e 用的本機後端：把 apps-script/platform 的 .gs 載進 vm（同 test/eval-actions.mock.test.mjs），
// 種假人員、假評分，包成 http://127.0.0.1:<PORT>/platform/api。GET /__today?d=YYYY-MM-DD 改「今天」。全部假資料、只聽 127.0.0.1。
// 做法同 staff.mock.test.mjs：Auth／Users／Staff／Perms／PermActions／Code 讀進同一個 vm sandbox，全程走 doPost。
// ⚠ 姓名、生日、手機、地址全是假資料（dzy 是 public repo）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Perms.gs', 'PermActions.gs', 'ApprovalRoute.gs', 'Approvals.gs', 'EvalCalc.gs', 'Eval.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

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

// ── 本機測試後端：把 vm 裡的平台後端包成 HTTP（只在本機，假資料）──
import http from 'node:http';
const PORT = Number(process.env.PORT || 8798);
const app = load(freshSeed());
const { sb } = app;
sb.setupStaff();
app.sheets.staff.getRange(1, sb.STF_EXTRA_DEPTS_COL_NO).setValue('extra_depts');
sb.__admin = adminTok(sb);
const MALA = (title) => ({ brand: 'mala', unit: 'mala-gf', title });
const people = {
  hrHm: mk(sb, '測試人資主管', HQ('hr', 'hm')),
  sm: mk(sb, '測試光復店長', MALA('sm')),
  pt1: mk(sb, '測試計時甲', MALA('pt')),
  pt2: mk(sb, '測試計時乙', MALA('pt')),
  pt3: mk(sb, '測試計時丙', MALA('pt')),
  ft1: mk(sb, '測試正職丁', MALA('ft')),
  osv: mk(sb, '測試小辛辣督導', { brand: 'mala', unit: 'mala-hq', title: 'osv' }),
  msm: mk(sb, '測試墨竹亭店長', { brand: 'mzt', unit: 'mzt-gf', title: 'sm' }),
  mpt: mk(sb, '測試墨竹亭計時', { brand: 'mzt', unit: 'mzt-gf', title: 'pt' }),
  ceo: mk(sb, '測試執行長', HQ('mgmt', 'ceo'))
};
post(sb, 'permInit', {}, sb.__admin);
app.props.PERMS_ON = '1';
let today = process.env.TODAY || '2027-01-03';
sb.evToday_ = () => today;
const A = sb.__admin;
console.log('evSetup', JSON.stringify(post(sb, 'evSetup', {}, A)).slice(0, 80));
const { MALA_SEED } = await import('../../modules/eval/seed-mala.js');
for (const b of ['mala', 'mzt']) {
  for (const k of ['pt_att', 'pt_perf', 'ft_att']) post(sb, 'evBankSave', { brand: b, set: k, items: MALA_SEED[k] }, A);
}
const banks = { pt_attitude: MALA_SEED.pt_att, pt_perf: MALA_SEED.pt_perf, ft_attitude: MALA_SEED.ft_att };
const KPI = [['sales', '技能', '營業額', 5, '月營業額達標'], ['profit', '技能', '獲利率', 10, '淨利率 10%'], ['op', '技能', '營運評分', 20, '稽核 90 分以上'], ['stock', '技能', '盤點差異', 5, '差異 1% 以內'], ['google', '技能', 'Google 評論', 5, '4.5 星以上'],
  ['e6', '執行力', '主管交辦一', 5, ''], ['e7', '執行力', '主管交辦二', 5, ''], ['e8', '執行力', '主管交辦三', 5, ''], ['e9', '執行力', '主管交辦四', 5, ''], ['e10', '執行力', '主管交辦五', 5, '']]
  .map(([key, type, label, weight, target]) => ({ key, type, label, weight, target, a: '達成 100%', b: '達成 90%', c: '達成 80%', d: '未達 80%' }));
console.log('tpl', JSON.stringify(post(sb, 'evTplSave', { brand: 'mala', title: 'ft', items: KPI }, A)));
post(sb, 'evTplSave', { brand: 'mala', title: 'sm', items: KPI }, A);
// 假的上一季成績（2026-Q3，舊系統匯入）＋本季部分互評，讓「我的成績」「單位結果」有東西
post(sb, 'evImportCommit', { rows: [
  { quarter: '2026-Q3', emp: people.pt1.emp, kind: 'pt', result: { attitude: 24, performance: 55, total: 79 } },
  { quarter: '2026-Q3', emp: people.ft1.emp, kind: 'ft', result: { attitude: 25.2, performance: 58, total: 83.2 } }] }, A);
const tok = (k) => people[k].token;
const stars = (n, base) => Array.from({ length: n }, (_, i) => Math.max(1, Math.min(5, base - (i % 3 === 0 ? 1 : 0))));
const nAtt = banks.pt_attitude.length, nPerf = banks.pt_perf.length, nFt = banks.ft_attitude.length;
for (const [rater, base] of [['pt2', 4], ['pt3', 5], ['sm', 4]]) {
  const ratings = ['pt1', 'pt2', 'pt3', 'ft1', 'sm'].filter((k) => k !== rater).map((k) => ({ ratee: people[k].emp, att: stars(k === 'ft1' || k === 'sm' ? nFt : nAtt, base), perf: k === 'ft1' || k === 'sm' ? [] : stars(nPerf, base) }));
  console.log('peer', rater, JSON.stringify(post(sb, 'evPeerSubmit', { ratings }, tok(rater))).slice(0, 60));
}
post(sb, 'evSelfSubmit', { att: stars(nAtt, 4), perf: stars(nPerf, 4), note: '下一季要練好炸燙', company: '希望冷藏櫃換新', peers: [{ to: people.pt2.emp, msg: '謝謝你常常幫我補料', anon: true }] }, tok('pt3'));
// 新人：pt3 到職日 2026-12-01（1/3 已滿月）
{ const col = sb.STF_COL_COUNT; const row = app.sheets.staff._data.find((r) => r[sb.STF_COL.emp_no] === people.pt3.emp); while (row.length <= col) row.push(''); row[col] = '2026-12-01'; }
const accounts = Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.emp]));
console.log('ACCOUNTS ' + JSON.stringify(accounts));

http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url.startsWith('/__today')) { today = new URL(req.url, 'http://x').searchParams.get('d') || today; res.writeHead(200, cors); return res.end(today); }
    let out;
    try { out = sb.doPost({ postData: { contents: body } }).getContent(); } catch (e) { out = JSON.stringify({ ok: false, error: String(e) }); }
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
    res.end(out);
  });
}).listen(PORT, '127.0.0.1', () => console.log('eval 測試後端 http://127.0.0.1:' + PORT + '/platform/api  今天＝' + today));
