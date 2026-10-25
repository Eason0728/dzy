/**
 * 新人考核：到職滿一個月的同仁自動出現（逾期 7 天以上標紅），店長（或往上一層的主管）考核一次。
 * 題目＝該品牌計時同仁那套（同舊站：正職新人也用計時題目）；分數單獨一筆，不併入每季分數。
 */
'use strict';

import { btnWaiting, starGroup, errText, r1 } from '../lib.js';

export function mountNewbie(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  el.innerHTML = '<p class="ev-note">載入中…</p>';

  async function load() {
    const r = await ctx.api.call('eval', 'evNewbieList', {});
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc(errText(r))}</p></div>`; return; }
    const list = r.data.list || [];
    const due = list.filter((x) => x.state === 'due');
    const waiting = list.filter((x) => x.state === 'waiting');
    el.innerHTML = `<div class="card"><div class="card-title">新人入職考核</div>
      <p class="ev-note">到職滿一個月由你考核一次，考完會從清單消失。題目跟計時同仁每季考核一樣（態度 30＋表現 70），分數只給新人自己看，不併入季分數。</p></div>
      <div class="card"><div class="card-title">待考核（${due.length}）</div>${due.length ? '<div data-role="due" style="display:flex;flex-direction:column;gap:8px"></div>' : '<p class="ev-note">目前沒有待考核的新人。</p>'}</div>
      ${waiting.length ? `<div class="card"><div class="card-title">還沒滿一個月</div><ul>${waiting.map((x) => `<li>${esc(x.name)}（${esc(x.unitName)}）到職 ${esc(x.hire)}，${esc(x.dueOn)} 起可考核（還有 ${x.daysLeft} 天）</li>`).join('')}</ul></div>` : ''}`;
    const box = el.querySelector('[data-role="due"]');
    due.forEach((x) => {
      const bank = r.data.banks[x.brand];
      const det = document.createElement('details');
      det.className = 'ev-person';
      det.setAttribute('data-role', 'ev-newbie');
      det.setAttribute('data-emp', x.emp);
      det.innerHTML = `<summary><span>${esc(x.name)}</span><span class="tag">${esc(x.unitName)}</span>
        <span class="ev-state ${x.late ? 'ev-down' : ''}">到職 ${esc(x.hire)}｜${x.overdueDays ? `已逾期 ${x.overdueDays} 天` : '今天滿一個月'}</span></summary><div class="ev-body"></div>`;
      const body = det.querySelector('.ev-body');
      if (!bank || !bank.pt_att.length || !bank.pt_perf.length) { body.innerHTML = '<p>這個品牌的題目還沒設定好，請人資先到「設定」輸入題目。</p>'; box.appendChild(det); return; }
      const att = starGroup(esc, '職能態度（滿分 30）', bank.pt_att, null, null);
      const perf = starGroup(esc, '職能表現（滿分 70）', bank.pt_perf, null, null);
      body.appendChild(att.el);
      body.appendChild(perf.el);
      const act = document.createElement('div');
      act.innerHTML = '<div class="btn-row"><button type="button" class="btn btn-primary" data-role="submit">送出考核</button></div><p class="field-hint" data-role="msg"></p>';
      body.appendChild(act);
      const btn = act.querySelector('[data-role="submit"]');
      const msg = act.querySelector('[data-role="msg"]');
      btn.addEventListener('click', async () => {
        if (!att.complete() || !perf.complete()) { msg.textContent = '每一題都要評。'; return; }
        if (!(await ctx.ui.confirm(`送出 ${x.name} 的入職考核？送出後不能修改。`))) return;
        const stop = btnWaiting(btn, '送出中');
        const res = await ctx.api.call('eval', 'evNewbieSubmit', { emp: x.emp, att: att.values(), perf: perf.values() });
        if (!alive) return;
        if (res && res.ok) { stop(false); ctx.ui.toast(`${x.name} 入職考核 ${r1(res.data.total)} 分，已送出`, 'ok'); load(); return; }
        stop(res && res.error !== 'duplicate');
        msg.textContent = errText(res);
      });
      box.appendChild(det);
    });
  }
  load();
  return () => { alive = false; };
}
