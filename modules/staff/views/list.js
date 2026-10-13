/**
 * modules/staff/views/list.js — 同仁名單（後台，docs/personnel/spec.md §6.3／§7.5）
 *
 * 一張表：編號、姓名、品牌單位職稱、狀態。搜尋＋篩選；每列依狀態出現對應動作。
 * 個資（生日、手機、地址）預設收合，按「顯示個資」才展開（防旁人偷看螢幕）。
 * 確認開通前固定提醒「打電話給本人核對」（防冒用的人工核對點，Fable 設計審第 14 條）。
 */
'use strict';

import { orgFieldsHtml, bindOrgFields, readOrgFields } from '../../staff-shared/org-fields.js';
import { personFilter, ymd } from '../../staff-shared/clock-lib.js';
import { clockTagsHtml, clockButtonsHtml, isClockAct, handleClockAct, openAddFlow } from '../../staff-shared/clock-ui.js';

const STATUS = {
  unclaimed: ['tag', '未開通'],
  pending: ['tag tag-warn', '待確認'],
  rejected: ['tag tag-danger', '已退回'],
  active: ['tag tag-ok', '已開通'],
  disabled: ['tag', '已停用']
};
const FILTERS = [
  ['todo', '待處理'], ['all', '全部'], ['unclaimed', '未開通'], ['pending', '待確認'],
  ['rejected', '已退回'], ['active', '已開通'], ['disabled', '已停用'], ['locked', '忘記密碼鎖住'],
  ['left', '已離職但打卡未停'], ['nohome', '沒有打卡編號'],
  ['overdue', '離職日已過未停用'], ['homestopped', '主店打卡被停']
];

