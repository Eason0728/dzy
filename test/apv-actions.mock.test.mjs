// node test/apv-actions.mock.test.mjs —— 第三期表單簽核 P1：每支 action 的權限、狀態轉移、並行、可見度、檔案、彙整
// （docs/approvals/task.md T1-3～T1-7、T2-1、T4-4；規格 spec §14、契約 api.md）
// 做法同 staff.mock.test.mjs：Auth／Users／Staff／Perms／PermActions／ApprovalRoute／Approvals／Code 讀進同一個 vm sandbox，全程走 doPost。
// ⚠ 姓名、編號全是假資料（測試甲、DZY9xx）；dzy 是 public repo，不得出現真實同仁資料。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const FILES = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Perms.gs', 'PermActions.gs', 'ApprovalRoute.gs', 'Approvals.gs', 'Code.gs'];
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
  ['DZY909', '測試壬', 'staff', 'dzy-hq', 'fin', 'hs'],       // 財務同仁（承辦）
  ['DZY910', '測試癸', 'hr', 'dzy-hq', 'hr', 'hm'],           // 人資主管（platform.staff）
  ['DZY911', '測試子', 'hr', 'dzy-hq', 'hr', 'hs'],           // 人資同仁（platform.staff）
  ['DZY912', '測試丑', 'staff', 'dzy-hq', 'fin', 'hm'],       // 財務主管
  ['DZY913', '測試寅', 'staff', 'mzt-gf', '', 'sm'],          // 墨竹亭店長
  ['DZY914', '測試卯', 'staff', 'dzy-hq', 'it', 'hs'],        // 資訊部同仁（與簽核無關的人）
  ['DZY915', '測試辰', 'staff', 'mala-gf', '', 'pt'],         // 光復計時（另一位同店同仁）
  ['DZY916', '測試巳', 'staff', 'mala-hq', '', 'oam'],        // 小辛辣區經理
  ['DZY917', '測試午', 'staff', 'mala-gf', '', 'ft', 'unclaimed'],   // 還沒開通
  ['DZY918', '測試未', 'staff', 'ck', '', 'ft'],              // 央廚店員
  ['DZY919', '測試申', 'staff', 'ck', '', 'sm']               // 央廚店長
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
    users, roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['staff', '員工', 'platform.self'], ['hr', '人資', 'platform.staff,platform.self']],
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
const FILEROWS = (app) => rowsOf(app, 'apv_files', ['id', 'owner', 'form_id', 'path', 'bytes', 'sha256', 'created_at', 'kind', 'state', 'seq', 'rev']);
const formOf = (app, id) => FORMS(app).find((f) => f.id === id);
function setCell(app, sheet, headers, id, key, val, idKey) {
  const c = col(headers);
  const row = app.sheets[sheet]._data.find((r, i) => i > 0 && r[c[idKey || 'id']] === id);
  row[c[key]] = val;
}
const FORM_H = ['id', 'type', 'status', 'sender', 'unit', 'subject', 'amount', 'body_json', 'route_json', 'step', 'step_at', 'handler_dept', 'created_at', 'updated_at', 'rev', 'client_id'];
const FILE_H = ['id', 'owner', 'form_id', 'path', 'bytes', 'sha256', 'created_at', 'kind', 'state', 'seq', 'rev'];
const ageStep = (app, id, ms) => setCell(app, 'apv_forms', FORM_H, id, 'step_at', Date.now() - ms);
const HOUR = 3600 * 1000;
const SHA = 'a'.repeat(64);

