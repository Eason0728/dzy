// node test/perms-actions.mock.test.mjs —— 個人帳號第二期 P2b：權限設定 action 與防呆（docs/permissions/task.md T2-3、spec §6／13／13.1）
// 做法同 staff.mock.test.mjs：Auth／Users／Staff／Perms／PermActions／Code 讀進同一個 vm sandbox，全程走 doPost。
// ⚠ 姓名、生日、手機、地址全是假資料（dzy 是 public repo）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'Perms.gs', 'PermActions.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

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
  const props = { HMAC_SECRET: 'fake-hmac-for-perm-actions' };
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
const rowsOf = (sheets, n) => (sheets[n] ? sheets[n]._rows() : null);
const hasCols = (r, o) => Object.keys(o).every((k) => String(r[k]) === String(o[k]));
const dayShift = (sb, n) => { const t = new Date(Date.now() + 8 * 3600 * 1000 + n * 86400000); return t.toISOString().slice(0, 10); };

// 通用場景：admin、人資主管、人資同仁、店長、財務、資訊、計時、美村店長
function scene() {
  const app = fresh();
  const { sb } = app;
  sb.__admin = adminTok(sb);
  const P = {
    hrHm: mk(sb, '人資主管', HQ('hr', 'hm')),
    hrHs: mk(sb, '人資同仁', HQ('hr', 'hs')),
    sm: mk(sb, '店長一', { brand: 'mala', unit: 'mala-gf', title: 'sm' }),
    fin: mk(sb, '財務同仁', HQ('fin', 'hs')),
    it: mk(sb, '資訊同仁', HQ('it', 'hs')),
    pt: mk(sb, '計時同仁', { brand: 'mala', unit: 'mala-gf', title: 'pt' }),
    smY: mk(sb, '一悟店長', { brand: 'yiwu', unit: 'yiwu-js', title: 'sm' }),
    ceo: mk(sb, '執行長', HQ('mgmt', 'ceo'))
  };
  return Object.assign(app, { P });
}
const init = (app) => post(app.sb, 'permInit', {}, app.sb.__admin);
const on = (app) => { app.props.PERMS_ON = '1'; };
// 開關開之後 token 不用重登（me 每次重算），但 login 時沒有 PERMS_ON 的 token 仍有效

// ============================================================
// 1. not_inited：表沒建 → 讀回 {inited:false}、寫回 not_inited，且不自動建表
// ============================================================
{
  const app = scene();
  const { sb, sheets, P } = app;
  const A = sb.__admin;
  for (const n of ['perm_map', 'perm_ex', 'perm_store_map', 'perm_audit']) ok(!sheets[n], '1 前置：沒初始化前沒有分頁 ' + n);
  const g = (a, p, t) => post(sb, a, p, t || A);
  ok(g('permMapGet').ok && g('permMapGet').data.inited === false, '1: permMapGet 未初始化 → {inited:false}', g('permMapGet'));
  ok(g('permExList').data.inited === false, '1: permExList → {inited:false}');
  ok(g('permStoreGet').data.inited === false, '1: permStoreGet → {inited:false}');
  ok(g('permAuditList').data.inited === false, '1: permAuditList → {inited:false}');
  for (const [a, p] of [['permMapSave', { add: [{ ladder: 'store', dept: '', title: 'sm', perm: 'dorm.read' }] }], ['permExSave', { emp_no: P.sm.emp, perm: 'dorm.read', mode: 'add', note: 'x' }], ['permExRevoke', { ex_id: 'X001' }], ['permStoreSave', { unit: 'mala-gf', audit_store: 'sxl-gf' }], ['permAuditSeen', { all: true }]]) {
    const r = g(a, p);
    ok(r.ok === false && r.code === 'not_inited', '1: ' + a + ' 未初始化 → not_inited', r);
  }
  for (const n of ['perm_map', 'perm_ex', 'perm_store_map', 'perm_audit']) ok(!sheets[n], '1: 讀寫都試過之後仍然沒有分頁 ' + n + '（不自動建表）');
  // permInit：非 admin 擋；admin 建四表、預設 33 條＋對照 5 筆；重跑不重複
  on(app);
  const bad = post(sb, 'permInit', {}, P.hrHm.token);
  ok(bad.ok === false && bad.code === 'no_perm', '1: permInit 非 admin（連人資主管）→ no_perm', bad);
  const lk0 = app.counters.locks;
  const r1 = g('permInit');
  ok(r1.ok && r1.data.created.length === 4 && r1.data.rules_seeded === 36 && r1.data.stores_seeded === 5, '1: admin permInit 建四表＋33 條＋5 筆對照（2026-10-26 加公告管理六條）', r1);
  ok(app.counters.locks > lk0, '1: permInit 拿了 LockService');
  ok(sheets.perm_map._rows().length === 37, '1: perm_map 37 列（表頭＋36）');
  const r2 = g('permInit');
  ok(r2.ok && r2.data.created.length === 0 && r2.data.rules_seeded === 0 && sheets.perm_map._rows().length === 37, '1: 重跑不重複', r2);
  const log = rowsOf(sheets, 'staff_log').filter((r) => r[2] === 'perm_init');
  ok(log.length === 2 && log.every((r) => /^created:/.test(r[4])), '1: staff_log 寫 perm_init（只有分頁名與數量）', log);
}

