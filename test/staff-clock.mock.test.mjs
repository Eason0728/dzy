// node test/staff-clock.mock.test.mjs —— 員工名單統一 平台後端驗收（docs/personnel/master-data/task.md 階段 2：B1–B10、B7b、B8b）
// 做法同 staff.mock.test.mjs：把 Auth.gs／Users.gs／Staff.gs／StaffClock.gs／Code.gs 讀進同一個 vm sandbox，
// 對外 action 全程走 doPost；內部函式（結尾底線）直接呼叫（正式環境是同步員經 runGas 呼叫），並證明打 doPost 呼叫不到。
// ⚠ 所有姓名、手機、打卡編號、金鑰都是假資料（dzy 是 public repo，不得出現真實同仁資料）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'StaffClock.gs', 'Perms.gs', 'PermActions.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

// ── GAS 假物件（同 staff.mock.test.mjs）──────────────────────
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
  const props = { HMAC_SECRET: 'fake-hmac-for-clock-tests' };
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
  return app;
}

// ── 時間 ────────────────────────────────────────────────────
const pad = (n) => (n < 10 ? '0' : '') + n;
function taipei(offsetMs) {
  const t = new Date(Date.now() + (offsetMs || 0) + 8 * 3600 * 1000);
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()) + ' ' + pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) + ':' + pad(t.getUTCSeconds());
}
const MIN = 60000;
const nowT = (min) => taipei((min || 0) * MIN);
const dayT = (days) => taipei((days || 0) * 86400000).slice(0, 10);

// ── 資料 ────────────────────────────────────────────────────
const PROF = (over) => Object.assign({ brand: 'mzt', unit: 'mzt-gf', dept: '', title: 'pt', birthday: '1995-05-05', phone: '0911222333', address: '新竹市測試路一段1號' }, over || {});
function claimApprove(app, name, pw, over) {
  const { sb, tok } = app;
  post(sb, 'staffImport', { names: [name] }, tok);
  const lk = post(sb, 'claimLookup', { name });
  const sub = post(sb, 'claimSubmit', Object.assign({ name, emp_no: lk.data.emp_no, password: pw }, PROF(over)));
  if (!sub.ok) throw new Error('claimSubmit ' + sub.error);
  const cf = post(sb, 'staffConfirm', { emp_no: lk.data.emp_no }, tok);
  if (!cf.ok) throw new Error('staffConfirm ' + cf.error);
  const lg = post(sb, 'login', { username: lk.data.emp_no, password: pw });
  if (!lg.ok) throw new Error('login ' + lg.error);
  return { emp: lk.data.emp_no, token: lg.data.token, name };
}
const MZT_GF = (title) => ({ brand: 'mzt', unit: 'mzt-gf', title: title || 'sm' });
const MZT_JS = (title) => ({ brand: 'mzt', unit: 'mzt-js', title: title || 'sm' });

function rowsOf(app, name) {
  const rows = app.sheets[name]._rows();
  const head = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}
const maps = (app) => rowsOf(app, 'staff_clock');
const eq6 = (a, b) => (b === undefined ? JSON.stringify(a) === JSON.stringify(['cf', 'gf', 'hq', 'mztgf', 'mztjs', 'mztlzl', 'mztmc']) : JSON.stringify(a) === JSON.stringify(b));
const jobs = (app) => rowsOf(app, 'clock_outbox');
const staffOf = (app, emp) => rowsOf(app, 'staff').find((r) => r.emp_no === emp);
const mapOf = (app, emp, store) => maps(app).filter((m) => m.emp_no === emp && (!store || m.store_code === store));
const lastJob = (app, kind) => jobs(app).filter((j) => !kind || j.kind === kind).pop();
function allCellText(app) {
  return Object.keys(app.sheets).map((k) => app.sheets[k]._rows().map((r) => r.join('|')).join('\n')).join('\n') + '\n' + JSON.stringify(app.props);
}
function setCell(app, sheet, rowIdx0, header, value) {
  const head = app.sheets[sheet]._data[0];
  app.sheets[sheet]._data[rowIdx0][head.indexOf(header)] = value;
}
function setStaff(app, emp, header, value) {
  const idx = app.sheets.staff._data.findIndex((r) => r[0] === emp);
  setCell(app, 'staff', idx, header, value);
}
function setMap(app, store, eid, header, value) {
  const idx = app.sheets.staff_clock._data.findIndex((r, i) => i > 0 && r[1] === store && r[2] === eid);
  if (idx < 0) throw new Error('no map row ' + store + ':' + eid);
  setCell(app, 'staff_clock', idx, header, value);
}
// 直接給某人一筆 confirmed 對照（模擬已建好）
function giveMap(app, emp, store, eid, role, extra) {
  const e = Object.assign({ state: 'confirmed', source: 'created', roster_active: 'TRUE', last_punch: '' }, extra || {});
  app.sheets.staff_clock._data.push([emp, store, eid, role, e.state, e.source, e.roster_active, e.last_punch, 'tester', nowT(), nowT()]);
}
const rosterRow = (eid, name, over) => Object.assign({ emp_id: eid, name, active: true, created_at: '2026-01-01', removed_at: '', line_bound: true, last_punch: '2026-10-10', src_store: '', src_emp_id: '' }, over || {});
const clockNowIso = () => nowT(0);

// 驗證用 key 開頭
const FAKE_LINK_KEY = 'FAKELINKKEY-0000-ZZZ';

// ============================================================
// B1 分頁建立
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets } = app;
  sb.setupStaff(); sb.setupStaff();
  ok(sheets.clock_stores._rows()[0].join() === 'store_code,store_name,unit_code,enabled,payroll_store', 'B1 clock_stores 表頭逐字（含 payroll_store）');
  ok(sheets.staff_clock._rows()[0].join() === 'emp_no,store_code,emp_id,role,state,source,roster_active,last_punch,confirmed_by,confirmed_at,updated_at,line_h,line_kid,line_bound_at,line_ok_at,duty_mgr', 'B1 staff_clock 表頭逐字（spec §2.3＋LINE 認身分四欄＋duty_mgr）');
  ok(sheets.clock_outbox._rows()[0].join() === 'job_id,kind,emp_no,store_code,emp_id,name,op_id,expect_json,state,tries,next_at,lease_until,last_error,created_at,updated_at,done_at', 'B1 clock_outbox 表頭逐字（spec §2.4 v2）');
  const stores = sheets.clock_stores._rows().slice(1);
  ok(stores.length === 7 && stores.map((r) => r[0]).join() === 'gf,mztjs,mztgf,mztlzl,mztmc,hq,cf', 'B1 預設七列（2026-10-29 加 mztmc）、store_code 照契約', stores);
  ok(stores.map((r) => r[2]).join('|') === 'mala-gf|mzt-js|mzt-gf|mzt-lzl|mzt-mc|dzy-hq,mzt-hq,mala-hq,yiwu-hq|ck', 'B1 unit_code 依 org 預設單位對上（hq 一列放四個總部與品牌辦公室單位）', stores.map((r) => r[2]));
  ok(stores.every((r) => String(r[3]) === 'TRUE'), 'B1 預設全部啟用');
  const head = sheets.staff._rows()[0];
  ok(head.length === 28 && head[24] === 'hire_date' && head[25] === 'last_day' && head[26] === 'extra_depts' && head[27] === 'line_revoked_at', 'B1 staff 右側補 hire_date、last_day、extra_depts、line_revoked_at');
  ok(head.slice(0, 24).join() === sb.STF_HEADERS.join(), 'B1 staff 原 24 欄不變');
  // 只補不覆蓋
  sheets.clock_stores._data[1][3] = 'FALSE';
  sheets.clock_stores._data[1][1] = '自訂店名';
  sb.setupStaff();
  ok(sheets.clock_stores._data[1][3] === 'FALSE' && sheets.clock_stores._data[1][1] === '自訂店名' && sheets.clock_stores._rows().length === 8, 'B1 重跑只補不覆蓋：總部改過的 clock_stores 列不動、不重複');
  // 既有試算表（staff 只有 24 欄、沒有三個新分頁）→ 補上
  const old = load(freshSeed(HASHER));
  old.sb.setupStaff();
  old.sheets.staff._data[0].length = 24;          // 模擬舊版 24 欄表頭
  ['clock_stores', 'staff_clock', 'clock_outbox'].forEach((n) => delete old.sheets[n]);
  old.sb.setupStaff();
  ok(old.sheets.staff._rows()[0].length === 28 && old.sheets.clock_outbox && old.sheets.clock_stores._rows().length === 8, 'B1 舊試算表（24 欄、無新分頁）跑 setupStaff 後補齊');
  // unit_code 查不到 → 留空（org 預設少了央廚單位時）
  const noCk = load(freshSeed(HASHER));
  noCk.sb.STF_DEFAULT_ORG = noCk.sb.STF_DEFAULT_ORG.filter((r) => !(r[0] === 'unit' && r[1] === 'ck'));
  const blank = noCk.sb.clkDefaultStoreRows_();
  ok(blank.length === 7 && blank.find((r) => r[0] === 'cf')[2] === '' && blank.find((r) => r[0] === 'gf')[2] === 'mala-gf', 'B1 org 查不到對應單位 → unit_code 留空，其他照填');
  // 表頭不一致 → 停下回錯
  const bad = fresh();
  bad.sheets.clock_outbox._data[0][3] = 'store_codeX';
  let threw = '';
  try { bad.sb.setupStaff(); } catch (e) { threw = e.message; }
  ok(threw.indexOf('clock_outbox') !== -1 && threw.indexOf('表頭') !== -1, 'B1 表頭不一致 → setupStaff 停下回錯', threw);
  const bad2 = fresh();
  bad2.sheets.staff._data[0][25] = 'lastday';
  threw = '';
  try { bad2.sb.setupStaff(); } catch (e) { threw = e.message; }
  ok(threw.indexOf('staff') !== -1, 'B1 staff 右側表頭被改過 → 停下回錯', threw);
  const mgr = claimApprove(bad, '壞頭店長', 'mgr-bad-pw-01', MZT_GF('sm'));
  const before = bad.sheets.staff._rows().length;
  const r = post(bad.sb, 'staffCreateByUnit', { name: '新人壞頭', title: 'pt', hire_date: dayT(0), phone: '0922000111' }, mgr.token);
  ok(r.ok === false && r.code === 'setup_failed' && bad.sheets.staff._rows().length === before, 'B1 action 遇到表頭不一致回 setup_failed、不寫任何資料', r);
})();

// ============================================================
// B2 staffCreateByUnit
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets, tok } = app;
  const mgrGF = claimApprove(app, '店長甲', 'mgr-a-pw-01', MZT_GF('sm'));
  const mgrJS = claimApprove(app, '店長乙', 'mgr-b-pw-01', MZT_JS('sm'));
  const crew = claimApprove(app, '計時丙', 'crew-c-pw-01', MZT_GF('pt'));
  const head = claimApprove(app, '部主丁', 'head-d-pw-01', { brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hm' });
  const ceo = claimApprove(app, '主管戊', 'ceo-e-pw-01', { brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'ceo' });
  const body = (o) => Object.assign({ name: '新人一', title: 'pt', hire_date: dayT(-3), phone: '0922000111' }, o || {});

  const r1 = post(sb, 'staffCreateByUnit', body({ unit: 'mzt-js' }), mgrGF.token);   // 夾帶別的單位 → 忽略
  ok(r1.ok && /^DZY\d{3}$/.test(r1.data.emp_no) && r1.data.job_id && r1.data.store_code === 'mztgf', 'B2 店長新增：回 emp_no 與 job_id', r1);
  const s1 = staffOf(app, r1.data.emp_no);
  ok(s1.unit === 'mzt-gf' && s1.brand === 'mzt' && s1.status === 'unclaimed' && s1.title === 'pt' && s1.hire_date === dayT(-3) && s1.last_day === '', 'B2 ★payload 夾 unit 被忽略：建在店長自己的單位；status unclaimed、hire_date 寫進右側欄', s1);
  const j1 = jobs(app).find((j) => j.job_id === r1.data.job_id);
  ok(j1 && j1.kind === 'add' && j1.emp_no === r1.data.emp_no && j1.store_code === 'mztgf' && j1.state === 'pending' && j1.name === '新人一', 'B2 ★staff 與 add 單在同一支呼叫內都寫好', j1);
  ok(/^J\d{14}-[0-9a-f]{4}$/.test(j1.job_id) && j1.op_id === 'dzy:' + j1.job_id, 'B2/B4 job_id、op_id 照共用契約格式', j1);
  const u1 = sheets.users._rows().find((r) => r[1] === r1.data.emp_no);
  ok(u1 && u1[3] === 'staff' && u1[7] === 'TRUE', 'B2 同時建 users 帳號（和 staffAdd 一樣）');

  const r2 = post(sb, 'staffCreateByUnit', body({ name: '新人二', phone: '0922000112' }), mgrGF.token);
  ok(r2.ok && r2.data.emp_no !== r1.data.emp_no && r2.data.job_id !== r1.data.job_id, 'B2 ★連續兩次新增號碼不同、待辦單不同', [r1.data, r2.data]);
  const empNums = sheets.staff._rows().slice(1).map((r) => r[0]);
  ok(new Set(empNums).size === empNums.length, 'B2 staff 的 emp_no 全表唯一');
  const maxBefore = Math.max(...empNums.map((e) => +e.slice(3)));
  ok(+r2.data.emp_no.slice(3) === maxBefore, 'B2 DZY 接最大號（連號）');

  // emp_no 唯一檢查：users 有人佔了號碼（沒有 staff 列）→ 接號跳過去；若接號函式出錯回到已存在的號碼 → 擋
  sheets.users._data.push(['u900', 'DZY050', '佔號者', 'staff', '', '', '', 'TRUE', '', '']);
  const r3 = post(sb, 'staffCreateByUnit', body({ name: '新人三', phone: '0922000113' }), mgrGF.token);
  ok(r3.ok && +r3.data.emp_no.slice(3) === 51, 'B2 users 那邊佔了的號碼也算（接 DZY051）', r3);
  const orig = sb.stfMaxEmpNum_;
  sb.stfMaxEmpNum_ = () => +r1.data.emp_no.slice(3) - 1;   // 模擬取號錯誤：會撞到已存在的 emp_no
  const staffRowsBefore = sheets.staff._rows().length, jobsBefore = jobs(app).length;
  const r4 = post(sb, 'staffCreateByUnit', body({ name: '新人四', phone: '0922000114' }), mgrGF.token);
  sb.stfMaxEmpNum_ = orig;
  ok(r4.ok === false && r4.code === 'emp_conflict' && sheets.staff._rows().length === staffRowsBefore && jobs(app).length === jobsBefore, 'B2 ★emp_no 唯一檢查：撞號時整筆拒絕，什麼都沒寫', r4);

  // 擋同名
  const dup = post(sb, 'staffCreateByUnit', body({ name: '新人一', phone: '0922000115' }), mgrGF.token);
  ok(dup.ok === false && dup.code === 'duplicate_name' && dup.error.indexOf('加註') !== -1, 'B2 ★同單位在職同名擋（訊息教他加註）', dup);
  const dup2 = post(sb, 'staffCreateByUnit', body({ name: '新人 一', phone: '0922000115' }), mgrGF.token);
  ok(dup2.ok === false && dup2.code === 'duplicate_name', 'B2 同名比對忽略空白');
  const okNote = post(sb, 'staffCreateByUnit', body({ name: '新人一-B', phone: '0922000115' }), mgrGF.token);
  ok(okNote.ok, 'B2 加註後可以新增');
  // 他店的店長不能因為同名被擋（不同單位）？—— 未認領的同名全名單都擋（避免認領時查到兩個）
  const cross = post(sb, 'staffCreateByUnit', body({ name: '新人一' }), mgrJS.token);
  ok(cross.ok === false && cross.code === 'duplicate_name', 'B2 他單位也有同名「未認領」的人 → 擋（認領時會查到兩個）');

  // 權限
  ok(post(sb, 'staffCreateByUnit', body({ name: '新人五' }), crew.token).code === 'no_perm', 'B2 計時同仁不能新增');
  ok(post(sb, 'staffCreateByUnit', body({ name: '新人五', unit: 'dzy-hq', dept: 'it' }), head.token).code === 'no_perm', 'B2 ★總部部門主管（hq rank≥2）不能走店長路徑');
  ok(post(sb, 'staffCreateByUnit', body({ name: '新人五', unit: 'dzy-hq', dept: 'it' }), ceo.token).code === 'no_perm', 'B2 ★總部 rank≥3 的主管也被拒');
  ok(post(sb, 'staffCreateByUnit', body({ name: '新人五' }), '').ok === false, 'B2 沒登入被拒');
  ok(post(sb, 'staffCreateByUnit', body({ name: '新人五', title: 'sv' }), mgrGF.token).code === 'bad_input', 'B2 店長新增停用的督導職稱 → 擋');
  ok(post(sb, 'staffCreateByUnit', body({ name: '新人五', title: 'am' }), mgrGF.token).code === 'no_perm', 'B2 店長新增區經理（2026-10-20 起門市職稱、職級比自己高）→ 擋');
  ok(post(sb, 'staffCreateByUnit', body({ name: '新人五', title: 'fm' }), mgrGF.token).code === 'bad_input', 'B2 門市新增中央工廠專用的廠長 → 擋（單位限定職稱）');
  ok(post(sb, 'staffCreateByUnit', body({ name: '新人五', title: 'hs' }), mgrGF.token).ok === false, 'B2 門市單位選總部職稱 → 擋');

  // 總部：可指定單位；單位沒有打卡 → job_id=null
  const hqNoClock = post(sb, 'staffCreateByUnit', body({ name: '新人六', unit: 'yiwu-wx' }), tok);
  ok(hqNoClock.ok && hqNoClock.data.job_id === null && hqNoClock.data.store_code === null && staffOf(app, hqNoClock.data.emp_no).unit === 'yiwu-wx', 'B2 ★總部可指定單位；單位（一悟竹北）沒有對應打卡 → job_id=null、不寫待辦單', hqNoClock);
  const hqJS = post(sb, 'staffCreateByUnit', body({ name: '新人七', unit: 'mzt-js' }), tok);
  ok(hqJS.ok && jobs(app).find((j) => j.job_id === hqJS.data.job_id).store_code === 'mztjs', 'B2 總部指定金山 → add 單的店是 mztjs');
  const hqNeedDept = post(sb, 'staffCreateByUnit', body({ name: '新人八', unit: 'dzy-hq', title: 'hs' }), tok);
  ok(hqNeedDept.ok === false, 'B2 總部單位有部門清單 → 部門必填');
  const hqHq = post(sb, 'staffCreateByUnit', body({ name: '新人八', unit: 'dzy-hq', dept: 'it', title: 'hs' }), tok);
  ok(hqHq.ok && hqHq.data.store_code === 'hq', 'B2 總部單位 → 打卡店 hq');

  // 輸入驗證
  ok(post(sb, 'staffCreateByUnit', body({ name: '' }), mgrGF.token).ok === false, 'B2 姓名必填');
  ok(post(sb, 'staffCreateByUnit', body({ name: '長'.repeat(31) }), mgrGF.token).ok === false, 'B2 姓名最多 30 字');
  ok(post(sb, 'staffCreateByUnit', body({ name: '新人九', phone: '123' }), mgrGF.token).ok === false, 'B2 手機格式');
  ok(post(sb, 'staffCreateByUnit', body({ name: '新人九', hire_date: '2026-02-30' }), mgrGF.token).ok === false, 'B2 到職日必須是有效日期');
  ok(post(sb, 'staffCreateByUnit', body({ name: '新人九', hire_date: '' }), mgrGF.token).ok === false, 'B2 到職日必填');

  // staff_log 不含個資
  const log = sheets.staff_log._rows().filter((r) => r[2] === 'add_by_unit').map((r) => r.join('|')).join('\n');
  ok(log.length > 0 && log.indexOf('0922000111') === -1 && log.indexOf('新人一') === -1 && log.indexOf(dayT(-3)) === -1, 'B2 staff_log 不含姓名、手機、到職日', log);

  // 其他功能不受影響：新人可照第一期認領
  const lk = post(sb, 'claimLookup', { name: '新人二' });
  ok(lk.ok && lk.data.emp_no === r2.data.emp_no, 'B2 建好的新人可以照第一期流程認領（claimLookup 找得到）');
})();

// ============================================================
// B3 staffLeave／staffLeaveCancel
// ============================================================
// B3b 2026-10-25 審查 A-02：店長不能對職級跟自己一樣或更高的同店同仁登記／撤銷離職
(() => {
  const app = fresh();
  const { sb, tok } = app;
  const sm = claimApprove(app, '職店長甲', 'rk-sm-pw-001', MZT_GF('sm'));
  const sm2 = claimApprove(app, '職店長乙', 'rk-sm-pw-002', MZT_GF('sm'));
  const am = claimApprove(app, '職區經理', 'rk-am-pw-001', MZT_GF('am'));
  const pt = claimApprove(app, '職同仁一', 'rk-pt-pw-001', MZT_GF('pt'));
  const up = post(sb, 'staffLeave', { emp_no: am.emp, last_day: dayT(1) }, sm.token);
  ok(up.ok === false && up.code === 'no_perm' && staffOf(app, am.emp).last_day === '', 'B3b ★店長不能登記同店區經理離職', up);
  ok(post(sb, 'staffLeave', { emp_no: sm2.emp, last_day: dayT(1) }, sm.token).code === 'no_perm', 'B3b ★同級（另一位店長）也擋');
  ok(post(sb, 'staffLeave', { emp_no: pt.emp, last_day: dayT(1) }, sm.token).ok, 'B3b 店長登記同店店員 OK');
  ok(post(sb, 'staffLeave', { emp_no: am.emp, last_day: dayT(1) }, tok).ok, 'B3b 總部登記區經理 OK');
  ok(post(sb, 'staffLeaveCancel', { emp_no: am.emp }, sm.token).code === 'no_perm' && staffOf(app, am.emp).last_day === dayT(1), 'B3b ★店長不能撤銷總部替區經理登記的離職');
})();