let cid = 0;
const newCid = () => 'client-' + (++cid) + '-' + crypto.randomBytes(4).toString('hex');
function upload(app, emp, kind) {
  const r = app.sb.apvFileRegister_(emp, { kind: kind || 'receipt', bytes: 1000, sha256: SHA });
  if (!r.ok) throw new Error('upload 失敗 ' + J(r));
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
// 1. setupApprovals
// ============================================================
{
  const app = freshApp();
  const s = app.sheets;
  const H = (n) => s[n]._data[0].join('|');
  ok(H('apv_forms') === 'id|type|status|sender|unit|subject|amount|body_json|route_json|step|step_at|handler_dept|created_at|updated_at|rev|client_id', '建表：apv_forms 表頭（含 client_id）');
  ok(H('apv_events') === 'at|form_id|rev|actor|action|note|sha256', '建表：apv_events 表頭（含 sha256）');
  ok(H('apv_files') === 'id|owner|form_id|path|bytes|sha256|created_at|kind|state|seq|rev', '建表：apv_files 表頭（kind／state／seq）');
  ok(H('apv_thresholds') === 'form_type|seq|max_amount|store_role|hq_role|ver', '建表：apv_thresholds 表頭（含 ver）');
  ok(H('apv_threshold_log') === 'at|actor|form_type|before_json|after_json', '建表：apv_threshold_log');
  ok(H('apv_revisions') === 'form_id|rev|at|body_json|amount|files_json|route_json|thr_ver|sha256', '建表：apv_revisions');
  ok(s.apv_thresholds._data.length === 5 && s.apv_thresholds._data[1].join() === 'spend,1,5000,head,head,1' && s.apv_thresholds._data[4].join() === 'spend,4,,chair,chair,1', '建表：預設四列門檻（5000／10000／30000／以上）');
  app.sb.setupApprovals();
  ok(s.apv_thresholds._data.length === 5, '重跑 setupApprovals 不重複寫預設列');
  const t = app.sb.apvReadTable_();
  ok(t.ver === 1 && t.rows.length === 4 && t.rows[3].max === null, 'apvReadTable_ 讀回預設表');
  // 表頭不一致 → 停
  const bad = freshApp({ noSetup: true });
  bad.sheets.apv_forms = makeSheet([['id', 'WRONG']]);
  let err = '';
  try { bad.sb.setupApprovals(); } catch (e) { err = String(e.message); }
  ok(/表頭/.test(err), '表頭被改 → setupApprovals 停下（不蓋掉資料）', err);
  // 承辦部門不在 org → 停
  const noDept = freshApp({ noSetup: true });
  noDept.sheets.org._data.forEach((r) => { if (r[0] === 'dept' && r[1] === 'purchase') r[7] = 'FALSE'; });
  let err2 = '';
  try { noDept.sb.setupApprovals(); } catch (e) { err2 = String(e.message); }
  ok(/purchase/.test(err2) && noDept.sheets.apv_forms === undefined, '承辦部門 purchase 在 org 停用 → setupApprovals 停下，一張表都沒建', err2);
  // 未初始化的讀寫 → not_inited
  const raw = freshApp({ noSetup: true });
  ok(post(raw, 'DZY901', 'apvMine', {}).error === 'not_inited' && post(raw, 'DZY901', 'apvSubmit', { client_id: 'abcdefgh1', type: 'expense' }).error === 'not_inited', '沒建表 → not_inited，不自動建表');
  ok(post(raw, 'DZY901', 'apvSetup', {}).error === 'forbidden', '一般同仁不能 apvSetup');
  { const r = post(raw, 'admin', 'apvSetup', {}); ok(r.ok && post(raw, 'admin', 'apvThresholdGet', {}).ok && post(raw, 'admin', 'apvThresholdGet', {}).data.rows.length === 4, 'admin apvSetup → 建表＋預設四列', r); }
  ok(post(raw, 'admin', 'apvSetup', {}).ok && post(raw, 'admin', 'apvThresholdGet', {}).data.rows.length === 4, '重按 apvSetup 不重複寫');
}

// ============================================================
// 2. Code.gs 接線：白名單、寫入鎖、jobs 專用函式不在分派表
// ============================================================
{
  const app = freshApp();
  const READS = ['apvThresholdGet', 'apvRoutePreview', 'apvMine', 'apvTodo', 'apvGet', 'apvList', 'apvExport', 'apvFileMeta'];
  const WRITES = ['apvSubmit', 'apvResubmit', 'apvWithdraw', 'apvDecide', 'apvSign', 'apvHandle', 'apvReassign', 'apvVoid', 'apvThresholdSave'];
  ok(READS.concat(WRITES).every((a) => app.sb.CODE_ALLOWED_ACTIONS.indexOf(a) !== -1), '白名單含 8 支讀取＋9 支寫入 action');
  READS.forEach((a) => {
    app.locks.tries = 0;
    post(app, 'DZY901', a, {});
    ok(app.locks.tries === 0, `讀取 action 不拿寫入鎖：${a}`);
  });
  WRITES.forEach((a) => {
    app.locks.tries = 0;
    post(app, 'DZY901', a, {});
    ok(app.locks.tries === 1, `寫入 action 在全域寫入鎖內：${a}`);
  });
  app.locks.busy = true;
  const busy = post(app, 'DZY901', 'apvSubmit', { client_id: newCid(), type: 'expense', body: expenseBody(), files: [] });
  ok(busy.ok === false && !app.sheets.apv_forms._data[1], '寫入鎖逾時 → 失敗且沒寫任何列');
  app.locks.busy = false;
  ['apvFileAuthorize_', 'apvFileRegister_', 'apvFileCanRead_', 'apvFileSweepList_', 'apvFileSweepDone_', 'apvBackupList_', 'apvDigest_', 'apvReconcile_'].forEach((a) => {
    ok(app.sb.CODE_ALLOWED_ACTIONS.indexOf(a) === -1 && post(app, 'admin', a, {}).ok === false, `jobs 專用函式不在分派表：${a}`);
    ok(typeof app.sb[a] === 'function', `jobs 專用全域函式存在：${a}`);
  });
  // 壞 token：全部 unauthorized
  READS.concat(WRITES).forEach((a) => {
    const r = post(app, null, a, { id: 'APV-000000-001' });
    ok(r.ok === false && r.error === 'unauthorized', `壞 token → unauthorized：${a}`, r);
  });
  // dryrun 讀取清單
  const dry = fs.readFileSync(path.join(__dirname, '..', 'platform', 'dryrun.js'), 'utf8');
  ok(READS.every((a) => dry.includes("'" + a + "'")) && WRITES.every((a) => !new RegExp("READ_ACTIONS[\\s\\S]*?'" + a + "'[\\s\\S]*?audit:").test(dry)), 'dryrun READ_ACTIONS 補上 8 支讀取、沒有寫入類');
}

// ============================================================
// 3. 核決權限表 get／save
// ============================================================
{
  const app = freshApp();
  const g = post(app, 'DZY901', 'apvThresholdGet', {});
  ok(g.ok && g.data.ver === 1 && g.data.rows.length === 4 && eq(g.data.rows[1], { seq: 2, max: 10000, store_role: 'brand_dir', hq_role: 'head' }), '已開通同仁可讀門檻表', g);
  ok(post(app, 'DZY917', 'apvThresholdGet', {}).ok === false, '未開通同仁讀不到門檻表');
  ok(post(app, 'admin', 'apvThresholdGet', {}).ok === true, 'admin 可讀');
  const rows = g.data.rows;
  const save = (who, p) => post(app, who, 'apvThresholdSave', p);
  ['DZY901', 'DZY904', 'DZY906', 'DZY910'].forEach((w) => ok(save(w, { expected_ver: 1, rows }).error === 'forbidden', `非 role admin（${w}）不能存門檻`));
  ok(save('admin', { expected_ver: 1, rows: [] }).error === 'bad_request', '空表被擋');
  ok(save('admin', { expected_ver: 1, rows: [{ max: 100, store_role: 'head', hq_role: 'head' }, { max: 100, store_role: 'gm', hq_role: 'gm' }, { max: null, store_role: 'chair', hq_role: 'chair' }] }).error === 'bad_request', '金額沒遞增被擋');
  ok(save('admin', { expected_ver: 1, rows: [{ max: 100, store_role: 'head', hq_role: 'head' }] }).error === 'bad_request', '最後一列有金額被擋');
  ok(save('admin', { expected_ver: 1, rows: [{ max: null, store_role: 'pur', hq_role: 'head' }] }).error === 'bad_request', '權限人代碼不合法被擋');
  ok(save('admin', { rows }).error === 'bad_request', '缺 expected_ver 被擋');
  ok(app.sheets.apv_threshold_log._data.length === 1 && app.sheets.apv_thresholds._data.length === 5, '被擋的存檔不寫 log、不動表');
  // 先送一張 800 元（走舊表：店長）
  const old = sendExpense(app, 'DZY901', 800);
  ok(old.ok && JSON.parse(formOf(app, old.data.id).route_json).row.max === 5000, '舊表送的單：快照記著 5000 那一列');
  // 存新表：把第一列拉到 500、加一級
  const newRows = [{ max: 500, store_role: 'head', hq_role: 'head' }, { max: 5000, store_role: 'brand_dir', hq_role: 'head' }, { max: 10000, store_role: 'gm', hq_role: 'gm' }, { max: 100000, store_role: 'chair', hq_role: 'chair' }, { max: null, store_role: 'chair', hq_role: 'chair' }];
  const sv = save('admin', { expected_ver: 1, rows: newRows });
  ok(sv.ok && sv.data.ver === 2 && sv.data.diff.length >= 3, 'admin 存新表 ver 1→2，回 diff', sv);
  ok(sv.data.diff.some((d) => d.seq === 5 && d.before === null && d.after.store_role === 'chair'), 'diff 含新增的一級（before null）');
  const log = rowsOf(app, 'apv_threshold_log', ['at', 'actor', 'form_type', 'before_json', 'after_json']);
  ok(log.length === 1 && log[0].actor === 'u001' && JSON.parse(log[0].before_json).length === 4 && JSON.parse(log[0].after_json).length === 5, 'log 有操作者、改前 4 列、改後 5 列');
  ok(save('admin', { expected_ver: 1, rows: newRows }).error === 'conflict', 'expected_ver 過期 → conflict');
  ok(post(app, 'DZY901', 'apvThresholdGet', {}).data.ver === 2, '讀回新版本');
  const f2 = JSON.parse(formOf(app, old.data.id).route_json);
  ok(f2.row.max === 5000 && f2.thr_ver === 1, '改門檻後，已送出的單路線不變');
  const nw = sendExpense(app, 'DZY901', 800);
  ok(JSON.parse(formOf(app, nw.data.id).route_json).row.role === 'brand_dir' && JSON.parse(formOf(app, nw.data.id).route_json).thr_ver === 2, '之後新送的單走新表（800 元現在要品牌總監）');
  // 縮表：刪到只剩 2 列
  const sv2 = save('admin', { expected_ver: 2, rows: [{ max: 1000, store_role: 'head', hq_role: 'head' }, { max: null, store_role: 'gm', hq_role: 'gm' }] });
  ok(sv2.ok && sv2.data.ver === 3 && post(app, 'DZY901', 'apvThresholdGet', {}).data.rows.length === 2, '刪列後讀回 2 列（多的列已清空）', sv2);
  ok(app.sb.apvReadTable_().rows.length === 2, '清空的列不會被讀成權限表');
}

// ============================================================
// 4. 送出：欄位、金額、client_id、檔案綁定
// ============================================================
{
  const app = freshApp();
  const sub = (who, p) => post(app, who, 'apvSubmit', Object.assign({ client_id: newCid() }, p));
  // 權限
  ok(sub('admin', { type: 'expense', body: expenseBody(), files: [] }).error === 'forbidden', 'admin（沒有同仁列）不能送單');
  ok(sub('DZY917', { type: 'expense', body: expenseBody(), files: [] }).error === 'forbidden', '未開通同仁不能送單');
  ok(sub('DZY901', { type: 'expense', body: expenseBody(), files: [] }).error === 'no_files', '請款沒附收據 → no_files');
  ok(sub('DZY901', { type: 'nope', body: {}, files: [] }).error === 'bad_request', 'type 不合法 → bad_request');
  ok(post(app, 'DZY901', 'apvSubmit', { type: 'expense', body: expenseBody() }).error === 'bad_request', '缺 client_id → bad_request');
  // 金額反例
  const f1 = upload(app, 'DZY901');
  [[0, 'bad_amount'], [-5, 'bad_amount'], [12.5, 'bad_amount'], ['800', 'bad_amount'], [null, 'bad_amount'], [10000001, 'bad_amount'], [NaN, 'bad_amount']].forEach(([a, e]) => {
    const r = sub('DZY901', { type: 'expense', body: expenseBody({ amount: a }), files: [f1] });
    ok(r.error === e, `請款金額 ${J(a)} → ${e}`, r);
  });
  ok(FORMS(app).length === 0 && FILEROWS(app)[0].state === 'uploaded', '金額被擋時沒開單、檔案維持 uploaded');
  // 請購金額：自動算、忽略前端送的金額
  const p1 = sub('DZY901', { type: 'purchase', body: purchaseBody({ items: [{ name: '甲', qty: 1.5, unit: '包', price: 333 }] }), amount: 1, sender: 'DZY999', unit: 'x', route: { steps: [] }, handler_dept: 'pur', files: [] });
  ok(p1.ok && formOf(app, p1.data.id).amount === 500, '請購 1.5×333＝500（四捨五入）；前端亂送 amount 被忽略', p1);
  const pf = formOf(app, p1.data.id);
  ok(pf.sender === 'DZY901' && pf.unit === 'mala-gf' && pf.handler_dept === 'purchase', 'sender／unit／handler_dept 一律伺服器產生（purchase 不是 pur）', pf);
  ok(new RegExp('^APV-' + idRe + '-001$').test(p1.data.id), '單號格式 APV-YYMMDD-001（台北日期）', p1.data.id);
  ok(p1.data.status === 'signing' && p1.data.route.steps[0].role === 'head' && p1.data.route.handler === 'purchase', '請購路線：500 元 → 店長，承辦 purchase');
  const p2 = sub('DZY901', { type: 'purchase', body: purchaseBody(), files: [] });
  ok(p2.data.id.endsWith('-002'), '單號當天流水 +1', p2.data.id);
  [[{ items: [{ name: '甲', qty: 0, unit: '個', price: 1 }] }, 'bad_amount'], [{ items: [{ name: '甲', qty: 1, unit: '個', price: -1 }] }, 'bad_amount'],
    [{ items: [{ name: '甲', qty: '1', unit: '個', price: 1 }] }, 'bad_amount'], [{ items: [{ name: '甲', qty: 1.234, unit: '個', price: 1 }] }, 'bad_amount'],
    [{ items: [] }, 'bad_request'], [{ items: [{ name: '', qty: 1, unit: '個', price: 1 }] }, 'bad_request'], [{ purpose: '' }, 'bad_request'], [{ need_date: '2026-02-30' }, 'bad_request']].forEach(([o, e]) => {
    const r = sub('DZY901', { type: 'purchase', body: purchaseBody(o), files: [] });
    ok(r.error === e, `請購反例 ${J(o).slice(0, 60)} → ${e}`, r);
  });
  ok(sub('DZY901', { type: 'purchase', body: purchaseBody({ items: Array.from({ length: 31 }, () => ({ name: '甲', qty: 1, unit: '個', price: 1 })) }), files: [] }).error === 'bad_request', '請購明細 31 列被擋');
  // client_id 重送
  const cidX = newCid();
  const fx = upload(app, 'DZY901');
  const a1 = post(app, 'DZY901', 'apvSubmit', { client_id: cidX, type: 'expense', body: expenseBody({ amount: 1200 }), files: [fx] });
  const before = FORMS(app).length;
  const a2 = post(app, 'DZY901', 'apvSubmit', { client_id: cidX, type: 'expense', body: expenseBody({ amount: 1200 }), files: [fx] });
  ok(a1.ok && a2.ok && a1.data.id === a2.data.id && FORMS(app).length === before, '同一個人同一個 client_id 重送 → 回原單號、不另開');
  const a3 = post(app, 'DZY902', 'apvSubmit', { client_id: cidX, type: 'expense', body: expenseBody(), files: [upload(app, 'DZY902')] });
  ok(a3.ok && a3.data.id !== a1.data.id, '不同人用同一個 client_id 不會撞單');
  // 檔案綁定條件
  const mine = upload(app, 'DZY901'), theirs = upload(app, 'DZY902'), sign = upload(app, 'DZY901', 'sign');
  ok(sub('DZY901', { type: 'expense', body: expenseBody(), files: [theirs] }).error === 'file_invalid', '綁別人上傳的檔 → file_invalid');
  ok(sub('DZY901', { type: 'expense', body: expenseBody(), files: [sign] }).error === 'file_invalid', '收據不能用簽名檔（kind 不符）');
  ok(sub('DZY901', { type: 'expense', body: expenseBody(), files: ['FNOTEXIST12345'] }).error === 'file_invalid', '不存在的檔號 → file_invalid');
  ok(sub('DZY901', { type: 'expense', body: expenseBody(), files: ['bad id'] }).error === 'file_invalid', '檔號格式錯 → file_invalid');
  const six = [1, 2, 3, 4, 5, 6].map(() => upload(app, 'DZY901'));
  ok(sub('DZY901', { type: 'expense', body: expenseBody(), files: six }).error === 'file_invalid', '照片超過 5 張 → file_invalid');
  const five = six.slice(0, 5);
  const ok5 = sub('DZY901', { type: 'expense', body: expenseBody(), files: five });
  ok(ok5.ok && five.every((id) => { const r = FILEROWS(app).find((x) => x.id === id); return r.state === 'bound' && r.form_id === ok5.data.id && r.rev === 1; }), '5 張剛好可以；綁定後狀態 bound、記單號與 rev');
  ok(sub('DZY901', { type: 'expense', body: expenseBody(), files: [five[0]] }).error === 'file_invalid', '已綁定的檔不能再綁別張單');
  // purchase_id 檢查
  const dn = sub('DZY901', { type: 'expense', body: expenseBody({ purchase_id: p1.data.id }), files: [upload(app, 'DZY901')] });
  ok(dn.error === 'bad_request', '對應的請購單還沒結案 → 擋');
  ok(sub('DZY901', { type: 'expense', body: expenseBody({ payee: 'vendor' }), files: [upload(app, 'DZY901')] }).error === 'bad_request', 'payee＝vendor 要填 vendor_name');
  ok(sub('DZY901', { type: 'expense', body: expenseBody({ category: '雜支' }), files: [upload(app, 'DZY901')] }).error === 'bad_request', 'category 必須是代碼');
  // 事件與版本證據
  const ev = EVENTS(app, a1.data.id);
  const revs = rowsOf(app, 'apv_revisions', ['form_id', 'rev', 'at', 'body_json', 'amount', 'files_json', 'route_json', 'thr_ver', 'sha256']).filter((r) => r.form_id === a1.data.id);
  ok(ev.length === 1 && ev[0].action === 'submit' && /^[0-9a-f]{64}$/.test(ev[0].sha256) && revs.length === 1 && revs[0].sha256 === ev[0].sha256 && revs[0].rev === 1, '送出寫 submit 事件＋apv_revisions，兩邊 sha256 一致', { ev, revs });
  const want = crypto.createHash('sha256').update(revs[0].body_json + '|' + revs[0].amount + '|' + revs[0].files_json).digest('hex');
  ok(want === revs[0].sha256, 'sha256 ＝ body_json｜amount｜files_json 的 SHA-256');
}

// ============================================================
// 5. 路線預覽
// ============================================================
{
  const app = freshApp();
  const pv = (who, p) => post(app, who, 'apvRoutePreview', p);
  const r = pv('DZY901', { type: 'expense', amount: 8600 });
  ok(r.ok && r.data.steps.length === 1 && r.data.steps[0].role === 'brand_dir' && eq(r.data.steps[0].candidates, [{ emp: 'DZY903', name: '測試丙' }]) && r.data.handler === 'fin', '預覽 8,600：品牌總監＝測試丙，承辦 fin', r);
  ok(pv('DZY901', { type: 'purchase', amount: 42000 }).data.steps[0].role === 'chair', '預覽請購 42,000 → 董事長');
  ok(pv('DZY901', { type: 'expense', amount: 0 }).error === 'bad_amount', '預覽金額 0 → bad_amount');
  ok(pv('DZY917', { type: 'expense', amount: 800 }).error === 'forbidden', '未開通同仁不能預覽');
  const ck = pv('DZY918', { type: 'expense', amount: 8000 });
  ok(ck.data.steps.map((s) => s.role + ':' + s.status).join() === 'brand_dir:skipped,ceo:pending' && ck.data.steps[1].candidates[0].emp === 'DZY905', '預覽央廚 8,000：品牌總監 skipped → 執行長', ck.data.steps);
  const lv = pv('DZY902', { type: 'personnel', kind: 'leave', subject: 'DZY901' });
  ok(lv.ok && lv.data.steps[0].role === 'self_sign' && lv.data.steps[0].candidates[0].emp === 'DZY901' && lv.data.steps[1].role === 'direct', '預覽主管送離職：本人簽名＋直屬主管', lv);
  ok(pv('DZY915', { type: 'personnel', kind: 'transfer', subject: 'DZY901' }).error === 'forbidden', '預覽：一般同仁不能送別人的調職');
  const selfLv = pv('DZY901', { type: 'personnel', kind: 'leave' });
  ok(selfLv.ok && selfLv.data.steps[0].role === 'self_sign' && selfLv.data.steps[0].emp === 'DZY901' && selfLv.data.steps[1].role === 'direct', '預覽本人送離職、不帶 subject → 視為本人（本人簽名當場完成＋直屬主管）', selfLv);
  ok(FORMS(app).length === 0, '預覽不寫任何單');
}

// ============================================================
// 6. 簽核主流程：核准→承辦→結案；§14.3 每個轉移；conflict
// ============================================================
{
  const app = freshApp();
  const s = sendExpense(app, 'DZY901', 8600);
  const id = s.data.id;
  ok(s.ok && s.data.route.steps[0].role === 'brand_dir', '8,600 請款 → 品牌總監一關');
  // 權限反向
  ['DZY901', 'DZY902', 'DZY904', 'DZY914', 'DZY910', 'DZY909'].forEach((w) => {
    const r = post(app, w, 'apvDecide', { id, rev: 1, step: 0, decision: 'approve' });
    ok(r.ok === false && r.error === 'forbidden', `非目前這關的人（${w}）不能核准`, r);
  });
  ok(post(app, 'DZY901', 'apvDecide', { id, rev: 1, step: 0, decision: 'approve' }).error === 'forbidden', '送件人不能核准自己的單');
  const gv = getForm(app, 'DZY903', id);
  ok(gv.ok && gv.data.form.can.decide === true && gv.data.form.can.withdraw === false && gv.data.form.route.steps[0].candidates[0].emp === 'DZY903', 'apvGet：候選人看得到單，can.decide＝true');
  ok(post(app, 'DZY903', 'apvDecide', { id, rev: 1, step: 0, decision: 'maybe' }).error === 'bad_request', 'decision 不合法 → bad_request');
  ok(post(app, 'DZY903', 'apvDecide', { id, rev: 1, step: 0, decision: 'reject' }).error === 'bad_request', '退回沒寫原因 → bad_request');
  ok(post(app, 'DZY903', 'apvDecide', { id, rev: 1, step: 0, decision: 'reject', note: '   ' }).error === 'bad_request', '退回原因空白 → bad_request');
  ok(post(app, 'DZY903', 'apvDecide', { id, rev: 2, step: 0, decision: 'approve' }).error === 'conflict', 'rev 不符 → conflict');
  ok(post(app, 'DZY903', 'apvDecide', { id, rev: 1, step: 3, decision: 'approve' }).error === 'conflict', 'step 不符 → conflict');
  ok(post(app, 'DZY903', 'apvDecide', { id: 'APV-000000-999', rev: 1, step: 0, decision: 'approve' }).error === 'not_found', '不存在的單 → not_found');
  ok(post(app, 'DZY903', 'apvHandle', { id, rev: 1, result: 'done' }).error === 'conflict', '還在簽核中不能承辦（狀態不符）');
  const ap = post(app, 'DZY903', 'apvDecide', { id, rev: 1, step: 0, decision: 'approve', note: '同意' });
  ok(ap.ok && ap.data.status === 'handling' && ap.data.step === null, '品牌總監核准 → handling', ap);
  ok(post(app, 'DZY903', 'apvDecide', { id, rev: 1, step: 0, decision: 'approve' }).error === 'conflict', '同一個人重按第二次 → conflict（狀態已變）');
  ok(post(app, 'DZY905', 'apvDecide', { id, rev: 1, step: 0, decision: 'approve' }).ok === false, '另一位候選人晚一步 → 失敗');
  // 事件含 sha256 並對得上版本
  const ev = EVENTS(app, id);
  const sub = ev.find((e) => e.action === 'submit'), appr = ev.find((e) => e.action === 'approve');
  ok(appr && appr.actor === 'DZY903' && appr.sha256 === sub.sha256 && appr.note === '同意', 'approve 事件記誰、核准哪一版（sha256 與送出版本相同）');
  // 承辦：只限 fin 部門
  ['DZY901', 'DZY903', 'DZY907', 'DZY910', 'DZY914'].forEach((w) => {
    ok(post(app, w, 'apvHandle', { id, rev: 1, result: 'done' }).error === 'forbidden', `非財務部（${w}）不能承辦`);
  });
  ok(post(app, 'DZY909', 'apvHandle', { id, rev: 2, result: 'done' }).error === 'conflict', '承辦 rev 不符 → conflict');
  ok(post(app, 'DZY909', 'apvHandle', { id, rev: 1, result: 'x' }).error === 'bad_request', 'result 不合法');
  ok(post(app, 'DZY909', 'apvHandle', { id, rev: 1, result: 'return' }).error === 'bad_request', '承辦退回沒原因 → bad_request');
  const todo = post(app, 'DZY909', 'apvTodo', {});
  ok(todo.ok && todo.data.handle.length === 1 && todo.data.handle[0].id === id && todo.data.sign.length === 0 && todo.data.exception === undefined, '財務部 apvTodo：待我辦 1 張；沒有 exception 欄（非人資）', todo);
  ok(post(app, 'DZY909', 'apvHandle', { id, rev: 1, result: 'done', note: '10/20 已匯款' }).data.status === 'done', '財務按已處理 → done');
  ok(post(app, 'DZY909', 'apvHandle', { id, rev: 1, result: 'done' }).error === 'conflict', '結案後不能再處理');
  const done = getForm(app, 'DZY901', id).data;
  ok(done.form.status === 'done' && done.events.some((e) => e.action === 'handle' && e.note === '10/20 已匯款' && e.actor.name === '測試壬'), '送件人看得到結案與備註');
  ok(done.revisions.length === 1 && done.revisions[0].rev === 1, 'apvGet 回版本證據');
  // 兼任財務部的人也能承辦
  const app2 = freshApp();
  app2.sheets.staff._data[0][26] = 'extra_depts';
  app2.sheets.staff._data.forEach((r) => { if (r[app2.sb.STF_COL.emp_no] === 'DZY914') r[26] = 'fin'; });
  const s2 = sendExpense(app2, 'DZY901', 800);
  decide(app2, 'DZY902', s2.data.id, 'approve');
  ok(post(app2, 'DZY914', 'apvHandle', { id: s2.data.id, rev: 1, result: 'done' }).ok, '兼任部門（extra_depts＝fin）也能承辦');
}

// ============================================================
// 7. 退回、再送（rev+1、路線重算）、撤回、承辦退回要重新核准
// ============================================================
{
  const app = freshApp();
  const s = sendExpense(app, 'DZY901', 800);
  const id = s.data.id;
  // 撤回
  ok(post(app, 'DZY902', 'apvWithdraw', { id, rev: 1, step: 0 }).error === 'forbidden', '只有送件人可撤回');
  ok(post(app, 'DZY901', 'apvWithdraw', { id, rev: 9, step: 0 }).error === 'conflict', '撤回 rev 不符 → conflict');
  const wd = sendExpense(app, 'DZY901', 800);
  ok(post(app, 'DZY901', 'apvWithdraw', { id: wd.data.id, rev: 1, step: 0 }).data.status === 'withdrawn', '無人核准時送件人可撤回');
  ok(post(app, 'DZY902', 'apvDecide', { id: wd.data.id, rev: 1, step: 0, decision: 'approve' }).error === 'conflict', '撤回後不能再核准（狀態不符 → conflict）');
  ok(post(app, 'DZY901', 'apvWithdraw', { id: wd.data.id, rev: 1, step: 0 }).error === 'conflict', '撤回後不能再撤回');
  // 退回
  const rj = post(app, 'DZY902', 'apvDecide', { id, rev: 1, step: 0, decision: 'reject', note: '收據不清楚' });
  ok(rj.ok && rj.data.status === 'rejected', '店長退回（有原因）→ rejected', rj);
  const ev = EVENTS(app, id);
  ok(ev.some((e) => e.action === 'reject' && e.note === '收據不清楚' && /^[0-9a-f]{64}$/.test(e.sha256)), 'reject 事件有原因與 sha256');
  const g = getForm(app, 'DZY901', id).data;
  ok(g.form.can.resubmit === true && g.form.can.withdraw === false, '送件人 can.resubmit');
  // 再送
  const f2 = upload(app, 'DZY901');
  ok(post(app, 'DZY902', 'apvResubmit', { id, rev: 1, body: expenseBody({ amount: 9000 }), files: [f2] }).error === 'forbidden', '只有送件人可再送');
  ok(post(app, 'DZY901', 'apvResubmit', { id, rev: 7, body: expenseBody({ amount: 9000 }), files: [f2] }).error === 'conflict', '再送 rev 不符 → conflict');
  ok(post(app, 'DZY901', 'apvResubmit', { id, rev: 1, body: expenseBody({ amount: 9000 }), files: [] }).error === 'no_files', '再送也要有收據');
  ok(post(app, 'DZY901', 'apvResubmit', { id, rev: 1, body: expenseBody({ amount: -1 }), files: [f2] }).error === 'bad_amount', '再送金額反例');
  const rs = post(app, 'DZY901', 'apvResubmit', { id, rev: 1, body: expenseBody({ amount: 9000 }), files: [f2] });
  ok(rs.ok && rs.data.rev === 2 && rs.data.status === 'signing' && rs.data.route.steps[0].role === 'brand_dir' && rs.data.route.row.seq === 2, '再送：rev 2、金額 9,000 → 路線重算成品牌總監、從第一關重簽', rs);
  const fr = formOf(app, id);
  ok(fr.amount === 9000 && fr.rev === 2 && fr.step === 0, '再送後單的 amount／rev／step 更新');
  ok(FILEROWS(app).find((x) => x.id === f2).rev === 2 && FILEROWS(app).find((x) => x.id === s.file).rev === 1, '新照片綁 rev 2；舊照片仍屬 rev 1');
  const revs = rowsOf(app, 'apv_revisions', ['form_id', 'rev', 'at', 'body_json', 'amount', 'files_json', 'route_json', 'thr_ver', 'sha256']).filter((r) => r.form_id === id);
  ok(revs.length === 2 && revs[0].sha256 !== revs[1].sha256 && revs[1].amount === 9000, '每次送出一列版本證據，sha256 不同');
  ok(post(app, 'DZY902', 'apvDecide', { id, rev: 1, step: 0, decision: 'approve' }).ok === false, '舊 rev 的簽核畫面已失效（店長不是新路線的簽核人／rev 不符）');
  ok(post(app, 'DZY901', 'apvResubmit', { id, rev: 2, body: expenseBody(), files: [f2] }).error === 'conflict', '不是 rejected 不能再送');
  // 品牌總監核准 → 財務退回 → 再送要重新核准
  decide(app, 'DZY903', id, 'approve');
  const rt = post(app, 'DZY909', 'apvHandle', { id, rev: 2, result: 'return', note: '金額和收據不符' });
  ok(rt.ok && rt.data.status === 'rejected', '承辦退回 → rejected', rt);
  ok(EVENTS(app, id).some((e) => e.action === 'reject' && /承辦退回/.test(e.note)), '承辦退回寫事件');
  const f3 = upload(app, 'DZY901');
  const rs2 = post(app, 'DZY901', 'apvResubmit', { id, rev: 2, body: expenseBody({ amount: 9000 }), files: [f3, f2] });
  ok(rs2.ok && rs2.data.rev === 3 && rs2.data.status === 'signing' && rs2.data.route.steps[0].status === 'pending', '承辦退回後再送：重新走簽核（品牌總監要重新核准）', rs2);
  ok(FILEROWS(app).find((x) => x.id === f2).rev === 3, '同一張單舊檔可在再送時沿用（改綁新 rev）');
}

// ============================================================
// 8. 改派、作廢、exception
// ============================================================
{
  const app = freshApp();
  const s = sendExpense(app, 'DZY901', 800);
  const id = s.data.id;
  const rsn = '店長請假';
  const re = (who, p) => post(app, who, 'apvReassign', Object.assign({ id, rev: 1, step: 0, reason: rsn }, p));
  ok(re('DZY902', { to: 'DZY903' }).error === 'forbidden', '非人資不能改派（店長）');
  ok(re('DZY906', { to: 'DZY903' }).error === 'forbidden', '非人資不能改派（董事長）');
  ok(re('DZY910', { to: 'DZY914' }).error === 'bad_request', '改派給不相干的人（資訊部同仁）被擋');
  ok(re('DZY910', { to: 'DZY901' }).error === 'bad_request', '改派給送件人自己被擋');
  ok(re('DZY910', { to: 'DZY917' }).error === 'bad_request', '改派給未開通的人被擋');
  ok(re('DZY910', { to: 'DZY907' }).error === 'bad_request', '改派給低於該關 role 的人（採購同仁）被擋');
  ok(re('DZY910', { to: 'DZY903', reason: '' }).error === 'bad_request', '改派沒寫原因被擋');
  ok(re('DZY910', { to: 'DZY903', rev: 4 }).error === 'conflict', '改派 rev 不符 → conflict');
  const ok1 = re('DZY910', { to: 'DZY904' });
  ok(ok1.ok && ok1.data.status === 'signing', '人資改派給更高一級（總經理）', ok1);
  const g = getForm(app, 'DZY904', id);
  ok(g.ok && g.data.form.can.decide === true && g.data.form.route.steps[0].override.to === 'DZY904' && g.data.form.route.steps[0].candidates.length === 1, '有 override：只有被改派的人能簽');
  ok(post(app, 'DZY902', 'apvDecide', { id, rev: 1, step: 0, decision: 'approve' }).error === 'forbidden', '原候選人（店長）失權');
  ok(EVENTS(app, id).some((e) => e.action === 'reassign' && /DZY904/.test(e.note)), '寫 reassign 事件');
  ok(decide(app, 'DZY904', id, 'approve').data.status === 'handling', '被改派的人核准 → handling');
  ok(re('DZY910', { to: 'DZY905' }).error === 'conflict', 'handling 時不能改派');
  // 董事長自己送 → exception
  const ex = sendExpense(app, 'DZY906', 800);
  ok(ex.ok && ex.data.status === 'exception', '董事長自己送支出單 → exception', ex);
  const exId = ex.data.id;
  const hrTodo = post(app, 'DZY910', 'apvTodo', {});
  ok(hrTodo.data.exception.length === 1 && hrTodo.data.exception[0].id === exId, '人資 apvTodo.exception 看得到');
  ok(post(app, 'admin', 'apvTodo', {}).data.exception.length === 1, 'admin apvTodo.exception 看得到');
  ok(post(app, 'DZY906', 'apvDecide', { id: exId, rev: 1, step: 4, decision: 'approve' }).error !== undefined && formOf(app, exId).status === 'exception', 'exception 時沒人能按核准（董事長自己也不行）');
  const stepIdx = getForm(app, 'DZY910', exId).data.form.step;
  ok(post(app, 'DZY910', 'apvReassign', { id: exId, rev: 1, step: stepIdx, to: 'DZY910', reason: '人資自己簽' }).error === 'bad_request', '人資不能把單改派給自己（除非本人是合格權限人）');
  ok(post(app, 'DZY910', 'apvReassign', { id: exId, rev: 1, step: stepIdx, to: 'DZY906', reason: '改派' }).error === 'bad_request', '改派給送件人（董事長）被擋');
  const rx = post(app, 'DZY910', 'apvReassign', { id: exId, rev: 1, step: stepIdx, to: 'DZY904', reason: '董事長本人送單，請總經理簽' });
  ok(rx.ok && rx.data.status === 'signing' && decide(app, 'DZY904', exId, 'approve').data.status === 'handling', 'exception 改派給總經理 → signing → 核准 → handling', rx);
  // 作廢
  const v1 = sendExpense(app, 'DZY901', 800);
  ok(post(app, 'DZY902', 'apvVoid', { id: v1.data.id, reason: '重複' }).error === 'forbidden', '非人資／admin 不能作廢');
  ok(post(app, 'DZY910', 'apvVoid', { id: v1.data.id, reason: '' }).error === 'bad_request', '作廢沒原因被擋');
  ok(post(app, 'DZY910', 'apvVoid', { id: v1.data.id, reason: '重複送單' }).data.status === 'voided', '人資作廢');
  ok(post(app, 'DZY910', 'apvVoid', { id: v1.data.id, reason: '再一次' }).error === 'conflict', '已作廢不能再作廢');
  ok(post(app, 'DZY902', 'apvDecide', { id: v1.data.id, rev: 1, step: 0, decision: 'approve' }).error === 'conflict', '作廢後不能核准');
  const v2 = sendExpense(app, 'DZY901', 800);
  ok(post(app, 'admin', 'apvVoid', { id: v2.data.id, reason: 'admin 作廢' }).data.status === 'voided', 'admin 可作廢');
  ok(post(app, 'DZY910', 'apvVoid', { id, reason: '核准後發現重複' }).data.status === 'voided', 'handling 的單也可作廢');
  // done 不能作廢
  const dn = sendExpense(app, 'DZY901', 800);
  decide(app, 'DZY902', dn.data.id, 'approve');
  post(app, 'DZY909', 'apvHandle', { id: dn.data.id, rev: 1, result: 'done' });
  ok(post(app, 'DZY910', 'apvVoid', { id: dn.data.id, reason: '想作廢' }).error === 'conflict', 'done 不能作廢');
}

// ============================================================
// 9. 並行：同時核准、step 前進後舊畫面
// ============================================================
{
  const app = freshApp();
  // 兩位店長（候選人有多人）
  app.sheets.staff._data.push((() => { const row = new Array(app.sb.STF_COL_COUNT).fill(''); const S = app.sb.STF_COL; row[S.emp_no] = 'DZY920'; row[S.user_id] = 'u920'; row[S.name] = '測試戌'; row[S.status] = 'active'; row[S.unit] = 'mala-gf'; row[S.title] = 'sm'; return row; })());
  app.sheets.users._data.push(['u920', 'DZY920', '測試戌', 'staff', '', 's', 'h', 'TRUE', '', '']);
  app.tok.DZY920 = app.sb.issueToken_({ id: 'u920', role: 'staff', node: '' });
  const s = sendExpense(app, 'DZY901', 800);
  const id = s.data.id;
  const g = getForm(app, 'admin', id).data.form;
  ok(g.route.steps[0].candidates.length === 2, '同一個權限人有兩人 → 兩人都是候選');
  const a = post(app, 'DZY902', 'apvDecide', { id, rev: g.rev, step: g.step, decision: 'approve' });
  const b = post(app, 'DZY920', 'apvDecide', { id, rev: g.rev, step: g.step, decision: 'approve' });
  ok(a.ok && b.ok === false && b.error === 'conflict', '兩人用同一個畫面（rev/step 相同）先後核准：第二個回 conflict', { a, b });
  ok(EVENTS(app, id).filter((e) => e.action === 'approve').length === 1, '只寫一筆 approve');
  // 兩位簽核者同時退回／核准
  const s2 = sendExpense(app, 'DZY901', 8600);
  const g2 = getForm(app, 'admin', s2.data.id).data.form;
  ok(post(app, 'DZY903', 'apvDecide', { id: s2.data.id, rev: g2.rev, step: g2.step, decision: 'reject', note: 'x' }).ok, '退回成功');
  ok(post(app, 'DZY903', 'apvDecide', { id: s2.data.id, rev: g2.rev, step: g2.step, decision: 'approve' }).error === 'conflict', '退回後同畫面再核准 → conflict');
}

// ============================================================
// 10. 人事異動（§14.4 矩陣）：送件資格、離職簽名、紙本、薪資可見度
// ============================================================
{
  const app = freshApp();
  const pb = (kind, o) => Object.assign({ kind, effective: '2026-11-01', from: { unit: 'mala-gf', title: 'ft', pay: 30000 }, to: kind === 'transfer' ? { unit: 'mala-hq', title: 'ofs' } : kind === 'raise' ? { pay: 33000 } : {}, reason: '測試原因' }, o || {});
  const send = (who, kind, subject, body, files) => post(app, who, 'apvSubmit', { client_id: newCid(), type: 'personnel', subject, body: body || pb(kind), files: files || [] });
  // 一般同仁：只能送自己的離職
  ok(send('DZY915', 'transfer', 'DZY901').error === 'forbidden', '一般同仁不能送別人的調職');
  ok(send('DZY915', 'leave', 'DZY901').error === 'forbidden', '一般同仁不能送別人的離職');
  { const r = send('DZY915', 'leave', undefined, pb('leave', { sign_file: upload(app, 'DZY915', 'sign') })); ok(r.ok && FORMS(app).some((f) => f.id === r.data.id && f.subject === 'DZY915'), '本人送離職不帶 subject → subject＝本人', r); }
  ok(send('DZY901', 'raise', 'DZY901', pb('raise')).error === 'forbidden', '一般同仁不能送自己的調薪');
  ok(send('DZY913', 'transfer', 'DZY901').error === 'forbidden', '跨店店長（墨竹亭）替小辛辣同仁送調職 → 擋');
  ok(send('DZY902', 'transfer', 'DZY999').error === 'bad_request', '對象不存在 → bad_request');
  ok(send('DZY902', 'transfer', 'DZY901', pb('transfer', { to: { unit: 'no-such-unit', title: 'ft' } })).error === 'bad_request', '調職 to.unit 必須是啟用中的單位');
  ok(send('DZY902', 'transfer', 'DZY901', pb('transfer', { to: { unit: 'mzt-mc', title: 'ft' } })).error === 'bad_request', '調職 to.unit 停用中的單位被擋');
  ok(send('DZY902', 'raise', 'DZY901', pb('raise', { to: { pay: 'abc' } })).error === 'bad_request', '調薪 pay 必須是數字');
  ok(send('DZY902', 'raise', 'DZY901', pb('raise', { to: {} })).error === 'bad_request', '調薪沒有 to.pay');
  ok(send('DZY902', 'raise', 'DZY901', pb('raise', { effective: '2026-13-01' })).error === 'bad_request', 'effective 日期不合法');
  ok(send('DZY902', 'raise', 'DZY901', pb('raise', { reason: '' })).error === 'bad_request', '原因必填');
  // 離職：本人送（要簽名檔）
  ok(send('DZY901', 'leave', 'DZY901', pb('leave', { from: { unit: 'mala-gf', title: 'ft' } })).error === 'file_invalid', '離職本人送沒附簽名 → file_invalid');
  const sg = upload(app, 'DZY901', 'sign');
  const l1 = send('DZY901', 'leave', 'DZY901', pb('leave', { sign_file: sg }));
  ok(l1.ok && l1.data.status === 'signing' && l1.data.route.steps[0].role === 'self_sign' && l1.data.route.steps[0].status === 'done' && l1.data.route.steps[1].role === 'direct', '離職本人送：簽名關當場完成 → 直屬主管（店長）', l1);
  ok(FILEROWS(app).find((x) => x.id === sg).state === 'bound' && EVENTS(app, l1.data.id).some((e) => e.action === 'sign' && e.actor === 'DZY901'), '簽名檔綁定、寫 sign 事件');
  ok(formOf(app, l1.data.id).amount === '' || formOf(app, l1.data.id).amount === null, '人事單沒有金額');
  ok(JSON.parse(formOf(app, l1.data.id).body_json).sign_file === sg, 'body 記簽名檔號');
  const lid = l1.data.id;
  ok(decide(app, 'DZY902', lid, 'approve').data.status === 'handling', '店長核准 → 人資承辦');
  ok(l1.data.route.handler === 'hr', '離職承辦 hr');
  ok(post(app, 'DZY911', 'apvHandle', { id: lid, rev: 1, result: 'done', note: '已辦離職' }).data.status === 'done', '人資承辦結案');
  ok(post(app, 'DZY909', 'apvHandle', { id: lid, rev: 1, result: 'done' }).ok === false, '財務不能承辦人事單');
  // 離職：主管送、對象已開通 → 本人簽名關
  const l2 = send('DZY902', 'leave', 'DZY915', pb('leave'));
  ok(l2.ok && l2.data.route.steps[0].role === 'self_sign' && l2.data.route.steps[0].status === 'pending', '主管送離職（對象已開通）：第一關本人簽名', l2);
  const l2id = l2.data.id;
  ok(getForm(app, 'DZY915', l2id).data.form.can.sign === true, '對象本人看得到單、can.sign');
  ok(post(app, 'DZY902', 'apvDecide', { id: l2id, rev: 1, step: 0, decision: 'approve' }).error === 'forbidden', '本人簽名關不能被別人代按核准');
  ok(post(app, 'DZY915', 'apvDecide', { id: l2id, rev: 1, step: 0, decision: 'approve' }).error === 'forbidden', '本人簽名關也不能用核准按鈕（要簽名）');
  const sg2 = upload(app, 'DZY915', 'sign');
  const sgOther = upload(app, 'DZY902', 'sign');
  ok(post(app, 'DZY902', 'apvSign', { id: l2id, rev: 1, step: 0, sign_file: sgOther }).error === 'forbidden', '送件人不能替本人簽名');
  ok(post(app, 'DZY915', 'apvSign', { id: l2id, rev: 1, step: 0, sign_file: sgOther }).error === 'file_invalid', '簽名檔 owner 不是本人 → file_invalid');
  ok(post(app, 'DZY915', 'apvSign', { id: l2id, rev: 1, step: 0, sign_file: upload(app, 'DZY915') }).error === 'file_invalid', '簽名檔 kind 不符（收據照）→ file_invalid');
  ok(post(app, 'DZY915', 'apvSign', { id: l2id, rev: 1, step: 1, sign_file: sg2 }).error === 'conflict', 'apvSign step 不符 → conflict');
  const sgr = post(app, 'DZY915', 'apvSign', { id: l2id, rev: 1, step: 0, sign_file: sg2 });
  ok(sgr.ok && sgr.data.status === 'signing' && sgr.data.step === 1, '本人簽名 → 下一關（直屬主管）', sgr);
  ok(FILEROWS(app).find((x) => x.id === sg2).state === 'bound' && FILEROWS(app).find((x) => x.id === sg2).form_id === l2id, '簽名檔綁到單');
  ok(post(app, 'DZY915', 'apvSign', { id: l2id, rev: 1, step: 1, sign_file: upload(app, 'DZY915', 'sign') }).error === 'conflict', '已簽過、現在不是簽名關 → conflict');
  // 主管送、對象已開通：撤回——簽名不算核准，但已有人核准後不行
  const l3 = send('DZY902', 'leave', 'DZY901', pb('leave'));
  ok(post(app, 'DZY902', 'apvWithdraw', { id: l3.data.id, rev: 1, step: 0 }).data.status === 'withdrawn', '離職單還沒人簽可撤回');
  // 離職：對象沒開通 → 紙本簽名照
  ok(send('DZY902', 'leave', 'DZY917', pb('leave')).error === 'file_invalid', '對象沒開通：沒附紙本簽名照 → file_invalid');
  const pp = upload(app, 'DZY902');
  const l4 = send('DZY902', 'leave', 'DZY917', pb('leave', { paper_files: [pp] }));
  ok(l4.ok && l4.data.route.steps.length === 1 && l4.data.route.steps[0].role === 'direct' && FILEROWS(app).find((x) => x.id === pp).state === 'bound', '對象沒開通：附紙本照 → 免本人簽名關', l4);
  ok(send('DZY902', 'leave', 'DZY917', pb('leave', { paper_files: [upload(app, 'DZY902'), upload(app, 'DZY902'), upload(app, 'DZY902')] })).error === 'file_invalid', '紙本簽名照最多 2 張');
  // transfer / raise
  const t1 = send('DZY902', 'transfer', 'DZY901');
  ok(t1.ok && t1.data.route.steps.length === 1 && t1.data.route.steps[0].role === 'direct', '店長送調職：一關直屬主管');
  const tCands = getForm(app, 'admin', t1.data.id).data.form.route.steps[0].candidates.map((c) => c.emp).sort();
  ok(eq(tCands, ['DZY903', 'DZY916']), '店長的直屬主管＝小辛辣辦公室區經理以上（測試丙、測試巳）', tCands);
  ok(decide(app, 'DZY916', t1.data.id, 'approve').data.status === 'handling', '區經理核准調職 → handling');
  const r1 = send('DZY902', 'raise', 'DZY901');
  ok(r1.ok && r1.data.route.steps[0].role === 'gm', '調薪：總經理一關');
  ok(post(app, 'DZY903', 'apvDecide', { id: r1.data.id, rev: 1, step: 0, decision: 'approve' }).error === 'forbidden', '調薪：品牌總監不能簽（只有總經理）');
  ok(decide(app, 'DZY904', r1.data.id, 'approve').data.status === 'handling', '總經理核准調薪');
  const r2 = send('DZY904', 'raise', 'DZY901');
  ok(r2.ok && r2.data.status === 'signing' && getForm(app, 'admin', r2.data.id).data.form.route.steps.map((s) => s.role + ':' + s.status).join() === 'gm:skipped,chair:pending', '總經理送調薪：總經理關 skipped → 董事長');
  const r3 = send('DZY911', 'raise', 'DZY901');
  ok(r3.ok && r3.data.route.steps[0].role === 'gm', '人資可替任何人送調薪');
  const r4 = send('DZY911', 'raise', 'DZY906');
  ok(r4.ok && r4.data.status === 'exception', '調薪對象是董事長 → exception');
  // 可見度：薪資只有路線上的人、人資、送件人
  const salaryId = r1.data.id;
  ok(getForm(app, 'DZY901', salaryId).ok === false && getForm(app, 'DZY901', salaryId).error === 'forbidden', '調薪單：對象本人看不到（不是送件人、不在路線上）');
  ok(getForm(app, 'DZY914', salaryId).error === 'forbidden', '調薪單：無關同仁 403');
  ok(getForm(app, 'DZY902', salaryId).data.form.body.to.pay === 33000, '調薪單：送件人看得到薪資');
  ok(getForm(app, 'DZY904', salaryId).data.form.body.to.pay === 33000, '調薪單：簽過的總經理看得到薪資');
  ok(getForm(app, 'DZY911', salaryId).data.form.body.to.pay === 33000, '調薪單：人資看得到薪資');
  ok(post(app, 'DZY915', 'apvList', {}).error === 'forbidden', '一般同仁 apvList 403');
  const lst = post(app, 'DZY914', 'apvList', {});
  ok(lst.error === 'forbidden', '資訊部同仁（非承辦部門）apvList 403');
  ok(JSON.stringify(post(app, 'DZY911', 'apvList', {}).data.forms).indexOf('"pay"') === -1, 'apvList 不回 body（不外流薪資）');
  // 事件 note 不含個資
  const allNotes = EVENTS(app).map((e) => e.note).join('|');
  ok(!/33000|30000/.test(allNotes), '事件 note 不含薪資數字');
}

// ============================================================
// 11. 可見度（§14.7）：apvGet／apvList／apvMine／apvTodo／apvExport／apvFileMeta
// ============================================================
{
  const app = freshApp();
  const s = sendExpense(app, 'DZY901', 8600);
  const id = s.data.id;
  const vis = (who) => getForm(app, who, id);
  ok(vis('DZY901').ok, 'sender 看得到');
  ok(vis('DZY903').ok, '目前關卡的候選人看得到');
  ['DZY914', 'DZY915', 'DZY913', 'DZY907', 'DZY909', 'DZY917'].forEach((w) => ok(vis(w).error === 'forbidden', `無關的人（${w}）apvGet 403`));
  ok(vis('DZY909').error === 'forbidden', '承辦部門在「還在簽核」時看不到（要簽完進承辦才看得到）');
  ok(vis('DZY902').error === 'forbidden', '路線以外的店長（沒簽過、不是候選）看不到');
  ok(vis('DZY910').ok && vis('admin').ok, 'platform.staff／admin 看得到全部');
  ok(post(app, 'DZY902', 'apvFileMeta', { id: s.file }).error === 'forbidden', 'apvFileMeta：看不到單的人也看不到檔');
  ok(post(app, 'DZY903', 'apvFileMeta', { id: s.file }).data.form_id === id, 'apvFileMeta：看得到單的人看得到檔');
  decide(app, 'DZY903', id, 'approve');
  ok(vis('DZY909').ok && vis('DZY903').ok, '進承辦後：承辦部門看得到；簽過的人仍看得到');
  ok(vis('DZY907').error === 'forbidden', '別的承辦部門（採購）看不到財務的單');
  ok(vis('DZY902').error === 'forbidden', '沒簽過的店長仍看不到');
  ok(post(app, 'DZY901', 'apvMine', {}).data.forms.length === 1 && post(app, 'DZY902', 'apvMine', {}).data.forms.length === 0, 'apvMine 只有自己送的');
  ok(post(app, 'DZY901', 'apvMine', { status: 'done' }).data.forms.length === 0 && post(app, 'DZY901', 'apvMine', { status: 'handling' }).data.forms.length === 1, 'apvMine 可篩狀態');
  const mine = post(app, 'DZY901', 'apvMine', {}).data.forms[0];
  ok(!('body' in mine) && mine.id === id && mine.sender.name === '測試甲' && mine.amount === 8600 && mine.can.void === false, 'apvMine 不含 body、形狀符合 api.md');
  // apvList：承辦部門看自己的；其他 403
  ok(post(app, 'DZY909', 'apvList', {}).data.forms.length === 1, '財務部 apvList 看得到自己部門的單');
  ok(post(app, 'DZY907', 'apvList', {}).data.forms.length === 0, '採購部 apvList 看不到財務的單（空）');
  ok(post(app, 'DZY910', 'apvList', {}).data.forms.length === 1 && post(app, 'admin', 'apvList', {}).data.forms.length === 1, 'platform.staff／admin apvList 看全部');
  ok(post(app, 'DZY910', 'apvList', { type: 'purchase' }).data.forms.length === 0 && post(app, 'DZY910', 'apvList', { status: 'handling' }).data.forms.length === 1, 'apvList 篩種類、狀態');
  ok(post(app, 'DZY910', 'apvList', { month: '2020-01' }).data.forms.length === 0 && post(app, 'DZY910', 'apvList', { month: 'abc' }).error === 'bad_request', 'apvList 篩月份；格式錯 → bad_request');
  // 簽核中的單：承辦部門的 list 不列
  const s2 = sendExpense(app, 'DZY901', 8600);
  ok(post(app, 'DZY909', 'apvList', {}).data.forms.every((f) => f.id !== s2.data.id), '簽核中的單不會出現在承辦部門的列表');
  // apvTodo
  const td = post(app, 'DZY903', 'apvTodo', {});
  ok(td.data.sign.length === 1 && td.data.sign[0].id === s2.data.id && td.data.handle.length === 0, 'apvTodo：品牌總監待我簽 1 張');
  ok(post(app, 'DZY914', 'apvTodo', {}).data.sign.length === 0, 'apvTodo：無關的人是空');
  ok(post(app, 'DZY901', 'apvTodo', {}).data.sign.length === 0, 'apvTodo：送件人看不到自己的單在待簽');
  // 匯出
  ok(post(app, 'DZY901', 'apvExport', { month: '2026-10' }).error === 'forbidden' && post(app, 'DZY907', 'apvExport', { month: '2026-10' }).error === 'forbidden', 'apvExport：非財務／人資 403');
  ok(post(app, 'DZY909', 'apvExport', { month: 'x' }).error === 'bad_request', 'apvExport month 格式');
  // 結案後匯出
  post(app, 'DZY909', 'apvHandle', { id, rev: 1, result: 'done', note: '已匯款' });
  const s3 = sendExpense(app, 'DZY901', 800, null);
  decide(app, 'DZY902', s3.data.id, 'approve');
  post(app, 'DZY909', 'apvHandle', { id: s3.data.id, rev: 1, result: 'done' });
  const nowMonth = (() => { const d = new Date(Date.now() + 8 * HOUR); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); })();
  const ex = post(app, 'DZY909', 'apvExport', { month: nowMonth });
  ok(ex.ok && ex.data.rows.length === 2 && ex.data.rows.reduce((a, r) => a + r.amount, 0) === 9400, '匯出當月已處理的請款，加總＝8600＋800', ex);
  const row = ex.data.rows.find((r) => r.id === id);
  ok(row.rev === 1 && row.category === '設備維修' && row.sender_name === '測試甲' && row.handle_note === '已匯款' && row.created_at > 0 && row.approved_at > 0 && row.done_at >= row.approved_at && row.type === 'expense' && row.desc === '測試維修', '匯出列帶送件日、核准日、處理日、rev、類別中文');
  ok(post(app, 'DZY910', 'apvExport', { month: nowMonth }).data.rows.length === 2 && post(app, 'admin', 'apvExport', { month: nowMonth }).ok, 'platform.staff／admin 也能匯出');
  ok(post(app, 'DZY909', 'apvExport', { month: '2020-01' }).data.rows.length === 0, '其他月份是空');
  // 未處理（handling）的單不在匯出
  decide(app, 'DZY903', s2.data.id, 'approve');
  ok(post(app, 'DZY909', 'apvExport', { month: nowMonth }).data.rows.length === 2, '還沒按已處理的單不進匯出');
  // 請購單進匯出（承辦 purchase；財務部匯出包含請購）
  const p = post(app, 'DZY901', 'apvSubmit', { client_id: newCid(), type: 'purchase', body: purchaseBody(), files: [] });
  decide(app, 'DZY902', p.data.id, 'approve');
  post(app, 'DZY908', 'apvHandle', { id: p.data.id, rev: 1, result: 'done' });
  const ex2 = post(app, 'DZY909', 'apvExport', { month: nowMonth });
  ok(ex2.data.rows.length === 3 && ex2.data.rows.find((r) => r.id === p.data.id).desc === '測試用途', '匯出也含請購單');
}

