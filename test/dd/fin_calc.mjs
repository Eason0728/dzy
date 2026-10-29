// node test/dd/fin_calc.mjs — 財務部門四模組的純函式資料帶入測試（隨機資料，預期值照規格自己算，不拿系統函式當裁判）
// 範圍：cashbook lib/matrix.js（稅額拆分、合計、匯出列排序、矩陣、xlsx 格子）、lib/util.js（台北日期閘門、月份、提醒、科目檢查）、
//       pnl/bridge.js、transfer-fin/bridge.js（parseCall 刪敏感欄位、toPageResult 試跑／錯誤還原）、purchase（navTabs／wantedTab／countAlerts／parseCounts）、
//       platform/dryrun.js READ／WRITE 與 Auth.gs 白名單、bridge 白名單一致。
// E2E_SEED=<n> 重現；預設隨機。每次跑完印種子。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const M = await import(path.join(ROOT, 'modules/cashbook/lib/matrix.js'));
const U = await import(path.join(ROOT, 'modules/cashbook/lib/util.js'));
const PB = await import(path.join(ROOT, 'modules/pnl/bridge.js'));
const TB = await import(path.join(ROOT, 'modules/transfer-fin/bridge.js'));
const PE = await import(path.join(ROOT, 'modules/purchase/embed.js'));
const PC = await import(path.join(ROOT, 'modules/purchase/counts.js'));
const DR = await import(path.join(ROOT, 'platform/dryrun.js'));

const SEED = Number(process.env.E2E_SEED) || (Math.floor(Math.random() * 1e9) + 1);
console.log('E2E_SEED=' + SEED);
let st = SEED >>> 0 || 1;
const rand = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 4294967296; };
const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (arr) => arr[ri(0, arr.length - 1)];
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = ri(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; };

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 獨立算式（規格：有發票 未稅＝round(金額/1.05)、稅額＝金額−未稅；無發票 稅額 0）
const roundHalfUp = (x) => Math.floor(x + 0.5);
function expSplit(amount, inv) { const amt = roundHalfUp(amount); if (!inv) return { net: amt, tax: 0 }; const net = roundHalfUp(amt / 1.05); return { net, tax: amt - net }; }

// ---------- 1. splitTax：整數、字串、.5 邊界、負數、空值 ----------
{
  let bad = [];
  for (let i = 0; i < 400; i++) {
    const amt = pick([ri(0, 100000), 21 * ri(1, 3000) + pick([-1, 0, 1]), ri(0, 999) + 0.5, String(ri(1, 99999)), '', null, undefined, 'abc']);
    const inv = rand() < 0.5;
    const got = M.splitTax(amt, inv);
    const n = Number(amt); const base = Number.isFinite(n) ? n : 0;
    const want = expSplit(base, inv);
    if (!eq(got, want) || got.net + got.tax !== roundHalfUp(base)) bad.push({ amt, inv, got, want });
  }
  ok(bad.length === 0, '1a: splitTax 400 組（含 .5 邊界、字串、空值）＝規格算法且 未稅＋稅額＝金額', bad.slice(0, 3));
  ok(eq(M.splitTax(100.5, false), { net: 101, tax: 0 }) && eq(M.splitTax(100.5, true), { net: 96, tax: 5 }), '1b: 100.5 進位成 101（JS Math.round），有發票 96＋5');
  ok(eq(M.splitTax(-105, true), { net: -100, tax: -5 }), '1c: 負數金額也成立（-105 → -100／-5）');
}

