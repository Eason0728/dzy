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
import { CARD_CSS } from './list-cards.js';

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
const FLAG_TEXT = { unit_inactive: '所屬門市已停用', title_ladder: '職稱需重選', dept_inactive: '部門已停用', exec_misplaced: '建議改到鼎兆元總部／管理部' };
// LINE 重設密碼紀錄（apps-script/platform/LineAuth.gs 寫進 staff_log 的 line_* 事件；docs/line-auth/spec.md §6）
export const LINE_LOG_TEXT = { line_claim_ok: '用 LINE 送出開通（已停用）', line_reset_ok: '用 LINE 重設密碼', line_revoke: '停用 LINE', line_fail: '失敗' };
// 手機卡片（≤860px，2026-10-26 Eason 選 B 版）：只露這些主要按鈕，其餘加 stf-sec 收進「更多」；電腦版整排照舊
export const PRIMARY_ACTS = ['confirm', 'reject', 'edit', 'unlock', 'rename', 'enable', 'reinstate', 'add-home'];
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
    if (canExtra) a.push(b('line', 'LINE 重設密碼'));   // 看紀錄＋停用此人的 LINE 重設密碼（platform.staff）
    a.push(p.status === 'disabled' ? b('enable', '啟用') : b('disable', '停用', 'btn-danger'));
    const extra = clockButtonsHtml(p, viewer); // 員工名單統一：離職／撤銷離職／打卡連結／改名／復職
    // 手機只露主要按鈕，其餘加上 stf-sec 收進「更多」（電腦版順序、顯示都不變）
    const all = a.concat(extra ? extra.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [] : []);
    const actOf = (h) => (/data-act="([^"]+)"/.exec(h) || [])[1];
    let sec = 0;
    const out = all.map((h) => (PRIMARY_ACTS.indexOf(actOf(h)) !== -1 ? h : (sec++, h.replace('class="btn ', 'class="btn stf-sec '))));
    return out.join(' ') + (sec ? ' <button type="button" class="btn btn-secondary stf-more" data-more="1" aria-expanded="false">更多 ▾</button>' : '');
  }

  function rowsHtml() {
    const list = staff.filter(match);
    if (!list.length) return '<tr><td class="c-none" colspan="6">沒有符合的同仁</td></tr>';
    return list.map((p) => {
      const [cls, txt] = STATUS[p.status] || ['tag', p.status];
      const change = p.has_pending_change ? `<div class="text-muted">${p.status === 'active' ? '要改成' : '填的是'}：${esc(orgText(p, 'p_'))}</div>` : '';
      const reason = p.reject_reason && (p.status === 'rejected' || p.status === 'unclaimed')
        ? `<div class="text-muted">${p.status === 'unclaimed' ? '上次退回' : '原因'}：${esc(p.reject_reason)}</div>` : '';
      const extra = (p.extra_dept_names || []).length ? `<div class="text-muted" data-role="extra-depts">兼任：${esc(p.extra_dept_names.join('、'))}</div>` : '';
      const bul = p.bulletin_admin ? '<span class="tag tag-ok" data-role="bulletin-admin-tag">可管理公告</span>' : '';
      const flagTags = bul + (p.flags || []).map((f) => `<span class="tag tag-warn" data-role="flag-tag">${esc(FLAG_TEXT[f] || f)}</span>`).join(' ');
      const priv = showPrivate && p.status !== 'unclaimed'
        ? `<div class="text-muted">生日 ${esc(p.birthday)}・手機 ${esc(p.phone)}・${esc(p.address)}</div>` : '';
      // class c-*：手機版卡片排版用（list-cards.js），電腦版表格不受影響
      return `<tr>
        <td class="c-emp">${esc(p.emp_no)}</td>
        <td class="c-name">${esc(p.name)}${flagTags ? ' ' + flagTags : ''}${priv}</td>
        <td class="c-org">${esc(orgText(p, '') || '—')}${extra}${change}</td>
        <td class="c-status"><span class="${cls}">${esc(txt)}</span>${p.reset_locked ? ' <span class="tag tag-danger">密碼鎖住</span>' : ''} ${clockTagsHtml(p)}${reason}</td>
        <td class="c-claim">${esc(p.claimed_at || '')}</td>
        <td class="c-act">${actionsHtml(p)}</td></tr>`;
    }).join('');
  }

  // 組織一次性按鈕（切換／退回 ×4 組）：遷移已完成，預設隱藏（Eason 2026-10-24）。
  // 要叫回來：用管理員登入，網址加 ?orgtools=1（例 https://dzy.mozhuting.com/?orgtools=1#/staff），免部署。
  const showOrgTools = () => isAdmin && typeof location !== 'undefined' && /(?:^|[?&])orgtools=1(?:&|$)/.test(location.search || '');

  function drawShell() {
    const orgTools = showOrgTools();
    const counts = {};
    staff.forEach((p) => { counts[p.status] = (counts[p.status] || 0) + 1; });
    el.innerHTML = `<style>${CARD_CSS}</style>
      <div class="card stack">
        <div class="card-row"><div class="card-title">同仁名單（${staff.length} 位）</div>
          <span>${orgTools ? '<button type="button" class="btn btn-secondary" data-role="org-upgrade">切換組織</button> <button type="button" class="btn btn-danger" data-role="org-rollback">退回組織</button> <button type="button" class="btn btn-secondary" data-role="org-upgrade-2610">職稱調整（10/20）</button> <button type="button" class="btn btn-danger" data-role="org-rollback-2610">退回職稱調整</button> <button type="button" class="btn btn-secondary" data-role="org-rename-2610n">名稱調整（10/23）</button> <button type="button" class="btn btn-danger" data-role="org-rename-rollback-2610n">退回名稱調整</button> <button type="button" class="btn btn-secondary" data-role="org-add-branddev-2610">新增品牌發展部（10/23）</button> <button type="button" class="btn btn-danger" data-role="org-rollback-branddev-2610">退回品牌發展部</button> ' : ''}<button type="button" class="btn btn-primary" data-role="add-staff">新增同仁</button></span></div>
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
      <div class="card"><div class="table-wrap stf-wrap"><table class="table stf-table">
        <thead><tr><th>編號</th><th>姓名</th><th>品牌／單位／職稱</th><th>狀態</th><th>認領時間</th><th>動作</th></tr></thead>
        <tbody data-role="rows">${rowsHtml()}</tbody></table></div></div>`;
    const redraw = () => { el.querySelector('[data-role="rows"]').innerHTML = rowsHtml(); };
    el.querySelector('#stf-q').addEventListener('input', (e) => { state.q = e.target.value.trim(); redraw(); });
    el.querySelector('#stf-f').addEventListener('change', (e) => { state.f = e.target.value; redraw(); });
    el.querySelector('#stf-brand').addEventListener('change', (e) => { state.brand = e.target.value; redraw(); });
    el.querySelector('#stf-priv').addEventListener('change', (e) => { showPrivate = e.target.checked; redraw(); });
    el.querySelector('[data-role="rows"]').addEventListener('click', (e) => {
      const more = e.target.closest ? e.target.closest('[data-more]') : null;
      if (more) { const tr = more.closest('tr'); const open = tr.classList.toggle('stf-open'); more.setAttribute('aria-expanded', String(open)); more.textContent = open ? '收起 ▴' : '更多 ▾'; return; }
      onAction(e);
    });
    el.querySelector('[data-role="add-staff"]').addEventListener('click', () => openAddFlow(clockEnv()));
    if (orgTools) {
      el.querySelector('[data-role="org-upgrade"]').addEventListener('click', upgradeFlow);
      el.querySelector('[data-role="org-rollback"]').addEventListener('click', rollbackFlow);
      el.querySelector('[data-role="org-upgrade-2610"]').addEventListener('click', upgrade2610Flow);
      el.querySelector('[data-role="org-rollback-2610"]').addEventListener('click', rollback2610Flow);
      el.querySelector('[data-role="org-rename-2610n"]').addEventListener('click', rename2610nFlow);
      el.querySelector('[data-role="org-rename-rollback-2610n"]').addEventListener('click', renameRollback2610nFlow);
      el.querySelector('[data-role="org-add-branddev-2610"]').addEventListener('click', addBranddev2610Flow);
      el.querySelector('[data-role="org-rollback-branddev-2610"]').addEventListener('click', branddevRollback2610Flow);
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

  // 公告管理權限（2026-10-17）：勾了＝管理系統「公告專區」多出「公告管理」「新增公告」分頁
  function bulletinHtml(p) {
    return `<div class="field" data-role="bulletin-wrap"><span class="field-label">電子佈告欄</span><div class="checkbox-row"><input type="checkbox" id="ed-bul"${p.bulletin_admin ? ' checked' : ''}><label for="ed-bul">可管理公告（公告專區多出「公告管理」「新增公告」）</label></div></div>`;
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

  // 2026-10-20 職稱調整（docs/org/spec.md 第 15 節）：區經理移回門市、中央工廠廠長／廚藝總監、央廚店長→廠長、權限規則複製
  const PERM_TEXT = { ok: '', not_inited: '權限設定還沒初始化（初始化時會直接帶預設規則）', header_mismatch: '權限對照表表頭不對' };
  function upgrade2610Html(d, done) {
    const orgRows = (d.org || []).map((o) => `${o.kind} ${o.code}　${o.field === 'row' ? '新增一列' : `${o.field}：${o.from || '（空）'} → ${o.to}`}`);
    const staffRows = (d.staff || []).map((x) => `${x.emp_no} ${x.name}：${x.field === 'p_title' ? '送出待審的職稱' : '職稱'} ${x.from_name || x.from} → ${x.to_name || x.to}`);
    const perm = d.perm || {};
    const permRows = (perm.add || []).map((x) => `${x.title}：${x.perm}（複製自 ${x.from_rule || '店長'}）`);
    const todo = (d.todo || []).map((t) => `${t.emp_no} ${t.name}（${t.unit_name || ''}）：${FLAG_TEXT[t.flag] || t.flag}${t.submitted ? '（送出待審的資料）' : ''}`);
    const resolved = (d.resolved || []).map((t) => `${t.emp_no} ${t.name}（${t.unit_name || ''}）：不再是「${FLAG_TEXT[t.flag] || t.flag}」`);
    return `<p>備份：${d.backup === 'exists' ? '已有備份（不覆蓋）' : done ? '已建立' : '會建立'}</p>
      <p><b>組織表${done ? '已改' : '會改'}（${orgRows.length} 筆）</b></p>${li(orgRows)}
      <p><b>同仁職稱${done ? '已改' : '會改'}（${staffRows.length} 筆）</b></p>${li(staffRows)}
      <p><b>權限規則${done ? '已補' : '會補'}（${permRows.length} 條）</b>${perm.status && perm.status !== 'ok' ? `<span class="text-muted">　${esc(PERM_TEXT[perm.status] || perm.status)}</span>` : ''}</p>${li(permRows)}
      <p><b>新出現的需處理名單（${todo.length} 人，要人資手動改派）</b></p>${li(todo)}
      <p><b>因此變合規（${resolved.length} 筆）</b></p>${li(resolved)}`;
  }
  async function upgrade2610Flow() {
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('staff', 'orgUpgrade202610', { dryrun: true }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!r.ok) { ctx.ui.toast(r.error || '預覽失敗', 'danger'); return; }
    const go = await ctx.ui.dialog({ title: '職稱調整：預覽（還沒寫入）', body: domOf(upgrade2610Html(r.data, false)), actions: [CANCEL, { label: '確定調整', value: 'go', variant: 'danger' }] });
    if (go !== 'go') return;
    ctx.ui.loading(true);
    let w;
    try { w = await ctx.api.call('staff', 'orgUpgrade202610', { dryrun: false }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!w.ok) { ctx.ui.toast(w.error || '調整失敗', 'danger'); return; }
    if (w.dryrun === true) { ctx.ui.toast('試跑模式：未寫入', 'warn'); return; }
    await ctx.ui.dialog({ title: '職稱調整完成', body: domOf(upgrade2610Html(w.data, true)), actions: OK_ONLY });
    if (alive) load();
  }
  async function rollback2610Flow() {
    if (!(await ctx.ui.confirm('退回職稱調整？組織表蓋回調整前的備份、中央工廠廠長改回店長、這次補的權限規則停用。若調整後組織表或這些同仁的職稱又被改過，系統會拒絕。'))) return;
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('staff', 'orgRollback202610', {}); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!r.ok) {
      const rd = (r.data && (r.data.diff || r.data.staff_diff ? r.data : r.data.data)) || {};
      const diff = rd.diff || [];
      const sdiff = rd.staff_diff || [];
      if (diff.length || sdiff.length) {
        const orgTbl = diff.length ? `<p><b>組織表差異</b></p><div class="table-wrap"><table class="table"><thead><tr><th>類別</th><th>代碼</th><th>欄位</th><th>調整後應為</th><th>目前</th></tr></thead><tbody>${diff.map((x) => `<tr><td>${esc(x.kind)}</td><td>${esc(x.code)}</td><td>${esc(x.field)}</td><td>${esc(x.expected)}</td><td>${esc(x.actual)}</td></tr>`).join('')}</tbody></table></div>` : '';
        const stfTbl = sdiff.length ? `<p><b>同仁職稱差異</b></p><div class="table-wrap"><table class="table"><thead><tr><th>編號</th><th>欄位</th><th>調整後應為</th><th>目前</th></tr></thead><tbody>${sdiff.map((x) => `<tr><td>${esc(x.emp_no)}</td><td>${esc(x.field)}</td><td>${esc(x.expected)}</td><td>${esc(x.actual)}</td></tr>`).join('')}</tbody></table></div>` : '';
        await ctx.ui.dialog({ title: '退回被拒絕', body: domOf(`<p>${esc(r.error)}</p>${orgTbl}${stfTbl}`), actions: OK_ONLY });
      } else ctx.ui.toast(r.error || '退回失敗', 'danger');
      return;
    }
    if (r.dryrun === true) { ctx.ui.toast('試跑模式：未寫入', 'warn'); return; }
    const d = r.data || {};
    const orphans = (d.orphans || []).map((o) => `${o.emp_no} ${o.name}（單位 ${o.unit || '—'}／職稱 ${o.title || '—'}${o.p_title ? '／送出待審 ' + o.p_title : ''}）`);
    await ctx.ui.dialog({
      title: '職稱調整已退回',
      body: domOf(`<p data-role="rb2610-sum">組織表還原 ${esc(d.restored)} 列；同仁職稱還原 ${esc(d.staff_restored || 0)} 筆；停用權限規則 ${esc((d.perm_disabled || []).length)} 條。</p>
        <p><b>退回後職稱需重選（只列不改）</b></p>${li(orphans)}`),
      actions: OK_ONLY
    });
    if (alive) load();
  }

  // 2026-10-23 名稱調整（docs/org/spec.md 第 16 節）：只改 org 四格顯示名稱（加盟部、總監、廚藝總監、品牌研發部），不動權限與審核
  const KIND_ZH = { dept: '部門', title: '職稱', brand: '品牌', role: '系統角色' };
  const kindZh = (k) => KIND_ZH[k] || k;
  function rename2610nHtml(d, done) {
    const rows = (d.changes || []).map((c) => `${kindZh(c.kind)} ${c.code}：${c.from} → ${c.to}`);
    const skipped = (d.skipped || []).map((c) => `${kindZh(c.kind)} ${c.code}：已經是「${c.name}」`);
    return `<p><b>名稱${done ? '已改' : '會改'}（${rows.length} 筆）</b></p>${li(rows)}
      <p><b>不用改（${skipped.length} 筆）</b></p>${li(skipped)}`;
  }
  const badOf = (r) => (r.data && (r.data.bad || (r.data.data && r.data.data.bad))) || [];
  async function renameBadDialog(r) {
    const bad = badOf(r).map((x) => `${kindZh(x.kind)} ${x.code}：應為「${x.expected}」，目前是「${x.actual}」`);
    await ctx.ui.dialog({ title: '名稱調整被拒絕', body: domOf(`<p>${esc(r.error)}</p>${li(bad)}`), actions: OK_ONLY });
  }
  async function rename2610nFlow() {
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('staff', 'orgRename202610', { dryrun: true }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!r.ok) { if (badOf(r).length) await renameBadDialog(r); else ctx.ui.toast(r.error || '預覽失敗', 'danger'); return; }
    const go = await ctx.ui.dialog({ title: '名稱調整：預覽（還沒寫入）', body: domOf(rename2610nHtml(r.data, false)), actions: [CANCEL, { label: '確定調整', value: 'go', variant: 'danger' }] });
    if (go !== 'go') return;
    ctx.ui.loading(true);
    let w;
    try { w = await ctx.api.call('staff', 'orgRename202610', { dryrun: false }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!w.ok) { if (badOf(w).length) await renameBadDialog(w); else ctx.ui.toast(w.error || '調整失敗', 'danger'); return; }
    if (w.dryrun === true) { ctx.ui.toast('試跑模式：未寫入', 'warn'); return; }
    await ctx.ui.dialog({ title: '名稱調整完成', body: domOf(rename2610nHtml(w.data, true)), actions: OK_ONLY });
    if (alive) load();
  }
  async function renameRollback2610nFlow() {
    if (!(await ctx.ui.confirm('退回名稱調整？加盟部、總監、廚藝總監、研發部（品牌）、總監（系統角色）改回加盟招商部、部門主管、研發總監、中央工廠、部門主管。若這些名稱調整後又被改過，系統會拒絕。'))) return;
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('staff', 'orgRenameRollback202610', {}); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!r.ok) { if (badOf(r).length) await renameBadDialog(r); else ctx.ui.toast(r.error || '退回失敗', 'danger'); return; }
    if (r.dryrun === true) { ctx.ui.toast('試跑模式：未寫入', 'warn'); return; }
    await ctx.ui.dialog({ title: '名稱調整已退回', body: domOf(rename2610nHtml(r.data, true)), actions: OK_ONLY });
    if (alive) load();
  }

  // 2026-10-23 新增品牌發展部（docs/org/spec.md 第 17 節）：鼎兆元總部加一個一般部門 branddev，不動權限與審核
  const BRANDDEV_ACT = { add: '新增一列', reactivate: '重新啟用', deactivate: '停用', skip: '不用改' };
  function branddevHtml(d, done) {
    const dep = d.dept || {};
    return `<p data-role="bd2610-sum">${done ? '已處理' : '會處理'}：${esc(BRANDDEV_ACT[d.action] || d.action)}（部門 ${esc(dep.code)}「${esc(dep.name)}」，掛在鼎兆元總部，順序 ${esc(dep.order)}）</p>`;
  }
  async function branddevRefuseDialog(r) {
    const dd = r.data || {};
    const bad = (dd.bad || []).map((x) => `部門 ${x.code}：應為「${x.expected}」，目前是「${x.actual}」`);
    const members = (dd.members || []).map((e) => `${e}`);
    await ctx.ui.dialog({ title: '品牌發展部被拒絕', body: domOf(`<p>${esc(r.error)}</p>${li(bad)}${members.length ? '<p><b>還在這個部門的同仁編號</b></p>' + li(members) : ''}`), actions: OK_ONLY });
  }
  const branddevRefused = (r) => !!(r.data && ((r.data.bad || []).length || (r.data.members || []).length));
  async function addBranddev2610Flow() {
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('staff', 'orgAddBranddev202610', { dryrun: true }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!r.ok) { if (branddevRefused(r)) await branddevRefuseDialog(r); else ctx.ui.toast(r.error || '預覽失敗', 'danger'); return; }
    const go = await ctx.ui.dialog({ title: '新增品牌發展部：預覽（還沒寫入）', body: domOf(branddevHtml(r.data, false)), actions: [CANCEL, { label: '確定新增', value: 'go', variant: 'danger' }] });
    if (go !== 'go') return;
    ctx.ui.loading(true);
    let w;
    try { w = await ctx.api.call('staff', 'orgAddBranddev202610', { dryrun: false }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!w.ok) { if (branddevRefused(w)) await branddevRefuseDialog(w); else ctx.ui.toast(w.error || '新增失敗', 'danger'); return; }
    if (w.dryrun === true) { ctx.ui.toast('試跑模式：未寫入', 'warn'); return; }
    await ctx.ui.dialog({ title: '新增品牌發展部完成', body: domOf(branddevHtml(w.data, true)), actions: OK_ONLY });
    if (alive) load();
  }
  async function branddevRollback2610Flow() {
    if (!(await ctx.ui.confirm('退回品牌發展部？部門會停用（不刪列）。若還有同仁的部門或兼任部門是品牌發展部，系統會拒絕並列出同仁編號。'))) return;
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('staff', 'orgAddBranddevRollback202610', {}); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!r.ok) { if (branddevRefused(r)) await branddevRefuseDialog(r); else ctx.ui.toast(r.error || '退回失敗', 'danger'); return; }
    if (r.dryrun === true) { ctx.ui.toast('試跑模式：未寫入', 'warn'); return; }
    await ctx.ui.dialog({ title: '品牌發展部已退回', body: domOf(branddevHtml(r.data, true)), actions: OK_ONLY });
    if (alive) load();
  }

  // LINE 重設密碼：最近紀錄（lineAuthLog）＋「停用此人的 LINE 重設密碼」（lineRevoke，二次確認）
  async function lineFlow(p) {
    const who = `${p.emp_no} ${p.name}`;
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('staff', 'lineAuthLog', { emp_no: p.emp_no }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '讀不到 LINE 紀錄', 'danger'); return; }
    const items = (r.data && r.data.items) || [];
    const revokedAt = Number(r.data && r.data.line_revoked_at) || 0;
    const rows = items.map((x) => `<li data-role="line-log-item">${esc(x.at)}　${esc(LINE_LOG_TEXT[x.type] || x.type)}</li>`).join('');
    const body = domOf(`<p class="text-muted">最近的 LINE 重設密碼紀錄（最多 5 筆）</p>
      ${rows ? `<ul data-role="line-log">${rows}</ul>` : '<p class="text-muted" data-role="line-log-empty">（沒有 LINE 重設密碼紀錄）</p>'}
      ${revokedAt ? `<p data-role="line-revoked">已於 ${esc(new Date(revokedAt + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '))} 停用；他要重新綁定 LINE、滿 7 天並用 LINE 打過卡才恢復。</p>` : ''}`);
    const v = await ctx.ui.dialog({ title: `LINE 重設密碼 ${who}`, body, actions: [{ label: '關閉', value: null, variant: 'secondary' }, { label: '停用此人的 LINE 重設密碼', value: 'revoke', variant: 'danger' }] });
    if (v !== 'revoke') return;
    if (!(await ctx.ui.confirm(`停用 ${who} 的 LINE 重設密碼？他要重新綁定 LINE、滿 7 天並用 LINE 打過卡，才能再用 LINE 重設密碼。用在懷疑被冒綁時。`))) return;
    ctx.ui.loading(true);
    let w;
    try { w = await ctx.api.call('staff', 'lineRevoke', { emp_no: p.emp_no }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!w || !w.ok) { ctx.ui.toast((w && w.error) || '停用失敗', 'danger'); return; }
    if (w.dryrun === true) { ctx.ui.toast('試跑模式：未寫入', 'warn'); return; }
    ctx.ui.toast('已停用此人的 LINE 重設密碼', 'ok');
  }

  async function onAction(e) {
    const btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const p = staff.find((x) => x.emp_no === btn.getAttribute('data-emp'));
    if (!p) return;
    const act = btn.getAttribute('data-act');
    const who = `${p.emp_no} ${p.name}`;
    if (isClockAct(act)) { handleClockAct(act, p, clockEnv()); return; }
    if (act === 'line') { await lineFlow(p); return; }

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
        ${field('ed-address', '居住地址', p.address)}${canExtra ? extraHtml(p) + (p.status === 'active' ? bulletinHtml(p) : '') : ''}<p class="field-hint">後台直接改正式資料，不必再確認。</p>`);
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
        // 只有已開通的同仁有這個勾選框（後端也只接受 active；審查 dzy-bulletin#44-12）
        const bulEl = body.querySelector('#ed-bul');
        if (bulEl && bulEl.checked !== !!p.bulletin_admin) payload.bulletin_admin = bulEl.checked;
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
