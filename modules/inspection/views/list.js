/**
 * 巡檢紀錄：清單（篩門市、月份）→ 點一筆看報告（分數、各表分數、缺失清單與照片、加分項）。
 * 看得到哪些店一律後端判：店長、區經理只看自己店；品牌總監、區督導看自己品牌；營運部看全部。
 * 網址 #/inspection/list?id=<巡檢編號> 直接開報告。
 */
'use strict';

import { defaultForms } from '../questions.js';
import { deficiencies, computeAll } from '../scoring.js';
import { errText, gradeTag, r1, hydratePhotos } from '../lib.js';

export function mountList(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let me = null;
  const st = { unit: '', month: '' };

  el.innerHTML = '<p class="ip-note">載入中…</p>';
  (async () => {
    const r = await ctx.api.call('inspection', 'inspMe', {});
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc(errText(r))}</p></div>`; return; }
    me = r.data;
    if (!me.ready) { renderNotReady(); return; }
    if (ctx.params && ctx.params.id) renderDetail(ctx.params.id); else renderList();
  })();

  function renderNotReady() {
    el.innerHTML = `<div class="card"><p>${esc(errText({ error: 'not_inited' }))}</p>
      ${me.is_admin ? '<button class="btn btn-primary" data-act="setup">初始化營運巡檢</button><p class="ip-note">會建立巡檢資料表，並在權限設定補上預設規則（營運部、品牌總監、區督導、區經理、店長）。</p>' : ''}</div>`;
    const b = el.querySelector('[data-act=setup]');
    if (b) b.onclick = async () => {
      ctx.ui.loading(true);
      let r;
      try { r = await ctx.api.call('inspection', 'inspSetup', {}); } finally { ctx.ui.loading(false); }
      if (r && r.ok && !r.dryrun) { ctx.ui.toast('營運巡檢已初始化', 'success'); me.ready = true; renderList(); } else if (r && r.dryrun) ctx.ui.toast('試跑模式：沒有真的初始化', 'info'); else ctx.ui.toast(errText(r), 'error');
    };
  }

  function unitOpts() {
    const groups = {};
    (me.stores || []).forEach((s) => { (groups[s.brand_name] = groups[s.brand_name] || []).push(s); });
    return '<option value="">全部門市</option>' + Object.keys(groups).map((b) => `<optgroup label="${esc(b)}">` +
      groups[b].map((s) => `<option value="${esc(s.unit)}"${st.unit === s.unit ? ' selected' : ''}>${esc(s.name)}</option>`).join('') + '</optgroup>').join('');
  }

  async function renderList() {
    if (!(me.stores || []).length) { el.innerHTML = '<div class="card"><p>你目前沒有可以查看的門市巡檢。</p></div>'; return; }
    el.innerHTML = `<div class="card"><div class="ip-row">
        <label>門市 <select class="input" data-role="unit">${unitOpts()}</select></label>
        <label>月份 <input class="input" type="month" data-role="month" value="${esc(st.month)}"></label>
        ${me.can_do ? '<button class="btn btn-primary" data-act="new">＋ 新增巡檢</button>' : ''}
      </div></div><div data-role="body"><p class="ip-note">載入中…</p></div>`;
    el.querySelector('[data-role=unit]').onchange = (e) => { st.unit = e.target.value; loadRows(); };
    el.querySelector('[data-role=month]').onchange = (e) => { st.month = e.target.value; loadRows(); };
    const nb = el.querySelector('[data-act=new]');
    if (nb) nb.onclick = () => ctx.nav('fill', {});
    loadRows();
  }

  async function loadRows() {
    const body = el.querySelector('[data-role=body]');
    body.innerHTML = '<p class="ip-note">載入中…</p>';
    const r = await ctx.api.call('inspection', 'inspList', { unit: st.unit, month: st.month });
    if (!alive) return;
    if (!r || !r.ok) { body.innerHTML = `<div class="card"><p>${esc(errText(r))}</p></div>`; return; }
    const items = r.data.items || [];
    if (!items.length) { body.innerHTML = '<div class="card"><p>還沒有巡檢紀錄。</p></div>'; return; }
    body.innerHTML = `<div class="card"><div class="table-wrap"><table class="table ip-table"><thead><tr>
      <th>巡檢日期</th><th>門市</th><th>巡檢人</th><th class="num">營運總分</th><th class="num">經營評鑑</th><th class="num">缺失</th><th class="num">照片</th><th></th></tr></thead><tbody>` +
      items.map((x) => `<tr data-id="${esc(x.id)}">
        <td>${esc(x.date)}</td><td>${esc(x.brand_name)} ${esc(x.unit_name)}</td><td>${esc(x.inspector_name)}</td>
        <td class="num">${r1(x.summary.operationalScore)} ${gradeTag(esc, x.summary.operationalGrade)}</td>
        <td class="num">${r1(x.summary.managementScore)} ${gradeTag(esc, x.summary.managementGrade)}</td>
        <td class="num">${x.summary.defects}</td><td class="num">${x.photo_count}</td>
        <td><button class="btn btn-sm" data-open="${esc(x.id)}">看報告</button></td></tr>`).join('') +
      `</tbody></table></div>${r.data.more ? '<p class="ip-note">只列最近 300 筆，請用月份篩選。</p>' : ''}</div>`;
    body.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => ctx.nav('list', { id: b.dataset.open }); });
  }

  async function renderDetail(id) {
    el.innerHTML = '<p class="ip-note">載入中…</p>';
    const r = await ctx.api.call('inspection', 'inspGet', { id });
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc(errText(r))}</p><button class="btn" data-act="back">回清單</button></div>`; el.querySelector('[data-act=back]').onclick = () => ctx.nav('list', {}); return; }
    const x = r.data;
    const forms = Array.isArray(x.forms) ? x.forms : defaultForms(x.brand);   // 送出當下的題目快照
    const ans = x.answers || {};
    const sum = x.summary;
    const calc = computeAll(forms, ans);
    const defs = deficiencies(forms, ans);
    const photo = (ids) => (ids || []).length ? `<div class="ip-bigphotos">${ids.map((fid) => `<img data-fid="${esc(fid)}" alt="缺失照片">`).join('')}</div>` : '';
    const formRows = forms.map((f) => {
      const fr = calc.byForm[f.id];
      const stored = (sum.forms || []).find((s) => s.id === f.id);
      const score = stored ? stored.score : fr.scoreRounded;
      // 加分文字要跟分數欄同一套：新報告用存檔摘要的 bonus（封頂後）；封頂前送出的舊報告沒存 bonus → 用現算 raw（當時沒封頂，分數就是含 raw）（2026-10-30 對抗驗證）
      const bonusShown = stored && typeof stored.bonus === 'number' ? stored.bonus : (stored ? fr.bonus.raw : fr.bonus.total);
      const cats = fr.categories.map((c) => `${esc(c.name)} ${c.ratio === null ? '未評' : Math.round(c.ratio * 100) + '%'}`).join('、');
      return `<tr><td>${esc(f.name)}</td><td class="num">${r1(score)}</td><td class="ip-note">${cats || '—'}${bonusShown ? `；加分 ＋${bonusShown}` : ''}${fr.penalty.total ? `；加重扣分 −${fr.penalty.total}` : ''}</td></tr>`;
    }).join('');
    const bonuses = [];
    forms.forEach((f) => { calc.byForm[f.id].bonus.detail.forEach((b) => bonuses.push(`<li>${esc(f.name)}：${esc(b.text)}（＋${b.points}）</li>`)); });
    el.innerHTML = `<div class="ip-row"><button class="btn" data-act="back">← 回清單</button>${me.can_void && x.state !== 'void' ? '<button class="btn btn-danger" data-act="void">作廢這筆</button>' : ''}</div>
      <div class="card"><div class="card-title">${esc(x.brand_name)} ${esc(x.unit_name)}　營運巡檢報告</div>
        <p>巡檢日期 ${esc(x.date)}　巡檢人 ${esc(x.inspector_name)}　送出 ${esc(ctx.fmt.datetime(x.submitted_at))}${x.state === 'void' ? '　<strong style="color:var(--danger)">已作廢</strong>' : ''}</p>
        <div class="ip-score">
          <div><small>營運巡檢總分</small><b>${r1(sum.operationalScore)} ${gradeTag(esc, sum.operationalGrade)}</b><small>${sum.penaltyTotal ? `含加重扣分 −${sum.penaltyTotal}` : '服務、環境、菜色平均'}</small></div>
          <div><small>經營評鑑</small><b>${r1(sum.managementScore)} ${gradeTag(esc, sum.managementGrade)}</b><small>單獨計分</small></div>
          <div><small>缺失</small><b>${defs.length} 項</b><small>照片 ${x.photo_count} 張</small></div>
        </div>
        <p class="ip-note">等級：A ≥ 90、B ≥ 80、C ≥ 70、D ≥ 60、E ≥ 50</p></div>
      <div class="card"><div class="card-title">各表分數</div><div class="table-wrap"><table class="table ip-table"><tbody>${formRows}</tbody></table></div></div>
      <div class="card"><div class="card-title">缺失清單（請店長改善）</div>${defs.length ? defs.map((d) => `<div class="ip-def">
          <div><strong>${esc(d.form)}・${esc(d.cat)} ${d.n}.</strong> ${esc(d.text)}</div>
          <small>${d.points ? `加重扣分 −${d.points}` : `得分 ${d.score} / 5`}</small>
          ${d.reason ? `<div>原因：${esc(d.reason)}</div>` : ''}${photo(d.photos)}</div>`).join('') : '<p>這次沒有缺失。</p>'}</div>
      ${bonuses.length ? `<div class="card"><div class="card-title">加分項目</div><ul>${bonuses.join('')}</ul></div>` : ''}`;
    hydratePhotos(el);
    el.querySelector('[data-act=back]').onclick = () => ctx.nav('list', {});
    const vb = el.querySelector('[data-act=void]');
    if (vb) vb.onclick = async () => {
      if (!(await ctx.ui.confirm('確定作廢這筆巡檢？作廢後店長看不到，清單也不再列出。'))) return;
      const v = await ctx.api.call('inspection', 'inspVoid', { id: x.id });
      if (v && v.ok && v.dryrun) { ctx.ui.toast('試跑模式：沒有真的作廢', 'info'); return; }
      if (v && v.ok) { ctx.ui.toast('已作廢', 'success'); ctx.nav('list', {}); } else ctx.ui.toast(errText(v), 'error');
    };
  }

  return () => { alive = false; };
}

