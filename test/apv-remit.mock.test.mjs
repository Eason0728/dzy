// node test/apv-remit.mock.test.mjs —— 表單簽核三種送單（個人代墊、單位請款、人事異動）＋財務部匯款清單（2026-11-18，docs/remit/progress.md）
// 沙盒、假人員沿用 test/apv-actions.mock.test.mjs（DZY909 財務同仁、DZY912 財務部主管多一個 remit 角色＝platform.remit）。
// ⚠ 姓名、編號全是假資料；dzy 是 public repo。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const FILES = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'Perms.gs', 'PermActions.gs', 'ApprovalRoute.gs', 'Approvals.gs', 'Code.gs'];
const SRC = FILES.map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}
const J = (x) => JSON.stringify(x);
const eq = (a, b) => J(a) === J(b);

// ── GAS 假物件 ──────────────────────────────────────────────
function makeSheet(rows) {
  const data = (rows || []).map((r) => r.slice());
  const fmt = {};
  return {
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
    _data: data,
    _fmt: fmt
  };
}
const bytes = (v) => (Buffer.isBuffer(v) ? v : typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => (b < 0 ? b + 256 : b) & 0xff)));
const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));

function load(seed) {
  const sheets = {};
  Object.keys(seed).forEach((k) => { sheets[k] = makeSheet(seed[k]); });
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; } };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-for-approval-tests' };
  const locks = { tries: 0, busy: false };
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
      put: (k, v, ttl) => cache.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null }),
      remove: (k) => cache.delete(k)
    }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { locks.tries++; return !locks.busy; }, releaseLock() {} }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  return { sb: sandbox, sheets, cache, props, locks };
}

// ── 假人員（全部虛構）──
// [編號, 姓名, 帳號角色, 單位, 部門, 職稱, 狀態]
const PEOPLE = [
  ['DZY901', '測試甲', 'staff', 'mala-gf', '', 'ft'],         // 光復店員（送件人）
  ['DZY902', '測試乙', 'staff', 'mala-gf', '', 'sm'],         // 光復店長
  ['DZY903', '測試丙', 'staff', 'mala-hq', '', 'odir'],       // 小辛辣總監
  ['DZY904', '測試丁', 'staff', 'dzy-hq', 'mgmt', 'gm'],      // 總經理
  ['DZY905', '測試戊', 'staff', 'dzy-hq', 'mgmt', 'ceo'],     // 執行長
  ['DZY906', '測試己', 'staff', 'dzy-hq', 'mgmt', 'chair'],   // 董事長
  ['DZY907', '測試庚', 'staff', 'dzy-hq', 'purchase', 'hs'],  // 採購同仁（承辦）
  ['DZY908', '測試辛', 'staff', 'dzy-hq', 'purchase', 'hm'],  // 採購主管
  ['DZY909', '測試壬', 'remit', 'dzy-hq', 'fin', 'hs'],       // 財務同仁（承辦）
  ['DZY910', '測試癸', 'hr', 'dzy-hq', 'hr', 'hm'],           // 人資主管（platform.staff）
  ['DZY911', '測試子', 'hr', 'dzy-hq', 'hr', 'hs'],           // 人資同仁（platform.staff）
  ['DZY912', '測試丑', 'remit', 'dzy-hq', 'fin', 'hm'],       // 財務主管
  ['DZY913', '測試寅', 'staff', 'mzt-gf', '', 'sm'],          // 墨竹亭店長
  ['DZY914', '測試卯', 'staff', 'dzy-hq', 'it', 'hs'],        // 資訊部同仁（與簽核無關的人）
  ['DZY915', '測試辰', 'staff', 'mala-gf', '', 'pt'],         // 光復計時（另一位同店同仁）
  ['DZY916', '測試巳', 'staff', 'mala-hq', '', 'osv'],        // 小辛辣區督導（oam 2026-10-20 停用）
  ['DZY917', '測試午', 'staff', 'mala-gf', '', 'ft', 'unclaimed'],   // 還沒開通
  ['DZY918', '測試未', 'staff', 'ck', '', 'ft'],              // 央廚店員
  ['DZY919', '測試申', 'staff', 'ck', '', 'fm']               // 央廚廠長（2026-10-20 起央廚不設店長）
];
const ADMIN_PW = 'fake-admin-pw-01';
const MZ = (emp) => 'u' + emp.slice(3);

