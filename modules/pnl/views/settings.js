/**
 * modules/pnl/views/settings.js — 損益試算「設定」頁（只有 pnl.admin 看得到；T17＋T18）
 * 分頁：門市｜科目｜門市科目｜連接器｜匯入範本｜系統設定｜使用者｜月份作業｜匯出 CSV｜維護
 *   表格編輯（settings-tables.js）：存檔 → saveSettings 帶 base_version（樂觀鎖），CONFLICT 時重讀。
 *   月份作業／匯出／維護（settings-ops.js）。純函式在 settings-lib.js。
 * 行為正本：~/mala-pnl-auto/gas/settings.html（不要外觀、登入、邀請碼、通行碼、登出所有裝置）。
 */
'use strict';

import { call, errText } from '../lib/api.js';
import { getSettings, isAdmin, invalidateSettings } from '../state.js';
import { currentMonth } from '../bridge.js';
import { loadingHtml, noticeHtml, errorHtml } from './common.js';
import { clone, shiftMonth, mapRowsFrom, shadowUsers, diffIsEmpty } from './settings-lib.js';
import { TABLE_SECTIONS } from './settings-tables.js';
import { OPS_SECTIONS } from './settings-ops.js';

const SECTIONS = TABLE_SECTIONS.concat(OPS_SECTIONS);

const CSS = `.pnl-set-nav{display:flex;flex-wrap:wrap;gap:8px}
.pnl-secret{-webkit-text-security:disc;text-security:disc}
.pnl-set-err{color:var(--danger,#c0392b)}
.pnl-set-wrap .table input.input,.pnl-set-wrap .table select.input{min-width:110px}
.pnl-set-wrap .table textarea.input{min-width:200px}
.pnl-set-diff-list{margin:4px 0 8px 18px;padding:0}
.pnl-set-warn{color:var(--danger,#c0392b);font-weight:600;margin:6px 0}`;

function makeDraft(data) {
  return {
    stores: clone(data.stores || []),
    accounts: clone(data.accounts || []),
    storeAccounts: clone(data.storeAccounts || []),
    templates: clone(data.templates || []),
    connectors: (data.connectors || []).map((c) => Object.assign(clone(c), { key: '', newUrl: '', _mapRows: mapRowsFrom(c) })),
    users: shadowUsers(data.users).map((u) => ({ name: u.name, role: u.role, stores: clone(u.stores || []) })),
    system: clone(data.system || {})
  };
}

function textNode(tag, text, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.textContent = text;
  return n;
}

