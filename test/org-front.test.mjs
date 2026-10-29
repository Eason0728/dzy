// node test/org-front.test.mjs —— 組織改版 T5／T6 前端：兼任部門、flags 標籤、需處理篩選、切換／退回組織、我的資料兼任
// 沒有 jsdom：用極簡假 DOM。全部假資料。
'use strict';
import fs from 'node:fs';

globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
// 組織一次性按鈕預設隱藏，要網址帶 ?orgtools=1 才出現；既有流程測試整支在旗標開啟下跑，最後還原
const hadLocation = Object.prototype.hasOwnProperty.call(globalThis, 'location');
const origLocation = globalThis.location;
const setSearch = (q) => { Object.defineProperty(globalThis, 'location', { value: q === null ? undefined : { search: q }, configurable: true, writable: true }); };
setSearch('?orgtools=1');
const { esc } = await import('../platform/fmt.js');
const { mountList, FILTERS } = await import('../modules/staff/views/list.js');
const { mountProfile } = await import('../modules/me/views/profile.js');

let passed = 0, failed = 0;
const ok = (c, label, extra) => { if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); } };
const flush = (n = 20) => new Promise((r) => { let k = n; (function s() { if (k-- <= 0) return r(); setImmediate(s); })(); });

function attrRe(sel) {
  if (sel.startsWith('#')) return new RegExp(`<[^>]*\\bid="${sel.slice(1)}"[^>]*>`);
  const m = /^\[([\w-]+)="([^"]+)"\]$/.exec(sel);
  if (m) return new RegExp(`<[^>]*\\b${m[1]}="${m[2]}"[^>]*>`);
  return null;
}
class FakeNode {
  constructor() { this.value = ''; this.hidden = false; this.checked = false; this.disabled = false; this._ls = {}; this._html = ''; this._q = new Map(); this.attrs = {}; }
  set innerHTML(h) { this._html = String(h); this._q = new Map(); }
  get innerHTML() { return this._html; }
  addEventListener(t, fn) { (this._ls[t] = this._ls[t] || []).push(fn); }
  fire(t, ev) { for (const fn of (this._ls[t] || []).slice()) fn(Object.assign({ preventDefault() {}, target: this }, ev || {})); }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  closest(sel) { return this.getAttribute(sel.replace(/^\[|\]$/g, '')) !== null ? this : null; }
  querySelectorAll(sel) {
    if (sel !== 'input[data-code]') return [];
    const key = '__all__' + sel;
    if (!this._q.has(key)) {
      const out = [];
      for (const m of this._html.matchAll(/<input\b[^>]*\bdata-code="([^"]*)"[^>]*>/g)) {
        const n = new FakeNode(); n.attrs['data-code'] = m[1]; n.checked = /\schecked[\s>]/.test(m[0]); out.push(n);
      }
      this._q.set(key, out);
    }
    return this._q.get(key);
  }
  querySelector(sel) {
    if (this._q.has(sel)) return this._q.get(sel);
    const re = attrRe(sel);
    const tag = re ? (re.exec(this._html) || [null])[0] : null;
    if (!tag) return null;
    const n = new FakeNode();
    const v = /\bvalue="([^"]*)"/.exec(tag);
    if (v) n.value = v[1];
    n.hidden = /\shidden[\s>]/.test(tag);
    n.checked = /\schecked[\s>]/.test(tag);
    this._q.set(sel, n);
    return n;
  }
}
globalThis.document = { createElement: () => new FakeNode() };
const xbox = (body, code) => body.querySelectorAll('input[data-code]').find((n) => n.getAttribute('data-code') === code);
const btn = (act, emp) => { const n = new FakeNode(); n.attrs['data-act'] = act; n.attrs['data-emp'] = emp; return n; };