export function mountList(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let staff = [];
  let org = { brands: [], units: [], depts: [], titles: [] };
  let showPrivate = false;
  const viewer = { isHq: true, isLead: false, user: ctx.user };
  const state = { f: (ctx.params && ctx.params.f) || 'all', q: '', brand: '' };

  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';

  async function load() {
    const [r, o] = await Promise.all([ctx.api.call('staff', 'staffList', {}), ctx.api.call('staff', 'orgOptions', {})]);
    if (!alive) return;
    if (!r.ok) { el.innerHTML = `<div class="card"><p>${esc(r.error || '讀不到名單')}</p></div>`; return; }
    staff = r.data.staff || [];
    if (o.ok) org = o.data;
    drawShell();
  }

  const orgText = (p, pre) => [p[pre + 'brand_name'], p[pre + 'unit_name'], p[pre + 'dept_name'], p[pre + 'title_name']].filter(Boolean).join('／');

  function match(p) {
    if (state.brand && p.brand !== state.brand && p.p_brand !== state.brand) return false;
    if (state.q && p.name.indexOf(state.q) === -1 && p.emp_no.indexOf(state.q.toUpperCase()) === -1) return false;
    switch (state.f) {
      case 'all': return true;
      case 'todo': return p.status === 'pending' || (p.status === 'active' && p.has_pending_change) || p.reset_locked;
      case 'locked': return p.reset_locked;
      case 'left': case 'nohome': case 'namediff': case 'overdue': case 'homestopped': return personFilter(state.f, p, ymd(new Date()));
      default: return p.status === state.f;
    }
  }

  function actionsHtml(p) {
    const b = (act, label, cls) => `<button type="button" class="btn ${cls || 'btn-secondary'}" data-act="${act}" data-emp="${esc(p.emp_no)}">${label}</button>`;
    const a = [];
    if (p.status === 'pending' || (p.status === 'active' && p.has_pending_change)) a.push(b('confirm', '確認', 'btn-primary'), b('reject', '退回'));
    if (p.status !== 'unclaimed' && p.status !== 'disabled') a.push(b('edit', '改資料'));
    if (p.reset_locked) a.push(b('unlock', '解鎖忘記密碼'));
    if (['pending', 'rejected', 'active'].indexOf(p.status) !== -1) a.push(b('unclaim', '撤回認領', 'btn-danger'));
    if (p.status === 'unclaimed') a.push(b('rename', '改姓名'));
    a.push(p.status === 'disabled' ? b('enable', '啟用') : b('disable', '停用', 'btn-danger'));
    const extra = clockButtonsHtml(p, viewer); // 員工名單統一：離職／撤銷離職／打卡連結／改名／復職
    return a.join(' ') + (extra ? ' ' + extra : '');
  }

  function rowsHtml() {
    const list = staff.filter(match);
    if (!list.length) return '<tr><td colspan="6">沒有符合的同仁</td></tr>';
    return list.map((p) => {
      const [cls, txt] = STATUS[p.status] || ['tag', p.status];
      const change = p.has_pending_change ? `<div class="text-muted">${p.status === 'active' ? '要改成' : '填的是'}：${esc(orgText(p, 'p_'))}</div>` : '';
      const reason = p.reject_reason && (p.status === 'rejected' || p.status === 'unclaimed')
        ? `<div class="text-muted">${p.status === 'unclaimed' ? '上次退回' : '原因'}：${esc(p.reject_reason)}</div>` : '';
      const priv = showPrivate && p.status !== 'unclaimed'
        ? `<div class="text-muted">生日 ${esc(p.birthday)}・手機 ${esc(p.phone)}・${esc(p.address)}</div>` : '';
      return `<tr>
        <td>${esc(p.emp_no)}</td>
        <td>${esc(p.name)}${priv}</td>
        <td>${esc(orgText(p, '') || '—')}${change}</td>
        <td><span class="${cls}">${esc(txt)}</span>${p.reset_locked ? ' <span class="tag tag-danger">密碼鎖住</span>' : ''} ${clockTagsHtml(p)}${reason}</td>
        <td>${esc(p.claimed_at || '')}</td>
        <td>${actionsHtml(p)}</td></tr>`;
    }).join('');
  }

  function drawShell() {
    const counts = {};
    staff.forEach((p) => { counts[p.status] = (counts[p.status] || 0) + 1; });
    el.innerHTML = `
      <div class="card stack">
        <div class="card-row"><div class="card-title">同仁名單（${staff.length} 位）</div>
          <button type="button" class="btn btn-primary" data-role="add-staff">新增同仁</button></div>
        <div class="card-row"><span class="text-muted">未開通 ${counts.unclaimed || 0}・待確認 ${counts.pending || 0}・已開通 ${counts.active || 0}・已停用 ${counts.disabled || 0}</span></div>
        <div class="form-grid-2">
          <div class="field"><label class="field-label" for="stf-q">搜尋姓名或編號</label><input class="input" id="stf-q" type="search" value="${esc(state.q)}"></div>
          <div class="field"><label class="field-label" for="stf-f">狀態</label><select class="input" id="stf-f">
            ${FILTERS.map(([v, n]) => `<option value="${v}"${v === state.f ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
        </div>
        <div class="form-grid-2">
          <div class="field"><label class="field-label" for="stf-brand">品牌</label><select class="input" id="stf-brand">
            <option value="">全部品牌</option>${org.brands.map((b) => `<option value="${esc(b.code)}"${b.code === state.brand ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
          <div class="checkbox-row"><input type="checkbox" id="stf-priv"${showPrivate ? ' checked' : ''}><label for="stf-priv">顯示個資（生日、手機、地址）</label></div>
        </div>
      </div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>編號</th><th>姓名</th><th>品牌／單位／職稱</th><th>狀態</th><th>認領時間</th><th>動作</th></tr></thead>
        <tbody data-role="rows">${rowsHtml()}</tbody></table></div></div>`;
    const redraw = () => { el.querySelector('[data-role="rows"]').innerHTML = rowsHtml(); };
    el.querySelector('#stf-q').addEventListener('input', (e) => { state.q = e.target.value.trim(); redraw(); });
    el.querySelector('#stf-f').addEventListener('change', (e) => { state.f = e.target.value; redraw(); });
    el.querySelector('#stf-brand').addEventListener('change', (e) => { state.brand = e.target.value; redraw(); });
    el.querySelector('#stf-priv').addEventListener('change', (e) => { showPrivate = e.target.checked; redraw(); });
    el.querySelector('[data-role="rows"]').addEventListener('click', onAction);
    el.querySelector('[data-role="add-staff"]').addEventListener('click', () => openAddFlow(clockEnv()));
  }

  const clockEnv = () => ({ ctx, mod: 'staff', viewer, org, reload: load });

  async function run(action, payload, okMsg) {
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('staff', action, payload); } finally { ctx.ui.loading(false); }
    if (!alive) return false;
    if (!r.ok) { ctx.ui.toast(r.error, 'danger'); return false; }
    ctx.ui.toast(okMsg, 'ok');
    const fresh = r.data && r.data.staff;
    if (fresh) staff = staff.map((p) => (p.emp_no === fresh.emp_no ? fresh : p));
    else await load();
    if (alive) el.querySelector('[data-role="rows"]').innerHTML = rowsHtml();
    return true;
  }

  function field(id, label, value, type) {
    return `<div class="field"><label class="field-label" for="${id}">${label}</label><input class="input" id="${id}" type="${type || 'text'}" value="${esc(value || '')}"></div>`;
  }
  function domOf(html) { const d = document.createElement('div'); d.innerHTML = html; return d; }

  async function onAction(e) {
    const btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const p = staff.find((x) => x.emp_no === btn.getAttribute('data-emp'));
    if (!p) return;
    const act = btn.getAttribute('data-act');
    const who = `${p.emp_no} ${p.name}`;
    if (isClockAct(act)) { handleClockAct(act, p, clockEnv()); return; }

    if (act === 'confirm') {
      const body = domOf(`<p><b>確認前請先打電話給本人核對</b>（手機 ${esc(p.phone)}），確定是他本人填的再按確認。</p>
        <p>${p.status === 'active' ? '要改成' : '確認後生效'}：${esc(orgText(p, 'p_'))}</p>`);
      const v = await ctx.ui.dialog({ title: `確認 ${who}`, body, actions: [{ label: '取消', value: null, variant: 'secondary' }, { label: '已核對，確認', value: 'ok', variant: 'primary' }] });
      if (v === 'ok') run('staffConfirm', { emp_no: p.emp_no }, '已確認');
    } else if (act === 'reject') {
      const body = domOf(p.status === 'pending'
        ? `<div class="field"><label class="field-label" for="rj-reason">退回原因（留在後台紀錄）</label><textarea class="input" id="rj-reason" rows="3" maxlength="200"></textarea></div>
          <p class="field-hint">退回後他填的資料與密碼會清空，要重新按「第一次使用」再送一次。原因請另外告訴他。</p>`
        : `<div class="field"><label class="field-label" for="rj-reason">退回原因（同仁會看到）</label><textarea class="input" id="rj-reason" rows="3" maxlength="200"></textarea></div>`);
      const v = await ctx.ui.dialog({ title: `退回 ${who}`, body, actions: [{ label: '取消', value: null, variant: 'secondary' }, { label: '退回', value: 'ok', variant: 'danger' }] });
      if (v === 'ok') run('staffReject', { emp_no: p.emp_no, reason: body.querySelector('#rj-reason').value.trim() }, '已退回');
    } else if (act === 'edit') {
      const body = domOf(`${field('ed-name', '姓名', p.name)}${orgFieldsHtml('ed')}
        <div class="form-grid-2">${field('ed-birthday', '生日', p.birthday, 'date')}${field('ed-phone', '手機', p.phone, 'tel')}</div>
        ${field('ed-address', '居住地址', p.address)}<p class="field-hint">後台直接改正式資料，不必再確認。</p>`);
      bindOrgFields(body, 'ed', org, { brand: p.brand, unit: p.unit, dept: p.dept, title: p.title });
      const v = await ctx.ui.dialog({ title: `改資料 ${who}`, body, actions: [{ label: '取消', value: null, variant: 'secondary' }, { label: '儲存', value: 'ok', variant: 'primary' }] });
      if (v !== 'ok') return;
      const payload = { emp_no: p.emp_no };
      const nm = body.querySelector('#ed-name').value.trim();
      if (nm !== p.name) payload.name = nm;
      const bd = body.querySelector('#ed-birthday').value;
      if (bd && bd !== p.birthday) payload.birthday = bd;
      const ph = body.querySelector('#ed-phone').value.replace(/[\s-]/g, '');
      if (ph && ph !== p.phone) payload.phone = ph;
      const ad = body.querySelector('#ed-address').value.trim();
      if (ad && ad !== p.address) payload.address = ad;
      const o = readOrgFields(body, 'ed');
      if (o.brand && (o.brand !== p.brand || o.unit !== p.unit || o.dept !== p.dept || o.title !== p.title)) Object.assign(payload, o);
      run('staffEdit', payload, '已儲存');
    } else if (act === 'rename') {
      const body = domOf(field('rn-name', '全名（同仁第一次使用時要輸入這個）', p.name));
      const v = await ctx.ui.dialog({ title: `改姓名 ${p.emp_no}`, body, actions: [{ label: '取消', value: null, variant: 'secondary' }, { label: '儲存', value: 'ok', variant: 'primary' }] });
      if (v === 'ok') run('staffEdit', { emp_no: p.emp_no, name: body.querySelector('#rn-name').value.trim() }, '已改名');
    } else if (act === 'unlock') {
      if (await ctx.ui.confirm(`解鎖 ${who} 的忘記密碼？`)) run('staffUnlockReset', { emp_no: p.emp_no }, '已解鎖');
    } else if (act === 'unclaim') {
      if (await ctx.ui.confirm(`撤回 ${who} 的認領？他的密碼與個資會清空，所有登入立刻失效，名字可以重新認領。用在發現被別人冒用時。`)) {
        run('staffUnclaim', { emp_no: p.emp_no }, '已撤回');
      }
    } else if (act === 'disable') {
      if (await ctx.ui.confirm(`停用 ${who}？停用後不能登入，編號保留不會給別人。`)) run('staffSetActive', { emp_no: p.emp_no, active: false }, '已停用');
    } else if (act === 'enable') {
      if (await ctx.ui.confirm(`重新啟用 ${who}？`)) run('staffSetActive', { emp_no: p.emp_no, active: true }, '已啟用');
    }
  }

  load();
  return () => { alive = false; };
}
