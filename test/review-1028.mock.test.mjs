// node test/review-1028.mock.test.mjs —— 2026-10-28 夜間審查修正的回歸測試（後端）：
// 績效逐題匿名守門（我的成績／主管明細，live／final／hist）、績效範圍看區域、系統帳不得用 DZY 編號、簽核 client_id 格式。
// 骨架照抄 eval-actions.mock.test.mjs（vm 載 .gs、假試算表、全程 doPost）。⚠ 全部假資料（dzy 是 public repo）。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'Perms.gs', 'PermActions.gs', 'ApprovalRoute.gs', 'Approvals.gs', 'EvalCalc.gs', 'Eval.gs', 'Inspect.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}
function note(label, extra) { console.log('NOTE: ' + label + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); }

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
  const props = { HMAC_SECRET: 'fake-hmac-adv' };
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
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  return { sb: sandbox, sheets, cache, props };
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
      ['u003', 'hr1', '系統人資', 'hrsys', '', salt, HASHER.hashPassword_('fake-hr-pw-01', salt), 'TRUE', '', '']
    ],
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['hrsys', '系統人資', 'platform.staff'], ['staff', '員工', '']],
    module_secrets: [['backend_id', 'level', 'secret']],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  };
}
const adminTok = (sb) => post(sb, 'login', { username: 'BOSS', password: ADMIN_PW }).data.token;
let seq = 0;
function claim(sb, name, org, pw) {
  post(sb, 'staffImport', { names: [name] }, sb.__admin);
  const lk = post(sb, 'claimLookup', { name });
  seq++;
  const prof = Object.assign({ dept: '', birthday: '1990-01-0' + (1 + (seq % 8)), phone: '09' + String(20000000 + seq), address: '新竹市測試路' + seq + '號' }, org);
  const sub = post(sb, 'claimSubmit', Object.assign({ name, emp_no: lk.data.emp_no, password: pw || 'fake-staff-pw-1' }, prof));
  if (!sub.ok) throw new Error('claimSubmit 失敗 ' + sub.error + ' ' + name);
  return lk.data.emp_no;
}
function mk(sb, name, org, pw) {
  const emp = claim(sb, name, org, pw);
  const cf = post(sb, 'staffConfirm', { emp_no: emp }, sb.__admin);
  if (!cf.ok) throw new Error('staffConfirm 失敗 ' + cf.error + ' ' + name);
  const lg = post(sb, 'login', { username: emp, password: pw || 'fake-staff-pw-1' });
  if (!lg.ok) throw new Error('登入失敗 ' + lg.error);
  return { emp, token: lg.data.token };
}
const HQ = (dept, title) => ({ brand: 'dzy', unit: 'dzy-hq', dept, title });
const MALA = (unit, title) => ({ brand: 'mala', unit, title });
const MZT = (unit, title) => ({ brand: 'mzt', unit, title });

function scene() {
  const app = load(freshSeed());
  const { sb } = app;
  sb.setupStaff();
  app.sheets.staff.getRange(1, sb.STF_EXTRA_DEPTS_COL_NO).setValue('extra_depts');
  sb.__admin = adminTok(sb);
  const P = {
    hrHm: mk(sb, '人資主管', HQ('hr', 'hm')),
    sm: mk(sb, '光復店長', MZT('mzt-gf', 'sm')),
    pt1: mk(sb, '計時甲', MZT('mzt-gf', 'pt')),
    pt2: mk(sb, '計時乙', MZT('mzt-gf', 'pt')),
    ft1: mk(sb, '正職丙', MZT('mzt-gf', 'ft')),
    osvA: mk(sb, '督導A', MZT('mzt-hq', 'osv')),
    osvB: mk(sb, '督導B', MZT('mzt-hq', 'osv')),
    odir: mk(sb, '小辛辣總監', MZT('mzt-hq', 'odir')),
    sm2: mk(sb, '美村店長', MZT('mzt-js', 'sm')),
    pt3: mk(sb, '美村計時', MZT('mzt-js', 'pt')),
    msm: mk(sb, '小辛辣店長', MALA('mala-gf', 'sm')),
    ceo: mk(sb, '執行長', HQ('mgmt', 'ceo')),
    gm: mk(sb, '總經理', HQ('mgmt', 'gm')),
    chair: mk(sb, '董事長', HQ('mgmt', 'chair')),
    fin: mk(sb, '財務同仁', HQ('fin', 'hs')),
    pur: mk(sb, '採購同仁', HQ('purchase', 'hs'))
  };
  post(sb, 'permInit', {}, sb.__admin);
  app.props.PERMS_ON = '1';
  app.P = P;
  app.as = (who, action, payload) => post(sb, action, payload || {}, who === 'admin' ? sb.__admin : (who === 'hrsys' ? app.hrsysTok : P[who].token));
  app.hrsysTok = post(sb, 'login', { username: 'hr1', password: 'fake-hr-pw-01' }).data.token;
  return app;
}
const setToday = (app, d) => { app.sb.evToday_ = () => d; };
const LV = ['五', '四', '三', '二', '一'];
const items = (keys) => keys.map((k) => ({ key: k, label: '題目' + k, levels: LV }));
const finRows = (app) => app.sheets.ev_final._data;
const seedEval = (app) => {
  const { as } = app;
  ok(as('admin', 'evSetup').ok, '前置 evSetup');
  ['pt_att', 'pt_perf', 'ft_att'].forEach((set) => ok(as('hrHm', 'evBankSave', { brand: 'mzt', set, items: items([set + '1', set + '2']) }).ok, '前置 題庫 ' + set));
  ok(as('hrHm', 'evTplSave', { brand: 'mzt', title: 'ft', items: [{ key: 'k1', type: '技能', label: 'x', weight: 70 }] }).ok, '前置 KPI 範本');
};

