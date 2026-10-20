// node test/approvals-front.test.mjs —— 第三期表單簽核前端的單元檢查（docs/approvals/task.md P3）
// manifest、CSV 中和、草稿 key、照片壓縮的大小分支（假 canvas）、各分頁依 form.can 顯示按鈕、金額、核決權限 diff、首頁提醒。全部假資料。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class MemoryStorage {
  constructor() { this._m = new Map(); }
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }
  setItem(k, v) { this._m.set(k, String(v)); }
  removeItem(k) { this._m.delete(k); }
}
globalThis.localStorage = new MemoryStorage();

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validateManifest } = await import('../platform/manifest-check.js');
const manifest = (await import('../modules/approvals/manifest.js')).default;
const lib = await import('../modules/approvals/lib.js');
const cards = await import('../modules/approvals/cards.js');
const photo = await import('../modules/approvals/photo.js');
const { apvCalcAmount } = await import('../modules/approvals-shared/amount.js');
const approvalsIndex = (await import('../modules/approvals/index.js')).default;
const { esc, datetime } = await import('../platform/fmt.js');

let passed = 0, failed = 0;
const ok = (c, l, extra) => { if (c) { passed++; console.log('PASS: ' + l); } else { failed++; console.error('FAIL: ' + l + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); } };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), l, { got: a, want: b });
const fmt = { datetime, esc };