(() => {
  const app = fresh();
  const { sb, sheets, tok } = app;
  const mgrGF = claimApprove(app, '離店長甲', 'mgr-a-pw-01', MZT_GF('sm'));
  const mgrJS = claimApprove(app, '離店長乙', 'mgr-b-pw-01', MZT_JS('sm'));
  const a = claimApprove(app, '離同仁一', 'crew-1-pw-01', MZT_GF('pt'));
  const b = claimApprove(app, '離同仁二', 'crew-2-pw-01', MZT_JS('pt'));
  const hrp = claimApprove(app, '離人資', 'hr-hr-pw-001', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' });
  sheets.users._data.find((r) => r[1] === hrp.emp)[3] = 'hr';
  const hrTok = post(sb, 'login', { username: hrp.emp, password: 'hr-hr-pw-001' }).data.token;

  const r = post(sb, 'staffLeave', { emp_no: a.emp, last_day: dayT(5) }, mgrGF.token);
  ok(r.ok && r.data.last_day === dayT(5) && r.data.can_cancel === true, 'B3 店長登記自己單位同仁離職（未來日期）', r);
  ok(staffOf(app, a.emp).last_day === dayT(5), 'B3 last_day 寫進 staff 右側欄');
  ok(post(sb, 'staffLeave', { emp_no: a.emp, last_day: dayT(0) }, mgrGF.token).ok, 'B3 可以改日期（今天）');
  ok(post(sb, 'staffLeave', { emp_no: a.emp, last_day: dayT(-7) }, mgrGF.token).ok, 'B3 店長往回補 7 天內可以（含第 7 天）');
  const past = post(sb, 'staffLeave', { emp_no: a.emp, last_day: dayT(-8) }, mgrGF.token);
  ok(past.ok === false && past.code === 'last_day_past', 'B3 ★店長：早於今天超過 7 天被擋', past);
  ok(post(sb, 'staffLeave', { emp_no: a.emp, last_day: dayT(-30) }, tok).ok, 'B3 ★總部不擋往回');
  ok(post(sb, 'staffLeave', { emp_no: a.emp, last_day: '2026-13-01' }, tok).ok === false, 'B3 日期格式要對');
  ok(post(sb, 'staffLeave', { emp_no: a.emp, last_day: dayT(900) }, tok).ok === false, 'B3 太遠的未來不收');
  ok(post(sb, 'staffLeave', { emp_no: b.emp, last_day: dayT(3) }, mgrGF.token).code === 'no_perm', 'B3 ★店長不能動別單位的人');
  ok(post(sb, 'staffLeave', { emp_no: b.emp, last_day: dayT(3) }, a.token).code === 'no_perm', 'B3 一般同仁不能登記');
  ok(post(sb, 'staffLeave', { emp_no: b.emp, last_day: dayT(3) }, mgrJS.token).ok, 'B3 他店店長動自己店的人 OK');
  ok(post(sb, 'staffLeave', { emp_no: 'DZY999', last_day: dayT(3) }, tok).code === 'not_found', 'B3 找不到同仁');
  // 不能對自己登記離職
  const self = post(sb, 'staffLeave', { emp_no: mgrGF.emp, last_day: dayT(3) }, mgrGF.token);
  ok(self.ok === false && self.code === 'self_leave', 'B3 ★店長不能對自己登記離職', self);
  const selfHr = post(sb, 'staffLeave', { emp_no: hrp.emp, last_day: dayT(3) }, hrTok);
  ok(selfHr.ok === false && selfHr.code === 'self_leave', 'B3 ★總部（人資）也不能對自己登記離職', selfHr);
  ok(post(sb, 'staffLeave', { emp_no: mgrGF.emp, last_day: dayT(3) }, hrTok).ok, 'B3 總部可以替店長登記');
  ok(post(sb, 'staffLeaveCancel', { emp_no: mgrGF.emp }, mgrGF.token).code === 'self_leave', 'B3 店長不能自己撤銷（避免推翻總部的決定）');

  // 撤銷
  ok(post(sb, 'staffLeave', { emp_no: a.emp, last_day: dayT(2) }, mgrGF.token).ok, 'B3 （重設 a 的最後上班日為未來）');
  const c1 = post(sb, 'staffLeaveCancel', { emp_no: a.emp }, mgrGF.token);
  ok(c1.ok && staffOf(app, a.emp).last_day === '', 'B3 撤銷：last_day 清空', c1);
  ok(post(sb, 'staffLeaveCancel', { emp_no: a.emp }, mgrGF.token).code === 'no_leave', 'B3 沒登記不能撤銷');
  post(sb, 'staffLeave', { emp_no: a.emp, last_day: dayT(0) }, mgrGF.token);
  ok(post(sb, 'staffLeaveCancel', { emp_no: a.emp }, mgrGF.token).ok, 'B3 ★last_day 當天結束前仍可撤銷');
  post(sb, 'staffLeave', { emp_no: a.emp, last_day: dayT(-2) }, mgrGF.token);
  const late = post(sb, 'staffLeaveCancel', { emp_no: a.emp }, mgrGF.token);
  ok(late.ok === false && late.code === 'leave_passed', 'B3 ★last_day 已過 → 不能撤銷', late);
  ok(post(sb, 'staffLeaveCancel', { emp_no: a.emp }, tok).code === 'leave_passed', 'B3 總部也一樣（過了就走復職）');
  // 已停用
  post(sb, 'staffSetActive', { emp_no: b.emp, active: false }, tok);
  ok(post(sb, 'staffLeave', { emp_no: b.emp, last_day: dayT(1) }, mgrJS.token).code === 'already_disabled', 'B3 ★已停用的人不能登記離職');
  const lg = sheets.staff_log._rows().filter((x) => x[2] === 'leave_set' || x[2] === 'leave_cancel').map((x) => x.join('|')).join('\n');
  ok(lg.length > 0 && lg.indexOf(dayT(5)) === -1 && lg.indexOf('離同仁') === -1, 'B3 staff_log 只記事件，不記日期與姓名');
})();

// ============================================================
// B4 clock_outbox 狀態機：claim／done／retry／jobStatus
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets, tok } = app;
  const mgr = claimApprove(app, '單店長', 'mgr-a-pw-01', MZT_GF('sm'));
  const c1 = post(sb, 'staffCreateByUnit', { name: '單新人一', title: 'pt', hire_date: dayT(0), phone: '0933000111' }, mgr.token);
  const jobId = c1.data.job_id, emp = c1.data.emp_no;

  // claim：只給 pending 且 next_at≤now；撿到轉 running，lease=now+5 分
  ok(sb.clockOutboxClaim_(nowT(1), 10, ['link', 'build']).data.jobs.length === 0 && jobs(app)[0].state === 'pending', 'B4 claim 可用 kinds 篩選（CLOCK_WRITE=0 時 add 單不被撿、仍是 pending）');
  const early = sb.clockOutboxClaim_(nowT(-10));
  ok(early.ok && early.data.jobs.length === 0, 'B4 ★next_at 還沒到的單不會被撿', early);
  const t0 = nowT(1);
  const cl = sb.clockOutboxClaim_(t0);
  ok(cl.ok && cl.data.jobs.length === 1 && cl.data.jobs[0].job_id === jobId && cl.data.jobs[0].kind === 'add' && cl.data.jobs[0].name === '單新人一' && cl.data.jobs[0].op_id === 'dzy:' + jobId, 'B4 撿到 pending 單（含 name、op_id）', cl);
  const jr = () => jobs(app).find((j) => j.job_id === jobId);
  ok(jr().state === 'running' && jr().lease_until > t0 && jr().lease_until <= nowT(7), 'B4 撿到即轉 running，lease_until ≈ now+5 分鐘', jr());
  ok(sb.clockOutboxClaim_(t0).data.jobs.length === 0, 'B4 ★同一張單不會被撿第二次（鎖內讀改寫）');
  ok(sb.clockOutboxClaim_(nowT(3)).data.jobs.length === 0, 'B4 running 還沒過期（lease 內）不重撿');
  const reclaim = sb.clockOutboxClaim_(nowT(8));
  ok(reclaim.data.jobs.length === 1 && reclaim.data.jobs[0].job_id === jobId, 'B4 ★running 超過 5 分鐘視為可再撿');
  ok(jr().tries === 1 && jr().last_error === 'lease_expired', 'FIX6 ★lease 過期被重撿：tries+1、last_error=lease_expired', jr());
  setCell(app, 'clock_outbox', 1, 'tries', 0); setCell(app, 'clock_outbox', 1, 'last_error', '');   // 歸零，接著測失敗排程
  // 鎖
  const realLock = sb.LockService;
  sb.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock() {} }) };
  ok(sb.clockOutboxClaim_(nowT(30)).code === 'busy', 'B4 內部函式自己拿鎖，拿不到回 busy');
  sb.LockService = realLock;

  // 失敗重試排程：1、5、30 分鐘、之後每 6 小時
  const fail = (code) => sb.clockOutboxDone_(jobId, { ok: false, error: code, message: '假的錯誤' }, nowT(10));
  const t10 = nowT(10);
  const minutesFromNow = () => Math.round((Date.parse(jr().next_at.replace(' ', 'T') + '+08:00') - Date.parse(t10.replace(' ', 'T') + '+08:00')) / MIN);
  let f = fail('network');
  ok(f.ok && jr().state === 'pending' && jr().tries === 1 && minutesFromNow() === 1, 'B4 ★第 1 次失敗：1 分鐘後重試', jr());
  fail('busy'); ok(jr().tries === 2 && minutesFromNow() === 5, 'B4 第 2 次失敗：5 分鐘');
  fail('timeout'); ok(jr().tries === 3 && minutesFromNow() === 30 && jr().state === 'pending', 'B4 第 3 次失敗：30 分鐘');
  fail('network'); ok(jr().tries === 4 && minutesFromNow() === 360, 'B4 之後每 6 小時');
  ok(jr().last_error.indexOf('network') !== -1 && jr().lease_until === '', 'B4 last_error 有記、lease 清掉');
  // alerts：tries≥3 才進
  const al = post(sb, 'clockAlerts', {}, tok);
  ok(al.ok && al.data.outbox_failed.some((x) => x.job_id === jobId && x.tries === 4), 'B4 ★tries≥3 的單進 alerts（紅色待辦）', al);
  // 手動重試：只有總部
  ok(post(sb, 'clockOutboxRetry', { job_id: jobId }, mgr.token).code === 'no_perm', 'B4 店長不能重試');
  const rt = post(sb, 'clockOutboxRetry', { job_id: jobId }, tok);
  ok(rt.ok && jr().state === 'pending' && jr().tries === 0 && jr().next_at <= nowT(0), 'B4 總部按「重試」：回 pending、立刻可撿、tries 歸零', jr());
  ok(post(sb, 'clockOutboxRetry', { job_id: jobId }, tok).code === 'not_retryable', 'B4 沒卡住的單不能重試');
  // 永久性錯誤：直接 failed
  sb.clockOutboxClaim_(nowT(1));
  const perm = sb.clockOutboxDone_(jobId, { ok: false, error: 'duplicate_name', message: '本店已有在職同仁同名' }, nowT(2));
  ok(perm.ok && jr().state === 'failed' && jr().tries === 1 && jr().next_at === '', 'B4 duplicate_name → failed（不自動重試）', jr());
  ok(sb.clockOutboxClaim_(nowT(60 * 24)).data.jobs.length === 0, 'B4 failed 的單不會被撿');
  ok(post(sb, 'clockAlerts', {}, tok).data.outbox_failed.some((x) => x.job_id === jobId && x.state === 'failed'), 'B4 failed 的單進 alerts');
  ok(post(sb, 'clockOutboxRetry', { job_id: jobId }, tok).ok, 'B4 failed 可手動重試');

  // 成功：add → staff_clock home / created / confirmed
  sb.clockOutboxClaim_(nowT(1));
  const done = sb.clockOutboxDone_(jobId, { ok: true, emp_id: 'T7' }, nowT(2));
  ok(done.ok && done.data.state === 'done' && done.data.emp_id === 'T7', 'B4 add 成功回填', done);
  const m = mapOf(app, emp);
  ok(m.length === 1 && m[0].store_code === 'mztgf' && m[0].emp_id === 'T7' && m[0].role === 'home' && m[0].state === 'confirmed' && m[0].source === 'created' && m[0].roster_active === 'TRUE' && m[0].confirmed_by !== '', 'B4 ★add 成功：staff_clock 寫 home／created／confirmed', m);
  ok(jr().state === 'done' && jr().done_at !== '' && jr().emp_id === 'T7', 'B4 單轉 done、done_at、emp_id');
  const again = sb.clockOutboxDone_(jobId, { ok: true, emp_id: 'T8' }, nowT(3));
  ok(again.ok && again.data.already === true && mapOf(app, emp).length === 1 && jr().emp_id === 'T7', 'B4 ★已完成的單重複回填不改任何東西（冪等）');
  // 狀態查詢（輪詢）
  const st = post(sb, 'clockJobStatus', { job_id: jobId }, mgr.token);
  ok(st.ok && st.data.state === 'done' && st.data.emp_id === 'T7' && st.data.kind === 'add', 'B4 clockJobStatus：店長查得到自己單位的單', st);
  const other = claimApprove(app, '他店長', 'mgr-j-pw-01', MZT_JS('sm'));
  ok(post(sb, 'clockJobStatus', { job_id: jobId }, other.token).code === 'no_job', 'B4 他單位店長查不到');
  ok(post(sb, 'clockJobStatus', { job_id: 'J00000000000000-0000' }, tok).code === 'no_job', 'B4 不存在的單');

  // 唯一鍵：同一個打卡編號不能對給兩個人；同人同店不能有兩個 confirmed
  const c2 = post(sb, 'staffCreateByUnit', { name: '單新人二', title: 'pt', hire_date: dayT(0), phone: '0933000112' }, mgr.token);
  sb.clockOutboxClaim_(nowT(1));
  const dupId = sb.clockOutboxDone_(c2.data.job_id, { ok: true, emp_id: 'T7' }, nowT(2));
  ok(dupId.data.state === 'failed' && mapOf(app, c2.data.emp_no).length === 0 && maps(app).filter((x) => x.store_code === 'mztgf' && x.emp_id === 'T7').length === 1, 'B4 ★唯一鍵 store_code+emp_id：同一打卡編號不會對給兩個人', dupId);
  // 驗證打卡端回的編號
  const c3 = post(sb, 'staffCreateByUnit', { name: '單新人三', title: 'pt', hire_date: dayT(0), phone: '0933000113' }, mgr.token);
  sb.clockOutboxClaim_(nowT(1));
  sb.clockOutboxDone_(c3.data.job_id, { ok: true, emp_id: '含空 白' }, nowT(2));
  ok(jobs(app).find((j) => j.job_id === c3.data.job_id).state === 'failed' && mapOf(app, c3.data.emp_no).length === 0, 'B4 打卡端回的編號格式不對 → failed，不寫對照');
})();

// ============================================================
// 值班主管本人的申請改由上層審（2026-10-28，docs/req-upper）：duty_mgr 欄與 clockUpperEmps_
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets } = app;
  const p = (n) => claimApprove(app, n, 'pw-' + n + '-0001', MZT_GF('pt')).emp;
  const eA = p('值班甲'), eB = p('一般乙'), eC = p('離職丙');
  giveMap(app, eA, 'mztgf', 'G1', 'home');
  giveMap(app, eA, 'mztjs', 'J1', 'support', { source: 'name_match' });
  giveMap(app, eA, 'hq', 'H1', 'support', { source: 'name_match' });
  giveMap(app, eB, 'mztgf', 'G2', 'home');
  giveMap(app, eC, 'mztgf', 'G3', 'home');
  const dutyOf = (store, eid) => maps(app).find((x) => x.store_code === store && x.emp_id === eid).duty_mgr;
  // 沒套用過名冊：舊列沒有 duty_mgr → 空 → 名單空
  const u0 = sb.clockUpperEmps_();
  ok(u0.ok === true && eq6(Object.keys(u0.stores).sort()) && Object.keys(u0.stores).every((k) => Array.isArray(u0.stores[k]) && u0.stores[k].length === 0), 'DM 還沒同步 duty_mgr：六店代碼都有 key、全是空陣列', u0);
  sb.clockRosterApply_('mztgf', [rosterRow('G1', '值班甲', { duty_mgr: true }), rosterRow('G2', '一般乙'), rosterRow('G3', '離職丙', { duty_mgr: 'TRUE' })], undefined, nowT(0));
  ok(dutyOf('mztgf', 'G1') === 'TRUE' && dutyOf('mztgf', 'G2') !== 'TRUE' && dutyOf('mztgf', 'G3') === 'TRUE', 'DM clockRosterApply_ 依 svc_roster 列的 duty_mgr 寫入（true／"TRUE"→TRUE；欄位不存在→非 TRUE）', maps(app).map((x) => x.emp_id + ':' + x.duty_mgr));
  const u1 = sb.clockUpperEmps_();
  ok(eq6(u1.stores.mztgf, ['G1', 'G3']) && eq6(u1.stores.mztjs, ['J1']) && eq6(u1.stores.hq, ['H1']) && u1.stores.gf.length === 0 && u1.stores.cf.length === 0 && u1.stores.mztlzl.length === 0,
    'DM ★clockUpperEmps_：值班主管在每一店所有 confirmed 對照的 emp_id（含不是值班那幾店）；一般人不在', u1.stores);
  // 名冊上停用 → roster_active FALSE：不再算（G3 這筆停用，他在別店也沒有對照 → 消失）
  sb.clockRosterApply_('mztgf', [rosterRow('G1', '值班甲', { duty_mgr: true }), rosterRow('G2', '一般乙'), rosterRow('G3', '離職丙', { active: false, duty_mgr: true })], undefined, nowT(1));
  ok(eq6(sb.clockUpperEmps_().stores.mztgf, ['G1']), 'DM roster_active=FALSE 的值班對照不算', sb.clockUpperEmps_().stores.mztgf);
  // 取消值班 → 名單剔除（連同他在別店的對照）
  sb.clockRosterApply_('mztgf', [rosterRow('G1', '值班甲'), rosterRow('G2', '一般乙')], undefined, nowT(2));
  ok(dutyOf('mztgf', 'G1') === 'FALSE', 'DM 下次同步 duty_mgr=FALSE → 改回 FALSE');
  const u2 = sb.clockUpperEmps_();
  ok(Object.keys(u2.stores).every((k) => u2.stores[k].length === 0), 'DM 取消值班後名單清空', u2.stores);
  // 另一店也標值班：該人所有 confirmed 對照都進名單；pending 的不進
  giveMap(app, eB, 'mztjs', 'J2', 'support', { state: 'suggested' });
  sb.clockRosterApply_('mztjs', [rosterRow('J1', '值班甲'), rosterRow('J2', '一般乙', { duty_mgr: true })], undefined, nowT(3));
  const u3 = sb.clockUpperEmps_();
  ok(u3.stores.mztjs.indexOf('J2') === -1, 'DM suggested 對照不進名單（沒生效）', u3.stores);
  // 值班主管沒有 confirmed 對照：duty_mgr=TRUE 的非 confirmed 列、以及同步記下的「打卡上有沒對照」且 duty 的帳號 → clockUpperEmps_.unmapped 計數
  {
    const a5 = fresh();
    const eX = claimApprove(a5, '未對照甲', 'pw-un-0001', MZT_GF('pt')).emp;
    giveMap(a5, eX, 'mztgf', 'U1', 'home', { state: 'suggested' });
    giveMap(a5, eX, 'mztjs', 'U2', 'home', { state: 'suggested', roster_active: 'FALSE' });
    const r5 = a5.sb.clockRosterApply_('mztgf', [rosterRow('U1', '未對照甲', { duty_mgr: true }), rosterRow('U9', '沒對照乙', { duty_mgr: true }), rosterRow('U8', '沒對照丙')], undefined, nowT(0));
    ok(r5.ok, 'DM unmapped 套用成功', r5);
    const up = a5.sb.clockUpperEmps_();
    ok(up.unmapped === 2 && eq6(up.stores.mztgf, []), 'DM ★clockUpperEmps_.unmapped＝suggested 的值班列(1)＋同步記下沒對照的值班帳號(1)；roster_active=FALSE 與非值班不算', up);
    const un = a5.sb.clkDutyUnmapped_(a5.sb.clkMaps_()).map((x) => x.store_code + ':' + x.emp_id + ':' + x.reason).sort();
    ok(eq6(un, ['mztgf:U1:unmapped', 'mztgf:U9:unmapped']), 'DM clkDutyUnmapped_ 項目形狀（無姓名）', un);
    const al = post(a5.sb, 'clockAlerts', {}, a5.tok);
    ok(al.data.unmapped.some((u) => u.emp_id === 'U9') && al.data.unmapped.some((u) => u.emp_id === 'U8'), 'DM 原有 alerts.unmapped 不受影響（duty 欄不外洩影響）');
    ok(a5.sb.clockUpperEmps_().unmapped === 2 && u0.unmapped === 0, 'DM 沒有時 unmapped=0');
  }
  // 不進分派表
  ok(post(sb, 'clockUpperEmps_', {}, app.tok).ok === false && post(sb, 'clockUpperEmps', {}, app.tok).ok === false, 'DM clockUpperEmps_ 不進 Code.gs 分派表');
  // 舊 15 欄表直接跑 clockRosterApply_（沒先跑 setupStaff）→ 自動補成 16 欄、duty_mgr 正確、其他欄不動
  {
    const a3 = fresh();
    a3.sb.setupStaff();
    const sd = a3.sheets.staff_clock._data;
    sd[0] = sd[0].slice(0, 15);
    const e3 = claimApprove(a3, '舊表甲', 'pw-old-0001', MZT_GF('pt')).emp;
    sd.push([e3, 'mztgf', 'G1', 'home', 'confirmed', 'created', 'TRUE', '', 'tester', 'c0', 'u0', 'h', 'k', 'b', 'o']);
    const r3 = a3.sb.clockRosterApply_('mztgf', [rosterRow('G1', '舊表甲', { duty_mgr: true, last_punch: '' })], undefined, nowT(0));
    const row = sd[sd.length - 1];
    ok(r3.ok && sd[0].length === 16 && sd[0][15] === 'duty_mgr' && row[15] === 'TRUE', 'DM ★舊 15 欄表直接 clockRosterApply_：補成 16 欄、duty_mgr=TRUE', [r3, sd[0], row]);
    ok(row.slice(0, 15).join('|') === [e3, 'mztgf', 'G1', 'home', 'confirmed', 'created', 'TRUE', '', 'tester', 'c0', 'u0', 'h', 'k', 'b', 'o'].join('|') || row[10] !== 'u0', 'DM 其他欄不動（updated_at 可更新）');
    ok(row[0] === e3 && row[1] === 'mztgf' && row[2] === 'G1' && row[3] === 'home' && row[8] === 'tester' && row[9] === 'c0', 'DM 識別欄與確認欄不動');
    // 表頭亂掉 → 不寫
    const a4 = fresh();
    a4.sb.setupStaff();
    a4.sheets.staff_clock._data[0][3] = 'zzz';
    const r4 = a4.sb.clockRosterApply_('mztgf', [rosterRow('G1', 'x')], undefined, nowT(0));
    ok(r4.ok === false, 'DM 表頭不一致 → 拒絕寫入', r4);
  }
  // 舊表（沒有 duty_mgr 表頭）→ clkSetup_ 補表頭、不動既有資料
  const app2 = fresh();
  app2.sb.setupStaff();
  const head = app2.sheets.staff_clock._data[0];
  const old = head.slice(0, 15);
  app2.sheets.staff_clock._data[0] = old.slice();
  app2.sheets.staff_clock._data.push(['DZY001', 'gf', 'E1', 'home', 'confirmed', 'created', 'TRUE', '', '', '', '', '', '', '', '']);
  app2.sb.clkSetup_(app2.sheets.staff_clock ? { getSheetByName: (n) => app2.sheets[n] || null } : null);
  ok(app2.sheets.staff_clock._data[0].join() === head.join() && app2.sheets.staff_clock._data[1][0] === 'DZY001', 'DM 舊表（缺 duty_mgr）自動補表頭、資料列不動', app2.sheets.staff_clock._data[0]);
})();

// ============================================================
// B5 clockRosterApply_
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets, tok } = app;
  const p = (n) => claimApprove(app, n, 'pw-' + n + '-0001', MZT_GF('pt')).emp;
  const eA = p('名冊甲'), eB = p('名冊乙'), eC = p('名冊丙'), eD = p('名冊丁');
  giveMap(app, eA, 'mztgf', 'G1', 'home');
  giveMap(app, eB, 'mztgf', 'G2', 'home');
  giveMap(app, eC, 'mztjs', 'J1', 'support', { source: 'name_match' });    // 他在金山的名冊
  giveMap(app, eD, 'mztgf', 'G9', 'home');                                  // 名冊上將消失
  const rows = [
    rosterRow('G1', '名冊甲', { last_punch: '2026-10-12' }),
    rosterRow('G2', '名冊乙', { active: false, last_punch: '2026-09-01' }),
    rosterRow('G3', '無來源新人'),                                          // 沒 src、沒對照 → 打卡上有沒對照
    rosterRow('G4', '支援來的人', { src_store: 'mztjs', src_emp_id: 'J1' }), // 有 src → 自動對照
    rosterRow('G5', '已離新人', { active: false })
  ];
  const r = sb.clockRosterApply_('mztgf', rows, undefined, nowT(0));
  ok(r.ok && r.data.created === 1 && r.data.unmapped === 1, 'B5 套用結果：1 筆自動對照、1 筆打卡上有沒對照', r);
  const g1 = maps(app).find((x) => x.store_code === 'mztgf' && x.emp_id === 'G1');
  ok(g1.roster_active === 'TRUE' && g1.last_punch === '2026-10-12', 'B5 roster_active、last_punch 更新');
  ok(maps(app).find((x) => x.emp_id === 'G2').roster_active === 'FALSE', 'B5 名冊上停用 → roster_active FALSE');
  ok(maps(app).find((x) => x.emp_id === 'G9').roster_active === 'FALSE', 'B5 名冊上完全沒有的編號 → 視為不在職');
  const g4 = maps(app).find((x) => x.store_code === 'mztgf' && x.emp_id === 'G4');
  ok(g4 && g4.emp_no === eC && g4.role === 'support' && g4.source === 'auto_support' && g4.state === 'confirmed', 'B5 ★有 src_* 的新列直接 support／auto_support／confirmed（指到來源對照的那個人）', g4);
  ok(!maps(app).some((x) => x.emp_id === 'G3') && !maps(app).some((x) => x.emp_id === 'G5'), 'B5 沒 src 的不建對照；停用的新列不理');
  const al = post(sb, 'clockAlerts', {}, tok);
  ok(al.data.unmapped.length === 1 && al.data.unmapped[0].emp_id === 'G3' && al.data.unmapped[0].store_code === 'mztgf', 'B5 「打卡上有、沒對照」進 alerts', al.data.unmapped);
  // 再跑一次：唯一鍵不重複
  const before = maps(app).length;
  sb.clockRosterApply_('mztgf', rows, undefined, nowT(1));
  ok(maps(app).length === before && maps(app).filter((x) => x.store_code === 'mztgf' && x.emp_id === 'G4').length === 1, 'B5 ★跑兩次：唯一鍵 store_code+emp_id 不重複、列數不變');
  // src 指不到 confirmed 對照 → 不自動建
  sb.clockRosterApply_('mztgf', [rosterRow('G6', '亂指的人', { src_store: 'mztjs', src_emp_id: 'NOPE' })], undefined, nowT(1));
  ok(!maps(app).some((x) => x.emp_id === 'G6') && post(sb, 'clockAlerts', {}, tok).data.unmapped.some((u) => u.emp_id === 'G6'), 'B5 src 指不到生效對照 → 列為沒對照，不亂配');
  // 同人同店已經有 confirmed 時，不再自動加第二個
  const dupRows = [rosterRow('G1', '名冊甲'), rosterRow('G7', '名冊甲重複', { src_store: 'mztgf', src_emp_id: 'G1' })];
  sb.clockRosterApply_('mztgf', dupRows, undefined, nowT(2));
  ok(!maps(app).some((x) => x.emp_id === 'G7'), 'B5 ★同人同店只一個 confirmed：不再自動加第二個編號');
  // 7A 自動建的人被 B 店移除 → rejected（DZY 仍在職）
  sb.clockRosterApply_('mztgf', [rosterRow('G1', '名冊甲'), rosterRow('G4', '支援來的人', { active: false, src_store: 'mztjs', src_emp_id: 'J1' })], undefined, nowT(3));
  ok(maps(app).find((x) => x.emp_id === 'G4').state === 'rejected', 'B5 ★首次支援被 B 店移除 → 對照標 rejected');
  sb.clockRosterApply_('mztgf', [rosterRow('G1', '名冊甲'), rosterRow('G4', '支援來的人', { src_store: 'mztjs', src_emp_id: 'J1' })], undefined, nowT(4));
  ok(maps(app).find((x) => x.emp_id === 'G4').state === 'rejected', 'B5 rejected 之後不會被自動加回');
  ok(sb.clockRosterApply_('nope', [], undefined).code === 'bad_input', 'B5 不認得的店');

  // B8b 姓名一致檢查：打卡名冊姓名≠薪資主檔姓名
  const r2 = sb.clockRosterApply_('mztgf', [rosterRow('G1', '名冊甲'), rosterRow('G2', '名冊乙')], [
    { store: 'mztgf', emp_id: 'G1', name: '名冊甲' },
    { store: 'mztgf', emp_id: 'G2', name: '名冊 乙X' },
    { store: 'gf', emp_id: 'G1', name: '別店的不看' }
  ], nowT(5));
  ok(r2.data.payroll_diff === 1, 'B8b 薪資主檔姓名和打卡名冊不同 → 1 筆（同店同 emp_id 才比）', r2);
  const al2 = post(sb, 'clockAlerts', {}, tok);
  ok(al2.data.payroll_diff.length === 1 && al2.data.payroll_diff[0].emp_id === 'G2' && al2.data.counts.payroll_diff === 1, 'B8b 進 alerts（請會計把薪資主檔姓名改成和打卡一樣）', al2.data.payroll_diff);
  sb.clockRosterApply_('mztgf', [rosterRow('G1', '名冊甲'), rosterRow('G2', '名冊乙')], [{ store: 'mztgf', emp_id: 'G2', name: '名冊乙' }], nowT(6));
  ok(post(sb, 'clockAlerts', {}, tok).data.payroll_diff.length === 0, 'B8b 會計改成一致後，下次同步異常消失');
  // 管理系統姓名 ≠ 打卡名冊姓名
  const r3 = sb.clockRosterApply_('mztgf', [rosterRow('G1', '名冊甲'), rosterRow('G2', '名冊乙已改')], undefined, nowT(7));
  ok(r3.data.name_diff === 1 && r3.data.payroll_diff === 0, 'B5 管理系統姓名≠打卡名冊姓名 → name_diff', r3);
})();