// ============================================================
// 1. 我的成績：同事少於兩人 → 不回逐題（live）
// ============================================================
(() => {
  const app = scene(); const { P, as } = app;
  seedEval(app);
  setToday(app, '2026-10-03');
  ok(as('pt2', 'evPeerSubmit', { ratings: [{ ratee: P.pt1.emp, att: [5, 1], perf: [4, 2] }] }).ok, '1 前置：只有計時乙評計時甲');
  ok(as('pt1', 'evSelfSubmit', { att: [3, 3], perf: [3, 3] }).ok, '1 前置：計時甲自評');
  ok(as('pt1', 'evPeerSubmit', { ratings: [{ ratee: P.ft1.emp, att: [5, 2] }, { ratee: P.pt2.emp, att: [4, 4], perf: [4, 4] }] }).ok, '1 前置：只有計時甲評正職丙（正職丙沒自評）');
  ok(as('ft1', 'evPeerSubmit', { ratings: [{ ratee: P.pt2.emp, att: [2, 2], perf: [2, 2] }] }).ok, '1 前置：計時乙有兩位同事評');
  setToday(app, '2026-10-15');
  const q = as('pt1', 'evMyScores').data.quarters[0];
  ok(q && q.attItems === null && q.perfItems === null && q.itemsHidden === true, 'MYS-1 ★1 位同事＋自評：我的成績不回 attItems／perfItems（不能拿自評反推）', q && { attItems: q.attItems, perfItems: q.perfItems });
  ok(q && typeof q.total === 'number' && typeof q.attitude === 'number', 'MYS-1 總分照常回', q && q.total);
  const q2 = as('ft1', 'evMyScores').data.quarters[0];
  ok(q2 && q2.attItems === null && q2.itemsHidden === true && q2.peerAttItems === null, 'MYS-2 ★1 位同事、沒自評：attItems 不回（否則＝對方原始分）', q2 && q2.attItems);
  const q3 = as('pt2', 'evMyScores').data.quarters[0];
  ok(q3 && Array.isArray(q3.attItems) && Array.isArray(q3.perfItems) && !q3.itemsHidden, 'MYS-3 兩位同事照常有逐題', q3 && q3.attItems);
})();

