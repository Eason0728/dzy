/**
 * modules/perms/views/map.js — 對照表分頁（spec §7.1-1、§13.1）
 * 列＝9 個功能，chip＝目前給了哪些對象；chip 可刪、「新增對象」三段選（階梯→總部才有部門→職稱）。
 * 鎖住的功能（platform.users／platform.permmap）對非 admin 灰掉。
 */
'use strict';

import { featureRows, errorText } from '../lib.js';

export function mountMap(el, ctx) {
  const esc = ctx.fmt.esc;
  const isAdmin = !!(ctx.user && ctx.user.role === 'admin');
  let alive = true;
  let data = null;
  let openDialog = null;

  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';

  async function load() {
    const r = await ctx.api.call('perms', 'permMapGet', {});
    if (!alive) return;
    if (!r.ok) { el.innerHTML = `<div class="card"><p>${esc(r.error || '讀不到對照表')}</p></div>`; return; }
    data = r.data || {};
    draw();
  }

  function drawNotInited() {
    el.innerHTML = isAdmin
      ? `<div class="card stack" data-role="not-inited">
          <div class="card-title">權限設定還沒初始化</div>
          <p class="text-muted">第一次使用要先建立權限用的分頁並放入預設規則。</p>
          <div><button type="button" class="btn btn-primary" data-act="init">初始化</button></div>
        </div>`
      : `<div class="card" data-role="not-inited"><div class="card-title">權限設定還沒初始化</div><p class="text-muted">請系統管理員初始化。</p></div>`;
  }

  function draw() {
    if (data.inited === false) { drawNotInited(); return; }
    const canEdit = (row) => isAdmin || !row.locked;
    const rows = featureRows(data).map((row) => {
      const editable = canEdit(row);
      const chips = row.rules.length
        ? row.rules.map((ru) => `<span class="tag" data-role="chip" data-rule="${esc(ru.rule_id)}" style="gap:var(--space-2)">${esc(ru.text)}${editable ? `<button type="button" data-act="del" data-rule="${esc(ru.rule_id)}" data-text="${esc(ru.text)}" data-perm="${esc(row.perm)}" aria-label="移除 ${esc(ru.text)}" style="background:none;border:0;cursor:pointer;color:inherit;padding:0 2px;font-size:var(--fs-base)">×</button>` : ''}</span>`).join(' ')
        : '<span class="text-muted">還沒有人</span>';
      return `<div class="card stack" data-role="feature-row" data-perm="${esc(row.perm)}"${row.locked ? ' data-locked="1"' : ''}${editable ? '' : ' style="opacity:.6"'}>
        <div class="card-row"><div class="card-title">${esc(row.name)}${row.locked ? ' <span class="tag tag-warn">鎖定</span>' : ''}</div>
          <button type="button" class="btn btn-secondary" data-act="add" data-perm="${esc(row.perm)}"${editable ? '' : ' disabled'}>新增對象</button></div>
        <div data-role="chips" style="display:flex;flex-wrap:wrap;gap:var(--space-2)">${chips}</div>
        ${editable ? '' : '<p class="field-hint" data-role="lock-note">只有系統管理員能改</p>'}
      </div>`;
    }).join('');
    el.innerHTML = `<div class="card stack"><div class="card-title">權限對照表</div>
      <p class="text-muted">每個功能給哪些單位・職稱的同仁用。改完馬上生效，同仁下次登入或重新整理後看到。</p></div>${rows}`;
  }

  async function doSave(payload, okText) {
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('perms', 'permMapSave', payload); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (r.dryrun) return;
    if (!r.ok) { ctx.ui.toast(errorText(r), 'danger'); return; }
    const n = r.data && typeof r.data.affected === 'number' ? r.data.affected : 0;
    ctx.ui.toast(`${okText}${n ? `，影響 ${n} 位同仁` : ''}`, 'ok');
    await load();
  }

  function addDialogBody(perm) {
    const ladders = data.ladders || [];
    const body = document.createElement('div');
    body.className = 'stack';
    const opt = (v, t) => `<option value="${esc(v)}">${esc(t)}</option>`;
    body.innerHTML = `
      <div class="field"><label class="field-label" for="pm-ladder">單位階梯</label>
        <select class="input" id="pm-ladder" data-role="pm-ladder">${ladders.map((l) => opt(l.code, l.name)).join('')}</select></div>
      <div class="field" data-role="pm-dept-wrap" hidden><label class="field-label" for="pm-dept">部門</label>
        <select class="input" id="pm-dept" data-role="pm-dept">${opt('', '全部部門')}${(data.depts || []).map((d) => opt(d.code, d.name)).join('')}</select></div>
      <div class="field"><label class="field-label" for="pm-title">職稱</label>
        <select class="input" id="pm-title" data-role="pm-title"></select></div>`;
    const ladderEl = body.querySelector('#pm-ladder');
    const deptWrap = body.querySelector('[data-role="pm-dept-wrap"]');
    const titleEl = body.querySelector('#pm-title');
    const sync = () => {
      const lad = ladderEl.value;
      deptWrap.hidden = lad !== 'hq';
      const titles = (data.titles || []).filter((t) => t.ladder === lad).sort((a, b) => (a.rank || 0) - (b.rank || 0));
      titleEl.innerHTML = opt('*', '全部職稱') + titles.map((t) => opt(t.code, t.name)).join('');
    };
    ladderEl.addEventListener('change', sync);
    sync();
    body.read = () => ({
      ladder: ladderEl.value,
      dept: ladderEl.value === 'hq' ? body.querySelector('#pm-dept').value : '',
      title: titleEl.value,
      perm
    });
    return body;
  }

  async function onAdd(perm) {
    const body = addDialogBody(perm);
    const name = featureRows(data).find((r) => r.perm === perm).name;
    const p = ctx.ui.dialog({
      title: `「${name}」新增對象`,
      body,
      actions: [{ label: '取消', value: false, variant: 'secondary' }, { label: '新增', value: true, variant: 'primary' }]
    });
    openDialog = p;
    const v = await p;
    openDialog = null;
    if (v !== true || !alive) return;
    await doSave({ add: [body.read()] }, '已新增對象');
  }

  async function onDel(btn) {
    const text = btn.getAttribute('data-text');
    const name = featureRows(data).find((r) => r.perm === btn.getAttribute('data-perm')).name;
    const yes = await ctx.ui.confirm(`要把「${text}」從「${name}」拿掉嗎？這些人會馬上失去這個功能。`);
    if (!yes || !alive) return;
    await doSave({ remove: [btn.getAttribute('data-rule')] }, '已移除');
  }

  async function onInit() {
    const yes = await ctx.ui.confirm('初始化會建立四張權限分頁（對照表、個別例外、店別對照、權限異動），並放入 19 條預設規則。確定要初始化嗎？');
    if (!yes || !alive) return;
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('perms', 'permInit', {}); } finally { ctx.ui.loading(false); }
    if (!alive || r.dryrun) return;
    if (!r.ok) { ctx.ui.toast(errorText(r), 'danger'); return; }
    ctx.ui.toast('已初始化', 'ok');
    await load();
  }

  const onClick = (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn || !el.contains(btn) || btn.disabled) return;
    const act = btn.getAttribute('data-act');
    if (act === 'add') onAdd(btn.getAttribute('data-perm'));
    else if (act === 'del') onDel(btn);
    else if (act === 'init') onInit();
  };
  el.addEventListener('click', onClick);
  load();
  return () => {
    alive = false;
    el.removeEventListener('click', onClick);
    if (openDialog && typeof openDialog.close === 'function') openDialog.close(false);
  };
}
