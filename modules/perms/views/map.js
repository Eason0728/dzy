/**
 * modules/perms/views/map.js — 對照表分頁（版本 B：先選身分、再開關功能；spec §7.1-1、§13.1、§13.2）
 * 左：身分清單（含人數）；右：選中身分的 11 個功能開關；底：未儲存摘要＋還原＋儲存（先 preview 名單、確認才正式送出）；
 * 上：搜尋同仁（permWho）。鎖碼功能（permMapGet.locked）對非 admin 顯示「只有系統管理員能改」並 disabled。
 */
'use strict';

import {
  featureRows, errorText, identityGroups, identityName, isOn, pendingChanges, buildPayload,
  alsoFrom, changeSummary, previewView, whoLines, scopeLabel, FEATURE_DESC
} from '../lib.js';

const SEARCH_DEBOUNCE_MS = 300;

export function mountMap(el, ctx) {
  const esc = ctx.fmt.esc;
  const isAdmin = !!(ctx.user && ctx.user.role === 'admin');
  let alive = true;
  let data = null;
  let sel = '';
  let pending = {};
  let openDialog = null;
  let searchTimer = null;
  let searchSeq = 0;

  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';

  async function load() {
    const r = await ctx.api.call('perms', 'permMapGet', {});
    if (!alive) return;
    if (!r.ok) { el.innerHTML = `<div class="card"><p>${esc(r.error || '讀不到對照表')}</p></div>`; return; }
    data = r.data || {};
    pending = {};
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

  // ---------- 畫面骨架 ----------
  function draw() {
    if (data.inited === false) { drawNotInited(); return; }
    const groups = identityGroups(data);
    if (!sel || !groups.some((g) => g.items.some((i) => i.key === sel))) {
      sel = groups.length && groups[0].items.length ? groups[0].items[0].key : '';
    }
    el.innerHTML = `<div class="pm-wrap" data-role="perm-map">
      <div class="card stack"><div class="card-title">權限對照表</div>
        <p class="text-muted">先選左邊的身分，再開關右邊的功能。改完先不生效，按底下的「儲存」確認名單後才生效；同仁下次登入或重新整理後看到。</p></div>
      <div class="pm-search" data-role="who-box">
        <label class="field-label" for="pm-q">查同仁</label>
        <input class="input" id="pm-q" data-role="who-input" type="search" placeholder="輸入姓名或編號（例：DZY012）" autocomplete="off">
        <div class="pm-who-result" data-role="who-result" aria-live="polite"></div>
      </div>
      <div class="pm-grid">
        <div class="pm-roles" data-role="role-list" role="listbox" aria-label="身分"></div>
        <div class="pm-panel" data-role="role-panel"></div>
      </div>
      <div class="pm-bar" data-role="save-bar"></div>
    </div>`;
    drawList();
    drawPanel();
    drawBar();
  }

  function drawList() {
    const host = el.querySelector('[data-role="role-list"]');
    if (!host) return;
    const top = host.scrollTop;
    const counts = data.counts || {};
    const dirtyKeys = {};
    pendingChanges(data, pending).forEach((c) => { dirtyKeys[c.key] = true; });
    host.innerHTML = identityGroups(data).map((g) => `<div class="pm-group" data-group="${esc(g.id)}">
      <div class="pm-group-title">${esc(g.title)}</div>
      ${g.items.map((it) => {
        const n = counts[it.key];
        return `<button type="button" class="pm-role${it.key === sel ? ' is-active' : ''}" role="option" aria-selected="${it.key === sel}" data-act="pick" data-key="${esc(it.key)}">
          <span>${esc(it.name)}${dirtyKeys[it.key] ? ' <span class="pm-dirty" aria-label="有未儲存變更">●</span>' : ''}</span>
          <small data-role="role-count">${typeof n === 'number' ? `${n} 人` : ''}</small></button>`;
      }).join('')}
    </div>`).join('');
    host.scrollTop = top;
  }

  function drawPanel() {
    const host = el.querySelector('[data-role="role-panel"]');
    if (!host) return;
    if (!sel) { host.innerHTML = '<p class="text-muted">沒有可選的身分</p>'; return; }
    const counts = data.counts || {};
    const n = counts[sel];
    const rows = featureRows(data).map((row) => {
      const editable = isAdmin || !row.locked;
      const on = isOn(data, pending, sel, row.perm);
      const changed = on !== isOn(data, null, sel, row.perm);
      const also = alsoFrom(data, pending, sel, row.perm);
      return `<div class="pm-row" data-role="feature-row" data-perm="${esc(row.perm)}"${row.locked ? ' data-locked="1"' : ''}>
        <div>
          <div class="pm-row-title">${esc(row.name)}${row.locked ? ' <span class="pm-locktag" data-role="lock-note">只有系統管理員能改</span>' : ''}</div>
          <div class="pm-row-desc">${esc(FEATURE_DESC[row.perm] || '')}</div>
          ${also.length ? `<div class="pm-also" data-role="also">也從『${esc(also.join('』『'))}』拿到</div>` : ''}
        </div>
        <button type="button" class="pm-switch${on ? ' is-on' : ''}${changed ? ' is-changed' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(row.name)}"
          data-act="toggle" data-perm="${esc(row.perm)}"${editable ? '' : ' disabled'}></button>
      </div>`;
    }).join('');
    host.innerHTML = `<div class="pm-who"><b data-role="role-name">${esc(identityName(data, sel))}</b>
      <span class="text-muted">${typeof n === 'number' ? `目前 ${n} 人・` : ''}每個人都另外有「我的資料、公告專區」</span></div>${rows}`;
  }

  function drawBar() {
    const host = el.querySelector('[data-role="save-bar"]');
    if (!host) return;
    const changes = pendingChanges(data, pending);
    host.innerHTML = `<div class="pm-bar-msg" data-role="bar-msg">${changes.length
      ? `未儲存：<b>${esc(changeSummary(data, changes))}</b>`
      : '<span class="text-muted">沒有未儲存的變更</span>'}</div>
      <div class="btn-row">
        <button type="button" class="btn btn-secondary" data-act="revert"${changes.length ? '' : ' disabled'}>還原</button>
        <button type="button" class="btn btn-primary" data-act="save"${changes.length ? '' : ' disabled'}>儲存</button>
      </div>`;
  }

  // ---------- 動作 ----------
  function onToggle(perm) {
    if (!sel) return;
    const row = featureRows(data).find((r) => r.perm === perm);
    if (!row || (!isAdmin && row.locked)) return;
    const next = !isOn(data, pending, sel, perm);
    const pk = `${sel}|${perm}`;
    if (next === isOn(data, null, sel, perm)) delete pending[pk]; else pending[pk] = next;
    drawList();
    drawPanel();
    drawBar();
  }

  function onRevert() {
    pending = {};
    drawList();
    drawPanel();
    drawBar();
  }

  function previewBody(view) {
    const body = document.createElement('div');
    body.className = 'stack';
    body.setAttribute('data-role', 'preview-body');
    body.innerHTML = view.total
      ? `<p>這次會讓 <b>${view.total}</b> 位同仁的權限改變：</p>
         <ul class="pm-preview-list">${view.lines.map((l) => `<li data-role="preview-person"><b>${esc(l.who)}</b>　${esc(l.text)}</li>`).join('')}</ul>
         ${view.rest ? `<p class="text-muted" data-role="preview-rest">其餘 ${view.rest} 人</p>` : ''}`
      : '<p>這次修改不會改到任何同仁的權限。</p>';
    return body;
  }

  async function onSave() {
    const changes = pendingChanges(data, pending);
    if (!changes.length) return;
    const payload = buildPayload(data, changes);
    ctx.ui.loading(true);
    let pv;
    try { pv = await ctx.api.call('perms', 'permMapSave', Object.assign({ preview: true }, payload)); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (pv.dryrun) { ctx.ui.toast('試跑模式不會寫入', 'warn'); return; }
    if (!pv.ok) { ctx.ui.toast(errorText(pv), 'danger'); return; }
    const view = previewView(pv.data && pv.data.people, 30);
    const p = ctx.ui.dialog({
      title: '確認儲存',
      body: previewBody(view),
      actions: [{ label: '取消', value: false, variant: 'secondary' }, { label: '確認儲存', value: true, variant: 'primary' }]
    });
    openDialog = p;
    const v = await p;
    openDialog = null;
    if (v !== true || !alive) return;
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('perms', 'permMapSave', payload); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (r.dryrun) { ctx.ui.toast('試跑模式不會寫入', 'warn'); return; }
    if (!r.ok) { ctx.ui.toast(errorText(r), 'danger'); return; }
    const n = r.data && typeof r.data.affected === 'number' ? r.data.affected : 0;
    ctx.ui.toast(`已儲存${n ? `，影響 ${n} 位同仁` : ''}`, 'ok');
    await load();
  }

  async function onInit() {
    const yes = await ctx.ui.confirm('初始化會建立四張權限分頁（對照表、個別例外、店別對照、權限異動），並放入 20 條預設規則。確定要初始化嗎？');
    if (!yes || !alive) return;
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('perms', 'permInit', {}); } finally { ctx.ui.loading(false); }
    if (!alive || r.dryrun) return;
    if (!r.ok) { ctx.ui.toast(errorText(r), 'danger'); return; }
    ctx.ui.toast('已初始化', 'ok');
    await load();
  }

  // ---------- 搜尋同仁 ----------
  function drawWho(items, msg) {
    const host = el.querySelector('[data-role="who-result"]');
    if (!host) return;
    if (msg !== undefined) { host.innerHTML = msg ? `<p class="text-muted" data-role="who-msg">${esc(msg)}</p>` : ''; return; }
    host.innerHTML = items.map((it) => {
      const lines = whoLines(it);
      const scope = scopeLabel(it.audit_scope, it.perms);
      return `<div class="pm-who-item" data-role="who-item" data-emp="${esc(it.emp_no)}">
        <div><b>${esc(it.name)}</b>（${esc(it.emp_no)}）<span class="text-muted">${esc([it.unit_name, it.dept_name, it.title_name].filter(Boolean).join('・'))}</span></div>
        ${lines.length
          ? `<ul class="pm-who-list">${lines.map((l) => `<li data-perm="${esc(l.perm)}"><b>${esc(l.name)}</b>　<span class="text-muted">${esc(l.texts.join('、'))}</span></li>`).join('')}</ul>`
          : '<div class="text-muted">目前沒有額外的功能（每個人都有「我的資料、公告專區」）</div>'}
        ${scope ? `<div class="text-muted">稽核範圍：${esc(scope)}</div>` : ''}
      </div>`;
    }).join('');
  }

  async function runSearch() {
    const input = el.querySelector('[data-role="who-input"]');
    if (!input) return;
    const q = input.value.trim();
    const seq = ++searchSeq;
    if (!q) { drawWho([], ''); return; }
    const r = await ctx.api.call('perms', 'permWho', { q });
    if (!alive || seq !== searchSeq) return;
    if (r.dryrun) { drawWho([], '試跑模式查不到同仁'); return; }
    if (!r.ok) { drawWho([], errorText(r)); return; }
    const items = (r.data && r.data.items) || [];
    if (!items.length) { drawWho([], '找不到這位同仁（只找在職的）'); return; }
    drawWho(items);
  }

  const onInput = (ev) => {
    if (!ev.target.matches || !ev.target.matches('[data-role="who-input"]')) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
  };
  const onKeydown = (ev) => {
    if (ev.key !== 'Enter' || !ev.target.matches || !ev.target.matches('[data-role="who-input"]')) return;
    ev.preventDefault();
    clearTimeout(searchTimer);
    runSearch();
  };

  const onClick = (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn || !el.contains(btn) || btn.disabled) return;
    const act = btn.getAttribute('data-act');
    if (act === 'pick') { sel = btn.getAttribute('data-key'); drawList(); drawPanel(); }
    else if (act === 'toggle') onToggle(btn.getAttribute('data-perm'));
    else if (act === 'revert') onRevert();
    else if (act === 'save') onSave();
    else if (act === 'init') onInit();
  };
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  el.addEventListener('keydown', onKeydown);
  load();
  return () => {
    alive = false;
    clearTimeout(searchTimer);
    el.removeEventListener('click', onClick);
    el.removeEventListener('input', onInput);
    el.removeEventListener('keydown', onKeydown);
    if (openDialog && typeof openDialog.close === 'function') openDialog.close(false);
  };
}
