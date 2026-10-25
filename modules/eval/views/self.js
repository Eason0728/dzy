/**
 * 自評：同一套題目給自己打分（自評在正式分數裡算一票，同舊站），加三種留言：
 * 給下一季的自己、給夥伴（可多列，預設匿名）、給公司（一律匿名）。
 */
'use strict';

import { qLabel, btnWaiting, draftKey, draftLoad, draftSave, draftClear, starGroup, errText } from '../lib.js';

export function mountSelf(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  el.innerHTML = '<p class="ev-note">載入中…</p>';

  (async () => {
    const r = await ctx.api.call('eval', 'evMe', {});
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc(errText(r))}</p></div>`; return; }
    const d = r.data;
    if (!d.evaluable) { el.innerHTML = '<div class="card"><p>績效評核目前只開放門市與中央工廠同仁填寫。</p></div>'; return; }
    if (!d.bankReady) { el.innerHTML = '<div class="card"><p>所屬品牌的題目還沒設定好，本季暫不開放。</p></div>'; return; }
    const pt = d.me.kind === 'pt';
    const attBank = pt ? d.bank.pt_att : d.bank.ft_att;
    const head = `<div class="card"><div class="card-title">${esc(qLabel(d.quarter))}　自評</div>
      <p class="ev-note">給自己打分，你的自評跟同事的評分一起平均（算一票）。${pt ? '' : '正職的工作表現由主管依 KPI 評分，這裡只評態度。'}</p></div>`;
    if (!d.windowOpen) {
      el.innerHTML = head + '<div class="card"><p>現在不是填寫期間（每季第一個月 1～5 號）。下面是自評項目：</p><div data-role="preview"></div></div>';
      const pv = el.querySelector('[data-role="preview"]');
      pv.appendChild(starGroup(esc, '職能態度', attBank, null, null, true).el);
      if (pt) pv.appendChild(starGroup(esc, '職能表現', d.bank.pt_perf, null, null, true).el);
      return;
    }
    if (d.selfDone) { el.innerHTML = head + '<div class="card"><p class="ev-state done" style="margin:0">✓ 你已送出本季自評。每人每季只能自評一次。</p></div>'; return; }

    const key = draftKey(ctx, 'self', d.quarter);
    const dv = draftLoad(key) || {};
    el.innerHTML = head + (Object.keys(dv).length ? '<p class="ev-note">📝 已還原你上次沒送出的草稿。</p>' : '') +
      `<div class="card" data-role="stars"></div>
      <div class="card"><div class="card-title">想說的話</div>
        <div class="field"><label class="field-label" for="ev-note">給下一季的自己</label><textarea class="input" id="ev-note" rows="3" maxlength="1000"></textarea></div>
        <div class="field"><span class="field-label">給夥伴（可以寫很多位）</span><div data-role="peers"></div>
          <button type="button" class="btn btn-secondary" data-role="add-peer">＋ 再寫一位</button></div>
        <div class="field"><label class="field-label" for="ev-company">給公司的話（一律匿名，主管看不到是誰寫的）</label><textarea class="input" id="ev-company" rows="3" maxlength="1000"></textarea></div>
      </div>
      <div class="card"><p class="ev-note">⚠️ 每人每季只能自評一次，送出後不能修改。</p>
        <div class="btn-row"><button type="button" class="btn btn-primary" data-role="submit">送出自評</button></div><p class="field-hint" data-role="msg"></p></div>`;
    const starsBox = el.querySelector('[data-role="stars"]');
    const save = () => draftSave(key, collect(true));
    const att = starGroup(esc, '職能態度', attBank, dv.att, save);
    starsBox.appendChild(att.el);
    const perf = pt ? starGroup(esc, '職能表現', d.bank.pt_perf, dv.perf, save) : null;
    if (perf) starsBox.appendChild(perf.el);
    const note = el.querySelector('#ev-note');
    const company = el.querySelector('#ev-company');
    note.value = dv.note || '';
    company.value = dv.company || '';
    note.addEventListener('input', save);
    company.addEventListener('input', save);

    const peersBox = el.querySelector('[data-role="peers"]');
    const opts = '<option value="">選同事</option>' + d.peers.map((p) => `<option value="${esc(p.emp)}">${esc(p.name)}</option>`).join('');
    let rowSeq = 0;
    function addRow(v) {
      v = v || {};
      const id = 'ev-peer-' + (++rowSeq);
      const row = document.createElement('div');
      row.className = 'ev-grid2';
      row.setAttribute('data-role', 'peer-row');
      row.style.marginBottom = '8px';
      row.innerHTML = `<div><select class="input" aria-label="留言對象" data-f="to">${opts}</select>
          <label class="checkbox-row"><input type="checkbox" data-f="anon" id="${id}-anon"> 匿名</label></div>
        <textarea class="input" rows="2" maxlength="1000" aria-label="留言內容" data-f="msg"></textarea>`;
      row.querySelector('[data-f="to"]').value = v.to || '';
      row.querySelector('[data-f="msg"]').value = v.msg || '';
      row.querySelector('[data-f="anon"]').checked = v.anon !== false;   // 預設匿名（舊站）
      row.addEventListener('input', save);
      row.addEventListener('change', save);
      peersBox.appendChild(row);
    }
    (Array.isArray(dv.peers) && dv.peers.length ? dv.peers : [{}]).forEach(addRow);
    el.querySelector('[data-role="add-peer"]').addEventListener('click', () => addRow({}));

    function collect(forDraft) {
      const peers = Array.from(peersBox.querySelectorAll('[data-role="peer-row"]')).map((row) => ({
        to: row.querySelector('[data-f="to"]').value,
        msg: row.querySelector('[data-f="msg"]').value,
        anon: row.querySelector('[data-f="anon"]').checked
      }));
      return { att: att.values(), perf: perf ? perf.values() : [], note: note.value, company: company.value,
        peers: forDraft ? peers : peers.filter((p) => p.to && p.msg.trim()) };
    }

    const btn = el.querySelector('[data-role="submit"]');
    const msg = el.querySelector('[data-role="msg"]');
    btn.addEventListener('click', async () => {
      if (!att.complete() || (perf && !perf.complete())) { msg.textContent = '自評的每一題都要評。'; return; }
      const v = collect(false);
      if (Array.from(peersBox.querySelectorAll('[data-role="peer-row"]')).some((row) => row.querySelector('[data-f="msg"]').value.trim() && !row.querySelector('[data-f="to"]').value)) {
        msg.textContent = '有夥伴留言沒選對象。'; return;
      }
      if (!(await ctx.ui.confirm('送出後不能修改，確定送出自評？'))) return;
      const stop = btnWaiting(btn, '送出中');
      const res = await ctx.api.call('eval', 'evSelfSubmit', v);
      if (!alive) return;
      if (res && res.ok) { draftClear(key); stop(false); ctx.ui.toast('已送出本季自評', 'ok'); mountSelf(el, ctx); return; }
      if (res && res.error === 'duplicate') { draftClear(key); stop(false); msg.textContent = '你已送出過本季自評。'; return; }
      stop(true);
      msg.textContent = errText(res);
    });
  })();
  return () => { alive = false; };
}
