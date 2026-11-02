/**
 * 待回答：列出 open 的題目（小幫手答不出來／被按 👎）。
 * 「AI 擬答」→ svc op draft 帶入編輯框；「上架」＝aihKbSave（status live）＋aihPendingSet（done，帶 kb_id）；「略過」＝ignored。
 * 寫入鈕在試跑模式鎖住。
 */
'use strict';

import { h, clear, errText, busyBtn, lockIfDryrun, loadPages, pageLabel, keepPlace } from '../lib.js';
import { createEditor } from '../editor.js';
import { getClient } from '../../../platform/helper/client.js';

const REASON = { unknown: '小幫手答不出來', thumbs_down: '被按了 👎' };

export function mountPending(el, ctx, shared) {
  let alive = true;
  const client = (shared && shared.client) || getClient();
  const body = h('div', { 'data-role': 'pending-body' });
  el.appendChild(body);

  // stayId：處理完一題後停在原地（那題消失，就停在它下一題的位置）
  async function load(stayId) {
    const back = stayId ? keepPlace(body, stayId) : null;
    if (!back) { clear(body); body.appendChild(h('p', { class: 'aim-note' }, '載入中…')); }
    const [r, pages] = await Promise.all([ctx.api.call('platform', 'aihPendingList', { status: 'open' }), loadPages()]);
    if (!alive) return;
    clear(body);
    if (!r || !r.ok) {
      body.appendChild(h('div', { class: 'card' }, [h('p', null, r && r.error === 'not_inited' ? '小幫手還沒初始化。請系統管理者按上方的「初始化小幫手」。' : errText(r))]));
      return;
    }
    const items = (r.data && Array.isArray(r.data.items)) ? r.data.items : [];
    body.appendChild(h('p', { class: 'aim-note', 'data-role': 'pending-count' }, '待回答 ' + items.length + ' 題'));
    if (!items.length) { body.appendChild(h('div', { class: 'card' }, [h('p', null, '目前沒有待回答的題目。')])); return; }
    items.forEach((it) => body.appendChild(card(it, pages)));
    if (back) back();
  }

  function card(it, pages) {
    const box = h('div', { class: 'aim-item', 'data-role': 'pending-item', 'data-id': it.id });
    box.appendChild(h('div', { class: 'aim-q', 'data-role': 'pending-q' }, it.q || '（問題內容已清除）'));
    box.appendChild(h('div', { class: 'aim-meta' }, [
      '在哪一頁：' + pageLabel(pages, it.m, it.v) + '　·　' + (REASON[it.reason] || it.reason || '') + (it.count > 1 ? '　·　出現 ' + it.count + ' 次' : '')
    ]));
    const msg = h('p', { class: 'field-hint', 'data-role': 'pending-msg' });
    const act = h('div', { class: 'aim-act' });
    const draftBtn = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'draft' }, 'AI 擬答'));
    const writeBtn = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'write' }, '自己寫'));
    const skipBtn = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'ignore' }, '略過'));
    act.appendChild(draftBtn); act.appendChild(writeBtn); act.appendChild(skipBtn);
    box.appendChild(act);
    box.appendChild(msg);
    let editor = null;
    let editHost = null;

    function openEditor(seed) {
      if (!editor) {
        editor = createEditor({ pages });
        editHost = h('div', null, [editor.el]);
        const pub = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-primary', 'data-act': 'publish' }, '上架'));
        const cancel = h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'cancel' }, '取消');
        cancel.addEventListener('click', () => { box.removeChild(editHost); editor = null; editHost = null; });
        pub.addEventListener('click', () => publish(pub));
        editor.el.appendChild(h('div', { class: 'aim-act' }, [pub, cancel]));
        box.appendChild(editHost);
      }
      editor.fill(seed);
      editor.focus();
    }

    async function publish(btn) {
      const f = editor.get();
      if (!f.question || !f.answer) { msg.textContent = '問題和答案都要填'; return; }
      const done = busyBtn(btn, '上架中');
      const s = await ctx.api.call('platform', 'aihKbSave', Object.assign({}, f, { status: 'live' }));
      if (!alive) return;
      if (!s || !s.ok) { done(true); msg.textContent = '上架失敗：' + errText(s); return; }
      if (s.dryrun) { done(true); ctx.ui.toast('試跑模式：沒有真的上架', 'info'); return; }
      const p = await ctx.api.call('platform', 'aihPendingSet', { id: it.id, status: 'done', kb_id: s.data.id });
      if (!alive) return;
      if (!p || !p.ok) { done(true); msg.textContent = '已上架成題目 ' + s.data.id + '，但沒能把這筆待回答標成已處理：' + errText(p); return; }
      ctx.ui.toast('已上架', 'ok');
      load(it.id);
    }

    draftBtn.addEventListener('click', async () => {
      const done = busyBtn(draftBtn, 'AI 擬答中');
      msg.textContent = '';
      const r = await client.draft({ pendingId: it.id });
      if (!alive) return;
      done(true);
      if (!r.ok) { msg.textContent = 'AI 擬答失敗：' + r.error; return; }
      const d = r.data || {};
      openEditor({ question: d.question || it.q, answer: d.answer || '', who: d.who || '', m: d.m || it.m || '', v: d.v || it.v || '' });
      msg.textContent = 'AI 擬的答案只是草稿，請對照規定確認後再上架。';
    });
    writeBtn.addEventListener('click', () => openEditor({ question: it.q, m: it.m, v: it.v }));
    skipBtn.addEventListener('click', async () => {
      const done = busyBtn(skipBtn, '處理中');
      const r = await ctx.api.call('platform', 'aihPendingSet', { id: it.id, status: 'ignored' });
      if (!alive) return;
      if (!r || !r.ok) { done(true); msg.textContent = errText(r); return; }
      if (r.dryrun) { done(true); ctx.ui.toast('試跑模式：沒有真的略過', 'info'); return; }
      load(it.id);
    });
    return box;
  }

  load();
  return () => { alive = false; };
}