// ============================================================
// 12. 懶式重解與 reconcile（§14.5）
// ============================================================
{
  const app = freshApp();
  const s = sendExpense(app, 'DZY901', 800);
  const id = s.data.id;
  // 店長被停用（staff status disabled）
  app.sheets.staff._data.forEach((r) => { if (r[app.sb.STF_COL.emp_no] === 'DZY902') r[app.sb.STF_COL.status] = 'disabled'; });
  const g = getForm(app, 'admin', id).data.form;
  ok(g.route.steps[0].status === 'skipped' && g.route.steps[1].role === 'brand_dir' && g.step === 1 && g.status === 'signing', 'apvGet 懶式重解：店長停用 → 顯示已往上到品牌總監（只算不寫）', g.route.steps);
  ok(formOf(app, id).step === 0 && EVENTS(app, id).filter((e) => e.action === 'skip').length === 0, '讀取不寫入：試算表仍是原狀');
  ok(post(app, 'DZY903', 'apvTodo', {}).data.sign.length === 1, 'apvTodo：品牌總監已看到這張待簽');
  const rec = app.sb.apvReconcile_();
  ok(rec.skipped === 1 && formOf(app, id).step === 1 && EVENTS(app, id).some((e) => e.action === 'skip' && e.actor === 'system'), 'apvReconcile_：寫入 skip 事件並前進', rec);
  ok(app.sb.apvReconcile_().skipped === 0, 'reconcile 重跑不再重複 skip');
  ok(decide(app, 'DZY903', id, 'approve').data.status === 'handling', '品牌總監核准順利');
  // decide 前的懶式重解（不經 reconcile）
  const s2 = sendExpense(app, 'DZY901', 8600);
  app.sheets.staff._data.forEach((r) => { if (r[app.sb.STF_COL.emp_no] === 'DZY903') r[app.sb.STF_COL.status] = 'disabled'; });
  const stale = post(app, 'DZY905', 'apvDecide', { id: s2.data.id, rev: 1, step: 0, decision: 'approve' });
  ok(stale.error === 'conflict' && formOf(app, s2.data.id).step === 1, 'apvDecide 先重解並寫回（舊畫面的 step 失效 → conflict）', stale);
  ok(post(app, 'DZY905', 'apvDecide', { id: s2.data.id, rev: 1, step: 1, decision: 'approve' }).data.status === 'handling', '用新 step 核准（執行長）成功');
  // 全部消失 → exception
  const s3 = sendExpense(app, 'DZY901', 800);
  app.sheets.staff._data.forEach((r) => { if (['DZY904', 'DZY905', 'DZY906'].includes(r[app.sb.STF_COL.emp_no])) r[app.sb.STF_COL.status] = 'disabled'; });
  app.sheets.staff._data.forEach((r) => { if (r[app.sb.STF_COL.emp_no] === 'DZY902') r[app.sb.STF_COL.status] = 'disabled'; });
  const rec2 = app.sb.apvReconcile_();
  ok(formOf(app, s3.data.id).status === 'exception' && rec2.skipped >= 3, '權限人全部停用 → reconcile 把單轉 exception', { rec2, st: formOf(app, s3.data.id).status });
}

