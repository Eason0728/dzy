/**
 * 填寫評鑑（互評）：同店同事卡片 → 態度（＋計時的工作表現）→ 送出。
 * 沿用舊站：草稿自動存、只送評完的人（沒評完的人這季少一票，不算 0 分）、送出前確認、一季一次。
 * 非填寫期：只列出本季題目讓大家先看（唯讀）。
 */
'use strict';

import { qLabel, btnWaiting, draftKey, draftLoad, draftSave, draftClear, starGroup, errText } from '../lib.js';

export function mountFill(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  el.innerHTML = '<p class="ev-note">載入中…</p>';

  (async () => {
    const r = await ctx.api.call('eval', 'evMe', {});
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc(errText(r))}</p></div>`; return; }
    const d = r.data;
    if (!d.evaluable) {
      el.innerHTML = '<div class="card"><p>績效評核目前只開放門市與中央工廠同仁填寫。你不在評核名單上，如果覺得有誤，請找人資確認同仁名單上的單位與職稱。</p></div>';
      return;
    }
    if (!d.bankReady) {
      el.innerHTML = `<div class="card"><p>${esc(d.me.unitName)} 所屬品牌的題目還沒設定好，本季暫不開放。</p></div>`;
      return;
    }
    const head = `<div class="card"><div class="card-title">${esc(qLabel(d.quarter))}　同仁互評</div>
      <p class="ev-note">${esc(d.me.unitName)}　｜　每季第一個月 1～5 號填寫，10 號以後在「我的成績」看結果。每顆星都有說明，照實際觀察到的行為評。你評的分數不會讓任何人看到是你給的。</p></div>`;

    if (!d.windowOpen) {
      el.innerHTML = head + '<div class="card"><p>現在不是填寫期間。下面是評分項目，先看看下次要評哪些事：</p><div data-role="preview"></div></div>';
      const pv = el.querySelector('[data-role="preview"]');
      pv.appendChild(starGroup(esc, '計時同仁｜態度', d.bank.pt_att, null, null, true).el);
      pv.appendChild(starGroup(esc, '計時同仁｜工作表現', d.bank.pt_perf, null, null, true).el);
      pv.appendChild(starGroup(esc, '正職同仁｜態度', d.bank.ft_att, null, null, true).el);
      return;
    }
    if (d.peerDone) {
      el.innerHTML = head + '<div class="card"><p class="ev-state done" style="margin:0">✓ 你已送出本季互評，謝謝。每人每季只能送一次。</p></div>';
      return;
    }
    if (!d.peers.length) {
      el.innerHTML = head + '<div class="card"><p>你的單位目前沒有其他同仁可以評。</p></div>';
      return;
    }

    const key = draftKey(ctx, 'peer', d.quarter);
    const draft = draftLoad(key) || {};
    el.innerHTML = head + (Object.keys(draft).length ? '<p class="ev-note" data-role="restored">📝 已還原你上次沒送出的草稿。</p>' : '') +
      '<div data-role="list" style="display:flex;flex-direction:column;gap:10px"></div>' +
      '<div class="card ev-noprint"><p class="ev-note">⚠️ 每人每季只能評分一次，送出後不能修改；沒評完的同仁這次不會送出、之後也不能補評。</p>' +
      '<div class="btn-row"><button type="button" class="btn btn-primary" data-role="submit">送出評鑑</button></div><p class="field-hint" data-role="msg"></p></div>';
    const list = el.querySelector('[data-role="list"]');
    const cards = d.peers.map((p) => {
      const det = document.createElement('details');
      det.className = 'ev-person';
      det.setAttribute('data-role', 'ev-person');
      det.setAttribute('data-emp', p.emp);
      det.innerHTML = `<summary><span>🔥 ${esc(p.name)}</span><span class="tag">${p.kind === 'pt' ? '計時' : '正職'}</span><span class="ev-state" data-role="state">未評</span></summary><div class="ev-body"></div>`;
      const body = det.querySelector('.ev-body');
      const dv = draft[p.emp] || {};
      const save = () => { draft[p.emp] = { att: att.values(), perf: perf ? perf.values() : [] }; draftSave(key, draft); paintState(); };
      const att = starGroup(esc, '職能態度', p.kind === 'pt' ? d.bank.pt_att : d.bank.ft_att, dv.att, save);
      body.appendChild(att.el);
      const perf = p.kind === 'pt' ? starGroup(esc, '職能表現', d.bank.pt_perf, dv.perf, save) : null;
      if (perf) body.appendChild(perf.el);
      const st = det.querySelector('[data-role="state"]');
      const complete = () => att.complete() && (!perf || perf.complete());
      const started = () => att.values().some((v) => v !== null) || (perf && perf.values().some((v) => v !== null));
      function paintState() {
        st.textContent = complete() ? '✓ 已評完' : (started() ? '評到一半' : '未評');
        st.classList.toggle('done', complete());
      }
      paintState();
      list.appendChild(det);
      return { p, att, perf, complete, started };
    });

    const btn = el.querySelector('[data-role="submit"]');
    const msg = el.querySelector('[data-role="msg"]');
    btn.addEventListener('click', async () => {
      const done = cards.filter((c) => c.complete());
      const undone = cards.filter((c) => !c.complete());
      if (!done.length) { msg.textContent = '至少要完整評完一位同仁才能送出。'; return; }
      const text = undone.length
        ? `還有 ${undone.length} 位沒評完：${undone.map((c) => c.p.name).join('、')}。這次只會送出評完的 ${done.length} 位，之後不能補評。確定送出？`
        : `${done.length} 位都評完了。送出後不能修改，確定送出？`;
      if (!(await ctx.ui.confirm(text))) return;
      const stop = btnWaiting(btn, '送出中');
      const res = await ctx.api.call('eval', 'evPeerSubmit', { ratings: done.map((c) => ({ ratee: c.p.emp, att: c.att.values(), perf: c.perf ? c.perf.values() : [] })) });
      if (!alive) return;
      if (res && res.ok) {
        draftClear(key);
        stop(false);
        ctx.ui.toast('已送出本季互評', 'ok');
        mountFill(el, ctx);
        return;
      }
      if (res && res.error === 'duplicate') { draftClear(key); stop(false); msg.textContent = '你已送出過本季評鑑。'; return; }
      stop(true);
      msg.textContent = errText(res);
    });
  })();
  return () => { alive = false; };
}