// ============================================================
// B6 建對照：clockMapBuild／clockMapBuildApply_／clockMapList／clockMapDecide
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets, tok } = app;
  // 前置檢查
  const pre0 = post(sb, 'clockMapBuild', {}, tok);
  ok(pre0.ok === false && pre0.code === 'precheck_baseline', 'B6 ★前置檢查：staff 不到 DZY001～DZY113 → 拒絕', pre0);
  // 113 人基準：特別的幾位排在前面
  const special = ['建甲', '建乙', '建丙', '建丁', '建同名', '建同名', '跨店人', '店長建'];
  const fillers = []; for (let i = special.length; i < 113; i++) fillers.push('基準人' + i);
  ok(post(sb, 'staffImport', { names: ['建甲', '建乙', '建丙', '建丁', '建同名', '建同名X', '跨店人', '店長建'].concat(fillers) }, tok).ok, 'B6 （匯入 113 人基準名單）');
  const E = (n) => sheets.staff._rows().find((r) => r[2] === n)[0];
  // 重名組
  const eX = E('建同名X');
  setStaff(app, eX, 'name', '建同名');
  const preDup = post(sb, 'clockMapBuild', {}, tok);
  ok(preDup.code === 'precheck_dup_name', 'B6 ★前置檢查：同仁名單有重複姓名 → 拒絕', preDup);
  setStaff(app, eX, 'name', '建同名X');
  const setOrg = (n, unit, title) => post(sb, 'staffEdit', { emp_no: E(n), brand: unit.split('-')[0] === 'mzt' ? 'mzt' : (unit === 'mala-gf' ? 'mala' : 'dzy'), unit, dept: unit === 'dzy-hq' ? 'it' : '', title: title || 'pt' }, tok);
  ok(setOrg('建甲', 'mzt-gf').ok && setOrg('建乙', 'mzt-js').ok && setOrg('跨店人', 'dzy-hq', 'hs').ok && setOrg('店長建', 'mzt-gf', 'sm').ok, 'B6 （設單位）');
  // 未完成待辦單 → 拒絕
  const st0 = sb.clockOutboxClaim_ ? null : null;
  giveMap(app, 'DZY001', 'mztgf', 'XX', 'home', { state: 'rejected' });
  sheets.clock_outbox._data.push(['J20260101000000-aaaa', 'add', E('建甲'), 'mztgf', '', '建甲', 'dzy:J20260101000000-aaaa', '{}', 'pending', 0, nowT(0), '', '', nowT(0), nowT(0), '']);
  const preOut = post(sb, 'clockMapBuild', {}, tok);
  ok(preOut.code === 'precheck_outbox', 'B6 ★前置檢查：clock_outbox 有未完成單 → 拒絕', preOut);
  sheets.clock_outbox._data[1][8] = 'done';
  sheets.staff_clock._data.length = 1;     // 清掉上面塞的列
  ok(post(sb, 'clockMapBuild', {}, mgrless()).ok === false, 'B6 沒登入不能建');
  function mgrless() { return ''; }
  const lead = claimApprove(app, '建店長', 'mgr-lead-pw-1', MZT_GF('sm'));
  ok(post(sb, 'clockMapBuild', {}, lead.token).code === 'no_perm', 'B6 店長不能「建立打卡對照」（只有總部）');
  const b = post(sb, 'clockMapBuild', {}, tok);
  ok(b.ok && /^J\d{14}-[0-9a-f]{4}$/.test(b.data.job_id), 'B6 前置檢查通過 → 寫一張待辦單（kind=build）', b);
  const bj = jobs(app).find((j) => j.job_id === b.data.job_id);
  ok(bj.kind === 'build' && bj.state === 'pending', 'B6 build 單進 outbox', bj);
  ok(sb.clockOutboxClaim_(nowT(1)).data.jobs.some((j) => j.job_id === b.data.job_id && j.kind === 'build'), 'B6 build 單可被同步員撿走');
  sb.clockOutboxDone_(b.data.job_id, { ok: true }, nowT(2));

  // 套用：六店名冊
  const staffBefore = sheets.staff._rows().length;
  setStaff(app, eX, 'name', '建同名');   // 套用時兩位在職的同名 DZY → 「建同名」變成同名多人
  const rosters = {
    gf: [rosterRow('GF1', '跨店人'), rosterRow('GF9', '閒人甲'), rosterRow('GF8', '建丙')],
    mztjs: [rosterRow('JS1', '建乙'), rosterRow('JS2', '跨店 人'), rosterRow('JS3', '閒人甲'), rosterRow('JS4', '建同名'), rosterRow('JS5', '建丁'), rosterRow('JS6', '建丁')],
    mztgf: [rosterRow('GFX1', '建甲'), rosterRow('GFX2', '建乙', { active: false })],
    hq: [rosterRow('HQ1', '跨店人')],
    mztlzl: [], cf: []
  };
  const ap = sb.clockMapBuildApply_(rosters, nowT(0));
  ok(ap.ok, 'B6 clockMapBuildApply_ 成功', ap);
  ok(sheets.staff._rows().length === staffBefore, 'B6 ★DZY 找不到的人只進候選清單，不建 staff');
  const sg = maps(app);
  ok(sg.every((m) => m.state === 'suggested' && m.source === 'name_match'), 'B6 對得上的一律先是 suggested（不生效）', sg);
  const mine = (n) => sg.filter((m) => m.emp_no === E(n)).map((m) => m.store_code + ':' + m.emp_id + ':' + m.role).sort().join();
  ok(mine('建甲') === 'mztgf:GFX1:home', 'B6 唯一同名 → suggested，home＝DZY 單位對應那家', mine('建甲'));
  ok(mine('建乙') === 'mztjs:JS1:home', 'B6 停用的名冊列不納入（建乙在光復名冊已停用）', mine('建乙'));
  ok(mine('跨店人') === 'gf:GF1:support,hq:HQ1:home,mztjs:JS2:support', 'B6 ★跨店聚成一個人（空白不同也算同名），比全部 DZY（不限單位）：home＝總部、其他 support', mine('跨店人'));
  const ms = post(sb, 'clockMapList', {}, tok);
  ok(ms.ok && ms.data.candidates.length === 1 && ms.data.candidates[0].name === '閒人甲', 'B6 候選新人：只有 DZY 找不到的「閒人甲」（建丁對得上 DZY 但一人兩號，不算候選）', ms.data.candidates.map((c) => c.name));
  const cJ = ms.data.candidates[0];
  ok(cJ && cJ.entries.length === 2, 'B6 ★候選新人跨店聚成一筆（光復＋金山，不是兩筆）', cJ);
  const need = ms.data.needs_hq;
  ok(need.some((n) => n.kind === 'dup_in_store' && n.name === '建丁'), 'B6 ★一人在同一家有兩個打卡編號 → 需總部處理', need);
  const amb = need.find((n) => n.kind === 'ambiguous' && n.name === '建同名');
  ok(amb && amb.options.length === 2 && amb.entries[0].emp_id === 'JS4', 'B6 ★同名多人（兩位在職）→ 需總部處理，列出候選的 DZY', need);
  ok(!maps(app).some((m) => m.emp_id === 'JS4' || m.emp_id === 'JS5' || m.emp_id === 'JS6'), 'B6 需總部處理的不建任何 suggested 列');
  ok(mine('建丙') === 'gf:GF8:home', 'B6 DZY 沒設單位的人、只在一家名冊在職 → 用打卡資料推斷主店（那一家）', mine('建丙'));

  // 重跑冪等：不重複列、不重設已決定的
  const nBefore = maps(app).length;
  sb.clockMapBuildApply_(rosters, nowT(1));
  ok(maps(app).length === nBefore, 'B6 重跑建對照不重複建列');
})();

// ============================================================
// B6b 決定對照（店長／總部）
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets, tok } = app;
  const mgrGF = claimApprove(app, '決店長甲', 'mgr-a-pw-01', MZT_GF('sm'));
  const mgrJS = claimApprove(app, '決店長乙', 'mgr-b-pw-01', MZT_JS('sm'));
  const x = claimApprove(app, '決同仁甲', 'crew-x-pw-01', MZT_GF('pt'));
  const y = claimApprove(app, '決同仁乙', 'crew-y-pw-01', MZT_JS('pt'));
  const z = claimApprove(app, '決同仁丙', 'crew-z-pw-01', MZT_GF('pt'));
  const sug = (emp, store, eid, role) => giveMap(app, emp, store, eid, role, { state: 'suggested', source: 'name_match', roster_active: 'TRUE' });
  sug(x.emp, 'mztgf', 'GA1', 'home'); sug(x.emp, 'mztjs', 'JA1', 'support'); sug(y.emp, 'mztjs', 'JB1', 'home'); sug(z.emp, 'mztgf', 'GC1', 'home'); sug(z.emp, 'mztgf', 'GC2', 'support');
  const lA = post(sb, 'clockMapList', {}, mgrGF.token);
  ok(lA.ok && lA.data.suggested.map((m) => m.emp_id).sort().join() === 'GA1,GC1,GC2', 'B6 ★店長只看到「自己店那家打卡帳號」的 suggested（別店的 JA1 不在）', lA.data.suggested.map((m) => m.emp_id));
  ok(lA.data.needs_hq.length === 0 && lA.data.candidates.length === 0, 'B6 店長看不到總部專屬清單');
  ok(post(sb, 'clockMapList', {}, tok).data.suggested.length === 5, 'B6 總部看全部');
  ok(post(sb, 'clockMapList', {}, x.token).code === 'no_perm', 'B6 一般同仁不能看對照');

  ok(post(sb, 'clockMapDecide', { store_code: 'mztjs', emp_id: 'JB1', decision: 'confirm' }, mgrGF.token).code === 'no_perm', 'B6 ★店長不能決定別單位的人');
  ok(post(sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'GA1', decision: 'confirm', emp_no: y.emp }, mgrGF.token).code === 'no_perm', 'B6 ★店長不能改指給別人（只有總部可以指定）');
  const c1 = post(sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'GA1', decision: 'confirm' }, mgrGF.token);
  const row = () => maps(app).find((m) => m.store_code === 'mztgf' && m.emp_id === 'GA1');
  ok(c1.ok && row().state === 'confirmed' && row().confirmed_by === mgrGF.emp && row().confirmed_at !== '', 'B6 店長按「對」→ confirmed（記誰、何時）', row());
  ok(post(sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'GA1', decision: 'confirm' }, mgrGF.token).code === 'dead_state', 'B6 已經不是 suggested 的店長不能再動');
  // 同人同店只能一個 confirmed
  ok(post(sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'GC1', decision: 'confirm' }, mgrGF.token).ok, 'B6 丙的第一個編號確認');
  const dc = post(sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'GC2', decision: 'confirm' }, mgrGF.token);
  ok(dc.ok === false && dc.code === 'dup_confirmed' && maps(app).find((m) => m.emp_id === 'GC2').state === 'suggested', 'B6 ★同一個 DZY 在同一家只能有一個 confirmed 打卡編號', dc);
  // 店長按「不對」→ 轉總部
  const rj = post(sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'GC2', decision: 'reject' }, mgrGF.token);
  ok(rj.ok && rj.data.escalated === true && maps(app).find((m) => m.emp_id === 'GC2').state === 'rejected', 'B6 店長按「不對」→ rejected 並轉總部', rj);
  const need = post(sb, 'clockMapList', {}, tok).data.needs_hq;
  ok(need.some((n) => n.kind === 'escalated' && n.entries[0].emp_id === 'GC2'), 'B6 總部的「需處理」清單看得到轉來的', need);
  // 總部直接指定
  const asg = post(sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'GC2', decision: 'confirm', emp_no: y.emp, role: 'support' }, tok);
  ok(asg.ok && maps(app).find((m) => m.emp_id === 'GC2').emp_no === y.emp && maps(app).find((m) => m.emp_id === 'GC2').state === 'confirmed', 'B6 ★總部可直接指定（把轉來的指給正確的人）', asg);
  ok(post(sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'GC2', decision: 'confirm', emp_no: 'DZY998' }, tok).code === 'not_found', 'B6 指定不存在的人');
  // 同一個人只有一個主店
  const homeTwo = post(sb, 'clockMapDecide', { store_code: 'mztjs', emp_id: 'JA1', decision: 'confirm', role: 'home' }, tok);
  ok(homeTwo.code === 'home_exists', 'B6 一個人只能有一個主店', homeTwo);
  ok(post(sb, 'clockMapDecide', { store_code: 'mztjs', emp_id: 'JA1', decision: 'confirm' }, mgrGF.token).code === 'no_perm', 'B6 ★別店那家打卡帳號的對照，光復店長不能決定');
  ok(post(sb, 'clockMapDecide', { store_code: 'mztjs', emp_id: 'JA1', decision: 'confirm' }, mgrJS.token).ok, 'B6 金山店長可以確認自己店那家的對照');
  // staff_log
  const lg = sheets.staff_log._rows().filter((r) => r[2].indexOf('map_') === 0).map((r) => r.join('|')).join('\n');
  ok(lg.indexOf('map_confirm') !== -1 && lg.indexOf('map_reject') !== -1, 'B6 決定寫 staff_log（誰、何時、哪列）');
  ok(sheets.staff_log._rows().filter((r) => r[2] === 'map_confirm').every((r) => r[3] && r[4].indexOf('決') === -1), 'B6 staff_log 不含姓名');
  // 候選新人：建立與排除
  const ms = { candidates: [{ key: 'gf:CA1', name: '候選甲', entries: [{ store_code: 'gf', emp_id: 'CA1' }, { store_code: 'mztgf', emp_id: 'CA2' }] }, { key: 'mztjs:CB1', name: 'TEST測試', entries: [{ store_code: 'mztjs', emp_id: 'CB1' }] }], needs_hq: [], excluded: [], built_at: '' };
  app.props.CLOCK_MAP_STATE = JSON.stringify(ms);
  ok(post(sb, 'clockCandidateCreate', { candidate_key: 'gf:CA1', unit: 'mala-gf', title: 'pt' }, mgrGF.token).code === 'no_perm', 'B6 店長不能建立候選新人');
  const staffN = sheets.staff._rows().length;
  const cc = post(sb, 'clockCandidateCreate', { candidate_key: 'gf:CA1', unit: 'mala-gf', title: 'pt', hire_date: dayT(-30) }, tok);
  ok(cc.ok && sheets.staff._rows().length === staffN + 1 && staffOf(app, cc.data.emp_no).name === '候選甲' && staffOf(app, cc.data.emp_no).unit === 'mala-gf', 'B6 ★總部確認是真人後按「建立」才補 DZY', cc);
  ok(mapOf(app, cc.data.emp_no).map((m) => m.store_code + ':' + m.role + ':' + m.state).sort().join() === 'gf:home:confirmed,mztgf:support:confirmed', 'B6 候選建立後各店對照 confirmed、home＝單位對應店', mapOf(app, cc.data.emp_no));
  ok(jobs(app).filter((j) => j.emp_no === cc.data.emp_no).length === 0, 'B6 候選建立不寫 add 單（打卡上已經有人）');
  const dm = post(sb, 'clockCandidateDismiss', { candidate_key: 'mztjs:CB1' }, tok);
  ok(dm.ok && JSON.parse(app.props.CLOCK_MAP_STATE).excluded.indexOf('mztjs:CB1') !== -1, 'B6 排除候選（TEST、錯字）');
  sb.clockMapBuildApply_({ mztjs: [rosterRow('CB1', 'TEST測試')] }, nowT(0));
  ok(JSON.parse(app.props.CLOCK_MAP_STATE).candidates.length === 0, 'B6 重建後被排除的不再出現');
})();

// ============================================================
// B7 clockDailyApply_ ＋ B7b 送前重驗
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets, tok } = app;
  const mgr = claimApprove(app, '日店長', 'mgr-a-pw-01', MZT_GF('sm'));
  const lv = claimApprove(app, '日離職者', 'crew-l-pw-01', MZT_GF('pt'));
  const stay = claimApprove(app, '日留任者', 'crew-s-pw-01', MZT_GF('pt'));
  giveMap(app, lv.emp, 'mztgf', 'L1', 'home'); giveMap(app, lv.emp, 'mztjs', 'L2', 'support');
  giveMap(app, lv.emp, 'gf', 'L3', 'support', { state: 'suggested', source: 'name_match' });
  giveMap(app, stay.emp, 'mztgf', 'S1', 'home');
  const today = dayT(0), tomorrow = dayT(1);
  post(sb, 'staffLeave', { emp_no: lv.emp, last_day: dayT(-1) }, tok);
  post(sb, 'staffLeave', { emp_no: stay.emp, last_day: today }, tok);

  const lvOldTok = lv.token;
  const d1 = sb.clockDailyApply_(today);
  ok(d1.ok && d1.data.disabled.join() === lv.emp, 'B7 ★last_day＜今天且在職 → 停用（last_day＝今天的還在）', d1);
  ok(staffOf(app, lv.emp).status === 'disabled' && sheets.users._rows().find((u) => u[1] === lv.emp)[7] === 'FALSE', 'B7 staff 停用、帳號停用（沿用第一期 disable）');
  ok(post(sb, 'me', {}, lvOldTok).ok === false, 'B7 寫了 token_after：舊 token 失效（登出）');
  const dj = jobs(app).filter((j) => j.kind === 'deactivate');
  ok(dj.length === 2 && dj.map((j) => j.store_code + ':' + j.emp_id).sort().join() === 'mztgf:L1,mztjs:L2' && dj.every((j) => j.state === 'pending' && j.emp_no === lv.emp), 'B7 ★同一支呼叫：每個 confirmed 對照各一張 deactivate 單（suggested 不發）', dj);
  ok(JSON.parse(dj[0].expect_json).map === dj[0].store_code + ':' + dj[0].emp_id && JSON.parse(dj[0].expect_json).state === 'confirmed', 'B7 expect_json 記了對照快照', dj[0].expect_json);
  ok(staffOf(app, stay.emp).status === 'active', 'B7 last_day＝今天的人當天不停用');
  // 跑兩次不重複
  const d2 = sb.clockDailyApply_(today);
  ok(jobs(app).filter((j) => j.kind === 'deactivate').length === 2 && d2.data.disabled.length === 0 && d2.data.reconcile_jobs.length === 0, 'B7 ★跑兩次不重複發單', d2);
  // 明天 → 留任者（其實今天最後一天）也停用
  const d3 = sb.clockDailyApply_(tomorrow);
  ok(d3.data.disabled.join() === stay.emp && jobs(app).filter((j) => j.emp_no === stay.emp && j.kind === 'deactivate').length === 1, 'B7 隔天跑：last_day 過了才停用');

  // 對帳：DZY 已停用但對照店仍在職 → 自動補單
  const app2 = fresh();
  const mgr2 = claimApprove(app2, '帳店長', 'mgr-a-pw-01', MZT_GF('sm'));
  const w = claimApprove(app2, '帳同仁', 'crew-w-pw-01', MZT_GF('pt'));
  giveMap(app2, w.emp, 'mztgf', 'W1', 'home'); giveMap(app2, w.emp, 'mztjs', 'W2', 'support', { roster_active: 'FALSE' });
  setStaff(app2, w.emp, 'status', 'disabled');      // 模擬舊流程停用過、當時沒發單（G8 後按鈕會自己發單，這裡驗每日對帳的補單）
  const e1 = app2.sb.clockDailyApply_(today);
  const rj = jobs(app2).filter((j) => j.kind === 'deactivate');
  ok(e1.data.reconcile_jobs.length === 1 && rj.length === 1 && rj[0].store_code === 'mztgf', 'B7 ★DZY 已停用但對照店名冊仍在職 → 自動補 deactivate 單（名冊已停用的店不補）', e1);
  ok(app2.sb.clockDailyApply_(today).data.reconcile_jobs.length === 0 && jobs(app2).filter((j) => j.kind === 'deactivate').length === 1, 'B7 對帳跑兩次不重複');
  ok(post(app2.sb, 'clockAlerts', {}, app2.tok).data.left_but_active.some((x) => x.emp_no === w.emp && x.store_code === 'mztgf'), 'B7 alerts：DZY 已離職但某家打卡仍在職');
  // 單做完 → roster_active FALSE；名冊又顯示在職 → 隔天再補，但同一天不補
  app2.sb.clockOutboxClaim_(nowT(1));
  app2.sb.clockOutboxDone_(rj[0].job_id, { ok: true }, nowT(2));
  ok(maps(app2).find((m) => m.emp_id === 'W1').roster_active === 'FALSE', 'B7 deactivate 成功 → roster_active 立刻 FALSE');
  app2.sb.clockRosterApply_('mztgf', [rosterRow('W1', '帳同仁')], undefined, nowT(3));
  const doneDay = nowT(5).slice(0, 10);
  // 「隔天」要以停用完成那天為準：23:58 之後跑時 nowT(2) 已跨到明天，用 dayT(1) 會跟完成日同一天（測試在午夜邊界會紅）
  const nextDay = new Date(Date.parse(doneDay + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  ok(app2.sb.clockDailyApply_(doneDay).data.reconcile_jobs.length === 0, 'B7 今天剛停用完成、名冊還沒反應 → 同一天不重複補');
  ok(app2.sb.clockDailyApply_(nextDay).data.reconcile_jobs.length === 1, 'B7 隔天名冊仍在職 → 再補一張');

  // 異常：打卡單位在職者沒有 home 對照、也沒有有效待辦
  const app3 = fresh();
  const m3 = claimApprove(app3, '異店長', 'mgr-a-pw-01', MZT_GF('sm'));
  const n1 = claimApprove(app3, '異同仁甲', 'crew-a-pw-01', MZT_GF('pt'));
  const n2 = claimApprove(app3, '異同仁乙', 'crew-b-pw-01', MZT_GF('pt'));
  const n3 = claimApprove(app3, '異美村同仁', 'crew-c-pw-01', { brand: 'yiwu', unit: 'yiwu-wx', title: 'pt' });
  giveMap(app3, n1.emp, 'mztgf', 'N1', 'home');
  const c = post(app3.sb, 'staffCreateByUnit', { name: '異新人', title: 'pt', hire_date: dayT(0), phone: '0944000111' }, m3.token);
  const e3 = app3.sb.clockDailyApply_(today);
  ok(e3.data.no_home_map.join() === [m3.emp, n2.emp].join(), 'B7 ★在職者沒有 home 對照也沒有有效待辦 → 異常（有 add 單的新人、美村無打卡的不算）', e3.data.no_home_map);
  const al = post(app3.sb, 'clockAlerts', {}, app3.tok);
  ok(al.data.counts.no_home_map === 2, 'B7 alerts 也有這一類');
  // 店長 alerts 只含自己單位
  ok(post(app3.sb, 'clockAlerts', {}, m3.token).ok, 'B7 店長看得到自己單位的 alerts');
})();

// ============================================================
// B7b 送出前重驗（expect_json）＋ cancelled
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets, tok } = app;
  const mgr = claimApprove(app, '驗店長', 'mgr-a-pw-01', MZT_GF('sm'));
  const w = claimApprove(app, '驗同仁甲', 'crew-w-pw-01', MZT_GF('pt'));
  const v = claimApprove(app, '驗同仁乙', 'crew-v-pw-01', MZT_GF('pt'));
  giveMap(app, w.emp, 'mztgf', 'W1', 'home'); giveMap(app, v.emp, 'mztgf', 'V1', 'home');
  post(sb, 'staffLeave', { emp_no: w.emp, last_day: dayT(-1) }, tok);
  post(sb, 'staffLeave', { emp_no: v.emp, last_day: dayT(-1) }, tok);
  sb.clockDailyApply_(dayT(0));
  const jw = jobs(app).find((j) => j.kind === 'deactivate' && j.emp_no === w.emp);
  const jv = jobs(app).find((j) => j.kind === 'deactivate' && j.emp_no === v.emp);
  // w：對照被總部改成別人（更正）；v：總部把人復職
  const fix = post(sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'W1', decision: 'confirm', emp_no: mgr.emp }, tok);
  ok(fix.ok, 'B7b （總部更正對照：W1 其實是別人）', fix);
  const cl = sb.clockOutboxClaim_(nowT(1));
  ok(cl.data.cancelled.indexOf(jw.job_id) !== -1 && !cl.data.jobs.some((j) => j.job_id === jw.job_id), 'B7b ★對照被改正後，舊 deactivate 單送前被取消、不打打卡', cl);
  ok(jobs(app).find((j) => j.job_id === jw.job_id).state === 'cancelled' && jobs(app).find((j) => j.job_id === jw.job_id).last_error !== '', 'B7b 單轉 cancelled、寫原因');
  ok(cl.data.jobs.some((j) => j.job_id === jv.job_id), 'B7b 對照沒變的單照送');
  // v 的單已 running；另開情境：復職後舊單
  const app2 = fresh();
  const w2 = claimApprove(app2, '驗復甲', 'crew-w-pw-01', MZT_GF('pt'));
  giveMap(app2, w2.emp, 'mztgf', 'R1', 'home');
  post(app2.sb, 'staffLeave', { emp_no: w2.emp, last_day: dayT(-1) }, app2.tok);
  app2.sb.clockDailyApply_(dayT(0));
  const rr = post(app2.sb, 'staffReinstate', { emp_no: w2.emp, stores: [] }, app2.tok);
  ok(rr.ok, 'B7b （總部復職，不勾任何店）', rr);
  const cl2 = app2.sb.clockOutboxClaim_(nowT(1));
  ok(cl2.data.jobs.length === 0 && cl2.data.cancelled.length === 1, 'B7b ★人已復職 → 還沒送的 deactivate 單取消', cl2);
  // add 單：人在排隊期間被停用 → 取消；改名 → 用新名字建
  const app3 = fresh();
  const m3 = claimApprove(app3, '驗新店長', 'mgr-a-pw-01', MZT_GF('sm'));
  const c1 = post(app3.sb, 'staffCreateByUnit', { name: '驗新人一', title: 'pt', hire_date: dayT(0), phone: '0955000111' }, m3.token);
  const c2 = post(app3.sb, 'staffCreateByUnit', { name: '驗新人二', title: 'pt', hire_date: dayT(0), phone: '0955000112' }, m3.token);
  post(app3.sb, 'staffSetActive', { emp_no: c1.data.emp_no, active: false }, app3.tok);
  post(app3.sb, 'staffRename', { emp_no: c2.data.emp_no, name: '驗新人二改' }, app3.tok);
  const cl3 = app3.sb.clockOutboxClaim_(nowT(1));
  ok(cl3.data.cancelled.indexOf(c1.data.job_id) !== -1, 'B7b 新增後被停用的人，add 單送前取消', cl3);
  ok(cl3.data.jobs.length === 1 && cl3.data.jobs[0].job_id === c2.data.job_id && cl3.data.jobs[0].name === '驗新人二改', 'B7b 排隊期間改名 → 用新姓名建', cl3);
  // 已經有主店對照 → add 單取消
  const app4 = fresh();
  const m4 = claimApprove(app4, '驗店長四', 'mgr-a-pw-01', MZT_GF('sm'));
  const c4 = post(app4.sb, 'staffCreateByUnit', { name: '驗新人四', title: 'pt', hire_date: dayT(0), phone: '0955000114' }, m4.token);
  giveMap(app4, c4.data.emp_no, 'mztgf', 'Q1', 'home');
  ok(app4.sb.clockOutboxClaim_(nowT(1)).data.cancelled.indexOf(c4.data.job_id) !== -1, 'B7b 已經有生效主店對照 → add 單取消（不重複建）');
})();