// ---------- 2. 隨機帳列 → summarize／buildExportRows／buildMatrix ----------
function makeRows(n) {
  const rows = [];
  const seqs = { 支出: 0, 收入: 0 };
  for (let i = 0; i < n; i++) {
    const kind = rand() < 0.3 ? '收入' : '支出';
    const amount = pick([ri(1, 500), ri(500, 5000), ri(5000, 80000)]);
    const inv = rand() < 0.5;
    const { net, tax } = expSplit(amount, inv);
    seqs[kind] += 1;
    rows.push({ id: 'R' + i, store: pick(['新竹光復', '台中美村']), date: '2026-' + String(ri(1, 12)).padStart(2, '0') + '-' + String(ri(1, 28)).padStart(2, '0'),
      kind, subject: pick(['食材', '雜支', '其他收入']), name: '品項' + ri(1, 99), amount, hasInvoice: inv, net, tax, seq: seqs[kind],
      photo: rand() < 0.5 ? 'https://x.test/' + i : '', author: pick(['店長', '阿明']), createdAt: '2026-01-01 09:0' + ri(0, 9) + ':00',
      status: rand() < 0.25 ? '作廢' : '正常' });
  }
  return shuffle(rows);
}
for (let round = 0; round < 5; round++) {
  const rows = makeRows(ri(0, 40));
  const live = rows.filter((r) => r.status !== '作廢');
  const expS = { expense: live.filter((r) => r.kind === '支出').reduce((s, r) => s + r.amount, 0), income: live.filter((r) => r.kind === '收入').reduce((s, r) => s + r.amount, 0) };
  expS.net = expS.income - expS.expense; expS.count = live.length;
  ok(eq(M.summarize(rows), expS), `2a[${round}]: summarize ${rows.length} 筆（${live.length} 未作廢）＝獨立合計 ${JSON.stringify(expS)}`, M.summarize(rows));
  const sorted = live.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.kind !== b.kind ? (a.kind === '支出' ? -1 : 1) : a.seq - b.seq));
  const expRows = sorted.map((r) => [r.store, r.date, r.kind, r.subject, r.name, r.net, r.tax, r.amount, r.hasInvoice ? '有' : '無', r.seq, r.photo, r.author, r.createdAt]);
  ok(eq(M.buildExportRows(rows), expRows), `2b[${round}]: buildExportRows 逐筆逐欄＝依(日期, 支出先, 編號)排序的未作廢列`, { got: M.buildExportRows(rows).slice(0, 2), want: expRows.slice(0, 2) });
  const mx = M.buildMatrix(rows);
  const expMx = [M.EXPORT_HEADERS].concat(expRows, [[], ['支出合計', '', '', '', '', '', '', expS.expense], ['收入合計', '', '', '', '', '', '', expS.income], ['淨額', '', '', '', '', '', '', expS.net]]);
  ok(eq(mx, expMx), `2c[${round}]: buildMatrix＝表頭＋資料＋空列＋三列合計（${mx.length} 列）`);
  ok(mx.slice(1, 1 + expRows.length).every((r) => [5, 6, 7, 9].every((c) => typeof r[c] === 'number')), `2d[${round}]: 金額三欄與收據編號是數字型別`);
}
ok(eq(M.EXPORT_HEADERS, ['店別', '日期', '收支別', '科目', '項目名稱', '未稅價', '稅額', '金額', '發票', '收據編號', '收據照片', '填表人', '登記時間']), '2e: 表頭十三欄與現金帳 calc.js 相同');
ok(M.fileName('新竹光復', '2026-09') === '現金收支_新竹光復_2026-09.xlsx' && M.fileName('', '2026-09') === '現金收支__2026-09.xlsx', '2f: 檔名 現金收支_<店>_<月>.xlsx');
ok(eq(M.MONEY_COLS, [5, 6, 7]) && eq(M.COL_WIDTHS, [10, 12, 8, 14, 22, 10, 8, 10, 6, 10, 28, 10, 20]) && M.SHEET_NAME === '明細', '2g: 千分位欄、欄寬、工作表名與現金帳 export.js 相同');