// ============================================================
// 2. 權限正反：誰能叫哪支
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, P } = app;
  const A = sb.__admin;
  const adminOnly = [['permExList', {}], ['permExSave', { emp_no: P.sm.emp, perm: 'dorm.read', mode: 'add', note: '測' }], ['permExRevoke', { ex_id: 'X001' }], ['permStoreSave', { unit: 'yiwu-js', audit_store: 'yiwu-js' }], ['permAuditList', {}], ['permAuditSeen', { all: true }], ['permInit', {}]];
  for (const [a, p] of adminOnly) {
    const viaHm = post(sb, a, p, P.hrHm.token);
    const viaSm = post(sb, a, p, P.sm.token);
    ok(viaHm.ok === false && viaHm.code === 'no_perm' && viaSm.ok === false && viaSm.code === 'no_perm', '2: ' + a + ' 只有 admin（人資主管、店長都 no_perm）', [viaHm, viaSm]);
    ok(post(sb, a, p, '').ok === false && post(sb, a, p, 'garbage').ok === false, '2: ' + a + ' 沒 token／亂 token 被擋');
  }
  // 2026-10-26：人資主管可設 platform.bulletin 例外的判斷在 StoreOps.gs（stfIsHrHead_），本檔不載入該檔 → 該案例見 storeops.mock 第 6 節
  for (const [a, p] of [['permMapGet', {}], ['permStoreGet', {}]]) {
    ok(post(sb, a, p, P.hrHm.token).ok === true, '2: ' + a + ' 人資主管（platform.permmap）可以');
    ok(post(sb, a, p, A).ok === true, '2: ' + a + ' admin 可以');
    const no = post(sb, a, p, P.sm.token);
    ok(no.ok === false && no.code === 'no_perm', '2: ' + a + ' 店長 no_perm', no);
    ok(post(sb, a, p, P.hrHs.token).ok === false, '2: ' + a + ' 人資同仁（沒有 permmap）被擋');
  }
  const noMapSave = post(sb, 'permMapSave', { add: [{ ladder: 'store', dept: '', title: 'sm', perm: 'dorm.read' }] }, P.sm.token);
  ok(noMapSave.ok === false && noMapSave.code === 'no_perm', '2: permMapSave 店長 no_perm', noMapSave);
  ok(post(sb, 'myPerms', {}, P.pt.token).ok === true && post(sb, 'myPerms', {}, A).ok === true, '2: myPerms 任何已登入都可以');
  ok(post(sb, 'myPerms', {}, '').ok === false, '2: myPerms 沒登入被擋');
  // 開關關：人資主管沒有 permmap → permMapGet 被擋（要等開關開）；admin 照常
  app.props.PERMS_ON = '0';
  ok(post(sb, 'permMapGet', {}, P.hrHm.token).ok === false && post(sb, 'permMapGet', {}, A).ok === true, '2: 開關關：人資主管的 permMapGet 被擋、admin 照常');
  // proxyAuthorize_ 不進分派表
  const px = post(sb, 'proxyAuthorize_', { ns: 'audit', action: 'getAll' }, A);
  ok(px.ok === false && px.error === '不支援的操作', '2: proxyAuthorize_ 仍不在分派表', px);
  ok(!/proxyAuthorize_/.test(fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8')), '2: Code.gs 原始碼沒有 proxyAuthorize_');
}

// ============================================================
// 3. permMapGet 內容、permMapSave（鎖碼、perm_self、整批拒絕、perm_audit、staff_log、鎖）
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, sheets, P, counters } = app;
  const A = sb.__admin;
  const g = post(sb, 'permMapGet', {}, A);
  ok(g.ok && g.data.inited && g.data.rules.length === 36 && g.data.grantable.length === 28 && g.data.grantable[18] === 'transfer.write' && g.data.grantable[13] === 'platform.bulletin' && g.data.locked.join() === 'platform.users,platform.permmap,audit.write,platform.staff,payroll.write,pnl.admin', '3: permMapGet 回 36 條規則、28 個可給功能（2026-10-27 營運巡檢五碼）、6 個鎖碼（2026-10-27 收支管理改回不鎖）', g.data && Object.keys(g.data));
  ok(g.data.titles.some((t) => t.code === 'osv' && t.rank === 2 && t.ladder === 'office') && g.data.depts.some((d) => d.code === 'hr') && g.data.names['audit.read'], '3: permMapGet 的 titles／depts／names 有內容（osv 職級 2）');
  const sav = (tok, add, remove) => post(sb, 'permMapSave', { add: add || [], remove: remove || [] }, tok);
  const R = (ladder, dept, title, perm) => ({ ladder, dept, title, perm });
  const before = sheets.perm_map._rows().length;

  // 鎖碼
  for (const perm of ['platform.permmap', 'platform.users', 'audit.write', 'platform.staff']) {
    const r = sav(P.hrHm.token, [R('hq', 'hr', '*', perm)]);
    ok(r.ok === false && r.code === 'perm_locked', '3: 非 admin 新增含 ' + perm + ' 的規則 → perm_locked', r);
  }
  // 2026-10-27 Eason「將四項改成人資都能開」：cashbook.write 不再是鎖碼（審查 B-01 的鎖碼撤回），這裡不再測 perm_locked
  for (const lp of ['platform.permmap', 'audit.write', 'platform.staff']) {
    const lockedRule = g.data.rules.find((r) => r.perm === lp);
    const rmLocked = sav(P.hrHm.token, [], [lockedRule.rule_id]);
    ok(rmLocked.ok === false && rmLocked.code === 'perm_locked', '3: 非 admin 刪 ' + lp + ' 規則 → perm_locked', rmLocked);
  }
  ok(sheets.perm_map._rows().length === before, '3: 被拒絕的請求沒有寫入任何列');
  // bad_perm／bad_target
  ok(sav(A, [R('hq', '', '*', 'platform.permex')]).code === 'bad_perm', '3: platform.permex 不能進對照表 → bad_perm');
  ok(sav(A, [R('hq', '', '*', '*')]).code === 'bad_perm', '3: * 不能進對照表 → bad_perm');
  ok(sav(A, [R('store', 'hr', 'sm', 'dorm.read')]).code === 'bad_target', '3: 門市規則填部門 → bad_target');
  ok(sav(A, [R('store', '', 'hm', 'dorm.read')]).code === 'bad_target', '3: 門市規則用總部職稱 → bad_target');
  ok(sav(A, [R('moon', '', '*', 'dorm.read')]).code === 'bad_target', '3: 未知階梯 → bad_target');
  ok(sav(A, []).code === 'bad_input' && sav(A, 'x').code === 'bad_input', '3: 空請求／格式錯 → bad_input');
  ok(sav(A, [R('store', '', 'sm', 'audit.read.own')]).code === 'dup_rule', '3: 重複規則 → dup_rule');
  ok(sav(A, [], ['R999']).code === 'no_rule', '3: 刪不存在的規則 → no_rule');
  // 整批拒絕：一好一壞，好的也不寫
  const mix = sav(P.hrHm.token, [R('store', '', 'ft', 'dorm.read'), R('hq', 'hr', '*', 'platform.permmap')]);
  ok(mix.ok === false && sheets.perm_map._rows().length === before, '3: 一好一壞整批拒絕、好的也不寫', mix);

  // perm_self：人資主管加一條會命中自己的規則 / 刪掉命中自己的規則
  const self1 = sav(P.hrHm.token, [R('hq', 'hr', 'hm', 'audit.read')]);
  ok(self1.ok === false && self1.code === 'perm_self', '3: 人資主管新增會讓自己多權限的規則 → perm_self', self1);
  const hrDorm = g.data.rules.find((r) => r.ladder === 'hq' && r.dept === 'hr' && r.title === '*' && r.perm === 'dorm.write');
  const self2 = sav(P.hrHm.token, [], [hrDorm.rule_id]);
  ok(self2.ok === false && self2.code === 'perm_self', '3: 人資主管刪掉命中自己的規則 → perm_self', self2);
  ok(sheets.perm_map._rows().length === before && sheets.perm_audit._rows().length === 1, '3: perm_self 沒寫任何東西（perm_map 列數不變、perm_audit 無新列）');

  // 正向：人資主管給「門市 ft」宿舍查看（不影響自己）→ 成功；受影響 = 所有 ft……沒有 ft，改 sm
  const lk0 = counters.locks;
  const auditRows0 = sheets.perm_audit._rows().length;
  const okAdd = sav(P.hrHm.token, [R('store', '', 'sm', 'dorm.read')]);
  ok(okAdd.ok && okAdd.data.added.length === 1 && /^R\d{3}$/.test(okAdd.data.added[0]) && okAdd.data.removed.length === 0, '3: 人資主管新增不影響自己的規則 → 成功、拿到規則 id', okAdd);
  ok(counters.locks > lk0, '3: permMapSave 拿了 LockService');
  ok(okAdd.data.affected === 2, '3: 受影響人數 = 兩位 active 店長（店長一、一悟店長）', okAdd.data);
  const newId = okAdd.data.added[0];
  const mapRow = sheets.perm_map._rows().find((r) => r[0] === newId);
  ok(mapRow && mapRow[1] === 'store' && mapRow[3] === 'sm' && mapRow[4] === 'dorm.read' && String(mapRow[5]).toUpperCase() === 'TRUE' && mapRow[7] !== '', '3: 新規則寫進 perm_map（active TRUE、updated_by 有值）', mapRow);
  const au = sheets.perm_audit._rows();
  ok(au.length === auditRows0 + 1 && au[au.length - 1][5] === 'perm_map' && au[au.length - 1][6] === 'FALSE', '3: perm_audit 多一列 cause=perm_map、seen=FALSE', au[au.length - 1]);
  const det = JSON.parse(au[au.length - 1][3]);
  ok(det.affected === 2 && det.rules_added[0] === newId && det.people.length === 2 && det.people.every((p) => p.added.join() === 'dorm.read'), '3: perm_audit 明細（JSON）記規則 id、受影響人數、每人加了什麼', det);
  const lg = rowsOf(sheets, 'staff_log').filter((r) => r[2] === 'perm_map_save');
  ok(lg.length === 1 && lg[0][4] === '+' + newId + '(dorm.read)' && !/DZY|[一-鿿]/.test(lg[0][4]), '3: staff_log 只寫規則 id 與權限碼（沒有姓名、編號）', lg);
  ok(post(sb, 'me', {}, P.sm.token).data.perms.indexOf('dorm.read') !== -1, '3: 店長下次 me 就有 dorm.read（立即生效）');

  // 刪除：非 admin 刪非鎖碼 OK；admin 刪鎖碼 OK 後人資主管失去 permmap
  const rm = sav(P.hrHm.token, [], [newId]);
  ok(rm.ok && rm.data.removed[0] === newId && rm.data.affected === 2, '3: 人資主管刪掉剛加的規則 → 成功、影響 2 人', rm);
  ok(String(sheets.perm_map._rows().find((r) => r[0] === newId)[5]).toUpperCase() === 'FALSE', '3: 刪除＝active 改 FALSE（留歷史）');
  const rmLockedAdmin = sav(A, [], [g.data.rules.find((r) => r.perm === 'platform.permmap').rule_id]);
  ok(rmLockedAdmin.ok, '3: admin 刪鎖碼規則可以', rmLockedAdmin);
  ok(post(sb, 'me', {}, P.hrHm.token).data.perms.indexOf('platform.permmap') === -1, '3: 刪掉後人資主管下次 me 沒有 platform.permmap');
  const addLockedAdmin = sav(A, [R('hq', 'hr', 'hm', 'platform.permmap')]);
  ok(addLockedAdmin.ok && post(sb, 'me', {}, P.hrHm.token).data.perms.indexOf('platform.permmap') !== -1, '3: admin 新增鎖碼規則可以、人資主管又拿回 permmap', addLockedAdmin);
  // 新規則 id 不撞號（刪過的 id 不重用）
  ok(addLockedAdmin.data.added[0] !== newId && addLockedAdmin.data.added[0] > newId, '3: 新規則 id 往後編、不重用已停用的 id', addLockedAdmin.data);
  // 沒有受影響的人就不寫 perm_audit
  const n0 = sheets.perm_audit._rows().length;
  const noEffect = sav(A, [R('office', '', 'ofs', 'dorm.read')]);
  ok(noEffect.ok && noEffect.data.affected === 0 && sheets.perm_audit._rows().length === n0, '3: 規則沒影響到任何人 → 不寫 perm_audit', noEffect);
}

