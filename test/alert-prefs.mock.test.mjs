// node test/alert-prefs.mock.test.mjs —— 我的資料 → 設定：每人提醒開關（Prefs.gs；docs/alert-prefs/spec.md）
// 沙盒骨架照抄 sched-admin-ex.mock.test.mjs（vm 載 .gs、走 doPost）。⚠ 帳密、姓名全是假資料。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'apps-script', 'platform');
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Regions.gs', 'StaffClock.gs', 'Perms.gs', 'PermActions.gs', 'StoreOps.gs', 'ApprovalRoute.gs', 'Approvals.gs', 'Prefs.gs', 'Code.gs']
  .map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}
const J = (v) => JSON.stringify(v);
const eq = (a, b) => J(a) === J(b);

// ── GAS 假物件 ───────────────────────────────────────────────
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
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; } };
  const cache = new Map();
  const props = { HMAC_SECRET: 'fake-hmac-for-storeops-tests' };
  const hooks = { onGet: null, lockCalls: 0 };
  const lockState = { held: false };
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
      getUuid: () => 'fake-uuid-' + (++uuid) + '-' + crypto.randomBytes(4).toString('hex')
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => {
        const e = cache.get(k);
        let v = null;
        if (e && !(e.exp && Date.now() > e.exp)) v = e.v;
        if (hooks.onGet) { const h = hooks.onGet; hooks.onGet = null; h(k); }   // 模擬「另一個請求在這個請求 get 與 remove 之間插進來」
        return v;
      },
      put: (k, v, ttl) => cache.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null }),
      remove: (k) => cache.delete(k)
    }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    // 全域鎖假物件：已被持有時 tryLock 回 false（等同等不到鎖）
    LockService: { getScriptLock: () => ({
      tryLock: () => { hooks.lockCalls++; if (lockState.held) return false; lockState.held = true; return true; },
      releaseLock() { lockState.held = false; }
    }) }
  };
  vm.createContext(sandbox);
  SRC.forEach(([f, code]) => vm.runInContext(code, sandbox, { filename: f }));
  return { sb: sandbox, sheets, cache, props, hooks, lockState };
}
function post(sb, action, payload, token) {
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify({ action, token: token || '', payload: payload || {} }) } }).getContent());
}

const PW = 'fake-prefs-pw-01';
const SALT = 'salt-prefs';
const HASHER = load({ users: [[]], roles: [[]], module_secrets: [[]], login_log: [[]] }).sb;
const USERS_HEAD = ['id', 'username', 'name', 'role', 'node', 'salt', 'hash', 'active', 'created_at', 'last_login_at', 'token_after'];
function world() {
  const h = HASHER.hashPassword_(PW, SALT);
  const app = load({
    users: [USERS_HEAD,
      ['u1', 'ACCA', '假會計甲', 'accountant', '', SALT, h, 'TRUE', '', '', ''],
      ['u2', 'ACCB', '假會計乙', 'accountant', '', SALT, h, 'TRUE', '', '', ''],
      ['u3', 'ACCC', '假停用', 'accountant', '', SALT, h, 'TRUE', '', '', '']],
    roles: [['role', 'name_zh', 'perms'], ['admin', '系統管理者', '*'], ['accountant', '會計', 'audit.write']],
    module_secrets: [['ns', 'level', 'secret']],
    login_log: [['at', 'username', 'ip_hash', 'result']]
  });
  app.login = (u) => { const r = post(app.sb, 'login', { username: u, password: PW }); return r.ok ? r.data.token : ''; };
  return app;
}

const w = world();
const ta = w.login('ACCA');
const tb = w.login('ACCB');
ok(!!ta && !!tb, '0: 假帳號登入成功');

// 1. 沒存過＝全部開著
let r = post(w.sb, 'myPrefsGet', {}, ta);
ok(r.ok && eq(r.data.alerts_off, []) && r.data.updated_at === '', '1a: 沒設定過 → alerts_off 空陣列', r);
ok(!w.sheets.user_prefs, '1b: 只讀不建表');

// 2. 存檔、讀回、自動建表
r = post(w.sb, 'myPrefsSave', { alerts_off: ['audit-stock', 'eval', 'audit-stock'] }, ta);
ok(r.ok && eq(r.data.alerts_off, ['audit-stock', 'eval']), '2a: 存檔成功且去重', r);
ok(!!w.sheets.user_prefs && eq(w.sheets.user_prefs._rows()[0], ['uid', 'prefs_json', 'updated_at']), '2b: 第一次存檔自動建 user_prefs 表頭');
r = post(w.sb, 'myPrefsGet', {}, ta);
ok(r.ok && eq(r.data.alerts_off, ['audit-stock', 'eval']) && !!r.data.updated_at, '2c: 讀回同一份', r);
ok(w.hooks.lockCalls >= 1, '2d: myPrefsSave 有拿全域鎖');

// 3. 每人分開；夾帶 uid 無效
r = post(w.sb, 'myPrefsGet', {}, tb);
ok(r.ok && eq(r.data.alerts_off, []), '3a: 別人讀不到我的設定', r);
r = post(w.sb, 'myPrefsSave', { alerts_off: ['dorm'], uid: 'u1', id: 'u1' }, tb);
ok(r.ok, '3b: 乙存自己的');
r = post(w.sb, 'myPrefsGet', {}, ta);
ok(eq(r.data.alerts_off, ['audit-stock', 'eval']), '3c: payload 夾帶 uid 不會改到甲', r);
ok(w.sheets.user_prefs._rows().length === 3, '3d: 一人一列（表頭＋2）', w.sheets.user_prefs._rows());