// ============================================================
// 2. 主管明細／我的成績：定稿、匯入也依人數守門；定稿存 peerCount
// ============================================================
(() => {
  const app = scene(); const { P, as, sb } = app;
  seedEval(app);
  setToday(app, '2026-10-03');
  ok(as('pt1', 'evPeerSubmit', { ratings: [{ ratee: P.ft1.emp, att: [5, 2] }, { ratee: P.pt2.emp, att: [5, 1], perf: [4, 2] }] }).ok, '2 前置：只有計時甲評正職丙、計時乙');
  ok(as('ft1', 'evPeerSubmit', { ratings: [{ ratee: P.pt1.emp, att: [4, 4] , perf: [4, 4] }] }).ok && as('pt2', 'evPeerSubmit', { ratings: [{ ratee: P.pt1.emp, att: [2, 2], perf: [2, 2] }] }).ok, '2 前置：計時甲有兩位同事評');
  setToday(app, '2026-10-15');
  ok(as('sm', 'evSupSave', { emp: P.ft1.emp, quarter: '2026-Q3', kpi: { k1: { sel: 'A' } } }).ok, '2 前置：店長打正職丙 KPI');
  const fin = as('hrHm', 'evFinalize', { unit: 'mzt-gf', quarter: '2026-Q3' });
  ok(fin.ok, '2 前置：定稿', fin);
  const stored = (emp) => { const h = finRows(app)[0]; const row = finRows(app).find((r) => r[h.indexOf('emp_no')] === emp); return row ? JSON.parse(row[h.indexOf('result')]) : null; };
  ok(stored(P.ft1.emp) && stored(P.ft1.emp).peerCount === 1 && stored(P.pt1.emp).peerCount === 2, 'FRZ-1 ★定稿結果存下 peerCount', { ft1: stored(P.ft1.emp) && stored(P.ft1.emp).peerCount, pt1: stored(P.pt1.emp) && stored(P.pt1.emp).peerCount });
  const d1 = as('sm', 'evPersonDetail', { emp: P.ft1.emp, quarter: '2026-Q3' });
  ok(d1.data.source === 'final' && d1.data.result.attItems === null && d1.data.result.itemsHidden === true, 'FRZ-2 ★定稿後主管明細：1 位同事評 → 不回逐題', d1.data.result && d1.data.result.attItems);
  const d2 = as('sm', 'evPersonDetail', { emp: P.pt2.emp, quarter: '2026-Q3' });
  ok(d2.data.result.attItems === null && d2.data.result.perfItems === null, 'FRZ-3 ★定稿後主管明細：計時 1 位同事 → attItems／perfItems 都不回');
  const d3 = as('sm', 'evPersonDetail', { emp: P.pt1.emp, quarter: '2026-Q3' });
  ok(Array.isArray(d3.data.result.attItems) && !d3.data.result.itemsHidden, 'FRZ-4 定稿後兩位同事照常有逐題');
  const m1 = as('ft1', 'evMyScores').data.quarters[0];
  ok(m1.source === 'final' && m1.attItems === null && m1.itemsHidden === true, 'FRZ-5 ★定稿後我的成績也守門', m1.attItems);
  // 舊定稿資料（沒有 peerCount）：用 attCount（含自評）保守判斷
  const h = finRows(app)[0];
  const rewrite = (emp, fn) => { const row = finRows(app).find((r) => r[h.indexOf('emp_no')] === emp); const o = JSON.parse(row[h.indexOf('result')]); fn(o); row[h.indexOf('result')] = JSON.stringify(o); };
  rewrite(P.pt1.emp, (o) => { delete o.peerCount; o.attCount = 2; });
  ok(as('sm', 'evPersonDetail', { emp: P.pt1.emp, quarter: '2026-Q3' }).data.result.attItems === null, 'OLD-1 ★舊定稿沒有 peerCount、attCount 2（可能 1 同事＋自評）→ 保守遮掉');
  rewrite(P.pt1.emp, (o) => { o.attCount = 3; });
  ok(Array.isArray(as('sm', 'evPersonDetail', { emp: P.pt1.emp, quarter: '2026-Q3' }).data.result.attItems), 'OLD-2 舊定稿 attCount 3 → 至少兩位同事，照常回逐題');
  rewrite(P.pt1.emp, (o) => { delete o.attCount; });
  ok(as('sm', 'evPersonDetail', { emp: P.pt1.emp, quarter: '2026-Q3' }).data.result.attItems === null, 'OLD-3 ★人數完全不明 → 遮掉');
  // 匯入（hist）也守門
  ok(as('hrHm', 'evImportCommit', { rows: [{ quarter: '2026-Q2', emp: P.pt1.emp, kind: 'pt', result: { attitude: 10, performance: 10, total: 20, attItems: [5, 5], perfItems: [5, 5], attLabels: ['a', 'b'], perfLabels: ['c', 'd'] } }] }).ok, '2 前置：匯入 2026-Q2');
  const hd = as('sm', 'evPersonDetail', { emp: P.pt1.emp, quarter: '2026-Q2' });
  ok(hd.data.source === 'hist' && hd.data.result.attItems === null, 'HIST-1 ★匯入成績沒有人數 → 主管明細不回逐題', hd.data.result && hd.data.result.attItems);
  setToday(app, '2026-10-20');
  const hm = as('pt1', 'evMyScores').data.quarters.find((x) => x.quarter === '2026-Q2');
  ok(hm && hm.attItems === null && hm.total === 20, 'HIST-2 ★匯入成績在我的成績也不回逐題、總分照常', hm);
})();

