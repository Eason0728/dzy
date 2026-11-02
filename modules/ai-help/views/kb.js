/**
 * 知識庫：搜尋、狀態篩選、新增／編輯、上架／下架、看歷史並「回到這個版本」（把快照帶回編輯框，仍要按儲存才生效）。
 * 寫入鈕在試跑模式鎖住。到期日用台北今天比對，已過期或 14 天內到期會標出來。
 */
'use strict';

import { h, clear, errText, busyBtn, lockIfDryrun, loadPages, pageLabel, taipeiDay } from '../lib.js';
import { createEditor } from '../editor.js';

const STATUS_ZH = { live: '上架中', draft: '草稿', off: '已下架' };
const ACTION_ZH = { create: '新增', publish: '上架', unpublish: '下架', update: '修改', pause_on: '暫停小幫手', pause_off: '恢復小幫手', expire: '到期下架' };

function addDays(ymd, n) {
  const d = new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000);
  return d.toISOString().slice(0, 10);
}

export function mountKb(el, ctx) {
  let alive = true;
  let q = '';
  let status = '';
  const filter = h('div', { class: 'aim-filter' });
  const search = h('input', { class: 'input', type: 'search', placeholder: '搜尋問題、答案、找誰', 'data-role': 'kb-search', 'aria-label': '搜尋知識庫' });
  const sel = h('select', { class: 'input', 'data-role': 'kb-status', 'aria-label': '狀態' }, [
    h('option', { value: '' }, '全部狀態'), h('option', { value: 'live' }, '上架中'), h('option', { value: 'draft' }, '草稿'), h('option', { value: 'off' }, '已下架')
  ]);
  const addBtn = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-primary', 'data-act': 'kb-new' }, '新增一題'));
  filter.appendChild(search); filter.appendChild(sel); filter.appendChild(addBtn);
  const newHost = h('div', { 'data-role': 'kb-new-host' });
  const list = h('div', { 'data-role': 'kb-list' });
  el.appendChild(filter); el.appendChild(newHost); el.appendChild(list);

  let timer = null;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value.trim(); load(); }, 250); });
  sel.addEventListener('change', () => { status = sel.value; load(); });

  async function load() {
    clear(list);
    list.appendChild(h('p', { class: 'aim-note' }, '載入中…'));
    const payload = {};
    if (q) payload.q = q;
    if (status) payload.status = status;
    const [r, pages] = await Promise.all([ctx.api.call('platform', 'aihKbList', payload), loadPages()]);
    if (!alive) return;
    clear(list);
    if (!r || !r.ok) {
      list.appendChild(h('div', { class: 'card' }, [h('p', null, r && r.error === 'not_inited' ? '小幫手還沒初始化。請系統管理者按上方的「初始化小幫手」。' : errText(r))]));
      return;
    }
    const items = (r.data && Array.isArray(r.data.items)) ? r.data.items : [];
    list.appendChild(h('p', { class: 'aim-note', 'data-role': 'kb-count' }, '共 ' + items.length + ' 題'));
    if (!items.length) list.appendChild(h('div', { class: 'card' }, [h('p', null, q || status ? '沒有符合的題目。' : '知識庫還是空的。可以按上方「匯入初始知識庫」，或按「新增一題」。')]));
    items.forEach((it) => list.appendChild(card(it, pages)));
  }

  function expireTag(it) {
    if (it.status !== 'live') return '';
    const today = taipeiDay();
    if (!it.expires_at || it.expires_at < today) return '　·　⚠ 已過期（不會給 AI 用）';
    if (it.expires_at <= addDays(today, 14)) return '　·　⚠ 快到期';
    return '';
  }

  function card(it, pages) {
    const box = h('div', { class: 'aim-item', 'data-role': 'kb-item', 'data-id': it.id, 'data-status': it.status });
    box.appendChild(h('div', { class: 'aim-q', 'data-role': 'kb-q' }, it.question));
    box.appendChild(h('div', { class: 'aim-a', 'data-role': 'kb-a' }, it.answer));
    box.appendChild(h('div', { class: 'aim-meta' }, [
      (STATUS_ZH[it.status] || it.status) + '　·　' + pageLabel(pages, it.m, it.v) + (it.who ? '　·　找誰：' + it.who : '') +
      '　·　有效到 ' + (it.expires_at || '—') + expireTag(it) + (it.updated_by ? '　·　' + it.updated_by + ' 更新' : '')
    ]));
    const msg = h('p', { class: 'field-hint', 'data-role': 'kb-msg' });
    const act = h('div', { class: 'aim-act' });
    const editBtn = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'edit' }, '編輯'));
    const toggleBtn = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': it.status === 'live' ? 'off' : 'on' }, it.status === 'live' ? '下架' : '上架'));
    const histBtn = h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'hist' }, '歷史');
    act.appendChild(editBtn); act.appendChild(toggleBtn); act.appendChild(histBtn);
    box.appendChild(act); box.appendChild(msg);
    const zone = h('div');
    box.appendChild(zone);
    let editor = null;
    let histOpen = false;

    function save(extra, btn) {
      return async () => {
        const f = editor.get();
        if (!f.question || !f.answer) { msg.textContent = '問題和答案都要填'; return; }
        const done = busyBtn(btn, '儲存中');
        const r = await ctx.api.call('platform', 'aihKbSave', Object.assign({ id: it.id, expected_updated_at: it.updated_at }, f, extra));
        if (!alive) return;
        done(true);
        if (!r || !r.ok) { msg.textContent = '儲存失敗：' + errText(r); return; }
        if (r.dryrun) { ctx.ui.toast('試跑模式：沒有真的儲存', 'info'); return; }
        ctx.ui.toast(r.data && r.data.changed === false ? '沒有任何變更' : '已儲存', 'ok');
        load();
      };
    }

    function openEdit(seed) {
      if (!editor) {
        editor = createEditor({ pages, isEdit: true });
        const saveBtn = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-primary', 'data-act': 'save' }, '儲存'));
        const cancel = h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'cancel' }, '取消');
        saveBtn.addEventListener('click', save({}, saveBtn));
        cancel.addEventListener('click', () => { clear(zoneEdit); editor = null; });
        editor.el.appendChild(h('div', { class: 'aim-act' }, [saveBtn, cancel]));
        zoneEdit.appendChild(editor.el);
      }
      editor.fill(seed);
      editor.focus();
    }
    const zoneEdit = h('div');
    zone.appendChild(zoneEdit);
    const zoneHist = h('div');
    zone.appendChild(zoneHist);

    editBtn.addEventListener('click', () => openEdit(it));
    toggleBtn.addEventListener('click', async () => {
      const done = busyBtn(toggleBtn, '處理中');
      const r = await ctx.api.call('platform', 'aihKbSave', { id: it.id, expected_updated_at: it.updated_at, status: it.status === 'live' ? 'off' : 'live' });
      if (!alive) return;
      if (!r || !r.ok) { done(true); msg.textContent = errText(r); return; }
      if (r.dryrun) { done(true); ctx.ui.toast('試跑模式：沒有真的更新', 'info'); return; }
      load();
    });
    histBtn.addEventListener('click', async () => {
      if (histOpen) { clear(zoneHist); histOpen = false; return; }
      const done = busyBtn(histBtn, '讀取中');
      const r = await ctx.api.call('platform', 'aihKbHist', { kb_id: it.id });
      if (!alive) return;
      done(true);
      if (!r || !r.ok) { msg.textContent = errText(r); return; }
      histOpen = true;
      const rows = (r.data && Array.isArray(r.data.items)) ? r.data.items : [];
      const box2 = h('div', { class: 'aim-hist', 'data-role': 'kb-hist' });
      if (!rows.length) box2.appendChild(h('p', { class: 'aim-note' }, '沒有歷史紀錄。'));
      rows.forEach((x) => {
        const snap = x.snapshot && typeof x.snapshot === 'object' ? x.snapshot : null;
        const row = h('div', { class: 'aim-hist-row', 'data-role': 'kb-hist-row', 'data-hist': x.hist_id }, [
          h('div', { class: 'aim-meta' }, (ACTION_ZH[x.action] || x.action) + '　·　' + (x.by || '') + '　·　' + (x.at || '')),
          snap && snap.question ? h('div', { class: 'aim-a' }, snap.answer || '') : null
        ]);
        if (snap && snap.question) {
          const back = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'restore' }, '回到這個版本'));
          back.addEventListener('click', () => { openEdit(snap); msg.textContent = '已把這個版本帶進編輯框，確認後按「儲存」才會生效。'; });
          row.appendChild(back);
        }
        box2.appendChild(row);
      });
      zoneHist.appendChild(box2);
    });
    return box;
  }

  addBtn.addEventListener('click', async () => {
    if (newHost.firstChild) { clear(newHost); return; }
    const pages = await loadPages();
    if (!alive) return;
    const ed = createEditor({ pages });
    ed.fill({});
    const msg = h('p', { class: 'field-hint' });
    const draftBtn = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'new-draft' }, '存成草稿'));
    const liveBtn = lockIfDryrun(h('button', { type: 'button', class: 'btn btn-primary', 'data-act': 'new-live' }, '直接上架'));
    const cancel = h('button', { type: 'button', class: 'btn btn-secondary' }, '取消');
    const submit = (st, btn) => async () => {
      const f = ed.get();
      if (!f.question || !f.answer) { msg.textContent = '問題和答案都要填'; return; }
      const done = busyBtn(btn, '儲存中');
      const r = await ctx.api.call('platform', 'aihKbSave', Object.assign({}, f, { status: st }));
      if (!alive) return;
      done(true);
      if (!r || !r.ok) { msg.textContent = '儲存失敗：' + errText(r); return; }
      if (r.dryrun) { ctx.ui.toast('試跑模式：沒有真的儲存', 'info'); return; }
      ctx.ui.toast('已新增', 'ok');
      clear(newHost);
      load();
    };
    draftBtn.addEventListener('click', submit('draft', draftBtn));
    liveBtn.addEventListener('click', submit('live', liveBtn));
    cancel.addEventListener('click', () => clear(newHost));
    ed.el.appendChild(h('div', { class: 'aim-act' }, [liveBtn, draftBtn, cancel]));
    ed.el.appendChild(msg);
    newHost.appendChild(h('div', { class: 'card' }, [ed.el]));
    ed.focus();
  });

  load();
  return () => { alive = false; clearTimeout(timer); };
}