// ============================================================
// 13. 檔案：authorize／register／canRead／sweep／backup（jobs 專用）
// ============================================================
{
  const app = freshApp();
  const sb = app.sb;
  ok(eq(sb.apvFileAuthorize_(app.tok.DZY901), { ok: true, emp: 'DZY901' }), 'apvFileAuthorize_：token → emp');
  ok(sb.apvFileAuthorize_('bad.token').ok === false && sb.apvFileAuthorize_(app.tok.admin).ok === false && sb.apvFileAuthorize_(app.tok.DZY917).ok === false, 'apvFileAuthorize_：壞 token／admin（無同仁列）／未開通 → 拒絕');
  const r = sb.apvFileRegister_('DZY901', { kind: 'receipt', bytes: 5000, sha256: SHA });
  ok(r.ok && /^F[0-9A-Z]{12,}$/.test(r.id) && new RegExp('^\\d{4}/\\d{2}/' + r.id + '\\.jpg$').test(r.path), 'apvFileRegister_：檔號 F＋時間戳36進位＋4碼；路徑（相對 apv-files）YYYY/MM/<檔號>.jpg', r);
  const rs = sb.apvFileRegister_('DZY901', { kind: 'sign', bytes: 5000, sha256: SHA });
  ok(rs.path.endsWith('.png'), '簽名檔副檔名 .png');
  const row = FILEROWS(app).find((x) => x.id === r.id);
  ok(row.state === 'uploaded' && row.owner === 'DZY901' && row.seq === 1 && row.form_id === '' && row.kind === 'receipt', '登記後 uploaded、未綁單、seq 遞增');
  ok(sb.apvFileRegister_('DZY901', { kind: 'receipt', bytes: 180 * 1024 + 1, sha256: SHA }).error === 'file_too_large', '收據超過 180 KB → file_too_large');
  ok(sb.apvFileRegister_('DZY901', { kind: 'receipt', bytes: 180 * 1024, sha256: SHA }).ok, '剛好 180 KB 可以');
  ok(sb.apvFileRegister_('DZY901', { kind: 'sign', bytes: 100 * 1024 + 1, sha256: SHA }).error === 'file_too_large', '簽名檔超過 100 KB → file_too_large');
  ok(sb.apvFileRegister_('DZY901', { kind: 'pdf', bytes: 10, sha256: SHA }).error === 'file_invalid' && sb.apvFileRegister_('DZY901', { kind: 'receipt', bytes: 10, sha256: 'xyz' }).error === 'file_invalid' && sb.apvFileRegister_('bad', { kind: 'receipt', bytes: 10, sha256: SHA }).ok === false, '種類／sha256／emp 格式檢查');
  // 配額：每人每天 60
  const q = freshApp();
  let last;
  for (let i = 0; i < 60; i++) last = q.sb.apvFileRegister_('DZY901', { kind: 'receipt', bytes: 10, sha256: SHA });
  ok(last.ok && q.sb.apvFileRegister_('DZY901', { kind: 'receipt', bytes: 10, sha256: SHA }).error === 'quota', '每人每天 60 張，第 61 張 → quota');
  ok(q.sb.apvFileRegister_('DZY902', { kind: 'receipt', bytes: 10, sha256: SHA }).ok, '別人不受影響');
  const ids = new Set(FILEROWS(q).map((x) => x.id));
  ok(ids.size === 61, '61 個檔號（含別人那張）全部不重複', ids.size);
  // canRead
  const s = sendExpense(app, 'DZY901', 8600);
  const can = (tok, id) => sb.apvFileCanRead_(app.tok[tok] || tok, id);
  ok(eq(can('DZY901', s.file), { ok: true, path: FILEROWS(app).find((x) => x.id === s.file).path, mime: 'image/jpeg' }), 'canRead：送件人可讀自己的收據');
  ok(can('DZY903', s.file).ok && can('DZY910', s.file).ok && can('admin', s.file).ok, 'canRead：候選人、人資、admin 可讀');
  ['DZY902', 'DZY914', 'DZY909', 'DZY917'].forEach((w) => ok(can(w, s.file).ok === false, `canRead：看不到單的人（${w}）不能讀`));
  ok(can('bad.token', s.file).ok === false && can('DZY901', 'FNOTEXIST9999').error === 'not_found', 'canRead：壞 token／不存在的檔');
  ok(can('DZY901', r.id).ok && can('DZY902', r.id).ok === false && can('DZY910', r.id).ok, 'canRead：未綁單的檔只有擁有者（與人資）能讀');
  ok(can('DZY901', rs.id).mime === 'image/png', 'canRead：簽名檔 mime＝image/png');
  // sweep：只刪 uploaded 且 > 24 小時
  const old1 = sb.apvFileRegister_('DZY902', { kind: 'receipt', bytes: 10, sha256: SHA }).id;
  const old2 = sb.apvFileRegister_('DZY902', { kind: 'receipt', bytes: 10, sha256: SHA }).id;
  const fresh1 = sb.apvFileRegister_('DZY902', { kind: 'receipt', bytes: 10, sha256: SHA }).id;
  const FH = FILE_H;
  setCell(app, 'apv_files', FH, old1, 'created_at', Date.now() - 25 * HOUR);
  setCell(app, 'apv_files', FH, old2, 'created_at', Date.now() - 48 * HOUR);
  setCell(app, 'apv_files', FH, s.file, 'created_at', Date.now() - 100 * HOUR);   // 已綁定的舊檔不能被掃
  const list = sb.apvFileSweepList_();
  ok(list.map((x) => x.id).sort().join() === [old1, old2].sort().join(), 'sweep：只列 uploaded 且超過 24 小時；已綁定的、新的都不列', list);
  ok(list.every((x) => /^\d{4}\/\d{2}\/F/.test(x.path)), 'sweep 回相對路徑');
  const ext = sb.apvFileRegister_('DZY901', { kind: 'receipt', mime: 'image/jpeg', ext: 'jpg', bytes: 10, sha256: SHA });
  ok(ext.ok && ext.path.endsWith('.jpg') && sb.apvFileRegister_('DZY901', { kind: 'sign', ext: 'jpg', bytes: 10, sha256: SHA }).error === 'file_invalid', 'meta.ext 生效；副檔名與種類不符被擋');
  ok(FILEROWS(app).find((x) => x.id === old1).state === 'deleting' && FILEROWS(app).find((x) => x.id === s.file).state === 'bound' && FILEROWS(app).find((x) => x.id === fresh1).state === 'uploaded', 'sweep：先改 deleting；綁定與新檔不動');
  ok(sb.apvFileSweepList_().length === 0, '重跑 sweep 不重複列 deleting 的');
  ok(can('DZY902', old1).error === 'not_found', 'deleting 的檔不能讀');
  const bindOld = post(app, 'DZY902', 'apvSubmit', { client_id: newCid(), type: 'expense', body: expenseBody(), files: [old1] });
  ok(bindOld.error === 'file_invalid', 'deleting 的檔不能再被綁定');
  ok(sb.apvFileSweepDone_([old1, fresh1, s.file]).done === 1 && FILEROWS(app).find((x) => x.id === old1).state === 'deleted' && FILEROWS(app).find((x) => x.id === fresh1).state === 'uploaded', 'sweepDone：只把 deleting 的改 deleted');
  // 備份水位
  const bl = sb.apvBackupList_(0);
  ok(bl.every((x, i, a) => i === 0 || a[i - 1].seq < x.seq) && bl.every((x) => x.sha256 && x.path) && !bl.some((x) => x.id === old1 || x.id === old2), 'apvBackupList_：依 seq 遞增、不含 deleting／deleted', bl.length);
  const maxSeq = Math.max.apply(null, FILEROWS(app).map((x) => x.seq));
  ok(sb.apvBackupList_(maxSeq).length === 0 && sb.apvBackupList_(maxSeq - 1).length >= 0, '水位之後沒有新檔就是空');
  const ent = bl.find((x) => x.id === s.file);
  ok(ent && ent.form_id === s.data.id && ent.rev === 1, '備份清單帶 form_id、rev');
  // 鎖
  app.locks.busy = true;
  ok(sb.apvFileRegister_('DZY901', { kind: 'receipt', bytes: 10, sha256: SHA }).error === 'busy' && sb.apvFileSweepList_().length === 0, '寫入類 jobs 函式在鎖逾時時回 busy／空（不寫）');
  app.locks.busy = false;
}

