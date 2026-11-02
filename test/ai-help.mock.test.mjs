// node test/ai-help.mock.test.mjs —— AI 小幫手 Phase 1（平台後端 .gs）驗收：docs/ai-helper/{spec,plan,task}.md（§12 優先）
// 做法同 staff.mock.test.mjs：把 .gs 讀進同一個 vm sandbox，管理 action 全程走 doPost（跟正式環境同一條路）；
// node 專用全域函式（結尾底線 8 支）直接呼叫 sandbox 的全域函式。
// ⚠ 姓名、生日、手機、地址都是假資料（dzy 是 public repo，不得出現真實同仁資料）。

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { READ_ACTIONS } from '../platform/dryrun.js';
import { buildPages, renderSource, OUT_FILE } from '../tools/gen-aihelp-pages.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'Perms.gs', 'PermActions.gs', 'AiHelpPages.gs', 'AiHelpSeed.gs', 'AiHelp.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);
const CODE_GS = fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8');

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── GAS 假物件 ──────────────────────────────────────────────
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
    deleteRows(start, n) { data.splice(start - 1, n); },
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

function load(seed, extraSrc) {
  const sheets = {};
  Object.keys(seed).forEach((k) => { sheets[k] = makeSheet(seed[k]); });
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; }
  };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-for-ai-help-tests' };
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
      put: (k, v, ttl) => cache.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null }),
      remove: (k) => cache.delete(k)
    }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  sandbox.__nowMs = null;   // 測試要固定時間時設；aihNow_ 覆寫在下面
  vm.runInContext('var __realAihNow = aihNow_; aihNow_ = function () { return (typeof __nowMs === "number" && __nowMs) ? __nowMs : __realAihNow(); };', sandbox);
  return { sb: sandbox, sheets, cache, props };
}

function post(sb, action, payload, token) {
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }).getContent());
}

const ADMIN_PW = 'fake-admin-pw-01';
function freshSeed(sbForHash) {
  const salt = 'salt-admin';
  return {
    users: [
      ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at'],
      ['u001', 'BOSS', '系統管理者', 'admin', '', salt, sbForHash.hashPassword_(ADMIN_PW, salt), 'TRUE', '', ''],
      ['u002', 'acc1', '假會計', 'accountant', '', salt, sbForHash.hashPassword_('fake-acc-pw-01', salt), 'TRUE', '', '']
    ],
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['accountant', '會計', 'audit.read,audit.write'], ['staff', '員工', '']],
    module_secrets: [['backend_id', 'level', 'secret']],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  };
}
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;

function fresh() {
  const app = load(freshSeed(HASHER));
  app.sb.setupStaff();
  return app;
}
function adminToken(sb) {
  const r = post(sb, 'login', { username: 'BOSS', password: ADMIN_PW });
  if (!r.ok) throw new Error('admin login 失敗 ' + r.error);
  return r.data.token;
}
const FAKE_NAMES = ['測試甲', '測試乙', '測試丙', '測試丁'];
const PROFILE = { brand: 'mzt', unit: 'mzt-gf', dept: '', title: 'pt', birthday: '1995-05-05', phone: '0911222333', address: '新竹市測試路一段1號' };
// 2026-10-12：認領後要審核通過才開通——這裡用後台確認（staffConfirm）開通後再登入，
// 回傳形狀維持 { emp, claim:{data:{token}} } 讓既有測試不必改
function claimAndApprove(sb, tok, who, pw, profile) {
  const lk = post(sb, 'claimLookup', { name: who });
  const sub = post(sb, 'claimSubmit', Object.assign({ name: who, emp_no: lk.data.emp_no, password: pw || 'fake-staff-pw-1' }, profile || PROFILE));
  if (!sub.ok) throw new Error('claimSubmit 失敗 ' + sub.error);
  const cf = post(sb, 'staffConfirm', { emp_no: lk.data.emp_no }, tok);
  if (!cf.ok) throw new Error('staffConfirm 失敗 ' + cf.error);
  const lg = post(sb, 'login', { username: lk.data.emp_no, password: pw || 'fake-staff-pw-1' });
  if (!lg.ok) throw new Error('開通後登入失敗 ' + lg.error);
  return { emp: lk.data.emp_no, claim: lg };
}
function seedAndClaim(sb, tok, who) {
  post(sb, 'staffImport', { names: FAKE_NAMES }, tok);
  return claimAndApprove(sb, tok, who || '測試甲');
}
const staffRow = (sheets, emp) => sheets.staff._rows().find((r) => r[0] === emp);
const COL = (h) => HASHER.STF_HEADERS.indexOf(h);

// ── 本檔專用的場景 ────────────────────────────────────────────
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 2, 6, 0, 0);          // 2026-11-02 14:00 台北
const iso = (ms) => new Date(ms).toISOString();
const SH = ['aih_kb', 'aih_kb_hist', 'aih_log', 'aih_pending'];

/** 一套完整環境：admin、會計（無 aihelp）、有 platform.aihelp 的非 admin 角色帳號、已開通同仁（測試甲）、第二位同仁（測試乙）、小幫手四張表已建 */
function scene() {
  const seed = freshSeed(HASHER);
  seed.roles.push(['helper', '小幫手管理員', 'platform.aihelp']);
  const salt = 'salt-admin';
  seed.users.push(['u003', 'helper1', '假管理員', 'helper', '', salt, HASHER.hashPassword_('fake-helper-pw-1', salt), 'TRUE', '', '']);
  const app = load(seed);
  const { sb } = app;
  sb.setupStaff();
  app.admin = adminToken(sb);
  const mk = (name) => {
    post(sb, 'staffImport', { names: [name] }, app.admin);
    return claimAndApprove(sb, app.admin, name);
  };
  app.a = mk('測試甲');
  app.b = mk('測試乙');
  app.accTok = post(sb, 'login', { username: 'acc1', password: 'fake-acc-pw-01' }).data.token;
  app.helperTok = post(sb, 'login', { username: 'helper1', password: 'fake-helper-pw-1' }).data.token;
  app.aTok = app.a.claim.data.token;
  app.aUid = app.a.claim.data.user.id;
  app.bTok = app.b.claim.data.token;
  app.bUid = app.b.claim.data.user.id;
  const setup = post(sb, 'aihSetup', {}, app.admin);
  if (!setup.ok) throw new Error('aihSetup 失敗 ' + JSON.stringify(setup));
  return app;
}
const kbSave = (sb, tok, p) => post(sb, 'aihKbSave', p, tok);
const kbRows = (app) => app.sheets.aih_kb._rows().slice(1);
const histRows = (app) => app.sheets.aih_kb_hist._rows().slice(1);
const LOGID = (n) => 'aih_20261102143' + String(100 + n).slice(-3) + '_9f3a';   // aih_ + 14 碼 + _ + 4 碼
const PENID = (n) => 'aip_20261102143' + String(100 + n).slice(-3) + '_1c0e';
const logRow = (o) => Object.assign({ ts: iso(NOW), uid: 'u900', conv: '', m: '', v: '', q: '怎麼改密碼', kind: 'answered', answer: '到我的資料改', kb_ids: ['kb0001'], tok_in: 100, tok_out: 50, usd: 0.000035 }, o);

// ============================================================
// T1-1 建表：只補不覆蓋、兩次不重複、表頭不符停、只限 admin
// ============================================================
(() => {
  const app = load(freshSeed(HASHER));
  const { sb, sheets } = app;
  sb.setupStaff();
  const adm = adminToken(sb);
  const r1 = post(sb, 'aihSetup', {}, adm);
  ok(r1.ok && eq(r1.data.created, SH) && eq(r1.data.existed, []), '1-1 aihSetup 第一次建四張表', r1);
  ok(SH.every((n) => sheets[n] && sheets[n]._rows().length === 1), '1-1 每張只有表頭一列');
  ok(sheets.aih_kb._rows()[0].join() === 'id,m,v,question,answer,who,go_m,go_v,status,source,verified_at,expires_at,updated_at,updated_by', '1-1 aih_kb 表頭逐字（含 §12.5 的 source、verified_at、expires_at）');
  ok(sheets.aih_kb_hist._rows()[0].join() === 'hist_id,kb_id,action,snapshot,by,at', '1-1 aih_kb_hist 表頭逐字');
  ok(sheets.aih_log._rows()[0].join() === 'id,ts,uid,conv,m,v,q,kind,answer,kb_ids,tok_in,tok_out,usd,feedback', '1-1 aih_log 表頭逐字（spec §7 加 §12.2 的 conv）');
  ok(sheets.aih_pending._rows()[0].join() === 'id,log_id,ts,q,m,v,reason,status,kb_id', '1-1 aih_pending 表頭逐字');
  const saved = kbSave(sb, adm, { question: '怎麼登入', answer: '用帳號密碼' });
  const r2 = post(sb, 'aihSetup', {}, adm);
  ok(r2.ok && eq(r2.data.created, []) && eq(r2.data.existed, SH), '1-1 aihSetup 第二次不重複建', r2);
  ok(SH.every((n) => sheets[n]._rows()[0].length > 3) && sheets.aih_kb._rows().length === 2 && sheets.aih_kb._rows()[1][0] === saved.data.id, '1-1 重跑不動既有資料列');
  ok(Object.keys(sheets).filter((n) => n.indexOf('aih_') === 0).length === 4, '1-1 試算表只多這四張 aih_ 分頁');
})();
  // 表頭多一欄：整列比對，也停