// ---------- 3. 真的用 vendor SheetJS 產 xlsx → 讀回每一格 ----------
{
  const sb = { console }; sb.self = sb; sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'modules/cashbook/vendor/xlsx.mini.min.js'), 'utf8'), sb);
  const XLSX = sb.XLSX;
  ok(!!XLSX && typeof XLSX.write === 'function', '3a: vendor xlsx.mini 載得起來');
  const rows = makeRows(ri(5, 30));
  const bytes = M.toXlsxBytes(XLSX, rows);
  const wb = XLSX.read(bytes, { type: 'array' });
  ok(eq(wb.SheetNames, ['明細']), '3b: 工作表只有「明細」', wb.SheetNames);
  const ws = wb.Sheets['明細'];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const want = M.buildMatrix(rows).map((r) => r.slice());
  // 讀回時尾端空字串會被省掉、空列變 []；比對前兩邊都把尾端 '' 去掉
  const trim = (r) => { const a = r.slice(); while (a.length && a[a.length - 1] === '') a.pop(); return a; };
  const got = aoa.map(trim); while (got.length < want.length) got.push([]);
  const wantT = want.map(trim);
  const diff = wantT.map((r, i) => (eq(r, got[i]) ? null : { row: i + 1, want: r, got: got[i] })).filter(Boolean);
  ok(diff.length === 0 && got.length === wantT.length, `3c: xlsx 讀回 ${wantT.length} 列逐格＝矩陣（含數字型別）`, diff.slice(0, 2));
  // mini 版 SheetJS 讀回不保留格式，所以格式與欄寬看寫入前的 workbook 物件
  const ws0 = M.toWorkbook(XLSX, want).Sheets['明細'];
  const moneyCells = [], otherCells = [];
  for (let r = 1; r < want.length; r++) for (let c = 0; c < 13; c++) { const cell = ws0[XLSX.utils.encode_cell({ r, c })]; if (!cell || typeof cell.v !== 'number') continue; ([5, 6, 7].includes(c) ? moneyCells : otherCells).push(cell.z); }
  ok(moneyCells.length > 0 && moneyCells.every((z) => z === '#,##0'), '3d: 未稅／稅額／金額數字格全部套 #,##0', moneyCells.filter((z) => z !== '#,##0'));
  ok(otherCells.every((z) => z === undefined), '3d2: 收據編號欄不套千分位');
  ok(eq(ws0['!cols'].map((c) => c.wch), M.COL_WIDTHS), '3e: 欄寬寫進 workbook');
}

// ---------- 4. util.js 日期閘門（台北時間）：隨機 UTC 時刻 ----------
{
  let bad = [];
  for (let i = 0; i < 300; i++) {
    const t = Date.UTC(ri(2024, 2028), ri(0, 11), ri(1, 28), ri(0, 23), ri(0, 59));
    const now = new Date(t);
    const tp = new Date(t + 8 * 3600 * 1000);
    const y = tp.getUTCFullYear(), m = tp.getUTCMonth() + 1, d = tp.getUTCDate();
    const ymk = (yy, mm) => yy + '-' + String(mm).padStart(2, '0');
    const last = m === 1 ? ymk(y - 1, 12) : ymk(y, m - 1);
    const cur = ymk(y, m);
    const expDef = d <= 10 ? last : cur;
    const expAlert = d <= 10 ? last : null;
    const expOpts = []; { let yy = y, mm = m; for (let k = 0; k < 13; k++) { expOpts.push(ymk(yy, mm)); mm--; if (mm === 0) { mm = 12; yy--; } } }
    if (!eq(U.taipeiParts(now), { y, m, d }) || U.lastMonthOf(now) !== last || U.currentMonthOf(now) !== cur || U.defaultMonth(now) !== expDef || U.alertMonth(now) !== expAlert || !eq(U.monthOptions(now, 13), expOpts)) {
      bad.push({ now: now.toISOString(), got: [U.defaultMonth(now), U.alertMonth(now)], want: [expDef, expAlert] });
    }
  }
  ok(bad.length === 0, '4a: 300 個隨機時刻：台北年月日／上月／當月／預設月（1–10 日上月）／提醒月／月份選單 全對', bad.slice(0, 3));
  // 跨日邊界：UTC 15:59 vs 16:00 ＝ 台北 23:59 vs 次日 00:00
  ok(U.defaultMonth(new Date('2026-10-10T15:59:00Z')) === '2026-09' && U.defaultMonth(new Date('2026-10-10T16:00:00Z')) === '2026-10', '4b: 10 日台北 23:59 → 上月；11 日 00:00 → 當月（不吃瀏覽器時區）');
  ok(U.monthNum('2026-09') === '9' && U.monthNum('2026-12') === '12' && U.monthNum('bad') === 'bad', '4c: monthNum 去前導零');
}