// ============================================================
// 4. 個別例外 permExSave／permExList／permExRevoke
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, sheets, P, counters } = app;
  const A = sb.__admin;
  const today = sb.permTodayTaipei_();
  const save = (p) => post(sb, 'permExSave', p, A);
  const base = (o) => Object.assign({ emp_no: P.pt.emp, perm: 'audit.write', mode: 'add', until: dayShift(sb, 1), note: '代班會計' }, o || {});
  ok(save(base({ perm: 'platform.permex' })).code === 'bad_perm', '4: platform.permex 不能設成例外 → bad_perm');
  ok(save(base({ mode: 'x' })).code === 'bad_mode', '4: mode 錯 → bad_mode');
  ok(save(base({ until: dayShift(sb, -2) })).code === 'bad_until', '4: 到期日早於今天 → bad_until');
  ok(save(base({ until: '2026/13/45' })).code === 'bad_until', '4: 到期日格式錯 → bad_until');
  ok(save(base({ note: '' })).code === 'bad_note' && save(base({ note: 'x'.repeat(51) })).code === 'bad_note' && save(base({ note: 5 })).code === 'bad_note', '4: note 空／過長／非字串 → bad_note');
  ok(save(base({ emp_no: 'abc' })).code === 'bad_input' && save(base({ emp_no: 'DZY999' })).code === 'no_staff', '4: 編號格式錯 → bad_input；查無此人 → no_staff');
  ok(sheets.perm_ex._rows().length === 1, '4: 被拒絕的都沒寫入');

  const lk0 = counters.locks;
  const s1 = save(base());
  ok(s1.ok && s1.data.ex_id === 'X001', '4: 設例外 → X001', s1);
  ok(counters.locks > lk0, '4: permExSave 拿了 LockService');
  const exRow = sheets.perm_ex._rows()[1];
  ok(exRow[1] === P.pt.emp && exRow[2] === 'audit.write' && exRow[3] === 'add' && exRow[4] === dayShift(sb, 1) && String(exRow[6]).toUpperCase() === 'TRUE' && exRow[8] !== '', '4: perm_ex 列欄位正確（until 正規化、active TRUE、created_by）', exRow);
  const me = post(sb, 'me', {}, P.pt.token).data;
  ok(me.perms.indexOf('audit.write') !== -1 && me.perms.indexOf('audit.read') !== -1 && me.audit_scope === 'all', '4: 計時同仁下次 me 有 audit.write＋audit.read、scope all', me);
  let au = sheets.perm_audit._rows();
  const last = au[au.length - 1];
  ok(last[5] === 'perm_ex' && last[2] === P.pt.emp && last[3] === 'audit.write' && last[4] === '', '4: perm_audit cause=perm_ex、added=audit.write', last);
  const lg = rowsOf(sheets, 'staff_log').filter((r) => r[2] === 'perm_ex_save');
  ok(lg.length === 1 && lg[0][4].indexOf('X001 add audit.write') === 0, '4: staff_log perm_ex_save（只有 id、碼、日期）', lg);

  // 注入公式的 note 會被加單引號
  const fx = save(base({ perm: 'dorm.read', note: '=HYPERLINK("x")' }));
  ok(fx.ok && String(sheets.perm_ex._rows()[2][5]).charAt(0) === "'", '4: note 以 = 開頭 → 存成純文字（加單引號）', sheets.perm_ex._rows()[2]);
  // remove 例外：拿掉財務同仁的 audit.read
  const rm = save({ emp_no: P.fin.emp, perm: 'audit.read', mode: 'remove', until: '', note: '暫停' });
  ok(rm.ok, '4: remove 例外成功', rm);
  const finMe = post(sb, 'me', {}, P.fin.token).data;
  ok(finMe.perms.indexOf('audit.read') !== -1 && finMe.perms.indexOf('audit.write') !== -1, '4: 財務同仁拿掉 audit.read 但 audit.write 還在 → 仍補上 audit.read（write 視同 read）', finMe);

  // permExList
  const L = post(sb, 'permExList', {}, A);
  ok(L.ok && L.data.items.length === 3 && L.data.items[0].ex_id === 'X001' && L.data.items[0].name === '計時同仁' && L.data.items[0].status === 'active', '4: permExList 全部、含姓名與 status', L.data.items.map((i) => [i.ex_id, i.status]));
  ok(post(sb, 'permExList', { emp_no: P.fin.emp.toLowerCase() }, A).data.items.length === 1, '4: permExList 依 emp_no 篩（不分大小寫）');
  ok(JSON.stringify(L.data.grantable) === JSON.stringify(sb.PERM_GRANTABLE), '4: ★permExList 回 grantable＝PERM_GRANTABLE（admin；個別例外下拉以此為準，2026-10-29）', L.data.grantable);
  sheets.perm_ex.appendRow(['X004', P.pt.emp, 'dorm.write', 'add', dayShift(sb, -1), '過期', 'TRUE', '', 'u001', '', '']);
  ok(post(sb, 'permExList', {}, A).data.items.find((i) => i.ex_id === 'X004').status === 'expired', '4: 到期的例外 status=expired');

  // revoke
  const lk1 = counters.locks;
  const rv = post(sb, 'permExRevoke', { ex_id: 'X001' }, A);
  ok(rv.ok && counters.locks > lk1, '4: permExRevoke 成功、拿了 LockService', rv);
  const r1 = sheets.perm_ex._rows()[1];
  ok(String(r1[6]).toUpperCase() === 'FALSE' && r1[9] !== '' && r1[10] !== '', '4: 撤銷＝active FALSE、revoked_at／revoked_by 有值', r1);
  ok(post(sb, 'me', {}, P.pt.token).data.perms.indexOf('audit.write') === -1, '4: 撤銷後計時同仁下次 me 沒有 audit.write');
  au = sheets.perm_audit._rows();
  const l2 = au[au.length - 1];
  ok(l2[5] === 'perm_ex' && l2[2] === P.pt.emp && l2[3] === '' && l2[4].indexOf('audit.write') !== -1, '4: 撤銷也寫 perm_audit（removed 含 audit.write）', l2);
  ok(post(sb, 'permExRevoke', { ex_id: 'X001' }, A).code === 'bad_state' && post(sb, 'permExRevoke', { ex_id: 'X777' }, A).code === 'no_ex' && post(sb, 'permExRevoke', {}, A).code === 'bad_input', '4: 重複撤銷 → bad_state；不存在 → no_ex；沒帶 → bad_input');
  ok(rowsOf(sheets, 'staff_log').some((r) => r[2] === 'perm_ex_revoke'), '4: staff_log 有 perm_ex_revoke');
}