// ============================================================
// 14. 每日彙整 apvDigest_
// ============================================================
{
  const app = freshApp();
  ok(eq(app.sb.apvDigest_(), { count: 0, title: '', text: '' }), '沒有任何單 → 不送（count 0）');
  const s = sendExpense(app, 'DZY901', 800);
  ok(app.sb.apvDigest_().count === 0, '剛送出的單不算卡關');
  ageStep(app, s.data.id, 71 * HOUR);
  ok(app.sb.apvDigest_().count === 0, '71 小時還不算');
  ageStep(app, s.data.id, 73 * HOUR);
  const d = app.sb.apvDigest_();
  ok(d.count === 1 && d.title === '表單簽核：1 張卡關' && d.text.split('\n').length === 1, '超過 72 小時：1 張', d);
  ok(new RegExp('^' + s.data.id + '｜請款｜單位主管（測試乙）｜3天$').test(d.text), '一行：單號｜種類｜卡在誰｜幾天', d.text);
  // handling 超過 72 小時
  const h = sendExpense(app, 'DZY901', 800);
  decide(app, 'DZY902', h.data.id, 'approve');
  ageStep(app, h.data.id, 100 * HOUR);
  const d2 = app.sb.apvDigest_();
  ok(d2.count === 2 && /承辦：財務部/.test(d2.text) && /4天/.test(d2.text), 'handling 超過 72 小時也算；卡在承辦部門', d2.text);
  // exception 當天即列
  const e = sendExpense(app, 'DZY906', 800);
  const d3 = app.sb.apvDigest_();
  ok(d3.count === 3 && d3.text.includes(e.data.id + '｜請款｜無合格簽核人｜0天'), 'exception 不等 72 小時，當天就列', d3.text);
  // 已結案／撤回不列
  post(app, 'DZY909', 'apvHandle', { id: h.data.id, rev: 1, result: 'done' });
  ok(app.sb.apvDigest_().count === 2, '結案後不列');
  // 截斷
  const big = freshApp();
  for (let i = 0; i < 60; i++) {
    const r = sendExpense(big, 'DZY901', 800);
    ageStep(big, r.data.id, (100 + i) * HOUR);
  }
  const bd = big.sb.apvDigest_();
  ok(bd.count === 60 && bd.text.length <= 1000, '60 張：文字 ≤ 1000 字', bd.text.length);
  const lines = bd.text.split('\n');
  const m = /^…另 (\d+) 張$/.exec(lines[lines.length - 1]);
  ok(m && Number(m[1]) + lines.length - 1 === 60 && Number(m[1]) > 0, '超過截斷，結尾寫「…另 N 張」且 N＋已列行數＝總數', lines[lines.length - 1]);
  ok(lines.slice(0, -1).every((l) => /^APV-\d{6}-\d{3}｜請款｜/.test(l)), '被截斷後留下的每行都是完整一行');
  ok(bd.title === '表單簽核：60 張卡關', '標題有總張數');
  // 剛好不超過：不加尾巴
  const few = freshApp();
  for (let i = 0; i < 5; i++) ageStep(few, sendExpense(few, 'DZY901', 800).data.id, 80 * HOUR);
  ok(!/…另/.test(few.sb.apvDigest_().text), '沒超過 1000 字不截斷');
}