// ── 1. manifest ──────────────────────────────────────
{
  const r = validateManifest(manifest);
  ok(r.ok, 'manifest 驗證通過', r.errors);
  ok(manifest.id === 'approvals' && manifest.ns === 'platform' && manifest.backend === manifest.ns, 'id=approvals，ns＝backend＝platform');
  ok(manifest.dept === undefined, '不填 dept');
  eq(manifest.views.map((v) => v.id), ['submit', 'mine', 'sign', 'handle', 'all', 'thr'], '六個分頁、順序：送單／我的單／待我簽／待我辦／全部單據／核決權限');
  eq(manifest.views.map((v) => v.name), ['送單', '我的單', '待我簽', '待我辦', '全部單據', '核決權限'], '分頁中文名');
  const thr = manifest.views.find((v) => v.id === 'thr');
  ok(thr.requires.length === 1 && thr.requires[0] === 'platform.permex', '核決權限只給 platform.permex（只有 admin 的 * 符合）');
  ok(manifest.views.filter((v) => v.id !== 'thr').every((v) => v.requires.includes('platform.login')), '其餘分頁人人看得到');
  ok(fs.existsSync(path.join(ROOT, 'assets/icons', manifest.icon + '.png')), '選單圖示檔存在');
  const reg = fs.readFileSync(path.join(ROOT, 'platform/registry.js'), 'utf8');
  ok(reg.includes("modules/approvals/manifest.js"), 'registry 接上');
  for (const f of ['index.js', 'lib.js', 'cards.js', 'actions.js', 'widgets.js', 'list-view.js', 'views/submit.js', 'views/thr.js', 'views/all.js', 'views/mine.js', 'views/sign.js', 'views/handle.js']) {
    ok(!/from '\.\.\/(\.\.\/)?platform\//.test(fs.readFileSync(path.join(ROOT, 'modules/approvals', f), 'utf8')), `${f} 沒有 import platform/`);
  }
}

// ── 2. CSV 中和與 BOM ─────────────────────────────────
{
  for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
    const c = lib.csvCell(lead + 'cmd');
    ok(c.replace(/^"/, '').startsWith("'" + lead), `以 ${JSON.stringify(lead)} 開頭的格前面加 '`, c);
  }
  eq(lib.csvCell('一般文字'), '一般文字', '一般文字不動');
  eq(lib.csvCell('a,b'), '"a,b"', '含逗號加引號');
  eq(lib.csvCell('say "hi"'), '"say ""hi"""', '引號跳脫');
  eq(lib.csvCell(8600), '8600', '數字不加 \'');
  eq(lib.csvCell(null), '', 'null → 空');
  const csv = lib.toCsv([{ id: 'APV-261018-001', rev: 1, type: 'expense', unit_name: '測試店', sender_name: '=HYPERLINK("x")', amount: 8600, category: 'repair', vendor: '+廠商', desc: '換零件', created_at: 1, approved_at: 2, done_at: 3, handle_note: '-' }], () => 'T');
  ok(csv.charCodeAt(0) === 0xFEFF, 'CSV 開頭是 UTF-8 BOM');
  ok(csv.includes('"\'=HYPERLINK(""x"")"') && csv.includes(",'+廠商,") && csv.includes('請款') && csv.includes('設備維修'), 'CSV 內容：公式被中和、代碼轉中文', csv);
  ok(csv.split('\r\n').length === 2, '一列標題＋一列資料');
}

// ── 3. 草稿 key ───────────────────────────────────────
{
  const st = new MemoryStorage();
  eq(lib.draftKey('u001', 'purchase'), 'dzy.u.u001.apv_draft_purchase', '草稿 key 格式');
  ok(lib.saveDraft(st, 'u001', 'purchase', { purpose: 'x' }) && st.getItem('dzy.u.u001.apv_draft_purchase'), '請購存草稿');
  ok(lib.saveDraft(st, 'u001', 'expense', { desc: 'y' }), '請款存草稿');
  ok(lib.saveDraft(st, 'u001', 'personnel', { reason: '薪資' }) === false && st.getItem('dzy.u.u001.apv_draft_personnel') === null, '人事單不存草稿');
  eq(lib.loadDraft(st, 'u001', 'purchase'), { purpose: 'x' }, '讀回草稿');
  eq(lib.loadDraft(st, 'u002', 'purchase'), null, '別人讀不到（key 帶本人 id）');
  eq(lib.loadDraft(st, 'u001', 'personnel'), null, '人事單讀草稿一律 null');
  lib.clearDraft(st, 'u001', 'purchase');
  eq(lib.loadDraft(st, 'u001', 'purchase'), null, '清掉草稿');
  st.setItem('dzy.u.u001.apv_draft_expense', '{壞掉');
  eq(lib.loadDraft(st, 'u001', 'expense'), null, '壞掉的 JSON 不拋錯');
}

// ── 4. 照片壓縮：大小分支（假 canvas）──────────────────
{
  eq(photo.fitSize(4000, 3000), { w: 1600, h: 1200 }, '長邊 4000 → 1600，等比');
  eq(photo.fitSize(3000, 4000), { w: 1200, h: 1600 }, '直式照片');
  eq(photo.fitSize(800, 600), { w: 800, h: 600 }, '小圖不放大');
  // 假 canvas：檔案大小＝像素 × 品質 × 係數，可控制各分支
  const makeCreate = (coef, log) => (w, h) => ({ getContext: () => ({ drawImage() {} }), toBlob(cb, type, q) { log.push({ w, h, q, type }); cb({ size: Math.round(w * h * q * coef) }); } });
  {
    const log = [];
    const r = await photo.compressToLimit(4000, 3000, photo.canvasRenderer(makeCreate(0.01, log), {}));
    ok(r.ok && r.quality === 0.85 && r.w === 1600 && r.h === 1200 && r.tries === 1 && log[0].type === 'image/jpeg', '本來就小：第一次（0.85）就過，輸出 JPEG、長邊 1600', { r, log });
  }
  {
    const log = [];
    const r = await photo.compressToLimit(4000, 3000, photo.canvasRenderer(makeCreate(0.12, log), {}));
    ok(r.ok && r.quality < 0.85 && r.blob.size <= photo.MAX_BYTES && r.tries > 1 && r.w === 1600, '超過 180KB：逐步降畫質後通過', { q: r.quality, tries: r.tries, size: r.blob && r.blob.size });
    ok(log.every((x, i) => i === 0 || x.q <= log[i - 1].q), '畫質是遞減嘗試', log.map((x) => x.q));
  }
  {
    const log = [];
    const r = await photo.compressToLimit(4000, 3000, photo.canvasRenderer(makeCreate(0.5, log), {}));
    ok(r.ok && r.w < 1600 && r.blob.size <= photo.MAX_BYTES, '降到最低畫質還太大：改縮小尺寸再試', { w: r.w, q: r.quality });
  }
  {
    const log = [];
    const r = await photo.compressToLimit(4000, 3000, photo.canvasRenderer(makeCreate(50, log), {}));
    ok(r.ok === false && r.error === 'too_large', '怎麼縮都超過：回失敗不卡死', r);
  }
  ok(photo.MAX_PHOTOS === 5 && photo.MAX_EDGE === 1600 && photo.MAX_BYTES === 180 * 1024, '常數：5 張、1600px、180KB');
  eq(photo.putUrl(), 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net/platform/svc/apv-file-put', '上傳網址由 BACKENDS.platform 推');
  eq(photo.getUrl(), 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net/platform/svc/apv-file-get', '讀圖網址');
  // 上傳：body 形狀照 api.md（token/kind/mime/b64），錯誤碼原樣回
  const seen = [];
  const fakeFetch = (resp) => async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return { json: async () => resp }; };
  const up = await photo.uploadB64('receipt', 'image/jpeg', 'QUJD', fakeFetch({ ok: true, data: { id: 'F1', bytes: 3 } }));
  ok(up.ok && up.id === 'F1' && seen[0].url.endsWith('/platform/svc/apv-file-put') && seen[0].body.kind === 'receipt' && seen[0].body.mime === 'image/jpeg' && seen[0].body.b64 === 'QUJD' && 'token' in seen[0].body, '上傳 body 形狀', seen);
  const bad = await photo.uploadB64('receipt', 'image/jpeg', 'QUJD', fakeFetch({ ok: false, error: 'quota' }));
  ok(bad.ok === false && bad.error === 'quota', '上傳錯誤碼原樣回（quota）');
  const g = await photo.fetchPhoto('F9', fakeFetch({ ok: true, data: { mime: 'image/jpeg', b64: 'QUJD' } }));
  ok(g === 'data:image/jpeg;base64,QUJD', '讀圖組成 data URL');
}

// ── 5. 金額（呼叫 approvals-shared/amount.js，只驗呼叫結果）────
{
  ok(apvCalcAmount('purchase', { items: [{ qty: 1.5, price: 333 }] }).amount === 500, 'qty 1.5 × 333 → 500（499.5 四捨五入）');
  const c = lib.calcPurchase([{ qty: '2', price: '100' }, { qty: '1.5', price: '333' }]);
  ok(c.ok && c.amount === 700 && c.subtotals.join() === '200,500', 'calcPurchase 把字串轉數字後呼叫 apvCalcAmount', c);
  ok(lib.calcPurchase([{ qty: '', price: '100' }]).ok === false, '空數量 → 不通過');
  ok(lib.calcPurchase([{ qty: '1', price: '-5' }]).ok === false, '負單價 → 不通過');
  ok(lib.calcPurchase([{ qty: '1', price: '1.5' }]).ok === false, '單價小數 → 不通過');
  ok(lib.checkExpenseAmount('8600') && !lib.checkExpenseAmount('0') && !lib.checkExpenseAmount('12.5') && !lib.checkExpenseAmount('') && !lib.checkExpenseAmount('10000001'), '請款金額 1～10,000,000 整數');
}

// ── 6. 各分頁依 form.can 顯示按鈕 ───────────────────────
{
  const mk = (can, extra) => ({ id: 'APV-261018-901', type: 'expense', status: 'signing', rev: 1, step: 0, sender: { emp: 'DZY901', name: '測試甲', unit_name: '測試店' }, amount: 8600, files: [{ id: 'F1', kind: 'receipt', bytes: 1 }], route: { steps: [{ role: 'brand_dir', status: 'pending', candidates: [{ emp: 'DZY902', name: '測試乙' }] }] }, created_at: 1760745600000, can: { decide: false, sign: false, resubmit: false, withdraw: false, handle: false, reassign: false, void: false, ...can }, ...extra });
  const acts = (f, scope) => lib.visibleActions(f, scope).map((a) => a.act);
  eq(acts(mk({ decide: true }), 'sign'), ['approve', 'reject'], '待我簽：decide → 核准／退回');
  eq(acts(mk({ sign: true }), 'sign'), ['sign'], '待我簽：sign → 本人簽名');
  eq(acts(mk({}), 'sign'), [], '待我簽：沒資格 → 沒有按鈕');
  eq(acts(mk({ handle: true, reassign: true }), 'handle'), ['done', 'return', 'reassign'], '待我辦：handle＋reassign');
  eq(acts(mk({ handle: true }), 'handle'), ['done', 'return'], '待我辦：只有 handle 沒有改派');
  eq(acts(mk({ resubmit: true, withdraw: true }), 'mine'), ['resubmit', 'withdraw'], '我的單：改完再送／撤回');
  eq(acts(mk({ withdraw: true }), 'mine'), ['withdraw'], '我的單：只能撤回');
  eq(acts(mk({ decide: true, void: true }), 'mine'), [], '我的單：不會出現核准／作廢');
  eq(acts(mk({ reassign: true, void: true }), 'all'), ['reassign', 'void'], '全部單據：改派／作廢');
  eq(acts(mk({ decide: true, handle: true }), 'all'), [], '全部單據：不會出現核准／已處理');
  const html = cards.cardHtml(mk({ decide: true }), 'sign', esc, fmt);
  ok(html.includes('data-act="approve"') && html.includes('data-act="reject"') && !html.includes('data-act="done"') && html.includes('data-act="view"'), '卡片 HTML：核准／退回／展開，沒有已處理');
  ok(html.includes('APV-261018-901') && html.includes('8,600') && html.includes('卡在：品牌總監／研發總監（測試乙）') && html.includes('data-file="F1"'), '卡片 HTML：單號、金額、卡在誰、照片縮圖', html);
  ok(!cards.cardHtml(mk({}, { stuck: true }), 'sign', esc, fmt).includes('data-act="approve"') && cards.cardHtml(mk({}, { stuck: true }), 'sign', esc, fmt).includes('卡關'), '卡關標記；沒資格仍不出按鈕');
  const evil = cards.cardHtml(mk({}, { sender: { emp: 'DZY901', name: '<img src=x onerror=1>', unit_name: 'u' } }), 'mine', esc, fmt);
  ok(!evil.includes('<img src=x'), '送件人姓名有被轉義');
  eq(lib.whereText(mk({}, { status: 'handling', handler_dept: 'fin' })), '等承辦：財務部', '待承辦顯示部門');
  ok(lib.whereText(mk({}, { status: 'exception' })).includes('找不到'), 'exception 說明');
}

// ── 6b. QA-final 第 1 條：apvHandle／apvVoid／apvResubmit 要送畫面當下的 rev＋step ─────────
{
  const { runAction } = await import('../modules/approvals/actions.js');
  globalThis.document = { createElement: () => ({ set innerHTML(v) {}, querySelector: () => ({ value: '測試原因' }) }) };
  const sent = [];
  const ctx = { api: { call: async (m, a, p) => { sent.push({ a, p }); return { ok: true, data: {} }; } },
    ui: { loading() {}, toast() {}, confirm: async () => true, dialog: async () => 'ok' } };
  const form = { id: 'APV-261018-901', rev: 3, step: null, status: 'handling' };
  for (const act of ['done', 'return', 'void']) {
    sent.length = 0;
    await runAction(ctx, form, act);
    const c = sent[0];
    ok(c && c.p.id === form.id && c.p.rev === 3 && 'step' in c.p && c.p.step === null, `動作 ${act}（${c && c.a}）送出畫面的 rev＋step（handling 單 step＝null）`, c);
  }
  sent.length = 0;
  await runAction(ctx, { ...form, status: 'signing', rev: 2, step: 1 }, 'void');
  ok(sent[0].p.rev === 2 && sent[0].p.step === 1, '作廢 signing 的單送 rev＝2、step＝1', sent[0]);
  const sub = fs.readFileSync(path.join(ROOT, 'modules/approvals/views/submit.js'), 'utf8');
  ok(/'apvResubmit', \{[^}]*rev: resub\.rev,\s*step: resub\.step/.test(sub), 'apvResubmit 送 resub.rev 與 resub.step');
}

// ── 7. 核決權限：驗證與 diff ───────────────────────────
{
  const base = () => [{ seq: 1, max: 5000, store_role: 'head', hq_role: 'head' }, { seq: 2, max: 10000, store_role: 'brand_dir', hq_role: 'head' }, { seq: 3, max: 30000, store_role: 'gm', hq_role: 'gm' }, { seq: 4, max: null, store_role: 'chair', hq_role: 'chair' }];
  ok(lib.validateThr(base()) === '', '預設四列合法');
  ok(lib.validateThr([]) !== '', '空表不行');
  ok(lib.validateThr(base().map((r, i) => i === 1 ? { ...r, max: 5000 } : r)) !== '', '金額沒有嚴格遞增被擋');
  ok(lib.validateThr(base().map((r, i) => i === 3 ? { ...r, max: 99999 } : r)) !== '', '最後一列有金額被擋');
  ok(lib.validateThr(base().map((r, i) => i === 0 ? { ...r, max: '' } : r)) !== '', '非最後一列沒金額被擋');
  ok(lib.validateThr(base().map((r, i) => i === 0 ? { ...r, store_role: 'boss' } : r)) !== '', '權限人代碼不合法被擋');
  const a = base();
  const b = base().map((r) => ({ ...r }));
  b[1].max = 12000;
  b[2].store_role = 'ceo';
  eq(lib.diffThr(a, b), ['第 2 級：金額上限 10,000 → 12,000', '第 3 級：門市 總經理 → 執行長'], 'diff：改金額與權限人');
  eq(lib.diffThr(a, a), [], '沒改 → 空');
  const c = base().slice(0, 3);
  c[2].max = null;
  const d = lib.diffThr(a, c);
  ok(d.some((x) => x.startsWith('刪除第 4 級')), 'diff：刪除一級', d);
  const e = lib.diffThr(c, a);
  ok(e.some((x) => x.startsWith('新增第 4 級')), 'diff：新增一級', e);
  eq(lib.normThrRows([{ max: '5000', store_role: 'head', hq_role: 'head' }, { max: '', store_role: 'chair', hq_role: 'chair' }]), [{ seq: 1, max: 5000, store_role: 'head', hq_role: 'head' }, { seq: 2, max: null, store_role: 'chair', hq_role: 'chair' }], '正規化：字串轉數字、最後一列 null、seq 重編');
}

// ── 8. 錯誤碼、client_id、首頁提醒 ─────────────────────
{
  eq(lib.errText({ ok: false, error: 'conflict' }), '這張單剛被別人處理過，請重新整理', 'conflict 訊息');
  ok(lib.isConflict({ ok: false, error: 'conflict' }) && !lib.isConflict({ ok: false, error: 'forbidden' }), 'isConflict');
  eq(lib.errText({ ok: false, error: 'bad_request', data: { message: '需求日沒填' } }), '需求日沒填', 'bad_request 帶後端 message');
  ok(lib.errText({ ok: false, error: 'no_files' }).includes('收據'), 'no_files');
  eq(lib.errText({ ok: false, error: 'bad_request', data: { message: '對象已開通帳號，請改用線上簽名' } }), '對象已開通帳號，請改用線上簽名', '已開通對象帶紙本簽名 → 顯示後端 message（submit.js 送出失敗時 msg＋toast 都用 errText）');
  const ids = new Set(Array.from({ length: 50 }, () => lib.newClientId()));
  ok(ids.size === 50 && [...ids].every((x) => /^[0-9a-f-]{36}$/.test(x)), 'client_id 是 UUID 且不重複');
  eq(lib.buildAlerts({ sign: [{ stuck: false }, {}], handle: [], exception: [] }), [{ level: 'warn', text: '待我簽 2 張', view: 'sign' }], '待我簽 2 張（黃）');
  eq(lib.buildAlerts({ sign: [{ stuck: true }], handle: [{}] }), [{ level: 'error', text: '待我簽 1 張', view: 'sign' }, { level: 'warn', text: '待我辦 1 張', view: 'handle' }], '卡關的待我簽＝紅色；待我辦未卡＝黃');
  ok(lib.buildAlerts({ sign: [], handle: [], exception: [{}, {}] })[0].level === 'error', 'exception → 紅色');
  eq(lib.buildAlerts({ sign: [], handle: [] }), [], '沒有待辦 → 空陣列');
  const calls = [];
  const ctx = { api: { call: async (m, a) => { calls.push([m, a]); return { ok: true, data: { sign: [{ stuck: true }], handle: [{}, {}], exception: [] } }; } } };
  const al = await approvalsIndex.alerts(ctx);
  ok(calls[0][0] === 'approvals' && calls[0][1] === 'apvTodo' && al.length === 2 && al[0].level === 'error', 'alerts() 呼叫 apvTodo 並依卡關給紅色', al);
  ok(await approvalsIndex.badge(ctx) === 3, 'badge() = 待我簽＋待我辦');
  ok(await approvalsIndex.alerts({ api: { call: async () => ({ ok: false, error: 'x' }) } }) === null, '後端失敗 → null（首頁顯示暫時讀不到，不壞）');
}

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
