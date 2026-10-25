// node test/proxy-authorize.test.mjs —— 2026-10-12 稽核／宿舍改由 Mac mini 代轉：平台後端 proxyAuthorize_ 的釘子測試
// 契約正本：~/dzy-minikit/apps/dzy-platform/PROXY.md 第 2 節。
// 做法同 security-hardening.test.mjs：Auth.gs／Users.gs／Staff.gs／Code.gs 讀進同一個 vm sandbox。
// ⚠ 帳密、通行碼都是假資料（FAKE- 開頭；dzy 是 public repo）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { READ_ACTIONS, WRITE_ACTIONS } from '../platform/dryrun.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'Perms.gs', 'PermActions.gs', 'StoreOps.gs', 'StaffClock.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

// ── GAS 假物件 ──────────────────────────────────────────────
function makeSheet(rows, opts) {
  const data = (rows || []).map((r) => r.slice());
  const calls = { deleteRows: [], deleteRow: 0 };
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
    deleteRow(n) { calls.deleteRow++; data.splice(n - 1, 1); },
    _rows: () => data.map((r) => r.slice()),
    _calls: calls
  };
  // 真試算表有 deleteRows；minikit 假表沒有 → noDeleteRows 模擬後者
  if (!(opts && opts.noDeleteRows)) sheet.deleteRows = (start, n) => { calls.deleteRows.push([start, n]); data.splice(start - 1, n); };
  return sheet;
}

function bytes(v) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  return Buffer.from(v.map((b) => (b < 0 ? b + 256 : b) & 0xff));
}
function signed(buf) { return Array.from(buf, (b) => (b > 127 ? b - 256 : b)); }

function load(seed, sheetOpts) {
  const sheets = {};
  Object.keys(seed).forEach((k) => { sheets[k] = makeSheet(seed[k], (sheetOpts || {})[k]); });
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; }
  };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-for-proxy-tests' };
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
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
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

function post(sb, action, payload, token, extraE) {
  const e = Object.assign({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }, extraE || {});
  return JSON.parse(sb.doPost(e).getContent());
}

const PW = { boss: 'fake-admin-pw-01', acc: 'fake-acc-pw-01', lead: 'fake-lead-pw-01', nonode: 'fake-nonode-pw-01',
  mgr: 'fake-mgr-pw-01', viewer: 'fake-viewer-pw-01', mix: 'fake-mix-pw-01' };
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
const H = (pw, salt) => HASHER.hashPassword_(pw, salt);
const SECRETS = { auditRead: 'FAKE-AUDIT-READ-77', auditWrite: 'FAKE-AUDIT-WRITE-88', dormWrite: 'FAKE-DORM-WRITE-99' };

function seed(extra) {
  return Object.assign({
    users: [
      ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at', 'token_after'],
      ['u001', 'BOSS', '系統管理者', 'admin', '', 's1', H(PW.boss, 's1'), 'TRUE', '', '', ''],
      ['u002', 'acc1', '假會計', 'accountant', '', 's2', H(PW.acc, 's2'), 'TRUE', '', '', ''],
      ['u003', 'lead1', '假店長', 'storelead', 'sxl-gf', 's3', H(PW.lead, 's3'), 'TRUE', '', '', ''],
      ['u004', 'nonode', '沒節點店長', 'storelead', '', 's4', H(PW.nonode, 's4'), 'TRUE', '', '', ''],
      ['u005', 'mgr1', '假主管', 'manager', '', 's5', H(PW.mgr, 's5'), 'TRUE', '', '', ''],
      ['u006', 'viewer1', '只看宿舍', 'dormviewer', '', 's6', H(PW.viewer, 's6'), 'TRUE', '', '', ''],
      ['u007', 'mix1', '寫入＋自己店', 'mixlead', 'mzt-gf', 's7', H(PW.mix, 's7'), 'TRUE', '', '', '']
    ],
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['accountant', '會計', 'audit.read,audit.write'],
      ['storelead', '店長', 'audit.read.own'], ['manager', '部門主管', 'audit.read,dorm.read,dorm.write'],
      ['dormviewer', '宿舍唯讀', 'dorm.read'], ['mixlead', '寫入店長', 'audit.read.own,audit.write'], ['staff', '員工', '']],
    module_secrets: [['backend_id', 'level', 'secret'],
      ['audit', 'read', SECRETS.auditRead], ['audit', 'write', ' ' + SECRETS.auditWrite + ' '], ['dorm', 'write', SECRETS.dormWrite]],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  }, extra || {});
}
function fresh(extra) {
  const app = load(seed(extra));
  app.sb.setupStaff();
  return app;
}
function tokenOf(sb, username, pw) {
  const r = post(sb, 'login', { username, password: pw });
  if (!r.ok) throw new Error('login 失敗 ' + username + ' ' + r.error);
  return r.data.token;
}
const hasAnySecret = (obj) => { const t = JSON.stringify(obj); return Object.values(SECRETS).some((s) => t.indexOf(s) !== -1); };
const snapshot = (sheets) => JSON.stringify(Object.keys(sheets).sort().map((k) => [k, sheets[k]._rows()]));

// ============================================================
// 1. proxyAuthorize_ 不能經 doPost／分派表叫到
// ============================================================
{
  const { sb } = fresh();
  const tok = tokenOf(sb, 'BOSS', PW.boss);
  for (const name of ['proxyAuthorize_', 'proxyAuthorize', 'proxy', 'pickSecrets_', 'pickSecretFor_']) {
    const r = post(sb, name, { ns: 'audit', action: 'getAll' }, tok);
    ok(r.ok === false && r.error === '不支援的操作' && !hasAnySecret(r), '1: doPost action=' + name + ' → 不支援的操作，回應不含通行碼', r);
  }
  ok(sb.CODE_ALLOWED_ACTIONS.every((a) => !/proxy|secret/i.test(a)), '1b: 分派白名單裡沒有任何 proxy／secret 字樣的 action');
  const codeSrc = SRC.find(([f]) => f === 'Code.gs')[1];
  ok(codeSrc.indexOf('proxyAuthorize_') === -1 && codeSrc.indexOf('pickSecret') === -1, '1c: Code.gs 原始碼完全沒呼叫 proxyAuthorize_／pickSecret*');
}

// ============================================================
// 2. login／me 回應不含任何通行碼字串（所有角色）
// ============================================================
{
  const { sb } = fresh();
  for (const [u, pw] of [['BOSS', PW.boss], ['acc1', PW.acc], ['lead1', PW.lead], ['mgr1', PW.mgr], ['viewer1', PW.viewer]]) {
    const lr = post(sb, 'login', { username: u, password: pw });
    ok(lr.ok && !('secrets' in lr.data) && !hasAnySecret(lr), '2: ' + u + ' login 回應沒有 secrets、不含通行碼', lr);
    const me = post(sb, 'me', {}, lr.data.token);
    ok(me.ok && !('secrets' in me.data) && !hasAnySecret(me), '2: ' + u + ' me 回應沒有 secrets、不含通行碼', me);
  }
}

