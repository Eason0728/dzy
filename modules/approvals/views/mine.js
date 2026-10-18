/**
 * 我的單（spec §7）：狀態、卡在誰、退回原因、改完再送、撤回。
 */
'use strict';

import { mountCardList } from '../list-view.js';
import { STATUS } from '../lib.js';

export function mountMine(el, ctx) {
  const esc = ctx.fmt.esc;
  let status = '';
  const opts = ['<option value="">全部狀態</option>'].concat(Object.keys(STATUS).map((k) => `<option value="${k}">${esc(STATUS[k][0])}</option>`)).join('');
  let alive = true;

  // apvMine 的 Form 沒有退回原因欄位 → 對 rejected 的單逐張讀 apvGet，拿該版最後一筆 reject／handle 事件的 note
  async function fillReasons(box, secs) {
    for (const s of secs) {
      for (const f of (s.forms || [])) {
        if (f.status !== 'rejected' || !alive) continue;
        const r = await ctx.api.call('approvals', 'apvGet', { id: f.id });
        if (!alive || !r || !r.ok || !r.data) continue;
        const ev = (r.data.events || []).filter((e) => (e.action === 'reject' || e.action === 'handle') && e.note).pop();
        const card = box.querySelector(`[data-role="apv-card"][data-id="${f.id}"]`);
        if (ev && card && !card.querySelector('[data-role="reject-note"]')) {
          const p = document.createElement('p');
          p.setAttribute('data-role', 'reject-note');
          p.className = 'field-hint';
          p.textContent = `退回原因：${ev.note}（${(ev.actor && ev.actor.name) || ''}）`;
          const thumbs = card.querySelector('[data-role="detail"]');
          card.insertBefore(p, thumbs);
        }
      }
    }
  }

  const un = mountCardList(el, ctx, {
    scope: 'mine',
    title: '我的單',
    hint: '你送出的請購、請款、人事異動。被退回的單可以改完再送；還沒有人核准前可以撤回。',
    empty: '你還沒有送過單',
    toolbar: () => `<div class="field"><label class="field-label" for="apv-mine-status">狀態</label><select class="input" id="apv-mine-status">${opts}</select></div>`,
    bindToolbar: (root, reload) => {
      root.querySelector('#apv-mine-status').addEventListener('change', (e) => { status = e.target.value; reload(); });
    },
    load: async () => {
      const r = await ctx.api.call('approvals', 'apvMine', status ? { status } : {});
      if (!r || !r.ok) return r || { ok: false };
      return { ok: true, sections: [{ forms: Array.isArray(r.data && r.data.forms) ? r.data.forms : [] }] };
    },
    after: (box, secs) => { fillReasons(box, secs); }
  });
  return () => { alive = false; un(); };
}