// ---------- 5. 鎖定判斷與首頁提醒名單 ----------
{
  const kinds = [[{ status: '鎖定', lockedVia: 'acct' }, 'acct', '會計鎖定'], [{ status: '鎖定', lockedVia: 'store' }, 'store', '店長鎖定'], [{ status: '鎖定' }, 'unknown', '已鎖定'],
    [{ status: '鎖定', lockedVia: '' }, 'unknown', '已鎖定'], [{ status: '解鎖', lockedVia: 'acct' }, 'none', '未鎖'], [null, 'none', '未鎖'], [undefined, 'none', '未鎖']];
  ok(kinds.every(([rec, k, label]) => U.lockKind(rec) === k && U.lockLabel(rec) === label && U.isLocked(rec) === (k !== 'none')), '5a: lockKind／lockLabel／isLocked 七種紀錄');
  let bad = [];
  for (let i = 0; i < 200; i++) {
    const month = '2026-' + String(ri(1, 12)).padStart(2, '0');
    const stores = Array.from({ length: ri(0, 6) }, (_, k) => ({ code: 's' + k, name: '店' + k }));
    const locksByStore = {}, liveByStore = {}, want = [];
    for (const s of stores) {
      const via = pick(['acct', 'store', 'old', 'none', 'acct-other-month']);
      locksByStore[s.code] = via === 'none' ? [] : via === 'acct-other-month' ? [{ month: '2020-01', status: '鎖定', lockedVia: 'acct' }] : [{ month, status: '鎖定', lockedVia: via === 'old' ? undefined : via }];
      if (rand() < 0.3) locksByStore[s.code].push({ month, status: '解鎖', lockedVia: 'acct' });   // 解鎖紀錄不算鎖
      const live = pick([true, false, undefined]);
      if (live !== undefined) liveByStore[s.code] = live;
      if (via !== 'acct' && live !== false) want.push(s);
    }
    const got = U.storesToAlert(stores, locksByStore, month, liveByStore);
    if (!eq(got, want)) bad.push({ stores, locksByStore, liveByStore, got, want });
  }
  ok(bad.length === 0, '5b: storesToAlert 200 組：只列「該月不是會計鎖、且不是明確沒帳」的店；店長鎖／舊資料鎖／別月的會計鎖都要提醒', bad.slice(0, 1));
  ok(eq(U.storesToAlert(null, null, '2026-09', null), []) && U.needsAcctLock(undefined, '2026-09') === true, '5c: 空輸入不炸');
}

// ---------- 6. 科目文字 → 清單 → 檢查 ----------
{
  let bad = [];
  for (let i = 0; i < 100; i++) {
    const items = Array.from({ length: ri(0, 8) }, () => pick(['食材', '雜支', '人事', '水電', ' 瓦斯 ', '', '  ', '甲'.repeat(ri(28, 33))]));
    const text = items.join(pick(['\n', '\r\n']));
    const want = []; items.forEach((x) => { const t = x.trim(); if (t && !want.includes(t)) want.push(t); });
    const got = U.parseSubjects(text);
    const v = U.validateSubjects(got, 'X');
    const wantV = want.length < 1 ? 'X至少要有 1 個科目' : want.length > 100 ? 'X最多 100 個科目（現在 ' + want.length + ' 個）' : (want.find((s) => s.length > 30) ? 'X「' + want.find((s) => s.length > 30).slice(0, 12) + '…」超過 30 字' : null);
    if (!eq(got, want) || v !== wantV) bad.push({ text, got, want, v, wantV });
  }
  ok(bad.length === 0, '6a: parseSubjects（去空白、去空行、去重、保序）＋validateSubjects（1–100 個、30 字）100 組', bad.slice(0, 2));
  ok(U.validateSubjects(Array.from({ length: 101 }, (_, i) => 'k' + i), '支出科目') === '支出科目最多 100 個科目（現在 101 個）' && U.validateSubjects(Array.from({ length: 100 }, (_, i) => 'k' + i), '支出科目') === null, '6b: 100 個合格、101 個不合格');
  ok(U.safeUrl('https://a.test/x.jpg') === 'https://a.test/x.jpg' && U.safeUrl('javascript:alert(1)') === '' && U.safeUrl(' HTTP://b/x ') === 'HTTP://b/x' && U.safeUrl(null) === '', '6c: safeUrl 只放 http(s)');
  ok(U.errText({ error: 'LOCKED' }) === '這個月已經月結鎖定，不能這樣改' && U.errText({ error: 'LOCKED_BY_ACCT' }) === '這個月是會計鎖的' && U.errText(null) === '沒有成功，請再試一次' && U.errText({ error: 'ZZZ' }) === 'ZZZ', '6d: errText 錯誤碼翻中文');
}