// ============================================================
// 3. token：NO_TOKEN／BAD_TOKEN；停用、登出（token_after）、改密碼後立刻 BAD_TOKEN
// ============================================================
{
  const { sb, sheets } = fresh();
  ok(sb.proxyAuthorize_('', 'audit', 'getAll').code === 'NO_TOKEN', '3a: 空 token → NO_TOKEN');
  ok(sb.proxyAuthorize_(undefined, 'audit', 'getAll').code === 'NO_TOKEN', '3b: 沒帶 token → NO_TOKEN');
  ok(sb.proxyAuthorize_('garbage.token', 'audit', 'getAll').code === 'BAD_TOKEN', '3c: 亂字串 → BAD_TOKEN');

  const boss = tokenOf(sb, 'BOSS', PW.boss);
  const acc = tokenOf(sb, 'acc1', PW.acc);
  ok(sb.proxyAuthorize_(acc, 'audit', 'getAll').ok === true, '3d: 停用前會計可以代轉');
  const dis = post(sb, 'setActive', { id: 'u002', active: false }, boss);
  ok(dis.ok === true, '3e: admin 停用會計', dis);
  const r = sb.proxyAuthorize_(acc, 'audit', 'getAll');
  ok(r.ok === false && r.code === 'BAD_TOKEN' && !hasAnySecret(r), '3f: 停用帳號（token 沒過期）下一次代轉立刻 BAD_TOKEN', r);

  const lead = tokenOf(sb, 'lead1', PW.lead);
  ok(sb.proxyAuthorize_(lead, 'audit', 'getAll').ok === true, '3g: 店長登出前可以代轉');
  post(sb, 'logout', {}, lead);
  ok(sb.proxyAuthorize_(lead, 'audit', 'getAll').code === 'BAD_TOKEN', '3h: 登出（token_after）後舊 token → BAD_TOKEN');
  // 直接改分頁停用（不經 setActive）也一樣：每次重查 active
  const mgr = tokenOf(sb, 'mgr1', PW.mgr);
  const rows = sheets.users._rows();
  const ri = rows.findIndex((x) => x[0] === 'u005');
  sheets.users.getRange(ri + 1, 8).setValue('FALSE');
  ok(sb.proxyAuthorize_(mgr, 'dorm', 'list').code === 'BAD_TOKEN', '3i: 試算表直接把 active 改 FALSE → 下一次代轉 BAD_TOKEN');
}

// ============================================================
// 4. 讀寫授權：讀清單以外一律要 <ns>.write
// ============================================================
{
  const { sb } = fresh();
  const acc = tokenOf(sb, 'acc1', PW.acc);
  const lead = tokenOf(sb, 'lead1', PW.lead);
  const mgr = tokenOf(sb, 'mgr1', PW.mgr);
  const viewer = tokenOf(sb, 'viewer1', PW.viewer);
  const boss = tokenOf(sb, 'BOSS', PW.boss);

  const a1 = sb.proxyAuthorize_(acc, 'audit', 'submitAudit');
  ok(a1.ok && a1.isWrite === true && a1.secret === SECRETS.auditWrite, '4a: 會計 submitAudit → 允許、isWrite、用 write 碼（已 trim）', a1);
  const a2 = sb.proxyAuthorize_(acc, 'audit', 'getAll');
  ok(a2.ok && a2.isWrite === false && a2.secret === SECRETS.auditWrite, '4b: 會計 getAll → 讀、仍用 write 碼（有 .write 就用 write 碼）', a2);

  const l1 = sb.proxyAuthorize_(lead, 'audit', 'getAll');
  ok(l1.ok && l1.isWrite === false && l1.secret === SECRETS.auditRead, '4c: 店長 getAll → 允許、用 read 碼', l1);
  for (const act of ['submitAudit', 'markRest', 'addStore', 'submitOpsAudit', 'whatever', 'getall']) {
    const x = sb.proxyAuthorize_(lead, 'audit', act);
    ok(x.ok === false && x.code === 'FORBIDDEN' && !hasAnySecret(x), '4d: 店長（只有 read.own）' + act + ' → FORBIDDEN（讀清單以外一律算寫入；大小寫不同也算）', x);
  }
  ok(sb.proxyAuthorize_(lead, 'dorm', 'list').code === 'FORBIDDEN', '4e: 店長沒有任何 dorm 權限 → FORBIDDEN');

  const m1 = sb.proxyAuthorize_(mgr, 'dorm', 'handoverSign');
  ok(m1.ok && m1.isWrite && m1.secret === SECRETS.dormWrite, '4f: 主管 dorm.handoverSign → 允許、write 碼', m1);
  ok(sb.proxyAuthorize_(mgr, 'audit', 'submitAudit').code === 'FORBIDDEN', '4g: 主管沒有 audit.write → submitAudit FORBIDDEN');
  ok(sb.proxyAuthorize_(mgr, 'audit', 'getAll').secret === SECRETS.auditRead, '4h: 主管 audit getAll → read 碼');

  ok(sb.proxyAuthorize_(viewer, 'dorm', 'terminate').code === 'FORBIDDEN', '4i: 只有 dorm.read → terminate FORBIDDEN');
  const v2 = sb.proxyAuthorize_(viewer, 'dorm', 'list');
  ok(v2.ok === false && v2.code === 'NO_SECRET' && !hasAnySecret(v2), '4j: 只有 dorm.read、但 dorm 沒有 read 級的碼 → NO_SECRET', v2);

  const b1 = sb.proxyAuthorize_(boss, 'dorm', 'create');
  ok(b1.ok && b1.isWrite && b1.secret === SECRETS.dormWrite && b1.filterNode === null, '4k: admin（*）dorm.create → 允許、不裁切', b1);
}

// ============================================================
// 5. filterNode：只有 read.own（沒有 .read）才裁；.write 不豁免；沒節點＝''
// ============================================================
{
  const { sb } = fresh();
  const t = (u, pw) => tokenOf(sb, u, pw);
  ok(sb.proxyAuthorize_(t('lead1', PW.lead), 'audit', 'getAll').filterNode === 'sxl-gf', '5a: 店長 → filterNode＝自己節點 sxl-gf');
  ok(sb.proxyAuthorize_(t('nonode', PW.nonode), 'audit', 'getAll').filterNode === '', '5b: 店長沒節點 → filterNode＝\'\'（執行器回空列，往關的方向失敗）');
  ok(sb.proxyAuthorize_(t('acc1', PW.acc), 'audit', 'getAll').filterNode === null, '5c: 會計（audit.read）→ 不裁');
  ok(sb.proxyAuthorize_(t('BOSS', PW.boss), 'audit', 'getAll').filterNode === null, '5d: admin（*）→ 不裁');
  ok(sb.proxyAuthorize_(t('mgr1', PW.mgr), 'audit', 'getAll').filterNode === null, '5e: 主管（audit.read）→ 不裁');
  const mix = sb.proxyAuthorize_(t('mix1', PW.mix), 'audit', 'submitAudit');
  ok(mix.ok && mix.filterNode === 'mzt-gf', '5f: 有 audit.write＋read.own、沒有 .read → 仍要裁（.write 不豁免）', mix);
}

