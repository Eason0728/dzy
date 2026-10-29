/**
 * modules/perms/views/ex.js — 個別例外分頁（admin；人資主管只看得到、只能設 store.void／att.extra／platform.bulletin；spec §7.1-2、docs/approver/spec.md §13.1）
 * 2026-10-26：admin 多一個「指定門市只看考勤」→ 出現門市下拉，送出 att.view@<門市>（docs/att-support/spec.md §2）。
 * 2026-10-29：admin 與人資主管多一個「兼任店長」→ 出現門市下拉，送出 store.sm@<門市>（docs/att-hr-acting/spec.md）。
 * 清單：同仁、功能、多給／拿掉、到期、原因、建立者；過期與已撤銷灰掉；可撤銷。
 * 新增：同仁（編號或姓名，名單取自 staffList）、功能、模式、到期日（可空）、原因（必填 ≤50 字）。
 */
'use strict';

import { FEATURE_ORDER, HR_EX_FEATURES, ATT_VIEW_CHOICE, ATT_VIEW_CHOICE_NAME, attViewCode, ACTING_CHOICE, ACTING_CHOICE_NAME, actingCode, featureName, errorText, exStatus, untilText, sortExItems, resolvePerson, removeAuditReadHint } from '../lib.js';

export function mountEx(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let items = [];
  let staff = [];
  let units = [];   // 2026-10-26 指定門市只看考勤：後端只回給 admin（permExList.att_view_units）
  let actingUnits = [];   // 2026-10-29 兼任店長：admin 與人資主管都有（permExList.acting_units）
  let notInited = false;

  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';

  async function load() {
    const [r, s] = await Promise.all([ctx.api.call('perms', 'permExList', {}), ctx.api.call('perms', 'staffList', {})]);
    if (!alive) return;
    if (!r.ok) { el.innerHTML = `<div class="card"><p>${esc(r.error || '讀不到例外清單')}</p></div>`; return; }
    notInited = r.data.inited === false;
    items = r.data.items || [];
    units = Array.isArray(r.data.att_view_units) ? r.data.att_view_units : [];
    actingUnits = Array.isArray(r.data.acting_units) ? r.data.acting_units : [];
    staff = s.ok ? ((s.data && s.data.staff) || []).filter((p) => p.status === 'active') : [];
    draw();
  }

  // 清單顯示名稱用：兩份門市清單合起來
  const allUnits = () => units.concat(actingUnits);

  function listHtml() {
    if (!items.length) return '<div class="card"><p class="text-muted" data-role="ex-empty">目前沒有任何例外。</p></div>';
    return sortExItems(items).map((x) => {
      const st = exStatus(x);
      const modeTag = x.mode === 'remove' ? '<span class="tag tag-danger">拿掉</span>' : '<span class="tag tag-ok">多給</span>';
      return `<div class="card stack${st.dim ? ' is-dim' : ''}" data-role="ex-item" data-ex="${esc(x.ex_id)}" data-status="${esc(x.status)}">
        <div class="card-row"><div class="card-title">${esc(x.name || '')} ${esc(x.emp_no)}</div><span class="tag${st.dim ? '' : ' tag-ok'}">${st.text}</span></div>
        <div>${modeTag} ${esc(featureName(x.perm, allUnits()))}　<span class="text-muted">${esc(untilText(x.until))}</span></div>
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
    const isAdmin = ctx.can('platform.permex');
    const featList = isAdmin ? FEATURE_ORDER : HR_EX_FEATURES;
    // 2026-10-26「指定門市只看考勤」只給 admin（後端也只有 admin 能存）；選了才出現門市下拉
    const attViewOn = isAdmin && units.length > 0;
    const actingOn = actingUnits.length > 0;
    const featOpts = featList.map((p) => `<option value="${esc(p)}">${esc(featureName(p))}</option>`).join('') +
      (attViewOn ? `<option value="${ATT_VIEW_CHOICE}">${esc(ATT_VIEW_CHOICE_NAME)}</option>` : '') +
      (actingOn ? `<option value="${ACTING_CHOICE}">${esc(ACTING_CHOICE_NAME)}</option>` : '');
    const unitOpts = '<option value="">請選擇門市</option>' + units.map((u) => `<option value="${esc(u.code)}">${esc(u.name || u.code)}</option>`).join('');
    const actingOpts = '<option value="">請選擇門市</option>' + actingUnits.map((u) => `<option value="${esc(u.code)}">${esc(u.name || u.code)}</option>`).join('');
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
          ${attViewOn ? `<div class="field" data-role="ex-unit-field" hidden><label class="field-label" for="ex-unit">門市（只看這家店的考勤）</label>
            <select class="input" id="ex-unit" data-role="ex-unit">${unitOpts}</select></div>` : ''}
          ${actingOn ? `<div class="field" data-role="ex-acting-field" hidden><label class="field-label" for="ex-acting">兼任哪一家店的店長</label>
            <select class="input" id="ex-acting" data-role="ex-acting">${actingOpts}</select></div>` : ''}
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
    const unitField = el.querySelector('[data-role="ex-unit-field"]');
    const unitEl = el.querySelector('[data-role="ex-unit"]');
    const actingField = el.querySelector('[data-role="ex-acting-field"]');
    const actingEl = el.querySelector('[data-role="ex-acting"]');
    const syncHint = () => {
      const av = permEl.value === ATT_VIEW_CHOICE;
      const ac = permEl.value === ACTING_CHOICE;
      if (unitField) unitField.hidden = !av;
      if (actingField) actingField.hidden = !ac;
      if (av || ac) modeEl.value = 'add';   // 只看考勤、兼任店長只能多給（要收回＝撤銷那筆例外）
      modeEl.disabled = av || ac;
      const h = av ? '只看不核：對方在考勤管理看得到這家店所有打卡同仁的工時與申請，不能核定。'
        : ac ? '當作這家店的店長：核同仁工時與加班／請假／忘打卡、排班、門市營運、新人開通審核、人事異動與 5,000 元以下請購請款第一關、績效評核打分、看這家店的稽核。本人的考勤照原身分。建議設到期日。'
        : removeAuditReadHint(permEl.value, modeEl.value);
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
      let perm = permEl.value;
      if (perm === ATT_VIEW_CHOICE) {
        perm = attViewCode(unitEl ? unitEl.value : '');
        if (!perm) return fail('請選擇門市');
      } else if (perm === ACTING_CHOICE) {
        perm = actingCode(actingEl ? actingEl.value : '');
        if (!perm) return fail('請選擇門市');
      }
      const note = el.querySelector('[data-role="ex-note"]').value.trim();
      if (!note) return fail('原因必填');
      if (Array.from(note).length > 50) return fail('原因最多 50 個字');
      box.hidden = true;
      ctx.ui.loading(true);
      let r;
      try {
        r = await ctx.api.call('perms', 'permExSave', {
          emp_no: who.person.emp_no, perm, mode: perm === permEl.value ? modeEl.value : 'add',
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
    const yes = await ctx.ui.confirm(`要撤銷這筆例外嗎？（${x ? `${x.name} ${x.emp_no}：${x.mode === 'remove' ? '拿掉' : '多給'}${featureName(x.perm, allUnits())}` : id}）`);
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
