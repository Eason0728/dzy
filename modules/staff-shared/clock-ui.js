/**
 * modules/staff-shared/clock-ui.js — 員工名單統一：共用畫面（D1～D4、D6；契約 docs/personnel/master-data/api.md）
 *
 * 同仁名單（staff 模組，總部）與我的資料（me 模組，店長）共用同一份，差別只在 viewer：
 *   viewer = { isHq, isLead, user }；mod = 呼叫 ctx.api.call 時用的模組 id（'staff' 或 'me'，兩者同一支平台後端）。
 * 權限只是「不顯示按鈕」，真正的檢查在後端；後端回的白話錯誤訊息一律原樣 toast。
 * 打卡連結金鑰只存在對話框的 DOM（關閉就清掉）；不寫 localStorage／sessionStorage、不進網址、不進 console。
 * 模組不得 import platform/，所以只依賴 ctx 與同資料夾的檔案。
 */
'use strict';

import { esc } from './esc.js';
import { orgFieldsHtml, bindOrgFields, readOrgFields } from './org-fields.js';
import {
  ymd, leaveMinDate, leaveDateError, leaveLabel, stoppedLabel, personActions, addFormErrors,
  pollJob, linkOutcome, clockLinkUrl, jobKindText
} from './clock-lib.js';

const domOf = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };
const CANCEL = { label: '取消', value: null, variant: 'secondary' };

function call(ctx, mod, action, payload) {
  return ctx.api.call(mod, action, payload || {});
}
async function callBusy(ctx, mod, action, payload) {
  ctx.ui.loading(true);
  try { return await call(ctx, mod, action, payload); } finally { ctx.ui.loading(false); }
}

// ============================================================
// 名單上的小標籤與按鈕（hq 表格與店長卡片共用）
// ============================================================

/** 狀態旁的補充標籤：「10/31 離職」「打卡已停 n/m」「打卡建檔中…」 */
export function clockTagsHtml(p) {
  const out = [];
  if (p.last_day) out.push(`<span class="tag tag-warn" data-role="leave-tag">${esc(leaveLabel(p.last_day))}</span>`);
  const s = stoppedLabel(p);
  if (s) out.push(`<span class="tag" data-role="stopped-tag">${esc(s)}</span>`);
  if (p.clock_job && p.clock_job.state !== 'done' && p.clock_job.state !== 'failed') out.push('<span class="tag tag-warn" data-role="job-tag">打卡建檔中…</span>');
  if (p.clock_job && p.clock_job.state === 'failed') out.push('<span class="tag tag-danger" data-role="job-tag">打卡未建</span>');
  return out.join(' ');
}

/** 每列的打卡相關按鈕（依 personActions 決定出現與否） */
export function clockButtonsHtml(p, viewer) {
  const a = personActions(p, viewer);
  const b = (act, label, cls) => `<button type="button" class="btn ${cls || 'btn-secondary'}" data-act="${act}" data-emp="${esc(p.emp_no)}">${label}</button>`;
  const out = [];
  if (a.leave) out.push(b('leave', p.last_day ? '改離職日' : '登記離職'));
  if (a.cancelLeave) out.push(b('leave-cancel', '撤銷離職'));
  if (a.link) out.push(b('link', '顯示打卡連結'));
  if (a.rename) out.push(b('rename-clock', '改名'));
  if (a.reinstate) out.push(b('reinstate', '復職'));
  return out.join(' ');
}

const CLOCK_ACTS = ['leave', 'leave-cancel', 'link', 'rename-clock', 'reinstate'];
export function isClockAct(act) { return CLOCK_ACTS.indexOf(act) !== -1; }

/** 點擊分派。env = { ctx, mod, viewer, reload } */
export async function handleClockAct(act, p, env) {
  if (act === 'leave') return openLeave(env, p);
  if (act === 'leave-cancel') return cancelLeave(env, p);
  if (act === 'link') return openLink(env, p);
  if (act === 'rename-clock') return openRename(env, p);
  if (act === 'reinstate') return openReinstate(env, p);
  return undefined;
}

// ============================================================
// D2 登記離職／撤銷離職
// ============================================================

async function openLeave(env, p) {
  const { ctx, mod, viewer } = env;
  const today = ymd(new Date());
  const min = leaveMinDate(today, viewer.isHq);
  let value = p.last_day || today;
  for (;;) {
    const hint = viewer.isHq ? '總部可以補登過去的日期。' : '最多往回補 7 天，更早的請找總部。';
    const body = domOf(`<div class="field"><label class="field-label" for="lv-date">最後上班日</label>
      <input class="input" id="lv-date" type="date" value="${esc(value)}"${min ? ` min="${esc(min)}"` : ''}></div>
      <p class="field-hint" data-role="leave-hint">${hint}可以選今天或未來的日子；這天之後系統會自動停用帳號與打卡（半夜 00:10 處理）。</p>`);
    const v = await ctx.ui.dialog({ title: `${p.last_day ? '改離職日' : '登記離職'} ${p.emp_no} ${p.name}`, body, actions: [CANCEL, { label: '送出', value: 'ok', variant: 'primary' }] });
    if (v !== 'ok') return false;
    value = body.querySelector('#lv-date').value;
    const err = leaveDateError(value, today, viewer.isHq);
    if (err) { ctx.ui.toast(err, 'warn'); continue; }
    const r = await callBusy(ctx, mod, 'staffLeave', { emp_no: p.emp_no, last_day: value });
    if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '登記失敗，請稍後再試', 'danger'); continue; }
    ctx.ui.toast(`已登記：${leaveLabel(r.data.last_day || value)}`, 'ok');
    await env.reload();
    return true;
  }
}

