/**
 * modules/me/views/unit.js — 單位通訊錄（docs/personnel/spec.md §6.4）
 * 店長以上（總部為總監以上）看同單位已確認同仁的姓名、職稱、手機；後端決定看不看得到。
 * 生日、地址（Eason 2026-10-25）：只有門市與央廚主管，後端回 private:true 才顯示這兩行；空的顯示「—」。
 * 一人一張卡（同打卡對照的 .card.stack）：欄位變多後表格在手機要左右滑才看得到手機／地址。
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
    const priv = res.data.private === true;
    const people = res.data.people;
    const line = (label, field, val) =>
      `<div data-field="${field}"><span class="text-muted">${label}</span>　${val ? esc(val) : '—'}</div>`;
    const cards = people.map((p) => `<div class="card stack" data-role="unit-row" data-emp="${esc(p.emp_no)}">
      <div><b>${esc(p.name)}</b>　<span class="text-muted">${esc(p.title_name)}・${esc(p.emp_no)}</span></div>
      ${line('手機', 'phone', p.phone)}
      ${priv ? line('生日', 'birthday', p.birthday) + line('地址', 'address', p.address) : ''}
    </div>`).join('');
    el.innerHTML = `<div class="stack"><div class="card"><div class="card-title">${esc(res.data.unit_name)}</div>
      <p class="text-muted">${people.length ? '共 ' + people.length + ' 位已確認的同仁' : '目前沒有已確認的同仁'}</p></div>${cards}</div>`;
  });
  return () => { alive = false; };
}