// ---------- 7. 白名單一致：dryrun.js ＝ Auth.gs ＝ bridge ----------
{
  const auth = fs.readFileSync(path.join(ROOT, 'apps-script/platform/Auth.gs'), 'utf8');
  const grab = (name) => { const m = new RegExp('var ' + name + ' = \\{([\\s\\S]*?)\\n\\};').exec(auth); const sb = {}; vm.createContext(sb); return vm.runInContext('({' + m[1] + '})', sb); };
  const R_ = grab('PROXY_READ_ACTIONS'), W_ = grab('PROXY_WRITE_ACTIONS');
  for (const ns of ['cashbook', 'pnl', 'transfer']) {
    ok(eq(DR.READ_ACTIONS[ns], R_[ns]) && eq(DR.WRITE_ACTIONS[ns], W_[ns]), `7a: ${ns} 讀寫白名單 dryrun.js ＝ Auth.gs`, { front: [DR.READ_ACTIONS[ns], DR.WRITE_ACTIONS[ns]], back: [R_[ns], W_[ns]] });
    ok(DR.READ_ACTIONS[ns].every((a) => !DR.WRITE_ACTIONS[ns].includes(a)), `7b: ${ns} 讀寫清單沒有重疊`);
  }
  ok(eq(PB.PNL_ACTIONS, DR.READ_ACTIONS.pnl.concat(DR.WRITE_ACTIONS.pnl)), '7c: pnl bridge 白名單＝讀＋寫');
  const adminActs = /var PROXY_PNL_ADMIN_ACTIONS = (\[[^\]]*\]);/.exec(auth)[1];
  ok(JSON.parse(adminActs.replace(/'/g, '"')).every((a) => DR.WRITE_ACTIONS.pnl.includes(a)), '7d: 損益「管」級動作都在寫入清單內');
  // ssoTicket 刻意在前端試跑白名單（試跑也要能自動登入嵌入系統，dryrun.js 註解）；PurchaseSso.gs 檔頭說的「不可列入」指 minikit readActions 與 svc* 服務動作
  ok(!DR.READ_ACTIONS.platform.some((a) => /^svc/.test(a)) && DR.READ_ACTIONS.platform.includes('ssoTicket'), '7e: svc* 服務動作不在試跑讀取白名單；ssoTicket 在（試跑也能換券）');
  ok(eq(TB.TRANSFER_PAGES.map((x) => x[0]), ['report', 'memory', 'overview']) && eq(PB.PNL_PAGES.map((x) => x[0]), ['dashboard', 'pending', 'food', 'labor', 'controllable', 'uncontrollable', 'revenue', 'import', 'settings']), '7f: 分頁對照表');
}

// ---------- 8. transfer bridge：parseCall 刪敏感欄位、toPageResult 還原 ----------
{
  let bad = [];
  const SENS = ['pin_master', 'token', 'operator', 'action'];
  for (let i = 0; i < 200; i++) {
    const good = rand() < 0.6;
    const id = good ? 'c' + ri(1, 1e6) : pick(['', 'a'.repeat(41), 'bad id', 123, null]);
    const action = good ? pick(['bootstrap', 'adminData', 'adminUpdate', 'buildMonthlyReport', 'x_y9']) : pick(['', '9abc', 'a'.repeat(42), 'with space', 'ab-cd', null]);
    const payload = pick([{ ym: '2026-09', op: 'memoryEdit', pin_master: 'P', token: 'T', operator: 'O', action: 'evil', nested: { pin_master: 'keep' } }, {}, undefined, null, [1], 'str']);
    const msg = { type: good && rand() < 0.95 ? 'dzy-transfer-call' : 'other', v: rand() < 0.95 ? 1 : 2, id, action, payload };
    const got = TB.parseCall(msg);
    const valid = msg.type === 'dzy-transfer-call' && msg.v === 1 && typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id) && typeof action === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(action) && (payload === undefined || payload === null || (typeof payload === 'object' && !Array.isArray(payload)));
    if (!valid) { if (got !== null) bad.push({ msg, got }); continue; }
    const wantP = Object.assign({}, payload || {}); SENS.forEach((k) => delete wantP[k]);
    if (!got || got.id !== id || got.action !== action || !eq(got.payload, wantP) || SENS.some((k) => k in got.payload)) bad.push({ msg, got });
  }
  ok(bad.length === 0, '8a: transfer parseCall 200 組：形狀不對回 null；合格時刪 pin_master／token／operator／action（巢狀不動）', bad.slice(0, 2));
  ok(eq(TB.toPageResult({ ok: true, dryrun: true, data: { dryRun: true } }), { ok: false, error: '試跑模式，未寫入', code: 'DRYRUN' }), '8b: 試跑攔下 → DRYRUN 失敗（畫面不會當成功）');
  ok(eq(TB.toPageResult({ ok: true, data: { data: { a: 1 } } }), { ok: true, data: { a: 1 } }) && eq(TB.toPageResult({ ok: true, data: {} }), { ok: true, data: null }), '8c: 成功還原 data.data');
  ok(eq(TB.toPageResult({ ok: false, error: '沒有權限', status: 403 }), { ok: false, error: '沒有權限' }) && eq(TB.toPageResult({ ok: false, error: 'OP_FORBIDDEN', data: { code: 'OP_FORBIDDEN' } }), { ok: false, error: 'OP_FORBIDDEN', code: 'OP_FORBIDDEN' }) && eq(TB.toPageResult(null), { ok: false, error: '伺服器回應格式錯誤' }), '8d: 失敗帶 code／無 code／非物件');
  ok(eq(TB.navMessage('memory'), { type: 'dzy-transfer-nav', v: 1, p: 'memory' }) && TB.navMessage('zzz').p === 'report' && TB.navMessage(undefined).p === 'report', '8e: navMessage 不認得回月報');
  ok(TB.transferTarget('localhost').url === 'http://localhost:8787/report.html?embed=dzy' && TB.transferTarget('dzy.mozhuting.com').url === 'https://eason0728.github.io/mala-transfer/report.html?embed=dzy' && TB.transferTarget('evil.localhost').origin === 'https://eason0728.github.io', '8f: transferTarget 只有 localhost／127.0.0.1 走本機');
}

// ---------- 9. pnl bridge ----------
{
  let bad = [];
  const SENS = ['action', 'token', 'key', 'operator', 'level', 'inner'];
  for (let i = 0; i < 200; i++) {
    const good = rand() < 0.6;
    const id = good ? 'p' + ri(1, 1e6) : pick(['', 'a'.repeat(41), 'bad id', 7]);
    const action = good ? pick(PB.PNL_ACTIONS) : pick(['login', 'registerWithInvite', 'createInvite', 'dzyProxy', '', null]);
    const body = pick([{ store_id: 'gf', month: '2026-09', key: 'K', token: 'T', operator: 'O', level: 'admin', inner: 'finalize', action: 'finalize' }, {}, undefined, [1], 'x']);
    const msg = { type: good ? 'dzy-pnl-call' : pick(['dzy-pnl-call', 'dzy-pnl-at']), v: 1, id, action, body };
    const got = PB.parseCall(msg);
    const valid = msg.type === 'dzy-pnl-call' && typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id) && PB.PNL_ACTIONS.includes(action) && (body === undefined || (typeof body === 'object' && !Array.isArray(body)));
    if (!valid) { if (got !== null) bad.push({ msg, got }); continue; }
    const wantP = Object.assign({}, body || {}); SENS.forEach((k) => delete wantP[k]);
    if (!got || !eq(got.payload, wantP) || got.action !== action) bad.push({ msg, got });
  }
  ok(bad.length === 0, '9a: pnl parseCall 200 組：白名單外（login／createInvite／dzyProxy…）回 null；刪 key／token／operator／level／inner／action', bad.slice(0, 2));
  ok(eq(PB.toPageResult({ ok: true, dryrun: true, data: { dryRun: true } }), { ok: false, error: 'BAD_INPUT', message: '試跑模式，未寫入' }), '9b: 試跑 → BAD_INPUT');
  ok(eq(PB.toPageResult({ ok: false, error: '登入已失效，請重新登入', status: 401 }), { ok: false, error: 'AUTH', message: '登入已失效，請重新登入' }) && PB.toPageResult({ ok: false, error: '沒有權限', status: 403 }).error === 'BUSY', '9c: 代轉 401 → AUTH、其他狀態 → BUSY');
  ok(eq(PB.toPageResult({ ok: false, error: 'FORBIDDEN', data: { message: '不能定稿' } }), { ok: false, error: 'FORBIDDEN', message: '不能定稿' }) && PB.toPageResult({ ok: false, error: '請求失敗 中文' }).error === 'BUSY', '9d: 損益錯誤碼原樣、非碼 → BUSY');
  ok(PB.atPage({ type: 'dzy-pnl-at', v: 1, p: 'food' }) === 'food' && PB.atPage({ type: 'dzy-pnl-at', v: 1, p: 'login' }) === null && PB.atPage({ type: 'dzy-pnl-at', v: 2, p: 'food' }) === null, '9e: atPage 只收九個分頁');
  let bad2 = [];
  for (let i = 0; i < 100; i++) {
    const t = Date.UTC(ri(2024, 2028), ri(0, 11), ri(1, 28), ri(0, 23), ri(0, 59));
    const tp = new Date(t + 8 * 3600 * 1000); const want = tp.getUTCFullYear() + '-' + String(tp.getUTCMonth() + 1).padStart(2, '0');
    if (PB.currentMonth(t) !== want) bad2.push({ t, got: PB.currentMonth(t), want });
    const rows = Array.from({ length: ri(0, 5) }, (_, k) => ({ store_id: 's' + k, name: rand() < 0.8 ? '店' + k : undefined, count: pick([0, 1, ri(2, 9), '3', -1, null]) }));
    const wantA = rows.filter((x) => typeof x.count === 'number' && x.count > 0).map((x) => ({ level: 'warn', text: `${x.name} ${Number(want.slice(5, 7))} 月損益還有 ${x.count} 項待補`, view: 'pending', params: { store: x.store_id } }));
    if (!eq(PB.buildAlerts(rows, want), wantA)) bad2.push({ rows, got: PB.buildAlerts(rows, want), wantA });
  }
  ok(bad2.length === 0, '9f: currentMonth（台北）＋buildAlerts（只列 count>0 的數字；文字「店 N 月損益還有 K 項待補」）100 組', bad2.slice(0, 2));
  ok(PB.buildAlerts([{ store_id: 'gf', count: 2 }], '2026-09')[0].text === 'undefined 9 月損益還有 2 項待補', '9g: （觀察）rows 缺 name 時 buildAlerts 文字會出現 undefined——index.js 有補 name||store_id，bridge 本身沒守');
}