// 4. 覆寫同一列、可清空
r = post(w.sb, 'myPrefsSave', { alerts_off: [] }, ta);
ok(r.ok && eq(post(w.sb, 'myPrefsGet', {}, ta).data.alerts_off, []), '4a: 全部打開＝空陣列');
ok(w.sheets.user_prefs._rows().length === 3, '4b: 覆寫原列不新增');

// 5. 格式錯擋下，不寫
const before = J(w.sheets.user_prefs._rows());
for (const [lb, bad] of [['不是陣列', 'audit-stock'], ['大寫', ['Audit']], ['數字', [1]], ['路徑字元', ['../x']], ['太長', ['a'.repeat(40)]], ['沒帶', undefined], ['超過 60 個', Array.from({ length: 61 }, (_, i) => 'm' + i)]]) {
  r = post(w.sb, 'myPrefsSave', bad === undefined ? {} : { alerts_off: bad }, ta);
  ok(!r.ok && /格式/.test(r.error), '5: 格式錯擋下（' + lb + '）', r);
}
ok(J(w.sheets.user_prefs._rows()) === before, '5z: 格式錯沒有寫入');

// 6. 沒登入、停用
ok(!post(w.sb, 'myPrefsGet', {}, '').ok, '6a: 沒 token 讀不到');
ok(!post(w.sb, 'myPrefsSave', { alerts_off: [] }, 'bad.token').ok, '6b: 壞 token 不能存');
const tc = w.login('ACCC');
w.sheets.users._data[3][7] = 'FALSE';
ok(!post(w.sb, 'myPrefsGet', {}, tc).ok, '6c: 帳號停用後 token 讀不到');

// 7. 儲存格壞掉（非 JSON）→ 當成沒設定，不讓首頁壞
w.sheets.user_prefs._data[1][1] = '{壞掉';
r = post(w.sb, 'myPrefsGet', {}, ta);
ok(r.ok && eq(r.data.alerts_off, []), '7: 壞 JSON → 空陣列', r);

// 8. 白名單：讀取在 dryrun 與 minikit 讀取清單、寫入不在
const dry = fs.readFileSync(path.join(ROOT, 'platform', 'dryrun.js'), 'utf8');
ok(/'myPrefsGet'/.test(dry) && !/'myPrefsSave'/.test(dry), '8a: dryrun READ_ACTIONS 有 myPrefsGet、沒有 myPrefsSave');
const code = fs.readFileSync(path.join(DIR, 'Code.gs'), 'utf8');
ok(/myPrefsSave: 1/.test(code), '8b: myPrefsSave 在 MUTATING_ACTIONS');

// 9. 前端純函式（platform/alert-prefs.js）與 manifest
{
  const ap = await import('../platform/alert-prefs.js');
  const mem = new Map();
  const st = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  ok(eq(ap.cleanOff(['eval', 'Eval', 'eval', 3, '../x', 'audit-stock']), ['eval', 'audit-stock']), '9a: cleanOff 只留合法 id、去重');
  ok(eq(ap.loadFor(st, 'u1'), []) && !ap.isMuted('eval'), '9b: 沒快取＝全部開著');
  ok(ap.apply(st, ['eval']) === true && ap.isMuted('eval'), '9c: apply 回 true＝有變');
  ok(ap.apply(st, ['eval']) === false, '9d: 一樣的清單回 false（不重算）');
  ok(mem.get('dzy.u.u1.alert_off') === '["eval"]', '9e: 寫進本機快取 dzy.u.<id>.alert_off');
  ok(eq(ap.loadFor(st, 'u2'), []) && !ap.isMuted('eval'), '9f: 換帳號不沿用別人的');
  ok(eq(ap.loadFor(st, 'u1'), ['eval']), '9g: 同帳號再開沿用快取');
  mem.set('dzy.u.u1.alert_off', '{壞');
  ok(eq(ap.loadFor(st, 'u1'), []), '9h: 快取壞掉當沒設定');
  ok(eq(ap.keepOnly([{ text: 'a', keep: true }, { text: 'b' }, null]), [{ text: 'a', keep: true }]), '9i: keepOnly 只留 keep:true');
  ok(ap.keepOnly(null) === null, '9j: keepOnly 非陣列原樣回');
  const { validateManifest } = await import('../platform/manifest-check.js');
  const me = (await import('../modules/me/manifest.js')).default;
  const vr = validateManifest(me);
  const errs = Array.isArray(vr) ? vr : (vr && vr.errors) || [];
  ok(errs.length === 0, '9k: 我的資料 manifest 通過檢查', vr);
  ok(me.views.some((v) => v.id === 'settings' && v.name === '設定'), '9l: 我的資料有「設定」分頁');
  const other = { ...me, id: 'demo-x' };
  const vr2 = validateManifest(other);
  const errs2 = Array.isArray(vr2) ? vr2 : (vr2 && vr2.errors) || [];
  ok(errs2.some((e) => /alertSettings/.test(e)), '9m: 別的模組宣告 alertSettings 會被擋', vr2);
  const meIdx = fs.readFileSync(path.join(ROOT, 'modules', 'me', 'index.js'), 'utf8');
  ok((meIdx.match(/keep: true/g) || []).length === 3, '9n: 帳號狀態三種提醒都標 keep:true');
}

console.log(`\n結果：${passed} 通過、${failed} 失敗`);
if (failed) process.exit(1);