function freshApp(opts) {
  opts = opts || {};
  const hasher = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
  const salt = 'salt-x';
  const hash = hasher.hashPassword_('fake-staff-pw-1', salt);
  const users = [['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at'],
    ['u001', 'BOSS', '系統管理者', 'admin', '', salt, hasher.hashPassword_(ADMIN_PW, salt), 'TRUE', '', '']];
  PEOPLE.forEach((p) => users.push([MZ(p[0]), p[0], p[1], p[2], '', salt, hash, 'TRUE', '', '']));
  const app = load({
    users, roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['staff', '員工', 'platform.self'], ['hr', '人資', 'platform.staff,platform.self'], ['remit', '財務（匯款清單）', 'platform.self,platform.remit']],
    module_secrets: [['backend_id', 'level', 'secret']], login_log: [['at', 'username', 'ip_hash', 'result']]
  });
  const sb = app.sb;

  sb.setupStaff();
  const st = app.sheets.staff;
  PEOPLE.forEach((p) => {
    const row = new Array(sb.STF_COL_COUNT).fill('');
    const put = (k, v) => { row[sb.STF_COL[k]] = v; };
    put('emp_no', p[0]); put('user_id', MZ(p[0])); put('name', p[1]); put('status', p[6] || 'active');
    put('unit', p[3]); put('dept', p[4]); put('title', p[5]);
    st._data.push(row);
  });
  if (!opts.noSetup) sb.setupApprovals();
  app.tok = {};
  app.tok.admin = sb.issueToken_({ id: 'u001', role: 'admin', node: '' });
  PEOPLE.forEach((p) => { app.tok[p[0]] = sb.issueToken_({ id: MZ(p[0]), role: p[2], node: '' }); });
  return app;
}

function post(app, who, action, payload) {
  const token = who === null ? 'bad.token' : (app.tok[who] || who);
  return JSON.parse(app.sb.doPost({ postData: { contents: JSON.stringify({ action, token, payload: payload || {} }) } }).getContent());
}
const col = (headers) => { const m = {}; headers.forEach((h, i) => { m[h] = i; }); return m; };
function rowsOf(app, sheet, headers) {
  const c = col(headers);
  return (app.sheets[sheet]._data.slice(1)).map((r) => { const o = {}; Object.keys(c).forEach((h) => { o[h] = r[c[h]]; }); return o; });
}
const FORMS = (app) => rowsOf(app, 'apv_forms', ['id', 'type', 'status', 'sender', 'unit', 'subject', 'amount', 'body_json', 'route_json', 'step', 'step_at', 'handler_dept', 'created_at', 'updated_at', 'rev', 'client_id']);
const EVENTS = (app, id) => rowsOf(app, 'apv_events', ['at', 'form_id', 'rev', 'actor', 'action', 'note', 'sha256']).filter((e) => !id || e.form_id === id);
const FILEROWS = (app) => rowsOf(app, 'apv_files', ['id', 'owner', 'form_id', 'path', 'bytes', 'sha256', 'created_at', 'kind', 'state', 'seq', 'rev', 'deleting_at']);
const formOf = (app, id) => FORMS(app).find((f) => f.id === id);
function setCell(app, sheet, headers, id, key, val, idKey) {
  const c = col(headers);
  const row = app.sheets[sheet]._data.find((r, i) => i > 0 && r[c[idKey || 'id']] === id);
  row[c[key]] = val;
}
const FORM_H = ['id', 'type', 'status', 'sender', 'unit', 'subject', 'amount', 'body_json', 'route_json', 'step', 'step_at', 'handler_dept', 'created_at', 'updated_at', 'rev', 'client_id'];
const FILE_H = ['id', 'owner', 'form_id', 'path', 'bytes', 'sha256', 'created_at', 'kind', 'state', 'seq', 'rev', 'deleting_at'];
const ageStep = (app, id, ms) => setCell(app, 'apv_forms', FORM_H, id, 'step_at', Date.now() - ms);
const HOUR = 3600 * 1000;
const SHA = 'a'.repeat(64);