// ============================================================
// B8 clockLink＋svcDirectory＋clockAlerts
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets, cache, props, tok } = app;
  const mgrGF = claimApprove(app, '連店長甲', 'mgr-a-pw-01', MZT_GF('sm'));
  const mgrJS = claimApprove(app, '連店長乙', 'mgr-b-pw-01', MZT_JS('sm'));
  const x = claimApprove(app, '連同仁甲', 'crew-x-pw-01', MZT_GF('pt'));
  const nm = claimApprove(app, '連無對照', 'crew-n-pw-01', MZT_GF('pt'));
  giveMap(app, x.emp, 'mztgf', 'LX1', 'home');
  giveMap(app, x.emp, 'mztjs', 'LX2', 'support');
  giveMap(app, mgrGF.emp, 'mztgf', 'LM1', 'home');
  giveMap(app, nm.emp, 'mztgf', 'LS1', 'home', { state: 'suggested', source: 'name_match' });
  giveMap(app, nm.emp, 'gf', 'LS2', 'support', { state: 'rejected', source: 'name_match' });

  ok(post(sb, 'clockLink', { emp_no: x.emp }, mgrJS.token).code === 'no_perm', 'B8 他單位店長不能要打卡連結');
  ok(post(sb, 'clockLink', { emp_no: x.emp }, x.token).code === 'no_perm', 'B8 一般同仁不能');
  ok(post(sb, 'clockLink', { emp_no: nm.emp }, mgrGF.token).code === 'no_map', 'B8 沒有 confirmed 對照（suggested／rejected 不算）→ 不能要');
  const lk = post(sb, 'clockLink', { emp_no: x.emp }, mgrGF.token);
  ok(lk.ok && /^J\d{14}-[0-9a-f]{4}$/.test(lk.data.job_id), 'B8 店長要連結 → 寫一張 kind=link 單', lk);
  const lj = jobs(app).find((j) => j.job_id === lk.data.job_id);
  ok(lj.kind === 'link' && lj.store_code === 'mztgf' && lj.emp_id === 'LX1' && lj.state === 'pending', 'B8 link 單預設主店、帶 emp_id', lj);
  const st0 = post(sb, 'clockJobStatus', { job_id: lk.data.job_id }, mgrGF.token);
  ok(st0.ok && st0.data.state === 'pending' && !('link_key' in st0.data), 'B8 還沒做完：沒有金鑰');
  sb.clockOutboxClaim_(nowT(1));
  const dn = sb.clockOutboxDone_(lk.data.job_id, { ok: true, link_key: FAKE_LINK_KEY }, nowT(2));
  ok(dn.ok && dn.data.state === 'done', 'B8 同步員回填 link 成功', dn);
  ok(allCellText(app).indexOf(FAKE_LINK_KEY) === -1, 'B8 ★金鑰在任何分頁（含 clock_outbox、staff_log、Script Properties）都找不到');
  const entry = cache.get('clk_link_' + lk.data.job_id);
  ok(entry && entry.v === FAKE_LINK_KEY && entry.exp - Date.now() <= 120000 && entry.exp - Date.now() > 100000, 'B8 ★金鑰只在 CacheService、TTL 120 秒', entry && entry.exp - Date.now());
  const hqPeek = post(sb, 'clockJobStatus', { job_id: lk.data.job_id }, tok);
  ok(hqPeek.ok && !('link_key' in hqPeek.data) && cache.get('clk_link_' + lk.data.job_id), 'B8 ★只有當初要連結的人拿得到金鑰；別人（含總部）查狀態不會把它取走');
  const got = post(sb, 'clockJobStatus', { job_id: lk.data.job_id }, mgrGF.token);
  ok(got.ok && got.data.link_key === FAKE_LINK_KEY, 'B8 ★要連結的人取到金鑰', got);
  ok(!cache.get('clk_link_' + lk.data.job_id), 'B8 ★取一次即刪');
  const again = post(sb, 'clockJobStatus', { job_id: lk.data.job_id }, mgrGF.token);
  ok(again.ok && !('link_key' in again.data) && again.data.link_expired === true, 'B8 第二次取不到（link_expired）');
  ok(allCellText(app).indexOf(FAKE_LINK_KEY) === -1, 'B8 取完後任何分頁仍找不到金鑰');
  // 指定支援店
  const lk2 = post(sb, 'clockLink', { emp_no: x.emp, store_code: 'mztjs' }, tok);
  ok(lk2.ok && jobs(app).find((j) => j.job_id === lk2.data.job_id).emp_id === 'LX2', 'B8 總部可指定要哪一家的連結');
  // link 失敗不寫金鑰
  sb.clockOutboxClaim_(nowT(1));
  sb.clockOutboxDone_(lk2.data.job_id, { ok: false, error: 'network' }, nowT(2));
  ok(jobs(app).find((j) => j.job_id === lk2.data.job_id).state === 'pending', 'B8 link 失敗照一般重試');
  // 沒給金鑰的成功 → failed
  sb.clockOutboxClaim_(nowT(10));
  sb.clockOutboxDone_(lk2.data.job_id, { ok: true }, nowT(11));
  ok(jobs(app).find((j) => j.job_id === lk2.data.job_id).state === 'failed', 'B8 link 成功卻沒金鑰 → failed');

  // svcDirectory
  const dirReq = (p) => post(sb, 'svcDirectory', p);
  ok(dirReq({}).code === 'unauthorized', 'B8 ★svcDirectory：Script Property 沒設 BULLETIN_SVC_KEY → 全拒');
  props.BULLETIN_SVC_KEY = 'fake-bulletin-key-0001';
  ok(dirReq({ svc_key: 'wrong' }).code === 'unauthorized' && dirReq({}).code === 'unauthorized' && dirReq({ svc_key: '' }).code === 'unauthorized', 'B8 錯金鑰、沒金鑰 → unauthorized');
  ok(post(sb, 'svcDirectory', { svc_key: 'fake-bulletin-key-0001' }, tok).ok && dirReq({ svc_key: 'fake-bulletin-key-0001' }).ok, 'B8 不靠登入 token：有金鑰就行');
  const dir = dirReq({ svc_key: 'fake-bulletin-key-0001' });
  const px = dir.data.find((p) => p.emp_no === x.emp);
  ok(Array.isArray(dir.data) && px.name === '連同仁甲' && px.unit === 'mzt-gf' && px.active === true && px.clocks.map((c) => c.store_code + ':' + c.emp_id + ':' + c.role).sort().join() === 'mztgf:LX1:home,mztjs:LX2:support', 'B8 ★回 [{emp_no,name,unit,active,clocks:[{store_code,emp_id,role}]}]', px);
  ok(dir.data.find((p) => p.emp_no === nm.emp).clocks.length === 0, 'B8 ★只含 confirmed 對照（suggested／rejected 不給）');
  ok(px.title === 'pt' && dir.data.find((p) => p.emp_no === mgrGF.emp).title === 'sm', 'B8 ★回職稱代碼 title（佈告欄依職稱決定看得到哪些品牌，2026-10-25）', px);
  const dirText = JSON.stringify(dir);
  ok(dirText.indexOf('0911222333') === -1 && dirText.indexOf('1995-05-05') === -1 && dirText.indexOf('測試路') === -1 && !/phone|birthday|address|password|hash|salt/.test(dirText), 'B8 ★svcDirectory 無手機、生日、地址（欄位與值都沒有）');
  post(sb, 'staffSetActive', { emp_no: x.emp, active: false }, tok);
  ok(dirReq({ svc_key: 'fake-bulletin-key-0001' }).data.find((p) => p.emp_no === x.emp).active === false, 'B8 停用的人 active＝false');
  ok(post(sb, 'svcDirectory', { svc_key: ['fake-bulletin-key-0001'] }).code === 'unauthorized', 'B8 金鑰型別不對也拒');

  // alerts 四類（總部）
  const app2 = fresh();
  const m2 = claimApprove(app2, '警店長', 'mgr-a-pw-01', MZT_GF('sm'));
  const p1 = claimApprove(app2, '警同仁一', 'crew-1-pw-01', MZT_GF('pt'));
  giveMap(app2, p1.emp, 'mztgf', 'AL1', 'home');
  giveMap(app2, p1.emp, 'mztjs', 'AL2', 'support', { state: 'suggested', source: 'name_match', roster_active: '' });
  const cr = post(app2.sb, 'staffCreateByUnit', { name: '警新人', title: 'pt', hire_date: dayT(0), phone: '0966000111' }, m2.token);
  app2.sb.clockOutboxClaim_(nowT(1));
  app2.sb.clockOutboxDone_(cr.data.job_id, { ok: false, error: 'bad_input', message: 'x' }, nowT(2));    // failed → 打卡未建
  app2.sb.clockRosterApply_('mztgf', [rosterRow('AL1', '警同仁一'), rosterRow('ZZ9', '不明人')], undefined, nowT(3));   // 打卡上有、沒對照
  post(app2.sb, 'staffSetActive', { emp_no: p1.emp, active: false }, app2.tok);                           // 已離職但打卡仍在職
  const al = post(app2.sb, 'clockAlerts', {}, app2.tok);
  ok(al.ok && al.data.outbox_failed.length === 1 && al.data.unmapped.length === 1 && al.data.left_but_active.length === 1 && al.data.pending_confirm.count === 1, 'B8 ★alerts 四類：打卡未建、打卡上有沒對照、DZY 已離職打卡仍在職、待確認對照數', al.data.counts);
  ok(al.data.last_sync.mztgf, 'B8 alerts 帶每店最後同步時間');
  const alM = post(app2.sb, 'clockAlerts', {}, m2.token);
  ok(alM.ok && alM.data.unmapped.length === 0 && alM.data.outbox_failed.length === 1, 'B8 店長只看自己單位的（沒有「打卡上有沒對照」那類）', alM.data.counts);
  ok(post(app2.sb, 'clockAlerts', {}, p1.token).ok === false, 'B8 一般同仁看不到 alerts');
})();

// ============================================================
// B10 改名、調店、復職（spec §4.8）
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets, tok } = app;
  const mgr = claimApprove(app, '改店長', 'mgr-a-pw-01', MZT_GF('sm'));
  const x = claimApprove(app, '改名者', 'crew-x-pw-01', MZT_GF('pt'));
  const other = claimApprove(app, '改名衝突', 'crew-y-pw-01', MZT_GF('pt'));
  giveMap(app, x.emp, 'mztgf', 'R1', 'home'); giveMap(app, x.emp, 'mztjs', 'R2', 'support');
  // 改名
  ok(post(sb, 'staffRename', { emp_no: x.emp, name: '改名後' }, mgr.token).code === 'no_perm', 'B10 ★已有對照的人，店長不能改姓名（只有總部）');
  ok(post(sb, 'staffRename', { emp_no: x.emp, name: '改名衝突' }, tok).code === 'duplicate_name', 'B10 改名不能和同單位在職的人重名');
  ok(post(sb, 'staffRename', { emp_no: x.emp, name: '改名者' }, tok).code === 'no_change', 'B10 沒變不處理');
  const rn = post(sb, 'staffRename', { emp_no: x.emp, name: '改名後' }, tok);
  ok(rn.ok && rn.data.clock_stores_to_fix.sort().join() === 'mztgf,mztjs' && staffOf(app, x.emp).name === '改名後' && sheets.users._rows().find((u) => u[1] === x.emp)[2] === '改名後', 'B10 總部改名：staff 與 users 都改、回要在打卡端改的店', rn);
  const al = post(sb, 'clockAlerts', {}, tok);
  ok(al.data.name_diff.length === 2 && al.data.counts.name_diff === 2, 'B10 ★改完首頁出現「打卡名冊姓名不同（N 家）」', al.data.name_diff);
  sb.clockRosterApply_('mztgf', [rosterRow('R1', '改名後')], undefined, nowT(1));
  ok(post(sb, 'clockAlerts', {}, tok).data.name_diff.length === 1, 'B10 打卡端改成一致後，下次同步該店異常消失（另一家還在）');
  sb.clockRosterApply_('mztjs', [rosterRow('R2', '改名後')], undefined, nowT(1));
  ok(post(sb, 'clockAlerts', {}, tok).data.name_diff.length === 0, 'B10 兩家都一致 → 清空');

  // 調店：第一期「改單位 → 待確認」→ 確認時新單位有打卡 → 開新店 add（home）、舊 home 改 support 並問總部
  const t = claimApprove(app, '調店者', 'crew-t-pw-01', MZT_GF('pt'));
  giveMap(app, t.emp, 'mztgf', 'T1', 'home');
  const ti = sheets.staff._data.findIndex((r) => r[0] === t.emp);
  const head = sheets.staff._data[0];
  const setP = (idx, h, v) => { sheets.staff._data[idx][head.indexOf(h)] = v; };
  setP(ti, 'p_brand', 'mzt'); setP(ti, 'p_unit', 'mzt-js'); setP(ti, 'p_dept', ''); setP(ti, 'p_title', 'pt');
  const cf = post(sb, 'staffConfirm', { emp_no: t.emp }, tok);
  ok(cf.ok && staffOf(app, t.emp).unit === 'mzt-js', 'B10 （第一期確認改單位）', cf);
  const aj = jobs(app).filter((j) => j.kind === 'add' && j.emp_no === t.emp);
  ok(aj.length === 1 && aj[0].store_code === 'mztjs' && aj[0].state === 'pending' && JSON.parse(aj[0].expect_json).demote_old === true, 'B10 ★調店確認 → 新單位開一張 add 單（home）', aj);
  sb.clockOutboxClaim_(nowT(1));
  sb.clockOutboxDone_(aj[0].job_id, { ok: true, emp_id: 'T9' }, nowT(2));
  const tm = mapOf(app, t.emp).map((m) => m.store_code + ':' + m.emp_id + ':' + m.role).sort().join();
  ok(tm === 'mztgf:T1:support,mztjs:T9:home', 'B10 ★add 成功：新店 home、舊 home 改 support', tm);
  const al2 = post(sb, 'clockAlerts', {}, tok);
  ok(al2.data.transfer_ask.length === 1 && al2.data.transfer_ask[0].store_code === 'mztgf', 'B10 ★問總部要不要停用舊店（alerts transfer_ask）', al2.data.transfer_ask);
  ok(post(sb, 'clockOldHomeDecide', { emp_no: t.emp, store_code: 'mztgf', deactivate: true }, mgr.token).code === 'no_perm', 'B10 店長不能決定');
  const dec = post(sb, 'clockOldHomeDecide', { emp_no: t.emp, store_code: 'mztgf', deactivate: true }, tok);
  ok(dec.ok && dec.data.job_id, 'B10 總部決定停用舊店 → 發 deactivate 單', dec);
  const cl = sb.clockOutboxClaim_(nowT(3));
  ok(cl.data.jobs.some((j) => j.job_id === dec.data.job_id), 'B10 舊店停用單的人沒離職也能送（expect 標了 staff＝active）', cl);
  sb.clockOutboxDone_(dec.data.job_id, { ok: true }, nowT(4));
  const old = maps(app).find((m) => m.emp_id === 'T1');
  ok(old.roster_active === 'FALSE' && old.state === 'rejected', 'B10 舊店停用完成 → roster_active FALSE、對照標 rejected（佈告欄不再列）');
  ok(post(sb, 'clockAlerts', {}, tok).data.transfer_ask.length === 0, 'B10 決定後從待決定清單移除');
  // 新單位已有 confirmed 支援對照 → 直接升主店
  const t2 = claimApprove(app, '調店二', 'crew-t2-pw-01', MZT_GF('pt'));
  giveMap(app, t2.emp, 'mztgf', 'U1', 'home'); giveMap(app, t2.emp, 'mztjs', 'U2', 'support');
  const ti2 = sheets.staff._data.findIndex((r) => r[0] === t2.emp);
  setP(ti2, 'p_brand', 'mzt'); setP(ti2, 'p_unit', 'mzt-js'); setP(ti2, 'p_title', 'pt');
  post(sb, 'staffConfirm', { emp_no: t2.emp }, tok);
  ok(mapOf(app, t2.emp).map((m) => m.emp_id + ':' + m.role).sort().join() === 'U1:support,U2:home' && jobs(app).filter((j) => j.emp_no === t2.emp).length === 0, 'B10 新單位本來就有支援對照 → 直接升主店、舊主店降支援，不開新單');
  // 第一次認領把單位從空填成某單位 ≠ 調店
  const jobsBefore = jobs(app).length;
  claimApprove(app, '首次認領', 'crew-f-pw-01', MZT_GF('pt'));
  ok(jobs(app).length === jobsBefore, 'B10 ★首次認領填單位不算調店，不開 add 單（避免重複建人）');

  // 復職
  const r = claimApprove(app, '復職者', 'crew-r-pw-01', MZT_GF('pt'));
  giveMap(app, r.emp, 'mztgf', 'V1', 'home'); giveMap(app, r.emp, 'mztjs', 'V2', 'support'); giveMap(app, r.emp, 'gf', 'V3', 'support', { state: 'rejected' });
  post(sb, 'staffLeave', { emp_no: r.emp, last_day: dayT(-1) }, tok);
  ok(post(sb, 'staffReinstate', { emp_no: r.emp, preview: true }, tok).code === 'not_disabled', 'B10 沒停用的人不用復職');
  sb.clockDailyApply_(dayT(0));
  ok(staffOf(app, r.emp).status === 'disabled', 'B10 （已離職停用）');
  ok(post(sb, 'staffReinstate', { emp_no: r.emp, preview: true }, mgr.token).code === 'no_perm', 'B10 復職只有總部');
  const pv = post(sb, 'staffReinstate', { emp_no: r.emp, preview: true }, tok);
  ok(pv.ok && pv.data.maps.map((m) => m.store_code).sort().join() === 'mztgf,mztjs' && staffOf(app, r.emp).status === 'disabled', 'B10 ★復職預覽：列出他過去 confirmed 的對照（不含 rejected），不改任何東西', pv);
  ok(post(sb, 'staffReinstate', { emp_no: r.emp, stores: ['gf'] }, tok).code === 'no_map', 'B10 勾了沒有的店 → 拒絕');
  const ri = post(sb, 'staffReinstate', { emp_no: r.emp, stores: ['mztgf'] }, tok);
  ok(ri.ok && ri.data.job_ids.length === 1, 'B10 ★勾哪幾家就發幾張 reactivate 單', ri);
  ok(staffOf(app, r.emp).status !== 'disabled' && staffOf(app, r.emp).last_day === '' && sheets.users._rows().find((u) => u[1] === r.emp)[7] === 'TRUE', 'B10 staff 恢復、清 last_day、帳號啟用');
  const rj = jobs(app).find((j) => j.job_id === ri.data.job_ids[0]);
  ok(rj.kind === 'reactivate' && rj.store_code === 'mztgf' && rj.emp_id === 'V1', 'B10 reactivate 單內容');
  // 之前離職連動發的 deactivate 單（V2 那家）還沒送 → 復職後被取消
  const cl2 = sb.clockOutboxClaim_(nowT(5));
  ok(cl2.data.jobs.some((j) => j.kind === 'reactivate') && cl2.data.cancelled.length >= 1, 'B10 復職後，離職時發的 deactivate 單送前被取消；reactivate 單照送', cl2);
  sb.clockOutboxDone_(rj.job_id, { ok: true }, nowT(6));
  ok(maps(app).find((m) => m.emp_id === 'V1').roster_active === 'TRUE', 'B10 reactivate 成功 → roster_active TRUE');
})();

// ============================================================
// 7A：clockAutoSupportCheck_／clockAutoSupportRecord_
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets, tok } = app;
  const a = claimApprove(app, '支援甲', 'crew-a-pw-01', MZT_GF('pt'));
  giveMap(app, a.emp, 'mztgf', 'SA1', 'home');
  const chk = (o) => sb.clockAutoSupportCheck_(Object.assign({ store_code: 'mztjs', src_store: 'mztgf', src_emp_id: 'SA1' }, o || {}));
  const base = chk();
  ok(base.ok && base.data.allowed === true && base.data.emp_no === a.emp && base.data.name === '支援甲', '7A 條件成立 → allowed（回 emp_no、name）', base);
  ok(chk({ src_emp_id: 'NOPE' }).data.reason === 'source_not_confirmed', '7A 來源對照不存在 → 拒');
  setMap(app, 'mztgf', 'SA1', 'state', 'suggested');
  ok(chk().data.reason === 'source_not_confirmed' && chk().data.allowed === false, '7A ★來源對照不是 confirmed → 拒');
  setMap(app, 'mztgf', 'SA1', 'state', 'confirmed');
  ok(chk({ store_code: 'mztgf' }).data.reason === 'same_store', '7A 自己那家不算支援');
  ok(chk({ store_code: 'nope' }).data.reason === 'store_disabled', '7A 不認得的店 → 拒');
  ok(sb.clockAutoSupportCheck_({}).data.reason === 'bad_input', '7A 缺參數 → 拒');
  post(sb, 'staffLeave', { emp_no: a.emp, last_day: dayT(10) }, tok);
  ok(chk().data.reason === 'leave_registered', '7A ★DZY 已登記離職（即使還沒到期）→ 拒');
  post(sb, 'staffLeaveCancel', { emp_no: a.emp }, tok);
  ok(chk().data.allowed === true, '7A 撤銷離職後又可以');
  post(sb, 'staffSetActive', { emp_no: a.emp, active: false }, tok);
  ok(chk().data.reason === 'staff_left', '7A ★DZY 已停用 → 拒');
  post(sb, 'staffSetActive', { emp_no: a.emp, active: true }, tok);
  // B 店有 rejected／停用對照 → 拒
  giveMap(app, a.emp, 'mztjs', 'SB1', 'support', { state: 'rejected', source: 'auto_support' });
  ok(chk().data.reason === 'removed_before', '7A ★B 店有指向他的 rejected 對照 → 不自動加回');
  setMap(app, 'mztjs', 'SB1', 'state', 'confirmed'); setMap(app, 'mztjs', 'SB1', 'roster_active', 'FALSE');
  ok(chk().data.reason === 'removed_before', '7A ★B 店有指向他的停用對照 → 不自動加回');
  setMap(app, 'mztjs', 'SB1', 'roster_active', 'TRUE');
  ok(chk().data.reason === 'already_mapped', '7A B 店已經有生效對照 → 不重複建');
  setMap(app, 'mztjs', 'SB1', 'state', 'suggested');
  ok(chk().data.reason === 'suggested_exists', '7A B 店有待確認對照 → 交給人處理');
  sheets.staff_clock._data.pop();   // 清掉 SB1

  // Record
  const rec = sb.clockAutoSupportRecord_({ store_code: 'mztjs', src_store: 'mztgf', src_emp_id: 'SA1', emp_id: 'SB2' }, nowT(0));
  const mm = maps(app).find((m) => m.store_code === 'mztjs' && m.emp_id === 'SB2');
  ok(rec.ok && mm && mm.emp_no === a.emp && mm.role === 'support' && mm.source === 'auto_support' && mm.state === 'confirmed' && mm.roster_active === 'TRUE' && mm.confirmed_by === 'LINE 自動（首次支援）', '7A ★寫 support／auto_support／confirmed', mm);
  const again = sb.clockAutoSupportRecord_({ store_code: 'mztjs', src_store: 'mztgf', src_emp_id: 'SA1', emp_id: 'SB2' }, nowT(1));
  ok(again.ok && again.data.already === true && maps(app).filter((m) => m.emp_id === 'SB2').length === 1, '7A ★同一組重送冪等，不重複寫');
  const second = sb.clockAutoSupportRecord_({ store_code: 'mztjs', src_store: 'mztgf', src_emp_id: 'SA1', emp_id: 'SB3' }, nowT(1));
  ok(second.ok === false && second.code === 'not_allowed', '7A 已經對照過的人，另一個編號被拒');
  const bad = sb.clockAutoSupportRecord_({ store_code: 'mztjs', src_store: 'mztgf', src_emp_id: 'SA1', emp_id: '壞 編號' }, nowT(1));
  ok(bad.ok === false, '7A 編號格式不對被拒');
  // 寫入前再把關：中間狀態變了
  const app2 = fresh();
  const b = claimApprove(app2, '支援乙', 'crew-b-pw-01', MZT_GF('pt'));
  giveMap(app2, b.emp, 'mztgf', 'TA1', 'home');
  post(app2.sb, 'staffSetActive', { emp_no: b.emp, active: false }, app2.tok);
  ok(app2.sb.clockAutoSupportRecord_({ store_code: 'mztjs', src_store: 'mztgf', src_emp_id: 'TA1', emp_id: 'TB1' }, nowT(0)).code === 'not_allowed' && !maps(app2).some((m) => m.emp_id === 'TB1'), '7A ★檢查到寫入之間 DZY 被停用 → 不寫對照');
  // 7A 寫的對照：首次支援被移除 → rejected → 不再自動加
  sb.clockRosterApply_('mztjs', [rosterRow('SB2', '支援甲', { active: false })], undefined, nowT(2));
  ok(maps(app).find((m) => m.emp_id === 'SB2').state === 'rejected' && chk().data.reason === 'removed_before', '7A 移除後每日同步標 rejected，之後 check 擋掉');
})();

