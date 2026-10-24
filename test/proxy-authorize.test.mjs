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
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Perms.gs', 'PermActions.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

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
// 14. 損益系統（2026-10-24）：pnl.read／pnl.write／pnl.admin、等級由平台算、金鑰只在代轉時給
// ============================================================
{
  const PNLK = 'FAKE-PNL-DZY-KEY-77';
  const extra = { module_secrets: seed().module_secrets.concat([['pnl', 'read', PNLK], ['pnl', 'write', PNLK]]) };
  const { sb, sheets } = fresh(extra);
  const boss = tokenOf(sb, 'BOSS', PW.boss);
  const hasK = (o) => JSON.stringify(o).indexOf(PNLK) !== -1;

  ok(JSON.stringify(sb.PROXY_READ_ACTIONS.pnl) === JSON.stringify(READ_ACTIONS.pnl), '14a: pnl 讀清單兩邊（Auth.gs／dryrun.js）一致');
  ok(JSON.stringify(sb.PROXY_WRITE_ACTIONS.pnl) === JSON.stringify(WRITE_ACTIONS.pnl), '14b: pnl 寫入清單兩邊一致');
  ok(['pnl.read', 'pnl.write', 'pnl.admin'].every((c) => sb.PERM_GRANTABLE.indexOf(c) !== -1), '14c: 三碼都可給');
  ok(sb.PERM_LOCKED.indexOf('pnl.admin') !== -1 && sb.PERM_LOCKED.indexOf('pnl.write') === -1 && sb.PERM_LOCKED.indexOf('pnl.read') === -1, '14d: 只有 pnl.admin 是鎖碼（Q1 改判：財務部門自動有＝不鎖）');

  const a = sb.proxyAuthorize_(boss, 'pnl', 'getSettings');
  ok(a.ok && a.secret === PNLK && a.isWrite === false && a.level === 'admin' && a.account === 'BOSS' && a.operator === '系統管理者（BOSS）（管理系統）', '14e: admin（*）讀 → level admin、帶帳號與操作人', a);
  ok(sb.proxyAuthorize_(boss, 'pnl', 'finalize').isWrite === true, '14f: finalize 是寫入');
  for (const bad of ['login', 'createInvite', 'logout', 'changeMyPasscode', 'revokeSessions', 'dzyProxy', 'listInvites']) {
    ok(sb.proxyAuthorize_(boss, 'pnl', bad).code === 'FORBIDDEN', '14g: 不代轉的 ' + bad + ' → FORBIDDEN');
  }
  ok(!('pnl' in sb.pickSecrets_(['*'])), '14h: pickSecrets_ 永不含 pnl');
  ok(sb.proxyAuthorize_(boss, 'audit', 'getAll').level === undefined, '14i: 其他系統不帶 level');
  ok(sb.proxyPnlLevel_(['pnl.read']) === 'read' && sb.proxyPnlLevel_(['pnl.read', 'pnl.write']) === 'write' && sb.proxyPnlLevel_(['pnl.read', 'pnl.admin']) === 'admin' && sb.proxyPnlLevel_([]) === '', '14j: 等級＝最高者');

  for (const [u, pw] of [['acc1', PW.acc], ['lead1', PW.lead], ['mgr1', PW.mgr], ['viewer1', PW.viewer]]) {
    const r = sb.proxyAuthorize_(tokenOf(sb, u, pw), 'pnl', 'getMonth');
    ok(r.ok === false && r.code === 'FORBIDDEN' && !hasK(r), '14k: 沒有損益權限的 ' + u + ' → FORBIDDEN、不含金鑰', r);
  }

  // 同仁（PERMS_ON）：財務部門走 perm_map（Eason 在權限設定開），其他人走個別例外
  const fin = mkStaff(sb, boss, '財務同仁甲', { brand: 'dzy', unit: 'dzy-hq', dept: 'fin', title: 'hs' });
  const ops = mkStaff(sb, boss, '營運同仁乙', { brand: 'dzy', unit: 'dzy-hq', dept: 'ops', title: 'hs' });
  ok(sb.permInit_({ role: 'admin', id: 'u001' }).ok === true, '14 前置：permInit_');
  turnOn(sb);
  ok(sb.proxyAuthorize_(fin.token, 'pnl', 'getMonth').code === 'FORBIDDEN', '14l: 對照表還沒開之前財務同仁也進不去');
  sheets.perm_map.appendRow(['R901', 'hq', 'fin', '*', 'pnl.write', 'TRUE', '', 'u001']);
  const f = sb.proxyAuthorize_(fin.token, 'pnl', 'addEntry');
  ok(f.ok && f.isWrite === true && f.level === 'write' && /財務同仁甲（DZY\d+）（管理系統）/.test(f.operator), '14m: 財務部門開了 pnl.write → 可寫、level write、操作人是本人', f);
  ok(sb.proxyAuthorize_(ops.token, 'pnl', 'getMonth').code === 'FORBIDDEN', '14n: 別部門仍 FORBIDDEN');
  sheets.perm_ex.appendRow(['X911', ops.emp, 'pnl.read', 'add', '', 'Eason 開', 'TRUE', '', 'u001', '', '']);
  const o = sb.proxyAuthorize_(ops.token, 'pnl', 'getMonth');
  ok(o.ok && o.level === 'read' && o.secret === PNLK, '14o: 個別例外給 pnl.read → 可讀、level read', o);
  ok(sb.proxyAuthorize_(ops.token, 'pnl', 'addEntry').code === 'FORBIDDEN', '14p: 只有看的人寫入 → FORBIDDEN');
  for (const adm of ['finalize', 'unlock', 'saveSettings', 'createDraft', 'refreshConnectors', 'refreshFixed', 'loadGroupUnits']) {
    ok(sb.proxyAuthorize_(fin.token, 'pnl', adm).code === 'FORBIDDEN', '14p2: 只有 pnl.write 打「管」級 ' + adm + ' → 平台就擋');
  }
  ok(/^DZY\d+$/.test(f.account), '14m2: 同仁的 account＝同仁編號', f.account);
  sheets.perm_ex.appendRow(['X912', fin.emp, 'pnl.admin', 'add', '', 'Eason 開', 'TRUE', '', 'u001', '', '']);
  const fa = sb.proxyAuthorize_(fin.token, 'pnl', 'saveSettings');
  ok(fa.ok && fa.level === 'admin' && fa.isWrite === true, '14q: 再給 pnl.admin → level admin', fa);
}

if (failed > 0) {
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  process.exit(1);
} else {
  console.log('\n全部測試通過，共 ' + passed + ' 項');
}