(() => {
  const seed = freshSeed(HASHER);
  seed.aih_pending = [['id', 'log_id', 'ts', 'q', 'm', 'v', 'reason', 'status', 'kb_id', 'EXTRA']];
  const app = load(seed);
  app.sb.setupStaff();
  const r = post(app.sb, 'aihSetup', {}, adminToken(app.sb));
  ok(r.ok === false && r.error === 'bad_request' && !app.sheets.aih_kb, '1-1 既有分頁表頭多一欄（第 10 欄）→ 停，一張都不建', r);
  const seed2 = freshSeed(HASHER);
  seed2.aih_kb = [['id', 'm']];
  const a2 = load(seed2);
  a2.sb.setupStaff();
  ok(post(a2.sb, 'aihSetup', {}, adminToken(a2.sb)).error === 'bad_request', '1-1 既有分頁表頭少欄 → 停');
})();
(() => {
  // 表頭不符：整個停、一張都不建
  const seed = freshSeed(HASHER);
  seed.aih_log = [['id', 'ts', 'WRONG']];
  const app = load(seed);
  app.sb.setupStaff();
  const adm = adminToken(app.sb);
  const r = post(app.sb, 'aihSetup', {}, adm);
  ok(r.ok === false && r.error === 'bad_request' && !app.sheets.aih_kb && !app.sheets.aih_pending, '1-1 既有分頁表頭不符 → 停，其他三張也沒建', r);
  ok(app.sheets.aih_log._rows()[0].join() === 'id,ts,WRONG', '1-1 表頭不符時原表頭不被覆寫');
})();
(() => {
  const app = scene();
  const { sb } = app;
  ok(post(sb, 'aihSetup', {}, app.accTok).error === 'forbidden', '1-1 會計跑 aihSetup → forbidden');
  ok(post(sb, 'aihSetup', {}, app.helperTok).error === 'forbidden', '1-1 有 platform.aihelp 但不是 role admin 跑 aihSetup → forbidden（只限 admin）');
  ok(post(sb, 'aihSetup', {}, 'bad-token').error === 'unauthorized', '1-1 壞 token → unauthorized');
})();

// ============================================================
// 權限：非 platform.aihelp 一律 forbidden；碼的登記
// ============================================================
(() => {
  const app = scene();
  const { sb } = app;
  const calls = [['aihKbList', {}], ['aihKbSave', { question: 'q', answer: 'a' }], ['aihKbImport', {}], ['aihKbHist', {}], ['aihPendingList', {}], ['aihPendingSet', { id: 'x', status: 'ignored' }], ['aihUsage', {}], ['aihPauseSet', { paused: true }]];
  for (const [who, tok] of [['同仁', app.aTok], ['會計', app.accTok]]) {
    ok(calls.every(([a, p]) => { const r = post(sb, a, p, tok); return r.ok === false && r.error === 'forbidden'; }), '權限 ' + who + ' 呼叫 8 支管理 action 全部 forbidden', calls.map(([a, p]) => post(sb, a, p, tok).error));
  }
  ok(calls.every(([a, p]) => post(sb, a, p, '').ok === false), '權限 沒 token 全部拒絕');
  ok(post(sb, 'aihKbList', {}, app.admin).ok && post(sb, 'aihKbList', {}, app.helperTok).ok, '權限 admin（*）與持 platform.aihelp 的角色可用');
  ok(sb.PERM_GRANTABLE.indexOf('platform.aihelp') === sb.PERM_GRANTABLE.length - 1 && sb.PERM_LOCKED.indexOf('platform.aihelp') !== -1, '權限 platform.aihelp 進 PERM_GRANTABLE（最後一碼）與 PERM_LOCKED');
  ok(sb.permName_('platform.aihelp') === 'AI 小幫手管理', '權限 中文名「AI 小幫手管理」');
  ok(sb.usrRoleIsSuper_ && sb.usrRoleIsSuper_('helper') === true, '權限 含鎖碼的角色屬高權限（只有 admin 能指派）');
  const names = ['aihSetup', 'aihKbList', 'aihKbSave', 'aihKbImport', 'aihKbHist', 'aihPendingList', 'aihPendingSet', 'aihUsage', 'aihPauseSet'];
  ok(names.every((n) => CODE_GS.indexOf("'" + n + "'") !== -1 && CODE_GS.indexOf("case '" + n + "':") !== -1), '權限 9 支管理 action 都在 Code.gs 白名單與分派');
  const rd = ['aihKbList', 'aihKbHist', 'aihPendingList', 'aihUsage'];
  ok(rd.every((n) => READ_ACTIONS.platform.indexOf(n) !== -1) && ['aihSetup', 'aihKbSave', 'aihKbImport', 'aihPendingSet', 'aihPauseSet'].every((n) => READ_ACTIONS.platform.indexOf(n) === -1), '權限 dryrun.js READ_ACTIONS：4 支讀取在、5 支寫入不在（試跑會攔）');
})();

// ============================================================
// T1-1 知識庫讀寫、conflict、hist
// ============================================================
(() => {
  const app = scene();
  const { sb } = app;
  const adm = app.admin;
  const r1 = kbSave(sb, adm, { question: '怎麼改密碼', answer: '到「我的資料」按改密碼', who: '資訊部', m: 'me', v: 'profile', go_m: 'me', go_v: 'profile', source: 'docs/x.md' });
  ok(r1.ok && r1.data.id === 'kb0001' && r1.data.changed === true, '1-1 新題自動編號 kb0001', r1);
  const r2 = kbSave(sb, adm, { question: '怎麼登入', answer: '帳號密碼' });
  ok(r2.data.id === 'kb0002', '1-1 第二題 kb0002');
  const row = kbRows(app)[0];
  const today = '2026-11-02';
  ok(row[8] === 'draft' && /^\d{4}-\d\d-\d\d$/.test(row[10]) && row[11] === sb.aihAddDays_(row[10], 180) && row[13] === 'BOSS', '1-1 新題 status 預設 draft、expires_at＝verified_at＋180 天、updated_by 記帳號', row);
  ok(histRows(app).length === 2 && histRows(app)[0][2] === 'create' && histRows(app)[0][1] === 'kb0001' && JSON.parse(histRows(app)[0][3]).question === '怎麼改密碼' && histRows(app)[0][4] === 'BOSS', '1-1 hist：每題新增各留一列（整列快照＋誰）');

  // 改題：expected_updated_at
  const ts1 = r1.data.updated_at;
  const bad = kbSave(sb, adm, { id: 'kb0001', answer: '新答案', expected_updated_at: '1999-01-01T00:00:00.000Z' });
  ok(bad.ok === false && bad.error === 'conflict', '1-1 改題 expected_updated_at 不符 → conflict', bad);
  ok(kbRows(app)[0][4] === '到「我的資料」按改密碼' && histRows(app).length === 2, '1-1 conflict 不寫資料、不留 hist');
  const good = kbSave(sb, adm, { id: 'kb0001', answer: '新答案', expected_updated_at: ts1 });
  ok(good.ok && good.data.changed && good.data.updated_at !== ts1 && kbRows(app)[0][4] === '新答案' && kbRows(app)[0][3] === '怎麼改密碼', '1-1 expected_updated_at 相符 → 改成功、沒給的欄位維持原值、updated_at 換新', good);
  const stale = kbSave(sb, adm, { id: 'kb0001', answer: '第二位的版本', expected_updated_at: ts1 });
  ok(stale.error === 'conflict' && kbRows(app)[0][4] === '新答案', '1-1 並發：第二筆用舊 updated_at → conflict、不覆蓋');
  ok(histRows(app).length === 3 && histRows(app)[2][2] === 'update', '1-1 hist：改答案留 update 一列（共 3 列）');
  // 上架、下架、不變
  const t2 = good.data.updated_at;
  const pub = kbSave(sb, adm, { id: 'kb0001', status: 'live', expected_updated_at: t2 });
  ok(pub.ok && kbRows(app)[0][8] === 'live' && histRows(app)[3][2] === 'publish', '1-1 上架 → hist publish');
  const off = kbSave(sb, adm, { id: 'kb0001', status: 'off', expected_updated_at: pub.data.updated_at });
  ok(off.ok && histRows(app)[4][2] === 'unpublish' && JSON.parse(histRows(app)[4][3]).status === 'off', '1-1 下架 → hist unpublish（快照是下架後的樣子）');
  const same = kbSave(sb, adm, { id: 'kb0001', status: 'off', expected_updated_at: off.data.updated_at });
  ok(same.ok && same.data.changed === false && histRows(app).length === 5, '1-1 完全沒變 → changed:false、不寫 hist');
  const hh = post(sb, 'aihKbHist', { kb_id: 'kb0001' }, adm);
  ok(hh.ok && hh.data.items.length === 4 && hh.data.items[0].action === 'unpublish' && hh.data.items[3].action === 'create' && hh.data.items[3].snapshot.question === '怎麼改密碼', '1-1 aihKbHist 回該題全部版本（新的在前、快照可還原）', hh.data.items.map((x) => x.action));
  // 驗證
  ok(kbSave(sb, adm, { question: '', answer: 'x' }).error === 'bad_request', '1-1 問題空白 → bad_request');
  ok(kbSave(sb, adm, { question: 'q', answer: 'a', m: 'nope' }).error === 'bad_request', '1-1 頁面不在地圖 → bad_request');
  ok(kbSave(sb, adm, { question: 'q', answer: 'a', m: 'me', v: 'zzz' }).error === 'bad_request', '1-1 模組在、分頁不在 → bad_request');
  ok(kbSave(sb, adm, { question: 'q', answer: 'a', go_m: 'me' }).error === 'bad_request', '1-1 帶我去只填一半 → bad_request');
  ok(kbSave(sb, adm, { question: 'q', answer: 'a', status: 'zzz' }).error === 'bad_request', '1-1 狀態不正確 → bad_request');
  ok(kbSave(sb, adm, { question: 'q', answer: 'a', verified_at: '2026-02-30' }).error === 'bad_request', '1-1 不存在的日期 → bad_request');
  ok(kbSave(sb, adm, { id: 'kb0099', answer: 'a' }).error === 'not_found', '1-1 改不存在的題 → not_found');
  ok(kbSave(sb, adm, { question: 5, answer: 'a' }).error === 'bad_request', '1-1 欄位型別錯 → bad_request');
  const ex = kbSave(sb, adm, { question: '另一題', answer: 'a', verified_at: '2026-03-01' });
  ok(kbRows(app)[2][11] === '2026-08-28', '1-1 verified_at 2026-03-01 → expires_at 預設 +180 天＝2026-08-28', kbRows(app)[2]);
  const re = kbSave(sb, adm, { id: ex.data.id, verified_at: '2026-11-01', expected_updated_at: ex.data.updated_at });
  ok(re.ok && kbRows(app)[2][11] === '2027-04-30', '1-1 重新確認（verified_at 變）→ 到期日順延 180 天');
  // list 篩選
  ok(post(sb, 'aihKbList', { status: 'off' }, adm).data.items.length === 1 && post(sb, 'aihKbList', { q: '登入' }, adm).data.items.length === 1 && post(sb, 'aihKbList', {}, adm).data.items.length === 3, '1-1 aihKbList 依 status、q 篩選');
  ok(post(sb, 'aihKbList', { status: 'zzz' }, adm).error === 'bad_request', '1-1 aihKbList 狀態不正確 → bad_request');
  // 沒初始化
  const raw = load(freshSeed(HASHER));
  raw.sb.setupStaff();
  ok(post(raw.sb, 'aihKbList', {}, adminToken(raw.sb)).error === 'not_inited', '1-1 沒按初始化 → not_inited');
})();

