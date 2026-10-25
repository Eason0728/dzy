/**
 * 月結鎖定（spec §7）：選店 → adminLocks → 列最近 12 個月，各月狀態（未鎖／店長鎖定／會計鎖定＋誰、何時）＋鎖定／解鎖鈕。
 * 解鎖要二次確認（解鎖後店長可以改這個月的帳）。會計鎖的月份店長自己解不開（現金帳伺服器 LOCKED_BY_ACCT）。
 */
'use strict';

import { getStores, settle, sel } from '../state.js';
import { errText, monthOptions, isLocked, lockKind, lockLabel } from '../lib/util.js';
import { storeSelectHtml, noticeHtml, NO_STORES } from './common.js';

export function mountLock(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let stores = [];
  let locks = null;     // adminLocks 的 locks[]
  let busy = false;
  let seq = 0;

  function head(msg) {
    return `<div class="card stack">${storeSelectHtml(esc, stores, sel.store, 'cb-store')}
      <p class="field-hint" data-role="cb-msg">${esc(msg || '')}</p></div>`;
  }

  function tableHtml() {
    const months = monthOptions(new Date(), 12);
    const byMonth = {};
    (locks || []).forEach((x) => { if (x && x.month && isLocked(x)) byMonth[x.month] = x; });
    const body = months.map((m) => {
      const rec = byMonth[m];
      const kind = lockKind(rec);
      const who = rec ? `${esc(rec.lockedBy || (kind === 'store' ? '店長' : ''))}　${esc(rec.lockedAt || '')}` : '';
      const tag = kind === 'none' ? '<span class="tag">未鎖</span>' : kind === 'acct' ? `<span class="tag tag-ok">${esc(lockLabel(rec))}</span>` : `<span class="tag tag-warn">${esc(lockLabel(rec))}</span>`;
      // 店長鎖的月份：會計可「改為會計鎖定」接手（現金帳 adminLock 會把來源改成會計），之後店長解不開
      const lockBtn = (label) => `<button type="button" class="btn btn-primary" data-act="lock" data-month="${esc(m)}">${label}</button>`;
      const unlockBtn = `<button type="button" class="btn btn-secondary" data-act="unlock" data-month="${esc(m)}">解鎖</button>`;
      const btn = kind === 'none' ? lockBtn('鎖定') : kind === 'acct' ? unlockBtn : `${lockBtn('改為會計鎖定')} ${unlockBtn}`;
      return `<tr data-role="cb-lock-row" data-month="${esc(m)}" data-kind="${kind}"><td>${esc(m)}</td><td>${tag}</td><td>${who}</td><td>${btn}</td></tr>`;
    }).join('');
    return `<div class="card stack"><div class="table-wrap"><table class="table" data-role="cb-lock-table">
      <thead><tr><th>月份</th><th>狀態</th><th>誰・何時</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
      <p class="field-hint">鎖定後這個月的帳不能再新增、修改或作廢。會計鎖的月份，店長自己解不開，要由這裡解鎖。</p></div>`;
  }

  function draw(msg) { el.innerHTML = head(msg) + (locks ? tableHtml() : ''); }

  async function load() {
    const mine = ++seq;
    if (!sel.store) { el.innerHTML = noticeHtml(esc, NO_STORES); return; }
    locks = null;
    draw('讀取中…');
    let r;
    try { r = await ctx.api.call('cashbook', 'adminLocks', { store: sel.store }); } catch (e) { r = null; }
    if (!alive || mine !== seq) return;
    if (!r || !r.ok) { draw(errText(r)); return; }
    locks = Array.isArray(r.data && r.data.locks) ? r.data.locks : [];
    draw('');
  }

  async function change(action, month) {
    if (busy) return;
    const store = stores.find((s) => s.code === sel.store);
    const name = (store && store.name) || sel.store;
    if (action === 'adminLock') {
      if (!(await ctx.ui.confirm(`確定要由會計鎖定「${name}」${month} 的帳？鎖定後這個月不能再新增、修改或作廢，店長也不能自己解鎖。`))) return;
    } else {
      if (!(await ctx.ui.confirm(`確定要解鎖「${name}」${month} 的帳？解鎖後店長可以修改這個月的帳。`))) return;
      if (!(await ctx.ui.confirm(`再確認一次：真的要解鎖「${name}」${month} 嗎？這個動作會留下紀錄。`))) return;
    }
    if (!alive) return;
    busy = true;
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('cashbook', action, { store: sel.store, month }); } catch (e) { r = null; } finally { ctx.ui.loading(false); busy = false; }
    if (!alive) return;
    if (!r || !r.ok) { ctx.ui.toast(errText(r), 'danger'); await load(); return; }
    ctx.ui.toast(r.data && r.data.dryRun ? '試跑模式：未實際寫入' : (action === 'adminLock' ? '已鎖定' : '已解鎖'), 'ok');
    await load();
  }

  function onClick(e) {
    const b = e.target && e.target.closest && e.target.closest('[data-act]');
    if (!b) return;
    const a = b.getAttribute('data-act');
    if (a === 'lock') change('adminLock', b.getAttribute('data-month'));
    else if (a === 'unlock') change('adminUnlock', b.getAttribute('data-month'));
  }
  function onChange(e) {
    const t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-role') === 'cb-store') { sel.store = t.value; load(); }
  }

  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  (async () => {
    el.innerHTML = noticeHtml(esc, '讀取中…');
    const s = await getStores(ctx);
    if (!alive) return;
    if (!s.ok) { el.innerHTML = noticeHtml(esc, errText(s.raw), 'cb-error'); return; }
    stores = s.stores;
    settle(stores, ctx.params);
    load();
  })();
  return () => { alive = false; el.removeEventListener('click', onClick); el.removeEventListener('change', onChange); };
}