let cid = 0;
const newCid = () => 'client-' + (++cid) + '-' + crypto.randomBytes(4).toString('hex');
function upload(app, emp, kind) {
  const r = app.sb.apvFileRegister_(emp, { kind: kind || 'receipt', bytes: 1000, sha256: SHA });
  if (!r.ok) throw new Error('upload 失敗 ' + J(r));
  if (!app.sb.apvFileCommit_(r.id).ok) throw new Error('commit 失敗');   // jobs 在 rename 成功後呼叫
  return r.id;
}
const expenseBody = (o) => Object.assign({ spend_date: '2026-10-17', category: 'repair', amount: 800, desc: '測試維修', payee: 'self' }, o || {});
function sendExpense(app, emp, amount, extra) {
  const f = upload(app, emp);
  const r = post(app, emp, 'apvSubmit', Object.assign({ client_id: newCid(), type: 'expense', body: expenseBody({ amount }), files: [f] }, extra || {}));
  r.file = f;
  return r;
}
const purchaseBody = (o) => Object.assign({ items: [{ name: '測試品', qty: 2, unit: '個', price: 100 }], purpose: '測試用途', need_date: '2026-10-30' }, o || {});
const getForm = (app, who, id) => post(app, who, 'apvGet', { id });
const decide = (app, who, id, decision, o) => {
  const g = getForm(app, 'admin', id).data.form;
  return post(app, who, 'apvDecide', Object.assign({ id, rev: g.rev, step: g.step, decision }, o || {}));
};
const idRe = (() => { const d = new Date(Date.now() + 8 * HOUR); const p = (n) => String(n).padStart(2, '0'); return String(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()); })();


// ============================================================
// 匯款清單＋三種送單（2026-11-18 Eason，docs/remit/progress.md）
//   個人代墊 advance／單位請款 unitpay：核決權限那一關 → 財務部主管 → handling（承辦 fin）＝匯款清單待出帳 → 標記已匯款＝done
//   會計不簽核只出帳；財務部主管本人送單 → 財務部主管那關本人核准（第 10 題 B）；同一人兩關都是 → 簽一次兩關都算
// ============================================================
const advBody = (o) => Object.assign({ spend_date: '2026-11-15', category: 'supplies', amount: 800, desc: '文具' }, o || {});
const upBody = (o) => Object.assign({ pay_date: '2026-11-25', category: 'repair', amount: 8600, desc: '冷藏櫃壓縮機', vendor_name: '範例冷凍行' }, o || {});
function send(app, emp, type, body) {
  return post(app, emp, 'apvSubmit', { client_id: newCid(), type, body, files: [upload(app, emp)] });
}
const roles = (r) => (r.steps || r.data.route.steps).map((s) => s.role + ':' + s.status).join();
const remitList = (app, who, p) => post(app, who, 'apvRemitList', p || {});
const rowOf = (app, who, id, p) => { const r = remitList(app, who, p); return r.ok ? r.data.rows.find((x) => x.id === id) : null; };
const TODAY = new Date(Date.now() + 8 * HOUR).toISOString().slice(0, 10);
// 兼任部門欄（第 27 欄，同 apv-actions 測試的做法）
const setExtra = (app, emp, v) => { app.sheets.staff._data[0][26] = 'extra_depts'; app.sheets.staff._data.forEach((r, n) => { if (n > 0 && r[app.sb.STF_COL.emp_no] === emp) { while (r.length <= 26) r.push(''); r[26] = v; } }); };

// ---- R1 送單：三種可送、舊費用請款不能新送、欄位檢查 ----
{
  const app = freshApp();
  ok(send(app, 'DZY901', 'expense', { spend_date: '2026-11-15', category: 'repair', amount: 800, desc: 'x', payee: 'self' }).error === 'bad_request', 'R1 舊種類 expense 不能新送');
  const a = send(app, 'DZY901', 'advance', advBody());
  ok(a.ok && roles(a) === 'head:pending,fin_head:pending' && a.data.route.handler === 'fin', 'R1 個人代墊 800：店長 → 財務部主管，承辦 fin', a);
  const f = formOf(app, a.data.id);
  ok(f.type === 'advance' && JSON.parse(f.body_json).payee === 'self' && JSON.parse(f.body_json).spend_date === '2026-11-15', 'R1 個人代墊存 payee self、支出日');
  const u = send(app, 'DZY901', 'unitpay', upBody({ vendor_name: '  範例   冷凍行 ' }));
  ok(u.ok && roles(u) === 'brand_dir:pending,fin_head:pending', 'R1 單位請款 8,600：品牌總監 → 財務部主管', u);
  ok(JSON.parse(formOf(app, u.data.id).body_json).vendor_name === '範例 冷凍行' && JSON.parse(formOf(app, u.data.id).body_json).payee === 'vendor', 'R1 廠商名稱去頭尾空白、中間空白併一個；payee vendor');
  ok(send(app, 'DZY901', 'unitpay', upBody({ vendor_name: '' })).error === 'bad_request', 'R1 單位請款沒廠商 → bad_request');
  ok(send(app, 'DZY901', 'unitpay', upBody({ pay_date: '2026-02-30' })).error === 'bad_request', 'R1 希望付款日不合法 → bad_request');
  ok(send(app, 'DZY901', 'advance', advBody({ spend_date: '' })).error === 'bad_request', 'R1 個人代墊沒支出日 → bad_request');
  ok(post(app, 'DZY901', 'apvSubmit', { client_id: newCid(), type: 'advance', body: advBody(), files: [] }).error === 'no_files', 'R1 沒附收據 → no_files');
  const pv = post(app, 'DZY901', 'apvRoutePreview', { type: 'unitpay', amount: 42000 });
  ok(pv.ok && pv.data.steps.map((s) => s.role).join() === 'chair,fin_head' && pv.data.steps[1].candidates[0].emp === 'DZY912', 'R1 預覽 42,000：董事長 → 財務部主管（測試丑）', pv);
}

