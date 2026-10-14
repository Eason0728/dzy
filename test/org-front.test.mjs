// node test/org-front.test.mjs —— 組織改版 T5／T6 前端：兼任部門、flags 標籤、需處理篩選、切換／退回組織、我的資料兼任
// 沒有 jsdom：用極簡假 DOM。全部假資料。
'use strict';
import fs from 'node:fs';

globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
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
  ctx.fills.push((body) => { body.querySelector('#ed-x-training').checked = false; body.querySelector('#ed-x-ops').checked = true; body.querySelector('#ed-x-ck').checked = true; });
  el.querySelector('[data-role="rows"]').fire('click', { target: btn('edit', 'DZY001') });
  await flush();
  const body = ctx.dialogs[0].body.innerHTML;
  ok(body.includes('id="ed-x-training"') && body.includes('id="ed-x-ops"') && body.includes('id="ed-x-ck"') && body.includes('中央工廠'), 'T5 對話框列 dzy-hq 部門＋中央工廠');
  ok(!body.includes('id="ed-x-it"'), 'T5 排除這個人的主要部門（it）');
  ok(!body.includes('id="ed-x-zzz"'), 'T5 不列別的單位底下的部門');
  ok(/id="ed-x-training"[^>]*checked/.test(body), 'T5 目前兼任預先勾選');
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
  ctx.fills.push((body) => { body.querySelector('#ed-x-training').checked = false; });
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
  ok(!ctx.dialogs[0].body.innerHTML.includes('ed-x-'), 'T5 ★沒有 platform.staff 看不到兼任區');
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

// ── 檢查 ──
for (const f of ['modules/staff/views/list.js', 'modules/me/views/profile.js']) {
  const s = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  ok(!/window\.(confirm|alert|prompt)|\b(?<![.\w])(alert|prompt)\(/.test(s), f + ' 沒有 window.confirm/alert/prompt');
}
console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
