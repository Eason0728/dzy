/**
 * modules/perms/views/audit.js — 權限異動分頁（admin；spec §13.1）
 * 清單：時間、誰改、原因類型、誰多了／少了什麼；對照表改動那列可展開受影響的人。
 * 「全部標為已看過」與逐列「已看過」。
 */
'use strict';

import { errorText, auditRowView, featureName } from '../lib.js';

export function mountAudit(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let data = null;
  const open = {};

  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';

  async function load() {
    const r = await ctx.api.call('perms', 'permAuditList', {});
    if (!alive) return;
    if (!r.ok) { el.innerHTML = `<div class="card"><p>${esc(r.error || '讀不到權限異動')}</p></div>`; return; }
    data = r.data || {};
    draw();
  }

  const permsText = (arr) => arr.map(esc).join('、');

  function peopleHtml(detail) {
    const people = (detail && detail.people) || [];
    if (!people.length) return '<p class="text-muted">沒有明細。</p>';
    const rows = people.map((p) => {
      const add = (p.added || []).map(featureName);
      const rem = (p.removed || []).map(featureName);
      return `<li>${esc(p.name || '')} ${esc(p.emp_no)}：${add.length ? `多了 ${permsText(add)}` : ''}${add.length && rem.length ? '；' : ''}${rem.length ? `少了 ${permsText(rem)}` : ''}</li>`;
    }).join('');
    const more = detail.affected > people.length ? `<li class="text-muted">…還有 ${detail.affected - people.length} 位沒列出</li>` : '';
    return `<ul data-role="people">${rows}${more}</ul>`;
  }

  function rowHtml(it) {
    const v = auditRowView(it);
    let body;
    if (v.isMap) {
      body = `<div>${esc(v.summary || '對照表有改動')}</div>
        <div><button type="button" class="btn btn-secondary" data-act="toggle" data-row="${it.row}">${open[it.row] ? '收起' : '看是哪些人'}</button></div>
        ${open[it.row] ? peopleHtml(v.detail) : ''}`;
    } else {
      const parts = [];
      if (v.added.length) parts.push(`<span class="tag tag-ok">多了</span> ${permsText(v.added)}`);
      if (v.removed.length) parts.push(`<span class="tag tag-danger">少了</span> ${permsText(v.removed)}`);
      body = `<div>${esc(v.who)}　${parts.join('　')}</div>`;
    }
    return `<div class="card stack" data-role="audit-item" data-row="${it.row}" data-seen="${it.seen ? '1' : '0'}"${it.seen ? ' style="opacity:.6"' : ''}>
      <div class="card-row"><div class="card-title">${esc(String(it.at || ''))}</div>${it.seen ? '<span class="tag">已看過</span>' : '<span class="tag tag-warn">未看</span>'}</div>
      <div class="text-muted">誰改的：${esc(it.by)}　原因：${esc(v.causeText)}</div>
      ${body}
      ${it.seen ? '' : `<div><button type="button" class="btn btn-secondary" data-act="seen" data-row="${it.row}">已看過</button></div>`}
    </div>`;
  }

  function draw() {
    if (data.inited === false) {
      el.innerHTML = '<div class="card"><div class="card-title">權限設定還沒初始化</div><p class="text-muted">請先到「對照表」分頁按「初始化」。</p></div>';
      return;
    }
    const items = data.items || [];
    el.innerHTML = `<div class="card stack">
        <div class="card-row"><div class="card-title">權限異動（未看 ${data.unseen || 0} 筆）</div>
          <button type="button" class="btn btn-primary" data-act="seen-all"${data.unseen ? '' : ' disabled'}>全部標為已看過</button></div>
        <p class="text-muted">同仁的權限因為換職稱、改對照表、個別例外而改變時，會記在這裡。</p></div>
      ${items.length ? items.map(rowHtml).join('') : '<div class="card"><p class="text-muted" data-role="audit-empty">目前沒有權限異動。</p></div>'}`;
  }

  async function mark(payload) {
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('perms', 'permAuditSeen', payload); } finally { ctx.ui.loading(false); }
    if (!alive || r.dryrun) return;
    if (!r.ok) { ctx.ui.toast(errorText(r), 'danger'); return; }
    ctx.ui.toast('已標為已看過', 'ok');
    await load();
  }

  const onClick = (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn || !el.contains(btn) || btn.disabled) return;
    const act = btn.getAttribute('data-act');
    if (act === 'seen-all') mark({ all: true });
    else if (act === 'seen') mark({ rows: [Number(btn.getAttribute('data-row'))] });
    else if (act === 'toggle') { const n = btn.getAttribute('data-row'); open[n] = !open[n]; draw(); }
  };
  el.addEventListener('click', onClick);
  load();
  return () => { alive = false; el.removeEventListener('click', onClick); };
}