// ---- R2 簽核：會計不能簽、兩關都過才進待出帳、待我辦不出現、apvHandle 擋 ----
{
  const app = freshApp();
  const a = send(app, 'DZY901', 'advance', advBody());
  const id = a.data.id;
  ok(decide(app, 'DZY909', id, 'approve').ok === false, 'R2 財務同仁（會計）不能簽核');
  ok(decide(app, 'DZY912', id, 'approve').ok === false, 'R2 財務部主管不能跳過第一關先簽');
  const d1 = decide(app, 'DZY902', id, 'approve');
  ok(d1.ok && d1.data.status === 'signing' && d1.data.step === 1, 'R2 店長核准 → 還在簽核，到第二關', d1);
  const g = getForm(app, 'DZY912', id);
  ok(g.ok && g.data.form.can.decide === true, 'R2 財務部主管看得到、可以核准');
  ok(decide(app, 'DZY902', id, 'approve').error === 'forbidden', 'R2 店長不能簽第二關');
  const d2 = decide(app, 'DZY912', id, 'approve');
  ok(d2.ok && d2.data.status === 'handling', 'R2 財務部主管核准 → handling（待出帳）', d2);
  const todo = post(app, 'DZY909', 'apvTodo', {});
  ok(todo.ok && todo.data.handle.length === 0, 'R2 待我辦不出現個人代墊（改在匯款清單）', todo.data);
  const hv = getForm(app, 'DZY909', id);
  ok(hv.ok && hv.data.form.can.handle === false, 'R2 can.handle＝false');
  ok(post(app, 'DZY909', 'apvHandle', { id, rev: 1, step: null, result: 'done' }).error === 'forbidden', 'R2 apvHandle 擋（請到匯款清單）');
  // 退回：主管退回 → rejected，不進清單
  const b = send(app, 'DZY901', 'advance', advBody({ amount: 900 }));
  decide(app, 'DZY902', b.data.id, 'approve');
  ok(decide(app, 'DZY912', b.data.id, 'reject', { note: '收據不清楚' }).data.status === 'rejected', 'R2 財務部主管可以退回');
  ok(!rowOf(app, 'DZY909', b.data.id, { state: 'all' }), 'R2 被退回的單不在匯款清單');
}

// ---- R3 財務部主管本人送單（第 10 題 B）、會計本人送單（第 4 題：照核決權限） ----
{
  const app = freshApp();
  const a = send(app, 'DZY912', 'advance', advBody({ amount: 3000 }));
  ok(a.ok && a.data.status === 'handling' && roles(a) === 'head:done,fin_head:done' && a.data.route.steps.every((s) => s.self), 'R3 財務部主管送 3,000：部門主管那關本人、財務部主管那關本人，送出即待出帳', a);
  const ev = EVENTS(app, a.data.id).map((e) => e.action + ':' + e.note);
  ok(ev.indexOf('approve:本人核准（金額在自己的核決權限內）') !== -1 && ev.indexOf('approve:本人核准（財務部主管本人送單）') !== -1, 'R3 兩筆本人核准事件', ev);
  const b = send(app, 'DZY912', 'advance', advBody({ amount: 20000 }));
  ok(b.ok && roles(b) === 'gm:pending,fin_head:done' && b.data.status === 'signing', 'R3 財務部主管送 20,000：總經理照簽，財務部主管那關本人核准', b);
  const c = send(app, 'DZY909', 'advance', advBody({ amount: 800 }));
  ok(c.ok && roles(c) === 'head:pending,fin_head:pending' && getForm(app, 'admin', c.data.id).data.form.route.steps[0].candidates[0].emp === 'DZY912', 'R3 會計（財務同仁）送 800：部門總監＝財務部主管簽第一關', c);
  const dc = decide(app, 'DZY912', c.data.id, 'approve');
  ok(dc.ok && dc.data.status === 'handling', 'R3 第一關的人就是財務部主管 → 簽一次兩關都算', dc);
  const r = getForm(app, 'admin', c.data.id).data.form.route.steps;
  ok(r[1].status === 'done' && r[1].dup === true && r[1].by === 'DZY912', 'R3 第二關標 dup、by 財務部主管', r);
  ok(EVENTS(app, c.data.id).some((e) => e.action === 'approve' && e.note === '同時是財務部主管，一併核准'), 'R3 一併核准事件');
}

