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
import { READ_ACTIONS } from '../platform/dryrun.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

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

if (failed > 0) {
  console.error('\n' + failed + ' 項測試失敗（共 ' + (passed + failed) + ' 項）');
  process.exit(1);
} else {
  console.log('\n全部測試通過，共 ' + passed + ' 項');
}