async function cancelLeave(env, p) {
  const { ctx, mod } = env;
  if (!(await ctx.ui.confirm(`撤銷 ${p.emp_no} ${p.name} 的離職登記？（${leaveLabel(p.last_day)}）`))) return false;
  const r = await callBusy(ctx, mod, 'staffLeaveCancel', { emp_no: p.emp_no });
  if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '撤銷失敗', 'danger'); return false; }
  ctx.ui.toast('已撤銷離職', 'ok');
  await env.reload();
  return true;
}

// ============================================================
// D3 顯示打卡連結（金鑰只在對話框裡，關掉就清）
// ============================================================

async function openLink(env, p) {
  const { ctx, mod } = env;
  const store = (p.clocks || []).filter((c) => c.role === 'home')[0] || (p.clocks || [])[0] || null;
  const storeCode = (env.storeCode) || (store && store.store_code) || undefined;
  const r = await callBusy(ctx, mod, 'clockLink', storeCode ? { emp_no: p.emp_no, store_code: storeCode } : { emp_no: p.emp_no });
  if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '取不到打卡連結', 'danger'); return false; }
  return showLinkDialog(ctx, mod, r.data.job_id, p, storeCode || (r.data.store_code || ''));
}

/** 已拿到 link 單的 job_id → 輪詢 → 顯示。openLink 與新增成功畫面共用 */
export async function showLinkDialog(ctx, mod, jobId, p, storeCode) {
  let stopped = false;
  const body = domOf('<p data-role="link-wait" class="text-muted">正在向打卡系統取連結…</p><div data-role="link-box"></div>');
  const dlg = ctx.ui.dialog({ title: `打卡連結 ${p.emp_no} ${p.name}`, body, actions: [{ label: '關閉', value: 'x', variant: 'secondary' }] });
  dlg.then(() => { stopped = true; body.innerHTML = ''; }); // 離開畫面即清掉金鑰
  const res = await pollJob(() => call(ctx, mod, 'clockJobStatus', { job_id: jobId }), { shouldStop: () => stopped });
  if (stopped) return false;
  const o = linkOutcome(res);
  const box = body.querySelector('[data-role="link-box"]');
  const wait = body.querySelector('[data-role="link-wait"]');
  if (o.kind !== 'ok') {
    wait.textContent = o.kind === 'expired' ? '連結已經取走或過期了，請關掉重新按「顯示打卡連結」。'
      : o.kind === 'timeout' ? '打卡系統還沒回應，請稍後再按一次「顯示打卡連結」。'
        : `取不到連結${o.error ? `（${o.error}）` : ''}，請稍後再試或通知總部。`;
    return false;
  }
  wait.remove();
  const url = clockLinkUrl(storeCode || (res.job && res.job.store_code), o.key);
  const shown = url || o.key;
  box.innerHTML = `<div class="field"><label class="field-label" for="lk-url">${url ? '專屬打卡網址' : '專屬金鑰（網址前綴查不到，請接在該店打卡頁後面 ?k=）'}</label>
      <input class="input" id="lk-url" type="text" readonly value="${esc(shown)}" data-role="link-url"></div>
    <div class="card-row"><button type="button" class="btn btn-primary" data-role="link-copy">複製</button></div>
    <p class="field-hint">這個連結只顯示這一次，關掉畫面就看不到了；請當場傳給同仁本人，不要貼在群組。</p>`;
  box.querySelector('[data-role="link-copy"]').addEventListener('click', async () => {
    const inp = box.querySelector('#lk-url');
    let done = false;
    try { await navigator.clipboard.writeText(inp.value); done = true; } catch (e) { /* 改走選取 */ }
    if (!done) { inp.select(); try { done = document.execCommand('copy'); } catch (e) { done = false; } }
    ctx.ui.toast(done ? '已複製' : '請長按文字手動複製', done ? 'ok' : 'warn');
  });
  return true;
}

// ============================================================
// 改名／復職（只總部）
// ============================================================

async function openRename(env, p) {
  const { ctx, mod } = env;
  const body = domOf(`<div class="field"><label class="field-label" for="rn2-name">新姓名</label><input class="input" id="rn2-name" value="${esc(p.name)}" maxlength="30"></div>
    <p class="field-hint">改名後，打卡端姓名要另外請各店改成一致；改完前首頁會提醒「打卡姓名不同」。</p>`);
  const v = await ctx.ui.dialog({ title: `改名 ${p.emp_no}`, body, actions: [CANCEL, { label: '儲存', value: 'ok', variant: 'primary' }] });
  if (v !== 'ok') return false;
  const name = body.querySelector('#rn2-name').value.trim();
  if (!name) { ctx.ui.toast('請填姓名', 'warn'); return false; }
  const r = await callBusy(ctx, mod, 'staffRename', { emp_no: p.emp_no, name });
  if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '改名失敗', 'danger'); return false; }
  const fix = (r.data.clock_stores_to_fix || []);
  if (fix.length) {
    const names = fix.map((code) => ((p.clocks || []).find((c) => c.store_code === code) || {}).store_name || code);
    await ctx.ui.dialog({ title: '還要到打卡端改名', body: domOf(`<p>已改成「${esc(r.data.name || name)}」。請到這幾家店的打卡端把姓名改成一致：</p><p data-role="fix-stores"><b>${esc(names.join('、'))}</b></p>`), actions: [{ label: '知道了', value: 'ok', variant: 'primary' }] });
  } else ctx.ui.toast('已改名', 'ok');
  await env.reload();
  return true;
}