// ---- R4 兼任財務部總監＝財務部主管；總經理兼財務主管簽一次；財務部沒人 → 往上；董事長送單照樣給財務部主管 ----
{
  const app = freshApp();
  setExtra(app, 'DZY904', 'fin:hm');   // 總經理兼任財務部總監
  const a = send(app, 'DZY901', 'unitpay', upBody({ amount: 20000 }));
  const fh = getForm(app, 'admin', a.data.id).data.form.route.steps[1];
  ok(a.ok && roles(a) === 'gm:pending,fin_head:pending' && fh.candidates.map((x) => x.emp).sort().join() === 'DZY904,DZY912', 'R4 兼任財務部總監也是財務部主管候選人', fh);
  const d = decide(app, 'DZY904', a.data.id, 'approve');
  ok(d.ok && d.data.status === 'handling', 'R4 總經理（兼財務部主管）核准一次 → 兩關都過', d);
  const ch = send(app, 'DZY906', 'advance', advBody({ amount: 50000 }));
  ok(ch.ok && roles(ch) === 'chair:done,fin_head:pending' && ch.data.status === 'signing', 'R4 董事長送 50,000：本人核准後仍給財務部主管（不比職級）', ch);
  const app2 = freshApp();
  app2.sheets.staff._data.forEach((r) => { if (r[app2.sb.STF_COL.emp_no] === 'DZY912') r[app2.sb.STF_COL.status] = 'disabled'; });
  const b = send(app2, 'DZY901', 'advance', advBody());
  decide(app2, 'DZY902', b.data.id, 'approve');
  const bs = getForm(app2, 'admin', b.data.id).data.form;
  ok(bs.route.steps.map((s) => s.role + ':' + s.status).join() === 'head:done,fin_head:skipped,ceo:pending' && bs.route.steps[2].candidates[0].emp === 'DZY905', 'R4 財務部沒有在職主管 → 往上找執行長', bs.route.steps);
  const rs = post(app2, 'DZY910', 'apvReassign', { id: b.data.id, rev: 1, step: 0, to: 'DZY913', reason: 'x' });
  ok(rs.ok === false, 'R4 改派仍照原規則（不相干的人不行）');
}