// ============================================================
// B9 Code.gs 分派＋內部函式不進分派表
// ============================================================
(() => {
  const app = fresh();
  const { sb, tok } = app;
  const internals = ['clockOutboxClaim_', 'clockOutboxDone_', 'clockRosterApply_', 'clockDailyApply_', 'clockMapBuildApply_', 'clockAutoSupportCheck_', 'clockAutoSupportRecord_', 'clkAfterConfirm_', 'clkSetup_', 'clockUpperEmps_'];
  const UNKNOWN = '不支援的操作';
  internals.forEach((fn) => {
    const r1 = post(sb, fn, {}, tok);
    const r2 = post(sb, fn.replace(/_$/, ''), {}, tok);
    ok(r1.ok === false && r1.error === UNKNOWN && r2.ok === false && r2.error === UNKNOWN, 'B9 ★內部函式 ' + fn + ' 打 doPost → unknown action（不進分派表）', [r1, r2]);
  });
  ok(typeof sb.clockOutboxClaim_ === 'function' && typeof sb.clockDailyApply_ === 'function', 'B9 內部函式本身可直接呼叫（給 runGas）');
  const src = SRC.find(([f]) => f === 'Code.gs')[1];
  const allowed = /CODE_ALLOWED_ACTIONS = \[([\s\S]*?)\];/.exec(src)[1];
  ok(!/_'/.test(allowed), 'B9 白名單裡沒有任何結尾底線的名字');
  const actions = ['staffCreateByUnit', 'staffLeave', 'staffLeaveCancel', 'staffRename', 'staffReinstate', 'staffUnitList', 'clockMapBuild', 'clockMapList', 'clockMapDecide', 'clockCandidateCreate', 'clockCandidateDismiss', 'clockOutboxRetry', 'clockOldHomeDecide', 'clockLink', 'clockJobStatus', 'clockAlerts', 'svcDirectory'];
  ok(actions.every((a) => allowed.indexOf("'" + a + "'") !== -1), 'B9 ★新 action 都在白名單');
  actions.forEach((a) => {
    const r = post(sb, a, {}, '');
    ok(r.error !== UNKNOWN, 'B9 ' + a + ' 可分派（沒登入不是 unknown action）', r);
  });
  const mut = /MUTATING_ACTIONS = \{([\s\S]*?)\};/.exec(src)[1];
  const writes = ['staffCreateByUnit', 'staffLeave', 'staffLeaveCancel', 'staffRename', 'staffReinstate', 'clockMapBuild', 'clockMapDecide', 'clockCandidateCreate', 'clockCandidateDismiss', 'clockOutboxRetry', 'clockOldHomeDecide', 'clockLink'];
  const reads = ['staffUnitList', 'clockMapList', 'clockJobStatus', 'clockAlerts', 'svcDirectory'];
  ok(writes.every((a) => mut.indexOf(a + ': 1') !== -1) && reads.every((a) => mut.indexOf(a) === -1), 'B9 ★寫入的 action 上全域寫入鎖，唯讀的不上');
  // 既有 action 沒被擠掉
  ok(['login', 'staffList', 'staffImport', 'unitApprove'].every((a) => allowed.indexOf("'" + a + "'") !== -1), 'B9 既有 action 全都還在');

  // staffList 多帶欄位、staffUnitList
  const mgr = claimApprove(app, '單店長甲', 'mgr-a-pw-01', MZT_GF('sm'));
  const p = claimApprove(app, '單同仁', 'crew-a-pw-01', MZT_GF('pt'));
  const q = claimApprove(app, '單他店同仁', 'crew-b-pw-01', MZT_JS('pt'));
  giveMap(app, p.emp, 'mztgf', 'UL1', 'home', { roster_active: 'FALSE' });
  post(sb, 'staffLeave', { emp_no: p.emp, last_day: dayT(4) }, tok);
  const sl = post(sb, 'staffList', {}, tok);
  const sp = sl.data.staff.find((x) => x.emp_no === p.emp);
  ok(sl.ok && sp.last_day === dayT(4) && 'hire_date' in sp && sp.clocks.length === 1 && sp.clock_total === 1 && sp.clock_stopped === 1, 'B9 staffList 多帶 hire_date／last_day／clocks／clock_total／clock_stopped（打卡已停 n/m）', sp);
  const ul = post(sb, 'staffUnitList', {}, mgr.token);
  ok(ul.ok && ul.data.people.every((x) => x.unit === 'mzt-gf') && ul.data.people.some((x) => x.emp_no === p.emp && x.can_cancel_leave === true && x.last_day === dayT(4)) && !ul.data.people.some((x) => x.emp_no === q.emp), 'B9 staffUnitList：店長只看到自己單位', ul.data.people.map((x) => x.emp_no));
  const ulText = JSON.stringify(ul);
  ok(!/phone|birthday|address/.test(ulText), 'B9 staffUnitList 不含手機生日地址');
  ok(post(sb, 'staffUnitList', {}, p.token).code === 'no_perm', 'B9 一般同仁不能看');
  const ulHq = post(sb, 'staffUnitList', { unit: 'mzt-js' }, tok);
  ok(ulHq.ok && ulHq.data.people.length === 1 && ulHq.data.people[0].emp_no === q.emp, 'B9 總部可帶 unit 篩選');
})();

// ============================================================
// 退回認領保留組織四欄（clkKeepOrgOnClear_）
// ============================================================
(() => {
  const app = fresh();
  const { sb, sheets, tok } = app;
  const mgr = claimApprove(app, '退店長', 'mgr-a-pw-01', MZT_GF('sm'));
  const c = post(sb, 'staffCreateByUnit', { name: '退新人', title: 'ft', hire_date: dayT(0), phone: '0922000111' }, mgr.token);
  const lkNew = post(sb, 'claimLookup', { name: '退新人' });
  const sub = post(sb, 'claimSubmit', Object.assign({ name: '退新人', emp_no: c.data.emp_no, password: 'new-pw-0001' }, PROF({ title: 'pt' })));
  ok(lkNew.ok && lkNew.data.emp_no === c.data.emp_no && sub.ok, 'KEEP (a) 店長新增的新人走第一期認領送出');
  const rj = post(sb, 'unitReject', { emp_no: c.data.emp_no, reason: '資料不對' }, mgr.token);
  const s = staffOf(app, c.data.emp_no);
  ok(rj.ok && s.status === 'unclaimed' && s.unit === 'mzt-gf' && s.brand === 'mzt' && s.title === 'ft' && s.p_unit === '' && s.p_title === '' && s.phone === '', 'KEEP (a) 店長新增者被退回：unit/brand/title 保留、status unclaimed、p_* 與個資已清', s);
  // (b) 一般同仁（無到職日、無對照）
  post(sb, 'staffImport', { names: ['退一般'] }, tok);
  const emp = post(sb, 'claimLookup', { name: '退一般' }).data.emp_no;
  post(sb, 'claimSubmit', Object.assign({ name: '退一般', emp_no: emp, password: 'new-pw-0002' }, PROF()));
  const rj2 = post(sb, 'unitReject', { emp_no: emp, reason: '資料不對' }, mgr.token);
  const g = staffOf(app, emp);
  ok(rj2.ok && g.status === 'unclaimed' && g.unit === '' && g.brand === '' && g.title === '' && g.dept === '', 'KEEP (b) 一般同仁（無到職日、無對照）被退回：組織四欄照舊清空（第一期行為不變）', g);
})();

// ============================================================
// Fable 第 1 輪審查修正（issue #1：1、2、3、4、5、6、7、10、11、14）
// ============================================================
(() => {
  // ── 1 薪資門市代碼 ──
  const app = fresh();
  const { sb, sheets, tok } = app;
  const gfRows = sheets.clock_stores._rows();
  { const m = {}; gfRows.slice(1).forEach((r) => { m[r[0]] = r[4]; });
    ok(gfRows[0][4] === 'payroll_store' && JSON.stringify(m) === JSON.stringify({ gf: 'SSLGF', mztjs: 'MZTJS', mztgf: 'MZTGF', mztlzl: 'MZTLZL', mztmc: 'MZTMC', hq: 'HQ', cf: 'CF' }), 'FIX1 clock_stores.payroll_store 預設列：gf=SSLGF／mztjs=MZTJS／mztlzl=MZTLZL／hq=HQ／cf=CF，mztgf=MZTGF（2026-10-28 薪酬門市表已建）', m); }
  const p = claimApprove(app, '薪光復甲', 'pw-fix1-pw-01', { brand: 'mala', unit: 'mala-gf', title: 'pt' });
  giveMap(app, p.emp, 'gf', 'E5', 'home');
  const real = sb.clockRosterApply_('gf', [rosterRow('E5', '薪光復甲')], [{ store: 'SSLGF', emp_id: 'E5', name: '薪光復甲打錯' }], nowT(0));
  ok(real.data.payroll_diff === 1 && post(sb, 'clockAlerts', {}, tok).data.payroll_diff[0].payroll_name === '薪光復甲打錯', 'FIX1 ★用真實薪資代碼 SSLGF 餵：姓名不同被抓到', real);
  const fake = sb.clockRosterApply_('gf', [rosterRow('E5', '薪光復甲')], [{ store: 'gf', emp_id: 'E5', name: '薪光復甲打錯' }], nowT(1));
  ok(fake.data.payroll_diff === 0, 'FIX1 用契約 store_code（gf）餵不再算數（薪資代碼才對）');
  // 舊試算表（clock_stores 只有 4 欄）→ setupStaff 補第 5 欄並把光復補 SSLGF
  const old = load(freshSeed(HASHER));
  old.sb.setupStaff();
  old.sheets.clock_stores._data.forEach((r) => { r.length = 4; });
  old.sb.setupStaff();
  ok(old.sheets.clock_stores._rows()[0][4] === 'payroll_store' && old.sheets.clock_stores._rows().find((r) => r[0] === 'gf')[4] === 'SSLGF' && old.sheets.clock_stores._rows().length === 8, 'FIX1 舊 4 欄 clock_stores 補欄不重複列');

  // ── 2 姓名上限 20 ──
  const mgr = claimApprove(app, '修店長', 'mgr-fix-pw-01', MZT_GF('sm'));
  const body = (o) => Object.assign({ name: '修新人', title: 'pt', hire_date: dayT(0), phone: '0911000222' }, o || {});
  const n20 = '二'.repeat(20), n21 = '二'.repeat(21);
  ok(post(sb, 'staffCreateByUnit', body({ name: n20 }), mgr.token).ok, 'FIX2 20 字可以');
  const r21 = post(sb, 'staffCreateByUnit', body({ name: n21, phone: '0911000223' }), mgr.token);
  ok(r21.ok === false && r21.code === 'bad_input' && r21.error.indexOf('20') !== -1, 'FIX2 ★新增 21 字姓名 → bad_input（不會建出打卡永遠建不出來的人）', r21);
  const crew = post(sb, 'staffCreateByUnit', body({ name: '修改名', phone: '0911000224' }), mgr.token);
  ok(post(sb, 'staffRename', { emp_no: crew.data.emp_no, name: n21 }, tok).code === 'bad_input', 'FIX2 ★改名 21 字被擋');
  ok(post(sb, 'staffRename', { emp_no: crew.data.emp_no, name: '三'.repeat(20) }, tok).ok, 'FIX2 改成 20 字 OK');
  app.props.CLOCK_MAP_STATE = JSON.stringify({ candidates: [{ key: 'gf:LONG1', name: n21, entries: [{ store_code: 'gf', emp_id: 'LONG1' }] }], needs_hq: [], excluded: [] });
  ok(post(sb, 'clockCandidateCreate', { candidate_key: 'gf:LONG1', unit: 'mala-gf', title: 'pt' }, tok).code === 'bad_input', 'FIX2 候選新人姓名超過 20 字不建');

  // ── 3 結案 ──
  const c = post(sb, 'staffCreateByUnit', body({ name: '修結案', phone: '0911000225' }), mgr.token);
  sb.clockOutboxClaim_(nowT(1));
  sb.clockOutboxDone_(c.data.job_id, { ok: false, error: 'duplicate_name', message: '同名' }, nowT(2));
  ok(jobs(app).find((j) => j.job_id === c.data.job_id).state === 'failed', 'FIX3 （一張永久失敗的單）');
  ok(post(sb, 'clockOutboxCancel', { job_id: c.data.job_id }, mgr.token).code === 'no_perm', 'FIX3 店長不能結案');
  ok(post(sb, 'clockOutboxCancel', { job_id: jobs(app)[0].job_id }, tok).code === 'not_retryable', 'FIX3 沒卡住的單不能取消');
  const cc = post(sb, 'clockOutboxCancel', { job_id: c.data.job_id, reason: '打卡端已有同名' }, tok);
  const cj = jobs(app).find((j) => j.job_id === c.data.job_id);
  ok(cc.ok && cj.state === 'cancelled' && cj.last_error.indexOf('打卡端已有同名') !== -1 && cj.done_at !== '', 'FIX3 ★總部取消 failed 單：轉 cancelled、記原因', cj);
  ok(!post(sb, 'clockAlerts', {}, tok).data.outbox_failed.some((x) => x.job_id === c.data.job_id), 'FIX3 取消後從首頁紅燈消失');
  ok(sheets.staff_log._rows().some((r) => r[2] === 'outbox_cancel'), 'FIX3 寫 staff_log');
  ok(post(sb, 'clockOutboxCancel', { job_id: c.data.job_id }, tok).code === 'not_retryable', 'FIX3 取消過的不能再取消');
})();

(() => {
  // ── 4 舊「啟用」按鈕 ──
  const app = fresh();
  const { sb, tok } = app;
  const w = claimApprove(app, '修復職', 'pw-fix4-pw-01', MZT_GF('pt'));
  giveMap(app, w.emp, 'mztgf', 'F4', 'home');
  post(sb, 'staffLeave', { emp_no: w.emp, last_day: dayT(-1) }, tok);
  sb.clockDailyApply_(dayT(0));
  ok(staffOf(app, w.emp).status === 'disabled', 'FIX4 （離職連動已停用）');
  const old = post(sb, 'staffSetActive', { emp_no: w.emp, active: true }, tok);
  ok(old.ok === false && old.code === 'use_reinstate' && old.error.indexOf('復職') !== -1 && staffOf(app, w.emp).status === 'disabled', 'FIX4 ★有 last_day 的人用舊「啟用」被擋並導向復職', old);
  ok(sb.clockDailyApply_(dayT(1)).data.disabled.length === 0, 'FIX4 沒被啟用，也沒有重複停用');
  ok(post(sb, 'staffReinstate', { emp_no: w.emp, stores: ['mztgf'] }, tok).ok && staffOf(app, w.emp).last_day === '', 'FIX4 走復職：清 last_day');
  ok(sb.clockDailyApply_(dayT(2)).data.disabled.length === 0 && staffOf(app, w.emp).status !== 'disabled', 'FIX4 ★復職後隔天不再停用');
  // 沒有 last_day 的（人資手動停用）舊按鈕照常可啟用
  const z = claimApprove(app, '修手動', 'pw-fix4-pw-02', MZT_GF('pt'));
  post(sb, 'staffSetActive', { emp_no: z.emp, active: false }, tok);
  ok(post(sb, 'staffSetActive', { emp_no: z.emp, active: true }, tok).ok, 'FIX4 沒登記離職日的舊啟用照常');
})();

(() => {
  // ── 5 停用失敗進 alerts ──
  const app = fresh();
  const { sb, tok } = app;
  const w = claimApprove(app, '修停失敗', 'pw-fix5-pw-01', MZT_GF('pt'));
  giveMap(app, w.emp, 'mztgf', 'F5', 'home');
  post(sb, 'staffLeave', { emp_no: w.emp, last_day: dayT(-1) }, tok);
  setStaff(app, w.emp, 'user_id', 'u9999');   // users 列遺失
  const d = sb.clockDailyApply_(dayT(0));
  ok(d.data.disable_errors.length === 1 && d.data.disable_errors[0].code === 'user_missing', 'FIX5 （帳號列遺失：回報 disable_errors）', d);
  const al = post(sb, 'clockAlerts', {}, tok);
  ok(al.data.leave_overdue.join() === w.emp && al.data.counts.leave_overdue === 1, 'FIX5 ★停用失敗的人進 alerts.leave_overdue', al.data);
  ok(sheets_has(app, 'disable_failed'), 'FIX5 ★寫 staff_log（disable_failed）');
  ok(post(sb, 'clockAlerts', {}, claimApprove(app, '修店長五', 'mgr-fix5-pw-1', MZT_GF('sm')).token).data.leave_overdue.join() === w.emp, 'FIX5 店長看得到自己單位的');
  function sheets_has(a, ev) { return a.sheets.staff_log._rows().some((r) => r[2] === ev); }
})();

(() => {
  // ── 6 lease 過期連續三次進紅燈 ──
  const app = fresh();
  const { sb, tok } = app;
  const mgr = claimApprove(app, '修店長六', 'mgr-fix6-pw-1', MZT_GF('sm'));
  const c = post(sb, 'staffCreateByUnit', { name: '修掛單', title: 'pt', hire_date: dayT(0), phone: '0911000226' }, mgr.token);
  const jr = () => jobs(app).find((j) => j.job_id === c.data.job_id);
  sb.clockOutboxClaim_(nowT(1));
  for (let i = 1; i <= 3; i++) sb.clockOutboxClaim_(nowT(1 + i * 6));
  ok(jr().tries === 3 && jr().state === 'running' && jr().last_error === 'lease_expired', 'FIX6 連續三次 lease 過期：tries=3', jr());
  ok(post(sb, 'clockAlerts', {}, tok).data.outbox_failed.some((x) => x.job_id === c.data.job_id), 'FIX6 ★進 alerts（running 且 tries≥3）');
  ok(post(sb, 'clockOutboxRetry', { job_id: c.data.job_id }, tok).ok && jr().state === 'pending' && jr().tries === 0, 'FIX6 卡住的單可手動重試');
})();

(() => {
  // ── 7 DZY 在職但主店打卡已停 ──
  const app = fresh();
  const { sb, tok } = app;
  const w = claimApprove(app, '修主店停', 'pw-fix7-pw-01', MZT_GF('pt'));
  const v = claimApprove(app, '修支援停', 'pw-fix7-pw-02', MZT_GF('pt'));
  giveMap(app, w.emp, 'mztgf', 'F7', 'home'); giveMap(app, v.emp, 'mztgf', 'F8', 'home'); giveMap(app, v.emp, 'mztjs', 'F9', 'support');
  sb.clockRosterApply_('mztgf', [rosterRow('F7', '修主店停', { active: false }), rosterRow('F8', '修支援停')], undefined, nowT(0));
  sb.clockRosterApply_('mztjs', [rosterRow('F9', '修支援停', { active: false })], undefined, nowT(0));
  const al = post(sb, 'clockAlerts', {}, tok);
  ok(al.data.home_stopped.length === 1 && al.data.home_stopped[0].emp_no === w.emp && al.data.counts.home_stopped === 1, 'FIX7 ★在職者主店打卡被停 → alerts.home_stopped（支援店停不算）', al.data.home_stopped);
  post(sb, 'staffLeave', { emp_no: w.emp, last_day: dayT(3) }, tok);
  ok(post(sb, 'clockAlerts', {}, tok).data.home_stopped.length === 0, 'FIX7 已登記離職的人不算異常');
})();

(() => {
  // ── 10 打卡編號大小寫以名冊為準 ──
  const app = fresh();
  const { sb, tok } = app;
  const mgr = claimApprove(app, '修店長十', 'mgr-fix10-pw-1', MZT_GF('sm'));
  const c = post(sb, 'staffCreateByUnit', { name: '修小寫', title: 'pt', hire_date: dayT(0), phone: '0911000227' }, mgr.token);
  sb.clockOutboxClaim_(nowT(1));
  sb.clockOutboxDone_(c.data.job_id, { ok: true, emp_id: 'e12x' }, nowT(2));
  ok(mapOf(app, c.data.emp_no)[0].emp_id === 'e12x', 'FIX10 ★平台不改打卡編號大小寫');
  post(sb, 'staffLeave', { emp_no: c.data.emp_no, last_day: dayT(-1) }, tok);
  sb.clockDailyApply_(dayT(0));
  const cl = sb.clockOutboxClaim_(nowT(3));
  ok(cl.data.jobs.length === 1 && cl.data.jobs[0].emp_id === 'e12x', 'FIX10 deactivate 單送給同步員的編號與名冊原字串一致', cl);
  const up = giveMap, other = claimApprove(app, '修大寫', 'pw-fix10-pw-02', MZT_GF('pt'));
  up(app, other.emp, 'mztgf', 'E12X', 'home');
  ok(maps(app).filter((m) => m.emp_id.toLowerCase() === 'e12x').length === 2, 'FIX10 大小寫不同視為不同編號（與打卡端比對一致）');
})();

(() => {
  // ── 11 調店開單例外要留痕 ──
  const app = fresh();
  const { sb, tok } = app;
  const t = claimApprove(app, '修調店', 'pw-fix11-pw-01', MZT_GF('pt'));
  giveMap(app, t.emp, 'mztgf', 'T11', 'home');
  const ti = app.sheets.staff._data.findIndex((r) => r[0] === t.emp);
  const head = app.sheets.staff._data[0];
  ['p_brand', 'p_unit', 'p_title'].forEach((h, i) => { app.sheets.staff._data[ti][head.indexOf(h)] = ['mzt', 'mzt-js', 'pt'][i]; });
  const orig = sb.clkEnqueue_;
  sb.clkEnqueue_ = () => { throw new Error('模擬寫單失敗'); };
  const cf = post(sb, 'staffConfirm', { emp_no: t.emp }, tok);
  sb.clkEnqueue_ = orig;
  ok(cf.ok && staffOf(app, t.emp).unit === 'mzt-js', 'FIX11 確認照常成功');
  ok(app.sheets.staff_log._rows().some((r) => r[1] === t.emp && r[2] === 'transfer_add_failed'), 'FIX11 ★開單失敗寫 staff_log（transfer_add_failed）');
  const al = post(sb, 'clockAlerts', {}, tok);
  ok(al.data.transfer_failed.join() === t.emp && al.data.counts.transfer_failed === 1, 'FIX11 ★alerts.transfer_failed 看得到', al.data);
})();

(() => {
  // ── 14 送給打卡端的姓名不帶前導單引號（舊資料：姓名以符號開頭、待辦單格子有 authSafeCell_ 的單引號）──
  const app = fresh();
  const { sb } = app;
  const mgr = claimApprove(app, '修店長十四', 'mgr-fix14-pw-1', MZT_GF('sm'));
  const c = post(sb, 'staffCreateByUnit', { name: '修加註', title: 'pt', hire_date: dayT(0), phone: '0911000228' }, mgr.token);
  setStaff(app, c.data.emp_no, 'name', '-B修加註');                         // 舊資料（F2 之前建的）
  const idx = app.sheets.clock_outbox._data.findIndex((r) => r[0] === c.data.job_id);
  setCell(app, 'clock_outbox', idx, 'name', "'-B修加註");
  const cl = sb.clockOutboxClaim_(nowT(1));
  ok(cl.data.jobs[0].name === '-B修加註', 'FIX14 ★claim 給同步員的姓名是原字串，不帶單引號', cl.data.jobs[0]);
})();

// ============================================================
// 上線前關（Fable＋GPT 互盲）平台端修正：F2 F4 F1 G2 G4 G5 G6 G7 G8 G12 F3 F5 F6 F10
// ============================================================
(() => {
  // ── F2＝G14 姓名開頭 = + - @ ──
  const app = fresh();
  const { sb, tok } = app;
  const mgr = claimApprove(app, '前店長二', 'mgr-pre2-pw-01', MZT_GF('sm'));
  const body = (n) => ({ name: n, title: 'pt', hire_date: dayT(0), phone: '0911000300' });
  ['=SUM(1)', '+886', '-B前加註', '@home'].forEach((n) => {
    const r = post(sb, 'staffCreateByUnit', body(n), mgr.token);
    ok(r.ok === false && r.code === 'bad_input' && r.error.indexOf('= + - @') !== -1, 'F2 ★新增姓名開頭「' + n[0] + '」被擋', r);
  });
  ok(post(sb, 'staffCreateByUnit', body('前加註-B'), mgr.token).ok, 'F2 符號放在後面可以');
  const x = claimApprove(app, '前改名', 'pw-pre2-pw-02', MZT_GF('pt'));
  ok(post(sb, 'staffRename', { emp_no: x.emp, name: '=改名' }, tok).code === 'bad_input', 'F2 ★改名開頭符號被擋');
  app.props.CLOCK_MAP_STATE = JSON.stringify({ candidates: [{ key: 'gf:BAD1', name: '@候選', entries: [{ store_code: 'gf', emp_id: 'BAD1' }] }], needs_hq: [], excluded: [] });
  ok(post(sb, 'clockCandidateCreate', { candidate_key: 'gf:BAD1', unit: 'mala-gf', title: 'pt' }, tok).code === 'bad_input', 'F2 ★候選新人姓名開頭符號被擋');
})();

(() => {
  // ── F4＝G11 每日同步的 src 新列要過 7A 同一套把關，不過 → 異常＋補償停用單 ──
  const app = fresh();
  const { sb, tok } = app;
  const mk = (n) => { const p = claimApprove(app, n, 'pw-' + n + '-0001', MZT_GF('pt')); giveMap(app, p.emp, 'mztgf', 'H' + n.length + p.emp, 'home'); return { emp: p.emp, src: 'H' + n.length + p.emp }; };
  const ok1 = mk('前通過'), leave = mk('前離職日'), gone = mk('前已停用'), stopped = mk('前來源停'), removed = mk('前被移除過');
  post(sb, 'staffLeave', { emp_no: leave.emp, last_day: dayT(5) }, tok);
  setStaff(app, gone.emp, 'status', 'disabled');
  setMap(app, 'mztgf', stopped.src, 'roster_active', 'FALSE');
  giveMap(app, removed.emp, 'mztjs', 'OLDR', 'support', { state: 'rejected', source: 'auto_support' });
  const row = (eid, who) => rosterRow(eid, '店端' + eid, { src_store: 'mztgf', src_emp_id: who.src });
  const r = sb.clockRosterApply_('mztjs', [row('N1', ok1), row('N2', leave), row('N3', gone), row('N4', stopped), row('N5', removed)], undefined, nowT(0));
  ok(r.ok && r.data.created === 1 && r.data.compensated === 4 && r.data.unmapped === 4, 'F4 ★1 條通過、4 條不過（離職日／已停用／來源停用／被移除過）', r);
  ok(maps(app).filter((m) => m.store_code === 'mztjs' && m.state === 'confirmed' && m.source === 'auto_support').map((m) => m.emp_id).join() === 'N1', 'F4 只有通過把關的建 auto_support／confirmed');
  const comp = jobs(app).filter((j) => JSON.parse(j.expect_json).comp);
  ok(comp.length === 4 && comp.every((j) => j.kind === 'deactivate' && j.store_code === 'mztjs' && j.state === 'pending') && comp.map((j) => j.emp_id).sort().join() === 'N2,N3,N4,N5', 'F4 ★不過的 4 條各發一張補償停用單', comp);
  ok(post(sb, 'clockAlerts', {}, tok).data.outbox_failed.filter((x) => x.comp).length === 4, 'F4 補償單進首頁紅燈（alerts.outbox_failed，comp:true）');
  const again = sb.clockRosterApply_('mztjs', [row('N1', ok1), row('N2', leave), row('N3', gone), row('N4', stopped), row('N5', removed)], undefined, nowT(1));
  ok(again.data.compensated === 0 && jobs(app).filter((j) => JSON.parse(j.expect_json).comp).length === 4, 'F4 跑兩次不重複發補償單');
  const cl = sb.clockOutboxClaim_(nowT(2));
  ok(cl.data.jobs.length === 4 && cl.data.jobs.every((j) => j.comp === true && j.kind === 'deactivate'), 'F4 補償單照送（不因同仁已離職／停用而被取消）', cl);
  sb.clockOutboxDone_(comp[0].job_id, { ok: true }, nowT(3));
  ok(post(sb, 'clockAlerts', {}, tok).data.outbox_failed.filter((x) => x.comp).length === 3, 'F4 做完後紅燈減一');
  // 補償單送前：這個打卡編號被人合法對照 → 取消
  const app2 = fresh();
  const a2 = claimApprove(app2, '前補償甲', 'pw-comp-pw-0001', MZT_GF('pt'));
  const cp = app2.sb.clockCompensate_('mztjs', 'Z9', 'record_failed', a2.emp, nowT(0));
  ok(cp.ok && cp.data.job_id && cp.data.existing === false, 'F1 ★clockCompensate_ 開補償停用單', cp);
  ok(app2.sb.clockCompensate_('mztjs', 'Z9', 'record_failed', a2.emp, nowT(0)).data.existing === true && jobs(app2).length === 1, 'F1 同一個編號不重複開單');
  ok(post(app2.sb, 'clockAlerts', {}, app2.tok).data.outbox_failed.find((x) => x.comp).reason === 'record_failed', 'F1 ★補償單進紅燈（含原因）');
  ok(app2.sb.clockCompensate_('nope', 'Z9', 'x').code === 'bad_input' && app2.sb.clockCompensate_('mztjs', '壞 編號', 'x').code === 'bad_input', 'F1 店代碼、編號格式不對被拒');
  giveMap(app2, a2.emp, 'mztjs', 'Z9', 'support');
  const cl2 = app2.sb.clockOutboxClaim_(nowT(1));
  ok(cl2.data.cancelled.length === 1 && cl2.data.jobs.length === 0, 'F1 補償單送前該編號已有生效對照 → 取消（不誤停合法帳號）');
  ok(app2.sb.clockCompensate_('mztjs', 'Z9', 'x').code === 'conflict', 'F1 該編號已有生效對照時不開補償單');
})();

(() => {
  // ── F1＝G3 已試著送過的 add 單不取消 ──
  const app = fresh();
  const { sb, tok } = app;
  const mgr = claimApprove(app, '前店長一', 'mgr-pre1-pw-01', MZT_GF('sm'));
  const c = post(sb, 'staffCreateByUnit', { name: '前送過', title: 'pt', hire_date: dayT(0), phone: '0911000301' }, mgr.token);
  sb.clockOutboxClaim_(nowT(1));
  sb.clockOutboxDone_(c.data.job_id, { ok: false, error: 'timeout' }, nowT(2));     // 送過一次（逾時：打卡端可能已建）
  post(sb, 'staffSetActive', { emp_no: c.data.emp_no, active: false }, tok);          // 排隊期間被停用
  const cl = sb.clockOutboxClaim_(nowT(10));
  ok(cl.data.jobs.length === 1 && cl.data.jobs[0].job_id === c.data.job_id && cl.data.cancelled.length === 0, 'F1 ★tries>0 的 add 單不取消，照送（origin_op 冪等）', cl);
  sb.clockOutboxDone_(c.data.job_id, { ok: true, emp_id: 'PS1' }, nowT(11));
  ok(mapOf(app, c.data.emp_no)[0].emp_id === 'PS1', 'F1 送成功後照常寫對照（之後由停用單／對帳處理）');
  ok(jobs(app).some((j) => j.kind === 'deactivate' && j.emp_no === c.data.emp_no), 'F1 且該人已停用 → 有對應的停用單（G8），不會留下沒人管的在職帳號');
  // running 過期（可能已送達）也不取消
  const c2 = post(sb, 'staffCreateByUnit', { name: '前掛住', title: 'pt', hire_date: dayT(0), phone: '0911000302' }, mgr.token);
  sb.clockOutboxClaim_(nowT(20));
  setStaff(app, c2.data.emp_no, 'status', 'disabled');
  const cl2 = sb.clockOutboxClaim_(nowT(30));
  ok(cl2.data.jobs.some((j) => j.job_id === c2.data.job_id) && !cl2.data.cancelled.includes(c2.data.job_id), 'F1 running 過期重撿的 add 單同樣不取消');
})();

(() => {
  // ── G2 送出中改綁 ──
  const app = fresh();
  const { sb, tok } = app;
  const a = claimApprove(app, '前綁甲', 'pw-g2-pw-0001', MZT_GF('pt'));
  const b = claimApprove(app, '前綁乙', 'pw-g2-pw-0002', MZT_GF('pt'));
  giveMap(app, a.emp, 'mztgf', 'G2A', 'home');
  post(sb, 'staffLeave', { emp_no: a.emp, last_day: dayT(-1) }, tok);
  sb.clockDailyApply_(dayT(0));
  sb.clockOutboxClaim_(nowT(1));            // 停用單送出中（running）
  const rb = post(sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'G2A', decision: 'confirm', emp_no: b.emp }, tok);
  ok(rb.ok === false && rb.code === 'job_open' && maps(app).find((m) => m.emp_id === 'G2A').emp_no === a.emp, 'G2 ★有送出中的單時禁止改綁給別人', rb);
  ok(post(sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'G2A', decision: 'reject' }, tok).code === 'job_open', 'G2 送出中也不能退回');
  // 回填時比對：對照已被改（直接改表模擬別條路徑）→ 不蓋新對照
  setMap(app, 'mztgf', 'G2A', 'emp_no', b.emp);
  const dj = jobs(app).find((j) => j.kind === 'deactivate' && j.emp_no === a.emp);
  sb.clockOutboxDone_(dj.job_id, { ok: true }, nowT(2));
  ok(maps(app).find((m) => m.emp_id === 'G2A').roster_active === 'TRUE' && app.sheets.staff_log._rows().some((r) => r[2] === 'outbox_done_stale'), 'G2 ★Done 前比對 expect：對照已改給別人 → 不標停用、記 outbox_done_stale', maps(app).find((m) => m.emp_id === 'G2A'));
  ok(post(sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'G2A', decision: 'confirm', emp_no: a.emp }, tok).ok, 'G2 單結束後可以改綁');
})();