const ORG = {
  brands: [{ code: 'dzy', name: '鼎兆元' }, { code: 'ck', name: '中央工廠' }],
  units: [{ code: 'dzy-hq', name: '鼎兆元總部', parent: 'dzy', ladder: 'hq' }, { code: 'ck', name: '中央工廠（央廚）', parent: 'ck', ladder: 'store' }],
  depts: [{ code: 'it', name: '資訊部', parent: 'dzy-hq' }, { code: 'training', name: '訓練部', parent: 'dzy-hq' }, { code: 'ops', name: '營運部', parent: 'dzy-hq' }, { code: 'zzz', name: '別處部門', parent: 'other-hq' }],
  titles: [{ code: 'hs', name: '部門同仁', parent: 'hq', rank: 1 }]
};
const P1 = { emp_no: 'DZY001', name: '測試甲', status: 'active', brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hs', brand_name: '鼎兆元', unit_name: '鼎兆元總部', dept_name: '資訊部', title_name: '部門同仁', phone: '0911222333', address: '測試路1號', birthday: '1995-05-05', extra_depts: ['training'], extra_dept_names: ['訓練部'], flags: [] };
const P2 = { emp_no: 'DZY002', name: '測試乙', status: 'active', brand: 'mala', unit: 'mala-old', title: 'sv', brand_name: '麻', unit_name: '舊店', title_name: '督導', phone: '0911000111', address: 'x', birthday: '1990-01-01', extra_depts: [], extra_dept_names: [], flags: ['unit_inactive', 'title_ladder'] };

function makeCtx(handler, opts) {
  opts = opts || {};
  const c = { calls: [], toasts: [], dialogs: [], confirms: [], answers: [], confirmAnswer: true, fills: [] };
  c.can = (p) => (opts.perms || []).includes(p);
  c.user = { id: 'u1', name: 'x', role: opts.role || 'staff' };
  c.fmt = { esc };
  c.api = { call: async (mod, action, payload) => { c.calls.push({ mod, action, payload }); return handler(action, payload); } };
  c.ui = {
    loading() {}, toast(m, t) { c.toasts.push([m, t]); },
    async confirm(m) { c.confirms.push(m); return c.confirmAnswer; },
    async dialog(o) { c.dialogs.push(o); const f = c.fills.shift(); if (f) f(o.body); return c.answers.length ? c.answers.shift() : null; }
  };
  return c;
}
const baseHandler = (extra) => (action, payload) => {
  if (extra) { const r = extra(action, payload); if (r) return r; }
  if (action === 'staffList') return { ok: true, data: { staff: [P1, P2] } };
  if (action === 'orgOptions') return { ok: true, data: ORG };
  if (action === 'staffEdit') return { ok: true, data: { staff: P1 } };
  return { ok: false, error: '未知 ' + action };
};
async function mount(ctx) { const el = new FakeNode(); mountList(el, ctx); await flush(); return el; }
const rows = (el) => el.querySelector('[data-role="rows"]').innerHTML;

// ── T5：名單標籤、兼任文字、篩選 ──
{
  const ctx = makeCtx(baseHandler(), { perms: ['platform.staff'] });
  const el = await mount(ctx);
  const h = el.innerHTML;
  ok(h.includes('兼任：訓練部'), 'T5 有兼任的人在單位文字後顯示「兼任：訓練部」');
  ok(h.includes('所屬門市已停用') && h.includes('職稱需重選'), 'T5 flags 標籤：所屬門市已停用／職稱需重選');
  ok((h.match(/所屬門市已停用/g) || []).length === 1, 'T5 沒 flags 的人不出現標籤');
  ok(FILTERS.some((f) => f[0] === 'flags' && f[1] === '需處理'), 'T5 篩選有「需處理」');
  el.querySelector('#stf-f').value = 'flags'; el.querySelector('#stf-f').fire('change');
  ok(rows(el).includes('DZY002') && !rows(el).includes('DZY001'), 'T5 「需處理」只留 flags 非空的人');
}

// ── T5：非 admin 看不到按鈕；admin 看得到 ──
{
  const el1 = await mount(makeCtx(baseHandler(), { perms: ['platform.staff'], role: 'hr' }));
  ok(!el1.innerHTML.includes('data-role="org-upgrade"') && !el1.innerHTML.includes('data-role="org-rollback"'), 'T5 ★非 admin 看不到兩顆按鈕');
  const el2 = await mount(makeCtx(baseHandler(), { perms: ['platform.staff'], role: 'admin' }));
  ok(el2.innerHTML.includes('data-role="org-upgrade"') && el2.innerHTML.includes('切換組織') && el2.innerHTML.includes('data-role="org-rollback"') && el2.innerHTML.includes('退回組織'), 'T5 admin 看得到「切換組織」「退回組織」');
}

// ── T5：改資料對話框兼任部門 ──
{
  const ctx = makeCtx(baseHandler(), { perms: ['platform.staff'] });
  const el = await mount(ctx);
  ctx.answers.push('ok');
  ctx.fills.push((body) => { xbox(body, 'training').checked = false; xbox(body, 'ops').checked = true; xbox(body, 'ck').checked = true; });
  el.querySelector('[data-role="rows"]').fire('click', { target: btn('edit', 'DZY001') });
  await flush();
  const body = ctx.dialogs[0].body.innerHTML;
  ok(body.includes('data-code="training"') && body.includes('data-code="ops"') && body.includes('data-code="ck"') && body.includes('中央工廠'), 'T5 對話框列 dzy-hq 部門＋中央工廠');
  ok(!body.includes('data-code="it"'), 'T5 排除這個人的主要部門（it）');
  ok(!body.includes('data-code="zzz"'), 'T5 不列別的單位底下的部門');
  ok(/data-code="training"[^>]*checked/.test(body), 'T5 目前兼任預先勾選');
  const call = ctx.calls.find((c) => c.action === 'staffEdit');
  ok(call && JSON.stringify(call.payload.extra_depts) === JSON.stringify(['ops', 'ck']), 'T5 送出帶 extra_depts（依勾選）', call);
}
{ // 沒改兼任 → 不帶
  const ctx = makeCtx(baseHandler(), { perms: ['platform.staff'] });
  const el = await mount(ctx);
  ctx.answers.push('ok');
  el.querySelector('[data-role="rows"]').fire('click', { target: btn('edit', 'DZY001') });
  await flush();
  const call = ctx.calls.find((c) => c.action === 'staffEdit');
  ok(call && !('extra_depts' in call.payload), 'T5 兼任沒變就不帶 extra_depts');
}
{ // 清空
  const ctx = makeCtx(baseHandler(), { perms: ['platform.staff'] });
  const el = await mount(ctx);
  ctx.answers.push('ok');
  ctx.fills.push((body) => { xbox(body, 'training').checked = false; });
  el.querySelector('[data-role="rows"]').fire('click', { target: btn('edit', 'DZY001') });
  await flush();
  const call = ctx.calls.find((c) => c.action === 'staffEdit');
  ok(call && Array.isArray(call.payload.extra_depts) && call.payload.extra_depts.length === 0, 'T5 全取消勾選 → 帶 []（清空）');
}
{ // 無 platform.staff：不出現區塊、不帶
  const ctx = makeCtx(baseHandler(), { perms: ['platform.review'] });
  const el = await mount(ctx);
  ctx.answers.push('ok');
  el.querySelector('[data-role="rows"]').fire('click', { target: btn('edit', 'DZY001') });
  await flush();
  ok(!ctx.dialogs[0].body.innerHTML.includes('data-code='), 'T5 ★沒有 platform.staff 看不到兼任區');
  const call = ctx.calls.find((c) => c.action === 'staffEdit');
  ok(call && !('extra_depts' in call.payload), 'T5 沒權限不帶 extra_depts');
}

// ── T5：切換組織 ──
const PREVIEW = { ok: true, data: { dryrun: true, backup: 'created', org: [{ code: 'ck', kind: 'brand', field: 'name', from: '央廚', to: '中央工廠' }, { code: 'yiwu-hq', kind: 'unit', field: 'row', from: '', to: 'added' }], clock: 'custom', staffColumn: 'added', titles: [{ emp_no: 'DZY010', name: '測試丙', from: 'hs', to: 'ofs', from_name: '部門同仁', to_name: '行政同仁' }], todo: [{ emp_no: 'DZY002', name: '測試乙', unit_name: '舊店', flag: 'title_ladder' }] } };
{
  const ctx = makeCtx(baseHandler((a, p) => (a === 'orgUpgrade2026' ? (p.dryrun ? PREVIEW : { ok: true, data: Object.assign({}, PREVIEW.data, { dryrun: false }) }) : null)), { perms: ['platform.staff'], role: 'admin' });
  const el = await mount(ctx);
  ctx.answers.push(null);
  el.querySelector('[data-role="org-upgrade"]').fire('click'); await flush();
  const ups = ctx.calls.filter((c) => c.action === 'orgUpgrade2026');
  ok(ups.length === 1 && ups[0].payload.dryrun === true, 'T5 ★先呼叫 dryrun:true，取消就不再呼叫');
  const pv = ctx.dialogs[0].body.innerHTML;
  ok(pv.includes('DZY010 測試丙：部門同仁 → 行政同仁') || (pv.includes('測試丙') && pv.includes('部門同仁') && pv.includes('行政同仁')), 'T5 預覽逐人顯示 姓名：從→到');
  ok(pv.includes('測試乙') && pv.includes('職稱需重選'), 'T5 預覽顯示需處理名單與原因');
  ok(pv.includes('自訂') && pv.includes('打卡'), 'T5 預覽顯示打卡對照狀態（custom）');
  ok(pv.includes('中央工廠') && pv.includes('yiwu-hq'), 'T5 預覽列出組織表要改的列');
  ok(ctx.dialogs[0].actions.some((a) => a.label === '確定切換'), 'T5 預覽有「確定切換」按鈕');
  // 確定
  ctx.calls.length = 0; ctx.dialogs.length = 0; ctx.answers.push('go', 'ok');
  el.querySelector('[data-role="org-upgrade"]').fire('click'); await flush();
  const ups2 = ctx.calls.filter((c) => c.action === 'orgUpgrade2026').map((c) => c.payload.dryrun);
  ok(JSON.stringify(ups2) === '[true,false]', 'T5 按「確定切換」才呼叫 dryrun:false', ups2);
  ok(ctx.dialogs.length === 2 && /完成|已切換/.test(ctx.dialogs[1].title), 'T5 完成後顯示報告');
  ok(ctx.calls.filter((c) => c.action === 'staffList').length >= 1 && ctx.calls[ctx.calls.length - 1].action !== 'orgUpgrade2026', 'T5 完成後重新載入名單');
}
{ // 後端錯誤
  const ctx = makeCtx(baseHandler((a) => (a === 'orgUpgrade2026' ? { ok: false, error: '只有管理員可以執行' } : null)), { perms: [], role: 'admin' });
  const el = await mount(ctx);
  el.querySelector('[data-role="org-upgrade"]').fire('click'); await flush();
  ok(ctx.toasts.some((t) => t[0] === '只有管理員可以執行' && t[1] === 'danger') && ctx.dialogs.length === 0, 'T5 錯誤訊息用後端中文');
}

// ── T5：退回組織 ──
{
  const ctx = makeCtx(baseHandler((a) => (a === 'orgRollback2026' ? { ok: true, data: { restored: 40, clock_restored: true, titles_restored: 2, titles_skipped: ['DZY777'], orphans: [{ emp_no: 'DZY002', name: '測試乙', unit: 'mala-old', title: 'sv' }], backup: 'org_bak_202610141200' } } : null)), { role: 'admin' });
  const el = await mount(ctx);
  ctx.confirmAnswer = false;
  el.querySelector('[data-role="org-rollback"]').fire('click'); await flush();
  ok(ctx.confirms.length === 1 && !ctx.calls.some((c) => c.action === 'orgRollback2026'), 'T5 退回先頁內確認，取消不呼叫');
  ctx.confirmAnswer = true; ctx.answers.push('ok');
  el.querySelector('[data-role="org-rollback"]').fire('click'); await flush();
  const rb = ctx.dialogs[0].body.innerHTML;
  ok(ctx.calls.some((c) => c.action === 'orgRollback2026') && rb.includes('40') && rb.includes('DZY777') && rb.includes('測試乙') && rb.includes('孤兒'), 'T5 退回報告：restored／略過／孤兒名單');
}
{ // 被拒 + diff
  const ctx = makeCtx(baseHandler((a) => (a === 'orgRollback2026' ? { ok: false, error: '切換後組織資料又被改過，拒絕整表覆蓋', data: { data: { diff: [{ kind: 'unit', code: 'ck', field: 'name', expected: 'A', actual: 'B' }] } } } : null)), { role: 'admin' });
  const el = await mount(ctx);
  ctx.answers.push('ok');
  el.querySelector('[data-role="org-rollback"]').fire('click'); await flush();
  const rb = ctx.dialogs[0] && ctx.dialogs[0].body.innerHTML;
  ok(rb && rb.includes('拒絕整表覆蓋') && rb.includes('ck') && rb.includes('name') && rb.includes('A') && rb.includes('B'), 'T5 被拒顯示原因與差異表', rb);
}

// ── T6：我的資料 ──
async function profileHtml(extraNames) {
  const p = Object.assign({}, P1, { extra_dept_names: extraNames, extra_depts: extraNames.map(() => 'x'), p_brand_name: '', p_unit_name: '' });
  const ctx = makeCtx((a) => (a === 'myProfile' ? { ok: true, data: p } : a === 'orgOptions' ? { ok: true, data: ORG } : { ok: false, error: 'x' }));
  const el = new FakeNode(); mountProfile(el, ctx); await flush();
  return el.innerHTML;
}
ok((await profileHtml(['資訊部', '訓練部'])).includes('兼任：資訊部、訓練部'), 'T6 有兼任顯示「兼任：資訊部、訓練部」');
ok(!(await profileHtml([])).includes('兼任'), 'T6 沒有兼任就不顯示');
{ const h = await profileHtml(['資訊部']); ok(!/id="[^"]*extra/.test(h), 'T6 唯讀（沒有可編輯欄位）'); }