// ---- R5 匯款清單權限、單位會計設定 ----
{
  const app = freshApp();
  const a = send(app, 'DZY901', 'advance', advBody());
  decide(app, 'DZY902', a.data.id, 'approve'); decide(app, 'DZY912', a.data.id, 'approve');
  ['DZY901', 'DZY914', 'DZY910'].forEach((w) => ok(remitList(app, w).error === 'forbidden', `R5 沒有 platform.remit（${w}）→ forbidden`));
  ok(post(app, 'DZY914', 'apvVendorList', {}).error === 'forbidden' && post(app, 'DZY914', 'apvAcctGet', {}).error === 'forbidden' && post(app, 'DZY914', 'apvRemitMark', { id: a.data.id, rev: 1, paid_date: TODAY }).error === 'forbidden', 'R5 沒權限的人讀不到廠商、會計、不能標記');
  ok(remitList(app, 'admin').ok, 'R5 admin（*）可讀');
  const l = remitList(app, 'DZY909');
  const r0 = l.data.rows[0];
  ok(l.ok && l.data.rows.length === 1 && r0.state === 'pending' && r0.self_pay === true && r0.payee === '測試甲（DZY901）' && r0.amount === 800 && r0.mine === false && r0.accountants.length === 0, 'R5 待出帳一筆、同仁代墊、還沒設定會計', l.data);
  ok(l.data.summary.pending === 1 && l.data.summary.unassigned === 1 && l.data.summary.mine === 0 && l.data.summary.pending_total === 800, 'R5 摘要：待出帳 1、未設定會計 1', l.data.summary);
  ok(getForm(app, 'DZY909', a.data.id).ok && getForm(app, 'DZY914', a.data.id).ok === false, 'R5 有匯款清單權限看得到單（含收據）；無關的人看不到');
  const g = post(app, 'DZY909', 'apvAcctGet', {});
  ok(g.ok && g.data.can_edit === false && g.data.candidates.map((x) => x.emp).sort().join() === 'DZY909,DZY912' && g.data.units.some((u) => u.unit === 'mala-gf'), 'R5 單位會計：財務同仁只能看、候選人＝財務部同仁', g.data.candidates);
  ok(post(app, 'DZY909', 'apvAcctSave', { unit: 'mala-gf', emps: ['DZY909'], expected_updated_at: 0 }).error === 'forbidden', 'R5 財務同仁不能設定單位會計');
  ok(post(app, 'DZY912', 'apvAcctSave', { unit: 'mala-gf', emps: ['DZY914'], expected_updated_at: 0 }).error === 'bad_request', 'R5 不是財務部的人不能當會計');
  ok(post(app, 'DZY912', 'apvAcctSave', { unit: 'nope', emps: [], expected_updated_at: 0 }).error === 'bad_request', 'R5 單位不存在 → bad_request');
  const s1 = post(app, 'DZY912', 'apvAcctSave', { unit: 'mala-gf', emps: ['dzy909'], expected_updated_at: 0 });
  ok(s1.ok && eq(s1.data.emps, ['DZY909']), 'R5 財務部主管設定光復會計＝財務同仁（編號大小寫不拘）', s1);
  ok(post(app, 'admin', 'apvAcctSave', { unit: 'mala-gf', emps: [], expected_updated_at: 0 }).error === 'conflict', 'R5 expected_updated_at 不符 → conflict');
  const l2 = remitList(app, 'DZY909');
  ok(l2.data.rows[0].mine === true && l2.data.summary.mine === 1 && l2.data.summary.unassigned === 0, 'R5 設定後：我負責、摘要 mine 1', l2.data.summary);
  ok(post(app, 'DZY909', 'apvRemitSummary', {}).data.mine === 1, 'R5 apvRemitSummary 同一套數字');
  // 會計調離財務部 → 自動不算
  app.sheets.staff._data.forEach((r) => { if (r[app.sb.STF_COL.emp_no] === 'DZY909') r[app.sb.STF_COL.dept] = 'it'; });
  ok(remitList(app, 'DZY912').data.rows[0].accountants.length === 0, 'R5 會計調出財務部 → 那個單位視同沒設定');
}