// ============================================================
// aihKbImport：匯入初始題庫（AiHelpSeed.gs 的 AIH_SEED）
// ============================================================
(() => {
  const app = scene();
  const { sb } = app;
  const adm = app.admin;
  const SEED = JSON.parse(JSON.stringify(sb.AIH_SEED));
  ok(Array.isArray(SEED) && SEED.length >= 50, 'IMP AIH_SEED 在 sandbox 載入、題數 ≥ 50', SEED.length);
  // 權限
  ok(post(sb, 'aihKbImport', {}, app.aTok).error === 'forbidden' && post(sb, 'aihKbImport', {}, app.accTok).error === 'forbidden', 'IMP 一般同仁、會計 → forbidden');
  ok(post(sb, 'aihKbImport', {}, '').ok === false, 'IMP 沒 token → 拒絕');
  ok(kbRows(app).length === 0 && histRows(app).length === 0, 'IMP 被拒絕時沒有寫任何資料');
  // 沒初始化
  const raw = load(freshSeed(HASHER));
  raw.sb.setupStaff();
  ok(post(raw.sb, 'aihKbImport', {}, adminToken(raw.sb)).error === 'not_inited', 'IMP 沒按初始化 → not_inited');
  // admin 匯入
  const r = post(sb, 'aihKbImport', {}, adm);
  ok(r.ok && r.data.added === SEED.length && r.data.skipped === 0, 'IMP admin 匯入：added＝全部題數、skipped＝0', r);
  const rows = kbRows(app);
  ok(rows.length === SEED.length && rows.every((x, i) => x[0] === 'kb' + ('0000' + (i + 1)).slice(-4)), 'IMP 自動編號 kb0001…連號');
  ok(rows.every((x) => x[8] === 'draft'), 'IMP 全部是 draft（業主逐題勾選才上架）');
  ok(rows.every((x, i) => x[1] === SEED[i].m && x[2] === SEED[i].v && x[3] === SEED[i].question && x[4] === SEED[i].answer && x[5] === SEED[i].who && x[6] === SEED[i].go_m && x[7] === SEED[i].go_v && x[9] === SEED[i].source), 'IMP 欄位逐題與 AIH_SEED 相同（順序 id,m,v,question,answer,who,go_m,go_v,status,source）');
  ok(rows.every((x) => /^\d{4}-\d\d-\d\d$/.test(x[10]) && x[11] === sb.aihAddDays_(x[10], 180) && x[13] === 'BOSS' && x[12]), 'IMP verified_at 今天、expires_at＋180 天、updated_by＝呼叫者');
  const h = histRows(app);
  ok(h.length === SEED.length && h.every((x, i) => x[1] === rows[i][0] && x[2] === 'create' && x[4] === 'BOSS' && JSON.parse(x[3]).question === SEED[i].question && JSON.parse(x[3]).status === 'draft'), 'IMP aih_kb_hist 每題一列 create（快照＋by＝呼叫者）');
  ok(new Set(h.map((x) => x[0])).size === h.length && h[0][0] === 'kh0001', 'IMP hist 編號不重複');
  // 冪等
  const r2 = post(sb, 'aihKbImport', {}, adm);
  ok(r2.ok && r2.data.added === 0 && r2.data.skipped === SEED.length && kbRows(app).length === SEED.length && histRows(app).length === SEED.length, '重複匯入 added＝0、skipped＝全部、不多寫資料也不多留 hist', r2);
  // 持 platform.aihelp 的非 admin 也能匯入（等同 aihKbSave 權限）
  const app2 = scene();
  const r3 = post(app2.sb, 'aihKbImport', {}, app2.helperTok);
  ok(r3.ok && r3.data.added === SEED.length && kbRows(app2)[0][13] === 'helper1', 'IMP 持 platform.aihelp 的角色可匯入，by 記他的帳號');
  // 已存在（任何狀態、含去前後空白）的題目略過；題庫內重複只加一次
  const app3 = scene();
  const s3 = app3.sb;
  s3.AIH_SEED = [
    { m: '', v: '', question: '甲題', answer: 'a1', who: '人資', go_m: '', go_v: '', source: 's' },
    { m: 'me', v: 'profile', question: '  乙題  ', answer: 'a2', who: '人資', go_m: 'me', go_v: 'profile', source: 's' },
    { m: '', v: '', question: '甲題', answer: '重複的', who: '人資', go_m: '', go_v: '', source: 's' },
    { m: '', v: '', question: '丙題', answer: 'a3', who: '人資', go_m: '', go_v: '', source: 's' }
  ];
  const pre = kbSave(s3, app3.admin, { question: '丙題', answer: '已存在的版本', status: 'live' });
  ok(pre.ok, 'IMP 預先建一題 live 的「丙題」');
  const r4 = post(s3, 'aihKbImport', {}, app3.admin);
  ok(r4.ok && r4.data.added === 2 && r4.data.skipped === 2, 'IMP 已存在的「丙題」與題庫內重複的「甲題」略過 → added 2、skipped 2', r4);
  const k3 = kbRows(app3);
  ok(k3.length === 3 && k3[0][3] === '丙題' && k3[0][4] === '已存在的版本' && k3[0][8] === 'live', 'IMP 已存在的題目不被覆蓋（答案、狀態維持）');
  ok(k3[1][3] === '甲題' && k3[1][4] === 'a1' && k3[2][3] === '乙題' && k3[2][0] === 'kb0003', 'IMP 新題接在後面編號、question 去前後空白');
  s3.AIH_SEED = [{ m: '', v: '', question: '  甲題 ', answer: 'x', who: 'y', go_m: '', go_v: '', source: 's' }];
  ok(post(s3, 'aihKbImport', {}, app3.admin).data.added === 0, 'IMP 前後空白不同的相同題目視為已存在');
  // 壞題目 → 整批不寫
  const app4 = scene();
  const s4 = app4.sb;
  const good = { m: '', v: '', question: '好題', answer: 'a', who: 'w', go_m: '', go_v: '', source: 's' };
  const bads = [
    ['頁面不在地圖', { m: 'nope', v: '', question: 'b', answer: 'a', who: 'w', go_m: '', go_v: '', source: 's' }],
    ['有分頁沒模組', { m: '', v: 'profile', question: 'b', answer: 'a', who: 'w', go_m: '', go_v: '', source: 's' }],
    ['帶我去只填一半', { m: '', v: '', question: 'b', answer: 'a', who: 'w', go_m: 'me', go_v: '', source: 's' }],
    ['答案空白', { m: '', v: '', question: 'b', answer: '', who: 'w', go_m: '', go_v: '', source: 's' }],
    ['答案太長', { m: '', v: '', question: 'b', answer: 'x'.repeat(1501), who: 'w', go_m: '', go_v: '', source: 's' }]
  ];
  for (const [label, bad] of bads) {
    s4.AIH_SEED = [good, bad];
    const rb = post(s4, 'aihKbImport', {}, app4.admin);
    ok(rb.ok === false && rb.error === 'bad_request' && kbRows(app4).length === 0 && histRows(app4).length === 0, 'IMP 壞題目（' + label + '）→ bad_request、一題都不寫', rb);
  }
  s4.AIH_SEED = [];
  ok(post(s4, 'aihKbImport', {}, app4.admin).data.added === 0, 'IMP 空題庫 → added 0');
})();

