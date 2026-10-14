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
export const FILTERS = [
  ['todo', '待處理'], ['all', '全部'], ['unclaimed', '未開通'], ['pending', '待確認'],
  ['rejected', '已退回'], ['active', '已開通'], ['disabled', '已停用'], ['locked', '忘記密碼鎖住'],
  ['left', '已離職但打卡未停'], ['nohome', '沒有打卡編號'],
  ['overdue', '離職日已過未停用'], ['homestopped', '主店打卡被停'], ['flags', '需處理']
];
const FLAG_TEXT = { unit_inactive: '所屬門市已停用', title_ladder: '職稱需重選', dept_inactive: '部門已停用' };
const CLOCK_TEXT = { updated: '會更新（補上一悟總部）', skipped: '不用更新', custom: '有自訂值，保留不動' };

export function mountList(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let staff = [];
  let org = { brands: [], units: [], depts: [], titles: [] };
  let showPrivate = false;
  const viewer = { isHq: true, isLead: false, user: ctx.user };
  const isAdmin = !!(ctx.user && ctx.user.role === 'admin');
  const canExtra = !!(ctx.can && ctx.can('platform.staff'));
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
      case 'flags': return (p.flags || []).length > 0;
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
      const extra = (p.extra_dept_names || []).length ? `<div class="text-muted" data-role="extra-depts">兼任：${esc(p.extra_dept_names.join('、'))}</div>` : '';
      const flagTags = (p.flags || []).map((f) => `<span class="tag tag-warn" data-role="flag-tag">${esc(FLAG_TEXT[f] || f)}</span>`).join(' ');
      const priv = showPrivate && p.status !== 'unclaimed'
        ? `<div class="text-muted">生日 ${esc(p.birthday)}・手機 ${esc(p.phone)}・${esc(p.address)}</div>` : '';
      return `<tr>
        <td>${esc(p.emp_no)}</td>
        <td>${esc(p.name)}${flagTags ? ' ' + flagTags : ''}${priv}</td>
        <td>${esc(orgText(p, '') || '—')}${extra}${change}</td>
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
          <span>${isAdmin ? '<button type="button" class="btn btn-secondary" data-role="org-upgrade">切換組織</button> <button type="button" class="btn btn-danger" data-role="org-rollback">退回組織</button> ' : ''}<button type="button" class="btn btn-primary" data-role="add-staff">新增同仁</button></span></div>
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
    if (isAdmin) {
      el.querySelector('[data-role="org-upgrade"]').addEventListener('click', upgradeFlow);
      el.querySelector('[data-role="org-rollback"]').addEventListener('click', rollbackFlow);
    }
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

  // 兼任部門可選項：dzy-hq 底下的部門＋中央工廠（ck），排除這個人的主要部門
  function extraChoices(p) {
    const list = (org.depts || []).filter((d) => d.parent === 'dzy-hq' && d.code !== p.dept).map((d) => ({ code: d.code, name: d.name }));
    if (p.unit !== 'ck') list.push({ code: 'ck', name: '中央工廠' });
    return list;
  }
  // 不在可選項裡的舊代碼（例如部門後來被停用）：畫面看不到、不可改，送出時原樣保留
  function extraHidden(p) {
    const vis = extraChoices(p).map((c) => c.code);
    const names = p.extra_dept_names || [];
    return (p.extra_depts || []).map((c, i) => ({ code: c, name: names[i] || c })).filter((x) => vis.indexOf(x.code) === -1);
  }
  function extraHtml(p) {
    const have = p.extra_depts || [];
    const all = extraChoices(p).map((c) => ({ code: c.code, name: c.name })).concat(extraHidden(p).map((x) => ({ code: x.code, name: x.name + '（目前不可選，保留不動）' })));
    const boxes = all.map((c, i) => `<div class="checkbox-row"><input type="checkbox" id="ed-x-${i}" data-code="${esc(c.code)}"${have.indexOf(c.code) !== -1 ? ' checked' : ''}><label for="ed-x-${i}">${esc(c.name)}</label></div>`).join('');
    const hidden = '';
    return `<div class="field" data-role="extra-wrap"><span class="field-label">兼任部門</span>${boxes}${hidden}<p class="field-hint">兼任不影響審核，審核只看主要部門。</p></div>`;
  }

  const li = (items) => (items.length ? `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="text-muted">（無）</p>');
  const OK_ONLY = [{ label: '知道了', value: 'ok', variant: 'primary' }];
  const CANCEL = { label: '取消', value: null, variant: 'secondary' };

  function upgradeReportHtml(d, done) {
    const titles = (d.titles || []).map((t) => `${t.emp_no} ${t.name}：${t.from_name || t.from} → ${t.to_name || t.to}`);
    const todo = (d.todo || []).map((t) => `${t.emp_no} ${t.name}（${t.unit_name || ''}）：${FLAG_TEXT[t.flag] || t.flag}${t.submitted ? '（送出待審的資料）' : ''}`);
    const orgRows = (d.org || []).map((o) => `${o.kind} ${o.code}　${o.field === 'row' ? '新增一列' : `${o.field}：${o.from || '（空）'} → ${o.to}`}`);
    return `<p>備份：${d.backup === 'exists' ? '已有備份（不覆蓋）' : done ? '已建立' : '會建立'}　・　同仁表兼任欄：${d.staffColumn === 'added' ? (done ? '已新增' : '會新增') : '已存在'}</p>
      <p data-role="pv-clock">打卡對照：${esc(CLOCK_TEXT[d.clock] || d.clock)}</p>
      <p><b>組織表${done ? '已改' : '會改'}（${orgRows.length} 筆）</b></p>${li(orgRows)}
      <p><b>職稱自動對應（${titles.length} 人）</b></p>${li(titles)}
      <p><b>需處理名單（${todo.length} 人，要人資手動改派）</b></p>${li(todo)}`;
  }
  async function upgradeFlow() {
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('staff', 'orgUpgrade2026', { dryrun: true }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!r.ok) { ctx.ui.toast(r.error || '預覽失敗', 'danger'); return; }
    const go = await ctx.ui.dialog({ title: '切換組織：預覽（還沒寫入）', body: domOf(upgradeReportHtml(r.data, false)), actions: [CANCEL, { label: '確定切換', value: 'go', variant: 'danger' }] });
    if (go !== 'go') return;
    ctx.ui.loading(true);
    let w;
    try { w = await ctx.api.call('staff', 'orgUpgrade2026', { dryrun: false }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!w.ok) { ctx.ui.toast(w.error || '切換失敗', 'danger'); return; }
    if (w.dryrun === true) { ctx.ui.toast('試跑模式：未寫入', 'warn'); return; }
    await ctx.ui.dialog({ title: '組織已切換完成', body: domOf(upgradeReportHtml(w.data, true)), actions: OK_ONLY });
    if (alive) load();
  }
  async function rollbackFlow() {
    if (!(await ctx.ui.confirm('退回組織？組織表會整份蓋回切換前的備份，並還原被自動對應的職稱。若切換後組織表又被改過，系統會拒絕。'))) return;
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('staff', 'orgRollback2026', {}); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!r.ok) {
      // 後端回 {ok:false,error,data:{diff}}；api.js 會把 data 整包放進 r.data，所以實際在 r.data.data.diff（兩種都收）
      const rd = (r.data && (r.data.diff || r.data.clock_diff ? r.data : r.data.data)) || {};
      const diff = rd.diff || [];
      const cdiff = rd.clock_diff || [];
      if (diff.length || cdiff.length) {
        const orgTbl = diff.length ? `<p><b>組織表差異</b></p><div class="table-wrap"><table class="table"><thead><tr><th>類別</th><th>代碼</th><th>欄位</th><th>切換後應為</th><th>目前</th></tr></thead><tbody>${diff.map((x) => `<tr><td>${esc(x.kind)}</td><td>${esc(x.code)}</td><td>${esc(x.field)}</td><td>${esc(x.expected)}</td><td>${esc(x.actual)}</td></tr>`).join('')}</tbody></table></div>` : '';
        const clkTbl = cdiff.length ? `<p><b>打卡對照差異</b></p><div class="table-wrap"><table class="table"><thead><tr><th>店別</th><th>欄位</th><th>切換後應為</th><th>目前</th></tr></thead><tbody>${cdiff.map((x) => `<tr><td>${esc(x.key)}</td><td>${esc(x.field)}</td><td>${esc(x.expected)}</td><td>${esc(x.actual)}</td></tr>`).join('')}</tbody></table></div>` : '';
        await ctx.ui.dialog({ title: '退回被拒絕', body: domOf(`<p>${esc(r.error)}</p>${orgTbl}${clkTbl}`), actions: OK_ONLY });
      } else ctx.ui.toast(r.error || '退回失敗', 'danger');
      return;
    }
    if (r.dryrun === true) { ctx.ui.toast('試跑模式：未寫入', 'warn'); return; }
    const d = r.data || {};
    const orphans = (d.orphans || []).map((o) => `${o.emp_no} ${o.name}（單位 ${o.unit || '—'}／部門 ${o.dept || '—'}／職稱 ${o.title || '—'}）`);
    await ctx.ui.dialog({
      title: '組織已退回',
      body: domOf(`<p>組織表還原 ${esc(d.restored)} 列${d.clock_restored ? '，打卡對照也已還原' : ''}；職稱還原 ${esc(d.titles_restored || 0)} 人。</p>
        <p><b>職稱沒還原（之後被改過，沒動）</b></p>${li(d.titles_skipped || [])}
        <p><b>孤兒名單（退回後單位或職稱找不到，只列不改）</b></p>${li(orphans)}`),
      actions: OK_ONLY
    });
    if (alive) load();
  }

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
        ${field('ed-address', '居住地址', p.address)}${canExtra ? extraHtml(p) : ''}<p class="field-hint">後台直接改正式資料，不必再確認。</p>`);
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
      if (canExtra) {
        // 停用部門的舊代碼也是勾選框（預設勾選）；取消勾選＝移除，保持勾選＝原樣送回
        const checked = Array.from(body.querySelectorAll('input[data-code]')).filter((n) => n.checked).map((n) => n.getAttribute('data-code'));
        const order = extraChoices(p).map((c) => c.code).concat(extraHidden(p).map((x) => x.code));
        const next = order.filter((c) => checked.indexOf(c) !== -1);
        const before = p.extra_depts || [];
        if (next.length !== before.length || next.some((c) => before.indexOf(c) === -1)) payload.extra_depts = next;
      }
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