async function openReinstate(env, p) {
  const { ctx, mod } = env;
  const pv = await callBusy(ctx, mod, 'staffReinstate', { emp_no: p.emp_no, preview: true });
  if (!pv || !pv.ok) { ctx.ui.toast((pv && pv.error) || '無法復職', 'danger'); return false; }
  const maps = pv.data.maps || [];
  const rows = maps.map((m, i) => `<div class="checkbox-row"><input type="checkbox" id="rs-${i}" data-store="${esc(m.store_code)}" checked>
      <label for="rs-${i}">${esc(m.store_name || m.store_code)}　${esc(m.emp_id)}（${m.role === 'home' ? '主店' : '支援'}${m.roster_active === false ? '・打卡已停' : ''}）</label></div>`).join('');
  const body = domOf(`<p>要恢復 ${esc(p.emp_no)} ${esc(p.name)} 的帳號。勾選要一起恢復打卡的店：</p>
    ${rows || '<p class="text-muted">他沒有已確認的打卡對照，只會恢復帳號。</p>'}`);
  const v = await ctx.ui.dialog({ title: `復職 ${p.emp_no}`, body, actions: [CANCEL, { label: '復職', value: 'ok', variant: 'primary' }] });
  if (v !== 'ok') return false;
  const stores = Array.from(body.querySelectorAll('input[type=checkbox]')).filter((c) => c.checked).map((c) => c.getAttribute('data-store'));
  const r = await callBusy(ctx, mod, 'staffReinstate', { emp_no: p.emp_no, stores });
  if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '復職失敗', 'danger'); return false; }
  ctx.ui.toast(stores.length ? `已復職，${stores.length} 家打卡恢復中` : '已復職', 'ok');
  await env.reload();
  return true;
}

// ============================================================
// D1 新增同仁（店長版固定單位；總部版可選）
// ============================================================

/**
 * env = { ctx, mod, viewer, org, myUnit, myUnitName, reload }
 * 流程：表單（驗不過就帶著填過的值重開）→ staffCreateByUnit → 輪詢 clockJobStatus → 三種結果畫面
 */