export function mountSettings(el, ctx) {
  const esc = ctx.fmt.esc;
  const S = { ctx, esc, alive: true, data: null, draft: null, tab: 'stores', panelEl: null, ops: null, accErrs: {}, saStore: '' };
  const dialogs = new Set();
  let loadSeq = 0;

  S.toast = (msg, type) => ctx.ui.toast(msg, type);
  S.err = (text) => { const e = S.panelEl && S.panelEl.querySelector('[data-role="pnl-set-err"]'); if (e) e.textContent = text || ''; };
  function applyMsg(key) {
    const m = S.ops && S.ops.msgs[key];
    const n = S.panelEl && S.panelEl.querySelector('[data-say="' + key + '"]');
    if (!n || !m) return;
    n.textContent = m.text;
    n.classList.toggle('pnl-set-err', m.err);
  }
  S.say = (key, text, isErr) => {
    if (!S.ops) return;
    S.ops.msgs[key] = { text: text || '', err: !!isErr };
    applyMsg(key);
  };
  S.lines = (arr) => { const d = document.createElement('div'); arr.forEach((t) => d.appendChild(textNode('div', t))); return d; };

  function track(p) { dialogs.add(p); p.then(() => dialogs.delete(p), () => dialogs.delete(p)); return p; }
  S.ask = async (title, body, confirmLabel, variant) => {
    const v = await track(ctx.ui.dialog({ title, body, actions: [{ label: '取消', value: false, variant: 'secondary' }, { label: confirmLabel || '確定', value: true, variant: variant || 'primary' }] }));
    return v === true;
  };
  S.confirmDiff = (title, diff, notes, warnings) => {
    const box = document.createElement('div');
    box.setAttribute('data-role', 'pnl-set-diff');
    (warnings || []).forEach((w) => box.appendChild(textNode('div', w, 'pnl-set-warn')));
    [['新增', diff.added], ['修改', diff.changed], ['刪除', diff.removed]].forEach(([label, arr]) => {
      if (!arr.length) return;
      box.appendChild(textNode('div', label + '（' + arr.length + '）', 'field-label'));
      const ul = document.createElement('ul');
      ul.className = 'pnl-set-diff-list';
      arr.forEach((x) => ul.appendChild(textNode('li', x)));
      box.appendChild(ul);
    });
    (notes || []).forEach((n) => box.appendChild(textNode('div', n, 'field-label')));
    if (diffIsEmpty(diff) && !(notes || []).length && !(warnings || []).length) box.appendChild(textNode('div', '沒有變更', 'text-muted'));
    return S.ask(title + ' 存檔預覽', box, '確認存檔');
  };
  S.promptReason = async (title, msg) => {
    const box = document.createElement('div');
    box.appendChild(textNode('div', msg));
    const inp = document.createElement('input');
    inp.className = 'input'; inp.type = 'text'; inp.placeholder = '原因（必填）'; inp.setAttribute('data-role', 'pnl-set-reason');
    box.appendChild(inp);
    const ok = await S.ask(title, box, '確定');
    return ok ? inp.value.trim() : null;
  };

  /** saveSettings：帶 base_version；CONFLICT 重讀；回 {ok,...} */
  S.saveTable = async (table, rows) => {
    const payload = { table, rows };
    const bv = S.data.versions && S.data.versions[table];
    if (bv) payload.base_version = bv;
    ctx.ui.loading(true);
    let r;
    try { r = await call(ctx, 'saveSettings', payload); } finally { ctx.ui.loading(false); }
    if (!S.alive) return { ok: false, error: 'GONE' };
    if (r.ok) {
      if (r.data && typeof r.data.version === 'string') { if (!S.data.versions) S.data.versions = {}; S.data.versions[table] = r.data.version; }
      invalidateSettings();
      return r;
    }
    if (r.error === 'CONFLICT') {
      S.toast('別人剛改過，已重新載入，請重新確認後再存一次', 'warn');
      await S.reload();
      return r;
    }
    S.toast(errText(r), 'danger');
    S.err(errText(r));
    return r;
  };

  const section = () => SECTIONS.filter((s) => s.id === S.tab)[0] || SECTIONS[0];
  const navHtml = () => `<div class="pnl-set-nav" role="tablist" data-role="pnl-set-nav">${SECTIONS.map((s) => `<button type="button" role="tab" class="btn ${s.id === S.tab ? 'btn-primary' : 'btn-secondary'}" aria-selected="${s.id === S.tab}" data-act="tab" data-tab="${s.id}" data-role="pnl-set-tab">${esc(s.label)}</button>`).join('')}</div>`;

  S.redraw = () => {
    if (!S.alive || !S.draft) return;
    S.panelEl.innerHTML = section().render(S);
    Array.prototype.forEach.call(S.panelEl.querySelectorAll('[data-say]'), (n) => applyMsg(n.getAttribute('data-say')));
    el.querySelector('[data-role="pnl-set-navbox"]').innerHTML = navHtml();
  };

  function initOps(data) {
    const thisMonth = currentMonth();
    const active = (data.stores || []).filter((s) => s.active);
    const first = active[0] ? active[0].store_id : '';
    const keep = (cur) => (cur && active.some((s) => s.store_id === cur) ? cur : first);
    const o = S.ops || {
      createMonth: shiftMonth(thisMonth, -1), refreshMonth: thisMonth, finMonth: shiftMonth(thisMonth, -1), exportMonth: thisMonth,
      exportStore: first || 'ALL', fin: null, finZero: {}, msgs: {}, lastLines: [], selfcheck: null
    };
    o.createStore = keep(o.createStore); o.refreshStore = keep(o.refreshStore); o.finStore = keep(o.finStore);
    S.ops = o;
  }

  S.reload = async () => {
    const mine = ++loadSeq;
    S.draft = null;
    S.panelEl.innerHTML = loadingHtml('設定資料載入中…');
    const r = await getSettings(ctx, true);
    if (!S.alive || mine !== loadSeq) return;
    if (!r.ok) { S.panelEl.innerHTML = errorHtml(esc, errText(r)); return; }
    if (!isAdmin(r.data)) { S.panelEl.innerHTML = noticeHtml(esc, '只有管理者看得到設定頁。', 'pnl-set-denied'); return; }
    S.data = clone(r.data);
    ['stores', 'accounts', 'storeAccounts', 'templates', 'connectors', 'users'].forEach((k) => { S.data[k] = S.data[k] || []; });
    S.data.system = S.data.system || {};
    S.draft = makeDraft(S.data);
    S.accErrs = {};
    initOps(S.data);
    S.redraw();
  };

  const within = (ev, sel) => { const t = ev.target && ev.target.closest ? ev.target.closest(sel) : null; return t && el.contains(t) ? t : null; };
  async function dispatch(kind, t) {
    try {
      if (kind === 'click' && t.dataset.act === 'tab') { S.tab = t.dataset.tab; if (S.draft) S.redraw(); return; }
      if (kind === 'click' && t.dataset.act === 'pnl-retry') { await S.reload(); return; }
      if (!S.draft) return;
      await section().event(S, kind, t);
    } catch (e) {
      S.toast('發生錯誤：' + (e && e.message ? e.message : e), 'danger');
    }
  }
  const onClick = (ev) => { const t = within(ev, '[data-act]'); if (t) dispatch('click', t); };
  const onInput = (ev) => { const t = within(ev, '[data-f]'); if (t) dispatch('input', t); };
  const onChange = (ev) => { const t = within(ev, '[data-fc]'); if (t) dispatch('change', t); };
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  el.addEventListener('change', onChange);

  const wanted = ctx.params && ctx.params.tab;
  if (wanted && SECTIONS.some((s) => s.id === wanted)) S.tab = wanted;
  el.innerHTML = `<style data-pnl="settings">${CSS}</style><div class="stack pnl-set-wrap" data-role="pnl-settings"><div class="card" data-role="pnl-set-navbox">${navHtml()}</div><div data-role="pnl-set-panel"></div></div>`;
  S.panelEl = el.querySelector('[data-role="pnl-set-panel"]');
  S.reload();

  return function unmount() {
    S.alive = false;
    loadSeq++;
    el.removeEventListener('click', onClick);
    el.removeEventListener('input', onInput);
    el.removeEventListener('change', onChange);
    dialogs.forEach((p) => { try { p.close(false); } catch (e) { /* 已關 */ } });
    dialogs.clear();
  };
}