(() => {
  // ── G4 查證：每日對帳／名冊同步不會依姓名自動 confirmed ──
  const app = fresh();
  const { sb, tok } = app;
  const a = claimApprove(app, '前同名人', 'pw-g4-pw-0001', MZT_GF('pt'));
  giveMap(app, a.emp, 'mztgf', 'G4A', 'home');
  sb.clockRosterApply_('mztjs', [rosterRow('G4B', '前同名人'), rosterRow('G4C', '前同名人', { src_store: '', src_emp_id: '' })], undefined, nowT(0));
  sb.clockRosterApply_('gf', [rosterRow('G4D', '前同名人')], undefined, nowT(0));
  sb.clockDailyApply_(dayT(0));
  ok(maps(app).length === 1 && maps(app)[0].emp_id === 'G4A', 'G4 ★同名但沒有 src_* 的新列：每日同步與對帳都不建任何對照（只列「打卡上有、沒對照」）');
  ok(post(sb, 'clockAlerts', {}, tok).data.unmapped.length === 3, 'G4 三筆同名新列都進異常清單');
})();

(() => {
  // ── G5 名字比對排除已停用／已過離職日 ──
  const app = fresh();
  const { sb, tok } = app;
  const live = claimApprove(app, '前在職人', 'pw-g5-pw-0001', MZT_GF('pt'));
  const old = claimApprove(app, '前在職人X', 'pw-g5-pw-0002', MZT_GF('pt'));
  setStaff(app, old.emp, 'name', '前在職人'); setStaff(app, old.emp, 'status', 'disabled');
  const solo = claimApprove(app, '前只剩舊人', 'pw-g5-pw-0003', MZT_GF('pt'));
  setStaff(app, solo.emp, 'status', 'disabled');
  const lastPast = claimApprove(app, '前過日人', 'pw-g5-pw-0004', MZT_GF('pt'));
  post(sb, 'staffLeave', { emp_no: lastPast.emp, last_day: dayT(-2) }, tok);
  const r = sb.clockMapBuildApply_({ mztgf: [rosterRow('B1', '前在職人'), rosterRow('B2', '前只剩舊人'), rosterRow('B3', '前過日人')] }, nowT(0));
  ok(mapOf(app, live.emp).length === 1 && mapOf(app, old.emp).length === 0, 'G5 ★同名時只對到在職的那位，已停用的舊人不當候選', maps(app));
  const st = JSON.parse(app.props.CLOCK_MAP_STATE);
  ok(st.needs_hq.filter((n) => n.kind === 'disabled_match').map((n) => n.name).sort().join() === '前只剩舊人,前過日人' && st.candidates.length === 0 && maps(app).length === 1, 'G5 ★只對得到已離職的人 → 交總部（disabled_match），不建 suggested、也不當新人建 DZY', st);
})();

(() => {
  // ── G6 帳號列遺失不擋店端停用單 ──
  const app = fresh();
  const { sb, tok } = app;
  const w = claimApprove(app, '前帳遺失', 'pw-g6-pw-0001', MZT_GF('pt'));
  giveMap(app, w.emp, 'mztgf', 'G6A', 'home'); giveMap(app, w.emp, 'mztjs', 'G6B', 'support');
  post(sb, 'staffLeave', { emp_no: w.emp, last_day: dayT(-1) }, tok);
  setStaff(app, w.emp, 'user_id', 'u9999');
  const d = sb.clockDailyApply_(dayT(0));
  ok(d.data.jobs.length === 2 && staffOf(app, w.emp).status === 'disabled', 'G6 ★帳號列遺失：staff 仍標停用、每個對照各一張店端停用單照發', d);
  ok(sb.clockOutboxClaim_(nowT(1)).data.jobs.length === 2, 'G6 停用單通過送前重驗、可被撿走');
  ok(post(sb, 'clockAlerts', {}, tok).data.leave_overdue.join() === w.emp, 'G6 同時進首頁異常（帳號沒停乾淨）');
})();

(() => {
  // ── G7 舊 staffEdit 改單位 ／ G8 舊 staffSetActive(false) ──
  const app = fresh();
  const { sb, tok } = app;
  const a = claimApprove(app, '前改單位', 'pw-g7-pw-0001', MZT_GF('pt'));
  giveMap(app, a.emp, 'mztgf', 'G7A', 'home');
  const r = post(sb, 'staffEdit', { emp_no: a.emp, brand: 'mzt', unit: 'mzt-js', dept: '', title: 'pt' }, tok);
  const aj = jobs(app).filter((j) => j.kind === 'add' && j.emp_no === a.emp);
  ok(r.ok && aj.length === 1 && aj[0].store_code === 'mztjs' && JSON.parse(aj[0].expect_json).demote_old === true, 'G7 ★有對照的人用舊 staffEdit 改單位 → 同樣走調店流程（開新店 add 單、舊主店之後降支援）', aj);
  const n = claimApprove(app, '前無對照', 'pw-g7-pw-0002', MZT_GF('pt'));
  const before = jobs(app).length;
  post(sb, 'staffEdit', { emp_no: n.emp, brand: 'mzt', unit: 'mzt-js', dept: '', title: 'pt' }, tok);
  ok(jobs(app).length === before, 'G7 沒對照的人改單位不開單');
  // G8
  const b = claimApprove(app, '前舊停用', 'pw-g8-pw-0001', MZT_GF('pt'));
  giveMap(app, b.emp, 'mztgf', 'G8A', 'home'); giveMap(app, b.emp, 'mztjs', 'G8B', 'support'); giveMap(app, b.emp, 'gf', 'G8C', 'support', { state: 'suggested' });
  ok(post(sb, 'staffSetActive', { emp_no: b.emp, active: false }, tok).ok, 'G8 （舊停用按鈕）');
  const dj = jobs(app).filter((j) => j.kind === 'deactivate' && j.emp_no === b.emp);
  ok(dj.length === 2 && dj.map((j) => j.store_code).sort().join() === 'mztgf,mztjs', 'G8 ★同時對每個 confirmed 對照發停用單（suggested 不發），不必等隔日對帳', dj);
  ok(sb.clockDailyApply_(dayT(0)).data.reconcile_jobs.length === 0 && jobs(app).filter((j) => j.emp_no === b.emp && j.kind === 'deactivate').length === 2, 'G8 隔日對帳不重複發單');
  ok(sb.clockOutboxClaim_(nowT(1)).data.jobs.filter((j) => j.emp_no === b.emp).length === 2, 'G8 停用單通過送前重驗');
})();

(() => {
  // ── G12 異常 ──
  const app = fresh();
  const { sb, tok } = app;
  const a = claimApprove(app, '前被拒在職', 'pw-g12-pw-0001', MZT_GF('pt'));
  const b = claimApprove(app, '前被拒手動', 'pw-g12-pw-0002', MZT_GF('pt'));
  const c = claimApprove(app, '前離職只建議', 'pw-g12-pw-0003', MZT_GF('pt'));
  giveMap(app, a.emp, 'mztjs', 'RA1', 'support', { state: 'rejected', source: 'auto_support', roster_active: 'TRUE' });
  giveMap(app, b.emp, 'mztjs', 'RB1', 'support', { state: 'rejected', source: 'name_match', roster_active: 'TRUE' });
  giveMap(app, c.emp, 'mztgf', 'RC1', 'home', { state: 'suggested', source: 'name_match', roster_active: 'TRUE' });
  setStaff(app, c.emp, 'status', 'disabled');
  const d = sb.clockDailyApply_(dayT(0));
  const jj = jobs(app).filter((j) => j.kind === 'deactivate');
  ok(d.data.rejected_jobs.length === 1 && jj.length === 1 && jj[0].emp_no === a.emp && jj[0].emp_id === 'RA1', 'G12 ★rejected 的首次支援對照、打卡帳號又在職、人也在職 → 發停用單（店長按「不對」轉總部的 rejected 不自動停）', jj);
  const al = post(sb, 'clockAlerts', {}, tok).data;
  ok(al.unmapped.filter((x) => x.reason === 'rejected').map((x) => x.emp_id).sort().join() === 'RA1,RB1' && al.counts.rejected_active === 2, 'G12 ★rejected 但打卡在職 → 進異常（併入 unmapped，reason=rejected）', al.unmapped);
  ok(al.left_but_active.filter((x) => x.suggested).length === 1 && al.left_but_active[0].emp_id === 'RC1' && al.counts.left_suggested === 1, 'G12 ★離職者只有 suggested 對照、打卡仍在職 → 進異常（併入 left_but_active，suggested=true）', al.left_but_active);
  ok(sb.clockDailyApply_(dayT(0)).data.rejected_jobs.length === 0, 'G12 跑兩次不重複發單');
  const cl = sb.clockOutboxClaim_(nowT(1));
  ok(cl.data.jobs.some((j) => j.emp_id === 'RA1') && cl.data.cancelled.length === 0, 'G12 停用單通過送前重驗（expect.state=rejected）');
  sb.clockOutboxDone_(jj[0].job_id, { ok: true }, nowT(2));
  ok(maps(app).find((m) => m.emp_id === 'RA1').roster_active === 'FALSE' && maps(app).find((m) => m.emp_id === 'RA1').state === 'rejected', 'G12 做完 roster_active FALSE、仍是 rejected');
})();

(() => {
  // ── F3 來源店名冊已停用 ──
  const app = fresh();
  const { sb } = app;
  const a = claimApprove(app, '前來源停', 'pw-f3-pw-0001', MZT_GF('pt'));
  giveMap(app, a.emp, 'mztgf', 'F3A', 'home');
  const chk = () => sb.clockAutoSupportCheck_({ store_code: 'mztjs', src_store: 'mztgf', src_emp_id: 'F3A' });
  ok(chk().data.allowed === true, 'F3 對照組：來源在職可以');
  setMap(app, 'mztgf', 'F3A', 'roster_active', 'FALSE');
  const r = chk();
  ok(r.data.allowed === false && r.data.reason === 'source_stopped', 'F3 ★來源店名冊已停用 → 拒（source_stopped）', r);
})();

(() => {
  // ── F5 空名冊 ──
  const app = fresh();
  const { sb } = app;
  const a = claimApprove(app, '前空名冊', 'pw-f5-pw-0001', MZT_GF('pt'));
  giveMap(app, a.emp, 'mztgf', 'F5A', 'home');
  const r = sb.clockRosterApply_('mztgf', [], undefined, nowT(0));
  ok(r.ok === false && r.code === 'empty_roster' && maps(app)[0].roster_active === 'TRUE', 'F5 ★已有 confirmed 對照的店收到空名冊 → 失敗、不套用（對照不會被全標停用）', r);
  ok(sb.clockRosterApply_('mztjs', [], undefined, nowT(0)).ok === true, 'F5 沒有對照的店空名冊照常');
  ok(sb.clockRosterApply_('mztgf', [rosterRow('F5A', '前空名冊')], undefined, nowT(1)).ok, 'F5 有資料就正常套用');
})();

(() => {
  // ── F6 svc_add 回 active:false ──
  const app = fresh();
  const { sb, tok } = app;
  const mgr = claimApprove(app, '前店長六', 'mgr-f6-pw-001', MZT_GF('sm'));
  const c = post(sb, 'staffCreateByUnit', { name: '前冪等停用', title: 'pt', hire_date: dayT(0), phone: '0911000303' }, mgr.token);
  sb.clockOutboxClaim_(nowT(1));
  sb.clockOutboxDone_(c.data.job_id, { ok: true, emp_id: 'F6A', active: false }, nowT(2));
  ok(mapOf(app, c.data.emp_no)[0].roster_active === 'FALSE', 'F6 ★回應帶 active:false → 照實寫 roster_active=FALSE');
  ok(post(sb, 'clockAlerts', {}, tok).data.home_stopped.some((x) => x.emp_id === 'F6A'), 'F6 且進異常（在職者主店打卡已停）');
  const c3 = post(sb, 'staffCreateByUnit', { name: '前既有列', title: 'pt', hire_date: dayT(0), phone: '0911000305' }, mgr.token);
  giveMap(app, c3.data.emp_no, 'mztgf', 'F6C', 'home', { state: 'suggested', source: 'name_match' });
  sb.clockOutboxClaim_(nowT(1));
  sb.clockOutboxDone_(c3.data.job_id, { ok: true, emp_id: 'F6C', active: false }, nowT(2));
  ok(mapOf(app, c3.data.emp_no).find((m) => m.emp_id === 'F6C').roster_active === 'FALSE', 'F6 同鍵已有 suggested 列時也照實寫');
  const c2 = post(sb, 'staffCreateByUnit', { name: '前正常建', title: 'pt', hire_date: dayT(0), phone: '0911000304' }, mgr.token);
  sb.clockOutboxClaim_(nowT(1));
  sb.clockOutboxDone_(c2.data.job_id, { ok: true, emp_id: 'F6B' }, nowT(2));
  ok(mapOf(app, c2.data.emp_no)[0].roster_active === 'TRUE', 'F6 沒帶 active 照舊 TRUE');
})();

(() => {
  // ── F10 支援店連結只給總部 ──
  const app = fresh();
  const { sb, tok } = app;
  const mgr = claimApprove(app, '前店長十', 'mgr-f10-pw-01', MZT_GF('sm'));
  const x = claimApprove(app, '前支援人', 'pw-f10-pw-0001', MZT_GF('pt'));
  giveMap(app, x.emp, 'mztgf', 'F10A', 'home'); giveMap(app, x.emp, 'mztjs', 'F10B', 'support');
  const r = post(sb, 'clockLink', { emp_no: x.emp, store_code: 'mztjs' }, mgr.token);
  ok(r.ok === false && r.code === 'no_perm', 'F10 ★店長不能取同仁「支援店」的連結', r);
  ok(post(sb, 'clockLink', { emp_no: x.emp }, mgr.token).ok && post(sb, 'clockLink', { emp_no: x.emp, store_code: 'mztgf' }, mgr.token).ok, 'F10 主店連結店長照常');
  ok(post(sb, 'clockLink', { emp_no: x.emp, store_code: 'mztjs' }, tok).ok, 'F10 總部可以取支援店連結');
})();

(() => {
  // ── Fable 驗證補強：lease 過期不擋、補償單（無對照列）也擋、staffImport／staffEdit 姓名 ──
  const app = fresh();
  const { sb, tok } = app;
  const a = claimApprove(app, '驗綁甲', 'pw-v1-pw-0001', MZT_GF('pt'));
  const b = claimApprove(app, '驗綁乙', 'pw-v1-pw-0002', MZT_GF('pt'));
  giveMap(app, a.emp, 'mztgf', 'V1A', 'home');
  post(sb, 'staffLeave', { emp_no: a.emp, last_day: dayT(-1) }, tok);
  sb.clockDailyApply_(dayT(0));
  const dj0 = jobs(app).findIndex((j) => j.kind === 'deactivate' && j.emp_no === a.emp);
  setCell(app, 'clock_outbox', dj0 + 1, 'state', 'running'); setCell(app, 'clock_outbox', dj0 + 1, 'lease_until', nowT(-15));   // 同步員撿走後當掉：lease 早就過期，單永遠停在 running
  const dj = jobs(app).find((j) => j.kind === 'deactivate' && j.emp_no === a.emp);
  ok(dj.state === 'running', 'V1 （單卡在 running，lease 已過期）');
  const rb = post(sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'V1A', decision: 'confirm', emp_no: b.emp }, tok);
  ok(rb.ok === true, 'V1 ★lease 過期的 running 單不擋改綁（視同 pending，送前重驗會處理）', rb);
  const dj2 = jobs(app).find((j) => j.job_id === dj.job_id);
  ok(post(sb, 'clockOutboxCancel', { job_id: dj.job_id }, tok).ok && jobs(app).find((j) => j.job_id === dj.job_id).state === 'cancelled', 'V1 ★lease 過期的 running 單總部可以取消', dj2);
  // 補償單（沒有對照列）running 中：confirm／建立候選都擋
  sb.clockCompensate_('mztjs', 'V4Z', 'record_failed', '', nowT(0));
  sb.clockOutboxClaim_(nowT(1));
  const c1 = post(sb, 'clockMapDecide', { store_code: 'mztjs', emp_id: 'V4Z', decision: 'confirm', emp_no: b.emp }, tok);
  ok(c1.ok === false && c1.code === 'job_open' && !maps(app).some((m) => m.emp_id === 'V4Z'), 'V4 ★沒有對照列、有送出中的補償單：總部 confirm 被擋', c1);
  app.props.CLOCK_MAP_STATE = JSON.stringify({ candidates: [{ key: 'mztjs:V4Z', name: '驗候選', entries: [{ store_code: 'mztjs', emp_id: 'V4Z' }] }], needs_hq: [], excluded: [] });
  ok(post(sb, 'clockCandidateCreate', { candidate_key: 'mztjs:V4Z', unit: 'mzt-js', title: 'pt' }, tok).code === 'job_open', 'V4 ★補償單送出中，建立候選新人（新建 confirmed）被擋');
  // 姓名（第一期入口）
  ['=cmd', '+1', '-B', '@x'].forEach((n) => {
    ok(post(sb, 'staffImport', { names: [n] }, tok).ok === false, 'V5 ★staffImport 擋開頭「' + n[0] + '」');
  });
  ok(post(sb, 'staffAdd', { name: '-加註' }, tok).ok === false, 'V5 ★staffAdd 擋開頭符號');
  ok(post(sb, 'staffImport', { names: ['驗加註-B', '長'.repeat(25)] }, tok).ok, 'V5 符號放後面、21～30 字的第一期匯入照舊可以');
  ok(post(sb, 'staffEdit', { emp_no: b.emp, name: '@改' }, tok).ok === false, 'V5 ★staffEdit 改名擋開頭符號');
  const long = '改'.repeat(21);
  const e1 = post(sb, 'staffEdit', { emp_no: b.emp, name: long }, tok);
  ok(e1.ok === false && e1.error.indexOf('20') !== -1, 'V5 ★會進打卡（單位有打卡／有對照）的人 staffEdit 改名限 20 字', e1);
  const imp = sheetsNameEmp(app, '長'.repeat(25));
  ok(post(sb, 'staffEdit', { emp_no: imp, name: long }, tok).ok, 'V5 沒單位、沒對照的人（第一期匯入）改名仍可到 30 字');
  function sheetsNameEmp(ap, n) { return ap.sheets.staff._rows().find((r) => r[2] === n)[0]; }
})();

(() => {
  // ── G9 actual_active ／ G6 svcDirectory 完整性 ──
  const app = fresh();
  const { sb, tok, props } = app;
  const a = claimApprove(app, '二關甲', 'pw-r2-pw-0001', MZT_GF('pt'));
  const b = claimApprove(app, '二關乙', 'pw-r2-pw-0002', MZT_GF('pt'));
  giveMap(app, a.emp, 'mztgf', 'R2A', 'home');
  setStaff(app, a.emp, 'status', 'disabled');
  sb.clockDailyApply_(dayT(0));
  sb.clockOutboxClaim_(nowT(1));
  const j = jobs(app).find((x) => x.kind === 'deactivate' && x.emp_no === a.emp);
  const r = sb.clockOutboxDone_(j.job_id, { ok: true, actual_active: true }, nowT(2));
  const jj = jobs(app).find((x) => x.job_id === j.job_id);
  ok(r.data.state === 'failed' && jj.state === 'failed' && jj.last_error.indexOf('conflict') === 0, 'G9 ★停用單回報店端實際仍在職（actual_active:true）→ failed（conflict），不算成功', jj);
  ok(maps(app).find((m) => m.emp_id === 'R2A').roster_active === 'TRUE', 'G9 對照 roster_active 照實寫（TRUE），沒被標成已停用');
  ok(post(sb, 'clockAlerts', {}, tok).data.outbox_failed.some((x) => x.job_id === j.job_id && x.state === 'failed'), 'G9 進 alerts');
  // 一致的 actual_active 照常成功；reactivate 反向同理
  ok(post(sb, 'clockOutboxRetry', { job_id: j.job_id }, tok).ok, 'G9 （重試）');
  sb.clockOutboxClaim_(nowT(1));
  const okR = sb.clockOutboxDone_(j.job_id, { ok: true, actual_active: false }, nowT(2));
  ok(okR.data.state === 'done' && maps(app).find((m) => m.emp_id === 'R2A').roster_active === 'FALSE', 'G9 actual_active 與目標一致 → 成功');
  giveMap(app, b.emp, 'mztgf', 'R2B', 'home', { roster_active: 'FALSE' });
  post(sb, 'staffLeave', { emp_no: b.emp, last_day: dayT(-1) }, tok); sb.clockDailyApply_(dayT(0)); post(sb, 'staffReinstate', { emp_no: b.emp, stores: ['mztgf'] }, tok);
  sb.clockOutboxClaim_(nowT(1));
  const rj = jobs(app).find((x) => x.kind === 'reactivate' && x.emp_no === b.emp);
  sb.clockOutboxDone_(rj.job_id, { ok: false, error: 'conflict', actual_active: false }, nowT(2));
  ok(jobs(app).find((x) => x.job_id === rj.job_id).state === 'failed' && maps(app).find((m) => m.emp_id === 'R2B').roster_active === 'FALSE', 'G9 reactivate 回 error=conflict＋actual_active:false → failed、照實寫');
  // G6 svcDirectory
  props.BULLETIN_SVC_KEY = 'fake-bulletin-key-0002';
  const dir = post(sb, 'svcDirectory', { svc_key: 'fake-bulletin-key-0002' });
  const n = app.sheets.staff._rows().length - 1;
  ok(dir.ok && dir.total === n && dir.data.length === n && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dir.generated_at), 'G6 ★svcDirectory 帶 total（＝全部 staff 筆數）與 generated_at', [dir.total, n]);
  ok(dir.data.some((p) => p.emp_no === a.emp && p.active === false) && dir.data.find((p) => p.emp_no === b.emp).clocks.length >= 0 && dir.data.every((p) => Array.isArray(p.clocks)), 'G6 ★停用者、沒有 confirmed 對照的人也都回（帶 active）；clocks 只放 confirmed');
  const c = claimApprove(app, '二關丙', 'pw-r2-pw-0003', MZT_GF('pt'));
  const dir2 = post(sb, 'svcDirectory', { svc_key: 'fake-bulletin-key-0002' });
  ok(dir2.total === n + 1 && dir2.data.find((p) => p.emp_no === c.emp).clocks.length === 0, 'G6 無對照的新人也在名單內、total 隨之增加');
})();

(() => {
  // ── 總部三單位共用 hq 打卡（Eason 2026-10-14）──
  const app = fresh();
  const { sb, sheets, tok } = app;
  const body = (o) => Object.assign({ title: 'hs', hire_date: dayT(0), phone: '0911000400' }, o);
  const r1 = post(sb, 'staffCreateByUnit', body({ name: '總部墨', unit: 'mzt-hq', title: 'ofs' }), tok);
  const r2 = post(sb, 'staffCreateByUnit', body({ name: '總部辛', unit: 'mala-hq', title: 'ofs', phone: '0911000401' }), tok);
  ok(r1.ok && r1.data.store_code === 'hq' && r1.data.job_id && r2.ok && r2.data.store_code === 'hq' && r2.data.job_id, 'HQ ★墨竹亭總部、小辛辣總部的新人都會開 hq 的 add 單', [r1, r2]);
  ok(jobs(app).filter((j) => j.store_code === 'hq' && j.kind === 'add').length === 2, 'HQ add 單的店都是 hq');
  const r3 = post(sb, 'staffCreateByUnit', body({ name: '總部鼎', unit: 'dzy-hq', dept: 'it', phone: '0911000402' }), tok);
  ok(r3.ok && r3.data.store_code === 'hq', 'HQ 鼎兆元總部照舊');
  // 建對照：三單位的人主店＝hq
  const e1 = r1.data.emp_no, e2 = r2.data.emp_no;
  const b = sb.clockMapBuildApply_({ hq: [rosterRow('H1', '總部墨'), rosterRow('H2', '總部辛')] }, nowT(0));
  ok(maps(app).find((m) => m.emp_no === e1).role === 'home' && maps(app).find((m) => m.emp_no === e2).role === 'home' && b.ok, 'HQ ★建對照：mzt-hq、mala-hq 的人主店＝hq', maps(app));
  // 候選新人：hq 對到多個單位 → 沒指定單位被擋
  app.props.CLOCK_MAP_STATE = JSON.stringify({ candidates: [{ key: 'hq:H9', name: '總部候選', entries: [{ store_code: 'hq', emp_id: 'H9' }] }, { key: 'mztjs:J9', name: '金山候選', entries: [{ store_code: 'mztjs', emp_id: 'J9' }] }], needs_hq: [], excluded: [] });
  const noUnit = post(sb, 'clockCandidateCreate', { candidate_key: 'hq:H9', title: 'hs' }, tok);
  ok(noUnit.ok === false && noUnit.code === 'bad_input' && noUnit.error.indexOf('指定單位') !== -1, 'HQ ★hq 候選新人沒指定單位被擋', noUnit);
  const withUnit = post(sb, 'clockCandidateCreate', { candidate_key: 'hq:H9', unit: 'mzt-hq', title: 'ofs' }, tok);
  ok(withUnit.ok && staffOf(app, withUnit.data.emp_no).unit === 'mzt-hq' && mapOf(app, withUnit.data.emp_no)[0].role === 'home', 'HQ 指定單位後可建立，主店＝hq', withUnit);
  const js = post(sb, 'clockCandidateCreate', { candidate_key: 'mztjs:J9', title: 'pt' }, tok);
  ok(js.ok && staffOf(app, js.data.emp_no).unit === 'mzt-js', 'HQ 只對一個單位的店仍自動帶單位');
  // 舊分頁升級：hq 列只有 dzy-hq → 補三個；自訂值不動
  const old = fresh();
  old.sheets.clock_stores._data.find((r) => r[0] === 'hq')[2] = 'dzy-hq';
  old.sb.setupStaff();
  ok(old.sheets.clock_stores._rows().find((r) => r[0] === 'hq')[2] === 'dzy-hq,mzt-hq,mala-hq,yiwu-hq', 'HQ ★舊分頁 hq 列等於舊預設 dzy-hq → 升級成四個單位');
  old.sb.setupStaff();
  ok(old.sheets.clock_stores._rows().find((r) => r[0] === 'hq')[2] === 'dzy-hq,mzt-hq,mala-hq,yiwu-hq', 'HQ 升級可重跑');
  const custom = fresh();
  custom.sheets.clock_stores._data.find((r) => r[0] === 'hq')[2] = 'dzy-hq,mzt-hq';
  custom.sb.setupStaff();
  ok(custom.sheets.clock_stores._rows().find((r) => r[0] === 'hq')[2] === 'dzy-hq,mzt-hq', 'HQ 總部自訂過的值不動');
  const blank = fresh();
  blank.sheets.clock_stores._data.find((r) => r[0] === 'hq')[2] = '';
  blank.sb.setupStaff();
  ok(blank.sheets.clock_stores._rows().find((r) => r[0] === 'hq')[2] === '', 'HQ 清空的值不動');
  // 同一單位不得在兩家店
  const dup = fresh();
  dup.sheets.clock_stores._data.find((r) => r[0] === 'cf')[2] = 'ck,mala-hq';
  let msg = '';
  try { dup.sb.setupStaff(); } catch (e) { msg = e.message; }
  ok(msg.indexOf('mala-hq') !== -1 && msg.indexOf('hq') !== -1 && msg.indexOf('cf') !== -1, 'HQ ★同一單位出現在兩家店 → setup 報錯', msg);
  const mgr = claimApprove(dup, '衝突店長', 'mgr-dup-pw-001', MZT_GF('sm'));
  const rr = post(dup.sb, 'staffCreateByUnit', { name: '衝突新人', title: 'pt', hire_date: dayT(0), phone: '0911000403' }, mgr.token);
  ok(rr.ok === false && rr.code === 'setup_failed' && rr.error.indexOf('mala-hq') !== -1, 'HQ 衝突時 action 也回 setup_failed、不寫資料', rr);
  // 單位→店只比對「包含」，不是前綴
  ok(sb.clkStoreOfUnit_('dzy-hq').store_code === 'hq' && sb.clkStoreOfUnit_('hq') === null && sb.clkStoreOfUnit_('mala') === null, 'HQ 單位→店用完整單位代碼比對');
})();