// ============================================================
// 5. 店別對照 permStoreGet／permStoreSave
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, sheets, P, counters } = app;
  const A = sb.__admin;
  const g = post(sb, 'permStoreGet', {}, P.hrHm.token);
  ok(g.ok && g.data.items.length === 5 && g.data.items.some((i) => i.unit === 'mala-gf' && i.audit_store === 'sxl-gf') && g.data.units.some((u) => u.code === 'yiwu-js'), '5: permStoreGet 回 5 筆預設＋單位清單', g.data);
  const sv = (p, t) => post(sb, 'permStoreSave', p, t || A);
  ok(sv({ unit: 'yiwu-js', audit_store: 'yiwu-js' }, P.hrHm.token).code === 'no_perm', '5: permStoreSave 人資主管 → no_perm（只有 admin 能改）');
  ok(sv({ unit: 'dzy-hq', audit_store: 'x1' }).code === 'bad_target' && sv({ unit: 'nope', audit_store: 'x1' }).code === 'bad_target', '5: 非門市／不存在的單位 → bad_target');
  ok(sv({ unit: 'yiwu-js', audit_store: 'a b' }).code === 'bad_store' && sv({ unit: 'yiwu-js', audit_store: '=x' }).code === 'bad_store', '5: 店別代碼格式錯 → bad_store');
  ok(sv({ unit: 'yiwu-js', audit_store: 'sxl-gf' }).code === 'dup_store', '5: 別的單位已用這家稽核店 → dup_store');
  ok(post(sb, 'me', {}, P.smY.token).data.audit_scope.length === 0, '5 前置：一悟店長的店沒有對照 → audit_scope []');
  const lk0 = counters.locks;
  const ok1 = sv({ unit: 'yiwu-js', audit_store: 'yiwu-js' });
  ok(ok1.ok && counters.locks > lk0, '5: admin 新增對照成功、拿了鎖', ok1);
  ok(post(sb, 'me', {}, P.smY.token).data.audit_scope.join() === 'yiwu-js', '5: 一悟店長下次 me 的 audit_scope=["yiwu-js"]');
  const upd = sv({ unit: 'yiwu-js', audit_store: 'yiwu-js2' });
  ok(upd.ok && sheets.perm_store_map._rows().filter((r) => r[0] === 'yiwu-js').length === 1 && sheets.perm_store_map._rows().find((r) => r[0] === 'yiwu-js')[1] === 'yiwu-js2', '5: 再存＝更新同一列（不重複新增）');
  ok(sv({ unit: 'yiwu-js', audit_store: '' }).ok && post(sb, 'me', {}, P.smY.token).data.audit_scope.length === 0, '5: 清空店別＝取消對照');
  const lg = rowsOf(sheets, 'staff_log').filter((r) => r[2] === 'perm_store_save');
  ok(lg.length === 3 && lg[0][4] === 'yiwu-js:→yiwu-js', '5: staff_log perm_store_save（單位與店別代碼）', lg.map((r) => r[4]));
}

// ============================================================
// 5b. 2026-10-26 審查 A-14（Eason 選「開放所有啟用中的門市」）：系統帳號的節點＝原本 5 家＋店別對照裡、門市還在啟用的稽核店代碼
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, sheets } = app;
  const A = sb.__admin;
  const save = (username, node) => post(sb, 'saveUser', { username, name: '節點測試', role: 'accountant', node, password: 'longenoughpw1A' }, A);
  ok(save('nodea1', 'st-01').ok === false, '5b 前置：還沒對照的稽核店代碼 st-01 → 不能當節點');
  ok(post(sb, 'permStoreSave', { unit: 'yiwu-js', audit_store: 'st-01' }, A).ok, '5b 前置：店別對照 一悟竹北 → st-01');
  const lu = post(sb, 'listUsers', {}, A);
  const opt = (lu.data.nodes || []).find((o) => o.value === 'st-01');
  ok(lu.ok && opt && opt.label === sb.stfReadOrg_().unit['yiwu-js'].name, '5b listUsers 回節點清單，st-01 帶門市名', lu.data.nodes);
  ok(['sxl-gf', 'ck', 'mzt-gf', 'mzt-js', 'mzt-lzl'].every((n) => lu.data.nodes.some((o) => o.value === n)), '5b 原本 5 家都在清單');
  const r1 = save('nodeb1', 'st-01');
  ok(r1.ok, '5b ★店別對照裡啟用中的門市 → 可以當節點', r1);
  ok(save('nodec1', 'st-99').ok === false && save('nodec2', '=x').ok === false, '5b 亂填的代碼照樣擋');
  ok(save('noded1', 'sxl-gf').ok, '5b 原本 5 家照舊可以');
  sheets.org._data.find((r) => r[0] === 'unit' && r[1] === 'yiwu-js')[7] = 'FALSE';   // 門市停用
  ok(save('nodee1', 'st-01').ok === false, '5b ★門市停用 → 它的稽核店代碼不能再設成節點');
  ok(!post(sb, 'listUsers', {}, A).data.nodes.some((o) => o.value === 'st-01'), '5b 門市停用後清單也不再出現');
  ok(sheets.users._rows().some((r) => r[1] === 'nodeb1' && r[4] === 'st-01'), '5b 已經設好的舊帳號節點不動');
  const b1 = sheets.users._rows().find((r) => r[1] === 'nodeb1');
  const ed = post(sb, 'saveUser', { id: b1[0], username: 'nodeb1', name: '改了名字', role: 'accountant', node: 'st-01' }, A);
  ok(ed.ok && sheets.users._rows().find((r) => r[1] === 'nodeb1')[2] === '改了名字', '5b ★節點沒改（門市已停用）時，舊帳號照樣能改其他欄位', ed);
  ok(post(sb, 'saveUser', { id: b1[0], username: 'nodeb1', name: '改了名字', role: 'accountant', node: 'st-77' }, A).ok === false, '5b 改成不合法的新節點照樣擋');
}

// ============================================================
// 6. myPerms：sources
// ============================================================
{
  const app = scene();
  init(app);
  const { sb, sheets, P } = app;
  const A = sb.__admin;
  ok(JSON.stringify(post(sb, 'myPerms', {}, P.sm.token).data) === '{"enabled":false}', '6: 開關關 → {enabled:false}');
  on(app);
  const sm = post(sb, 'myPerms', {}, P.sm.token).data;
  const own = sm.items.find((i) => i.perm === 'audit.read.own');
  ok(sm.enabled && own && own.source === 'title' && /^R\d{3}$/.test(own.rule_id) && own.name_zh === '稽核：我的門市', '6: 店長 audit.read.own 來源=title、有 rule_id 與中文名', own);
  ok(sm.items.some((i) => i.perm === 'platform.self' && i.source === 'role') && JSON.stringify(sm.audit_scope) === '["sxl-gf"]', '6: 角色權限 source=role、audit_scope 陣列', sm);
  const fin = post(sb, 'myPerms', {}, P.fin.token).data;
  ok(fin.items.filter((i) => i.source === 'dept').map((i) => i.perm).sort().join() === 'audit.read,audit.write,cashbook.write,platform.purchase,pnl.write,transfer.write' && fin.audit_scope === 'all', '6: 財務同仁 audit.read／write／cashbook.write 來源=dept、scope all', fin);
  const ceo = post(sb, 'myPerms', {}, P.ceo.token).data;
  ok(ceo.items.find((i) => i.perm === 'dorm.read').source === 'title', '6: 執行長 dorm.read 來源=title');
  post(sb, 'permExSave', { emp_no: P.pt.emp, perm: 'dorm.read', mode: 'add', until: dayShift(sb, 3), note: '暫時' }, A);
  const pt = post(sb, 'myPerms', {}, P.pt.token).data;
  const ex = pt.items.find((i) => i.perm === 'dorm.read');
  ok(ex && ex.source === 'exception' && ex.ex_id === 'X001' && ex.until === dayShift(sb, 3), '6: 例外 source=exception、有 ex_id 與 until', ex);
  const it = post(sb, 'myPerms', {}, P.it.token).data;
  ok(it.audit_scope === 'none' && it.items.every((i) => i.source === 'role'), '6: 資訊部同仁沒有任何規則 → 只有 role、scope none', it);
  const acc = post(sb, 'myPerms', { }, post(sb, 'login', { username: 'acc1', password: 'fake-acc-pw-01' }).data.token).data;
  ok(acc.enabled && acc.audit_scope === 'all' && acc.items.every((i) => i.source === 'role'), '6: 系統帳號（會計）全是 role、scope all', acc);
  // 實際重算與 sources 一致：audit.write 帶出的 audit.read
  post(sb, 'permExSave', { emp_no: P.it.emp, perm: 'audit.write', mode: 'add', until: '', note: '只給填單' }, A);
  const it2 = post(sb, 'myPerms', {}, P.it.token).data;
  ok(it2.items.some((i) => i.perm === 'audit.read' && i.source === 'implied') && it2.items.some((i) => i.perm === 'audit.write' && i.source === 'exception'), '6: 只靠例外給 audit.write → 另有 audit.read（source=implied）', it2.items);
}