// ============================================================
// 3. 績效範圍看區域（REGIONS_ON='1'）
// ============================================================
(() => {
  const app = scene(); const { P, as, sb } = app;
  ok(as('admin', 'evSetup').ok, '3 前置 evSetup');
  const l0 = as('hrsys', 'regionList');
  ok(as('hrsys', 'regionSave', { region: { name: 'A區', brand: 'mzt', stores: ['mzt-gf'], supervisor: P.osvA.emp }, expected_ver: l0.data.ver }).ok, '3 前置 A 區');
  const l1 = as('hrsys', 'regionList');
  ok(as('hrsys', 'regionSave', { region: { name: 'B區', brand: 'mzt', stores: ['mzt-js'], supervisor: P.osvB.emp }, expected_ver: l1.data.ver }).ok, '3 前置 B 區');
  // 開關關：維持舊行為（同品牌督導都能管）
  const off = as('osvA', 'evUnitResults', { unit: 'mzt-js' });
  ok(off.ok && off.data.rows.some((r) => r.emp === P.sm2.emp && r.canManage), 'REG-0 開關關：督導A 仍可管美村店長（行為同區域上線前）');
  app.props.REGIONS_ON = '1'; sb.regionCtxReset_();
  const ur = as('osvA', 'evUnitResults', { unit: 'mzt-js' });
  ok(ur.ok && ur.data.rows.some((r) => r.emp === P.sm2.emp) && !ur.data.rows.some((r) => r.emp === P.sm2.emp && r.canManage), 'REG-1 ★開關開：督導A 對 B 區店長 canManage=false（查看仍走 platform.eval-brand 品牌範圍，不變）', ur.ok ? ur.data.rows.map((r) => r.emp + ':' + r.canManage) : ur.error);
  ok(as('osvA', 'evSupSave', { emp: P.sm2.emp, quarter: '2026-Q3', feedback: 'x' }).error === 'forbidden', 'REG-2 ★開關開：督導A 不能替 B 區店長打分／調整');
  const pd = as('osvA', 'evPersonDetail', { emp: P.sm2.emp, quarter: '2026-Q3' });
  ok(pd.ok && pd.data.canManage === false, 'REG-3 ★開關開：督導A 看 B 區店長明細時不能編（canManage=false）', pd.data && pd.data.canManage);
  ok(as('osvB', 'evSupSave', { emp: P.sm2.emp, quarter: '2026-Q3', feedback: 'x' }).ok, 'REG-4 B 區督導照常可替自己區的店長打分');
  ok(as('osvA', 'evSupSave', { emp: P.sm.emp, quarter: '2026-Q3', feedback: 'x' }).ok, 'REG-5 督導A 照常可替 A 區店長打分');
})();

// ============================================================
// 4. 系統帳不得用 DZY 編號當帳號
// ============================================================
(() => {
  const app = scene(); const { as } = app;
  ['DZY123', 'dzy123', 'Dzy0456'].forEach((u) => {
    const r = as('admin', 'saveUser', { username: u, name: '假系統帳', role: 'hrsys', node: '', password: 'fake-sys-pw-0001' });
    ok(r.ok === false && /同仁編號/.test(r.error || ''), 'USR-1 ★系統帳 username=' + u + ' → 擋（中文錯誤）', r);
  });
  const good = as('admin', 'saveUser', { username: 'sysdzy1', name: '假系統帳', role: 'hrsys', node: '', password: 'fake-sys-pw-0001' });
  ok(good.ok, 'USR-2 一般系統帳名照常可建', good);
  const users = as('admin', 'listUsers').data.users;
  const me = users.find((u) => u.username === 'sysdzy1');
  const ren = as('admin', 'saveUser', { id: me.id, username: 'DZY777', name: '假系統帳', role: 'hrsys', node: '' });
  ok(ren.ok === false && /同仁編號/.test(ren.error || ''), 'USR-3 ★修改時改成 DZY777 → 擋', ren);
})();

// ============================================================
// 6. 簽核 client_id：至少一個非數字字元
// ============================================================
(() => {
  const app = scene(); const { as } = app;
  ok(as('admin', 'apvSetup').ok, '6 前置 apvSetup');
  const body = { items: [{ name: 'a', qty: 1, unit: '個', price: 100 }], purpose: 'x', need_date: '2026-11-01' };
  const num = as('pt1', 'apvSubmit', { client_id: '12345678', type: 'purchase', body, files: [] });
  ok(num.ok === false && num.error === 'bad_request', 'APV-1 ★client_id 全數字（試算表會轉成數字、重送比對失準）→ 擋', num);
  const uuid = as('pt1', 'apvSubmit', { client_id: '0b8f2c1e-5d1a-4c3e-9f00-123456789abc', type: 'purchase', body, files: [] });
  ok(uuid.ok, 'APV-2 前端 UUID 照常可送', uuid);
  ok(as('pt1', 'apvSubmit', { client_id: 'cid-00000001', type: 'purchase', body, files: [] }).ok, 'APV-3 含字母的 client_id 照常可送');
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