// ============================================================
// 15. 寫入欄位格式（純文字，防公式注入）與其他防線
// ============================================================
{
  const app = freshApp();
  const f = upload(app, 'DZY901');
  const r = post(app, 'DZY901', 'apvSubmit', { client_id: newCid(), type: 'expense', body: expenseBody({ desc: '=HYPERLINK("x")' }), files: [f] });
  ok(r.ok && app.sheets.apv_forms._fmt[2] === '@', '寫入前該列設成純文字（文字開頭是 = 不會變公式）');
  ok(JSON.parse(formOf(app, r.data.id).body_json).desc === '=HYPERLINK("x")', 'body_json 原樣保存（前端匯出時才加 \' 前綴）');
  const long = post(app, 'DZY901', 'apvSubmit', { client_id: newCid(), type: 'expense', body: expenseBody({ desc: 'x'.repeat(201) }), files: [upload(app, 'DZY901')] });
  ok(long.error === 'bad_request', '說明超過 200 字被擋');
  ok(post(app, 'DZY901', 'apvGet', {}).error === 'not_found' && post(app, 'DZY901', 'apvGet', { id: 'x' }).error === 'not_found', 'apvGet 沒給或亂給 id → not_found');
  ok(post(app, 'DZY901', 'apvSubmit', { client_id: newCid(), type: 'expense', body: null, files: [f] }).error === 'bad_request', 'body 不是物件 → bad_request');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