// ---- R6 標記已匯款／取消、推損益不重推 ----
{
  const app = freshApp();
  const a = send(app, 'DZY901', 'advance', advBody({ category: 'repair', amount: 1200 }));
  const id = a.data.id;
  decide(app, 'DZY902', id, 'approve'); decide(app, 'DZY912', id, 'approve');
  const mark = (p) => post(app, 'DZY909', 'apvRemitMark', Object.assign({ id, rev: 1, paid_date: TODAY }, p || {}));
  ok(mark({ paid_date: '2099-01-01' }).error === 'bad_request', 'R6 未來日期 → bad_request');
  ok(mark({ paid_date: '' }).error === 'bad_request', 'R6 沒匯款日 → bad_request');
  ok(mark({ rev: 2 }).error === 'conflict', 'R6 rev 不符 → conflict');
  ok(post(app, 'DZY909', 'apvRemitMark', { id: 'APV-000000-999', rev: 1, paid_date: TODAY }).error === 'not_found', 'R6 不存在的單 → not_found');
  ok(app.sb.apvPnlClaim_(Date.now(), 20).length === 0, 'R6 還沒匯款不推損益');
  const m = mark({ note: '網銀' });
  ok(m.ok && formOf(app, id).status === 'done', 'R6 標記已匯款 → 結案 done', m);
  ok(EVENTS(app, id).some((e) => e.action === 'handle' && e.note === '已匯款 ' + TODAY + '：網銀'), 'R6 寫 handle 事件（已匯款＋日期＋備註）');
  const pr = rowOf(app, 'DZY909', id, { state: 'paid', month: TODAY.slice(0, 7) });
  ok(pr && pr.state === 'paid' && pr.paid.date === TODAY && pr.paid.by === 'DZY909' && pr.paid.note === '網銀', 'R6 已匯款列帶匯款日、誰標的', pr);
  ok(!rowOf(app, 'DZY909', id, { state: 'pending' }), 'R6 已匯款不在待出帳');
  ok(mark().error === 'conflict', 'R6 重標 → conflict');
  const claim = app.sb.apvPnlClaim_(Date.now(), 20);
  ok(claim.length === 1 && claim[0].form_id === id && claim[0].store_id === 'S01' && claim[0].acc_id === 'A102' && claim[0].spend_month === '2026-11' && claim[0].amount === 1200, 'R6 結案後推損益：光復 S01、設備維修 A102、支出月', claim);
  app.sb.apvPnlMark_(id, { ok: true, month: '2026-11', row_id: 'r1' });
  ok(post(app, 'DZY909', 'apvRemitUnmark', { id, rev: 1, reason: '' }).error === 'bad_request', 'R6 取消沒原因 → bad_request');
  const um = post(app, 'DZY909', 'apvRemitUnmark', { id, rev: 1, reason: '匯錯帳戶' });
  ok(um.ok && formOf(app, id).status === 'handling' && EVENTS(app, id).some((e) => e.action === 'unpaid' && e.note === '匯錯帳戶'), 'R6 取消已匯款 → 回待出帳、寫 unpaid 事件', um);
  ok(rowOf(app, 'DZY909', id, { state: 'pending' }).state === 'pending', 'R6 回到待出帳清單');
  ok(mark().ok && app.sb.apvPnlClaim_(Date.now(), 20).length === 0, 'R6 重新標記後損益不重推');
  ok(post(app, 'DZY909', 'apvExport', { month: TODAY.slice(0, 7) }).data.rows.some((x) => x.id === id && x.type === 'advance' && x.category === '設備維修'), 'R6 匯出（apvExport）含個人代墊');
}