// ── #4 修 ──
{ // #1 停用部門的舊兼任：不動不帶、對話框唯讀列出
  const P4 = Object.assign({}, P1, { extra_depts: ['training', 'old'], extra_dept_names: ['訓練部', '舊部門'] });
  const h4 = (extra) => baseHandler((a) => (a === 'staffList' ? { ok: true, data: { staff: [P4, P2] } } : (extra && extra(a)) || null));
  const ctx = makeCtx(h4(), { perms: ['platform.staff'] });
  const el = await mount(ctx);
  ctx.answers.push('ok');
  el.querySelector('[data-role="rows"]').fire('click', { target: btn('edit', 'DZY001') });
  await flush();
  ok(/data-code="old"[^>]*checked/.test(ctx.dialogs[0].body.innerHTML) && ctx.dialogs[0].body.innerHTML.includes('舊部門（目前不可選，保留不動）'), '#5 不可選舊代碼是預設勾選的勾選框「舊部門（目前不可選，保留不動）」');
  let call = ctx.calls.find((c) => c.action === 'staffEdit');
  ok(call && !('extra_depts' in call.payload), '#4-1 ★含停用代碼、不動直接儲存 → 不帶 extra_depts', call);
  const ctx2 = makeCtx(h4(), { perms: ['platform.staff'] });
  const el2 = await mount(ctx2);
  ctx2.answers.push('ok');
  ctx2.fills.push((body) => { xbox(body, 'ops').checked = true; });
  el2.querySelector('[data-role="rows"]').fire('click', { target: btn('edit', 'DZY001') });
  await flush();
  call = ctx2.calls.find((c) => c.action === 'staffEdit');
  ok(call && JSON.stringify(call.payload.extra_depts) === JSON.stringify(['training', 'ops', 'old']), '#4-1 ★改別的勾選、停用代碼保持勾選 → 原樣送回', call);
}
{ // 停用兼任取消勾選就移除
  const P4 = Object.assign({}, P1, { extra_depts: ['training', 'old'], extra_dept_names: ['訓練部', '舊部門'] });
  const ctx = makeCtx((a) => (a === 'staffList' ? { ok: true, data: { staff: [P4] } } : a === 'orgOptions' ? { ok: true, data: ORG } : { ok: true, data: { staff: P4 } }), { perms: ['platform.staff'] });
  const el = await mount(ctx);
  ctx.answers.push('ok');
  ctx.fills.push((body) => { xbox(body, 'old').checked = false; });
  el.querySelector('[data-role="rows"]').fire('click', { target: btn('edit', 'DZY001') });
  await flush();
  const call = ctx.calls.find((c) => c.action === 'staffEdit');
  ok(call && JSON.stringify(call.payload.extra_depts) === JSON.stringify(['training']), '#4-1 取消勾選停用代碼 → 從 extra_depts 移除', call);
}
{ // #3 代碼含特殊字元也能正確讀勾選（不靠 id 選擇器）
  const ORG3 = Object.assign({}, ORG, { depts: ORG.depts.concat([{ code: 'r.d', name: '特殊部', parent: 'dzy-hq' }]) });
  const P3 = Object.assign({}, P1, { extra_depts: ['r.d'], extra_dept_names: ['特殊部'] });
  const ctx = makeCtx((a) => (a === 'staffList' ? { ok: true, data: { staff: [P3] } } : a === 'orgOptions' ? { ok: true, data: ORG3 } : { ok: true, data: { staff: P3 } }), { perms: ['platform.staff'] });
  const el = await mount(ctx);
  ctx.answers.push('ok');
  ctx.fills.push((body) => { xbox(body, 'ops').checked = true; });
  el.querySelector('[data-role="rows"]').fire('click', { target: btn('edit', 'DZY001') });
  await flush();
  const call = ctx.calls.find((c) => c.action === 'staffEdit');
  ok(call && JSON.stringify(call.payload.extra_depts) === JSON.stringify(['ops', 'r.d']), '#4-3 代碼含「.」時原本勾選仍被保留', call);
  ok(!/id="ed-x-r/.test(ctx.dialogs[0].body.innerHTML), '#4-3 不再把代碼拼進 id');
}
{ // #2 試跑模式放行 orgUpgrade2026 dryrun:true，dryrun:false 與 rollback 仍攔
  const { isReadAction } = await import('../platform/dryrun.js');
  ok(isReadAction('platform', 'orgUpgrade2026', { dryrun: true }), '#4-2 orgUpgrade2026 {dryrun:true} 放行');
  ok(!isReadAction('platform', 'orgUpgrade2026', { dryrun: false }) && !isReadAction('platform', 'orgUpgrade2026', {}) && !isReadAction('platform', 'orgRollback2026', {}), '#4-2 dryrun:false／無參數／orgRollback2026 仍攔');
}

// ── exec_misplaced ──
{
  const P6 = Object.assign({}, P1, { emp_no: 'DZY006', name: '測試己', title: 'ceo', title_name: '執行長', flags: ['exec_misplaced'] });
  const pv = JSON.parse(JSON.stringify(PREVIEW)); pv.data.todo.push({ emp_no: 'DZY006', name: '測試己', unit_name: '小辛辣品牌辦公室', flag: 'exec_misplaced', submitted: false });
  const ctx = makeCtx(baseHandler((a, p) => (a === 'staffList' ? { ok: true, data: { staff: [P1, P6] } } : a === 'orgUpgrade2026' ? pv : null)), { role: 'admin' });
  const el = await mount(ctx);
  ok(el.innerHTML.includes('建議改到鼎兆元總部／管理部'), '標籤：exec_misplaced →「建議改到鼎兆元總部／管理部」');
  el.querySelector('#stf-f').value = 'flags'; el.querySelector('#stf-f').fire('change');
  ok(rows(el).includes('DZY006') && !rows(el).includes('DZY001'), '「需處理」也算 exec_misplaced');
  ctx.answers.push(null);
  el.querySelector('[data-role="org-upgrade"]').fire('click'); await flush();
  ok(/測試己[^<]*建議改到鼎兆元總部／管理部/.test(ctx.dialogs[0].body.innerHTML), '預覽需處理名單顯示 exec_misplaced', ctx.dialogs[0].body.innerHTML);
}

// ── dept_inactive／submitted／orphans.dept／clock_diff ──
{
  const P5 = Object.assign({}, P1, { emp_no: 'DZY005', name: '測試戊', flags: ['dept_inactive'] });
  const pv = JSON.parse(JSON.stringify(PREVIEW)); pv.data.todo.push({ emp_no: 'DZY005', name: '測試戊', unit_name: '總部', flag: 'dept_inactive', submitted: true });
  const ctx = makeCtx(baseHandler((a, p) => (a === 'staffList' ? { ok: true, data: { staff: [P1, P5] } } : a === 'orgUpgrade2026' ? pv : a === 'orgRollback2026' ? { ok: false, error: '切換後打卡店別對照又被改過，拒絕整表覆蓋', data: { data: { clock_diff: [{ key: 'hq', field: 'unit_code', expected: 'dzy-hq', actual: 'x-hq' }] } } } : null)), { role: 'admin' });
  const el = await mount(ctx);
  ok(el.innerHTML.includes('部門已停用'), '標籤：dept_inactive →「部門已停用」');
  el.querySelector('#stf-f').value = 'flags'; el.querySelector('#stf-f').fire('change');
  ok(rows(el).includes('DZY005') && !rows(el).includes('DZY001'), '「需處理」也算 dept_inactive');
  ctx.answers.push(null);
  el.querySelector('[data-role="org-upgrade"]').fire('click'); await flush();
  const t = ctx.dialogs[0].body.innerHTML;
  ok(/測試戊[^<]*部門已停用[^<]*（送出待審的資料）/.test(t), '預覽需處理名單：submitted → 後面加「（送出待審的資料）」', t);
  ok(!/測試乙[^<]*（送出待審的資料）/.test(t), '非 submitted 不加註');
  ctx.dialogs.length = 0; ctx.answers.push('ok');
  el.querySelector('[data-role="org-rollback"]').fire('click'); await flush();
  const d = ctx.dialogs[0] && ctx.dialogs[0].body.innerHTML;
  ok(d && d.includes('打卡對照差異') && d.includes('x-hq') && d.includes('unit_code') && d.includes('dzy-hq'), '退回被拒：只有 clock_diff 也顯示「打卡對照差異」', d);
}
{
  const ctx = makeCtx(baseHandler((a) => (a === 'orgRollback2026' ? { ok: false, error: '被改過', data: { data: { diff: [{ kind: 'unit', code: 'ck', field: 'name', expected: 'A', actual: 'B' }], clock_diff: [{ key: 'hq', field: 'unit_code', expected: 'E1', actual: 'A1' }] } } } : null)), { role: 'admin' });
  const el = await mount(ctx);
  ctx.answers.push('ok');
  el.querySelector('[data-role="org-rollback"]').fire('click'); await flush();
  const d = ctx.dialogs[0].body.innerHTML;
  ok(d.indexOf('組織表差異') !== -1 && d.indexOf('組織表差異') < d.indexOf('打卡對照差異') && d.includes('E1'), '兩種差異：組織表在上、打卡對照在下');
}
{
  const ctx = makeCtx(baseHandler((a) => (a === 'orgRollback2026' ? { ok: true, data: { restored: 1, orphans: [{ emp_no: 'DZY009', name: '測試己', unit: 'u1', dept: 'olddept', title: 't1' }] } } : null)), { role: 'admin' });
  const el = await mount(ctx);
  ctx.answers.push('ok');
  el.querySelector('[data-role="org-rollback"]').fire('click'); await flush();
  ok(ctx.dialogs[0].body.innerHTML.includes('olddept'), '孤兒名單顯示部門');
}

// ── 試跑模式：被 api.js 攔下（回 dryrun:true）不顯示假報告、不重載 ──
{
  const DRY = { ok: true, dryrun: true, data: { dryRun: true } };
  const ctx = makeCtx(baseHandler((a, p) => (a === 'orgUpgrade2026' ? (p.dryrun ? PREVIEW : DRY) : a === 'orgRollback2026' ? DRY : null)), { role: 'admin' });
  const el = await mount(ctx);
  ctx.answers.push('go');
  const n0 = ctx.calls.filter((c) => c.action === 'staffList').length;
  el.querySelector('[data-role="org-upgrade"]').fire('click'); await flush();
  ok(ctx.dialogs.length === 1 && ctx.toasts.some((t) => t[0] === '試跑模式：未寫入') && ctx.calls.filter((c) => c.action === 'staffList').length === n0, '#4 試跑：確定切換只 toast「試跑模式：未寫入」，沒有完成報告、不重載');
  ctx.dialogs.length = 0; ctx.toasts.length = 0;
  el.querySelector('[data-role="org-rollback"]').fire('click'); await flush();
  ok(ctx.dialogs.length === 0 && ctx.toasts.some((t) => t[0] === '試跑模式：未寫入') && ctx.calls.filter((c) => c.action === 'staffList').length === n0, '#4 試跑：退回組織只 toast，沒有報告、不重載');
}

// ── 第 15 節：職稱調整（2026-10-20）前端 ──
{
  const el1 = await mount(makeCtx(baseHandler(), { perms: ['platform.staff'], role: 'hr' }));
  ok(!el1.innerHTML.includes('data-role="org-upgrade-2610"') && !el1.innerHTML.includes('data-role="org-rollback-2610"'), '15 ★非 admin 看不到「職稱調整」「退回職稱調整」');
  const PV = { ok: true, data: { dryrun: true, backup: 'created', org: [{ kind: 'title', code: 'fm', field: 'row', from: '', to: 'added' }, { kind: 'title', code: 'oam', field: 'active', from: 'TRUE', to: 'FALSE' }],
    staff: [{ emp_no: 'DZY050', name: '測試央', field: 'title', from: 'sm', to: 'fm', from_name: '店長', to_name: '廠長' }, { emp_no: 'DZY051', name: '測試待', field: 'p_title', from: 'sm', to: 'fm', from_name: '店長', to_name: '廠長' }],
    perm: { status: 'ok', add: [{ ladder: 'store', dept: '', title: 'fm', perm: 'store.void', from_rule: 'R020' }] },
    todo: [{ emp_no: 'DZY052', name: '測試辦', unit_name: '小辛辣品牌辦公室', flag: 'title_ladder', submitted: false }],
    resolved: [{ emp_no: 'DZY053', name: '測試區', unit_name: '新竹光復', flag: 'title_ladder', submitted: false }] } };
  const ctx = makeCtx(baseHandler((a, p) => (a === 'orgUpgrade202610' ? (p.dryrun ? PV : { ok: true, data: Object.assign({}, PV.data, { dryrun: false }) }) : null)), { perms: ['platform.staff'], role: 'admin' });
  const el = await mount(ctx);
  ok(el.innerHTML.includes('data-role="org-upgrade-2610"') && el.innerHTML.includes('data-role="org-rollback-2610"'), '15 admin 看得到兩顆新按鈕');
  ctx.answers.push(null);
  el.querySelector('[data-role="org-upgrade-2610"]').fire('click'); await flush();
  const c1 = ctx.calls.filter((c) => c.action === 'orgUpgrade202610');
  ok(c1.length === 1 && c1[0].payload.dryrun === true, '15 ★先 dryrun:true 預覽，取消就不寫');
  const pv = ctx.dialogs[0].body.innerHTML;
  ok(pv.includes('DZY050 測試央') && pv.includes('店長 → 廠長') && pv.includes('送出待審的職稱') && pv.includes('fm：store.void') && pv.includes('測試辦') && pv.includes('職稱需重選') && pv.includes('測試區'), '15 預覽列出組織列、同仁職稱（含待審）、權限規則、需處理與變合規名單', pv);
  ctx.calls.length = 0; ctx.dialogs.length = 0; ctx.answers.push('go', 'ok');
  el.querySelector('[data-role="org-upgrade-2610"]').fire('click'); await flush();
  ok(JSON.stringify(ctx.calls.filter((c) => c.action === 'orgUpgrade202610').map((c) => c.payload.dryrun)) === '[true,false]' && /完成/.test(ctx.dialogs[1].title), '15 按「確定調整」才 dryrun:false，完成顯示報告');
}
{ // 退回職稱調整：確認、成功報告、被拒差異表
  const ctx = makeCtx(baseHandler((a) => (a === 'orgRollback202610' ? { ok: true, data: { restored: 50, staff_restored: 2, perm_disabled: ['R030', 'R031'], orphans: [{ emp_no: 'DZY060', name: '測試研', unit: 'ck', title: 'rdd', p_title: '' }] } } : null)), { role: 'admin' });
  const el = await mount(ctx);
  ctx.confirmAnswer = false;
  el.querySelector('[data-role="org-rollback-2610"]').fire('click'); await flush();
  ok(ctx.confirms.length === 1 && !ctx.calls.some((c) => c.action === 'orgRollback202610'), '15 退回先確認，取消不呼叫');
  ctx.confirmAnswer = true; ctx.answers.push('ok');
  el.querySelector('[data-role="org-rollback-2610"]').fire('click'); await flush();
  const rb = ctx.dialogs[0].body.innerHTML;
  ok(rb.includes('50') && rb.includes('同仁職稱還原 2') && rb.includes('停用權限規則 2') && rb.includes('測試研'), '15 退回報告', rb);
  const ctx2 = makeCtx(baseHandler((a) => (a === 'orgRollback202610' ? { ok: false, error: '職稱調整後同仁職稱又被改過', data: { data: { staff_diff: [{ emp_no: 'DZY061', field: 'title', expected: 'fm', actual: 'pt' }] } } } : null)), { role: 'admin' });
  const el2 = await mount(ctx2);
  ctx2.answers.push('ok');
  el2.querySelector('[data-role="org-rollback-2610"]').fire('click'); await flush();
  const rb2 = ctx2.dialogs[0] && ctx2.dialogs[0].body.innerHTML;
  ok(rb2 && rb2.includes('DZY061') && rb2.includes('fm') && rb2.includes('pt') && rb2.includes('同仁職稱差異'), '15 退回被拒：顯示同仁差異表', rb2);
}
{ // 試跑模式：orgUpgrade202610 dryrun:true 放行，其餘攔
  const { isReadAction } = await import('../platform/dryrun.js');
  ok(isReadAction('platform', 'orgUpgrade202610', { dryrun: true }) && !isReadAction('platform', 'orgUpgrade202610', { dryrun: false }) && !isReadAction('platform', 'orgUpgrade202610', {}) && !isReadAction('platform', 'orgRollback202610', {}), '15 dryrun.js：預覽放行、執行與退回攔下');
}
// ── 第 16 節：名稱調整（2026-10-23）前端 ──
{
  const el1 = await mount(makeCtx(baseHandler(), { perms: ['platform.staff'], role: 'hr' }));
  ok(!el1.innerHTML.includes('data-role="org-rename-2610n"') && !el1.innerHTML.includes('data-role="org-rename-rollback-2610n"'), '16 ★非 admin 看不到「名稱調整」「退回名稱調整」');
  const PV = { ok: true, data: { dryrun: true, changes: [{ kind: 'dept', code: 'franchise', from: '加盟招商部', to: '加盟部' }, { kind: 'title', code: 'hm', from: '部門主管', to: '總監' }, { kind: 'brand', code: 'ck', from: '中央工廠', to: '研發部' }, { kind: 'role', code: 'manager', from: '部門主管', to: '總監' }], skipped: [{ kind: 'title', code: 'rdd', name: '廚藝總監' }] } };
  const ctx = makeCtx(baseHandler((a, p) => (a === 'orgRename202610' ? (p.dryrun ? PV : { ok: true, data: Object.assign({}, PV.data, { dryrun: false }) }) : null)), { perms: ['platform.staff'], role: 'admin' });
  const el = await mount(ctx);
  ok(el.innerHTML.includes('名稱調整（10/23）') && el.innerHTML.includes('退回名稱調整'), '16 admin 看得到兩顆按鈕');
  ctx.answers.push(null);
  el.querySelector('[data-role="org-rename-2610n"]').fire('click'); await flush();
  ok(ctx.calls.filter((c) => c.action === 'orgRename202610').length === 1 && ctx.calls.find((c) => c.action === 'orgRename202610').payload.dryrun === true, '16 ★先 dryrun:true 預覽，取消就不寫');
  const pv = ctx.dialogs[0].body.innerHTML;
  ok(pv.includes('加盟招商部 → 加盟部') && pv.includes('部門主管 → 總監') && pv.includes('廚藝總監'), '16 預覽列出要改與已是新名的格子', pv);
  ok(pv.includes('品牌 ck：中央工廠 → 研發部') && pv.includes('系統角色 manager：部門主管 → 總監'), '16 預覽標示品牌、系統角色（不是一律寫職稱）', pv);
  ctx.calls.length = 0; ctx.dialogs.length = 0; ctx.answers.push('go', 'ok');
  el.querySelector('[data-role="org-rename-2610n"]').fire('click'); await flush();
  ok(JSON.stringify(ctx.calls.filter((c) => c.action === 'orgRename202610').map((c) => c.payload.dryrun)) === '[true,false]' && /完成/.test(ctx.dialogs[1].title), '16 按「確定調整」才 dryrun:false');
  // 退回：先確認；被拒顯示清單
  const ctx2 = makeCtx(baseHandler((a) => (a === 'orgRenameRollback202610' ? { ok: false, error: '退回名稱調整：名稱不是預期的值', data: { bad: [{ kind: 'title', code: 'hm', expected: '總監', actual: '部門經理' }] } } : null)), { role: 'admin' });
  const el2 = await mount(ctx2);
  ctx2.confirmAnswer = false;
  el2.querySelector('[data-role="org-rename-rollback-2610n"]').fire('click'); await flush();
  ok(ctx2.confirms.length === 1 && !ctx2.calls.some((c) => c.action === 'orgRenameRollback202610'), '16 退回先確認，取消不呼叫');
  ctx2.confirmAnswer = true; ctx2.answers.push('ok');
  el2.querySelector('[data-role="org-rename-rollback-2610n"]').fire('click'); await flush();
  const rb = ctx2.dialogs[0] && ctx2.dialogs[0].body.innerHTML;
  ok(rb && rb.includes('部門經理') && rb.includes('hm'), '16 退回被拒：列出不符的名稱', rb);
}
{ // 試跑模式：orgRename202610 dryrun:true 放行，其餘攔
  const { isReadAction } = await import('../platform/dryrun.js');
  ok(isReadAction('platform', 'orgRename202610', { dryrun: true }) && !isReadAction('platform', 'orgRename202610', { dryrun: false }) && !isReadAction('platform', 'orgRename202610', {}) && !isReadAction('platform', 'orgRenameRollback202610', {}) && !isReadAction('platform', 'orgRenameRollback202610', { dryrun: true }), '16 dryrun.js：預覽放行、執行與退回攔下');
}
{ // 左側選單部門（platform/config.js）
  const { DEPARTMENTS } = await import('../platform/config.js');
  const ids = DEPARTMENTS.map((d) => d.id);
  ok(DEPARTMENTS[ids.indexOf('eng') + 1].id === 'rd' && DEPARTMENTS[ids.indexOf('eng') + 1].name === '研發部門', '16 選單：研發部門排在工程部門之後');
  ok(DEPARTMENTS.find((d) => d.id === 'franchise').name === '加盟部門' && DEPARTMENTS.length === 12 && new Set(ids).size === 12 && DEPARTMENTS.every((d) => d.name.length === 4), '16 選單：加盟部門、共 12 個、代碼不重複、名稱四字');
}
// ── 第 17 節：新增品牌發展部（2026-10-23）前端 ──
{
  const el1 = await mount(makeCtx(baseHandler(), { perms: ['platform.staff'], role: 'hr' }));
  ok(!el1.innerHTML.includes('data-role="org-add-branddev-2610"') && !el1.innerHTML.includes('data-role="org-rollback-branddev-2610"'), '17 ★非 admin 看不到「新增品牌發展部」「退回品牌發展部」');
  const PV = { ok: true, data: { dryrun: true, action: 'add', dept: { code: 'branddev', name: '品牌發展部', parent: 'dzy-hq', order: 11 } } };
  const ctx = makeCtx(baseHandler((a, p) => (a === 'orgAddBranddev202610' ? (p.dryrun ? PV : { ok: true, data: Object.assign({}, PV.data, { dryrun: false }) }) : null)), { perms: ['platform.staff'], role: 'admin' });
  const el = await mount(ctx);
  ok(el.innerHTML.includes('新增品牌發展部（10/23）') && el.innerHTML.includes('退回品牌發展部'), '17 admin 看得到兩顆按鈕');
  ctx.answers.push(null);
  el.querySelector('[data-role="org-add-branddev-2610"]').fire('click'); await flush();
  const c1 = ctx.calls.filter((c) => c.action === 'orgAddBranddev202610');
  ok(c1.length === 1 && c1[0].payload.dryrun === true, '17 ★先 dryrun:true 預覽，取消就不寫');
  ok(ctx.dialogs[0].body.innerHTML.includes('品牌發展部') && ctx.dialogs[0].body.innerHTML.includes('新增一列'), '17 預覽顯示部門與動作', ctx.dialogs[0].body.innerHTML);
  ctx.calls.length = 0; ctx.dialogs.length = 0; ctx.answers.push('go', 'ok');
  el.querySelector('[data-role="org-add-branddev-2610"]').fire('click'); await flush();
  ok(JSON.stringify(ctx.calls.filter((c) => c.action === 'orgAddBranddev202610').map((c) => c.payload.dryrun)) === '[true,false]' && /完成/.test(ctx.dialogs[1].title), '17 按「確定新增」才 dryrun:false');
  // 退回：先確認；有人在部門 → 只列編號
  const ctx2 = makeCtx(baseHandler((a) => (a === 'orgAddBranddevRollback202610' ? { ok: false, error: '退回品牌發展部：還有同仁', data: { members: ['DZY007'] } } : null)), { role: 'admin' });
  const el2 = await mount(ctx2);
  ctx2.confirmAnswer = false;
  el2.querySelector('[data-role="org-rollback-branddev-2610"]').fire('click'); await flush();
  ok(ctx2.confirms.length === 1 && !ctx2.calls.some((c) => c.action === 'orgAddBranddevRollback202610'), '17 退回先確認，取消不呼叫');
  ctx2.confirmAnswer = true; ctx2.answers.push('ok');
  el2.querySelector('[data-role="org-rollback-branddev-2610"]').fire('click'); await flush();
  const rb = ctx2.dialogs[0] && ctx2.dialogs[0].body.innerHTML;
  ok(rb && rb.includes('DZY007'), '17 退回被拒：列出還在部門的同仁編號', rb);
}
{ // 試跑模式：orgAddBranddev202610 dryrun:true 放行，其餘攔
  const { isReadAction } = await import('../platform/dryrun.js');
  ok(isReadAction('platform', 'orgAddBranddev202610', { dryrun: true }) && !isReadAction('platform', 'orgAddBranddev202610', { dryrun: false }) && !isReadAction('platform', 'orgAddBranddev202610', {}) && !isReadAction('platform', 'orgAddBranddevRollback202610', {}) && !isReadAction('platform', 'orgAddBranddevRollback202610', { dryrun: true }), '17 dryrun.js：預覽放行、執行與退回攔下');
}
// ── 第 19 節：重新啟用墨竹亭台中美村（2026-10-29）前端 ──
{
  const el1 = await mount(makeCtx(baseHandler(), { perms: ['platform.staff'], role: 'hr' }));
  ok(!el1.innerHTML.includes('data-role="org-enable-mztmc-2610"') && !el1.innerHTML.includes('data-role="org-rollback-mztmc-2610"'), '19 ★非 admin 看不到「啟用墨竹亭台中美村」「退回墨竹亭台中美村」');
  const PV = { ok: true, data: { dryrun: true, action: 'reactivate', unit: { code: 'mzt-mc', name: '台中美村', parent: 'mzt', order: 6 } } };
  const ctx = makeCtx(baseHandler((a, p) => (a === 'orgEnableMztMc202610' ? (p.dryrun ? PV : { ok: true, data: Object.assign({}, PV.data, { dryrun: false }) }) : null)), { perms: ['platform.staff'], role: 'admin' });
  const el = await mount(ctx);
  ok(el.innerHTML.includes('啟用墨竹亭台中美村（10/29）') && el.innerHTML.includes('退回墨竹亭台中美村'), '19 admin 看得到兩顆按鈕');
  ctx.answers.push(null);
  el.querySelector('[data-role="org-enable-mztmc-2610"]').fire('click'); await flush();
  const c1 = ctx.calls.filter((c) => c.action === 'orgEnableMztMc202610');
  ok(c1.length === 1 && c1[0].payload.dryrun === true, '19 ★先 dryrun:true 預覽，取消就不寫');
  ok(ctx.dialogs[0].body.innerHTML.includes('墨竹亭台中美村') && ctx.dialogs[0].body.innerHTML.includes('重新啟用'), '19 預覽顯示門市與動作', ctx.dialogs[0].body.innerHTML);
  ctx.calls.length = 0; ctx.dialogs.length = 0; ctx.answers.push('go', 'ok');
  el.querySelector('[data-role="org-enable-mztmc-2610"]').fire('click'); await flush();
  ok(JSON.stringify(ctx.calls.filter((c) => c.action === 'orgEnableMztMc202610').map((c) => c.payload.dryrun)) === '[true,false]' && /已啟用/.test(ctx.dialogs[1].title), '19 按「確定啟用」才 dryrun:false');
  const ctx2 = makeCtx(baseHandler((a) => (a === 'orgEnableMztMcRollback202610' ? { ok: false, error: '退回墨竹亭台中美村：還有同仁', data: { members: ['DZY007'] } } : null)), { role: 'admin' });
  const el2 = await mount(ctx2);
  ctx2.confirmAnswer = false;
  el2.querySelector('[data-role="org-rollback-mztmc-2610"]').fire('click'); await flush();
  ok(ctx2.confirms.length === 1 && !ctx2.calls.some((c) => c.action === 'orgEnableMztMcRollback202610'), '19 退回先確認，取消不呼叫');
  ctx2.confirmAnswer = true; ctx2.answers.push('ok');
  el2.querySelector('[data-role="org-rollback-mztmc-2610"]').fire('click'); await flush();
  const rb = ctx2.dialogs[0] && ctx2.dialogs[0].body.innerHTML;
  ok(rb && rb.includes('DZY007'), '19 退回被拒：列出還在店的同仁編號', rb);
  const { isReadAction } = await import('../platform/dryrun.js');
  ok(isReadAction('platform', 'orgEnableMztMc202610', { dryrun: true }) && !isReadAction('platform', 'orgEnableMztMc202610', { dryrun: false }) && !isReadAction('platform', 'orgEnableMztMc202610', {}) && !isReadAction('platform', 'orgEnableMztMcRollback202610', { dryrun: true }), '19 dryrun.js：預覽放行、執行與退回攔下');
}
{ // 左側選單：品牌發展緊接在行銷部門之後
  const { DEPARTMENTS } = await import('../platform/config.js');
  const ids = DEPARTMENTS.map((d) => d.id);
  const mi = ids.indexOf('marketing');
  ok(DEPARTMENTS[mi + 1].id === 'branddev' && DEPARTMENTS[mi + 1].name === '品牌發展' && DEPARTMENTS[mi + 2].id === 'it', '17 選單：品牌發展排在行銷部門之後、資訊部門之前');
}
{ // org-fields titlesForUnit（兩份同一份程式）
  const { titlesForUnit } = await import('../platform/views/org-fields.js');
  const { titlesForUnit: t2 } = await import('../modules/staff-shared/org-fields.js');
  const O = { titles: ['pt', 'ft', 'sm', 'am', 'fm', 'rdd'].map((c, i) => ({ code: c, name: c, parent: 'store', rank: i })).concat([{ code: 'ofs', name: 'ofs', parent: 'office', rank: 1 }]),
    unit_titles: { ck: ['pt', 'ft', 'fm', 'rdd'] }, title_units: { fm: ['ck'], rdd: ['ck'] } };
  const codes = (f, u) => f(O, u).map((t) => t.code).join();
  ok(codes(titlesForUnit, { code: 'ck', ladder: 'store' }) === 'pt,ft,fm,rdd' && codes(t2, { code: 'ck', ladder: 'store' }) === 'pt,ft,fm,rdd', '15 前端：中央工廠只列 pt／ft／fm／rdd（不列店長、區經理）');
  ok(codes(titlesForUnit, { code: 'mala-gf', ladder: 'store' }) === 'pt,ft,sm,am', '15 前端：門市列 pt／ft／sm／am（不列廠長、廚藝總監）');
  ok(codes(titlesForUnit, { code: 'mala-hq', ladder: 'office' }) === 'ofs', '15 前端：品牌辦公室照階梯');
  ok(titlesForUnit({ titles: O.titles }, { code: 'ck', ladder: 'store' }).length === 6, '15 前端：舊後端沒有 unit_titles → 不限定（相容）');
}

// ── 2026-10-24：八顆一次性按鈕預設隱藏，admin＋?orgtools=1 才顯示 ──
{
  const ROLES = ['org-upgrade', 'org-rollback', 'org-upgrade-2610', 'org-rollback-2610', 'org-rename-2610n', 'org-rename-rollback-2610n', 'org-add-branddev-2610', 'org-rollback-branddev-2610'];
  const count = (el) => ROLES.filter((r) => el.innerHTML.includes('data-role="' + r + '"')).length;
  const adm = () => makeCtx(baseHandler(), { perms: ['platform.staff'], role: 'admin' });
  for (const q of [null, '', '?foo=1', '?orgtools=0', '?orgtools=11', '?xorgtools=1']) {
    setSearch(q);
    const el = await mount(adm());
    ok(count(el) === 0 && el.innerHTML.includes('data-role="add-staff"') && el.innerHTML.includes('新增同仁'), '17 ★admin 無旗標(' + JSON.stringify(q) + ')：八顆都不見、「新增同仁」仍在');
  }
  for (const q of ['?orgtools=1', '?a=1&orgtools=1', '?orgtools=1&a=1']) {
    setSearch(q);
    const el = await mount(adm());
    ok(count(el) === 8 && el.innerHTML.includes('data-role="add-staff"'), '17 admin＋旗標(' + q + ')：八顆都在');
  }
  setSearch('?orgtools=1');
  const elh = await mount(makeCtx(baseHandler(), { perms: ['platform.staff'], role: 'hr' }));
  ok(count(elh) === 0 && elh.innerHTML.includes('data-role="add-staff"'), '17 ★非 admin＋旗標：八顆都不見');
}

// ── 2026-10-26：手機版一人一張卡（Eason 選 B 版：次要按鈕收進「更多」；電腦版表格不變） ──
{
  setSearch(null);
  const { PRIMARY_ACTS } = await import('../modules/staff/views/list.js');
  const { CARD_CSS } = await import('../modules/staff/views/list-cards.js');
  const P3 = { emp_no: 'DZY003', name: '測試丙', status: 'disabled', brand: 'dzy', unit: 'dzy-hq', dept: 'it', title: 'hs', flags: [] };
  const P4 = { emp_no: 'DZY004', name: '測試丁', status: 'pending', brand: '', unit: '', title: '', p_brand: 'dzy', p_unit: 'dzy-hq', p_dept: 'it', p_title: 'hs', p_brand_name: '鼎兆元', has_pending_change: true, flags: [] };
  const h = (perms) => makeCtx(baseHandler((a) => (a === 'staffList' ? { ok: true, data: { staff: [P1, P3, P4] } } : null)), { perms });
  const rowOf = (el, emp) => el.innerHTML.split('<tr>').find((r) => r.includes('>' + emp + '</td>')) || '';
  const btns = (row) => Array.from(row.matchAll(/<button\b[^>]*>/g)).map((m) => ({ act: (/data-act="([^"]+)"/.exec(m[0]) || [])[1], sec: /class="btn stf-sec /.test(m[0]), more: /data-more=/.test(m[0]) }));
  const el = await mount(h(['platform.staff']));
  ok(el.innerHTML.includes('<style>') && CARD_CSS.includes('@media (max-width: 860px)') && /class="table stf-table"/.test(el.innerHTML) && /class="table-wrap stf-wrap"/.test(el.innerHTML), '18 名單注入卡片樣式、斷點 860px（跟殼一致）、表格掛 stf-table');
  const r1 = rowOf(el, 'DZY001');
  ok(['c-emp', 'c-name', 'c-org', 'c-status', 'c-claim', 'c-act'].every((c) => r1.includes('<td class="' + c + '">')), '18 每列六格都有 c-* class（卡片排版用）');
  const b1 = btns(r1);
  ok(b1.filter((b) => b.act).map((b) => b.act).slice(0, 5).join() === 'edit,unlock,unclaim,line,disable', '18 ★電腦版按鈕順序不變（改資料、解除鎖定〔2026-10-25 已開通一律有〕、撤回認領、LINE、停用）');
  ok(b1.some((b) => b.act === 'unlock' && b.sec), '18 沒被鎖的已開通同仁：解除鎖定收進「更多」（手機卡片不多一顆）');
  ok(!b1.find((b) => b.act === 'edit').sec && ['unclaim', 'line', 'disable'].every((a) => b1.find((b) => b.act === a).sec), '18 改資料是主要按鈕；撤回認領、LINE、停用收進更多');
  ok(b1.filter((b) => b.more).length === 1 && b1[b1.length - 1].more && !/data-act=/.test(r1.match(/<button[^>]*data-more[^>]*>/)[0]), '18 有次要按鈕 → 最後一顆是「更多」，且不帶 data-act（不會觸發動作）');
  const b4 = btns(rowOf(el, 'DZY004'));
  ok(['confirm', 'reject', 'edit'].every((a) => !b4.find((b) => b.act === a).sec), '18 待確認：確認、退回、改資料都露在卡片上');
  ok(['unclaim', 'disable'].every((a) => b4.find((b) => b.act === a).sec), '18 ★紅色危險鈕（撤回認領、停用）一律收進更多');
  const el2 = await mount(h([]));
  const b3 = btns(rowOf(el2, 'DZY003'));
  ok(['enable', 'reinstate'].every((a) => b3.some((b) => b.act === a && !b.sec)) && b3.some((b) => b.act === 'rename-clock' && b.sec), '18 已停用：啟用、復職露在卡片上，打卡改名收進更多');
  ok(PRIMARY_ACTS.indexOf('unclaim') === -1 && PRIMARY_ACTS.indexOf('disable') === -1 && PRIMARY_ACTS.indexOf('confirm') !== -1, '18 主要按鈕清單不含撤回認領、停用');
  ok(/\.stf-more \{ display: none; \}/.test(CARD_CSS.split('@media')[0]), '18 電腦版不顯示「更多」');
}

// ── 檢查 ──
for (const f of ['modules/staff/views/list.js', 'modules/me/views/profile.js']) {
  const s = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  ok(!/window\.(confirm|alert|prompt)|\b(?<![.\w])(alert|prompt)\(/.test(s), f + ' 沒有 window.confirm/alert/prompt');
}
// 還原 location
if (hadLocation) Object.defineProperty(globalThis, 'location', { value: origLocation, configurable: true, writable: true }); else delete globalThis.location;
console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