(() => {
  // ── 主店判斷：未認領者（單位空）依打卡資料推斷；DZY 單位優先 ──
  const app = fresh();
  const { sb, sheets, tok } = app;
  post(sb, 'staffImport', { names: ['主單店', '主多店', '主同分', '主單位優先', '主不動甲'] }, tok);
  const E = (n) => sheets.staff._rows().find((r) => r[2] === n)[0];
  post(sb, 'staffEdit', { emp_no: E('主單位優先'), brand: 'mzt', unit: 'mzt-gf', dept: '', title: 'pt' }, tok);
  const R = (eid, n, punch) => rosterRow(eid, n, { last_punch: punch });
  sb.clockMapBuildApply_({
    mztgf: [R('A1', '主單店', '2026-10-01'), R('A2', '主多店', '2026-10-01'), R('A3', '主同分', '2026-10-05'), R('A4', '主單位優先', '2026-09-01')],
    mztjs: [R('B2', '主多店', '2026-10-10'), R('B3', '主同分', '2026-10-05'), R('B4', '主單位優先', '2026-10-12')]
  }, nowT(0));
  const roleOf = (n) => mapOf(app, E(n)).map((m) => m.store_code + ':' + m.role).sort().join();
  ok(roleOf('主單店') === 'mztgf:home', 'ROLE ★未認領、只在一家名冊在職 → 主店＝那家', roleOf('主單店'));
  ok(roleOf('主多店') === 'mztgf:support,mztjs:home', 'ROLE ★未認領、多家 → 最近打卡者為主店（金山 10/10 比光復 10/01 近）', roleOf('主多店'));
  ok(roleOf('主同分') === 'mztgf:home,mztjs:support', 'ROLE 同日打卡 → store_code 字母序最前（mztgf）', roleOf('主同分'));
  ok(roleOf('主單位優先') === 'mztgf:home,mztjs:support', 'ROLE ★DZY 單位有值 → 以單位為準，不被較近的打卡資料覆蓋', roleOf('主單位優先'));
  ok(mapOf(app, E('主多店')).every((m) => m.state === 'suggested'), 'ROLE 推斷只動 role，state 仍是 suggested');

  // 每日重算：打卡資料變了 → 單位空的人 role 跟著變（suggested／confirmed 都可），不改 state、不發單
  setMap(app, 'mztgf', 'A2', 'state', 'confirmed');
  sb.clockRosterApply_('mztgf', [R('A1', '主單店', '2026-10-01'), R('A2', '主多店', '2026-10-14'), R('A3', '主同分', '2026-10-05'), R('A4', '主單位優先', '2026-09-01')], undefined, nowT(0));
  const jobsBefore = jobs(app).length;
  const stateBefore = maps(app).map((m) => m.state).join();
  const dd = sb.clockDailyApply_(dayT(0));
  ok(roleOf('主多店') === 'mztgf:home,mztjs:support' && dd.data.role_changes.indexOf(E('主多店')) !== -1, 'ROLE ★每日同步重算：光復打卡變最近 → home 換到光復（confirmed 那筆也可改 role）', roleOf('主多店'));
  ok(maps(app).map((m) => m.state).join() === stateBefore && jobs(app).length === jobsBefore, 'ROLE ★每日重算不改任何 state、不發任何打卡單');
  ok(app.sheets.staff_log._rows().some((r) => r[1] === E('主多店') && r[2] === 'role_recalc'), 'ROLE 重算寫 staff_log（role_recalc）');
  // DZY 單位有值且已有 confirmed home：不被打卡資料覆蓋
  setMap(app, 'mztgf', 'A4', 'state', 'confirmed');
  sb.clockRosterApply_('mztjs', [R('B2', '主多店', '2026-10-10'), R('B3', '主同分', '2026-10-05'), R('B4', '主單位優先', '2026-10-20')], undefined, nowT(0));
  sb.clockDailyApply_(dayT(0));
  ok(roleOf('主單位優先') === 'mztgf:home,mztjs:support', 'ROLE ★單位有值的人每日重算也不動（home 以單位為準）');
  // 重跑 build 對既有列也更新 role
  setMap(app, 'mztjs', 'B3', 'role', 'home'); setMap(app, 'mztgf', 'A3', 'role', 'support'); setMap(app, 'mztgf', 'A3', 'last_punch', '2026-10-08');
  const rb = sb.clockMapBuildApply_({ mztgf: [R('A3', '主同分', '2026-10-05')], mztjs: [R('B3', '主同分', '2026-10-05')] }, nowT(1));
  ok(roleOf('主同分') === 'mztgf:home,mztjs:support' && rb.data.role_changes >= 1, 'ROLE ★重跑「建立打卡對照」：已存在的列也用新規則更新 role', roleOf('主同分'));

  // 單位有值、已有 confirmed home（例如總部手動指定在別家）：每日重算不覆蓋
  const app4 = fresh();
  const p4 = claimApprove(app4, '主手動指定', 'pw-role-pw-0001', MZT_GF('pt'));
  giveMap(app4, p4.emp, 'mztjs', 'M1', 'home'); giveMap(app4, p4.emp, 'mztgf', 'M2', 'support');
  app4.sb.clockDailyApply_(dayT(0));
  ok(mapOf(app4, p4.emp).map((m) => m.store_code + ':' + m.role).sort().join() === 'mztgf:support,mztjs:home', 'ROLE ★單位有值且已有 confirmed home：每日重算不覆蓋既有主店');
  // decide 預設 role：未認領者用推斷
  const app2 = fresh();
  post(app2.sb, 'staffImport', { names: ['決定未認領'] }, app2.tok);
  const e2 = app2.sheets.staff._rows().find((r) => r[2] === '決定未認領')[0];
  giveMap(app2, e2, 'mztgf', 'D1', 'support', { state: 'suggested', source: 'name_match', last_punch: '2026-10-01' });
  giveMap(app2, e2, 'mztjs', 'D2', 'support', { state: 'suggested', source: 'name_match', last_punch: '2026-10-09' });
  setMap(app2, 'mztgf', 'D1', 'role', ''); 
  post(app2.sb, 'clockMapDecide', { store_code: 'mztjs', emp_id: 'D2', decision: 'confirm' }, app2.tok);
  const d1 = post(app2.sb, 'clockMapDecide', { store_code: 'mztgf', emp_id: 'D1', decision: 'confirm' }, app2.tok);
  ok(d1.ok && d1.data.role === 'support', 'ROLE decide 預設 role：已有生效主店時不搶（support），不報 home_exists', d1);
  // 單位空的人沒有任何 confirmed home 時：預設推斷
  const app3 = fresh();
  post(app3.sb, 'staffImport', { names: ['決定單家'] }, app3.tok);
  const e3 = app3.sheets.staff._rows().find((r) => r[2] === '決定單家')[0];
  giveMap(app3, e3, 'mztjs', 'S1', 'support', { state: 'suggested', source: 'name_match' });
  setMap(app3, 'mztjs', 'S1', 'role', '');
  ok(post(app3.sb, 'clockMapDecide', { store_code: 'mztjs', emp_id: 'S1', decision: 'confirm' }, app3.tok).data.role === 'home', 'ROLE decide 預設 role：未認領、只在一家 → home');
})();

(() => {
  // ── 認領後單位從空變有值 ──
  const app = fresh();
  const { sb, sheets, tok } = app;
  post(sb, 'staffImport', { names: ['認領換主甲', '認領無對照乙'] }, tok);
  const E = (n) => sheets.staff._rows().find((r) => r[2] === n)[0];
  const a = E('認領換主甲'), b = E('認領無對照乙');
  giveMap(app, a, 'mztgf', 'C1', 'home'); giveMap(app, a, 'mztjs', 'C2', 'support');
  giveMap(app, b, 'mztgf', 'C3', 'home');
  const head = sheets.staff._data[0];
  const setP = (emp, unit) => { const i = sheets.staff._data.findIndex((r) => r[0] === emp); [['p_brand', 'mzt'], ['p_unit', unit], ['p_title', 'pt']].forEach(([h, v]) => { sheets.staff._data[i][head.indexOf(h)] = v; }); sheets.staff._data[i][head.indexOf('status')] = 'pending'; };
  const jobsBefore = jobs(app).length;
  setP(a, 'mzt-js');
  ok(post(sb, 'staffConfirm', { emp_no: a }, tok).ok, 'CLAIM （認領確認，單位空→金山）');
  ok(mapOf(app, a).map((m) => m.store_code + ':' + m.role).sort().join() === 'mztgf:support,mztjs:home', 'CLAIM ★新單位的店已有對照 → 那筆改 home、原 home 改 support', mapOf(app, a));
  ok(jobs(app).length === jobsBefore && mapOf(app, a).every((m) => m.state === 'confirmed') && post(sb, 'clockAlerts', {}, tok).data.transfer_ask.length === 0, 'CLAIM ★不發單、不改 state、不算調店（沒有 transfer_ask）');
  setP(b, 'mzt-js');
  post(sb, 'staffConfirm', { emp_no: b }, tok);
  ok(jobs(app).length === jobsBefore && mapOf(app, b)[0].role === 'home', 'CLAIM 新單位的店沒有對照 → 不開 add 單、不動既有對照');
  ok(post(sb, 'clockAlerts', {}, tok).data.no_home_map.indexOf(b) !== -1, 'CLAIM 沒對照的人列入 no_home_map 讓總部處理');
})();

(() => {
  // ── 店長可見範圍：看「對照列的店」，單位空的未認領者也看得到 ──
  const app = fresh();
  const { sb, sheets, tok } = app;
  const mgrGF = claimApprove(app, '見店長光', 'mgr-vis-pw-001', MZT_GF('sm'));
  const mgrJS = claimApprove(app, '見店長金', 'mgr-vis-pw-002', MZT_JS('sm'));
  post(sb, 'staffImport', { names: ['見未認領'] }, tok);
  const u = sheets.staff._rows().find((r) => r[2] === '見未認領')[0];
  giveMap(app, u, 'mztgf', 'V1', 'home', { state: 'suggested', source: 'name_match' });
  giveMap(app, u, 'mztjs', 'V2', 'support', { state: 'suggested', source: 'name_match' });
  const ids = (t) => post(sb, 'clockMapList', {}, t).data.suggested.map((m) => m.emp_id).sort().join();
  ok(ids(mgrGF.token) === 'V1' && ids(mgrJS.token) === 'V2', 'VIS ★單位空的未認領者：各店店長只看到自己店那家的對照', [ids(mgrGF.token), ids(mgrJS.token)]);
  ok(post(sb, 'clockMapList', {}, mgrGF.token).data.suggested[0].unit === '', 'VIS 單位欄位為空（前端顯示未認領）');
  ok(post(sb, 'clockMapDecide', { store_code: 'mztjs', emp_id: 'V2', decision: 'confirm' }, mgrGF.token).code === 'no_perm', 'VIS ★別店店長不能決定這家的對照');
  ok(post(sb, 'clockMapDecide', { store_code: 'mztjs', emp_id: 'V2', decision: 'reject' }, mgrGF.token).code === 'no_perm', 'VIS 別店店長也不能退回');
  ok(post(sb, 'clockAlerts', {}, mgrGF.token).data.pending_confirm.count === 1 && post(sb, 'clockAlerts', {}, mgrJS.token).data.pending_confirm.items[0].emp_id === 'V2', 'VIS 待確認數 alerts 同樣以店為準');
  const ul = post(sb, 'staffUnitList', {}, mgrJS.token).data.people;
  const row = ul.find((p) => p.emp_no === u);
  ok(row && row.unit_empty === true && row.unit === '', 'VIS ★staffUnitList：單位空、在本店有對照的未認領者看得到（unit_empty）');
  const ulGF = post(sb, 'staffUnitList', {}, mgrGF.token).data.people;
  ok(ulGF.some((p) => p.emp_no === u), 'VIS 光復店長也看得到（他在光復也有對照）');
  const other = claimApprove(app, '見他店店長', 'mgr-vis-pw-003', { brand: 'mzt', unit: 'mzt-lzl', title: 'sm' });
  ok(!post(sb, 'staffUnitList', {}, other.token).data.people.some((p) => p.emp_no === u) && ids(other.token) === '', 'VIS ★第三家店的店長看不到');
  ok(post(sb, 'clockMapDecide', { store_code: 'mztjs', emp_id: 'V2', decision: 'confirm' }, mgrJS.token).ok, 'VIS 金山店長可以確認自己店的');
})();

(() => {
  // ── 總部指定主店（釘選）clockSetHome ──
  const app = fresh();
  const { sb, sheets, tok, props } = app;
  const mgr = claimApprove(app, '釘店長', 'mgr-pin-pw-001', MZT_GF('sm'));
  post(sb, 'staffImport', { names: ['釘人甲', '釘人乙', '釘單位人'] }, tok);
  const E = (n) => sheets.staff._rows().find((r) => r[2] === n)[0];
  const a = E('釘人甲'), b = E('釘人乙'), u = E('釘單位人');
  giveMap(app, a, 'mztgf', 'P1', 'home', { last_punch: '2026-10-10' });
  giveMap(app, a, 'hq', 'P2', 'support', { last_punch: '2026-09-01' });
  giveMap(app, a, 'mztjs', 'P3', 'support', { last_punch: '2026-10-01' });
  giveMap(app, a, 'cf', 'P4', 'support', { state: 'suggested', source: 'name_match' });
  const roles = (emp) => mapOf(app, emp).map((m) => m.store_code + ':' + m.role + ':' + m.state).sort().join();
  ok(post(sb, 'clockSetHome', { emp_no: a, store_code: 'hq' }, mgr.token).code === 'no_perm', 'PIN ★非總部（店長）被拒');
  ok(post(sb, 'clockSetHome', { emp_no: a, store_code: 'cf' }, tok).code === 'bad_input', 'PIN ★該店只有 suggested、沒有 confirmed 對照 → bad_input');
  ok(post(sb, 'clockSetHome', { emp_no: a, store_code: 'mztlzl' }, tok).code === 'bad_input' && post(sb, 'clockSetHome', { emp_no: a, store_code: 'nope' }, tok).code === 'bad_input', 'PIN 完全沒對照的店、不認得的店 → bad_input');
  ok(post(sb, 'clockSetHome', { emp_no: 'DZY999', store_code: 'hq' }, tok).code === 'not_found', 'PIN 找不到同仁');
  const jobsBefore = jobs(app).length;
  const r = post(sb, 'clockSetHome', { emp_no: a, store_code: 'hq' }, tok);
  ok(r.ok && r.data.pinned === true && JSON.parse(props.CLOCK_HOME_PIN)[a] === 'hq', 'PIN 釘選寫進 Script Property CLOCK_HOME_PIN', r);
  ok(roles(a) === 'cf:support:suggested,hq:home:confirmed,mztgf:support:confirmed,mztjs:support:confirmed', 'PIN ★立刻對調：hq 對照 home、其他 confirmed 改 support，suggested 不動、state 不變', roles(a));
  ok(jobs(app).length === jobsBefore, 'PIN ★不發任何打卡單');
  ok(sheets.staff_log._rows().some((x) => x[1] === a && x[2] === 'home_pin' && x[4] === 'hq'), 'PIN 寫 staff_log（home_pin）');
  // 每日重算不覆蓋（mztjs 打卡變成最近）
  setMap(app, 'mztjs', 'P3', 'last_punch', '2026-10-13');
  sb.clockDailyApply_(dayT(0));
  ok(roles(a).indexOf('hq:home:confirmed') !== -1 && roles(a).indexOf('mztjs:support') !== -1, 'PIN ★每日重算不被較近的打卡資料覆蓋', roles(a));
  // 對照：沒釘選的人會跟著打卡走
  giveMap(app, b, 'mztgf', 'Q1', 'home', { last_punch: '2026-10-01' }); giveMap(app, b, 'mztjs', 'Q2', 'support', { last_punch: '2026-10-13' });
  sb.clockDailyApply_(dayT(0));
  ok(mapOf(app, b).find((m) => m.store_code === 'mztjs').role === 'home', 'PIN 對照組：沒釘選的人每日重算跟著最近打卡');
  // clockMapList 帶 pinned
  const lst = post(sb, 'clockMapList', {}, tok).data.confirmed;
  ok(lst.find((x) => x.emp_id === 'P2').pinned === true && lst.find((x) => x.emp_id === 'P1').pinned === false, 'PIN ★clockMapList 每列帶 pinned 布林');
  // 釘選的對照被停用 → 失效
  setMap(app, 'hq', 'P2', 'roster_active', 'FALSE');
  sb.clockDailyApply_(dayT(0));
  ok(mapOf(app, a).find((m) => m.store_code === 'mztjs').role === 'home' && mapOf(app, a).find((m) => m.store_code === 'hq').role === 'support', 'PIN ★釘選的對照被停用 → 釘選失效，回到打卡推斷', roles(a));
  setMap(app, 'hq', 'P2', 'roster_active', 'TRUE');
  // 清除釘選
  const c = post(sb, 'clockSetHome', { emp_no: a, store_code: 'hq' }, tok);
  ok(c.ok && roles(a).indexOf('hq:home') !== -1, 'PIN （重新釘選）');
  const clr = post(sb, 'clockSetHome', { emp_no: a, store_code: '' }, tok);
  ok(clr.ok && clr.data.pinned === false && !('' + app.props.CLOCK_HOME_PIN).includes(a) && mapOf(app, a).find((m) => m.store_code === 'mztjs').role === 'home', 'PIN ★清除釘選後回到打卡推斷（mztjs 最近打卡）', roles(a));
  ok(post(sb, 'clockSetHome', { emp_no: a, store_code: '' }, mgr.token).code === 'no_perm', 'PIN 清除也只限總部');
  // DZY 單位有值時單位優先
  post(sb, 'staffEdit', { emp_no: u, brand: 'mzt', unit: 'mzt-gf', dept: '', title: 'pt' }, tok);
  giveMap(app, u, 'mztgf', 'U1', 'support', { state: 'suggested', source: 'name_match', last_punch: '2026-09-01' });
  giveMap(app, u, 'hq', 'U2', 'support', { state: 'confirmed', last_punch: '2026-10-13' });
  app.props.CLOCK_HOME_PIN = JSON.stringify(Object.assign(JSON.parse(app.props.CLOCK_HOME_PIN || '{}'), { [u]: 'hq' }));
  const h = sb.clkHomeStoreFor_(sb.clkStaffByEmp_(u), sb.clkMaps_());
  ok(h.store === 'mztgf' && h.by === 'unit', 'PIN ★DZY 單位有值 → 單位優先，釘選不生效', h);
  const h2 = sb.clkHomeStoreFor_(sb.clkStaffByEmp_(a), sb.clkMaps_());
  ok(h2.by === 'infer', 'PIN 優先順序：沒釘選也沒單位 → 推斷', h2);
  // Code.gs：寫入類 action 上鎖
  const mut = /MUTATING_ACTIONS = \{([\s\S]*?)\};/.exec(SRC.find(([f]) => f === 'Code.gs')[1])[1];
  ok(mut.indexOf('clockSetHome: 1') !== -1, 'PIN clockSetHome 上全域寫入鎖');
})();

(() => {
  // ── 第 4 段：總部在主店補建打卡帳號 clockAddHome（no_home_map 異常列）──
  const app = fresh();
  const { sb, sheets, tok } = app;
  const mgr = claimApprove(app, '補建店長', 'mgr-addh-pw-01', MZT_GF('sm'));
  post(sb, 'staffImport', { names: ['補建總部甲', '補建有對照乙', '補建無單位丙', '補建停用丁', '補建離職戊', '補建美村己'] }, tok);
  const E = (n) => sheets.staff._rows().find((r) => r[2] === n)[0];
  const a = E('補建總部甲'), b = E('補建有對照乙'), c = E('補建無單位丙'), dd = E('補建停用丁'), ee = E('補建離職戊'), ff = E('補建美村己');
  const setUnit = (emp, o) => { const r = post(sb, 'staffEdit', Object.assign({ emp_no: emp, dept: '' }, o), tok); if (!r.ok) throw new Error('staffEdit ' + r.error); };
  setUnit(a, { brand: 'mzt', unit: 'mzt-hq', title: 'ofs' });
  setUnit(b, { brand: 'mzt', unit: 'mzt-gf', title: 'pt' });
  setUnit(dd, { brand: 'mzt', unit: 'mzt-gf', title: 'pt' });
  setUnit(ee, { brand: 'mzt', unit: 'mzt-gf', title: 'pt' });
  setUnit(ff, { brand: 'yiwu', unit: 'yiwu-wx', title: 'pt' });
  ok(staffOf(app, a).unit === 'mzt-hq', 'ADDH （前置：甲單位＝墨竹亭總部）', staffOf(app, a));
  giveMap(app, a, 'mztgf', 'H1', 'home', { last_punch: '' });     // 只在別店有一個沒打過卡的帳號
  giveMap(app, b, 'mztgf', 'H2', 'support');                       // 主店已有 confirmed（只是 role 不對）
  post(sb, 'staffSetActive', { emp_no: dd, active: false }, tok);
  setStaff(app, ee, 'last_day', dayT(-2));
  const nh = post(sb, 'clockAlerts', {}, tok).data.no_home_map;
  ok(nh.indexOf(a) !== -1, 'ADDH 甲在 no_home_map（總部打卡沒帳號、只有別店對照）', nh);
  const row = (emp, t) => post(sb, 'staffList', {}, t || tok).data.staff.find((p) => p.emp_no === emp);
  ok(row(a).no_home === true && row(c).no_home === false && row(dd).no_home === false, 'ADDH ★staffList 每列帶 no_home，與 no_home_map 同一套判斷', [row(a).no_home, row(c).no_home]);
  ok(post(sb, 'staffUnitList', { unit: 'mzt-hq' }, tok).data.people.find((p) => p.emp_no === a).no_home === true, 'ADDH staffUnitList 也帶 no_home');

  const jobsBefore = jobs(app).length;
  // 店長被擋
  const byMgr = post(sb, 'clockAddHome', { emp_no: b }, mgr.token);
  ok(byMgr.ok === false && byMgr.code === 'no_perm' && jobs(app).length === jobsBefore, 'ADDH ★店長（即使是同單位）被擋 no_perm、不開單', byMgr);
  ok(post(sb, 'clockAddHome', { emp_no: a }, '').ok === false && jobs(app).length === jobsBefore, 'ADDH 沒登入被擋');
  // 各種不符合
  const r404 = post(sb, 'clockAddHome', { emp_no: 'DZY999' }, tok);
  ok(r404.code === 'not_found', 'ADDH 找不到同仁 → not_found', r404);
  const rB = post(sb, 'clockAddHome', { emp_no: b }, tok);
  ok(rB.ok === false && rB.code === 'dup_confirmed' && rB.error.indexOf('mztgf:H2') !== -1, 'ADDH ★主店已有 confirmed 對照 → dup_confirmed（訊息帶店與編號）', rB);
  const rC = post(sb, 'clockAddHome', { emp_no: c }, tok);
  ok(rC.ok === false && rC.code === 'no_unit' && /單位/.test(rC.error), 'ADDH ★沒有單位 → no_unit', rC);
  const rD = post(sb, 'clockAddHome', { emp_no: dd }, tok);
  ok(rD.ok === false && rD.code === 'already_disabled', 'ADDH ★已停用 → already_disabled', rD);
  const rE = post(sb, 'clockAddHome', { emp_no: ee }, tok);
  ok(rE.ok === false && rE.code === 'already_left' && /離職/.test(rE.error), 'ADDH ★離職日已過 → already_left', rE);
  const rF = post(sb, 'clockAddHome', { emp_no: ff }, tok);
  ok(rF.ok === false && rF.code === 'no_clock_store', 'ADDH 單位沒有對應打卡店（美村）→ no_clock_store', rF);
  ok(jobs(app).length === jobsBefore, 'ADDH 以上全部沒有寫任何待辦單');

  // 總部成功
  const r = post(sb, 'clockAddHome', { emp_no: a }, tok);
  ok(r.ok && r.data.emp_no === a && r.data.store_code === 'hq' && r.data.state === 'pending' && /^J\d{14}-[0-9a-f]{4}$/.test(r.data.job_id), 'ADDH ★總部成功：回 job_id、store hq、pending', r);
  const j = jobs(app).find((x) => x.job_id === r.data.job_id);
  const ex = JSON.parse(j.expect_json);
  ok(j.kind === 'add' && j.emp_no === a && j.store_code === 'hq' && j.name === '補建總部甲' && j.op_id === 'dzy:' + j.job_id && j.emp_id === '', 'ADDH ★add 單欄位照 staffCreateByUnit 寫法（kind add、主店、姓名、op_id）', j);
  ok(ex.emp_no === a && ex.store_code === 'hq' && ex.name === '補建總部甲' && ex.uid === 'u001' && ex.demote_old === true && ex.by !== '', 'ADDH expect 帶 emp_no／store／name／by／uid＋demote_old', ex);
  ok(sheets.staff_log._rows().some((x) => x[1] === a && x[2] === 'add_home' && String(x[4]).indexOf(j.job_id) !== -1), 'ADDH 寫 staff_log（add_home，含待辦單號）');
  ok(mapOf(app, a).length === 1 && mapOf(app, a)[0].role === 'home', 'ADDH 開單當下不動既有對照');
  ok(row(a).no_home === false && row(a).clock_job && row(a).clock_job.job_id === j.job_id, 'ADDH 開單後 no_home 轉 false、名單顯示建檔中（clock_job）');
  ok(post(sb, 'clockAlerts', {}, tok).data.no_home_map.indexOf(a) === -1, 'ADDH 開單後從 no_home_map 消失');
  // 已有未完成的 add 單 → 擋
  const again = post(sb, 'clockAddHome', { emp_no: a }, tok);
  ok(again.ok === false && again.code === 'job_open' && again.error.indexOf(j.job_id) !== -1 && jobs(app).length === jobsBefore + 1, 'ADDH ★同店已有未完成 add 單 → job_open、不重複開', again);
  // 同步員做完 → hq home confirmed；原 home（mztgf）改 support 並問總部
  sb.clockOutboxClaim_(nowT(1));
  const done = sb.clockOutboxDone_(j.job_id, { ok: true, emp_id: 'HQ77' }, nowT(2));
  ok(done.ok && done.data.state === 'done', 'ADDH 同步員回填成功', done);
  const ms = mapOf(app, a).map((m) => m.store_code + ':' + m.emp_id + ':' + m.role + ':' + m.state).sort().join();
  ok(ms === 'hq:HQ77:home:confirmed,mztgf:H1:support:confirmed', 'ADDH ★建好後 hq 為 home、舊主店改 support', ms);
  ok(post(sb, 'clockAlerts', {}, tok).data.transfer_ask.some((x) => x.emp_no === a && x.store_code === 'mztgf'), 'ADDH 舊主店進 transfer_ask 讓總部決定要不要停');
  const after = post(sb, 'clockAddHome', { emp_no: a }, tok);
  ok(after.code === 'dup_confirmed', 'ADDH 建好後再按 → dup_confirmed', after);
  // 註冊、上鎖
  ok(sb.CODE_ALLOWED_ACTIONS.indexOf('clockAddHome') !== -1, 'ADDH 分派白名單有 clockAddHome');
  const mut = /MUTATING_ACTIONS = \{([\s\S]*?)\};/.exec(SRC.find(([f]) => f === 'Code.gs')[1])[1];
  ok(mut.indexOf('clockAddHome: 1') !== -1, 'ADDH clockAddHome 上全域寫入鎖');
})();