// ============================================================
// 7. permAuditList／permAuditSeen
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, sheets, P } = app;
  const A = sb.__admin;
  post(sb, 'permExSave', { emp_no: P.pt.emp, perm: 'dorm.read', mode: 'add', until: '', note: 'a' }, A);
  post(sb, 'permExSave', { emp_no: P.it.emp, perm: 'dorm.read', mode: 'add', until: '', note: 'b' }, A);
  post(sb, 'permMapSave', { add: [{ ladder: 'store', dept: '', title: 'sm', perm: 'dorm.write' }] }, A);
  const L = post(sb, 'permAuditList', {}, A);
  ok(L.ok && L.data.items.length === 3 && L.data.unseen === 3 && L.data.items[0].cause === 'perm_map' && L.data.items[0].detail && L.data.items[0].detail.affected === 2, '7: permAuditList 最新在前、未讀 3、perm_map 帶 detail', L.data.items.map((i) => i.cause));
  ok(L.data.items[2].name === '計時同仁' && L.data.items[2].seen === false, '7: ex 列帶姓名、seen=false');
  const s1 = post(sb, 'permAuditSeen', { rows: [L.data.items[2].row] }, A);
  ok(s1.ok && s1.data.marked === 1 && post(sb, 'permAuditList', {}, A).data.unseen === 2, '7: 指定列標已看過 → 未讀 2', s1);
  ok(post(sb, 'permAuditList', { unseen_only: true }, A).data.items.length === 2, '7: unseen_only 只回未讀');
  ok(post(sb, 'permAuditSeen', { rows: [1] }, A).code === 'bad_input' && post(sb, 'permAuditSeen', { rows: [99] }, A).code === 'bad_input' && post(sb, 'permAuditSeen', {}, A).code === 'bad_input', '7: 列號不對／沒帶 → bad_input');
  ok(post(sb, 'permAuditSeen', { all: true }, A).data.marked === 2 && post(sb, 'permAuditList', {}, A).data.unseen === 0, '7: all:true 全部標已看過');
  ok(post(sb, 'permAuditList', {}, P.hrHm.token).code === 'no_perm', '7: 人資主管不能看 permAuditList（只有 admin）');
}

// ============================================================
// 8. 自改擋下 self_org_edit
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, sheets, P } = app;
  const A = sb.__admin;
  const me = P.hrHs;                    // 人資同仁：有 platform.staff
  const edit = (emp, p, t) => post(sb, 'staffEdit', Object.assign({ emp_no: emp }, p), t || me.token);
  for (const p of [{ title: 'hm' }, { dept: 'fin' }, { unit: 'mala-gf', brand: 'mala', dept: '', title: 'sm' }, { brand: 'mzt' }]) {
    const r = edit(me.emp, p);
    ok(r.ok === false && r.code === 'self_org_edit', '8: 人資改自己 ' + Object.keys(p).join('／') + ' → self_org_edit', r);
  }
  const ex = edit(me.emp, { extra_depts: ['fin'] });
  ok(ex.ok === false && ex.code === 'self_org_edit', '8: 人資改自己的 extra_depts → self_org_edit', ex);
  const row = () => sheets_row(app, me.emp);
  ok(row()[sb.STF_COL.title] === 'hs' && row()[sb.STF_COL.dept] === 'hr', '8: 被擋之後自己的組織欄沒變');
  ok(edit(me.emp, { phone: '0911000999' }).ok, '8: 個資欄（手機）照放');
  ok(edit(me.emp, { title: 'hs', dept: 'hr', unit: 'dzy-hq', brand: 'dzy', phone: '0911000998' }).ok, '8: 組織欄送一樣的值（沒真的改）不擋');
  ok(edit(P.it.emp, { dept: 'marketing' }).ok, '8: 人資改別人的組織欄（不涉及 permmap）照放');
  const adm = post(sb, 'staffEdit', { emp_no: me.emp, dept: 'fin' }, A);
  ok(adm.ok, '8: admin 改任何人（含改人資同仁的部門）不受自改限制', adm);
  // 自己確認自己的待確認變更
  const sh = app.sheets.staff;
  const ri = sh._rows().findIndex((r) => r[0] === P.it.emp);
  const setCell = (h, v) => sh.getRange(ri + 1, sb.STF_COL[h] + 1).setValue(v);
  // 資訊同仁自己是 platform.staff 嗎？不是 → 用 admin 發 platform.staff 例外
  post(sb, 'permExSave', { emp_no: P.it.emp, perm: 'platform.staff', mode: 'add', until: '', note: '代理人資' }, A);
  setCell('p_brand', 'dzy'); setCell('p_unit', 'dzy-hq'); setCell('p_dept', 'ops'); setCell('p_title', 'hs');
  const selfCf = post(sb, 'staffConfirm', { emp_no: P.it.emp }, P.it.token);
  ok(selfCf.ok === false && selfCf.code === 'self_org_edit', '8: 非 admin 確認自己的待確認組織變更 → self_org_edit', selfCf);
  const otherCf = post(sb, 'staffConfirm', { emp_no: P.it.emp }, P.hrHs.token);
  ok(otherCf.ok === false && otherCf.error !== undefined, '8 前置：人資同仁（已被 admin 改到 fin 部，失去 platform.staff）不能確認', otherCf);
  const admCf = post(sb, 'staffConfirm', { emp_no: P.it.emp }, A);
  ok(admCf.ok && sheets_row(app, P.it.emp)[sb.STF_COL.dept] === 'ops', '8: admin 確認同一筆 → 成功', admCf);
}
function sheets_row(app, emp) { return app.sheets.staff._rows().find((r) => r[0] === emp); }

// ============================================================
// 9. 人資主管只有 admin 能設 perm_admin_only（開關開、開關關、表未初始化都要擋）
// ============================================================
function adminOnlyCases(label, setup, useSysHr) {
  const app = scene();
  const { sb, P } = app;
  setup(app);
  const A = sb.__admin;
  // 非 admin 的人資：開關關時同仁帳號沒有 platform.staff，改用「系統帳號人資」（role hrsys）；開關開用人資同仁
  const hr = useSysHr ? post(sb, 'login', { username: 'hr1', password: 'fake-hr-pw-01' }).data.token : P.hrHs.token;
  const has = (e) => /* 該人是不是人資主管 */ sheets_row(app, e)[sb.STF_COL.title] === 'hm' && sheets_row(app, e)[sb.STF_COL.dept] === 'hr';
  // (1) staffEdit：把資訊同仁改成人資部主管 → 擋
  const e1 = post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'hr', title: 'hm' }, hr);
  ok(e1.ok === false && e1.code === 'perm_admin_only' && e1.error === '人資主管要請系統管理員設定', label + ': staffEdit 把人改成人資主管 → perm_admin_only', e1);
  ok(!has(P.it.emp), label + ': 被擋之後組織欄沒變');
  // (2) extra_depts：資訊部主管兼任人資部 → 命中 (hq, hr, hm) → 擋
  const itHm = mk(sb, '資訊主管', HQ('it', 'hm'));
  const e2 = post(sb, 'staffEdit', { emp_no: itHm.emp, extra_depts: ['hr'] }, hr);
  ok(e2.ok === false && e2.code === 'perm_admin_only', label + ': 部門主管被加兼任人資部 → perm_admin_only', e2);
  // (3) 失去：人資主管被降成同仁 → 擋
  const e3 = post(sb, 'staffEdit', { emp_no: P.hrHm.emp, title: 'hs' }, hr);
  ok(e3.ok === false && e3.code === 'perm_admin_only', label + ': 人資主管被降成同仁（失去 permmap）→ perm_admin_only', e3);
  const e3b = post(sb, 'staffEdit', { emp_no: P.hrHm.emp, dept: 'it' }, hr);
  ok(e3b.ok === false && e3b.code === 'perm_admin_only', label + ': 人資主管被調去資訊部 → perm_admin_only', e3b);
  // (4) 不涉及 permmap 的改動照放
  ok(post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'ops' }, hr).ok, label + ': 改成營運部同仁（不涉及 permmap）照放');
  ok(post(sb, 'staffEdit', { emp_no: P.hrHm.emp, phone: '0911555666' }, hr).ok, label + ': 人資主管改手機（個資欄）照放');
  // (5) staffConfirm／unitApprove：待審 hm/hr
  const pend1 = claim(sb, '待確認甲', HQ('hr', 'hm'));
  const c1 = post(sb, 'staffConfirm', { emp_no: pend1 }, hr);
  ok(c1.ok === false && c1.code === 'perm_admin_only', label + ': 人資 staffConfirm 一位 hm/hr 的認領 → perm_admin_only', c1);
  const pend2 = claim(sb, '待確認乙', HQ('hr', 'hm'));
  const ap = post(sb, 'unitApprove', { emp_no: pend2 }, P.ceo.token);
  ok(ap.ok === false && ap.code === 'perm_admin_only', label + ': 執行長 unitApprove 一位 hm/hr 的認領 → perm_admin_only', ap);
  ok(sheets_row(app, pend2)[sb.STF_COL.status] === 'pending', label + ': 被擋之後仍是 pending');
  const ca = post(sb, 'staffConfirm', { emp_no: pend1 }, A);
  ok(ca.ok, label + ': admin staffConfirm 同一筆 → 成功', ca);
  const ae = post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'hr', title: 'hm' }, A);
  ok(ae.ok, label + ': admin staffEdit 設人資主管 → 成功', ae);
  // (6) 一般 pending 照放
  const pend3 = claim(sb, '待確認丙', { brand: 'mala', unit: 'mala-gf', title: 'pt' });
  ok(post(sb, 'staffConfirm', { emp_no: pend3 }, hr).ok, label + ': 人資 staffConfirm 一般計時同仁 → 成功');
  return app;
}
adminOnlyCases('9a 開關關、表未初始化', () => {}, true);
adminOnlyCases('9b 開關關、表已初始化', (app) => { init(app); }, true);
adminOnlyCases('9c 開關開', (app) => { init(app); on(app); });
{
  // 9d 表未初始化時不會因此建出 perm 表、也不寫 perm_audit
  const app = scene();
  const { sb, P, sheets } = app;
  post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'fin' }, P.hrHs.token);
  ok(!sheets.perm_map && !sheets.perm_audit, '9d: 表未初始化時防呆照擋，但不會建出任何 perm 分頁');
}

