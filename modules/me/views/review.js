/**
 * modules/me/views/review.js — 待審核（認領後主管審核，Eason 2026-10-12；docs/personnel/spec.md §6.8／§7.4）
 *
 * 單位主管（店長／總部部門主管，後端依職級判斷）看自己單位送出開通申請的同仁，核對本人後「通過」或「退回」。
 * 人資（platform.staff）看得到全部單位（單位還沒有主管帳號時的備援）。
 * 分頁只有 platform.review／platform.staff 看得到（manifest）；萬一沒資格仍打開，只顯示後端說明，不報錯。
 * 退回＝同仁的認領被撤回、個資清空，他要重新「第一次使用」；原因只留在後台紀錄，請當面告訴他。
 */
'use strict';

export function mountReview(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let people = [];
  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';

  async function load() {
    const res = await ctx.api.call('me', 'unitPending', {});
    if (!alive) return;
    if (!res || !res.ok) {
      el.innerHTML = `<div class="card"><p class="text-muted">${esc((res && res.error) || '讀不到待審核名單')}</p></div>`;
      return;
    }
    people = Array.isArray(res.data.people) ? res.data.people : [];
    draw(res.data);
  }

  const orgText = (p) => [p.brand_name, p.unit_name, p.dept_name, p.title_name].filter(Boolean).join('／');

  function draw(d) {
    const scope = d.all_units ? '全部單位（人資）' : (d.scope_name || '');
    const cards = people.map((p) => `
      <div class="card stack" data-role="review-row" data-emp="${esc(p.emp_no)}">
        <div class="card-row"><div class="card-title">${esc(p.name)}　${esc(p.emp_no)}</div><span class="tag tag-warn">等你審核</span></div>
        <div class="table-wrap"><table class="table"><tbody>
          <tr><th>填的單位</th><td>${esc(orgText(p) || '—')}</td></tr>
          <tr><th>生日</th><td>${esc(p.birthday)}</td></tr>
          <tr><th>手機</th><td>${esc(p.phone)}</td></tr>
          <tr><th>地址</th><td>${esc(p.address)}</td></tr>
          <tr><th>送出時間</th><td>${esc(p.claimed_at)}</td></tr>
        </tbody></table></div>
        <div class="card-row">
          <button type="button" class="btn btn-primary" data-act="approve" data-emp="${esc(p.emp_no)}">通過</button>
          <button type="button" class="btn btn-danger" data-act="reject" data-emp="${esc(p.emp_no)}">退回</button>
        </div>
      </div>`).join('');
    el.innerHTML = `
      <div class="card"><div class="card-title">待審核${scope ? `｜${esc(scope)}` : ''}</div>
        <p class="text-muted">同仁第一次使用送出資料後，要你核對是本人、資料正確才通過；通過後他才能登入。</p></div>
      ${cards || '<div class="card" data-role="review-empty"><p class="text-muted">目前沒有等你審核的同仁</p></div>'}`;
  }

  function domOf(html) { const d = document.createElement('div'); d.innerHTML = html; return d; }

  async function send(action, payload, okMsg) {
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('me', action, payload); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '操作失敗，請稍後再試', 'danger'); return; }
    ctx.ui.toast(okMsg, 'ok');
    await load();
  }

  async function onClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const p = people.find((x) => x.emp_no === btn.getAttribute('data-emp'));
    if (!p) return;
    const who = `${p.emp_no} ${p.name}`;
    if (btn.getAttribute('data-act') === 'approve') {
      const body = domOf(`<p><b>請先確認是他本人</b>（當面或打手機 ${esc(p.phone)}），單位、職稱、生日都對再按通過。</p>
        <p>通過後生效：${esc(orgText(p))}</p>`);
      const v = await ctx.ui.dialog({ title: `通過 ${who}`, body, actions: [
        { label: '取消', value: null, variant: 'secondary' },
        { label: '已核對，通過', value: 'ok', variant: 'primary' }] });
      if (v === 'ok') await send('unitApprove', { emp_no: p.emp_no }, `已通過，${p.name} 現在可以登入了`);
    } else {
      const body = domOf(`<div class="field"><label class="field-label" for="rv-reason">退回原因（必填，留在後台紀錄）</label>
        <textarea class="input" id="rv-reason" rows="3" maxlength="200"></textarea></div>
        <p class="field-hint">退回後他填的資料會清空，要重新按「第一次使用」再送一次。原因請另外當面告訴他。</p>`);
      const v = await ctx.ui.dialog({ title: `退回 ${who}`, body, actions: [
        { label: '取消', value: null, variant: 'secondary' },
        { label: '退回', value: 'ok', variant: 'danger' }] });
      if (v !== 'ok') return;
      const reason = body.querySelector('#rv-reason').value.trim();
      if (!reason) { ctx.ui.toast('請填寫退回原因', 'warn'); return; }
      await send('unitReject', { emp_no: p.emp_no, reason }, '已退回');
    }
  }

  el.addEventListener('click', onClick);
  load();
  return () => { alive = false; el.removeEventListener('click', onClick); };
}