export async function openAddFlow(env) {
  const { ctx, mod, viewer, org } = env;
  const today = ymd(new Date());
  const val = { name: '', hire_date: today, phone: '', title: '', brand: '', unit: '', dept: '' };
  for (;;) {
    const unitPart = viewer.isHq
      ? orgFieldsHtml('ad')
      : `<div class="field"><span class="field-label">單位</span><div data-role="fixed-unit"><b>${esc(env.myUnitName || '你的單位')}</b>
          <span class="text-muted">（固定，不能選）</span></div></div>
        <div class="field"><label class="field-label" for="ad-title">職稱</label><select class="input" id="ad-title">
          <option value="">請選擇</option>${(org.titles || []).filter((t) => t.parent === 'store').map((t) => `<option value="${esc(t.code)}"${t.code === val.title ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>`;
    const body = domOf(`<div class="field"><label class="field-label" for="ad-name">姓名（全名）</label><input class="input" id="ad-name" maxlength="30" value="${esc(val.name)}"></div>
      ${unitPart}
      <div class="form-grid-2">
        <div class="field"><label class="field-label" for="ad-hire">到職日</label><input class="input" id="ad-hire" type="date" value="${esc(val.hire_date)}"></div>
        <div class="field"><label class="field-label" for="ad-phone">手機</label><input class="input" id="ad-phone" type="tel" inputmode="numeric" value="${esc(val.phone)}" placeholder="09xxxxxxxx"></div>
      </div>
      <p class="field-hint">同單位有同名的在職同仁時會擋下，請在姓名後加註（例如「王小明（二）」）。</p>`);
    if (viewer.isHq) bindOrgFields(body, 'ad', org, { brand: val.brand, unit: val.unit, dept: val.dept, title: val.title });
    const v = await ctx.ui.dialog({ title: '新增同仁', body, actions: [CANCEL, { label: '送出', value: 'ok', variant: 'primary' }] });
    if (v !== 'ok') return false;
    val.name = body.querySelector('#ad-name').value.trim();
    val.hire_date = body.querySelector('#ad-hire').value;
    val.phone = body.querySelector('#ad-phone').value.replace(/[\s-]/g, '');
    let payload;
    if (viewer.isHq) {
      const o = readOrgFields(body, 'ad');
      Object.assign(val, o);
      payload = { name: val.name, title: o.title, hire_date: val.hire_date, phone: val.phone, unit: o.unit };
      if (o.dept) payload.dept = o.dept;
      if (!o.unit) { ctx.ui.toast('請選單位', 'warn'); continue; }
    } else {
      val.title = body.querySelector('#ad-title').value;
      payload = { name: val.name, title: val.title, hire_date: val.hire_date, phone: val.phone }; // 店長不送 unit（後端也會忽略）
    }
    const errs = addFormErrors({ name: val.name, title: payload.title, hire_date: val.hire_date, phone: val.phone }, today);
    if (errs.length) { ctx.ui.toast(errs[0], 'warn'); continue; }
    const r = await callBusy(ctx, mod, 'staffCreateByUnit', payload);
    if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '新增失敗，請稍後再試', 'danger'); continue; }
    await showAddResult(env, r.data, val.name);
    return true;
  }
}

async function showAddResult(env, data, name) {
  const { ctx, mod, viewer } = env;
  const { emp_no: empNo, job_id: jobId } = data;
  if (!jobId) {
    await ctx.ui.dialog({ title: `${empNo} 已建立`, body: domOf(`<p data-role="add-nojob"><b>${esc(empNo)} ${esc(name)}</b> 已建立。</p><p data-role="no-clock">這個單位沒有打卡系統，不需要建打卡編號。</p>`), actions: [{ label: '完成', value: 'ok', variant: 'primary' }] });
    await env.reload();
    return;
  }
  let closed = false;
  const body = domOf(`<p data-role="add-created"><b>${esc(empNo)} ${esc(name)}</b> 已建立，打卡建檔中…</p>
    <p class="text-muted" data-role="add-wait">每 3 秒查一次，最多等 1 分鐘。</p><div data-role="add-result"></div>`);
  const dlg = ctx.ui.dialog({ title: '新增同仁', body, actions: [{ label: '關閉', value: 'x', variant: 'secondary' }] });
  dlg.then(() => { closed = true; });
  const res = await pollJob(() => call(ctx, mod, 'clockJobStatus', { job_id: jobId }), { shouldStop: () => closed });
  if (closed) { await env.reload(); return; }
  const out = body.querySelector('[data-role="add-result"]');
  body.querySelector('[data-role="add-wait"]').remove();
  const created = body.querySelector('[data-role="add-created"]');
  if (res.status === 'done') {
    const j = res.job;
    created.innerHTML = `<b>${esc(empNo)} ${esc(name)}</b> 已建立，打卡也建好了。`;
    out.setAttribute('data-state', 'done');
    out.innerHTML = `<div class="stack">
        <div>DZY 編號：<b data-role="res-dzy">${esc(empNo)}</b></div>
        <div>打卡編號：<b data-role="res-clock">${esc(j.emp_id)}</b></div></div>
      <div class="card-row"><button type="button" class="btn btn-primary" data-role="add-show-link">顯示打卡連結</button></div>
      <p class="field-hint" data-role="line-help">LINE 綁定：請同仁加入打卡的 LINE 官方帳號，輸入自己的全名完成綁定，之後就能用 LINE 打卡；
        也可以按上面的「顯示打卡連結」，把專屬連結當場傳給他。</p>`;
    const fresh = out.querySelector('[data-role="add-show-link"]');
    fresh.addEventListener('click', async () => {
      const lr = await callBusy(ctx, mod, 'clockLink', { emp_no: empNo, store_code: j.store_code || data.store_code });
      if (!lr || !lr.ok) { ctx.ui.toast((lr && lr.error) || '取不到打卡連結', 'danger'); return; }
      showLinkDialog(ctx, mod, lr.data.job_id, { emp_no: empNo, name }, j.store_code || data.store_code);
    });
  } else if (res.status === 'timeout') {
    created.innerHTML = `<b>${esc(empNo)} ${esc(name)}</b> 已建立。`;
    out.setAttribute('data-state', 'timeout');
    out.innerHTML = '<p data-role="add-timeout"><b>打卡還在建，稍後到同仁名單看。</b></p><p class="field-hint">不用重新新增；名單上的「打卡建檔中…」消失、出現打卡編號就好了。</p>';
  } else {
    created.innerHTML = `<b>${esc(empNo)} ${esc(name)}</b> 已建立，但打卡沒建成。`;
    out.setAttribute('data-state', 'failed');
    out.innerHTML = `<p data-role="add-failed"><b>打卡建檔失敗。</b>首頁「待辦與異常」會出現這一筆，${viewer.isHq ? '你可以在那裡按「重試」。' : '請通知總部按「重試」，你不用重新新增。'}</p>
      ${viewer.isHq ? '<div class="card-row"><button type="button" class="btn btn-secondary" data-role="add-retry">現在重試</button></div>' : ''}`;
    const rb = out.querySelector('[data-role="add-retry"]');
    if (rb) rb.addEventListener('click', async () => {
      const rr = await callBusy(ctx, mod, 'clockOutboxRetry', { job_id: jobId });
      ctx.ui.toast(rr && rr.ok ? '已重新排隊，稍後到同仁名單看結果' : ((rr && rr.error) || '重試失敗'), rr && rr.ok ? 'ok' : 'danger');
      if (rr && rr.ok) rb.disabled = true;
    });
  }
  await env.reload();
}

// ============================================================
// D4 打卡對照（店長＝只有 suggested；總部＝全部）
// ============================================================

const KIND_TEXT = {
  ambiguous: '同名多人', dup_in_store: '同店兩個編號', conflict: '同人同店已有生效編號',
  rejected: '對照被退回，需重指定', escalated: '店長說不對，轉總部'
};
const ROLE_TEXT = { home: '主店', support: '支援' };
const HQ_TABS = [['all', '全部對照'], ['needs', '需總部處理'], ['cand', '候選新人'], ['oldhome', '舊主店'], ['jobs', '待辦單']];

/** env = { ctx, mod, viewer, org, tab? } */
export function mountClockMap(el, env) {
  const { ctx, mod, viewer } = env;
  const isHq = viewer.isHq;
  let alive = true;
  let data = { suggested: [], needs_hq: [], candidates: [], confirmed_count: 0, built_at: '' };
  let alerts = {};
  let tab = (ctx.params && ctx.params.t) || (isHq ? 'all' : 'suggested');
  if (tab === 'suggested') tab = 'all';
  if (!isHq) tab = 'all';
  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';

  async function load() {
    const [r, a] = await Promise.all([call(ctx, mod, 'clockMapList', {}), isHq ? call(ctx, mod, 'clockAlerts', {}) : Promise.resolve(null)]);
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc((r && r.error) || '讀不到打卡對照')}</p></div>`; return; }
    data = Object.assign(data, r.data);
    alerts = a && a.ok ? (a.data || {}) : {};
    draw();
  }

  const unitOf = (x) => x.unit_name || x.unit || '';

  function suggestedHtml() {
    const rows = data.suggested || [];
    if (!rows.length) return `<div class="card" data-role="cm-empty"><p class="text-muted">${isHq ? '目前沒有待確認或未生效的對照' : '目前沒有要你確認的打卡對照'}</p></div>`;
    return rows.map((x) => `
      <div class="card stack" data-role="cm-row" data-store="${esc(x.store_code)}" data-emp-id="${esc(x.emp_id)}">
        <div class="card-row"><div class="card-title">${esc(x.name)}　${esc(x.emp_no)}</div>
          <span class="tag ${x.state === 'confirmed' ? 'tag-ok' : x.state === 'rejected' ? 'tag-danger' : 'tag-warn'}">${x.state === 'confirmed' ? '已確認' : x.state === 'rejected' ? '已退回' : '等確認'}</span></div>
        <div class="text-muted">${esc(unitOf(x))}｜打卡：${esc(x.store_name || x.store_code)} 編號 ${esc(x.emp_id)}（${esc(ROLE_TEXT[x.role] || x.role)}）${x.last_punch ? `｜最近打卡 ${esc(x.last_punch)}` : ''}</div>
        <p class="field-hint">這個人在打卡系統的 ${esc(x.emp_id)}，就是 ${esc(x.name)} 本人嗎？</p>
        <div class="card-row">
          <button type="button" class="btn btn-primary" data-act="cm-yes" data-store="${esc(x.store_code)}" data-eid="${esc(x.emp_id)}">對</button>
          <button type="button" class="btn btn-danger" data-act="cm-no" data-store="${esc(x.store_code)}" data-eid="${esc(x.emp_id)}">不對</button>
          ${isHq ? `<button type="button" class="btn btn-secondary" data-act="cm-assign" data-store="${esc(x.store_code)}" data-eid="${esc(x.emp_id)}">指定給別人…</button>` : ''}
        </div>
      </div>`).join('');
  }

  function needsHtml() {
    const rows = data.needs_hq || [];
    if (!rows.length) return '<div class="card" data-role="cm-empty"><p class="text-muted">沒有需要總部處理的對照</p></div>';
    return rows.map((x, i) => `
      <div class="card stack" data-role="needs-row">
        <div class="card-row"><div class="card-title">${esc(x.name)}</div><span class="tag tag-warn">${esc(KIND_TEXT[x.kind] || x.kind)}</span></div>
        <div class="text-muted">打卡編號：${(x.entries || []).map((e) => `${esc(e.store_code)}:${esc(e.emp_id)}`).join('、')}</div>
        <div class="text-muted">可能是：${(x.options || []).map((o) => `${esc(o.emp_no)} ${esc(o.name)}（${esc(o.unit)}）`).join('、') || '—'}</div>
        <div class="card-row"><button type="button" class="btn btn-primary" data-act="needs-assign" data-i="${i}">指定</button></div>
      </div>`).join('');
  }

  function candHtml() {
    const rows = data.candidates || [];
    if (!rows.length) return '<div class="card" data-role="cm-empty"><p class="text-muted">沒有候選新人</p></div>';
    return `<div class="card"><p class="text-muted">這些人在打卡系統是在職，但管理系統找不到同名同仁。先確認是不是真人（排除測試帳號、錯字），再按「建立」補進同仁名單。</p></div>` + rows.map((x, i) => `
      <div class="card stack" data-role="cand-row" data-key="${esc(x.key)}">
        <div class="card-row"><div class="card-title">${esc(x.name)}</div></div>
        <div class="text-muted">打卡：${(x.entries || []).map((e) => `${esc(e.store_code)}:${esc(e.emp_id)}`).join('、')}</div>
        <div class="card-row"><button type="button" class="btn btn-primary" data-act="cand-create" data-i="${i}">建立同仁</button>
          <button type="button" class="btn btn-secondary" data-act="cand-dismiss" data-i="${i}">排除</button></div>
      </div>`).join('');
  }

  function oldHomeHtml() {
    const rows = alerts.transfer_ask || [];
    if (!rows.length) return '<div class="card" data-role="cm-empty"><p class="text-muted">沒有待決定的舊主店</p></div>';
    return `<div class="card"><p class="text-muted">這些同仁調店後，舊主店變成「支援」。要不要把舊店的打卡停掉？</p></div>` + rows.map((x, i) => `
      <div class="card stack" data-role="oldhome-row">
        <div class="card-row"><div class="card-title">${esc(x.emp_no)}</div><span class="text-muted">舊主店 ${esc(x.store_code)}</span></div>
        <div class="card-row"><button type="button" class="btn btn-danger" data-act="old-stop" data-i="${i}">停用舊店打卡</button>
          <button type="button" class="btn btn-secondary" data-act="old-keep" data-i="${i}">保留（當支援）</button></div>
      </div>`).join('');
  }

  function jobsHtml() {
    const rows = alerts.outbox_failed || [];
    if (!rows.length) return '<div class="card" data-role="cm-empty"><p class="text-muted">沒有失敗的待辦單</p></div>';
    return rows.map((x, i) => `
      <div class="card stack" data-role="job-row" data-job="${esc(x.job_id)}">
        <div class="card-row"><div class="card-title">${esc(x.emp_no || '')} ${esc(jobKindText(x.kind))}</div><span class="tag tag-danger">失敗（試了 ${esc(x.tries)} 次）</span></div>
        <div class="text-muted">${esc(x.store_code || '')}｜${esc(x.last_error || '')}</div>
        <div class="card-row"><button type="button" class="btn btn-primary" data-act="job-retry" data-i="${i}">重試</button></div>
      </div>`).join('');
  }

  function draw() {
    const counts = { all: (data.suggested || []).length, needs: (data.needs_hq || []).length, cand: (data.candidates || []).length, oldhome: (alerts.transfer_ask || []).length, jobs: (alerts.outbox_failed || []).length };
    const head = isHq
      ? `<div class="card stack" data-role="cm-head">
          <div class="card-row"><div class="card-title">打卡對照</div><span class="text-muted">已生效 ${esc(data.confirmed_count)} 筆${data.built_at ? `｜上次建立 ${esc(data.built_at)}` : ''}</span></div>
          <p class="text-muted">把打卡系統裡的人，一對一對到管理系統的同仁。同一個人同一家店只能有一個生效編號。</p>
          <div class="card-row"><button type="button" class="btn btn-primary" data-act="build" data-role="build">建立打卡對照</button></div>
          <div class="card-row" data-role="cm-tabs">${HQ_TABS.map(([k, n]) => `<button type="button" class="btn ${k === tab ? 'btn-primary' : 'btn-secondary'}" data-act="tab" data-t="${k}" data-role="cm-tab">${n}${counts[k] ? `（${counts[k]}）` : ''}</button>`).join(' ')}</div>
        </div>`
      : `<div class="card"><div class="card-title">打卡對照</div>
          <p class="text-muted">打卡系統裡的人，系統猜他是你單位的哪位同仁。請核對：是本人按「對」，不是按「不對」（會轉給總部處理）。</p></div>`;
    const bodyHtml = !isHq ? suggestedHtml() : ({ all: suggestedHtml, needs: needsHtml, cand: candHtml, oldhome: oldHomeHtml, jobs: jobsHtml }[tab] || suggestedHtml)();
    el.innerHTML = head + `<div data-role="cm-body" data-tab="${esc(tab)}">${bodyHtml}</div>`;
  }

  async function act(fn) {
    const ok = await fn();
    if (ok !== false && alive) await load();
  }

  async function decide(payload, okMsg) {
    const r = await callBusy(ctx, mod, 'clockMapDecide', payload);
    if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '操作失敗', 'danger'); return false; }
    ctx.ui.toast(r.data && r.data.escalated ? '已轉給總部處理' : okMsg, 'ok');
    return true;
  }

  async function assignDialog(entries, options, title) {
    const optList = (options || []).map((o) => `<option value="${esc(o.emp_no)} ${esc(o.name)}"></option>`).join('');
    const body = domOf(`${entries.length > 1 ? `<div class="field"><label class="field-label" for="as-entry">哪一個打卡編號</label><select class="input" id="as-entry">
        ${entries.map((e, i) => `<option value="${i}">${esc(e.store_code)}:${esc(e.emp_id)}</option>`).join('')}</select></div>` : `<p>打卡編號：<b>${esc(entries[0].store_code)}:${esc(entries[0].emp_id)}</b></p>`}
      <div class="field"><label class="field-label" for="as-emp">指給哪位同仁（DZY 編號）</label>
        <input class="input" id="as-emp" list="as-opts" placeholder="DZY001" autocomplete="off"><datalist id="as-opts">${optList}</datalist></div>
      <div class="field"><label class="field-label" for="as-role">這是他的</label><select class="input" id="as-role">
        <option value="">維持原本</option><option value="home">主店</option><option value="support">支援店</option></select></div>`);
    const v = await ctx.ui.dialog({ title, body, actions: [CANCEL, { label: '確認指定', value: 'ok', variant: 'primary' }] });
    if (v !== 'ok') return null;
    const emp = (body.querySelector('#as-emp').value.match(/DZY\d+/i) || [''])[0].toUpperCase();
    if (!emp) { ctx.ui.toast('請輸入同仁的 DZY 編號', 'warn'); return null; }
    const sel = body.querySelector('#as-entry');
    return { entry: entries[sel ? Number(sel.value) : 0], emp_no: emp, role: body.querySelector('#as-role').value };
  }

  async function onClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const a = btn.getAttribute('data-act');
    const i = Number(btn.getAttribute('data-i'));
    const store = btn.getAttribute('data-store');
    const eid = btn.getAttribute('data-eid');
    if (a === 'tab') { tab = btn.getAttribute('data-t'); draw(); return; }
    if (a === 'cm-yes') return act(() => decide({ store_code: store, emp_id: eid, decision: 'confirm' }, '已確認'));
    if (a === 'cm-no') {
      if (!(await ctx.ui.confirm('確定不是這位同仁？這筆會轉給總部處理。'))) return;
      return act(() => decide({ store_code: store, emp_id: eid, decision: 'reject' }, '已退回'));
    }
    if (a === 'cm-assign') {
      const r = await assignDialog([{ store_code: store, emp_id: eid }], [], `指定 ${store}:${eid}`);
      if (!r) return;
      return act(() => decide(Object.assign({ store_code: r.entry.store_code, emp_id: r.entry.emp_id, decision: 'confirm', emp_no: r.emp_no }, r.role ? { role: r.role } : {}), '已指定'));
    }
    if (a === 'needs-assign') {
      const x = (data.needs_hq || [])[i];
      if (!x) return;
      const r = await assignDialog(x.entries || [], x.options || [], `指定 ${x.name}`);
      if (!r) return;
      return act(() => decide(Object.assign({ store_code: r.entry.store_code, emp_id: r.entry.emp_id, decision: 'confirm', emp_no: r.emp_no }, r.role ? { role: r.role } : {}), '已指定'));
    }
    if (a === 'build') {
      if (!(await ctx.ui.confirm('要重新讀取六家店的打卡名冊、建立對照嗎？已確認的不會被動到。'))) return;
      const r = await callBusy(ctx, mod, 'clockMapBuild', {});
      if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '前置檢查沒過，無法建立', 'danger'); return; }
      ctx.ui.toast('已送出，正在建立對照…', 'ok');
      const res = await pollJob(() => call(ctx, mod, 'clockJobStatus', { job_id: r.data.job_id }), { shouldStop: () => !alive });
      if (!alive) return;
      ctx.ui.toast(res.status === 'done' ? '對照建立完成' : res.status === 'failed' ? '建立失敗，請看「待辦單」' : '還在跑，稍後重新整理看結果', res.status === 'done' ? 'ok' : 'warn');
      await load();
      return;
    }
    if (a === 'cand-create') {
      const x = (data.candidates || [])[i];
      if (!x) return;
      return act(() => createCandidate(x));
    }
    if (a === 'cand-dismiss') {
      const x = (data.candidates || [])[i];
      if (!x || !(await ctx.ui.confirm(`排除「${x.name}」？之後重建對照不會再出現（用在測試帳號或錯字）。`))) return;
      return act(async () => {
        const r = await callBusy(ctx, mod, 'clockCandidateDismiss', { candidate_key: x.key });
        if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '排除失敗', 'danger'); return false; }
        ctx.ui.toast('已排除', 'ok');
        return true;
      });
    }
    if (a === 'old-stop' || a === 'old-keep') {
      const x = (alerts.transfer_ask || [])[i];
      if (!x) return;
      const stop = a === 'old-stop';
      if (stop && !(await ctx.ui.confirm(`停用 ${x.emp_no} 在 ${x.store_code} 的打卡？`))) return;
      return act(async () => {
        const r = await callBusy(ctx, mod, 'clockOldHomeDecide', { emp_no: x.emp_no, store_code: x.store_code, deactivate: stop });
        if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '操作失敗', 'danger'); return false; }
        ctx.ui.toast(stop ? '已排停用' : '已保留', 'ok');
        return true;
      });
    }
    if (a === 'job-retry') {
      const x = (alerts.outbox_failed || [])[i];
      if (!x) return;
      return act(async () => {
        const r = await callBusy(ctx, mod, 'clockOutboxRetry', { job_id: x.job_id });
        if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '重試失敗', 'danger'); return false; }
        ctx.ui.toast('已重新排隊', 'ok');
        return true;
      });
    }
    return undefined;
  }

  async function createCandidate(x) {
    const org = env.org || { brands: [], units: [], depts: [], titles: [] };
    const body = domOf(`<p>為「<b>${esc(x.name)}</b>」建立同仁（未開通，沒有手機；他之後自己認領）。</p>${orgFieldsHtml('cc')}
      <div class="field"><label class="field-label" for="cc-hire">到職日（選填）</label><input class="input" id="cc-hire" type="date"></div>`);
    bindOrgFields(body, 'cc', org, {});
    const v = await ctx.ui.dialog({ title: '建立候選新人', body, actions: [CANCEL, { label: '建立', value: 'ok', variant: 'primary' }] });
    if (v !== 'ok') return false;
    const o = readOrgFields(body, 'cc');
    if (!o.unit || !o.title) { ctx.ui.toast('請選單位與職稱', 'warn'); return false; }
    const payload = { candidate_key: x.key, unit: o.unit, title: o.title };
    if (o.dept) payload.dept = o.dept;
    const hd = body.querySelector('#cc-hire').value;
    if (hd) payload.hire_date = hd;
    const r = await callBusy(ctx, mod, 'clockCandidateCreate', payload);
    if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '建立失敗', 'danger'); return false; }
    ctx.ui.toast(`已建立 ${r.data.emp_no}`, 'ok');
    return true;
  }

  el.addEventListener('click', onClick);
  load();
  return () => { alive = false; el.removeEventListener('click', onClick); };
}