// ---------- 10. purchase：navTabs／wantedTab／countAlerts／parseCounts ----------
{
  let bad = [];
  for (let i = 0; i < 200; i++) {
    const n = ri(0, 22);
    const items = Array.from({ length: n }, (_, k) => pick([{ id: 'tab' + k, label: '分頁' + k, badge: pick([0, 3, '7', -1, 'x']) }, { id: 'Bad Id', label: 'x' }, { id: 'ok' + k, label: 5 }, null, { id: 'e' + k, label: 'E', err: true }]));
    const cur = pick([items.find((x) => x && typeof x.id === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(x.id) && typeof x.label === 'string')?.id, 'nope', 5, undefined]);
    const d = { type: rand() < 0.9 ? 'dzy-purchase-nav' : 'dzy-purchase-go', v: rand() < 0.9 ? 1 : 0, items, cur };
    const got = PE.navTabs(d);
    const valid = d.type === 'dzy-purchase-nav' && d.v === 1 && items.length <= 20;
    if (!valid) { if (got !== null) bad.push({ d, got }); continue; }
    const tabs = items.filter((x) => x && typeof x.id === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(x.id) && typeof x.label === 'string').map((x) => ({ id: x.id, name: x.label, badge: Number(x.badge) || 0, err: x.err === true }));
    const wantCur = typeof cur === 'string' && tabs.some((t) => t.id === cur) ? cur : '';
    if (!eq(got, { tabs, cur: wantCur })) bad.push({ d, got, want: { tabs, cur: wantCur } });
    const ctx = { viewId: pick([tabs[0]?.id, 'main', 'zzz', undefined]), params: { tab: pick([tabs[tabs.length - 1]?.id, 'nope', 3]) } };
    const ids = tabs.map((t) => t.id);
    const wantW = ids.includes(ctx.viewId) ? ctx.viewId : (typeof ctx.params.tab === 'string' && ids.includes(ctx.params.tab) ? ctx.params.tab : '');
    if (PE.wantedTab(ctx, tabs) !== wantW) bad.push({ ctx, got: PE.wantedTab(ctx, tabs), wantW });
  }
  ok(bad.length === 0, '10a: navTabs（>20 個整包丟、壞 id 單筆丟、badge 轉數字、cur 要在清單內）＋wantedTab（網址優先、其次 ?tab=）200 組', bad.slice(0, 2));
  ok(PE.navTabs({ type: 'dzy-purchase-nav', v: 1, items: [{ id: 'review', label: '待核對', badge: -5 }], cur: 'review' }).tabs[0].badge === -5, '10b: （觀察）navTabs 不擋負數 badge（殼的 sanitizeTabs 會歸 0，但 badge 顯示交給殼）');
  let bad2 = [];
  for (let i = 0; i < 100; i++) {
    const review = pick([0, ri(1, 50), -1, 2.5, '3', null]), failed = pick([0, ri(1, 50), -2, NaN, undefined]);
    const j = pick([{ ok: true, data: { review, failed } }, { ok: false, data: { review, failed } }, null, { ok: true }]);
    const good = j && j.ok === true && j.data && Number.isSafeInteger(review) && review >= 0 && Number.isSafeInteger(failed) && failed >= 0;
    const got = PC.parseCounts(j);
    if (!eq(got, good ? { review, failed } : null)) bad2.push({ j, got });
    if (good) {
      const want = [];
      if (review > 0) want.push({ level: 'warn', text: `貨單待核對 ${review} 張`, view: 'main', params: { tab: 'review' } });
      if (failed > 0) want.push({ level: 'error', text: `貨單辨識失敗 ${failed} 張`, view: 'main', params: { tab: 'failed' } });
      if (!eq(PC.countAlerts(got), want)) bad2.push({ got, alerts: PC.countAlerts(got), want });
    }
  }
  ok(bad2.length === 0, '10c: parseCounts（只收非負整數）＋countAlerts（0 不列、待核對 warn、辨識失敗 error）100 組', bad2.slice(0, 2));
  ok(PC.purchaseApi('localhost') === 'http://localhost:8794/purchase/api' && PC.purchaseApi('dzy.mozhuting.com').startsWith('https://') && PE.purchaseOrigin('127.0.0.1') === 'http://localhost:8795', '10d: 貨單後端／網頁位址只在 localhost／127.0.0.1 走本機');
  ok(PE.DRYRUN_EMBED_WARN.includes('試跑模式') && PE.DRYRUN_EMBED_WARN.includes('真的寫入'), '10e: 試跑模式嵌入警語');
}

console.log(`\n共 ${passed + failed} 項，通過 ${passed}，失敗 ${failed}（E2E_SEED=${SEED}）`);
process.exit(failed ? 1 : 0);