// ============================================================
// 10. 組織欄改動 → perm_audit（staff_edit／confirm）
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, sheets, P } = app;
  const A = sb.__admin;
  const n0 = sheets.perm_audit._rows().length;
  // 資訊同仁 → 財務部（得到 audit.read／audit.write）
  const e = post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'fin' }, A);
  ok(e.ok, '10: admin 把資訊同仁調去財務部（非 admin 會被鎖碼擋）', e);
  let au = sheets.perm_audit._rows();
  let last = au[au.length - 1];
  ok(au.length === n0 + 1 && last[5] === 'staff_edit' && last[2] === P.it.emp && last[3] === 'audit.read,audit.write,cashbook.write,platform.purchase,pnl.write,transfer.write' && last[4] === '' && last[6] === 'FALSE', '10: 權限有差異 → perm_audit 一列 cause=staff_edit、added=audit.read,audit.write,cashbook.write', last);
  ok(last[1] !== '', '10: by 是帳號 id');
  // 只改手機：權限沒差異 → 不寫
  post(sb, 'staffEdit', { emp_no: P.it.emp, phone: '0911000123' }, P.hrHs.token);
  ok(sheets.perm_audit._rows().length === n0 + 1, '10: 沒改到權限（只改手機）→ 不寫 perm_audit');
  // 調成另一個沒規則的部門：removed
  post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'it' }, A);
  au = sheets.perm_audit._rows(); last = au[au.length - 1];
  ok(last[5] === 'staff_edit' && last[3] === '' && last[4] === 'audit.read,audit.write,cashbook.write,platform.purchase,pnl.write,transfer.write', '10: 調回資訊部 → removed=audit.read,audit.write,cashbook.write', last);
  // confirm：新認領的店長，admin 確認 → 從無到有
  const emp = claim(sb, '待確認店長', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  const n1 = sheets.perm_audit._rows().length;
  ok(post(sb, 'staffConfirm', { emp_no: emp }, A).ok, '10: admin staffConfirm 新店長');
  au = sheets.perm_audit._rows(); last = au[au.length - 1];
  ok(au.length === n1 + 1 && last[5] === 'confirm' && last[2] === emp && last[3] === 'audit.read.own,store.void', '10: confirm 後權限有差異 → perm_audit cause=confirm、added=audit.read.own,store.void', last);
  // unitApprove（店長 → 計時同仁的認領）
  const emp2 = claim(sb, '待審計時', { brand: 'mala', unit: 'mala-gf', title: 'pt' });
  const n2 = sheets.perm_audit._rows().length;
  ok(post(sb, 'unitApprove', { emp_no: emp2 }, P.sm.token).ok, '10: 店長 unitApprove 計時同仁');
  ok(sheets.perm_audit._rows().length === n2, '10: 計時同仁沒有任何規則權限 → 不寫 perm_audit');
}

// ============================================================
// 11. stfScopeMeets_ 同級不能審（< 改 <=）
// ============================================================
{
  const { sb } = fresh();
  const m = (kinds, rank, tl) => ({ kinds, unit: 'x', brand: 'b', dept: 'd', rank, titleLadder: tl });
  const nd = (kind, rank, parent) => ({ kind, title: { rank, parent }, unit: 'x', brand: 'b', dept: 'd' });
  ok(sb.stfScopeMeets_(m(['store'], 3, 'store'), nd('store', 3, 'store')) === false, '11: 同階梯同級（店長審自報店長）→ 不行');
  ok(sb.stfScopeMeets_(m(['store'], 3, 'store'), nd('store', 2, 'store')) === true, '11: 同階梯高審低 → 可以');
  ok(sb.stfScopeMeets_(m(['store'], 3, 'store'), nd('store', 4, 'store')) === false, '11: 低審高 → 不行');
}

// ============================================================
// 12. 白名單／鎖：新 action 都在 CODE_ALLOWED_ACTIONS；寫入類都在 MUTATING_ACTIONS（拿全域鎖）
// ============================================================
{
  const { sb } = fresh();
  const names = ['permInit', 'permMapGet', 'permMapSave', 'permExList', 'permExSave', 'permExRevoke', 'permStoreGet', 'permStoreSave', 'myPerms', 'permAuditList', 'permAuditSeen'];
  ok(names.every((a) => sb.CODE_ALLOWED_ACTIONS.indexOf(a) !== -1), '12: 11 個新 action 都在白名單');
  const code = fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8');
  const mut = /var MUTATING_ACTIONS = \{([\s\S]*?)\};/.exec(code)[1];
  ok(['permInit', 'permMapSave', 'permExSave', 'permExRevoke', 'permStoreSave', 'permAuditSeen'].every((a) => new RegExp('\\b' + a + ': 1').test(mut)), '12: 6 個寫入類 action 在 MUTATING_ACTIONS（上全域鎖）');
  ok(['permMapGet', 'permExList', 'permStoreGet', 'myPerms', 'permAuditList'].every((a) => !new RegExp('\\b' + a + ': 1').test(mut)), '12: 讀取類不上鎖');
}