// ============================================================
// 店長「我的單位」：staffUnitList（沒有手機、生日、地址）
// ============================================================

/** env = { ctx, mod, viewer }；店長版名單，含新增、離職、打卡連結 */
export function mountTeam(el, env) {
  const { ctx, mod, viewer } = env;
  const f = (ctx.params && ctx.params.f) || '';
  let alive = true;
  let people = [];
  let unitName = '';
  let unit = '';
  let org = { brands: [], units: [], depts: [], titles: [] };
  let failed = [];
  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';

  async function load() {
    const [r, o, a] = await Promise.all([call(ctx, mod, 'staffUnitList', {}), call(ctx, mod, 'orgOptions', {}), call(ctx, mod, 'clockAlerts', {})]);
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc((r && r.error) || '讀不到單位名單')}</p></div>`; return; }
    people = r.data.people || [];
    unit = r.data.unit || (people[0] && people[0].unit) || '';
    unitName = (people[0] && people[0].unit_name) || (org.units.find((u) => u.code === unit) || {}).name || '';
    if (o && o.ok) org = o.data;
    failed = a && a.ok && a.data ? (a.data.outbox_failed || []) : [];
    if (!unitName) unitName = (org.units.find((u) => u.code === unit) || {}).name || '你的單位';
    draw();
  }

  function visible() {
    if (f === 'left') return people.filter((p) => (p.status === 'disabled' || p.last_day) && p.clock_total > p.clock_stopped);
    if (f === 'nohome') return people.filter((p) => p.status !== 'disabled' && !p.clock_total && !p.clock_job);
    return people;
  }

  function cardHtml(p) {
    const tags = clockTagsHtml(p);
    return `<div class="card stack" data-role="team-row" data-emp="${esc(p.emp_no)}">
      <div class="card-row"><div class="card-title">${esc(p.name)}　${esc(p.emp_no)}</div>
        <span class="tag ${p.status === 'disabled' ? '' : 'tag-ok'}">${p.status === 'disabled' ? '已離職' : (p.status === 'active' ? '在職' : '未開通')}</span></div>
      <div class="text-muted">${esc(p.title_name || '—')}｜到職 ${esc(p.hire_date || '—')}</div>
      ${(p.clocks || []).length ? `<div class="text-muted">打卡：${p.clocks.map((c) => `${esc(c.store_name || c.store_code)} ${esc(c.emp_id)}${c.role === 'home' ? '（主店）' : ''}`).join('、')}</div>` : ''}
      ${tags ? `<div class="card-row">${tags}</div>` : ''}
      <div class="card-row">${clockButtonsHtml(p, viewer)}</div></div>`;
  }

  function draw() {
    const list = visible();
    const failRows = failed.length ? `<div class="card stack" data-role="team-failed">
        <div class="card-title">打卡待辦單失敗（${failed.length}）</div>
        ${failed.map((x) => `<div class="text-muted">${esc(x.emp_no || '')} ${esc(jobKindText(x.kind))}：${esc(x.last_error || '失敗')}</div>`).join('')}
        <p class="field-hint">請通知總部按「重試」；你不用重新新增。</p></div>` : '';
    el.innerHTML = `
      <div class="card stack">
        <div class="card-row"><div class="card-title">我的單位｜${esc(unitName)}</div>
          <button type="button" class="btn btn-primary" data-act="add" data-role="add-staff">新增同仁</button></div>
        <p class="text-muted">只列你單位的同仁，不含手機、生日、地址。新增同仁會當場建好打卡編號。${f ? '（已套用提醒篩選）' : ''}</p>
      </div>${failRows}
      ${list.map(cardHtml).join('') || '<div class="card"><p class="text-muted">沒有符合的同仁</p></div>'}`;
  }

  const envOf = () => ({ ctx, mod, viewer, org, myUnit: unit, myUnitName: unitName, reload: load });

  async function onClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const a = btn.getAttribute('data-act');
    if (a === 'add') { await openAddFlow(envOf()); return; }
    const p = people.find((x) => x.emp_no === btn.getAttribute('data-emp'));
    if (p && isClockAct(a)) await handleClockAct(a, p, envOf());
  }

  el.addEventListener('click', onClick);
  load();
  return () => { alive = false; el.removeEventListener('click', onClick); };
}
