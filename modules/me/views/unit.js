/**
 * modules/me/views/unit.js — 單位通訊錄（docs/personnel/spec.md §6.4）
 * 店長以上（總部為總監以上）看同單位已確認同仁的姓名、職稱、手機；後端決定看不看得到。
 * 生日、地址（Eason 2026-10-25）：只有門市與央廚主管，後端回 private:true 才顯示這兩行；空的顯示「—」。
 * 一人一張卡（同打卡對照的 .card.stack）：欄位變多後表格在手機要左右滑才看得到手機／地址。
 * 我的區域（docs/regions/spec.md 第 4 節）：後端回 regions 非空時接在辦公室同事下面；每區一個標題、每家店一個
 * 可收合區塊（店名＋人數），只有姓名、職稱、手機（不給生日地址）；超過 30 人的店預設收合。
 */
'use strict';

export const REGION_COLLAPSE_OVER = 30;

/** 「我的區域」那段 HTML；沒有 regions（或空陣列）→ '' */
export function regionsHtml(regions, esc) {
  if (!Array.isArray(regions) || !regions.length) return '';
  const person = (p) => `<div class="card stack" data-role="region-row" data-emp="${esc(p.emp_no)}">
      <div><b>${esc(p.name)}</b>　<span class="text-muted">${esc(p.title_name)}${p.emp_no ? '・' + esc(p.emp_no) : ''}</span></div>
      <div data-field="phone"><span class="text-muted">手機</span>　${p.phone ? esc(p.phone) : '—'}</div>
    </div>`;
  const store = (s) => {
    const people = Array.isArray(s.people) ? s.people : [];
    const open = people.length <= REGION_COLLAPSE_OVER ? ' open' : '';
    return `<details class="card" data-role="region-store" data-unit="${esc(s.unit)}"${open}>
      <summary><b>${esc(s.unit_name || '已停用的門市')}</b>　<span class="text-muted">${people.length} 位</span></summary>
      <div class="stack">${people.length ? people.map(person).join('') : '<p class="text-muted">目前沒有已確認的同仁</p>'}</div>
    </details>`;
  };
  return `<div class="card" data-role="my-regions"><div class="card-title">我的區域</div></div>` +
    regions.map((r) => `<div class="stack" data-role="region" data-code="${esc(r.code || '')}">
      <div class="section-title">${esc(r.name)}</div>
      ${(r.stores || []).length ? r.stores.map(store).join('') : '<p class="text-muted">這個區域目前沒有門市</p>'}
    </div>`).join('');
}

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
      <p class="text-muted">${people.length ? '共 ' + people.length + ' 位已確認的同仁' : '目前沒有已確認的同仁'}</p></div>${cards}${regionsHtml(res.data.regions, esc)}</div>`;
  });
  return () => { alive = false; };
}