// ============================================================
// 13. 審查修正：停用中改組織欄不能繞過鎖碼檢查；停用收回的權限留 perm_audit；無 staff 列的訊息
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, sheets, P } = app;
  const A = sb.__admin;
  const hr = P.hrHs.token;   // 非 admin 的人資同仁（有 platform.staff）
  const row = (e) => sheets_row(app, e);
  // (a) 停用→改成人資主管→啟用：第二步非 admin 要被擋
  ok(post(sb, 'staffSetActive', { emp_no: P.it.emp, active: false }, A).ok, '13a: admin 先停用資訊同仁');
  ok(row(P.it.emp)[sb.STF_COL.status] === 'disabled', '13a 前置：status=disabled');
  const nAudit0 = sheets.perm_audit._rows().length;
  const blocked = post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'hr', title: 'hm' }, hr);
  ok(blocked.ok === false && blocked.code === 'perm_admin_only', '13a: 停用中改成人資主管 → perm_admin_only', blocked);
  ok(row(P.it.emp)[sb.STF_COL.title] !== 'hm', '13a: 被擋之後組織欄沒變');
  ok(post(sb, 'staffSetActive', { emp_no: P.it.emp, active: true }, A).ok, '13a: 啟用');
  ok(row(P.it.emp)[sb.STF_COL.title] !== 'hm', '13a: 啟用後仍不是人資主管');
  // (b) 停用中改成一般會拿到稽核權限的部門（非鎖碼）→ 照放，並寫 perm_audit（以「若在職」計算）
  ok(post(sb, 'staffSetActive', { emp_no: P.it.emp, active: false }, A).ok, '13b: 再停用');
  const nAudit1 = sheets.perm_audit._rows().length;
  const okEdit = post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'fin' }, A);
  ok(okEdit.ok, '13b: 停用中 admin 改去財務部', okEdit);
  ok(post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'ops' }, hr).ok === false, '13b: 停用中非 admin 改組織欄也以「若在職」算鎖碼 → 擋（財務→營運失去 audit.write）');
  ok(post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'fin' }, A).ok, '13b: 還原');
  const au = sheets.perm_audit._rows();
  const last = au[au.length - 1];
  ok(au.length === nAudit1 + 1 && last[5] === 'staff_edit' && last[2] === P.it.emp && last[3] === 'audit.read,audit.write,cashbook.write,platform.purchase,pnl.write,transfer.write', '13b: 停用中改組織欄也寫 perm_audit（added）', last);
  // (c) 停用有權限的人 → perm_audit removed
  const fin = P.fin;
  const n2 = sheets.perm_audit._rows().length;
  ok(post(sb, 'staffSetActive', { emp_no: fin.emp, active: false }, A).ok, '13c: 停用財務同仁');
  const au2 = sheets.perm_audit._rows();
  const l2 = au2[au2.length - 1];
  ok(au2.length === n2 + 1 && l2[2] === fin.emp && l2[3] === '' && l2[4] === 'audit.read,audit.write,cashbook.write,platform.purchase,pnl.write,transfer.write' && l2[5] === 'staff_edit', '13c: 停用收回權限 → perm_audit removed', l2);
  // (d) 停用沒有任何規則權限的人 → 不寫
  const n3 = sheets.perm_audit._rows().length;
  ok(post(sb, 'staffSetActive', { emp_no: P.pt.emp, active: false }, A).ok, '13d: 停用計時同仁');
  ok(sheets.perm_audit._rows().length === n3, '13d: 沒有權限可收回 → 不寫 perm_audit');
}
{
  // 無 staff 列：role=staff 的帳號在 users 有、staff 分頁沒有 → 訊息不是「帳號已停用」；status≠active 維持原訊息
  const app = scene();
  init(app); on(app);
  const { sb, sheets, P } = app;
  const A = sb.__admin;
  const emp = P.pt.emp;
  const r = sheets_row(app, emp);
  const uid = r[sb.STF_COL.user_id];
  ok(post(sb, 'staffSetActive', { emp_no: emp, active: false }, A).ok, '13e 前置：停用');
  const dis = post(sb, 'login', { username: emp, password: 'fake-staff-pw-1' });
  ok(dis.ok === false && dis.error === '帳號已停用', '13e: staff 列存在但 status≠active → 維持「帳號已停用」', dis);
  // 把 staff 列的 user_id 抹掉＝users 有帳號、staff 找不到對應列
  const idx = sheets.staff._data.findIndex((x) => x[0] === emp);
  sheets.staff._data[idx][sb.STF_COL.user_id] = '';
  const sheetUsers = sheets.users._data.find((x) => x[0] === uid);
  sheetUsers[7] = 'TRUE';
  const miss = post(sb, 'login', { username: emp, password: 'fake-staff-pw-1' });
  ok(miss.ok === false && miss.error === '此帳號不在同仁名單，請聯絡人資', '13e: users 有帳號但 staff 沒有對應列 → 「此帳號不在同仁名單，請聯絡人資」', miss);
}

{
  // 4a 鎖碼家族：把人調進會拿到 platform.users 的組織位置，非 admin 也要擋（不只 platform.permmap）
  const app = scene();
  init(app); on(app);
  const { sb, sheets, P } = app;
  const A = sb.__admin;
  const addRule = post(sb, 'permMapSave', { add: [{ ladder: 'hq', dept: 'it', title: '*', perm: 'platform.users' }] }, A);
  ok(addRule.ok, '13f 前置：admin 加一條 hq/it/* → platform.users 規則', addRule);
  const hr = P.hrHs.token;
  const blk = post(sb, 'staffEdit', { emp_no: P.fin.emp, dept: 'it' }, hr);
  ok(blk.ok === false && blk.code === 'perm_admin_only', '13f: 非 admin 把人調進會拿到 platform.users 的位置 → perm_admin_only', blk);
  ok(sheets_row(app, P.fin.emp)[sb.STF_COL.dept] === 'fin', '13f: 被擋之後組織欄沒變');
  const blk2 = post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'ops' }, hr);
  ok(blk2.ok === false && blk2.code === 'perm_admin_only', '13f: 非 admin 把原本有 platform.users 的人調走 → perm_admin_only', blk2);
  ok(post(sb, 'staffEdit', { emp_no: P.fin.emp, dept: 'it' }, A).ok, '13f: admin 做同一件事 → 成功');
}

{
  // 4b 擴大鎖碼（2026-10-17）：人資把人調進／調出財務部（audit.write）要擋，訊息依碼組中文
  const app = scene();
  init(app); on(app);
  const { sb, sheets, P } = app;
  const A = sb.__admin;
  const hr = P.hrHs.token;
  const into = post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'fin' }, hr);
  ok(into.ok === false && into.code === 'perm_admin_only' && /稽核填單/.test(into.error) && /請系統管理員處理/.test(into.error), '4b: 人資把人調進財務部 → perm_admin_only 且訊息含稽核填單', into);
  ok(sheets_row(app, P.it.emp)[sb.STF_COL.dept] !== 'fin', '4b: 被擋之後組織欄沒變');
  const out = post(sb, 'staffEdit', { emp_no: P.fin.emp, dept: 'ops' }, hr);
  ok(out.ok === false && out.code === 'perm_admin_only', '4b: 人資把財務同仁調去營運部（失去 audit.write）→ perm_admin_only', out);
  const toHr = post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'hr', title: 'hs' }, hr);
  ok(toHr.ok === false && toHr.code === 'perm_admin_only' && /同仁名單/.test(toHr.error), '4b: 人資把人調進人資部（拿到 platform.staff）→ 擋且訊息含同仁名單', toHr);
  ok(post(sb, 'staffEdit', { emp_no: P.it.emp, dept: 'fin' }, A).ok, '4b: admin 同一件事 → 成功');
}

// ============================================================
// P2-N3 啟用（復職）後對方若有權限 → 寫 perm_audit（added）
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, sheets, P } = app;
  const A = sb.__admin;
  ok(post(sb, 'staffSetActive', { emp_no: P.sm.emp, active: false }, A).ok, 'N3 前置：停用店長');
  const n0 = sheets.perm_audit._rows().length;
  ok(post(sb, 'staffSetActive', { emp_no: P.sm.emp, active: true }, A).ok, 'N3 前置：重新啟用');
  const rows = sheets.perm_audit._rows();
  const last = rows[rows.length - 1];
  ok(rows.length === n0 + 1 && last[2] === P.sm.emp && String(last[3]).length > 0 && String(last[4]) === '' && last[5] === 'staff_edit', 'N3 啟用後寫一列 perm_audit（added＝對方拿回的權限、cause＝staff_edit）', last);
}

// ============================================================
// P2-N4 roles 分頁裡含鎖碼的角色，視為高權限（非 admin 不能指派、不能動該帳號）
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, sheets } = app;
  const A = sb.__admin;
  sheets.roles._data.push(['permrole', '權限管理員', 'platform.permmap'], ['ulead', '帳號管理', 'platform.users,platform.self']);
  const salt = 'salt-n4';
  sheets.users._data.push(['u090', 'ulead1', '帳號管理員', 'ulead', '', salt, sb.hashPassword_('fake-ul-pw-01', salt), 'TRUE', '', '']);
  sheets.users._data.push(['u091', 'pm1', '權限管理員', 'permrole', '', salt, sb.hashPassword_('fake-pm-pw-01', salt), 'TRUE', '', '']);
  const ul = post(sb, 'login', { username: 'ulead1', password: 'fake-ul-pw-01' });
  ok(ul.ok, 'N4 前置：非 admin 帳號管理員登入', ul);
  const n0 = sheets.users._rows().length;
  const ins = post(sb, 'saveUser', { username: 'newperm', name: '新權限者', role: 'permrole', password: 'fake-np-pw-01' }, ul.data.token);
  ok(ins.ok === false && sheets.users._rows().length === n0, 'N4 非 admin 新增含鎖碼角色的帳號 → 擋', ins);
  const before91 = sheets.users._rows().find((r) => r[0] === 'u091')[6];
  const reset = post(sb, 'resetPassword', { id: 'u091', newPassword: 'fake-reset-pw-01' }, ul.data.token);
  ok(reset.ok === false && sheets.users._rows().find((r) => r[0] === 'u091')[6] === before91, 'N4 非 admin 重設含鎖碼角色帳號的密碼 → 擋', reset);
  const off = post(sb, 'setActive', { id: 'u091', active: false }, ul.data.token);
  ok(off.ok === false && sheets.users._rows().find((r) => r[0] === 'u091')[7] === 'TRUE', 'N4 非 admin 停用含鎖碼角色帳號 → 擋', off);
  const ins2 = post(sb, 'saveUser', { username: 'newperm2', name: '新權限者二', role: 'permrole', password: 'fake-np-pw-01' }, A);
  ok(ins2.ok, 'N4 admin 指派同一角色 → 成功', ins2);
}