// ============================================================
// 6. ns 必須是 module_secrets 出現過的；原型鏈名稱也擋
// ============================================================
{
  const { sb } = fresh();
  const boss = tokenOf(sb, 'BOSS', PW.boss);
  for (const ns of ['platform', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', 'AUDIT']) {
    const r = sb.proxyAuthorize_(boss, ns, 'getAll');
    ok(r.ok === false && r.code === 'UNKNOWN_NS', '6: ns=' + JSON.stringify(ns) + ' → UNKNOWN_NS', r);
  }
}

// ============================================================
// 7. 純數字通行碼一律轉字串；失敗訊息永遠不含通行碼
// ============================================================
{
  const { sb } = fresh({ module_secrets: [['backend_id', 'level', 'secret'], ['audit', 'read', 123456], ['audit', 'write', 654321]] });
  const lead = tokenOf(sb, 'lead1', PW.lead);
  const r = sb.proxyAuthorize_(lead, 'audit', 'getAll');
  ok(r.ok && r.secret === '123456' && typeof r.secret === 'string', '7a: 儲存格是數字 123456 → 字串 "123456"', r);
}

// ============================================================
// 8. 純讀：呼叫 proxyAuthorize_ 不寫任何分頁（成功、失敗都一樣）
// ============================================================
{
  const { sb, sheets } = fresh();
  const lead = tokenOf(sb, 'lead1', PW.lead);
  const acc = tokenOf(sb, 'acc1', PW.acc);
  const before = snapshot(sheets);
  sb.proxyAuthorize_(lead, 'audit', 'getAll');
  sb.proxyAuthorize_(lead, 'audit', 'submitAudit');
  sb.proxyAuthorize_(acc, 'audit', 'submitAudit');
  sb.proxyAuthorize_('garbage', 'audit', 'getAll');
  sb.proxyAuthorize_(acc, 'nope', 'getAll');
  ok(snapshot(sheets) === before, '8: 代轉授權前後所有分頁一格都沒變（不寫 login_log、不更新 last_login）');
}

// ============================================================
// 9. 讀清單兩邊同步：Auth.gs PROXY_READ_ACTIONS ＝ platform/dryrun.js READ_ACTIONS（audit／dorm）
// ============================================================
{
  const { sb } = fresh();
  ok(JSON.stringify(sb.PROXY_READ_ACTIONS.audit) === JSON.stringify(READ_ACTIONS.audit), '9a: audit 讀清單兩邊一致', [sb.PROXY_READ_ACTIONS.audit, READ_ACTIONS.audit]);
  ok(JSON.stringify(sb.PROXY_READ_ACTIONS.dorm) === JSON.stringify(READ_ACTIONS.dorm), '9b: dorm 讀清單兩邊一致', [sb.PROXY_READ_ACTIONS.dorm, READ_ACTIONS.dorm]);
}

// ============================================================
// 10. 同仁認領待審（舊 token）也一律 BAD_TOKEN（與 handleMe_ 同一套閘門）
// ============================================================
{
  const { sb, sheets } = fresh();
  const boss = tokenOf(sb, 'BOSS', PW.boss);
  // 假造一個 staff 角色的 token，對應 staff 分頁 pending 的人
  post(sb, 'staffImport', { names: ['代轉測試'] }, boss);
  const cl = post(sb, 'claimSubmit', { name: '代轉測試', emp_no: 'DZY001', password: 'fake-staff-pw-9', brand: 'mzt', unit: 'mzt-gf', dept: '', title: 'pt', birthday: '1995-05-05', phone: '0911222333', address: '新竹市測試路一段1號' });
  ok(cl.ok === true, '10a: 認領送出（待審）', cl);
  const row = sheets.users._rows().find((x) => x[1] === 'DZY001');
  const u = row && { id: row[0] };
  ok(!!u, '10b: 找到認領後的帳號');
  const forged = u && sb.issueToken_({ id: u.id, role: 'staff', node: '' });
  const r = sb.proxyAuthorize_(forged, 'audit', 'getAll');
  ok(r.ok === false && r.code === 'BAD_TOKEN', '10c: 認領待審的同仁即使有合法簽章 token 也 BAD_TOKEN', r);
}

// ============================================================
// 11. 第二期：role staff 依職稱／部門算出的稽核範圍（PERMS_ON='1'）
// ============================================================
let phoneSeq = 0;
function mkStaff(sb, bossTok, name, org, pw) {
  post(sb, 'staffImport', { names: [name] }, bossTok);
  const lk = post(sb, 'claimLookup', { name });
  phoneSeq++;
  const prof = Object.assign({ dept: '', birthday: '1990-01-0' + (1 + (phoneSeq % 8)), phone: '09' + String(10000000 + phoneSeq), address: '新竹市測試路' + phoneSeq + '號' }, org);
  const sub = post(sb, 'claimSubmit', Object.assign({ name, emp_no: lk.data.emp_no, password: pw || 'fake-staff-pw-1' }, prof));
  if (!sub.ok) throw new Error('claimSubmit 失敗 ' + sub.error);
  const cf = post(sb, 'staffConfirm', { emp_no: lk.data.emp_no }, bossTok);
  if (!cf.ok) throw new Error('staffConfirm 失敗 ' + cf.error);
  const lg = post(sb, 'login', { username: lk.data.emp_no, password: pw || 'fake-staff-pw-1' });
  if (!lg.ok) throw new Error('同仁登入失敗 ' + lg.error);
  return { emp: lk.data.emp_no, token: lg.data.token, login: lg };
}
const turnOn = (sb) => sb.PropertiesService.getScriptProperties().setProperty('PERMS_ON', '1');
{
  const { sb, sheets } = fresh();
  const boss = tokenOf(sb, 'BOSS', PW.boss);
  const sm = mkStaff(sb, boss, '店長甲', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  const osv = mkStaff(sb, boss, '區督導乙', { brand: 'mzt', unit: 'mzt-hq', title: 'osv' });
  const smNo = mkStaff(sb, boss, '店長丙', { brand: 'yiwu', unit: 'yiwu-js', title: 'sm' });
  const pt = mkStaff(sb, boss, '計時丁', { brand: 'mala', unit: 'mala-gf', title: 'pt' });
  const fin = mkStaff(sb, boss, '財務戊', { brand: 'dzy', unit: 'dzy-hq', dept: 'fin', title: 'hs' });
  const hr = mkStaff(sb, boss, '人資己', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' });
  const wr = mkStaff(sb, boss, '純寫庚', { brand: 'mala', unit: 'mala-gf', title: 'pt' });

  // ── 開關關（預設）：同仁照舊——沒有任何稽核權限、不讀 perm 表、login／me 沒有 audit_scope
  sb.permLoadTables_ = () => { throw new Error('開關關時不該讀 perm 表'); };
  sb.permInit_({ role: 'admin', id: 'u001' }); // permInit_ 不讀 permLoadTables_，只建表
  const offSm = sb.proxyAuthorize_(sm.token, 'audit', 'getAll');
  ok(offSm.ok === false && offSm.code === 'FORBIDDEN', '11a: 開關關 → 同仁（店長）照舊 FORBIDDEN', offSm);
  const offMe = post(sb, 'me', {}, sm.token);
  ok(offMe.ok && !('audit_scope' in offMe.data) && offMe.data.perms.join() === 'platform.self,platform.review', '11a2: 開關關 → me 沒有任何稽核權限（只有 self＋店長的 review）、沒有 audit_scope', offMe.data);
  ok(sb.proxyAuthorize_(fin.token, 'audit', 'submitAudit').code === 'FORBIDDEN', '11a3: 開關關 → 財務同仁不能寫');
}
{
  const { sb, sheets } = fresh();
  const boss = tokenOf(sb, 'BOSS', PW.boss);
  const mk = (n, o) => mkStaff(sb, boss, n, o);
  const sm = mk('店長甲', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  const osv = mk('區督導乙', { brand: 'mzt', unit: 'mzt-hq', title: 'osv' });
  const smNo = mk('店長丙', { brand: 'yiwu', unit: 'yiwu-js', title: 'sm' });
  const pt = mk('計時丁', { brand: 'mala', unit: 'mala-gf', title: 'pt' });
  const fin = mk('財務戊', { brand: 'dzy', unit: 'dzy-hq', dept: 'fin', title: 'hs' });
  const hr = mk('人資己', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' });
  const wr = mk('純寫庚', { brand: 'mala', unit: 'mala-gf', title: 'pt' });
  const ini = sb.permInit_({ role: 'admin', id: 'u001' });
  ok(ini.ok === true, '11 前置：permInit_ 建表', ini);
  // 純 write：只靠個別例外給 audit.write（沒有 audit.read）
  sheets.perm_ex.appendRow(['X001', wr.emp, 'audit.write', 'add', '', '測試', 'TRUE', '', 'u001', '', '']);
  turnOn(sb);

  // 對照組：開關開了之後，系統帳號行為逐字不變
  ok(sb.proxyAuthorize_(tokenOf(sb, 'lead1', PW.lead), 'audit', 'getAll').filterNode === 'sxl-gf', '11b0: 開關開 → 系統店長仍回字串節點 sxl-gf');
  ok(sb.proxyAuthorize_(tokenOf(sb, 'acc1', PW.acc), 'audit', 'getAll').filterNode === null, '11b0: 開關開 → 系統會計仍 null');

  const smR = sb.proxyAuthorize_(sm.token, 'audit', 'getAll');
  ok(smR.ok && JSON.stringify(smR.filterNode) === '["sxl-gf"]' && smR.secret === SECRETS.auditRead && smR.isWrite === false, '11b: 店長（同仁）→ filterNode 陣列 ["sxl-gf"]、read 碼', smR);
  const osvR = sb.proxyAuthorize_(osv.token, 'audit', 'getAll');
  ok(osvR.ok && JSON.stringify(osvR.filterNode) === '["mzt-gf","mzt-js","mzt-lzl"]' && osvR.secret === SECRETS.auditRead, '11c: 區督導（brand）→ 自己品牌的店陣列、read 碼（brand 永不回 null）', osvR);
  const noR = sb.proxyAuthorize_(smNo.token, 'audit', 'getAll');
  ok(noR.ok && Array.isArray(noR.filterNode) && noR.filterNode.length === 0, '11d: 店長的店沒有店別對照 → 空陣列 []（全部裁空，仍放行）', noR);
  const ptR = sb.proxyAuthorize_(pt.token, 'audit', 'getAll');
  ok(ptR.ok === false && ptR.code === 'FORBIDDEN' && !hasAnySecret(ptR), '11e: 計時同仁（none）→ 403 FORBIDDEN', ptR);
  const finR = sb.proxyAuthorize_(fin.token, 'audit', 'getAll');
  ok(finR.ok && finR.filterNode === null && finR.secret === SECRETS.auditWrite, '11f: 財務同仁（audit.read＋write → all）→ filterNode null、write 碼', finR);
  ok(sb.proxyAuthorize_(fin.token, 'audit', 'submitAudit').ok === true, '11f2: 財務同仁可寫入');
  ok(sb.proxyAuthorize_(sm.token, 'audit', 'submitAudit').code === 'FORBIDDEN', '11g: 店長（同仁）不能寫入');
  ok(sb.proxyAuthorize_(osv.token, 'audit', 'submitAudit').code === 'FORBIDDEN', '11g2: 區督導不能寫入');
  const wrR = sb.proxyAuthorize_(wr.token, 'audit', 'getAll');
  ok(wrR.ok && wrR.filterNode === null && wrR.secret === SECRETS.auditWrite, '11h: 純 audit.write 的同仁（例外給）→ 讀取回 null（write 視同 read，scope all）', wrR);
  const wrMe = post(sb, 'me', {}, wr.token);
  ok(wrMe.data.perms.indexOf('audit.read') !== -1 && wrMe.data.perms.indexOf('audit.write') !== -1 && wrMe.data.audit_scope === 'all', '11h2: audit.write 存在時 perms 也補 audit.read、audit_scope=all', wrMe.data);
  const hrD = sb.proxyAuthorize_(hr.token, 'dorm', 'list');
  ok(hrD.ok && hrD.filterNode === null && hrD.secret === SECRETS.dormWrite, '11i: 人資同仁 dorm.list → 不裁切（dorm 照舊）', hrD);
  ok(sb.proxyAuthorize_(hr.token, 'audit', 'getAll').code === 'FORBIDDEN', '11i2: 人資同仁沒有稽核權限 → FORBIDDEN');
  ok(sb.proxyAuthorize_(sm.token, 'dorm', 'list').code === 'FORBIDDEN', '11i3: 店長沒有宿舍權限 → FORBIDDEN');

  // login／me 對外：perms 陣列＋audit_scope
  const lg = post(sb, 'login', { username: sm.emp, password: 'fake-staff-pw-1' });
  ok(lg.ok && Array.isArray(lg.data.perms) && lg.data.perms.indexOf('audit.read.own') !== -1 && JSON.stringify(lg.data.audit_scope) === '["sxl-gf"]', '11j: login 回 perms 陣列含 audit.read.own，另有 audit_scope', lg.data);
  ok(post(sb, 'me', {}, osv.token).data.audit_scope.join() === 'mzt-gf,mzt-js,mzt-lzl', '11j2: me 的 audit_scope 是陣列');
  ok(post(sb, 'me', {}, pt.token).data.audit_scope === 'none', '11j3: 沒權限的同仁 audit_scope=\'none\'');

  // 永不回 secrets（即使 LEGACY_SECRETS=1）；系統帳號照舊
  sb.PropertiesService.getScriptProperties().setProperty('LEGACY_SECRETS', '1');
  const l2 = post(sb, 'login', { username: fin.emp, password: 'fake-staff-pw-1' });
  const m2 = post(sb, 'me', {}, fin.token);
  ok(l2.ok && !('secrets' in l2.data) && !('secrets' in m2.data) && !hasAnySecret(l2) && !hasAnySecret(m2), '11k: LEGACY_SECRETS=1 → role staff 的 login／me 仍沒有 secrets', [l2.data, m2.data]);
  ok(post(sb, 'me', {}, tokenOf(sb, 'acc1', PW.acc)).data.secrets !== undefined, '11k2: LEGACY_SECRETS=1 → 系統帳號照舊回 secrets');
  sb.PropertiesService.getScriptProperties().setProperty('LEGACY_SECRETS', '');

  // 非 active：staff 列被改成 disabled（users 仍 active）→ session 拒絕
  const ri = sheets.staff._rows().findIndex((r) => r[0] === sm.emp);
  sheets.staff.getRange(ri + 1, sb.STF_COL.status + 1).setValue('disabled');
  ok(post(sb, 'me', {}, sm.token).ok === false, '11l: 開關開 → staff 列不是 active → me 拒絕');
  ok(sb.proxyAuthorize_(sm.token, 'audit', 'getAll').code === 'BAD_TOKEN', '11l2: 同上 → 代轉 BAD_TOKEN');
  ok(post(sb, 'login', { username: sm.emp, password: 'fake-staff-pw-1' }).ok === false, '11l3: 同上 → login 拒絕');
  // staff 列不存在
  const gone = sheets.staff._rows().findIndex((r) => r[0] === osv.emp);
  sheets.staff.deleteRow(gone + 1);
  ok(post(sb, 'me', {}, osv.token).ok === false, '11l4: 開關開 → staff 列不存在 → me 拒絕');
}
{
  // 開關關時 staff 列不存在／非 active 照舊（不改行為）
  const { sb, sheets } = fresh();
  const boss = tokenOf(sb, 'BOSS', PW.boss);
  const sm = mkStaff(sb, boss, '店長甲', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  const ri = sheets.staff._rows().findIndex((r) => r[0] === sm.emp);
  sheets.staff.deleteRow(ri + 1);
  ok(post(sb, 'me', {}, sm.token).ok === true, '11m: 開關關 → staff 列不存在仍照舊放行（不改行為）');
  sb.PropertiesService.getScriptProperties().setProperty('PERMS_ON', 'true');
  ok(post(sb, 'me', {}, sm.token).ok === true, '11m2: PERMS_ON 不是恰好 \'1\'（\'true\'）→ 視為關');
}

// ============================================================
// 12. 寫入白名單：寫入 action 不在表內一律 FORBIDDEN（即使有 <ns>.write）；前端用到的寫入 action 都在表內
// ============================================================
{
  const { sb } = fresh();
  const boss = tokenOf(sb, 'BOSS', PW.boss);
  const acc = tokenOf(sb, 'acc1', PW.acc);
  const mgr = tokenOf(sb, 'mgr1', PW.mgr);
  for (const act of ['delete', 'cleanupTest', 'setSetting']) {
    const a = sb.proxyAuthorize_(boss, 'dorm', act);
    ok(a.ok === false && a.code === 'FORBIDDEN' && !hasAnySecret(a), '12a: admin 打 dorm.' + act + '（不在寫入白名單）→ FORBIDDEN', a);
    const m = sb.proxyAuthorize_(mgr, 'dorm', act);
    ok(m.ok === false && m.code === 'FORBIDDEN', '12b: 有 dorm.write 的主管打 dorm.' + act + ' → FORBIDDEN', m);
  }
  const x = sb.proxyAuthorize_(acc, 'audit', 'dropEverything');
  ok(x.ok === false && x.code === 'FORBIDDEN', '12c: 有 audit.write 打不在表內的 audit action → FORBIDDEN', x);

  // 前端實際用到的寫入 action（掃原始碼字面值）都必須在 Auth.gs 白名單內
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const used = { audit: new Set(), dorm: new Set() };
  for (const f of walk('modules')) {
    const src = read(f);
    const ns = f.startsWith('modules/dorm') ? 'dorm' : (f.startsWith('modules/audit') ? 'audit' : null);
    if (!ns) continue;
    for (const m of src.matchAll(/(?:submit\(ctx,\s*|write\(|call\((?:BACKEND_ID|'dorm'|'audit'),\s*)'(\w+)'/g)) used[ns].add(m[1]);
  }
  for (const ns of ['audit', 'dorm']) {
    ok(used[ns].size > 0, '12d: 掃到 ' + ns + ' 前端呼叫的 action（' + [...used[ns]].join(',') + '）');
    for (const act of used[ns]) {
      const inRead = sb.PROXY_READ_ACTIONS[ns].includes(act);
      const inWrite = (sb.PROXY_WRITE_ACTIONS && sb.PROXY_WRITE_ACTIONS[ns] || []).includes(act);
      ok(inRead || inWrite, '12e: 前端用到 ' + ns + '.' + act + ' 在白名單內', { inRead, inWrite });
    }
  }
  ok(JSON.stringify(sb.PROXY_WRITE_ACTIONS && sb.PROXY_WRITE_ACTIONS.audit) === JSON.stringify(WRITE_ACTIONS.audit), '12f: audit 寫入清單兩邊（Auth.gs／dryrun.js）一致');
  ok(JSON.stringify(sb.PROXY_WRITE_ACTIONS && sb.PROXY_WRITE_ACTIONS.dorm) === JSON.stringify(WRITE_ACTIONS.dorm), '12g: dorm 寫入清單兩邊一致');
}

// ============================================================
// 13. 薪酬系統（2026-10-19）：payroll.write 一個開關、管理金鑰只在代轉時給、操作人由平台決定
// ============================================================
{
  const PAY = 'FAKE-PAYROLL-ADMIN-KEY-55';
  const extra = { module_secrets: seed().module_secrets.concat([['payroll', 'write', PAY]]) };
  const { sb, sheets } = fresh(extra);
  const boss = tokenOf(sb, 'BOSS', PW.boss);
  const hasPay = (o) => JSON.stringify(o).indexOf(PAY) !== -1;

  ok(JSON.stringify(sb.PROXY_READ_ACTIONS.payroll) === JSON.stringify(READ_ACTIONS.payroll), '13a: payroll 讀清單兩邊（Auth.gs／dryrun.js）一致');
  ok(JSON.stringify(sb.PROXY_WRITE_ACTIONS.payroll) === JSON.stringify(WRITE_ACTIONS.payroll), '13b: payroll 寫入清單兩邊一致');
  ok(sb.PERM_GRANTABLE.indexOf('payroll.write') !== -1 && sb.PERM_LOCKED.indexOf('payroll.write') !== -1, '13c: payroll.write 可給、且是鎖碼（只有 admin 能開給人）');

  const a = sb.proxyAuthorize_(boss, 'payroll', 'payroll_month');
  ok(a.ok && a.secret === PAY && a.isWrite === false && a.filterNode === null, '13d: admin 讀 → 給管理金鑰、讀、不裁切', a);
  ok(a.operator === '系統管理者（BOSS）（管理系統）', '13e: 操作人＝登入者姓名＋帳號（平台決定）', a.operator);
  const w = sb.proxyAuthorize_(boss, 'payroll', 'payroll_finalize');
  ok(w.ok && w.isWrite === true && w.operator, '13f: admin 鎖定本月 → 寫入、帶操作人', w);
  ok(sb.proxyAuthorize_(boss, 'payroll', 'payroll_migrate_store').code === 'FORBIDDEN', '13g: 不在白名單的維運 action（payroll_migrate_store）→ FORBIDDEN');
  ok(sb.proxyAuthorize_(boss, 'audit', 'getAll').operator === undefined, '13h: 其他系統不帶 operator（舊後端不認）');

  for (const [u, pw] of [['acc1', PW.acc], ['lead1', PW.lead], ['mgr1', PW.mgr], ['viewer1', PW.viewer]]) {
    const t = tokenOf(sb, u, pw);
    for (const act of ['payroll_month', 'payroll_calc']) {
      const r = sb.proxyAuthorize_(t, 'payroll', act);
      ok(r.ok === false && r.code === 'FORBIDDEN' && !hasPay(r), '13i: 沒有 payroll.write 的 ' + u + ' ' + act + ' → FORBIDDEN、不含金鑰', r);
    }
  }
  // 過渡旗標打開也絕不下發薪酬金鑰
  sb.PropertiesService.getScriptProperties().setProperty('LEGACY_SECRETS', '1');
  const lg = post(sb, 'login', { username: 'BOSS', password: PW.boss });
  ok(lg.ok && !hasPay(lg) && !hasPay(post(sb, 'me', {}, lg.data.token)), '13j: LEGACY_SECRETS=1 時 admin 的 login／me 仍不含薪酬金鑰', lg.data && lg.data.secrets);
  ok(!('payroll' in sb.pickSecrets_(['*'])), '13k: pickSecrets_ 永不含 payroll');
  sb.PropertiesService.getScriptProperties().setProperty('LEGACY_SECRETS', '');

  // 同仁（PERMS_ON）：人資主管預設沒有；只有個別例外給 payroll.write 的人才進得去
  const hrHead = mkStaff(sb, boss, '人資主管辛', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hm' });
  const hrStaff = mkStaff(sb, boss, '人資同仁壬', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' });
  ok(sb.permInit_({ role: 'admin', id: 'u001' }).ok === true, '13 前置：permInit_');
  turnOn(sb);
  ok(sb.proxyAuthorize_(hrHead.token, 'payroll', 'payroll_month').code === 'FORBIDDEN', '13l: 人資主管預設沒有薪酬權限 → FORBIDDEN');
  sheets.perm_ex.appendRow(['X901', hrHead.emp, 'payroll.write', 'add', '', 'Eason 開', 'TRUE', '', 'u001', '', '']);
  const h = sb.proxyAuthorize_(hrHead.token, 'payroll', 'payroll_calc');
  ok(h.ok && h.secret === PAY && h.isWrite === true && /人資主管辛（DZY\d+）（管理系統）/.test(h.operator), '13m: 個別例外給了 payroll.write 的人資主管 → 可寫、操作人是本人', h);
  ok(sb.proxyAuthorize_(hrStaff.token, 'payroll', 'payroll_month').code === 'FORBIDDEN', '13n: 同部門其他人資同仁仍 FORBIDDEN');
  const me = post(sb, 'me', {}, hrHead.token);
  ok(me.ok && !hasPay(me) && me.data.perms.indexOf('payroll.write') !== -1, '13o: 人資主管 me 有 payroll.write 但不含金鑰', me.data && me.data.perms);
  // 停用帳號 → 下一次代轉就擋
  const rowIdx = sheets.users._rows().findIndex((r) => String(r[1]) === hrHead.emp);
  sheets.users.getRange(rowIdx + 1, 8).setValue('FALSE');
  ok(sb.proxyAuthorize_(hrHead.token, 'payroll', 'payroll_month').code === 'BAD_TOKEN', '13p: 帳號停用後立刻 BAD_TOKEN');
}

// ============================================================
// 14. 考勤管理首頁待辦（2026-10-24，營運系統 spec §17.5）：ns attendance／action attAlerts
//     只認 platform.att（含衍生）；用 attendance/read 服務金鑰；subject＝登入身分的 DZY 編號（admin 為 U:<id>）
// ============================================================
{
  const ATT = 'FAKE-ATT-ALERT-KEY-31';
  const extra = { module_secrets: seed().module_secrets.concat([['attendance', 'read', ATT]]) };
  const { sb, sheets } = fresh(extra);
  const boss = tokenOf(sb, 'BOSS', PW.boss);
  const props = sb.PropertiesService.getScriptProperties();
  props.setProperty('STORE_SSO_UNITS', 'mala-gf');

  ok(JSON.stringify(sb.PROXY_READ_ACTIONS.attendance) === JSON.stringify(READ_ACTIONS.attendance) && READ_ACTIONS.attendance[0] === 'attAlerts', '14a: attendance 讀清單兩邊（Auth.gs／dryrun.js）一致且含 attAlerts', [sb.PROXY_READ_ACTIONS.attendance, READ_ACTIONS.attendance]);

  const a = sb.proxyAuthorize_(boss, 'attendance', 'attAlerts');
  ok(a.ok === true && a.secret === ATT && a.filterNode === null && a.isWrite === false && a.subject === 'U:u001', '14b: admin → 服務金鑰、讀、subject＝U:<id>', a);
  ok(sb.proxyAuthorize_(boss, 'attendance', 'attSetSomething').code === 'FORBIDDEN', '14c: action 不是 attAlerts（admin 也）→ FORBIDDEN');

  const sm = mkStaff(sb, boss, '考勤店長', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  const r = sb.proxyAuthorize_(sm.token, 'attendance', 'attAlerts');
  ok(r.ok === true && r.secret === ATT && r.isWrite === false && r.subject === sm.emp && /^DZY\d+$/.test(String(r.subject)), '14d: 有 platform.att 的店長 → subject＝DZY 編號', r);
  ok(sb.proxyAuthorize_(sm.token, 'attendance', 'attWrite').code === 'FORBIDDEN', '14e: 店長打非 attAlerts → FORBIDDEN');
  ok(sb.proxyAuthorize_(sm.token, 'attendance', 'attAlerts').secret !== undefined && JSON.stringify(post(sb, 'me', {}, sm.token)).indexOf(ATT) === -1, '14f: me 回應不含服務金鑰');

  const pt = mkStaff(sb, boss, '考勤計時', { brand: 'mala', unit: 'mala-gf', title: 'pt' });
  ok(sb.proxyAuthorize_(pt.token, 'attendance', 'attAlerts').code === 'FORBIDDEN', '14g: 沒有 platform.att 的計時同仁 → FORBIDDEN');
  ok(sb.proxyAuthorize_(tokenOf(sb, 'acc1', PW.acc), 'attendance', 'attAlerts').code === 'FORBIDDEN', '14h: 會計（非 staff、無 platform.att）→ FORBIDDEN');
  // 即使有 attendance.read 之類的通用權限也不走通用邏輯
  sheets.roles.appendRow(['attrole', '假', 'attendance.read,attendance.write']);
  sheets.users.appendRow(['u090', 'attx', '假', 'attrole', '', 's9', H('fake-attx-pw-01', 's9'), 'TRUE', '', '', '']);
  ok(sb.proxyAuthorize_(tokenOf(sb, 'attx', 'fake-attx-pw-01'), 'attendance', 'attAlerts').code === 'FORBIDDEN', '14i: 只有 attendance.read 通用權限、沒有 platform.att → FORBIDDEN（不走通用邏輯）');

  // 有 platform.att 但 storeSubForUser_ 回空（非 DZY 編號的系統帳號）→ FORBIDDEN
  sheets.roles.appendRow(['attsys', '假', 'platform.att']);
  sheets.users.appendRow(['u091', 'sysatt', '假', 'attsys', '', 's9', H('fake-sysatt-pw-01', 's9'), 'TRUE', '', '', '']);
  ok(sb.proxyAuthorize_(tokenOf(sb, 'sysatt', 'fake-sysatt-pw-01'), 'attendance', 'attAlerts').code === 'FORBIDDEN', '14j: 有 platform.att 但沒有 DZY 編號身分（subject 空）→ FORBIDDEN');

  // PERMS_ON 開（第二期權限表）：platform.att 由 authPermsWithGate_ 併入、與開關無關 → 店長照樣 ok＋DZY subject，計時照樣 FORBIDDEN（2026-10-24 總審）
  ok(sb.permInit_({ role: 'admin', id: 'u001' }).ok === true, '14n 前置：permInit_ 建表');
  turnOn(sb);
  const rOn = sb.proxyAuthorize_(sm.token, 'attendance', 'attAlerts');
  ok(rOn.ok === true && rOn.secret === ATT && rOn.isWrite === false && rOn.subject === sm.emp && /^DZY\d+$/.test(String(rOn.subject)), '14n: PERMS_ON 開 → 店長仍 ok、subject＝DZY 編號', rOn);
  ok(sb.proxyAuthorize_(pt.token, 'attendance', 'attAlerts').code === 'FORBIDDEN', '14o: PERMS_ON 開 → 計時同仁仍 FORBIDDEN');
  ok(sb.proxyAuthorize_(boss, 'attendance', 'attAlerts').subject === 'U:u001', '14p: PERMS_ON 開 → admin 仍 subject＝U:<id>');

  // 沒設 attendance/read → NO_SECRET；整個 ns 沒登記 → UNKNOWN_NS
  const n = fresh();
  ok(n.sb.proxyAuthorize_(tokenOf(n.sb, 'BOSS', PW.boss), 'attendance', 'attAlerts').code === 'UNKNOWN_NS', '14k: module_secrets 沒有 attendance → UNKNOWN_NS');
  const w = fresh({ module_secrets: seed().module_secrets.concat([['attendance', 'write', 'FAKE-ONLY-WRITE']]) });
  ok(w.sb.proxyAuthorize_(tokenOf(w.sb, 'BOSS', PW.boss), 'attendance', 'attAlerts').code === 'NO_SECRET', '14l: 只有 attendance/write、沒有 read → NO_SECRET（不拿寫入碼頂替）');
  const num = fresh({ module_secrets: seed().module_secrets.concat([['attendance', 'read', 123456]]) });
  ok(String(num.sb.proxyAuthorize_(tokenOf(num.sb, 'BOSS', PW.boss), 'attendance', 'attAlerts').secret) === '123456', '14m: 純數字金鑰被試算表轉成 number 也回字串');
}

// ============================================================
// 15. 收支管理（2026-10-24）：cashbook.write 一個開關（不是鎖碼）、財務部門預設有、管理金鑰只在代轉時給、操作人由平台決定
// ============================================================
{
  const CB = 'FAKE-CASHBOOK-ADMIN-KEY-66';
  const extra = { module_secrets: seed().module_secrets.concat([['cashbook', 'write', CB]]) };
  const { sb, sheets } = fresh(extra);
  const boss = tokenOf(sb, 'BOSS', PW.boss);
  const hasCb = (o) => JSON.stringify(o).indexOf(CB) !== -1;
  const READ = ['adminStores', 'adminList', 'adminLocks', 'adminGet'];
  const WRITE = ['adminSave', 'adminVoid', 'adminLock', 'adminUnlock'];

  ok(JSON.stringify(sb.PROXY_READ_ACTIONS.cashbook) === JSON.stringify(READ) && JSON.stringify(READ_ACTIONS.cashbook) === JSON.stringify(READ), '15a: cashbook 讀清單兩邊（Auth.gs／dryrun.js）一致，且就是 adminStores／adminList／adminLocks／adminGet');
  ok(JSON.stringify(sb.PROXY_WRITE_ACTIONS.cashbook) === JSON.stringify(WRITE) && JSON.stringify(WRITE_ACTIONS.cashbook) === JSON.stringify(WRITE), '15b: cashbook 寫入清單兩邊一致，且就是 adminSave／adminVoid／adminLock／adminUnlock');
  ok(sb.PERM_GRANTABLE.indexOf('cashbook.write') !== -1 && sb.PERM_LOCKED.indexOf('cashbook.write') === -1, '15c: cashbook.write 可給、且不是鎖碼（人資可在權限設定打開）');
  ok(sb.permName_('cashbook.write') === '收支管理', '15d: 中文名「收支管理」');
  ok(sb.PERM_DEFAULT_RULES.some((r) => r.join('|') === 'hq|fin|*|cashbook.write'), '15e: 財務部門預設規則 hq／fin／*／cashbook.write');

  for (const act of READ) {
    const a = sb.proxyAuthorize_(boss, 'cashbook', act);
    ok(a.ok && a.secret === CB && a.isWrite === false && a.filterNode === null, '15f: admin ' + act + ' → 讀、給管理金鑰、不裁切', a);
  }
  const a0 = sb.proxyAuthorize_(boss, 'cashbook', 'adminList');
  ok(a0.operator === '系統管理者（BOSS）（管理系統）', '15g: 操作人＝登入者姓名＋帳號（平台決定，呼叫端沒有地方可以帶）', a0.operator);
  for (const act of WRITE) {
    const w = sb.proxyAuthorize_(boss, 'cashbook', act);
    ok(w.ok && w.isWrite === true && w.secret === CB && /（管理系統）$/.test(w.operator), '15h: admin ' + act + ' → 寫入、帶操作人', w);
  }
  for (const bad of ['adminSetPass', 'create', 'update', 'void', 'lock', 'unlock', 'bootstrap', 'list', 'pnlSummary', '']) {
    ok(sb.proxyAuthorize_(boss, 'cashbook', bad).code === 'FORBIDDEN', '15i: 不在白名單的 action「' + bad + '」→ FORBIDDEN（門市通道動作、損益動作都不通）');
  }

  for (const [u, pw] of [['acc1', PW.acc], ['lead1', PW.lead], ['mgr1', PW.mgr], ['viewer1', PW.viewer]]) {
    const t = tokenOf(sb, u, pw);
    for (const act of ['adminList', 'adminVoid']) {
      const r = sb.proxyAuthorize_(t, 'cashbook', act);
      ok(r.ok === false && r.code === 'FORBIDDEN' && !hasCb(r), '15j: 沒有 cashbook.write 的 ' + u + ' ' + act + ' → FORBIDDEN、不含金鑰', r);
    }
  }
  ok(sb.proxyAuthorize_('', 'cashbook', 'adminList').code === 'NO_TOKEN', '15k: 沒登入 → NO_TOKEN');
  ok(sb.proxyAuthorize_('x.y.z', 'cashbook', 'adminList').code === 'BAD_TOKEN', '15k2: 假 token → BAD_TOKEN');

  // 其他 ns 的 operator 行為不變：audit 不帶；cashbook 與 payroll 帶
  ok(sb.proxyAuthorize_(boss, 'audit', 'getAll').operator === undefined, '15l: audit 仍不帶 operator');

  // 過渡旗標打開也絕不下發收支管理金鑰
  sb.PropertiesService.getScriptProperties().setProperty('LEGACY_SECRETS', '1');
  const lg = post(sb, 'login', { username: 'BOSS', password: PW.boss });
  ok(lg.ok && !hasCb(lg) && !hasCb(post(sb, 'me', {}, lg.data.token)), '15m: LEGACY_SECRETS=1 時 admin 的 login／me 仍不含收支管理金鑰', lg.data && lg.data.secrets);
  ok(!('cashbook' in sb.pickSecrets_(['*'])) && !('cashbook' in sb.pickSecrets_(['cashbook.write'])), '15n: pickSecrets_ 永不含 cashbook');
  sb.PropertiesService.getScriptProperties().setProperty('LEGACY_SECRETS', '');

  // 同仁（PERMS_ON）：財務部門預設有；人資、營運沒有；個別例外給了就有；停用後立刻擋
  const finStaff = mkStaff(sb, boss, '財務同仁甲', { brand: 'dzy', unit: 'dzy-hq', dept: 'fin', title: 'hs' });
  const finHead = mkStaff(sb, boss, '財務主管乙', { brand: 'dzy', unit: 'dzy-hq', dept: 'fin', title: 'hm' });
  const hrStaff = mkStaff(sb, boss, '人資同仁丙', { brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs' });
  const opsStaff = mkStaff(sb, boss, '營運同仁丁', { brand: 'dzy', unit: 'dzy-hq', dept: 'ops', title: 'hs' });
  const store = mkStaff(sb, boss, '店長戊', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  ok(sb.permInit_({ role: 'admin', id: 'u001' }).ok === true, '15 前置：permInit_');
  turnOn(sb);
  for (const who of [finStaff, finHead]) {
    const r = sb.proxyAuthorize_(who.token, 'cashbook', 'adminVoid');
    ok(r.ok && r.secret === CB && r.isWrite === true && r.filterNode === null, '15o: 財務部門同仁預設可寫（作廢）', r);
  }
  ok(/^財務同仁甲（DZY\d+）（管理系統）$/.test(sb.proxyAuthorize_(finStaff.token, 'cashbook', 'adminList').operator), '15p: 財務同仁的操作人是本人姓名＋工號');
  for (const [label, who] of [['人資', hrStaff], ['營運', opsStaff], ['店長', store]]) {
    const r = sb.proxyAuthorize_(who.token, 'cashbook', 'adminList');
    ok(r.ok === false && r.code === 'FORBIDDEN' && !hasCb(r), '15q: ' + label + '同仁沒有收支管理 → FORBIDDEN', r);
  }
  const meFin = post(sb, 'me', {}, finStaff.token);
  ok(meFin.ok && !hasCb(meFin) && meFin.data.perms.indexOf('cashbook.write') !== -1, '15r: 財務同仁 me 有 cashbook.write 但不含金鑰', meFin.data && meFin.data.perms);
  sheets.perm_ex.appendRow(['X902', hrStaff.emp, 'cashbook.write', 'add', '', 'Eason 開', 'TRUE', '', 'u001', '', '']);
  ok(sb.proxyAuthorize_(hrStaff.token, 'cashbook', 'adminLock').ok === true, '15s: 個別例外給了 cashbook.write 的人資同仁 → 可寫（S3 選 B 時就靠這個）');
  sheets.perm_ex.appendRow(['X903', finStaff.emp, 'cashbook.write', 'remove', '', '調走收支', 'TRUE', '', 'u001', '', '']);
  ok(sb.proxyAuthorize_(finStaff.token, 'cashbook', 'adminList').code === 'FORBIDDEN', '15t: 個別例外拿掉 cashbook.write → FORBIDDEN');
  const rowIdx = sheets.users._rows().findIndex((r) => String(r[1]) === finHead.emp);
  sheets.users.getRange(rowIdx + 1, 8).setValue('FALSE');
  ok(sb.proxyAuthorize_(finHead.token, 'cashbook', 'adminList').code === 'BAD_TOKEN', '15u: 帳號停用後立刻 BAD_TOKEN');
}

// ============================================================
// 16. 排班管理首頁待辦（2026-10-24，營運系統 hr-move-spec §5）：ns schedule／action schedAlerts
//     與 attendance 同規則但權限改認 platform.sched（只給能排班的人；有 att 沒 sched → 403），subject＝DZY 編號，用 schedule/read 服務金鑰（與 attendance 的是兩列、同值）
// ============================================================
{
  const SCH = 'FAKE-SCHED-ALERT-KEY-41';
  const extra = { module_secrets: seed().module_secrets.concat([['schedule', 'read', SCH], ['attendance', 'read', 'FAKE-ATT-OTHER']]) };
  const { sb, sheets } = fresh(extra);
  const boss = tokenOf(sb, 'BOSS', PW.boss);
  sb.PropertiesService.getScriptProperties().setProperty('STORE_SSO_UNITS', 'mala-gf');

  ok(JSON.stringify(sb.PROXY_READ_ACTIONS.schedule) === JSON.stringify(READ_ACTIONS.schedule) && READ_ACTIONS.schedule[0] === 'schedAlerts', '16a: schedule 讀清單兩邊（Auth.gs／dryrun.js）一致且含 schedAlerts', [sb.PROXY_READ_ACTIONS.schedule, READ_ACTIONS.schedule]);

  const a = sb.proxyAuthorize_(boss, 'schedule', 'schedAlerts');
  ok(a.ok === true && a.secret === SCH && a.filterNode === null && a.isWrite === false && a.subject === 'U:u001', '16b: admin → schedule 金鑰（不是 attendance 那列）、讀、subject＝U:<id>', a);
  ok(sb.proxyAuthorize_(boss, 'schedule', 'schedSetSomething').code === 'FORBIDDEN', '16c: action 不是 schedAlerts（admin 也）→ FORBIDDEN');
  ok(sb.proxyAuthorize_(boss, 'schedule', 'attAlerts').code === 'FORBIDDEN' && sb.proxyAuthorize_(boss, 'attendance', 'schedAlerts').code === 'FORBIDDEN', '16d: schedule／attendance 的 action 不能互換');

  const sm = mkStaff(sb, boss, '排班店長', { brand: 'mala', unit: 'mala-gf', title: 'sm' });
  const r = sb.proxyAuthorize_(sm.token, 'schedule', 'schedAlerts');
  ok(r.ok === true && r.secret === SCH && r.isWrite === false && r.subject === sm.emp && /^DZY\d+$/.test(String(r.subject)), '16e: 有 platform.sched 的店長 → subject＝DZY 編號', r);
  ok(sb.proxyAuthorize_(sm.token, 'schedule', 'schedWrite').code === 'FORBIDDEN', '16f: 店長打非 schedAlerts → FORBIDDEN');
  ok(JSON.stringify(post(sb, 'me', {}, sm.token)).indexOf(SCH) === -1, '16g: me 回應不含服務金鑰');

  const pt = mkStaff(sb, boss, '排班計時', { brand: 'mala', unit: 'mala-gf', title: 'pt' });
  ok(sb.proxyAuthorize_(pt.token, 'schedule', 'schedAlerts').code === 'FORBIDDEN', '16h: 沒有 platform.sched 的計時同仁 → FORBIDDEN（403）');
  ok(sb.proxyAuthorize_(tokenOf(sb, 'acc1', PW.acc), 'schedule', 'schedAlerts').code === 'FORBIDDEN', '16i: 會計（無 platform.sched）→ FORBIDDEN');
  sheets.roles.appendRow(['schrole', '假', 'schedule.read,schedule.write']);
  sheets.users.appendRow(['u092', 'schx', '假', 'schrole', '', 's9', H('fake-schx-pw-01', 's9'), 'TRUE', '', '', '']);
  ok(sb.proxyAuthorize_(tokenOf(sb, 'schx', 'fake-schx-pw-01'), 'schedule', 'schedAlerts').code === 'FORBIDDEN', '16j: 只有 schedule.read 通用權限、沒有 platform.sched → FORBIDDEN');
  sheets.roles.appendRow(['schsys', '假', 'platform.sched']);
  sheets.users.appendRow(['u093', 'syssch', '假', 'schsys', '', 's9', H('fake-syssch-pw-01', 's9'), 'TRUE', '', '', '']);
  ok(sb.proxyAuthorize_(tokenOf(sb, 'syssch', 'fake-syssch-pw-01'), 'schedule', 'schedAlerts').code === 'FORBIDDEN', '16k: 有 platform.sched 但沒有 DZY 編號身分 → FORBIDDEN');

  // 2026-10-25 起 platform.sched 含總部／品牌辦公室同仁：區督導（ladder office）也有；沒有 platform.sched 的（只有 platform.att 的帳號）仍 403
  const osv = mkStaff(sb, boss, '排班督導', { brand: 'mala', unit: 'mala-hq', title: 'osv' });
  // 還要有 hq 打卡對照（confirmed、roster_active 不是 FALSE）才有 platform.sched（2026-10-25 縮小範圍）
  ok(sb.proxyAuthorize_(osv.token, 'schedule', 'schedAlerts').code === 'FORBIDDEN', '16q0: 區督導沒有 hq 打卡對照 → 沒有 platform.sched → 403');
  sb.clkSetup_(sb.SpreadsheetApp.getActive());
  sheets.staff_clock.appendRow([osv.emp, 'hq', 'HQ' + osv.emp.slice(3), 'staff', 'confirmed', 'created', 'TRUE', '', 'tester', '', '']);
  ok(sb.proxyAuthorize_(osv.token, 'schedule', 'schedAlerts').code !== 'FORBIDDEN', '16q: 區督導（品牌辦公室，2026-10-25 起有 platform.sched）→ schedule 不再 403');
  ok(sb.proxyAuthorize_(osv.token, 'attendance', 'attAlerts').code !== 'FORBIDDEN', '16r: 同一個人打 attendance 仍過（platform.att）');
  ok(sb.proxyAuthorize_(sm.token, 'attendance', 'attAlerts').code !== 'FORBIDDEN', '16s: 店長 attendance 也過');
  sheets.roles.appendRow(['attonly', '假', 'platform.att']);
  sheets.users.appendRow(['u794', 'attonly', '假', 'attonly', '', 's9', H('fake-attonly-pw-01', 's9'), 'TRUE', '', '', '']);
  ok(sb.proxyAuthorize_(tokenOf(sb, 'attonly', 'fake-attonly-pw-01'), 'schedule', 'schedAlerts').code === 'FORBIDDEN', '16t: roles 只給 platform.att 的帳號 → schedule 403（platform.att 不能頂替 platform.sched）');

  // PERMS_ON 開：同 14n～14p
  ok(sb.permInit_({ role: 'admin', id: 'u001' }).ok === true, '16l 前置：permInit_ 建表');
  turnOn(sb);
  const rOn = sb.proxyAuthorize_(sm.token, 'schedule', 'schedAlerts');
  ok(rOn.ok === true && rOn.secret === SCH && rOn.subject === sm.emp, '16l: PERMS_ON 開 → 店長仍 ok、subject＝DZY 編號', rOn);
  ok(sb.proxyAuthorize_(pt.token, 'schedule', 'schedAlerts').code === 'FORBIDDEN', '16m: PERMS_ON 開 → 計時同仁仍 FORBIDDEN');
  ok(sb.proxyAuthorize_(boss, 'schedule', 'schedAlerts').subject === 'U:u001', '16n: PERMS_ON 開 → admin 仍 subject＝U:<id>');

  const n = fresh();
  ok(n.sb.proxyAuthorize_(tokenOf(n.sb, 'BOSS', PW.boss), 'schedule', 'schedAlerts').code === 'UNKNOWN_NS', '16o: module_secrets 沒有 schedule → UNKNOWN_NS');
  const w = fresh({ module_secrets: seed().module_secrets.concat([['schedule', 'write', 'FAKE-ONLY-WRITE'], ['attendance', 'read', 'FAKE-ATT-OTHER']]) });
  ok(w.sb.proxyAuthorize_(tokenOf(w.sb, 'BOSS', PW.boss), 'schedule', 'schedAlerts').code === 'NO_SECRET', '16p: 只有 schedule/write、沒有 read → NO_SECRET（不拿寫入碼、也不拿 attendance/read 頂替）');
}

// ============================================================
// 17. pickSecrets_ 明文排除 attendance／schedule／payroll（2026-10-24 Fable 驗證 B：日後補 write 列也不准漏）
// ============================================================
{
  const mk = (n) => 'FAKE-PICK-' + n;
  const extra = { module_secrets: seed().module_secrets.concat([
    ['attendance', 'read', mk('ATT-R')], ['attendance', 'write', mk('ATT-W')],
    ['schedule', 'read', mk('SCH-R')], ['schedule', 'write', mk('SCH-W')],
    ['payroll', 'read', mk('PAY-R')], ['payroll', 'write', mk('PAY-W')]
  ]) };
  const { sb } = fresh(extra);
  const picked = sb.pickSecrets_(['*']);
  ok(!('attendance' in picked) && !('schedule' in picked) && !('payroll' in picked), '17a: pickSecrets_([*]) 不含 attendance／schedule／payroll（連 write 列都有也不下發）', Object.keys(picked));
  ok(Object.keys(picked).length > 0 && JSON.stringify(picked).indexOf('FAKE-PICK-') === -1, '17b: 其他後端（audit／dorm）照舊會有，且不含這三個的金鑰值', Object.keys(picked));
  sb.PropertiesService.getScriptProperties().setProperty('LEGACY_SECRETS', '1');
  const lg = post(sb, 'login', { username: 'BOSS', password: PW.boss });
  const me = post(sb, 'me', {}, lg.data.token);
  const noThree = (r) => { const t = JSON.stringify(r); const sec = (r.data && r.data.secrets) || {}; return t.indexOf('FAKE-PICK-') === -1 && !('attendance' in sec) && !('schedule' in sec) && !('payroll' in sec); };
  ok(lg.ok && me.ok && noThree(lg) && noThree(me), '17c: LEGACY_SECRETS=1 的 admin login／me 不含 attendance、schedule、payroll 金鑰', lg.data && lg.data.secrets);
  ok(lg.data.secrets !== undefined, '17d: 對照：LEGACY_SECRETS=1 的 admin 仍照舊有 secrets 物件（其他後端）');
  sb.PropertiesService.getScriptProperties().setProperty('LEGACY_SECRETS', '');
}

if (failed > 0) {
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  process.exit(1);
} else {
  console.log('\n全部測試通過，共 ' + passed + ' 項');
}
