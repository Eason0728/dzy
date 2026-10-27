/**
 * 新增巡檢：選門市與日期 → 四張表逐項評分（缺失可寫原因、拍照）→ 即時算分 → 送出。
 * 做法照舊站 mala-inspection 的填寫畫面；邊填邊存草稿（本機、只認本人），送出才寫進後端。
 */
'use strict';

import { defaultForms, DEFAULT_VER } from '../questions.js';
import { itemKey, computeAll, summaryOf, deficiencies } from '../scoring.js';
import { errText, gradeTag, r1, todayStr, newId, loadDraft, saveDraft, clearDraft, uploadPhoto, hydratePhotos, isDryRun } from '../lib.js';

const MAX_PHOTOS_PER_ITEM = 4;

export function mountFill(el, ctx) {
  const esc = ctx.fmt.esc;
  const user = ctx.user;
  let me = null;
  let draft = null;     // {id, unit, date, answers, tab}
  let uploading = 0;
  let alive = true;

  el.innerHTML = '<p class="ip-note">載入中…</p>';
  (async () => {
    const r = await ctx.api.call('inspection', 'inspMe', {});
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc(errText(r))}</p></div>`; return; }
    me = r.data;
    if (!me.ready) { el.innerHTML = `<div class="card"><p>${esc(errText({ error: 'not_inited' }))}</p></div>`; return; }
    if (!me.can_do) { el.innerHTML = '<div class="card"><p>你沒有巡檢門市的權限。要開通請找人資或系統管理者（權限設定 →「營運巡檢：到店巡檢」）。</p></div>'; return; }
    const d = loadDraft(user);
    if (d && d.unit && Array.isArray(d.forms) && me.do_units.indexOf(d.unit) !== -1) { draft = d; renderResume(); } else renderStart();
  })();

  function unitInfo(u) { return (me.stores || []).find((s) => s.unit === u) || { unit: u, name: u, brand: '', brand_name: '' }; }
  function forms() { return draft.forms; }
  function countItems(fs) { return fs.reduce((s, f) => s + f.categories.reduce((t, c) => t + c.items.length, 0), 0); }
  function persist() { draft.savedAt = Date.now(); saveDraft(user, draft); }

  // ── 開始 ──
  function renderStart() {
    const groups = {};
    me.do_units.map(unitInfo).forEach((s) => { (groups[s.brand_name] = groups[s.brand_name] || []).push(s); });
    const opts = Object.keys(groups).map((b) => `<optgroup label="${esc(b)}">` + groups[b].map((s) => `<option value="${esc(s.unit)}">${esc(s.name)}</option>`).join('') + '</optgroup>').join('');
    el.innerHTML = `<div class="card"><div class="card-title">開始一次巡檢</div>
      ${isDryRun() ? '<p class="ip-note">⚠ 試跑模式：可以照常填寫、拍照，但按送出不會真的存進系統。</p>' : ''}
      <div class="ip-grid2">
        <label>門市<select id="ip-unit" class="input"><option value="">請選擇</option>${opts}</select></label>
        <label>巡檢日期<input id="ip-date" class="input" type="date" value="${todayStr()}"></label>
      </div>
      <p class="ip-note">巡檢人：${esc(me.me.name || '')}（自動帶入登入的人）</p>
      <div class="ip-row"><button class="btn btn-primary" data-act="start">開始巡檢</button></div></div>`;
    el.querySelector('[data-act=start]').onclick = async () => {
      const unit = el.querySelector('#ip-unit').value;
      const date = el.querySelector('#ip-date').value;
      if (!unit) { ctx.ui.toast('請先選門市', 'error'); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { ctx.ui.toast('請選巡檢日期', 'error'); return; }
      const brand = unitInfo(unit).brand;
      const b = await ctx.api.call('inspection', 'inspBankGet', { brand });
      if (!alive) return;
      if (!b || !b.ok) { ctx.ui.toast(errText(b), 'error'); return; }
      const fs = b.data.forms || defaultForms(brand);
      if (!countItems(fs)) {
        ctx.ui.toast(`${unitInfo(unit).brand_name}還沒有巡檢題目，請營運部或品牌總監先到「題目設定」新增`, 'error');
        return;
      }
      // 題目跟著草稿存：填到一半有人改題目也不會對不上
      draft = { id: newId(), unit, date, tab: 'service', forms: fs, bank_ver: b.data.ver || DEFAULT_VER,
        answers: { scores: {}, bonuses: {}, freeBonuses: {}, penalties: {}, reasons: {}, photos: {} } };
      persist();
      renderForm();
    };
  }

  function renderResume() {
    const s = unitInfo(draft.unit);
    el.innerHTML = `<div class="card"><div class="card-title">有一份還沒送出的巡檢</div>
      <p>${esc(s.brand_name)} ${esc(s.name)}　${esc(draft.date)}</p>
      <div class="ip-row"><button class="btn btn-primary" data-act="go">繼續填寫</button><button class="btn" data-act="drop">捨棄，重新開始</button></div></div>`;
    el.querySelector('[data-act=go]').onclick = () => renderForm();
    el.querySelector('[data-act=drop]').onclick = async () => {
      if (!(await ctx.ui.confirm('確定捨棄這份草稿？已填的分數和照片都會清掉。'))) return;
      clearDraft(user); draft = null; renderStart();
    };
  }

  // ── 填寫 ──
  function scoreBar() {
    const r = computeAll(forms(), draft.answers);
    return `<div class="ip-score">
      <div><small>營運巡檢總分</small><b>${r1(r.operationalScore)} ${gradeTag(esc, r.operationalGrade)}</b><small>${r.penaltyTotal ? `含加重扣分 −${r.penaltyTotal}` : '服務、環境、菜色已評的平均'}</small></div>
      <div><small>經營評鑑</small><b>${r1(r.managementScore)} ${gradeTag(esc, r.managementGrade)}</b><small>單獨計分</small></div>
    </div>`;
  }
  function tabsHtml() {
    const defs = deficiencies(forms(), draft.answers);
    return forms().map((f) => {
      const n = defs.filter((d) => d.key.indexOf(f.id + '.') === 0).length;
      return `<button class="ip-tab${draft.tab === f.id ? ' on' : ''}" data-tab="${f.id}">${esc(f.name)}${n ? `<span class="n">${n}</span>` : ''}</button>`;
    }).join('');
  }

  function renderForm() {
    const s = unitInfo(draft.unit);
    const f = forms().find((x) => x.id === draft.tab) || forms()[0];
    draft.tab = f.id;
    el.innerHTML = `<div class="card"><div class="ip-row" style="justify-content:space-between">
        <div><strong>${esc(s.brand_name)} ${esc(s.name)}</strong>　${esc(draft.date)}　巡檢人 ${esc(me.me.name || '')}</div>
        <button class="btn btn-sm" data-act="cancel">捨棄草稿</button></div>
      ${isDryRun() ? '<p class="ip-note">⚠ 試跑模式：送出不會真的存進系統。</p>' : ''}
      <div data-role="score">${scoreBar()}</div></div>
      <div class="ip-tabs" data-role="tabs">${tabsHtml()}</div>
      <div class="card"><div class="card-title">${esc(f.heading || f.name)}</div><div data-role="items">${f.categories.map((c) => catHtml(f, c)).join('')}</div></div>
      <div class="ip-sticky"><span class="ip-note" data-role="saved">草稿已存在這支手機</span>
        <div class="ip-row">${nextTabBtn(f)}<button class="btn btn-primary" data-act="submit">送出巡檢</button></div></div>`;
    hydratePhotos(el);
    bind();
  }
  function nextTabBtn(f) {
    const list = forms();
    const i = list.findIndex((x) => x.id === f.id);
    return i < list.length - 1 ? `<button class="btn" data-tab="${list[i + 1].id}">下一張：${esc(list[i + 1].name)}</button>` : '';
  }

  function catHtml(f, c) {
    const w = c.role === 'scored' && c.weight ? `（權重 ${Math.round(c.weight * 100)}%）` : '';
    return `<div class="ip-cat">${esc(c.name)}${w}</div>` + c.items.map((it) => `<div data-k="${itemKey(f.id, c.id, it.n)}">${itemHtml(f, c, it)}</div>`).join('');
  }

  function itemHtml(f, c, it) {
    const k = itemKey(f.id, c.id, it.n);
    const a = draft.answers;
    const v = a.scores[k];
    let ctl = '', bad = false;
    if (it.type === 'score') {
      ctl = [0, 1, 2, 3, 4, 5].map((n) => `<button class="ip-pt${v === n ? ' on' : ''}${v === n && n < 5 ? ' low' : ''}" data-act="score" data-k="${k}" data-v="${n}">${n}</button>`).join('');
      bad = v != null && v < 5;
    } else if (it.type === 'critical') {
      ctl = `<button class="ip-pt${v === 5 ? ' on' : ''}" data-act="score" data-k="${k}" data-v="5">正常</button><button class="ip-pt${v === 0 ? ' on low' : ''}" data-act="score" data-k="${k}" data-v="0">發生</button>`;
      bad = v === 0;
    } else if (it.type === 'binary') {
      ctl = `<button class="ip-pt${v === 5 ? ' on' : ''}" data-act="score" data-k="${k}" data-v="5">有做到（5）</button><button class="ip-pt${v === 0 ? ' on low' : ''}" data-act="score" data-k="${k}" data-v="0">沒做到（0）</button>`;
      bad = v === 0;
    } else if (it.type === 'bonus') {
      ctl = `<label class="ip-row"><input type="checkbox" data-act="bonus" data-k="${k}"${a.bonuses[k] ? ' checked' : ''}> 達成（＋${it.points}）</label>`;
    } else if (it.type === 'bonus_free') {
      const arr = a.freeBonuses[k] || [];
      const rows = [];
      for (let i = 0; i < it.max; i++) rows.push(`<input type="text" class="input" data-act="free" data-k="${k}" data-i="${i}" value="${esc(arr[i] || '')}" placeholder="第 ${i + 1} 項具體事實（＋${it.points}）">`);
      ctl = `<div class="ip-ev">${rows.join('')}</div>`;
    } else if (it.type === 'penalty') {
      const p = a.penalties[k] || {};
      ctl = `<label class="ip-row"><input type="checkbox" data-act="pen" data-k="${k}"${p.checked ? ' checked' : ''}> 發生（總分 −${it.points}）</label>`;
      bad = !!p.checked;
    }
    const scored = it.type === 'score' || it.type === 'critical' || it.type === 'binary';
    const showEv = bad || (a.reasons[k] || '').length || (a.photos[k] || []).length;
    let ev = '';
    if (showEv && (scored || it.type === 'penalty')) {
      const val = it.type === 'penalty' ? ((a.penalties[k] || {}).note || '') : (a.reasons[k] || '');
      ev = `<div class="ip-ev">${it.type === 'penalty'
        ? `<input type="text" class="input" data-act="pennote" data-k="${k}" value="${esc(val)}" placeholder="說明（品項／日期）">`
        : `<textarea class="input" rows="2" data-act="reason" data-k="${k}" placeholder="扣分原因（給店長看）">${esc(val)}</textarea>`}
        <div class="ip-photos">${(a.photos[k] || []).map((id) => `<div class="ip-thumb"><img data-fid="${esc(id)}" alt="缺失照片"><button class="x" data-act="rmphoto" data-k="${k}" data-id="${esc(id)}" aria-label="刪除照片">✕</button></div>`).join('')}
          ${(a.photos[k] || []).length < MAX_PHOTOS_PER_ITEM ? `<label class="btn btn-sm">📷 加照片<input type="file" accept="image/*" capture="environment" multiple hidden data-act="photo" data-k="${k}"></label>` : ''}</div></div>`;
    }
    return `<div class="ip-item${bad ? ' bad' : ''}"><div class="ip-text">${it.n}. ${esc(it.text)}</div><div class="ip-pts">${ctl}</div>${ev}</div>`;
  }

  function findItem(k) {
    const [fid, cid, n] = k.split('.');
    const f = forms().find((x) => x.id === fid);
    const c = f && f.categories.find((x) => x.id === cid);
    const it = c && c.items.find((x) => String(x.n) === n);
    return it ? { f, c, it } : null;
  }
  function refreshItem(k) {
    const box = el.querySelector(`[data-k="${k}"]`);
    const hit = findItem(k);
    if (!box || !hit) return;
    box.innerHTML = itemHtml(hit.f, hit.c, hit.it);
    hydratePhotos(box);
    el.querySelector('[data-role=score]').innerHTML = scoreBar();
    el.querySelector('[data-role=tabs]').innerHTML = tabsHtml();
  }

  function bind() {
    el.onclick = async (e) => {
      const t = e.target.closest('[data-act],[data-tab]');
      if (!t || !el.contains(t)) return;
      if (t.dataset.tab) { draft.tab = t.dataset.tab; persist(); renderForm(); window.scrollTo && window.scrollTo(0, 0); return; }
      const k = t.dataset.k;
      const a = draft.answers;
      switch (t.dataset.act) {
        case 'score': {
          const v = Number(t.dataset.v);
          if (a.scores[k] === v) delete a.scores[k]; else a.scores[k] = v;   // 再按一次＝取消
          persist(); refreshItem(k); break;
        }
        case 'rmphoto': a.photos[k] = (a.photos[k] || []).filter((x) => x !== t.dataset.id); persist(); refreshItem(k); break;
        case 'cancel':
          if (!(await ctx.ui.confirm('確定捨棄這份草稿？已填的分數和照片都會清掉。'))) return;
          clearDraft(user); draft = null; renderStart(); break;
        case 'submit': submit(); break;
        default: break;
      }
    };
    el.onchange = async (e) => {
      const t = e.target;
      const k = t.dataset && t.dataset.k;
      if (!k) return;
      const a = draft.answers;
      if (t.dataset.act === 'bonus') { if (t.checked) a.bonuses[k] = true; else delete a.bonuses[k]; persist(); refreshItem(k); }
      else if (t.dataset.act === 'pen') { const p = a.penalties[k] || { note: '' }; p.checked = t.checked; a.penalties[k] = p; persist(); refreshItem(k); }
      else if (t.dataset.act === 'photo') addPhotos(k, Array.from(t.files || []));
    };
    el.oninput = (e) => {
      const t = e.target;
      const k = t.dataset && t.dataset.k;
      if (!k) return;
      const a = draft.answers;
      if (t.dataset.act === 'reason') a.reasons[k] = t.value;
      else if (t.dataset.act === 'pennote') { const p = a.penalties[k] || { checked: false }; p.note = t.value; a.penalties[k] = p; }
      else if (t.dataset.act === 'free') { const arr = (a.freeBonuses[k] || []).slice(); arr[Number(t.dataset.i)] = t.value; a.freeBonuses[k] = arr; el.querySelector('[data-role=score]').innerHTML = scoreBar(); }
      else return;
      persist();
    };
  }

  async function addPhotos(k, files) {
    if (!me.can_photo) { ctx.ui.toast('系統管理者帳號不能附照片，請用個人帳號巡檢', 'error'); return; }
    const room = MAX_PHOTOS_PER_ITEM - (draft.answers.photos[k] || []).length;
    files = files.slice(0, Math.max(0, room));
    for (const file of files) {
      uploading++;
      const box = el.querySelector(`[data-k="${k}"] .ip-photos`);
      const ph = document.createElement('div');
      ph.className = 'ip-thumb busy'; ph.textContent = '上傳中…';
      if (box) box.insertBefore(ph, box.lastElementChild);
      const r = await uploadPhoto(file);
      uploading--;
      if (!alive || !draft) return;
      if (!r.ok) { ph.remove(); ctx.ui.toast(r.error, 'error'); continue; }
      draft.answers.photos[k] = (draft.answers.photos[k] || []).concat([r.id]);
      persist();
      refreshItem(k);
    }
  }

  async function submit() {
    if (uploading > 0) { ctx.ui.toast('照片還在上傳，等一下再送出', 'error'); return; }
    const fs = forms();
    const sum = summaryOf(fs, draft.answers);
    if (sum.operationalScore === null && sum.managementScore === null) { ctx.ui.toast('還沒有評任何一題', 'error'); return; }
    const unAns = [];
    fs.forEach((f) => f.categories.filter((c) => c.role === 'scored').forEach((c) => c.items.forEach((it) => {
      if (draft.answers.scores[itemKey(f.id, c.id, it.n)] == null) unAns.push(f.name);
    })));
    const s = unitInfo(draft.unit);
    const msg = `送出 ${s.brand_name} ${s.name} ${draft.date} 的巡檢？\n營運 ${r1(sum.operationalScore)}（${sum.operationalGrade}）、經營評鑑 ${r1(sum.managementScore)}（${sum.managementGrade}）、缺失 ${sum.defects} 項。` +
      (unAns.length ? `\n還有 ${unAns.length} 題沒評（沒評的題不計分）。` : '') + '\n送出後不能修改。';
    if (!(await ctx.ui.confirm(msg))) return;
    const files = [];
    Object.keys(draft.answers.photos).forEach((k) => (draft.answers.photos[k] || []).forEach((id) => { if (files.indexOf(id) === -1) files.push(id); }));
    ctx.ui.loading(true);
    let r;
    try {
      r = await ctx.api.call('inspection', 'inspSubmit', { id: draft.id, unit: draft.unit, date: draft.date, bank_ver: draft.bank_ver, forms: draft.forms, answers: draft.answers, summary: sum, files });
    } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (r && r.ok && r.dryrun) { ctx.ui.toast('試跑模式：巡檢沒有真的送出，草稿還在', 'info'); return; }
    if (r && r.ok) {
      const id = draft.id;
      clearDraft(user); draft = null;
      ctx.ui.toast('巡檢已送出', 'success');
      ctx.nav('list', { id });
      return;
    }
    ctx.ui.toast(errText(r), 'error');
  }

  return () => { alive = false; el.onclick = null; el.onchange = null; el.oninput = null; };
}