// ============================================================
// AIH_SEED 品質（規則 1～4 為硬性檢查；業主上架前還要人工逐題讀過）
// ============================================================
(() => {
  const { sb } = load(freshSeed(HASHER));
  const SEED = JSON.parse(JSON.stringify(sb.AIH_SEED));
  const PAGES = JSON.parse(JSON.stringify(sb.AIH_PAGES));
  const exists = (m, v) => PAGES.some((p) => p.m === m && p.v === v);
  const f = (o, k) => (typeof o[k] === 'string' ? o[k] : '');
  const KEYS = 'm,v,question,answer,who,go_m,go_v,source';
  ok(SEED.length >= 50 && SEED.length <= 90, 'SEED 題數 50～90（約 60 題）', SEED.length);
  ok(SEED.every((o) => Object.keys(o).join() === KEYS && KEYS.split(',').every((k) => typeof o[k] === 'string')), 'SEED 每題欄位固定為 ' + KEYS + '（不含 id、status、時間），都是字串');
  // 規則 1：m／v 組合
  const bad1 = SEED.filter((o) => (o.m || o.v) && !(o.m && o.v && exists(o.m, o.v)));
  ok(bad1.length === 0, 'SEED 規則1 m／v 組合存在於 AIH_PAGES（通用題兩者皆空）', bad1.map((o) => o.question));
  const bad1g = SEED.filter((o) => (o.go_m || o.go_v) && !(o.go_m && o.go_v && exists(o.go_m, o.go_v)));
  ok(bad1g.length === 0, 'SEED 規則1 go_m／go_v 若填也必須存在（兩者一起填）', bad1g.map((o) => o.question));
  ok(SEED.some((o) => !o.m && !o.v) && SEED.some((o) => o.m && o.v), 'SEED 同時有通用題與分頁題');
  // 規則 2
  ok(new Set(SEED.map((o) => o.question.trim())).size === SEED.length, 'SEED 規則2 question 不重複');
  ok(SEED.every((o) => o.question.trim() === o.question && o.question && o.question.length <= sb.AIH_MAX.question), 'SEED 規則2 question 非空、無前後空白、不超過上限');
  const long = SEED.filter((o) => !o.answer || o.answer.length > 300);
  ok(long.length === 0, 'SEED 規則2 answer 非空且 ≤ 300 字', long.map((o) => [o.question, o.answer.length]));
  ok(SEED.every((o) => o.source.trim() && o.source.length <= sb.AIH_MAX.source), 'SEED 規則2 source 非空、≤ 上限');
  ok(SEED.every((o) => o.who.trim() && o.who.length <= sb.AIH_MAX.who), 'SEED 規則2 who 非空、≤ 上限');
  // 規則 3：個資、金鑰、內部主機名
  const prose = (o) => [o.question, o.answer, o.who].join('\n');
  const all = (o) => [o.question, o.answer, o.who, o.source].join('\n');
  const noHost = (t) => t.replace(/dzy\.mozhuting\.com/g, '');
  const bad3 = SEED.filter((o) => /(?:\+?886[-\s]?)?0?9\d{2}[-\s]?\d{3}[-\s]?\d{3}/.test(all(o)) || /\b[A-Z][12]\d{8}\b/.test(all(o)) || /DZY\s?\d{2,}/i.test(all(o)) || /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(all(o)) || /[\w.+-]+@[\w-]+\.[\w.]+/.test(all(o)));
  ok(bad3.length === 0, 'SEED 規則3 沒有手機、身分證、員工編號（DZY＋數字）、IP、email', bad3.map((o) => o.question));
  const bad3k = SEED.filter((o) => /[A-Za-z0-9_\-+/=]{24,}/.test(noHost(all(o)).replace(/[~/.\w-]*\/(SKILL\.md|[\w.-]+\.(js|gs|html|md))/g, '')) || /(api[_-]?key|secret|password=|sk-[A-Za-z0-9]|AKfy)/i.test(all(o)));
  ok(bad3k.length === 0, 'SEED 規則3 沒有金鑰樣式的長字串', bad3k.map((o) => o.question));
  const hostRe = /(?:mini|tailscale|funnel|localhost|github\.io|script\.google|googleusercontent|\.ts\.net|mozhuting)/i;
  const bad3h = SEED.filter((o) => hostRe.test(noHost(prose(o))) || /https?:\/\/(?!dzy\.mozhuting\.com)/i.test(prose(o)));
  ok(bad3h.length === 0, 'SEED 規則3 問答裡沒有網址以外的內部主機名（只准 dzy.mozhuting.com）', bad3h.map((o) => o.question));
  const bad3n = SEED.filter((o) => /(先生|小姐|女士)/.test(prose(o)));
  ok(bad3n.length === 0, 'SEED 規則3 沒有「○○先生／小姐」這類真實姓名稱呼（只用職稱／部門；姓名全面人工讀過）', bad3n.map((o) => o.question));
  // 規則 4：程式代號。問答（question／answer／who）裡的英文字，只准系統畫面上本來就有的
  const EN_OK = new Set(['LINE', 'PDF', 'Safari', 'Chrome', 'iPhone', 'Android', 'Wi', 'Fi', 'QR', 'Cmd', 'Shift', 'Ctrl', 'DZY', 'Excel', 'Word', 'App', 'AI', 'Windows', 'F5', 'Eason']);
  const bad4 = [];
  SEED.forEach((o) => {
    const words = noHost(prose(o)).match(/[A-Za-z][A-Za-z0-9]*/g) || [];
    const unknown = words.filter((w) => w.length > 1 && !EN_OK.has(w));
    if (unknown.length) bad4.push([o.question, unknown]);
  });
  ok(bad4.length === 0, 'SEED 規則4 問答沒有程式代號／英文權限碼（只准 ' + Array.from(EN_OK).join('、') + '）', bad4);
  const bad4p = SEED.filter((o) => /(platform\.|\.gs\b|\baction\b|\btoken\b|PERMS_ON|[a-z]+_[a-z_]+|[a-z]+[A-Z][a-z]+\()/.test(prose(o)));
  ok(bad4p.length === 0, 'SEED 規則4 問答沒有 platform.／.gs／action／token／PERMS_ON 等字樣', bad4p.map((o) => o.question));
  // 純文字：不得含 HTML 或 Markdown 標記（§12.4 畫面一律純文字）
  const badT = SEED.filter((o) => /[<>]|\*\*|`|\]\(/.test(prose(o)));
  ok(badT.length === 0, 'SEED 問答是純文字（無 HTML／Markdown 標記）', badT.map((o) => o.question));
  // 待確認只出現在 source 最後一段
  ok(SEED.every((o) => !/待確認/.test(prose(o)) && (o.source.indexOf('待確認') === -1 || /；待確認：[^；]+$/.test(o.source))), 'SEED 規則5 有疑問的題目在 source 最後加「；待確認：<一句話>」，且只有一句');
  // go 的頁面不要跟題目沒關係：有 go 的題目，go 頁面本人看得到的條件不得比題目寬（避免帶人去沒權限的頁）— 只要求 go 存在，不強求同頁
})();

// ============================================================
// T1-2 待回答、用量、暫停
// ============================================================
(() => {
  const app = scene();
  const { sb } = app;
  const adm = app.admin;
  const k = kbSave(sb, adm, { question: '待答', answer: '答' });
  ok(sb.aihPendingAdd_({ id: PENID(1), log_id: LOGID(1), q: '我要怎麼報加班', m: 'attendance', v: 'main', reason: 'unknown', ts: iso(NOW) }).ok, '1-2 aihPendingAdd_ 寫入');
  sb.aihPendingAdd_({ id: PENID(2), q: '我要怎麼報加班', m: 'attendance', v: 'main', reason: 'unknown', ts: iso(NOW) });
  sb.aihPendingAdd_({ id: PENID(3), q: '別的問題', reason: 'thumbs_down', ts: iso(NOW) });
  const pl = post(sb, 'aihPendingList', { status: 'open' }, adm);
  ok(pl.ok && pl.data.items.length === 3 && pl.data.open_count === 3, '1-2 aihPendingList 列 open', pl.data);
  const first = pl.data.items.find((x) => x.id === PENID(1));
  ok(first.count === 2 && pl.data.items.find((x) => x.id === PENID(3)).count === 1, '1-2 同一題（同頁）出現幾次＝count', pl.data.items.map((x) => [x.id, x.count]));
  ok(post(sb, 'aihPendingSet', { id: PENID(1), status: 'done' }, adm).error === 'bad_request', '1-2 done 沒帶 kb_id → bad_request');
  ok(post(sb, 'aihPendingSet', { id: PENID(1), status: 'done', kb_id: 'kb9999' }, adm).error === 'bad_request', '1-2 done 帶不存在的 kb_id → bad_request');
  ok(post(sb, 'aihPendingSet', { id: PENID(1), status: 'done', kb_id: k.data.id }, adm).error === 'bad_request' && app.sheets.aih_pending._rows()[1][7] === 'open', '1-2 done 帶的題還是草稿（沒上架）→ bad_request、不動資料');
  kbSave(sb, adm, { id: k.data.id, status: 'live', expected_updated_at: k.data.updated_at });
  const dn = post(sb, 'aihPendingSet', { id: PENID(1), status: 'done', kb_id: k.data.id }, adm);
  ok(dn.ok && app.sheets.aih_pending._rows()[1][7] === 'done' && app.sheets.aih_pending._rows()[1][8] === k.data.id, '1-2 done 帶 kb_id → 寫入', dn);
  ok(post(sb, 'aihPendingSet', { id: PENID(2), status: 'ignored' }, adm).ok && post(sb, 'aihPendingList', { status: 'open' }, adm).data.items.length === 1, '1-2 ignored → open 剩 1 筆');
  ok(post(sb, 'aihPendingSet', { id: PENID(9), status: 'ignored' }, adm).error === 'not_found', '1-2 不存在 → not_found');
  ok(post(sb, 'aihPendingSet', { id: PENID(2), status: 'zzz' }, adm).error === 'bad_request', '1-2 狀態不正確 → bad_request');

  // 用量：與手算一致（台北月份；11/30 16:30 UTC＝12/01 台北不算 11 月）
  const logs = [
    logRow({ id: LOGID(1), ts: '2026-11-01T01:00:00Z', usd: 0.001, kind: 'answered' }),
    logRow({ id: LOGID(2), ts: '2026-11-01T02:00:00Z', usd: 0.002, kind: 'unknown' }),
    logRow({ id: LOGID(3), ts: '2026-11-02T01:00:00Z', usd: 0.000003, kind: 'answered' }),
    logRow({ id: LOGID(4), ts: '2026-11-30T16:30:00Z', usd: 9, kind: 'answered' }),
    logRow({ id: LOGID(5), ts: '2026-10-31T15:59:59Z', usd: 9, kind: 'answered' })   // 台北 10/31 23:59:59
  ];
  logs.forEach((l) => { if (!sb.aihLogAppend_(l).ok) throw new Error('log 寫入失敗'); });
  sb.aihFeedback_('u900', LOGID(3), false);
  sb.aihFeedback_('u900', LOGID(1), true);
  const u = post(sb, 'aihUsage', { month: '2026-11' }, adm);
  ok(u.ok && u.data.count === 3 && !('usd' in u.data) && u.data.by_day.every((d) => !('usd' in d)) && u.data.answered_ratio === 0.6667 && u.data.down_ratio === 0.3333 && eq(u.data.by_day, [{ day: '2026-11-01', count: 2 }, { day: '2026-11-02', count: 1 }]), '1-2 aihUsage 11 月：3 筆、不含 usd（費用走 node 帳本）、答得出來 2/3、👎 1/3、by_day 兩天', u.data);
  ok(post(sb, 'aihUsage', { month: '2026-10' }, adm).data.count === 1 && post(sb, 'aihUsage', { month: '2026-12' }, adm).data.count === 1, '1-2 月份邊界以台北時間算（10/31 23:59 算 10 月、11/30 16:30 UTC 算 12 月）');
  ok(post(sb, 'aihUsage', { month: '2027-01' }, adm).data.count === 0 && post(sb, 'aihUsage', { month: '2027-01' }, adm).data.answered_ratio === 0, '1-2 空月份比例為 0');
  ok(post(sb, 'aihUsage', { month: '2026-13' }, adm).error === 'bad_request', '1-2 月份格式錯 → bad_request');

  // 暫停
  ok(post(sb, 'aihPauseSet', { paused: 'yes' }, adm).error === 'bad_request', '暫停 非布林 → bad_request');
  const before = histRows(app).length;
  const p1 = post(sb, 'aihPauseSet', { paused: true }, adm);
  ok(p1.ok && p1.data.changed && app.props.AIH_PAUSED === '1', '暫停 設定 Script Property AIH_PAUSED=1', p1);
  const ph = histRows(app).slice(before);
  ok(ph.length === 1 && ph[0][1] === '' && ph[0][2] === 'pause_on' && ph[0][3] === '{"paused":true}' && ph[0][4] === 'BOSS', '暫停 稽核：aih_kb_hist 追加 pause_on 列（kb_id 空、記誰）', ph);
  ok(post(sb, 'aihPauseSet', { paused: true }, adm).data.changed === false && histRows(app).length === before + 1, '暫停 狀態沒變不重複記');
  ok(post(sb, 'aihUsage', {}, adm).data.paused === true && post(sb, 'aihKbList', {}, adm).data.paused === true, '暫停 aihUsage／aihKbList 回 paused');
  post(sb, 'aihPauseSet', { paused: false }, adm);
  ok(app.props.AIH_PAUSED === '0' && histRows(app).slice(-1)[0][2] === 'pause_off', '暫停 恢復 → 0、hist pause_off');
  ok(post(sb, 'aihPauseSet', { paused: true }, app.aTok).error === 'forbidden' && app.props.AIH_PAUSED === '0', '暫停 一般同仁不能設');
})();

// ============================================================
// T1-3 aiHelpAuthorize_：staff／系統帳／停用帳號、鍵白名單
// ============================================================
(() => {
  const app = scene();
  const { sb } = app;
  const A = sb.aiHelpAuthorize_(app.aTok);
  const S0 = (a) => a.sb.aiHelpAuthorize_(a.accTok);
  const keysOf = (o) => Object.keys(o).sort();
  ok(A.ok === true && eq(keysOf(A), ['can_manage', 'me', 'ok', 'perms', 'who']), '3 staff：頂層鍵只有 ok／who／me／perms／can_manage', keysOf(A));
  ok(eq(keysOf(A.who), ['role', 'uid']) && A.who.uid === String(app.aUid) && A.who.role === 'staff', '3 staff：who 只有 uid、role');
  ok(eq(keysOf(A.me), ['acting_unit_names', 'dept_name', 'extra_dept_names', 'kind', 'staff_add_unit_names', 'status', 'title_name', 'unit_name']) && A.me.kind === 'staff' && A.me.status === 'active', '3 staff：me 的鍵剛好是 spec §6 白名單（8 個）、status active', A.me);
  ok(A.me.unit_name !== '' && A.me.title_name !== '' && Array.isArray(A.me.extra_dept_names) && Array.isArray(A.me.acting_unit_names) && Array.isArray(A.me.staff_add_unit_names), '3 staff：單位名、職稱名有值、三個陣列欄位是陣列', A.me);
  ok(A.perms.length >= 1 && A.perms.every((p) => eq(keysOf(p), ['name_zh', 'source_zh'])) && A.perms.some((p) => p.name_zh === '我的資料' && p.source_zh === '系統角色'), '3 staff：perms 每項只有 name_zh／source_zh，含「我的資料」', A.perms);
  const dump = JSON.stringify(A);
  const emp = A.who && app.a.emp;
  ok(['0911222333', '1995', '新竹市測試路', '測試甲', emp, 'p_', 'phone', 'birthday', 'address', 'emp_no', 'has_pending'].every((s) => dump.indexOf(s) === -1), '3 staff：輸出不含手機、生日、地址、姓名、員工編號、p_* 欄位', dump);
  ok(A.can_manage === false && S0(app).can_manage === false, '3 can_manage：一般同仁、會計 false');
  // 系統帳
  const S = sb.aiHelpAuthorize_(app.accTok);
  ok(S.ok && eq(keysOf(S), ['can_manage', 'me', 'ok', 'perms', 'who']) && eq(S.me, { kind: 'system', role_name: '會計' }) && S.who.role === 'accountant' && S.who.uid === 'u002', '3 系統帳：me 只有 kind 與角色中文名', S);
  ok(S.perms.some((p) => p.name_zh === '稽核：填單與門市管理' && p.source_zh === '系統角色') && JSON.stringify(S).indexOf('假會計') === -1, '3 系統帳：perms 取自角色、不含帳號姓名');
  const AD = sb.aiHelpAuthorize_(app.admin);
  ok(AD.can_manage === true && sb.aiHelpAuthorize_(app.helperTok).can_manage === true, '3 can_manage：admin、持 platform.aihelp 的角色 true');
  ok(AD.ok && AD.me.kind === 'system' && AD.perms.length === 1 && AD.perms[0].name_zh === '全部功能', '3 admin：視為系統帳，權限「全部功能」');
  // 停用帳號與壞 token
  const rowIdx = app.sheets.users._data.findIndex((r) => String(r[0]) === String(app.bUid));
  app.sheets.users._data[rowIdx][7] = 'FALSE';
  const D = sb.aiHelpAuthorize_(app.bTok);
  ok(D.ok === false && D.code === 'unauthorized' && eq(keysOf(D), ['code', 'error', 'ok']) && D.error && !D.who && !D.me, '3 停用帳號（token 還沒過期）→ unauthorized，什麼本人資料都不回', D);
  ok(sb.aiHelpAuthorize_('garbage').code === 'unauthorized' && sb.aiHelpAuthorize_('').code === 'unauthorized' && sb.aiHelpAuthorize_(undefined).code === 'unauthorized', '3 壞 token／空／undefined → unauthorized');
})();

// ============================================================
// T1-3 PERMS_ON='1'（正式環境走的路）：source_zh 三種、aihKbVisible_ 依對照表權限
// ============================================================
(() => {
  const app = scene();
  const { sb } = app;
  const adm = app.admin;
  sb.__nowMs = NOW;
  vm.runInContext("storePilotUnits_ = function () { return ['mzt-gf']; };", app.sb);   // 兼任店長要試點名單（StoreOps.gs 沒載入，補假的）
  ok(post(sb, 'permInit', {}, adm).ok, 'P 前置：permInit');
  app.props.PERMS_ON = '1';
  const rule = post(sb, 'permMapSave', { add: [{ ladder: 'store', dept: '', title: 'pt', perm: 'platform.bulletin' }] }, adm);
  ok(rule.ok, 'P 前置：對照表加規則「門市計時 → 公告管理」', rule);
  const ex = post(sb, 'permExSave', { emp_no: app.a.emp, perm: 'dorm.read', mode: 'add', note: '測' }, adm);
  ok(ex.ok, 'P 前置：給測試甲個別例外 dorm.read', ex);
  const act = post(sb, 'permExSave', { emp_no: app.a.emp, perm: 'store.sm@mzt-gf', mode: 'add', note: '測' }, adm);
  ok(act.ok, 'P 前置：給測試甲兼任店長 mzt-gf', act);
  vm.runInContext('permActingReset_();', sb);
  const A = sb.aiHelpAuthorize_(app.aTok);
  const src = (zh) => A.perms.filter((p) => p.name_zh === zh).map((p) => p.source_zh);
  ok(A.ok && eq(src('公告管理'), ['職稱']), 'P source_zh：規則來自職稱 → 「職稱」', A.perms);
  ok(eq(src('宿舍：查看'), ['個別例外']), 'P source_zh：個別例外 → 「個別例外」');
  ok(A.perms.some((p) => p.source_zh === '兼任店長'), 'P source_zh：兼任店長衍生的碼 → 「兼任店長」', A.perms);
  ok(A.me.acting_unit_names.length === 1 && A.me.acting_unit_names[0] !== '', 'P me.acting_unit_names 有兼任的店名', A.me);
  ok(eq(Object.keys(A).sort(), ['can_manage', 'me', 'ok', 'perms', 'who']) && eq(Object.keys(A.perms[0]).sort(), ['name_zh', 'source_zh']), 'P 開關開時輸出鍵仍是白名單');
  // kb 可見
  const add = (p) => kbSave(sb, adm, Object.assign({ answer: '答', status: 'live', verified_at: '2026-11-02' }, p)).data.id;
  const kBull = add({ question: '公告管理題', m: 'bulletin', v: 'manage' });
  const kDorm = add({ question: '宿舍題', m: 'dorm', v: 'list' });
  const kPay = add({ question: '薪酬題', m: 'payroll', v: 'run' });
  const ids = (r) => r.items.map((x) => x.id);
  const VA = sb.aihKbVisible_(app.aUid);
  ok(ids(VA).includes(kBull) && ids(VA).includes(kDorm) && !ids(VA).includes(kPay), 'P 測試甲（職稱規則＋例外）：看得到公告管理題、宿舍題；看不到薪酬題', ids(VA));
  const VB = sb.aihKbVisible_(app.bUid);
  ok(ids(VB).includes(kBull) && !ids(VB).includes(kDorm) && !ids(VB).includes(kPay), 'P 測試乙（同職稱、沒例外）：有公告管理題、沒有宿舍題', ids(VB));
  // status≠active → unauthorized
  const brow = app.sheets.staff._data.find((r) => r[0] === app.b.emp);
  brow[sb.STF_HEADERS.indexOf('status')] = 'resigned';
  ok(sb.aihKbVisible_(app.bUid).code === 'unauthorized' && sb.aiHelpAuthorize_(app.bTok).code === 'unauthorized', 'P staff status≠active → aihKbVisible_／aiHelpAuthorize_ 都 unauthorized');
})();

// ============================================================
// T1-3 aihKbVisible_：權限過濾、過期、狀態
// ============================================================
(() => {
  const app = scene();
  const { sb } = app;
  const adm = app.admin;
  const add = (p) => { const r = kbSave(sb, adm, Object.assign({ answer: '答', status: 'live', verified_at: '2026-11-02' }, p)); if (!r.ok) throw new Error(JSON.stringify(r)); return r.data.id; };
  const gen = add({ question: '通用題' });
  const me = add({ question: '我的資料題', m: 'me', v: 'profile' });
  const login = add({ question: '公告題', m: 'bulletin', v: 'board' });
  const mod = add({ question: '只有模組', m: 'bulletin' });
  const staffList = add({ question: '同仁名單題', m: 'staff', v: 'list' });
  const staffMod = add({ question: '同仁名單模組題', m: 'staff' });
  const draft = add({ question: '草稿題', status: 'draft' });
  const off = add({ question: '下架題', status: 'off' });
  const expired = add({ question: '過期題', expires_at: '2026-11-02' });         // 到期當天＝過期
  const lastDay = add({ question: '明天才到期', expires_at: '2026-11-03' });
  const noExp = add({ question: '沒到期日' });
  app.sheets.aih_kb._data.find((r) => r[0] === noExp)[11] = '';
  const orphan = add({ question: '孤兒題', m: 'me', v: 'profile' });
  // 把孤兒題的頁面改成不在地圖上的（手改試算表）：fail closed
  const orow = app.sheets.aih_kb._data.find((r) => r[0] === orphan);
  orow[1] = 'gone';
  const ids = (r) => r.items.map((x) => x.id);
  sb.__nowMs = NOW;
  const A = sb.aihKbVisible_(app.aUid);
  ok(A.ok && A.paused === false, '3 aihKbVisible_ 同仁：ok、paused:false');
  ok(eq(ids(A), [gen, me, login, mod, lastDay]), '3 同仁（只有 platform.self）：看到通用題、我的資料題、platform.login 的公告題、模組題、未過期題；看不到同仁名單、草稿、下架、過期、頁面不在地圖的題', ids(A));
  ok(!ids(A).includes(staffList) && !ids(A).includes(staffMod) && !ids(A).includes(draft) && !ids(A).includes(off) && !ids(A).includes(expired) && !ids(A).includes(orphan) && !ids(A).includes(noExp), '3 live 但沒有 expires_at＝fail-closed 不可見；上列被排除的題都不在');
  ok(eq(Object.keys(A.items[0]).sort(), ['answer', 'go_m', 'go_v', 'id', 'm', 'question', 'updated_at', 'v', 'who']), '3 回傳的每題只有約定欄位（沒有 status／updated_by／source）');
  const AD = sb.aihKbVisible_('u001');
  ok(eq(ids(AD), [gen, me, login, mod, staffList, staffMod, lastDay]), '3 admin（*）：同仁名單題也看得到，其餘排除規則相同', ids(AD));
  const AC = sb.aihKbVisible_('u002');
  ok(eq(ids(AC), [gen, login, mod, lastDay]), '3 會計（audit 權限，沒有 platform.self）：看不到我的資料題，只有通用與 platform.login 的頁面', ids(AC));
  ok(sb.aihKbVisible_(app.aUid).items.every((x) => typeof x.id === 'string'), '3 id 一律字串');
  sb.__nowMs = NOW + 2 * DAY;
  ok(!ids(sb.aihKbVisible_(app.aUid)).includes(lastDay), '3 時間過了到期日 → 該題自動不可見');
  sb.__nowMs = NOW;
  // 暫停
  post(sb, 'aihPauseSet', { paused: true }, adm);
  const P = sb.aihKbVisible_(app.aUid);
  ok(P.ok && P.paused === true && P.items.length === 0, '3 暫停中：paused:true、items 空');
  post(sb, 'aihPauseSet', { paused: false }, adm);
  // 停用／不存在的帳號
  const bIdx = app.sheets.users._data.findIndex((r) => String(r[0]) === String(app.bUid));
  app.sheets.users._data[bIdx][7] = 'FALSE';
  ok(sb.aihKbVisible_(app.bUid).code === 'unauthorized' && sb.aihKbVisible_('nobody').code === 'unauthorized' && sb.aihKbVisible_('').code === 'unauthorized', '3 停用帳號／不存在／空 uid → unauthorized');
  // 純函式：頁面規則
  ok(sb.aihPageVisible_(['*'], 'staff', 'list') && !sb.aihPageVisible_([], 'staff', 'list') && sb.aihPageVisible_([], '', '') && sb.aihPageVisible_([], 'bulletin', 'board') && !sb.aihPageVisible_([], 'nope', ''), '3 aihPageVisible_ 規則：* 通過、無權限擋、通用人人可見、platform.login 恆成立、不在地圖擋');
  ok(sb.aihPageVisible_(['platform.self', 'platform.review'], 'me', 'review') && !sb.aihPageVisible_([], 'me', 'review') && !sb.aihPageVisible_(['platform.staff'], 'me', 'review') && sb.aihPageVisible_(['platform.staff', 'platform.self'], 'me', 'review'), '3 requires 是「任一碼」；模組層與分頁層都要過');
  ok(!sb.aihPageVisible_(['payroll.admin'], 'payroll', 'group') && sb.aihPageVisible_(['payroll.admin', 'payroll.write'], 'payroll', 'group') && !sb.aihPageVisible_(['platform.review'], 'me', 'review'), '3 有分頁權限（payroll.admin）沒模組權限（payroll.write）→ 不可見；me/review 只有分頁碼 → 不可見');
})();

// ============================================================
// T1-3 log／pending／feedback／conv 寫入
// ============================================================
(() => {
  const app = scene();
  const { sb } = app;
  const r1 = sb.aihLogAppend_(logRow({ id: LOGID(1), uid: 'u900', conv: 'aic_20261102143000_ab12', kb_ids: ['kb0001', 'kb0002'] }));
  ok(r1.ok && r1.id === LOGID(1) && r1.dup === false, '3 aihLogAppend_ 寫入');
  const lr = app.sheets.aih_log._rows()[1];
  ok(lr[0] === LOGID(1) && lr[2] === 'u900' && lr[3] === 'aic_20261102143000_ab12' && lr[9] === 'kb0001,kb0002' && lr[13] === '', '3 欄位位置正確、kb_ids 逗號串、feedback 空白');
  ok(sb.aihLogAppend_(logRow({ id: LOGID(1) })).dup === true && app.sheets.aih_log._rows().length === 2, '3 同 id 冪等（不重複寫）');
  ok(sb.aihLogAppend_(logRow({ id: 'bad' })).code === 'bad_input' && sb.aihLogAppend_(logRow({ id: LOGID(2), uid: '' })).code === 'bad_input' && sb.aihLogAppend_(logRow({ id: LOGID(2), kind: 'error' })).code === 'bad_input' && sb.aihLogAppend_(logRow({ id: LOGID(2), conv: 'x' })).code === 'bad_input' && sb.aihLogAppend_(null).code === 'bad_input' && sb.aihLogAppend_(logRow({ id: LOGID(2), ts: 'yesterday' })).code === 'bad_input', '3 id／uid／kind／conv／ts 格式不對 → bad_input');
  // feedback：只能改自己的
  ok(sb.aihFeedback_('u901', LOGID(1), false).code === 'not_found' && app.sheets.aih_log._rows()[1][13] === '', '3 aihFeedback_ 改別人的 log → not_found、不動資料');
  ok(sb.aihFeedback_('u900', LOGID(1), false).ok && app.sheets.aih_log._rows()[1][13] === 'down' && sb.aihFeedback_('u900', LOGID(1), true).ok && app.sheets.aih_log._rows()[1][13] === 'up', '3 aihFeedback_ 自己的 → down／up（可改）');
  { const fbr = sb.aihFeedback_('u900', LOGID(1), false); ok(fbr.ok && fbr.q === '怎麼改密碼' && fbr.m === '' && fbr.v === '' && fbr.kind === 'answered', '3 aihFeedback_ 成功時回該筆 log 的 q（已遮罩）、m、v、kind（node 用它寫 👎 待回答）', fbr); }
  ok(sb.aihFeedback_('u901', LOGID(1), false).q === undefined, '3 aihFeedback_ 別人的 log 不回 q');
  ok(sb.aihFeedback_('u900', LOGID(8), true).code === 'not_found' && sb.aihFeedback_('u900', LOGID(1), 'yes').code === 'bad_input' && app.sheets.aih_log._rows()[1].slice(0, 13).join('|') === lr.slice(0, 13).join('|'), '3 不存在 → not_found；good 非布林 → bad_input；其他欄不被動到');
  // pending
  const p1 = sb.aihPendingAdd_({ id: PENID(1), log_id: LOGID(1), q: 'Q1', reason: 'thumbs_down' });
  ok(p1.ok && p1.dup === false && app.sheets.aih_pending._rows()[1][7] === 'open', '3 aihPendingAdd_ 寫入（status open）');
  ok(sb.aihPendingAdd_({ id: PENID(2), log_id: LOGID(1), q: 'Q1', reason: 'thumbs_down' }).dup === true && sb.aihPendingAdd_({ id: PENID(1), q: 'Q1', reason: 'unknown' }).dup === true && app.sheets.aih_pending._rows().length === 2, '3 同 id、或同 log 同 reason 重複 → dup（不灌水）');
  ok(sb.aihPendingAdd_({ id: PENID(3), q: 'Q', reason: 'bad' }).code === 'bad_input' && sb.aihPendingAdd_({ id: 'x', q: 'Q', reason: 'unknown' }).code === 'bad_input' && sb.aihPendingAdd_({ id: PENID(3), q: '', reason: 'unknown' }).code === 'bad_input', '3 aihPendingAdd_ reason／id／q 不對 → bad_input');
  // conv：同 uid 同 conv 最近 3 組，舊→新
  const C = 'aic_20261102150000_0001';
  [1, 2, 3, 4].forEach((i) => sb.aihLogAppend_(logRow({ id: LOGID(10 + i), uid: 'u900', conv: C, q: 'Q' + i, answer: 'A' + i, ts: iso(NOW + i * 1000) })));
  sb.aihLogAppend_(logRow({ id: LOGID(20), uid: 'u901', conv: C, q: '別人的', answer: 'X' }));
  sb.aihLogAppend_(logRow({ id: LOGID(21), uid: 'u900', conv: 'aic_20261102150000_0002', q: '別串', answer: 'Y' }));
  const cg = sb.aihConvGet_('u900', C);
  ok(cg.ok && eq(cg.items, [{ q: 'Q2', a: 'A2' }, { q: 'Q3', a: 'A3' }, { q: 'Q4', a: 'A4' }]), '3 aihConvGet_ 同 uid 同 conv 最近 3 組（舊→新），不混別人、別串', cg.items);
  ok(eq(sb.aihConvGet_('u900', 'bad').items, []) && eq(sb.aihConvGet_('u900', '').items, []) && eq(sb.aihConvGet_('u777', C).items, []), '3 conv 格式錯／空／別人 → 空陣列');
  // 沒初始化
  const raw = load(freshSeed(HASHER)).sb;
  ok(raw.aihLogAppend_(logRow({ id: LOGID(1) })).code === 'not_inited' && raw.aihPurge_(NOW).code === 'not_inited' && raw.aihKbVisible_('u001').code === 'not_inited', '3 沒初始化 → not_inited');
})();

// ============================================================
// T1-3 aihPurge_：三種清除
// ============================================================
(() => {
  const app = scene();
  const { sb } = app;
  const adm = app.admin;
  // log：91 天前、89 天前、剛好 90 天（保留）、壞時間（保留）、台北格式字串
  sb.aihLogAppend_(logRow({ id: LOGID(1), ts: iso(NOW - 91 * DAY) }));
  sb.aihLogAppend_(logRow({ id: LOGID(2), ts: iso(NOW - 89 * DAY) }));
  sb.aihLogAppend_(logRow({ id: LOGID(3), ts: iso(NOW - 90 * DAY) }));
  sb.aihLogAppend_(logRow({ id: LOGID(4), ts: '2026-07-01 08:00:00' }));       // 無時區＝台北時間，約 124 天前
  sb.aihLogAppend_(logRow({ id: LOGID(5), ts: iso(NOW) }));
  // pending：舊的（任何狀態）清 q、新的不動
  sb.aihPendingAdd_({ id: PENID(1), q: '舊的 open', reason: 'unknown', ts: iso(NOW - 100 * DAY) });
  sb.aihPendingAdd_({ id: PENID(2), q: '舊的 done', reason: 'unknown', ts: iso(NOW - 95 * DAY) });
  sb.aihPendingAdd_({ id: PENID(3), q: '新的', reason: 'unknown', ts: iso(NOW - 10 * DAY) });
  post(sb, 'aihPendingSet', { id: PENID(2), status: 'ignored' }, adm);
  // 知識：到期（live）→ off；未到期不動；draft 不動
  const mk = (q, p) => kbSave(sb, adm, Object.assign({ question: q, answer: 'a', status: 'live', verified_at: '2026-11-02' }, p)).data.id;
  const kExp = mk('今天到期', { expires_at: '2026-11-02' });
  const kPast = mk('早就到期', { expires_at: '2026-10-01' });
  const kOk = mk('還沒到期', { expires_at: '2026-11-03' });
  const kNoExp = mk('沒到期日');
  app.sheets.aih_kb._data.find((r) => r[0] === kNoExp)[11] = '';
  const kDraft = mk('草稿過期', { expires_at: '2026-10-01', status: 'draft' });
  const histBefore = histRows(app).length;
  const res = sb.aihPurge_(NOW);
  ok(res.ok && res.log_deleted === 2 && res.pending_q_cleared === 2 && res.kb_expired === 3, '3 aihPurge_ 回報：刪 2 筆 log、清 2 個 q、到期（含無到期日）下架 3 題', res);
  const logIds = app.sheets.aih_log._rows().slice(1).map((r) => r[0]);
  ok(eq(logIds.sort(), [LOGID(2), LOGID(3), LOGID(5)].sort()), '3 aih_log：刪 91 天前與 124 天前（無時區字串視為台北時間）；90 天整、89 天前、今天的保留', logIds);
  const pr = app.sheets.aih_pending._rows().slice(1);
  ok(pr.length === 3 && pr[0][3] === '' && pr[1][3] === '' && pr[2][3] === '新的', '3 aih_pending：90 天前的 q（open 與已結案都算）清空、新的不動、列都還在', pr);
  ok(pr[0][6] === 'unknown' && pr[0][0] === PENID(1) && pr[1][7] === 'ignored', '3 aih_pending：清的只有 q，id／reason／狀態保留');
  const st = (id) => kbRows(app).find((r) => r[0] === id)[8];
  ok(st(kExp) === 'off' && st(kPast) === 'off' && st(kNoExp) === 'off' && st(kOk) === 'live' && st(kDraft) === 'draft', '3 知識到期（到期當天含）→ off；未到期 live、草稿都不動', [st(kExp), st(kPast), st(kOk), st(kDraft)]);
  const hnew = histRows(app).slice(histBefore);
  ok(hnew.length === 3 && hnew.every((r) => r[2] === 'expire' && r[4] === 'system' && JSON.parse(r[3]).status === 'off') && eq(hnew.map((r) => r[1]).sort(), [kExp, kPast, kNoExp].sort()), '3 到期下架各寫一列 aih_kb_hist（action expire、by system、快照 status off）', hnew);
  ok(kbRows(app).find((r) => r[0] === kExp)[13] === 'system', '3 到期下架的題 updated_by＝system');
  const again = sb.aihPurge_(NOW);
  ok(again.ok && again.log_deleted === 0 && again.pending_q_cleared === 0 && again.kb_expired === 0 && histRows(app).length === histBefore + 3, '3 aihPurge_ 重跑不再動任何東西（冪等）', again);
  ok(sb.aihPurge_(NOW + 400 * DAY).log_deleted === 3, '3 時間往後推 400 天 → 剩下的 log 也都過期被刪');
  ok(sb.aihPurge_().ok && sb.aihPurge_('x').ok, '3 nowMs 沒給／不是數字 → 用現在時間，不當掉');
})();

// ============================================================
// aihDigest_
// ============================================================
(() => {
  const app = scene();
  const { sb } = app;
  const adm = app.admin;
  sb.aihPendingAdd_({ id: PENID(1), q: '加班怎麼報', m: 'attendance', v: 'main', reason: 'unknown', ts: iso(NOW - 3600000) });
  sb.aihPendingAdd_({ id: PENID(2), q: '加班怎麼報', m: 'attendance', v: 'main', reason: 'unknown', ts: iso(NOW - 2 * DAY) });
  sb.aihPendingAdd_({ id: PENID(3), q: '請假', reason: 'unknown', ts: iso(NOW - 2 * DAY) });
  sb.aihPendingAdd_({ id: PENID(4), q: '已略過', reason: 'unknown', ts: iso(NOW - 1000) });
  post(sb, 'aihPendingSet', { id: PENID(4), status: 'ignored' }, adm);
  [6, 7, 8, 9, 10, 11].forEach((i) => sb.aihPendingAdd_({ id: PENID(i), q: '雜' + i, reason: 'unknown', ts: iso(NOW - 2 * DAY) }));
  const mk = (q, e) => kbSave(sb, adm, { question: q, answer: 'a', status: 'live', verified_at: '2026-11-02', expires_at: e }).data.id;
  const e14 = mk('14天後', '2026-11-16'), e15 = mk('15天後', '2026-11-17'), e0 = mk('今天', '2026-11-02'), e1 = mk('明天', '2026-11-03');
  const d = sb.aihDigest_(NOW);
  ok(d.ok && eq(Object.keys(d).sort(), ['expiring', 'new_pending', 'ok', 'paused', 'top']) && d.new_pending === 1 && d.paused === false, '8 aihDigest_：過去 24 小時新增且 open 只算 1（略過的、2 天前的不算）', d);
  ok(d.top.length === 5 && eq(d.top[0], { q: '加班怎麼報', m: 'attendance', v: 'main', count: 2 }) && Object.keys(d.top[0]).join() === 'q,m,v,count', '8 top：最多 5 筆、同題次數多的在前、不含已略過', d.top);
  ok(eq(d.expiring.map((x) => x.id).sort(), [e14, e1].sort()) && d.expiring.every((x) => eq(Object.keys(x), ['id', 'question', 'expires_at'])) && !d.expiring.some((x) => x.id === e0 || x.id === e15), '8 expiring：只有 1～14 天後到期（今天、15 天後不算）', d.expiring);
  post(sb, 'aihPauseSet', { paused: true }, adm);
  ok(sb.aihDigest_(NOW).paused === true && sb.aihDigest_(NOW + 400 * DAY).expiring.length === 0, '8 paused 帶出；很久以後 expiring 空');
})();

// ============================================================
// T1-3／T1-5 靜態檢查：7 支不在 Code.gs；頁面地圖＝registry
// ============================================================
(() => {
  const NODE_FNS = ['aiHelpAuthorize_', 'aihKbVisible_', 'aihLogAppend_', 'aihPendingAdd_', 'aihFeedback_', 'aihPurge_', 'aihConvGet_', 'aihDigest_'];
  ok(NODE_FNS.length === 8 && NODE_FNS.every((n) => CODE_GS.indexOf(n) === -1), '5 Code.gs 全文不出現 node 專用 8 支函式的名字', NODE_FNS.filter((n) => CODE_GS.indexOf(n) !== -1));
  const { sb } = load(freshSeed(HASHER));
  ok(NODE_FNS.every((n) => typeof sb[n] === 'function'), '5 8 支都是 sandbox 全域函式（node 可直接呼叫）');
  ok(!sb.CODE_ALLOWED_ACTIONS.some((a) => NODE_FNS.indexOf(a) !== -1) && sb.CODE_ALLOWED_ACTIONS.filter((a) => /^aih/.test(a)).length === 9, '5 白名單裡沒有 8 支；aih* 管理 action 剛好 9 支（含 aihKbImport）');
  // doPost 打得到 7 支名字也一定被拒
  const adm = (() => { const a = load(freshSeed(HASHER)); a.sb.setupStaff(); return [a, adminToken(a.sb)]; })();
  ok(NODE_FNS.every((n) => post(adm[0].sb, n, { token: adm[1] }, adm[1]).error === '不支援的操作'), '5 用 doPost 打這 8 個名字 → 不支援的操作');
})();
await (async () => {
  const pages = await buildPages();
  const fileText = fs.readFileSync(OUT_FILE, 'utf8');
  ok(renderSource(pages) === fileText, '5 AiHelpPages.gs 產物＝現行 registry 產出（逐字）');
  const { sb } = load(freshSeed(HASHER));
  ok(eq(JSON.parse(JSON.stringify(sb.AIH_PAGES)), pages), '5 sandbox 載入的 AIH_PAGES 與 registry 一致');
  ok(pages.length > 50 && pages.every((p) => Object.keys(p).join() === 'm,v,name,view_name,dept,requires_module,requires' && Array.isArray(p.requires)), '5 每頁的鍵固定為 m,v,name,view_name,dept,requires_module,requires', pages.length);
  ok(pages.some((p) => p.m === 'me' && p.v === 'profile' && p.name === '我的資料' && p.view_name === '個人資料' && p.dept === '' && eq(p.requires, ['platform.self']) && eq(p.requires_module, ['platform.self'])), '5 抽驗：我的資料／個人資料');
  const extra = pages.concat([{ m: 'newmod', v: 'main', name: '新模組', view_name: '新', dept: '', requires_module: [], requires: [] }]);
  ok(renderSource(extra) !== fileText, '5 新增模組而沒重產 → 比對不相等（測試會紅）');
  ok(new Set(pages.map((p) => p.m + '/' + p.v)).size === pages.length, '5 (m,v) 不重複');
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