// ---- R7 單位請款＋廠商帳戶 ----
{
  const app = freshApp();
  const u = send(app, 'DZY901', 'unitpay', upBody());
  const id = u.data.id;
  decide(app, 'DZY903', id, 'approve'); decide(app, 'DZY912', id, 'approve');
  let r = rowOf(app, 'DZY909', id);
  ok(r && r.bank === null && r.self_pay === false && r.payee === '範例冷凍行' && r.date === '2026-11-25' && r.date_label === '希望付款日', 'R7 單位請款待出帳、還沒有帳戶', r);
  ok(post(app, 'DZY909', 'apvRemitMark', { id, rev: 1, paid_date: TODAY }).error === 'no_account', 'R7 沒帳戶不能標記已匯款');
  const vs = (p) => post(app, 'DZY909', 'apvVendorSave', Object.assign({ name: '範例冷凍行', bank_code: '004', bank_name: '臺灣銀行', branch: '新竹分行', acct_name: '範例冷凍行', acct_no: '012-345-678901', note: '' }, p || {}));
  ok(vs({ bank_code: '4' }).error === 'bad_request', 'R7 銀行代碼不是 3 碼 → bad_request');
  ok(vs({ acct_no: '12ab' }).error === 'bad_request' && vs({ acct_no: '12345' }).error === 'bad_request' && vs({ acct_no: '-1234567' }).error === 'bad_request', 'R7 帳號格式不對 → bad_request');
  ok(vs({ acct_name: '' }).error === 'bad_request', 'R7 沒戶名 → bad_request');
  ok(post(app, 'DZY914', 'apvVendorSave', { name: 'x' }).error === 'forbidden', 'R7 沒權限不能存廠商');
  const v1 = vs({ name: ' 範例冷凍行 ' });
  ok(v1.ok && v1.data.id === 'V0001', 'R7 新增廠商帳戶 V0001', v1);
  ok(vs({ name: '範例冷凍行' }).error === 'dup', 'R7 同名再新增 → dup');
  const names = post(app, 'DZY901', 'apvVendorNames', {});
  ok(names.ok && eq(names.data.names, ['範例冷凍行']) && J(names).indexOf('012-345') === -1, 'R7 送件人拿得到廠商名稱、拿不到帳號', names);
  ok(post(app, 'DZY901', 'apvVendorList', {}).error === 'forbidden', 'R7 送件人看不到廠商帳戶');
  r = rowOf(app, 'DZY909', id);
  ok(r.bank && r.bank.bank_code === '004' && r.bank.acct_no === '012-345-678901', 'R7 設定後清單帶出帳戶', r.bank);
  ok(r.overdue === ('2026-11-25' < TODAY), 'R7 過了希望付款日才標逾期');
  ok(post(app, 'DZY909', 'apvRemitMark', { id, rev: 1, paid_date: TODAY }).ok, 'R7 有帳戶後可以標記已匯款');
  const list = post(app, 'DZY909', 'apvVendorList', {});
  const v = list.data.vendors[0];
  ok(post(app, 'DZY909', 'apvVendorSave', { id: v.id, expected_updated_at: v.updated_at - 1, name: v.name, bank_code: '004', bank_name: '臺灣銀行', acct_name: 'x', acct_no: '99999999' }).error === 'conflict', 'R7 修改帶舊的 updated_at → conflict');
  const ed = post(app, 'DZY909', 'apvVendorSave', { id: v.id, expected_updated_at: v.updated_at, name: v.name, bank_code: '822', bank_name: '中國信託', acct_name: '範例冷凍行', acct_no: '99999999' });
  ok(ed.ok, 'R7 修改廠商帳戶');
  const pr = rowOf(app, 'DZY909', id, { state: 'paid', month: TODAY.slice(0, 7) });
  ok(pr.bank.bank_code === '004' && pr.bank.acct_no === '012-345-678901', 'R7 已匯款那筆留當時的帳戶快照（改帳戶不影響）', pr.bank);
  const log = post(app, 'DZY909', 'apvVendorList', {}).data.vendors[0].log;
  ok(log.length === 2 && log[0].action === 'edit' && log[1].action === 'add' && log[0].actor === 'DZY909', 'R7 異動紀錄（新的在前）', log);
  const v2 = post(app, 'DZY909', 'apvVendorList', {}).data.vendors[0];
  ok(post(app, 'DZY909', 'apvVendorToggle', { id: v2.id, active: false, expected_updated_at: v2.updated_at }).ok && eq(post(app, 'DZY901', 'apvVendorNames', {}).data.names, []), 'R7 停用廠商 → 名稱建議不再出現');
  const u2 = send(app, 'DZY901', 'unitpay', upBody({ amount: 500 }));
  decide(app, 'DZY902', u2.data.id, 'approve'); decide(app, 'DZY912', u2.data.id, 'approve');
  ok(rowOf(app, 'DZY909', u2.data.id).bank === null, 'R7 停用的廠商不帶帳戶');
  ok(vs({ name: '範例冷凍行' }).error === 'dup', 'R7 停用的同名廠商也擋（請重新啟用）');
}

// ---- R8 試跑清單、分派表、寫入鎖 ----
{
  const app = freshApp();
  const READS = ['apvRemitList', 'apvRemitSummary', 'apvVendorList', 'apvVendorNames', 'apvAcctGet'];
  const WRITES = ['apvRemitMark', 'apvRemitUnmark', 'apvVendorSave', 'apvVendorToggle', 'apvAcctSave'];
  const dry = fs.readFileSync(path.join(__dirname, '..', 'platform', 'dryrun.js'), 'utf8');
  ok(READS.every((a) => dry.indexOf(`'${a}'`) !== -1) && WRITES.every((a) => dry.indexOf(`'${a}'`) === -1), 'R8 讀取列進 dryrun READ_ACTIONS、寫入不列');
  const codeSrc = fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8');
  const mut = (/var MUTATING_ACTIONS = \{([\s\S]*?)\};/.exec(codeSrc) || [])[1] || '';
  ok(WRITES.every((a) => new RegExp('\\b' + a + ': 1').test(mut)) && READS.every((a) => !new RegExp('\\b' + a + ': 1').test(mut)), 'R8 寫入都在 MUTATING_ACTIONS（拿全域鎖）、讀取不在');
  ok(READS.concat(WRITES).every((a) => post(app, 'DZY914', a, {}).error !== 'bad_request' || a === 'apvVendorNames'), 'R8 十支都接在分派表');
  ok(app.sb.PERM_GRANTABLE.indexOf('platform.remit') !== -1 && app.sb.PERM_LOCKED.indexOf('platform.remit') === -1 && app.sb.permName_('platform.remit') === '匯款清單', 'R8 platform.remit 可給、不鎖碼、中文名匯款清單');
  ok(app.sb.PERM_DEFAULT_RULES.some((r) => r.join() === 'hq,fin,*,platform.remit'), 'R8 預設規則：總部財務部全部職稱');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