// ── SSO：公告專區自動登入佈告欄（2026-10-16）───────────────────
(() => {
  const app = fresh();
  const { sb, tok, props, cache } = app;
  const st = claimApprove(app, '單登同仁甲', 'sso-pw-0001');
  const tk = (t, p) => post(sb, 'ssoTicket', p === undefined ? { aud: 'bulletin' } : p, t);
  const rd = (p) => post(sb, 'svcSsoRedeem', p);
  // 發券
  ok(tk('').ok === false, 'SSO 沒登入 → 不發券');
  ok(tk(st.token, { aud: 'evil' }).code === 'bad_aud' && tk(st.token, {}).code === 'bad_aud' && tk(st.token, { aud: 'hasOwnProperty' }).code === 'bad_aud', 'SSO ★aud 不是 bulletin → bad_aud（含原型鍵）');
  ok(tk(tok).code === 'no_emp', 'SSO ★系統帳號（admin）沒有同仁編號 → no_emp');
  const t1 = tk(st.token);
  ok(t1.ok && /^[0-9a-f]{64}$/.test(t1.data.ticket) && t1.data.expires_in === 60, 'SSO 同仁拿到 64 位十六進位券、60 秒', t1);
  ok(JSON.stringify(t1).indexOf(st.emp) === -1, 'SSO 發券回應不含同仁編號');
  ok(tk(st.token).data.ticket !== t1.data.ticket, 'SSO 每次的券都不同');
  // 兌換
  ok(rd({ ticket: t1.data.ticket, aud: 'bulletin' }).code === 'unauthorized', 'SSO ★沒設 BULLETIN_SVC_KEY → 兌換全拒');
  props.BULLETIN_SVC_KEY = 'fake-bulletin-key-0001';
  ok(rd({ svc_key: 'wrong', ticket: t1.data.ticket, aud: 'bulletin' }).code === 'unauthorized', 'SSO ★錯金鑰 → unauthorized');
  ok(cache.has('sso_tkt:' + t1.data.ticket), 'SSO 錯金鑰不會把券用掉');
  ok(rd({ svc_key: 'fake-bulletin-key-0001', ticket: t1.data.ticket, aud: 'other' }).code === 'ticket_invalid', 'SSO ★aud 不符 → ticket_invalid');
  ok(rd({ svc_key: 'fake-bulletin-key-0001', ticket: t1.data.ticket, aud: 'bulletin' }).code === 'ticket_invalid', 'SSO ★aud 不符那次已把券作廢');
  const t2 = tk(st.token).data.ticket;
  const r2 = rd({ svc_key: 'fake-bulletin-key-0001', ticket: t2, aud: 'bulletin' });
  ok(r2.ok && r2.data.emp_no === st.emp && Object.keys(r2.data).join() === 'emp_no', 'SSO ★兌換成功只回 emp_no', r2);
  ok(rd({ svc_key: 'fake-bulletin-key-0001', ticket: t2, aud: 'bulletin' }).code === 'ticket_invalid', 'SSO ★同一張券只能換一次');
  // 兌換要上鎖（2026-10-28 #5，比照 PurchaseSso）：拿不到鎖 → busy、券不動；拿得到鎖才取出並作廢
  {
    const t5 = tk(st.token).data.ticket;
    const realLock = sb.LockService;
    let tries = 0, releases = 0;
    sb.LockService = { getScriptLock: () => ({ tryLock: () => { tries++; return false; }, releaseLock() { releases++; } }) };
    const busy = rd({ svc_key: 'fake-bulletin-key-0001', ticket: t5, aud: 'bulletin' });
    ok(busy.code === 'busy' && tries === 1 && cache.has('sso_tkt:' + t5), 'SSO ★兌換拿不到鎖 → busy、券沒被用掉', busy);
    sb.LockService = { getScriptLock: () => ({ tryLock: () => { tries++; return true; }, releaseLock() { releases++; } }) };
    const got = rd({ svc_key: 'fake-bulletin-key-0001', ticket: t5, aud: 'bulletin' });
    ok(got.ok && tries === 2 && releases === 1 && !cache.has('sso_tkt:' + t5), 'SSO ★兌換在鎖內取出並作廢、用完放鎖', { got, tries, releases });
    sb.LockService = realLock;
  }
  ok(rd({ svc_key: 'fake-bulletin-key-0001', ticket: 'abc', aud: 'bulletin' }).code === 'ticket_invalid' && rd({ svc_key: 'fake-bulletin-key-0001', ticket: ['x'], aud: 'bulletin' }).code === 'ticket_invalid', 'SSO 券格式不對 → ticket_invalid');
  // 過期
  const t3 = tk(st.token).data.ticket;
  cache.get('sso_tkt:' + t3).exp = Date.now() - 1;
  ok(rd({ svc_key: 'fake-bulletin-key-0001', ticket: t3, aud: 'bulletin' }).code === 'ticket_invalid', 'SSO ★過期 → ticket_invalid');
  // 停用的人拿不到新券
  post(sb, 'staffSetActive', { emp_no: st.emp, active: false }, tok);
  ok(tk(st.token).ok === false, 'SSO ★停用後舊登入換不到券');
  ok(sb.CODE_ALLOWED_ACTIONS.indexOf('ssoTicket') !== -1 && sb.CODE_ALLOWED_ACTIONS.indexOf('svcSsoRedeem') !== -1, 'SSO 分派白名單有兩支');
})();

// ── 公告管理權限＋bulletin-admin 入場券（2026-10-17；2026-10-26 權限搬進「權限設定」，同仁名單不再勾選）────────────────
(() => {
  const app = fresh();
  const { sb, tok, props } = app;
  props.BULLETIN_SVC_KEY = 'fake-bulletin-key-0001';
  const st = claimApprove(app, '公告同仁乙', 'bul-pw-0001');
  const other = claimApprove(app, '公告同仁丙', 'bul-pw-0002');
  // 總監級（hm，不分部門）：預設規則 R028 給 platform.bulletin
  const dir = claimApprove(app, '公告總監庚', 'bul-pw-0006', { brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hm' });
  post(sb, 'permInit', {}, tok);
  props.PERMS_ON = '1';
  const tkA = (t) => post(sb, 'ssoTicket', { aud: 'bulletin-admin' }, t);
  const rd = (ticket, aud) => post(sb, 'svcSsoRedeem', { svc_key: 'fake-bulletin-key-0001', ticket, aud });
  const perms = (t) => post(sb, 'me', {}, t).data.perms;
  const listed = (emp) => post(sb, 'staffList', {}, tok).data.staff.find((p) => p.emp_no === emp);
  const MOVED = '公告管理已改到「權限設定」設定，請重新整理頁面';
  ok(sb.STF_MSG.BULLETIN_MOVED === MOVED, 'BUL 搬家提示文案固定');
  // (c) 沒有規則、沒有例外 → 沒有 platform.bulletin、換不到管理券
  ok(tkA(st.token).code === 'no_perm' && perms(st.token).indexOf('platform.bulletin') === -1, 'BUL 沒規則也沒例外 → 沒有 platform.bulletin、換不到管理券');
  // (b) 同仁名單不再有 bulletin_admin 欄位
  ok(!('bulletin_admin' in listed(st.emp)) && post(sb, 'staffList', {}, tok).data.staff.every((p) => !('bulletin_admin' in p)), 'BUL ★同仁名單物件沒有 bulletin_admin 鍵');
  // (a) 任何人帶 bulletin_admin（true／false／'yes'）→ 一律回搬家提示、什麼都不動
  const hr = claimApprove(app, '公告人資丁', 'bul-pw-0003');
  const ui = app.sheets.users._data.findIndex((r) => String(r[1]).toUpperCase() === hr.emp);
  setCell(app, 'users', ui, 'role', 'hr');
  const snap = () => JSON.stringify([rowsOf(app, 'staff'), rowsOf(app, 'staff_log'), rowsOf(app, 'perm_ex'), rowsOf(app, 'perm_audit'), props.BULLETIN_ADMINS || '']);
  const before = snap();
  [[true, tok, 'admin'], [false, tok, 'admin'], ['yes', tok, 'admin'], [true, hr.token, '人資'], [false, hr.token, '人資'], ['yes', hr.token, '人資'], [true, other.token, '一般同仁'], [true, st.token, '本人（自己）'], [false, st.token, '本人（自己）']].forEach(([v, t, who]) => {
    const r = post(sb, 'staffEdit', { emp_no: st.emp, bulletin_admin: v }, t);
    ok(r.ok === false && r.error === MOVED, 'BUL ★' + who + ' 帶 bulletin_admin=' + JSON.stringify(v) + ' → 搬家提示', r);
  });
  ok(post(sb, 'staffEdit', { emp_no: st.emp, bulletin_admin: true, phone: '0922333444' }, tok).error === MOVED && listed(st.emp).phone !== '0922333444', 'BUL ★跟其他欄位一起帶也整筆拒絕（電話沒被改）');
  ok(post(sb, 'staffEdit', { emp_no: 'DZY999', bulletin_admin: true }, tok).error === MOVED, 'BUL 不存在的編號也先回搬家提示（先於其他檢查）');
  ok(snap() === before, 'BUL ★被拒的請求不改名單、不寫紀錄、不動 perm_ex／BULLETIN_ADMINS');
  ok(tkA(st.token).code === 'no_perm', 'BUL 被拒後仍沒有管理權');
  // 一般欄位照常可改
  ok(post(sb, 'staffEdit', { emp_no: st.emp, phone: '0922333444' }, tok).ok, 'BUL 其他欄位（電話）照常可改');
  // (f) 舊的 Script Property BULLETIN_ADMINS 完全不再認
  props.BULLETIN_ADMINS = [st.emp, hr.emp, other.emp].join(',');
  ok(perms(st.token).indexOf('platform.bulletin') === -1 && tkA(st.token).code === 'no_perm', 'BUL ★BULLETIN_ADMINS 寫了工號也不給（舊制作廢，staff）');
  ok(perms(hr.token).indexOf('platform.bulletin') === -1 && tkA(hr.token).code === 'no_perm', 'BUL ★BULLETIN_ADMINS 寫了工號也不給（舊制作廢，人資角色）');
  ok(typeof sb.stfBulletinGate_ === 'undefined', 'BUL 舊的 stfBulletinGate_（讀 BULLETIN_ADMINS）已移除');
  ok(props.BULLETIN_ADMINS === [st.emp, hr.emp, other.emp].join(','), 'BUL 系統不再改寫 BULLETIN_ADMINS');
  delete props.BULLETIN_ADMINS;
  // (e) 總監級職稱：預設規則 R028 → 有 platform.bulletin、換得到管理券
  ok(perms(dir.token).indexOf('platform.bulletin') !== -1, 'BUL ★總監 hm（不分部門）靠預設規則有 platform.bulletin');
  ok(tkA(dir.token).ok, 'BUL 總監換得到管理券');
  // 降成一般職稱 → 立刻失去
  setStaff(app, dir.emp, 'title', 'hs');
  ok(perms(dir.token).indexOf('platform.bulletin') === -1 && tkA(dir.token).code === 'no_perm', 'BUL 總監改成同仁 → 立刻沒有 platform.bulletin');
  setStaff(app, dir.emp, 'title', 'hm');
  ok(perms(dir.token).indexOf('platform.bulletin') !== -1, 'BUL 改回總監又有');
  // (d) 個別例外：admin 給 st platform.bulletin → 同一個登入就有（每次請求重算）、換得到管理券
  const ex = post(sb, 'permExSave', { emp_no: st.emp, perm: 'platform.bulletin', mode: 'add', until: '', note: '公告管理' }, tok);
  ok(ex.ok && /^X\d+/.test(ex.data.ex_id), 'BUL admin 給個別例外 platform.bulletin', ex);
  ok(perms(st.token).indexOf('platform.bulletin') !== -1, 'BUL ★例外生效後同一個登入就有 platform.bulletin（每次請求重算）');
  ok(perms(other.token).indexOf('platform.bulletin') === -1, 'BUL 別人不受影響');
  const t1 = tkA(st.token);
  ok(t1.ok && /^[0-9a-f]{64}$/.test(t1.data.ticket), 'BUL 有權限 → 拿到管理券');
  ok(rd(t1.data.ticket, 'bulletin').code === 'ticket_invalid', 'BUL ★管理券不能當一般登入券用（aud 不符，且作廢）');
  const t2 = tkA(st.token).data.ticket, r2 = rd(t2, 'bulletin-admin');
  ok(r2.ok && r2.data.admin === true && r2.data.emp_no === st.emp && r2.data.name === '公告同仁乙', 'BUL ★兌換回 admin＋編號＋名字', r2);
  ok(rd(t2, 'bulletin-admin').code === 'ticket_invalid', 'BUL 管理券同樣只能換一次');
  const tb = post(sb, 'ssoTicket', { aud: 'bulletin' }, st.token).data.ticket;
  ok(rd(tb, 'bulletin-admin').code === 'ticket_invalid', 'BUL ★一般登入券不能拿去換管理權');
  // admin（'*'）沒有 DZY 編號也能管理
  const ta = tkA(tok).data.ticket, ra = rd(ta, 'bulletin-admin');
  ok(ra.ok && ra.data.emp_no === '' && ra.data.uid === 'u001' && ra.data.name === '系統管理者', 'BUL ★admin 換得到管理券（編號空、帶帳號 id 與名字）', ra);
  // 撤銷例外、停用都收回
  ok(post(sb, 'permExRevoke', { ex_id: ex.data.ex_id }, tok).ok && perms(st.token).indexOf('platform.bulletin') === -1 && tkA(st.token).code === 'no_perm', 'BUL ★撤銷例外 → 立刻換不到管理券');
  post(sb, 'permExSave', { emp_no: other.emp, perm: 'platform.bulletin', mode: 'add', until: '', note: '公告管理' }, tok);
  ok(tkA(other.token).ok, 'BUL 前提：丙有例外就換得到');
  post(sb, 'staffSetActive', { emp_no: other.emp, active: false }, tok);
  ok(tkA(other.token).ok === false, 'BUL ★停用後換不到管理券');
  // 例外 remove 模式：總監被拿掉 platform.bulletin
  post(sb, 'permExSave', { emp_no: dir.emp, perm: 'platform.bulletin', mode: 'remove', until: '', note: '暫停公告' }, tok);
  ok(perms(dir.token).indexOf('platform.bulletin') === -1 && tkA(dir.token).code === 'no_perm', 'BUL 總監被個別例外 remove → 沒有 platform.bulletin');
  // 開關關閉（PERMS_ON 不是 1）→ staff 帳號沒有 platform.bulletin（規則與例外都不算）
  props.PERMS_ON = '0';
  ok(perms(dir.token).indexOf('platform.bulletin') === -1 && tkA(dir.token).code === 'no_perm', 'BUL ★權限開關關閉 → 總監也沒有 platform.bulletin（fail closed）');
  props.PERMS_ON = '1';
  // 未認領列：沒有登入、不影響
  post(sb, 'staffImport', { names: ['公告未認領戊'] }, tok);
  const un = rowsOf(app, 'staff').find((r) => r.name === '公告未認領戊');
  ok(un && un.status === 'unclaimed' && post(sb, 'staffEdit', { emp_no: un.emp_no, bulletin_admin: true }, tok).error === MOVED, 'BUL 未認領列帶 bulletin_admin 一樣是搬家提示');
})();

// ============================================================
// P2-N1 非 admin 人資建出「會拿到鎖碼」的列（新增→認領→確認）要被擋
// ============================================================
(() => {
  const app = fresh();
  const { sb, tok } = app;
  const hr = claimApprove(app, '人資同仁甲', 'hr-a-pw-0001', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' });
  post(sb, 'permInit', {}, tok);
  app.props.PERMS_ON = '1';
  const body = { name: '新主管甲', dept: 'hr', unit: 'dzy-hq', title: 'hm', hire_date: dayT(-1), phone: '0922000777' };
  const before = app.sheets.staff._rows().length;
  const r = post(sb, 'staffCreateByUnit', body, hr.token);
  ok(r.ok === false && r.code === 'perm_admin_only' && app.sheets.staff._rows().length === before, 'N1a 非 admin 人資新增會拿到鎖碼的同仁列 → perm_admin_only、不寫列', r);
  const okRow = post(sb, 'staffCreateByUnit', Object.assign({}, body, { name: '新同仁乙', dept: 'ops', title: 'hs' }), hr.token);
  ok(okRow.ok, 'N1a 一般同仁照放', okRow);
  const adm = post(sb, 'staffCreateByUnit', Object.assign({}, body, { name: '新主管丙' }), tok);
  ok(adm.ok, 'N1a admin 新增同一種列 → 成功', adm);
  // 縱深：未認領列（組織欄已填好）被認領後，非 admin 確認要擋；admin 確認放行
  post(sb, 'staffImport', { names: ['直寫列丁'] }, tok);
  const lk = post(sb, 'claimLookup', { name: '直寫列丁' });
  setStaff(app, lk.data.emp_no, 'brand', 'dzy'); setStaff(app, lk.data.emp_no, 'unit', 'dzy-hq');
  setStaff(app, lk.data.emp_no, 'dept', 'hr'); setStaff(app, lk.data.emp_no, 'title', 'hm');
  const sub = post(sb, 'claimSubmit', { name: '直寫列丁', emp_no: lk.data.emp_no, password: 'fake-d-pw-0001', brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hm', birthday: '1990-01-02', phone: '0922000778', address: '新竹市測試路9號' });
  ok(sub.ok, 'N1b 前置：認領成功', sub);
  const cf = post(sb, 'staffConfirm', { emp_no: lk.data.emp_no }, hr.token);
  ok(cf.ok === false && cf.code === 'perm_admin_only', 'N1b 未認領列已填鎖碼組織欄 → 非 admin 確認被擋', cf);
  ok(post(sb, 'staffConfirm', { emp_no: lk.data.emp_no }, tok).ok, 'N1b admin 確認 → 成功');
})();

// P2-N3 復職（staffReinstate）後對方若有權限 → 寫 perm_audit（added）
(() => {
  const app = fresh();
  const { sb, tok, sheets } = app;
  const sm = claimApprove(app, '店長復職甲', 'mgr-r-pw-0001', MZT_GF('sm'));
  post(sb, 'permInit', {}, tok);
  app.props.PERMS_ON = '1';
  ok(post(sb, 'staffSetActive', { emp_no: sm.emp, active: false }, tok).ok, 'N3c 前置：停用');
  const n0 = sheets.perm_audit._rows().length;
  const re = post(sb, 'staffReinstate', { emp_no: sm.emp, stores: [] }, tok);
  const rows = sheets.perm_audit._rows();
  const last = rows[rows.length - 1];
  ok(re.ok && rows.length === n0 + 1 && last[2] === sm.emp && String(last[3]).length > 0 && last[5] === 'staff_edit', 'N3c 復職後寫一列 perm_audit（added）', { re, last });
})();

// AS：clockMapBuildApply_ 自動確認（已確認身分的同仁，到非主店名冊多一個編號 → confirmed／support／auto_support_map）
(() => {
  const app = fresh();
  const { sb } = app;
  const mk = (n, over) => claimApprove(app, n, 'pw-' + n + '-0001', over || MZT_GF('pt'));
  const okp = mk('自動甲'), unc = (() => { post(sb, 'staffImport', { names: ['自動未認領'] }, app.tok); return post(sb, 'claimLookup', { name: '自動未認領' }).data; })();
  const noconf = mk('自動乙'), gone = mk('自動丙'), homeP = mk('自動丁', MZT_JS('pt')), rej = mk('自動戊');
  const dupA = mk('自動己'), dupB = mk('自動己');
  giveMap(app, okp.emp, 'mztgf', 'AH1', 'home');
  giveMap(app, unc.emp_no, 'mztgf', 'AH2', 'home', { last_punch: '2026-10-18' });
  giveMap(app, gone.emp, 'mztgf', 'AH3', 'home');
  giveMap(app, homeP.emp, 'mztgf', 'AH4', 'support');          // 丁主店在金山（單位 mzt-js），已有 confirmed 對照
  giveMap(app, rej.emp, 'mztgf', 'AH5', 'home');
  giveMap(app, rej.emp, 'mztjs', 'AR5', 'support', { state: 'rejected', source: 'name_match' });
  giveMap(app, dupA.emp, 'mztgf', 'AH6', 'home');
  setStaff(app, gone.emp, 'status', 'disabled');
  setStaff(app, dupB.emp, 'status', 'disabled');                 // 同名的另一位是停用者 → 不算「只有他一位」
  const ap = sb.clockMapBuildApply_({
    mztgf: [rosterRow('AH1', '自動甲'), rosterRow('AH2', '自動未認領'), rosterRow('AH3', '自動丙'), rosterRow('AH4', '自動丁'), rosterRow('AH5', '自動戊'), rosterRow('AH6', '自動己'), rosterRow('AN1', '自動乙')],
    mztjs: [rosterRow('AJ1', '自動甲'), rosterRow('AJ2', '自動未認領'), rosterRow('AJ3', '自動乙'), rosterRow('AJ4', '自動丙'), rosterRow('AJ5', '自動丁'), rosterRow('AR5', '自動戊'), rosterRow('AJ6', '自動己')]
  }, nowT(0));
  ok(ap.ok, 'AS 套用成功', ap);
  const one = (emp, store) => mapOf(app, emp, store).filter((m) => m.state !== 'rejected' || m.emp_id === 'AR5')[0];
  const a = mapOf(app, okp.emp, 'mztjs')[0];
  ok(a && a.state === 'confirmed' && a.role === 'support' && a.source === 'auto_support_map' && a.emp_id === 'AJ1' && a.confirmed_by !== '', 'AS ★符合全部條件 → confirmed／support／auto_support_map', a);
  ok(mapOf(app, okp.emp, 'mztgf')[0].role === 'home' && mapOf(app, okp.emp, 'mztgf')[0].emp_id === 'AH1', 'AS 主店那筆原樣（home）');
  const u = mapOf(app, unc.emp_no, 'mztjs')[0];
  ok(u && u.state === 'confirmed' && u.role === 'support' && u.source === 'auto_support_map', 'AS 單位未填的未認領者（已有 confirmed）也自動確認', u);
  const n = mapOf(app, noconf.emp, 'mztjs')[0];
  ok(n && n.state === 'suggested' && n.source === 'name_match', 'AS 沒有任何已確認對照 → 照舊 suggested', n);
  ok(mapOf(app, gone.emp, 'mztjs').length === 0, 'AS 停用同仁不自動、也不建對照（交總部）');
  ok(ap.data.needs_hq === 2 && jobs(app).length === 0, 'AS 不發任何打卡單', ap);
  const h = mapOf(app, homeP.emp, 'mztjs')[0];
  ok(h && h.state === 'suggested' && h.source === 'name_match' && h.role === 'home', 'AS ★這家是他的主店 → 照原流程 suggested', h);
  const r = mapOf(app, rej.emp, 'mztjs')[0];
  ok(r && r.state === 'rejected' && r.emp_id === 'AR5' && r.source === 'name_match', 'AS rejected 不被改', r);
  const d = mapOf(app, dupA.emp, 'mztjs')[0];
  ok(d && d.state === 'suggested' && d.source === 'name_match', 'AS 同名還有停用者 → 不算唯一，照舊 suggested', d);
  // 同名兩位在職 → ambiguous，不建任何列
  const x1 = mk('自動庚'), x2 = mk('自動庚');
  giveMap(app, x1.emp, 'mztgf', 'AH7', 'home');
  const ap2 = sb.clockMapBuildApply_({ mztgf: [rosterRow('AH7', '自動庚')], mztjs: [rosterRow('AJ7', '自動庚')] }, nowT(1));
  ok(ap2.ok && !maps(app).some((m) => m.emp_id === 'AJ7'), 'AS 同名兩位在職 → 不建對照（需總部處理）', ap2);
  const lg = rowsOf(app, 'staff_log').filter((l) => l.event === 'auto_support_map');
  ok(lg.length === 2 && lg.every((l) => l.detail.indexOf('自動') === -1 && /^mztjs:AJ[12]$/.test(l.detail)), 'AS staff_log 有記、不含姓名', lg);
  const ml = post(sb, 'clockMapList', {}, app.tok);
  ok(ml.data.confirmed.some((m) => m.emp_no === okp.emp && m.source === 'auto_support_map'), 'AS clockMapList 的 confirmed 帶出 source', ml.data.confirmed.map((m) => m.source));
  // 重跑冪等；總部可按「不對」
  const nb = maps(app).length;
  sb.clockMapBuildApply_({ mztgf: [rosterRow('AH1', '自動甲')], mztjs: [rosterRow('AJ1', '自動甲')] }, nowT(2));
  ok(maps(app).length === nb && mapOf(app, okp.emp, 'mztjs')[0].state === 'confirmed', 'AS 重跑不重複、不改');
  const no = post(sb, 'clockMapDecide', { emp_no: okp.emp, store_code: 'mztjs', emp_id: 'AJ1', decision: 'reject' }, app.tok);
  ok(no.ok && mapOf(app, okp.emp, 'mztjs')[0].state === 'rejected', 'AS 總部發現錯了仍可按「不對」', no);
})();

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
