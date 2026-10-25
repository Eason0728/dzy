/**
 * modules/perms/views/ex.js — 個別例外分頁（admin；人資主管只看得到、只能設 store.void／att.extra；spec §7.1-2、docs/approver/spec.md §13.1）
 * 清單：同仁、功能、多給／拿掉、到期、原因、建立者；過期與已撤銷灰掉；可撤銷。
 * 新增：同仁（編號或姓名，名單取自 staffList）、功能、模式、到期日（可空）、原因（必填 ≤50 字）。
 */
'use strict';

import { FEATURE_ORDER, HR_EX_FEATURES, featureName, errorText, exStatus, untilText, sortExItems, resolvePerson, removeAuditReadHint } from '../lib.js';

export function mountEx(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let items = [];
  let staff = [];
  let notInited = false;

  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';

  async function load() {
    const [r, s] = await Promise.all([ctx.api.call('perms', 'permExList', {}), ctx.api.call('perms', 'staffList', {})]);
    if (!alive) return;
    if (!r.ok) { el.innerHTML = `<div class="card"><p>${esc(r.error || '讀不到例外清單')}</p></div>`; return; }
    notInited = r.data.inited === false;
    items = r.data.items || [];
    staff = s.ok ? ((s.data && s.data.staff) || []).filter((p) => p.status === 'active') : [];
    draw();
  }

  function listHtml() {
    if (!items.length) return '<div class="card"><p class="text-muted" data-role="ex-empty">目前沒有任何例外。</p></div>';
    return sortExItems(items).map((x) => {
      const st = exStatus(x);
      const modeTag = x.mode === 'remove' ? '<span class="tag tag-danger">拿掉</span>' : '<span class="tag tag-ok">多給</span>';
      return `<div class="card stack" data-role="ex-item" data-ex="${esc(x.ex_id)}" data-status="${esc(x.status)}"${st.dim ? ' style="opacity:.55"' : ''}>
        <div class="card-row"><div class="card-title">${esc(x.name || '')} ${esc(x.emp_no)}</div><span class="tag${st.dim ? '' : ' tag-ok'}">${st.text}</span></div>
        <div>${modeTag} ${esc(featureName(x.perm))}　<span class="text-muted">${esc(untilText(x.until))}</span></div>
        <div class="text-muted">原因：${esc(x.note)}　建立者：${esc(x.created_by)}${x.created_at ? `（${esc(String(x.created_at).slice(0, 10))}）` : ''}</div>
        ${st.revocable ? `<div><button type="button" class="btn btn-secondary" data-act="revoke" data-ex="${esc(x.ex_id)}">撤銷</button></div>` : ''}
      </div>`;
    }).join('');
  }

  function draw() {
    if (notInited) {
      el.innerHTML = '<div class="card"><div class="card-title">權限設定還沒初始化</div><p class="text-muted">請先到「對照表」分頁按「初始化」。</p></div>';
      return;
    }
    // 人資主管（沒有 platform.permex）只能選三碼；admin 全部。後端 permExList 也只回他看得到的那三碼的例外
    const featList = ctx.can('platform.permex') ? FEATURE_ORDER : HR_EX_FEATURES;
    const featOpts = featList.map((p) => `<option value="${esc(p)}">${esc(featureName(p))}</option>`).join('');
    const staffOpts = staff.map((p) => `<option value="${esc(p.emp_no)} ${esc(p.name)}"></option>`).join('');
    el.innerHTML = `
      <form class="card stack" data-role="ex-form" novalidate>
        <div class="card-title">新增個別例外</div>
        <div class="toast toast-danger" data-role="ex-error" hidden></div>
        <div class="form-grid-2">
          <div class="field"><label class="field-label" for="ex-who">同仁（編號或姓名）</label>
            <input class="input" id="ex-who" list="ex-staff-list" autocomplete="off" data-role="ex-who" placeholder="例如 DZY001 或 王小明">
            <datalist id="ex-staff-list">${staffOpts}</datalist></div>
          <div class="field"><label class="field-label" for="ex-perm">功能</label>
            <select class="input" id="ex-perm" data-role="ex-perm">${featOpts}</select></div>
          <div class="field"><label class="field-label" for="ex-mode">多給或拿掉</label>
            <select class="input" id="ex-mode" data-role="ex-mode"><option value="add">多給</option><option value="remove">拿掉</option></select></div>
          <div class="field"><label class="field-label" for="ex-until">到期日（可空＝不到期）</label>
            <input class="input" id="ex-until" type="date" data-role="ex-until"></div>
        </div>
        <div class="field"><label class="field-label" for="ex-note">原因（必填，50 字內）</label>
          <input class="input" id="ex-note" type="text" maxlength="50" data-role="ex-note"></div>
        <p class="field-hint" data-role="ex-hint" hidden></p>
        <div><button class="btn btn-primary" type="submit" data-role="ex-submit">新增例外</button></div>
      </form>
      <div class="card stack"><div class="card-title">例外清單（${items.length}）</div></div>
      <div data-role="ex-list">${listHtml()}</div>`;
    const form = el.querySelector('[data-role="ex-form"]');
    const permEl = el.querySelector('[data-role="ex-perm"]');
    const modeEl = el.querySelector('[data-role="ex-mode"]');
    const hintEl = el.querySelector('[data-role="ex-hint"]');
    const box = el.querySelector('[data-role="ex-error"]');
    const syncHint = () => {
      const h = removeAuditReadHint(permEl.value, modeEl.value);
      hintEl.textContent = h;
      hintEl.hidden = !h;
    };
    permEl.addEventListener('change', syncHint);
    modeEl.addEventListener('change', syncHint);
    form.addEventListener('input', () => { box.hidden = true; });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fail = (m) => { box.textContent = m; box.hidden = false; };
      const who = resolvePerson(el.querySelector('[data-role="ex-who"]').value, staff);
      if (who.error) return fail(who.error);
      const note = el.querySelector('[data-role="ex-note"]').value.trim();
      if (!note) return fail('原因必填');
      if (Array.from(note).length > 50) return fail('原因最多 50 個字');
      box.hidden = true;
      ctx.ui.loading(true);
      let r;
      try {
        r = await ctx.api.call('perms', 'permExSave', {
          emp_no: who.person.emp_no, perm: permEl.value, mode: modeEl.value,
          until: el.querySelector('[data-role="ex-until"]').value || '', note
        });
      } finally { ctx.ui.loading(false); }
      if (!alive || r.dryrun) return;
      if (!r.ok) return fail(errorText(r));
      ctx.ui.toast('已新增例外', 'ok');
      await load();
    });
  }

  async function onRevoke(id) {
    const x = items.find((i) => i.ex_id === id);
    const yes = await ctx.ui.confirm(`要撤銷這筆例外嗎？（${x ? `${x.name} ${x.emp_no}：${x.mode === 'remove' ? '拿掉' : '多給'}${featureName(x.perm)}` : id}）`);
    if (!yes || !alive) return;
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('perms', 'permExRevoke', { ex_id: id }); } finally { ctx.ui.loading(false); }
    if (!alive || r.dryrun) return;
    if (!r.ok) { ctx.ui.toast(errorText(r), 'danger'); return; }
    ctx.ui.toast('已撤銷', 'ok');
    await load();
  }

  const onClick = (ev) => {
    const btn = ev.target.closest('[data-act="revoke"]');
    if (btn && el.contains(btn)) onRevoke(btn.getAttribute('data-ex'));
  };
  el.addEventListener('click', onClick);
  load();
  return () => { alive = false; el.removeEventListener('click', onClick); };
}
