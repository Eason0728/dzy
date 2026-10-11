/**
 * modules/me/views/unit.js — 單位通訊錄（docs/personnel/spec.md §6.4）
 * 店長以上（總部為部門主管以上）看同單位已確認同仁的姓名、職稱、手機；後端決定看不看得到。
 */
'use strict';

export function mountUnit(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';
  ctx.api.call('me', 'myUnit', {}).then((res) => {
    if (!alive) return;
    if (!res.ok) {
      el.innerHTML = `<div class="card"><p class="text-muted">${esc(res.error)}</p></div>`;
      return;
    }
    const rows = res.data.people.map((p) =>
      `<tr><td>${esc(p.emp_no)}</td><td>${esc(p.name)}</td><td>${esc(p.title_name)}</td><td>${esc(p.phone)}</td></tr>`).join('');
    el.innerHTML = `<div class="card"><div class="card-title">${esc(res.data.unit_name)}</div>
      <div class="table-wrap"><table class="table"><thead><tr><th>編號</th><th>姓名</th><th>職稱</th><th>手機</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">目前沒有已確認的同仁</td></tr>'}</tbody></table></div></div>`;
  });
  return () => { alive = false; };
}