// ============================================================
// P3 對照表改版（版本 B）：permMapGet.counts、permMapSave preview、permWho
// ============================================================
{
  const app = scene();
  init(app); on(app);
  const { sb, sheets, P } = app;
  const A = sb.__admin;
  const R = (ladder, dept, title, perm) => ({ ladder, dept, title, perm });
  const counts = () => post(sb, 'permMapGet', {}, A).data.counts;
  const c0 = counts();
  ok(c0 && c0['store||sm'] === 2 && c0['store||pt'] === 1, 'B1: counts 店長 2 人（美村光復＋一悟）、計時 1 人', c0);
  ok(c0['hq|hr|*'] === 2 && c0['hq|hr|hm'] === 1 && c0['hq|hr|hs'] === 1, 'B1: counts 總部人資部全部職稱 2、人資主管 1', c0);
  ok(c0['hq||ceo'] === 1 && c0['hq|mgmt|*'] === 1 && c0['hq|mgmt|ceo'] === 1, 'B1: 執行長不分部門 1；管理部全部職稱含執行長（部門命中）', c0);
  ok(c0['hq|ops|*'] === 0, 'B1: 沒人的部門 0', c0);
  // 兼任：資訊同仁兼任人資部 → hq|hr|* 變 3，hq|hr|hm 不變（title 是 hs）
  ok(post(sb, 'staffEdit', { emp_no: P.it.emp, extra_depts: ['hr'] }, A).ok, 'B1 前置：admin 讓資訊同仁兼任人資部');
  const c1 = counts();
  ok(c1['hq|hr|*'] === 3 && c1['hq|hr|hs'] === 2 && c1['hq|hr|hm'] === 1, 'B1: 兼任部門算進命中人數', c1);
  // 停用不算
  ok(post(sb, 'staffSetActive', { emp_no: P.it.emp, active: false }, A).ok, 'B1 前置：停用資訊同仁');
  const c2 = counts();
  ok(c2['hq|hr|*'] === 2 && c2['hq|it|*'] === 0, 'B1: 停用的同仁不算（含主要部門與兼任）', c2);
  // 現有規則的目標鍵都在
  const g = post(sb, 'permMapGet', {}, A).data;
  ok(g.rules.every((r) => typeof g.counts[r.ladder + '|' + r.dept + '|' + r.title] === 'number'), 'B1: 每條現有規則的目標鍵都有人數');
  ok(post(sb, 'permMapGet', {}, P.hrHm.token).data.counts['store||sm'] === 2, 'B1: 人資主管也拿得到 counts');

  // preview：不寫入、名單正確
  const before = sheets.perm_map._rows().length;
  const auditBefore = sheets.perm_audit._rows().length;
  const pv = post(sb, 'permMapSave', { add: [R('store', '', 'sm', 'dorm.read')], preview: true }, P.hrHm.token);
  ok(pv.ok && pv.data.preview === true && pv.data.affected === 2 && pv.data.people.length === 2, 'B2: preview 回受影響人數與名單', pv);
  ok(pv.data.people.every((x) => x.added.join() === 'dorm.read' && x.removed.length === 0 && /店長/.test(x.name) && /^DZY/.test(x.emp_no)), 'B2: preview 名單有姓名、added', pv.data.people);
  ok(sheets.perm_map._rows().length === before && sheets.perm_audit._rows().length === auditBefore, 'B2: preview 不寫 perm_map、不寫 perm_audit');
  ok(rowsOf(sheets, 'staff_log').filter((r) => r[2] === 'perm_map_save').length === 0, 'B2: preview 不寫 staff_log');
  const hrDorm = g.rules.find((r) => r.ladder === 'hq' && r.dept === 'hr' && r.title === '*' && r.perm === 'dorm.write');
  const pv2 = post(sb, 'permMapSave', { remove: [hrDorm.rule_id], preview: true }, A);
  ok(pv2.ok && pv2.data.affected === 2 && pv2.data.people.every((x) => x.removed.join() === 'dorm.write'), 'B2: preview 刪除規則 → removed 名單（停用同仁不在內）', pv2);
  ok(sheets.perm_map._rows().length === before, 'B2: preview 刪除也不寫入');
  // preview 也驗證
  const l = post(sb, 'permMapSave', { add: [R('hq', 'hr', '*', 'platform.users')], preview: true }, P.hrHm.token);
  ok(l.ok === false && l.code === 'perm_locked', 'B2: preview 也回 perm_locked', l);
  const sf = post(sb, 'permMapSave', { add: [R('hq', 'hr', 'hm', 'audit.read')], preview: true }, P.hrHm.token);
  ok(sf.ok === false && sf.code === 'perm_self', 'B2: preview 也回 perm_self', sf);
  ok(post(sb, 'permMapSave', { add: [R('store', '', 'sm', 'dorm.read')], preview: true }, P.sm.token).code === 'no_perm', 'B2: preview 沒權限仍 no_perm');
  ok(post(sb, 'permMapSave', { add: [R('store', '', 'sm', 'dorm.read')], preview: 'yes' }, A).ok && sheets.perm_map._rows().length === before + 1, 'B2: preview 非 true（字串）不當預覽，照常寫入');

  // permWho
  const w = (q, tok) => post(sb, 'permWho', { q }, tok || A);
  const w1 = w(P.sm.emp);
  ok(w1.ok && w1.data.items.length === 1 && w1.data.items[0].name === '店長一' && w1.data.items[0].perms.indexOf('audit.read.own') !== -1, 'B3: permWho 編號精確（大小寫不拘）', w1);
  ok(w(P.sm.emp.toLowerCase()).data.items.length === 1, 'B3: 編號小寫也找得到');
  const it0 = w1.data.items[0];
  ok(it0.sources.some((x) => x.perm === 'audit.read.own' && x.source === 'title' && x.rule_id) && it0.audit_scope && it0.unit_name && it0.title_name === '店長', 'B3: sources 格式同 myPerms、有單位職稱名、audit_scope', it0);
  const w2 = w('店長');
  ok(w2.ok && w2.data.items.length === 2, 'B3: 姓名部分比對（店長一、一悟店長）', w2.data.items.map((x) => x.name));
  ok(w('資訊同仁').data.items.length === 0, 'B3: 停用的同仁找不到（只找 active）');
  ok(w('不存在的人').data.items.length === 0, 'B3: 找不到回空陣列');
  ok(post(sb, 'permWho', { q: '' }, A).code === 'bad_input', 'B3: 空查詢 → bad_input');
  ok(w(P.hrHm.emp, P.hrHm.token).ok && w('店長', P.hrHs.token).code === 'no_perm' && w('店長', P.sm.token).code === 'no_perm', 'B3: 人資主管與 admin 可查、人資同仁與店長 no_perm');
  ok(post(sb, 'permWho', { q: '店長' }, '').ok === false, 'B3: 沒 token 被擋');
  // 最多 10 筆
  for (let i = 0; i < 12; i++) mk(sb, '多人' + String.fromCharCode(0x4e00 + i), { brand: 'mala', unit: 'mala-gf', title: 'pt' });
  ok(w('多人').data.items.length === 10, 'B3: 最多 10 筆');
  // 已拿例外的來源
  post(sb, 'permExSave', { emp_no: P.pt.emp, perm: 'dorm.read', mode: 'add', note: '測' }, A);
  ok(w(P.pt.emp).data.items[0].sources.some((x) => x.source === 'exception' && x.perm === 'dorm.read'), 'B3: 例外也出現在 sources');
  ok(/permWho/.test(sb.CODE_ALLOWED_ACTIONS.join()), 'B3: permWho 在白名單');
}

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
