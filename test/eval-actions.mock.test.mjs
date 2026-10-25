// node test/eval-actions.mock.test.mjs —— 績效評核 P2～P5 後端：權限範圍、填寫窗、防重複、匿名、計分、定稿、新人考核、匯入（docs/eval/task.md）
// 測試骨架（假試算表、claim 流程）照抄 perms-actions.mock.test.mjs；另載入 ApprovalRoute／Approvals（apvDirectory_）與 EvalCalc／Eval。
// ⚠ 全部假資料（dzy 是 public repo）。

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
const SRC = ['Auth.gs', 'Users.gs', 'Staff.gs', 'Perms.gs', 'PermActions.gs', 'ApprovalRoute.gs', 'Approvals.gs', 'EvalCalc.gs', 'Eval.gs', 'Code.gs'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

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
  const props = { HMAC_SECRET: 'fake-hmac-for-eval-actions' };
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

// ============================================================
// 績效評核場景
// ============================================================
const J = (x) => JSON.stringify(x);
function scene() {
  const app = load(freshSeed());
  const { sb } = app;
  sb.setupStaff();
  app.sheets.staff.getRange(1, sb.STF_EXTRA_DEPTS_COL_NO).setValue('extra_depts');
  sb.__admin = adminTok(sb);
  const MALA = (title) => ({ brand: 'mala', unit: 'mala-gf', title });
  const P = {
    hrHm: mk(sb, '人資主管', HQ('hr', 'hm')),
    hrHs: mk(sb, '人資同仁', HQ('hr', 'hs')),
    sm: mk(sb, '光復店長', MALA('sm')),
    pt1: mk(sb, '計時甲', MALA('pt')),
    pt2: mk(sb, '計時乙', MALA('pt')),
    ft1: mk(sb, '正職丙', MALA('ft')),
    osv: mk(sb, '小辛辣督導', { brand: 'mala', unit: 'mala-hq', title: 'osv' }),
    msm: mk(sb, '墨竹亭店長', { brand: 'mzt', unit: 'mzt-gf', title: 'sm' }),
    mpt: mk(sb, '墨竹亭計時', { brand: 'mzt', unit: 'mzt-gf', title: 'pt' }),
    ceo: mk(sb, '執行長', HQ('mgmt', 'ceo')),
    it: mk(sb, '資訊同仁', HQ('it', 'hs'))
  };
  post(sb, 'permInit', {}, sb.__admin);
  app.props.PERMS_ON = '1';
  return Object.assign(app, { P });
}
const ev = (app, who, action, payload) => post(app.sb, action, payload || {}, who === 'admin' ? app.sb.__admin : app.P[who].token);
const setToday = (app, d) => { app.sb.evToday_ = () => d; };
const LV = ['五', '四', '三', '二', '一'];
const items = (keys) => keys.map((k) => ({ key: k, label: '題目' + k, levels: LV }));
function seedBank(app, brand) {
  ok(ev(app, 'hrHm', 'evBankSave', { brand, set: 'pt_att', items: items(['a1', 'a2']) }).ok, '設定：' + brand + ' 計時態度 2 題');
  ok(ev(app, 'hrHm', 'evBankSave', { brand, set: 'pt_perf', items: items(['p1', 'p2']) }).ok, '設定：' + brand + ' 計時表現 2 題');
  ok(ev(app, 'hrHm', 'evBankSave', { brand, set: 'ft_att', items: items(['f1', 'f2']) }).ok, '設定：' + brand + ' 正職態度 2 題');
}
const KPI = [{ key: 'k1', type: '技能', label: '營業額', weight: 40 }, { key: 'k2', type: '執行力', label: '交辦', weight: 30 }];

// ── 1. 初始化與權限 ──
const app = scene();
const { sb, sheets, P } = app;
{
  setToday(app, '2027-01-03');
  const pre = ev(app, 'pt1', 'evMe');
  ok(pre.ok === false && pre.error === 'not_inited', '1: 沒初始化 → not_inited', pre);
  const bad = ev(app, 'hrHm', 'evSetup');
  ok(bad.ok === false && bad.error === 'forbidden', '1: 人資主管不能初始化（只有 role admin）', bad);
  const r = ev(app, 'admin', 'evSetup');
  ok(r.ok && r.data.permAdded.length === sb.EV_PERM_DEFAULT_RULES.length, '1: admin 初始化，perm_map 補 ' + sb.EV_PERM_DEFAULT_RULES.length + ' 條', r);
  ok(Object.values(sb.EV_SH).every((n) => sheets[n]), '1: 12 張 ev_ 分頁都建好');
  ok(sheets.ev_wage._data.length === 1 + 8 * 4 && sheets.ev_grade._data.length === 1 + 4 * 4, '1: 四品牌各有時薪 8 列、等第 4 列');
  const r2 = ev(app, 'admin', 'evSetup');
  ok(r2.ok && r2.data.permAdded.length === 0 && sheets.ev_wage._data.length === 33, '1: 重按初始化不重複');
  ok(ev(app, 'sm', 'evBankSave', { brand: 'mala', set: 'pt_att', items: items(['x']) }).error === 'forbidden', '1: 店長不能改題目');
  seedBank(app, 'mala');
  seedBank(app, 'mzt');
  ok(ev(app, 'hrHm', 'evTplSave', { brand: 'mala', title: 'ft', items: KPI }).data.total === 70, '設定：mala 正職 KPI 範本 70 分');
  const bk = ev(app, 'hrHm', 'evBankSave', { brand: 'mala', set: 'pt_att', items: [{ key: 'a1', label: 'x', levels: ['1', '2'] }] });
  ok(bk.ok === false && bk.error === 'bad_request', '1: 星等說明不足 5 級 → 擋', bk);
}

// ── 2. evMe：同店名單、品牌題庫 ──
{
  const m = ev(app, 'pt1', 'evMe');
  ok(m.ok && m.data.quarter === '2026-Q4' && m.data.windowOpen === true && m.data.evaluable, '2: 1/3 → 填 2026-Q4、填寫窗開', m.data && { q: m.data.quarter, w: m.data.windowOpen });
  ok(J(m.data.peers.map((x) => x.emp).sort()) === J([P.sm.emp, P.pt2.emp, P.ft1.emp].sort()), '2: 名單只有同店三人（不含自己、督導、墨竹亭）', m.data.peers);
  ok(m.data.bank.pt_att.length === 2 && m.data.bankReady, '2: 拿到小辛辣題庫');
  const hq = ev(app, 'it', 'evMe');
  ok(hq.ok && hq.data.evaluable === false && !hq.data.peers, '2: 總部同仁不在評核範圍', hq.data);
  const o = ev(app, 'osv', 'evMe');
  ok(o.data.evaluable === false && o.data.perms.manage && o.data.perms.readBrand, '2: 督導不被評、但有打分與看品牌權限', o.data.perms);
}

// ── 3. 互評送出 ──
{
  const bad = ev(app, 'pt1', 'evPeerSubmit', { ratings: [{ ratee: P.mpt.emp, att: [5, 5], perf: [5, 5] }] });
  ok(bad.ok === false && bad.error === 'not_in_unit', '3: 評別家店的人 → not_in_unit', bad);
  const half = ev(app, 'pt1', 'evPeerSubmit', { ratings: [{ ratee: P.pt2.emp, att: [5, 4], perf: [4] }] });
  ok(half.ok === false && half.error === 'bad_request', '3: 表現題沒評完 → 擋', half);
  const zero = ev(app, 'pt1', 'evPeerSubmit', { ratings: [{ ratee: P.pt2.emp, att: [5, 0], perf: [4, 4] }] });
  ok(zero.ok === false, '3: 0 顆星 → 擋');
  const g = ev(app, 'pt1', 'evPeerSubmit', { ratings: [{ ratee: P.pt2.emp, att: [5, 4], perf: [4, 4] }, { ratee: P.ft1.emp, att: [5, 5] }] });
  ok(g.ok && g.data.count === 2, '3: 評兩位（正職只評態度）', g);
  ok(ev(app, 'pt1', 'evPeerSubmit', { ratings: [{ ratee: P.sm.emp, att: [3, 3] }] }).error === 'duplicate', '3: 同一季第二次送出 → duplicate');
  const row = sheets.ev_peer._data[1];
  ok(row[0] === '2026-Q4' && row[1] === 'mala-gf' && /題目a1/.test(row[6]), '3: 存季度、單位、當下題目文字', row);
  ok(ev(app, 'pt1', 'evMe').data.peerDone === true, '3: evMe 顯示已送出');
  ok(ev(app, 'sm', 'evPeerSubmit', { ratings: [{ ratee: P.pt2.emp, att: [3, 3], perf: [3, 3] }] }).ok, '3: 店長也評計時乙');
  setToday(app, '2027-01-06');
  const late = ev(app, 'pt2', 'evPeerSubmit', { ratings: [{ ratee: P.pt1.emp, att: [3, 3], perf: [3, 3] }] });
  ok(late.ok === false && late.error === 'window_closed', '3: 1/6 → 填寫期已過', late);
  setToday(app, '2027-01-03');
}

// ── 4. 自評與留言 ──
{
  const s = ev(app, 'pt2', 'evSelfSubmit', { att: [3, 3], perf: [2, 2], note: '下季要更快', company: '希望多一台冰箱',
    peers: [{ to: P.pt1.emp, msg: '謝謝支援', anon: true }, { to: P.sm.emp, msg: '店長辛苦了', anon: false }] });
  ok(s.ok, '4: 自評＋三種留言', s);
  ok(ev(app, 'pt2', 'evSelfSubmit', { att: [3, 3], perf: [2, 2] }).error === 'duplicate', '4: 自評第二次 → duplicate');
  const x = ev(app, 'pt1', 'evSelfSubmit', { att: [4, 4], perf: [4, 4], peers: [{ to: P.mpt.emp, msg: '嗨' }] });
  ok(x.ok === false && x.error === 'not_in_unit', '4: 留言給別家店 → 擋', x);
  ok(ev(app, 'ft1', 'evSelfSubmit', { att: [4, 4] }).ok, '4: 正職自評只填態度');
}

// ── 5. 我的成績：10 號前不公布、只回彙總 ──
{
  setToday(app, '2027-01-08');
  const early = ev(app, 'pt2', 'evMyScores');
  ok(early.ok && early.data.quarters.length === 0, '5: 1/8 本季還看不到', early.data.quarters);
  ok(early.data.messages.some((m) => m.kind === 'self' && m.text === '下季要更快'), '5: 留言不受 10 號限制');
  setToday(app, '2027-01-10');
  const r = ev(app, 'pt2', 'evMyScores');
  const q = r.data.quarters[0];
  // 態度：計時甲 9、店長 6、自評 6 → 7；表現：8、6、4 → 6
  ok(q && q.quarter === '2026-Q4' && q.attitude === 7 && q.performance === 6 && q.total === 13 && q.attCount === 3, '5: 計時乙 2026-Q4 態度 7、表現 6、總 13（自評算一票）', q);
  ok(J(q.attItems) === J([11 / 3, 10 / 3]), '5: 每題平均', q.attItems);
  const s = J(r);
  ok(!s.includes(P.pt1.emp) && !s.includes(P.sm.emp) && !s.includes('rater'), '5: 回應裡沒有任何評分者編號', s.slice(0, 300));
  const p1 = ev(app, 'pt1', 'evMyScores').data.messages.find((m) => m.kind === 'peer');
  ok(p1 && p1.text === '謝謝支援' && p1.from === '', '5: 匿名夥伴留言不帶名字', p1);
  const sm = ev(app, 'sm', 'evMyScores').data.messages.find((m) => m.kind === 'peer');
  ok(sm && sm.from === '計時乙', '5: 具名留言帶名字', sm);
  ok(!J(ev(app, 'pt2', 'evMyScores')).includes('希望多一台冰箱'), '5: 給公司的話不回給本人');
}

// ── 6. 範圍：誰看得到誰 ──
{
  const none = ev(app, 'pt1', 'evUnitResults');
  ok(none.ok === false && none.error === 'no_scope', '6: 一般同仁沒有單位結果', none);
  const smr = ev(app, 'sm', 'evUnitResults', { quarter: '2026-Q4' });
  ok(smr.ok && J(smr.data.units.map((u) => u.unit)) === J(['mala-gf']), '6: 店長只看到光復', smr.data && smr.data.units);
  const meRow = smr.data.rows.find((x) => x.isMe);
  ok(meRow && meRow.result === null, '6: 店長在名單上看不到自己的分數');
  const r2 = smr.data.rows.find((x) => x.emp === P.pt2.emp);
  ok(r2 && r2.result.total === 13 && r2.canManage && r2.peerDone === false && r2.selfDone === true, '6: 店長看得到計時乙、可打分、填寫進度', r2);
  ok(!J(smr).includes('rater') && smr.data.company.length === 0, '6: 店長看不到評分者、也看不到給公司的話', smr.data.company);
  ok(ev(app, 'msm', 'evPersonDetail', { emp: P.pt2.emp }).error === 'forbidden', '6: 墨竹亭店長看不到小辛辣同仁');
  ok(ev(app, 'msm', 'evUnitResults', { unit: 'mala-gf' }).error === 'forbidden', '6: 墨竹亭店長不能指定別家店');
  const o = ev(app, 'osv', 'evUnitResults', { unit: 'mala-gf', quarter: '2026-Q4' });
  ok(o.ok && o.data.rows.find((x) => x.emp === P.sm.emp).canManage && o.data.company.includes('希望多一台冰箱'), '6: 督導看光復、可替店長打分、看得到給公司的話', o.data && o.data.company);
  ok(!o.data.units.some((u) => u.brand !== 'mala'), '6: 督導只看小辛辣的店');
  const c = ev(app, 'ceo', 'evUnitResults', { unit: 'mzt-gf' });
  ok(c.ok && c.data.units.some((u) => u.unit === 'mzt-gf') && c.data.units.some((u) => u.unit === 'mala-gf'), '6: 執行長看全集團');
  ok(c.data.rows.every((x) => !x.canManage), '6: 執行長預設不能替門市打分');
  ok(ev(app, 'sm', 'evSupSave', { emp: P.osv.emp, quarter: '2026-Q4', feedback: 'x' }).error === 'forbidden', '6: 店長不能打督導');
  ok(ev(app, 'pt1', 'evSupSave', { emp: P.pt2.emp, quarter: '2026-Q4', feedback: 'x' }).error === 'forbidden', '6: 計時不能打分');
}

// ── 7. 主管打分：KPI、加減分、回饋 ──
{
  const s1 = ev(app, 'sm', 'evSupSave', { emp: P.ft1.emp, quarter: '2026-Q4', kpi: { k1: { sel: 'B', actual: '120 萬' }, k2: { sel: '完成' } } });
  ok(s1.ok, '7: 店長打正職丙 KPI', s1);
  ok(ev(app, 'sm', 'evSupSave', { emp: P.ft1.emp, quarter: '2026-Q4', adj_att: 2, adj_reason: '主動支援', feedback: '做得好' }).ok, '7: 再存加減分與回饋（不洗掉 KPI）');
  ok(ev(app, 'sm', 'evSupSave', { emp: P.ft1.emp, quarter: '2026-Q4', adj_att: 'abc' }).error === 'bad_request', '7: 調整不是數字 → 擋');
  const d = ev(app, 'sm', 'evPersonDetail', { emp: P.ft1.emp, quarter: '2026-Q4' }).data;
  // 態度：計時甲 [5,5]=10、自評 [4,4]=8 → 9 ×1.2 = 10.8；KPI 40×0.8＋30 = 62；+2 → 74.8 → C
  ok(d.result.performance === 62 && Math.abs(d.result.attitude - 10.8) < 1e-9 && d.result.total === 74.8 && d.result.grade === 'C', '7: 正職丙 態度 10.8＋KPI 62＋調整 2＝74.8（C）', d.result);
  ok(d.sup.feedback === '做得好' && d.sup.kpi.k1.actual === '120 萬' && d.tpl.title === 'ft', '7: 明細帶回主管欄位與範本', d.sup);
  ok(!J(d).includes(P.pt1.emp), '7: 明細沒有評分者編號');
  const fb = ev(app, 'ft1', 'evMyScores').data;
  ok(fb.quarters[0].total === 74.8 && fb.quarters[0].feedback === '做得好' && fb.quarters[0].kpi[0].actual === '120 萬', '7: 正職丙在我的成績看到分數、KPI 實際值、回饋', fb.quarters[0]);
  ok(ev(app, 'osv', 'evSupSave', { emp: P.sm.emp, quarter: '2026-Q4', feedback: '辛苦了' }).ok, '7: 督導替店長寫回饋（往上一層）');
}

// ── 8. 定稿 ──
{
  ok(ev(app, 'sm', 'evFinalize', { unit: 'mala-gf', quarter: '2026-Q4' }).error === 'forbidden', '8: 店長不能定稿');
  const f = ev(app, 'hrHm', 'evFinalize', { unit: 'mala-gf', quarter: '2026-Q4' });
  ok(f.ok && f.data.skipped.includes('光復店長'), '8: 人資主管定稿；店長 KPI 沒評完不鎖', f.data);
  ok(ev(app, 'sm', 'evSupSave', { emp: P.ft1.emp, quarter: '2026-Q4', adj_att: 5 }).error === 'finalized', '8: 定稿後不能改分');
  // 改題目後，已定稿季的題目與分數不變
  ev(app, 'hrHm', 'evBankSave', { brand: 'mala', set: 'pt_att', items: items(['z1', 'z2', 'z3']) });
  const q = ev(app, 'pt2', 'evMyScores').data.quarters[0];
  ok(q.source === 'final' && q.total === 13 && J(q.attLabels) === J(['題目a1', '題目a2']), '8: 改題後定稿季仍是原題目與 13 分', q);
  ok(ev(app, 'hrHm', 'evUnfinalize', { unit: 'mala-gf', quarter: '2026-Q4' }).ok, '8: 解除定稿');
  ok(ev(app, 'pt2', 'evMyScores').data.quarters[0].source === 'live', '8: 解除後回到即時計算');
  ev(app, 'hrHm', 'evBankSave', { brand: 'mala', set: 'pt_att', items: items(['a1', 'a2']) });
}

// ── 9. 新人考核 ──
{
  const hireCol = sb.STF_COL_COUNT;   // 0-based
  const setHire = (emp, d) => { const row = sheets.staff._data.find((r) => r[sb.STF_COL.emp_no] === emp); while (row.length <= hireCol) row.push(''); row[hireCol] = d; };
  setHire(P.pt1.emp, '2026-12-01');
  setHire(P.pt2.emp, '2026-12-20');
  setHire(P.ft1.emp, '2025-01-01');   // 早於保險絲
  setToday(app, '2027-01-05');
  const l = ev(app, 'sm', 'evNewbieList');
  const st = Object.fromEntries(l.data.list.map((x) => [x.emp, x.state]));
  ok(st[P.pt1.emp] === 'due' && st[P.pt2.emp] === 'waiting' && !st[P.ft1.emp], '9: 滿月 due、未滿 waiting、舊人不出現', l.data.list);
  ok(ev(app, 'pt1', 'evNewbieList').error === 'forbidden', '9: 計時看不到新人清單');
  ok(ev(app, 'msm', 'evNewbieList').data.list.length === 0, '9: 墨竹亭店長看不到小辛辣新人');
  ok(ev(app, 'sm', 'evNewbieSubmit', { emp: P.pt2.emp, att: [5, 5], perf: [5, 5] }).error === 'bad_request', '9: 還沒滿月不能考');
  const s = ev(app, 'sm', 'evNewbieSubmit', { emp: P.pt1.emp, att: [5, 4], perf: [3, 3] });
  ok(s.ok && s.data.total === 15, '9: 新人考核直接加總', s);
  ok(ev(app, 'sm', 'evNewbieSubmit', { emp: P.pt1.emp, att: [5, 4], perf: [3, 3] }).error === 'duplicate', '9: 一人一次');
  const mine = ev(app, 'pt1', 'evMyScores').data.newbie;
  ok(mine && mine.total === 15, '9: 新人在我的成績看到入職考核', mine);
}

// ── 10. 匯入舊成績 ──
{
  const pv = ev(app, 'hrHm', 'evImportPreview', { unit: 'mala-gf', names: ['計時甲', '沒這個人'] });
  ok(pv.ok && pv.data.matches[0].hits[0].emp === P.pt1.emp && pv.data.matches[1].hits.length === 0, '10: 依姓名比對', pv.data);
  ok(ev(app, 'sm', 'evImportCommit', { rows: [] }).error === 'forbidden', '10: 店長不能匯入');
  const c = ev(app, 'hrHm', 'evImportCommit', { rows: [{ quarter: '2026-Q3', emp: P.pt1.emp, kind: 'pt', result: { attitude: 25, performance: 60, total: 85 } }] });
  ok(c.ok, '10: 匯入 2026-Q3', c);
  setToday(app, '2027-01-12');
  const qs = ev(app, 'pt1', 'evMyScores').data.quarters;
  const q3 = qs.find((x) => x.quarter === '2026-Q3');
  ok(q3 && q3.source === 'hist' && q3.total === 85 && q3.grade === 'A' && q3.wageIdx === 3, '10: 我的成績看到舊季（A 等、時薪第 4 格）', q3);
  const bad = ev(app, 'hrHm', 'evImportCommit', { rows: [{ quarter: '2026-Q3', emp: P.pt1.emp, kind: 'pt', result: { total: 130 } }] });
  ok(bad.ok === false, '10: 總分超過 100 → 擋');
}

// ── 11. 時薪與等第（品牌各一張）──
{
  ok(ev(app, 'hrHm', 'evGradeSave', { brand: 'mzt', rows: [{ grade: 'A', min: 90, base: 1 }, { grade: 'B', min: 50, base: 0.5 }] }).error === 'bad_request', '11: 沒有 0 分那列 → 擋');
  ok(ev(app, 'hrHm', 'evGradeSave', { brand: 'mzt', rows: [{ grade: 'A', min: 90, base: 1 }, { grade: 'B', min: 0, base: 0.5 }] }).ok, '11: 墨竹亭改等第表');
  ok(ev(app, 'hrHm', 'evWageSave', { brand: 'mzt', rows: [['80 分以上', '250'], ['79 分以下', '200']] }).ok, '11: 墨竹亭改時薪');
  const g = ev(app, 'hrHm', 'evBankGet', { brand: 'mzt' }).data;
  const m = ev(app, 'hrHm', 'evBankGet', { brand: 'mala' }).data;
  ok(g.grade.length === 2 && g.wage.length === 2 && m.grade.length === 4 && m.wage.length === 8, '11: 只改到墨竹亭，小辛辣不變');
}

// ── 12. 試跑白名單：讀取 action 都在 dryrun.js、寫入 action 都不在 ──
{
  const { READ_ACTIONS } = await import('../platform/dryrun.js');
  const reads = ['evMe', 'evMyScores', 'evNewbieList', 'evUnitResults', 'evPersonDetail', 'evBankGet', 'evImportPreview'];
  const writes = ['evSetup', 'evPeerSubmit', 'evSelfSubmit', 'evNewbieSubmit', 'evSupSave', 'evBankSave', 'evTplSave', 'evWageSave', 'evGradeSave', 'evFinalize', 'evUnfinalize', 'evImportCommit'];
  ok(reads.every((a) => READ_ACTIONS.platform.includes(a)), '12: 讀取 action 都在試跑白名單');
  ok(writes.every((a) => !READ_ACTIONS.platform.includes(a)), '12: 寫入 action 都不在試跑白名單');
  ok(reads.concat(writes).every((a) => sb.CODE_ALLOWED_ACTIONS.includes(a)) && reads.length + writes.length === sb.CODE_ALLOWED_ACTIONS.filter((a) => /^ev[A-Z]/.test(a)).length, '12: Code.gs 白名單剛好是這 19 支');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
