/**
 * 單位結果（店長以上）：選單位＋季度 → 總覽、誰還沒填、給公司的話 → 點人看明細、打 KPI、加減分、寫回饋。
 * 人資總監（platform.eval-admin）另有定稿／解除定稿。列印 PDF 用瀏覽器列印，檔名「<店名>＿績效評核＿<年>年第<季>季」。
 * 能看哪些單位、能替誰打分，全部由後端 evUnitResults／evPersonDetail 回的 canManage 決定。
 */
'use strict';

import { qLabel, r1, btnWaiting, errText } from '../lib.js';
import { evKpiTotal, evKpiItemScore } from '../../eval-shared/calc.js';

const BRAND_NAME = { mzt: '墨竹亭燃麵本家', mala: '麻的小辛辣', yiwu: '一悟燒肉', ck: '中央工廠' };

function quarterList(cur, n) {
  const m = /^(\d{4})-Q([1-4])$/.exec(cur);
  if (!m) return [cur];
  let y = Number(m[1]); let q = Number(m[2]);
  const out = [];
  for (let i = 0; i < n; i++) { out.push(`${y}-Q${q}`); q--; if (q === 0) { q = 4; y--; } }
  return out;
}

export function mountResults(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  const state = { unit: ctx.params.unit || '', quarter: ctx.params.q || '', emp: '' };
  el.innerHTML = '<p class="ev-note">載入中…</p>';

  async function load() {
    const r = await ctx.api.call('eval', 'evUnitResults', { unit: state.unit, quarter: state.quarter });
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc(errText(r))}</p></div>`; return; }
    const d = r.data;
    state.unit = d.unit; state.quarter = d.quarter;
    const quarters = quarterList(d.quarter > (state.maxQ || '') ? d.quarter : state.maxQ, 8);
    state.maxQ = quarters[0];
    const notPeer = d.rows.filter((x) => !x.peerDone).map((x) => x.name);
    const notSelf = d.rows.filter((x) => !x.selfDone).map((x) => x.name);
    const isFt = (x) => x.kind === 'ft';
    el.innerHTML = `
      <div class="ev-print-head">${esc(BRAND_NAME[d.brand] || '')}　${esc(d.unitName)}　績效評核　${esc(qLabel(d.quarter))}</div>
      <div class="card ev-noprint"><div class="ev-grid2">
        <div class="field"><label class="field-label" for="ev-unit">單位</label><select class="input" id="ev-unit">${d.units.map((u) => `<option value="${esc(u.unit)}" ${u.unit === d.unit ? 'selected' : ''}>${esc(BRAND_NAME[u.brand] || u.brand)}　${esc(u.name)}</option>`).join('')}</select></div>
        <div class="field"><label class="field-label" for="ev-quarter">季度</label><select class="input" id="ev-quarter">${quarters.map((q) => `<option value="${q}" ${q === d.quarter ? 'selected' : ''}>${esc(qLabel(q))}</option>`).join('')}</select></div>
      </div>
      <div class="ev-row-act">
        ${d.finalized ? '<span class="tag tag-ok">已定稿</span>' : '<span class="tag">未定稿</span>'}
        <button type="button" class="btn btn-secondary" data-role="print">列印 PDF</button>
        ${d.canFinalize ? `<button type="button" class="btn ${d.finalized ? 'btn-secondary' : 'btn-primary'}" data-role="finalize">${d.finalized ? '重新定稿' : '定稿本季'}</button>${d.finalized ? '<button type="button" class="btn btn-secondary" data-role="unfinalize">解除定稿</button>' : ''}` : ''}
      </div>
      <p class="field-hint">${d.canFinalize ? '定稿＝把這一季每個人的分數鎖住，之後改題目、改範本都不會變動；正職 KPI 還沒評完的人不會被鎖。' : ''}</p></div>
      ${d.windowOpen ? `<div class="card ev-noprint"><div class="card-title">本季填寫進度</div>
        <p>互評還沒送：${notPeer.length ? esc(notPeer.join('、')) : '全部送出 ✓'}</p><p>自評還沒送：${notSelf.length ? esc(notSelf.join('、')) : '全部送出 ✓'}</p></div>` : ''}
      <div class="card"><div class="card-title">${esc(d.unitName)}　${esc(qLabel(d.quarter))}　總覽</div>
        <div class="table-wrap"><table class="table ev-table"><thead><tr><th>姓名</th><th>職稱</th><th class="num">態度</th><th class="num">表現</th><th class="num">調整</th><th class="num">實際分數</th><th>等第／時薪</th><th class="num">評分人數</th></tr></thead><tbody>
        ${d.rows.map((x) => {
          const res = x.result;
          if (x.isMe) return `<tr><td>${esc(x.name)}（你）</td><td>${esc(x.titleName)}</td><td colspan="6" class="ev-note">自己的分數請看「我的成績」</td></tr>`;
          if (!res) return `<tr><td>${esc(x.name)}</td><td>${esc(x.titleName)}</td><td colspan="6" class="ev-note">這一季沒有資料</td></tr>`;
          const adj = (Number(res.adjAtt) || 0) + (Number(res.adjPerf) || 0);
          const tier = isFt(x) ? (res.performance === null ? 'KPI 未評' : (res.grade || '—')) : (d.wageTiers[wageIdxOf(res)] ? d.wageTiers[wageIdxOf(res)][1] : '—');
          return `<tr data-role="ev-row" data-emp="${esc(x.emp)}"><td><a href="#" data-role="open" data-emp="${esc(x.emp)}">${esc(x.name)}</a></td><td>${esc(x.titleName)}</td>
            <td class="num">${r1(res.attitude)}</td><td class="num">${res.performance === null ? '未計' : r1(res.performance)}</td>
            <td class="num">${adj ? (adj > 0 ? '+' : '') + r1(adj) : '—'}</td><td class="num"><strong>${r1(res.total)}</strong></td><td>${esc(String(tier))}</td>
            <td class="num">${res.source === 'hist' ? '舊系統' : res.attCount}${res.source === 'final' ? '（定稿）' : ''}</td></tr>`;
        }).join('')}
        </tbody></table></div></div>
      ${d.company.length ? `<div class="card"><div class="card-title">給公司的話（匿名）</div>${d.company.map((t) => `<div class="ev-msg">${esc(t)}</div>`).join('')}</div>` : ''}
      <div data-role="person"></div>`;
    function wageIdxOf(res) { return typeof res.wageIdx === 'number' ? res.wageIdx : -1; }

    el.querySelector('#ev-unit').addEventListener('change', (e) => { state.unit = e.target.value; state.emp = ''; load(); });
    el.querySelector('#ev-quarter').addEventListener('change', (e) => { state.quarter = e.target.value; state.emp = ''; load(); });
    el.querySelector('[data-role="print"]').addEventListener('click', () => {
      const t = document.title;
      const m = /^(\d{4})-Q([1-4])$/.exec(d.quarter);
      document.title = `${d.unitName}＿績效評核＿${m ? `${m[1]}年第${m[2]}季` : d.quarter}`;
      window.print();
      setTimeout(() => { document.title = t; }, 500);
    });
    const fin = el.querySelector('[data-role="finalize"]');
    if (fin) fin.addEventListener('click', async () => {
      if (!(await ctx.ui.confirm(`把 ${d.unitName} ${qLabel(d.quarter)} 的分數定稿？`))) return;
      const stop = btnWaiting(fin, '定稿中');
      const res = await ctx.api.call('eval', 'evFinalize', { unit: d.unit, quarter: d.quarter });
      stop(true);
      if (!res || !res.ok) { ctx.ui.toast(errText(res), 'danger'); return; }
      ctx.ui.toast(`已定稿 ${res.data.count} 人${res.data.skipped.length ? `；KPI 還沒評完、沒鎖：${res.data.skipped.join('、')}` : ''}`, 'ok');
      load();
    });
    const unf = el.querySelector('[data-role="unfinalize"]');
    if (unf) unf.addEventListener('click', async () => {
      if (!(await ctx.ui.confirm('解除定稿後，分數會回到即時計算（改題目、改範本會影響這一季）。確定解除？'))) return;
      const stop = btnWaiting(unf, '解除中');
      const res = await ctx.api.call('eval', 'evUnfinalize', { unit: d.unit, quarter: d.quarter });
      stop(true);
      if (!res || !res.ok) { ctx.ui.toast(errText(res), 'danger'); return; }
      load();
    });
    el.querySelectorAll('[data-role="open"]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); state.emp = a.dataset.emp; person(); }));
    if (state.emp) await person();
  }

  async function person() {
    const box = el.querySelector('[data-role="person"]');
    box.innerHTML = '<p class="ev-note">載入中…</p>';
    const r = await ctx.api.call('eval', 'evPersonDetail', { emp: state.emp, quarter: state.quarter });
    if (!alive) return;
    if (!r || !r.ok) { box.innerHTML = `<div class="card"><p>${esc(errText(r))}</p></div>`; return; }
    const p = r.data;
    const res = p.result;
    const editable = p.canManage && !p.finalized;
    const lock = p.finalized ? '<p class="field-hint">這一季已定稿，要修改請人資先解除定稿。</p>' : (p.canManage ? '' : '<p class="field-hint">你可以查看，但不能替這位同仁打分。</p>');
    const itemRows = (labels, vals) => (labels || []).map((lb, i) => `<tr><td>${esc(lb)}</td><td class="num">${vals ? r1(vals[i]) : '—'}</td></tr>`).join('');
    let html = `<div class="card" data-role="ev-detail"><div class="card-title">${esc(p.name)}　${esc(qLabel(p.quarter))}　明細</div>${lock}`;
    if (res) {
      html += `<div class="table-wrap"><table class="table ev-table"><tbody>
        <tr class="sub"><td>職能態度（${res.attCount || 0} 人評，含自評）</td><td class="num">${r1(res.attitude)}</td></tr>${itemRows(res.attLabels, res.attItems)}
        ${p.kind === 'pt' ? `<tr class="sub"><td>職能表現</td><td class="num">${r1(res.performance)}</td></tr>${itemRows(res.perfLabels, res.perfItems)}` : `<tr class="sub"><td>職能表現（主管 KPI）</td><td class="num">${res.performance === null ? '未計' : r1(res.performance)}</td></tr>`}
        <tr class="grand"><td>實際分數${res.grade && p.kind === 'ft' ? `（${esc(res.grade)} 等）` : ''}</td><td class="num">${r1(res.total)}</td></tr></tbody></table></div>`;
    } else {
      html += '<p class="ev-note">這一季還沒有人評這位同仁。</p>';
    }
    if (p.newbie) html += `<p class="ev-note">入職考核（${esc(p.newbie.at)}）：${r1(p.newbie.total)} 分，不列入季分數。</p>`;
    html += '</div>';

    // KPI（正職）
    if (p.kind === 'ft') {
      html += `<div class="card"><div class="card-title">正職職能表現（KPI）</div>
        <div class="field"><label class="field-label" for="ev-tpl">範本</label><select class="input" id="ev-tpl" ${editable ? '' : 'disabled'}>${(p.tplTitles || []).map((t) => `<option value="${esc(t)}" ${t === p.tpl.title ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
        ${p.tpl.items.length ? `<div class="table-wrap"><table class="table ev-table"><thead><tr><th>項目</th><th>評等</th><th>實際值</th><th class="num">得分</th></tr></thead><tbody>
          ${p.tpl.items.map((it) => {
            const v = p.sup.kpi[it.key] || {};
            const opts = it.type === '執行力' ? ['', '完成', '未完成'] : ['', 'A', 'B', 'C', 'D'];
            const std = it.type === '技能' ? [it.a, it.b, it.c, it.d].map((s, i) => s ? `${'ABCD'[i]}：${esc(s)}` : '').filter(Boolean).join('　') : '';
            return `<tr data-role="kpi-row" data-key="${esc(it.key)}"><td>${esc(it.label)}（${it.weight} 分）${it.target ? `<div class="ev-note">🎯 ${esc(it.target)}</div>` : ''}${std ? `<div class="ev-note">${std}</div>` : ''}</td>
              <td><select class="input" data-f="sel" aria-label="${esc(it.label)} 評等" ${editable ? '' : 'disabled'}>${opts.map((o) => `<option value="${o}" ${o === (v.sel || '') ? 'selected' : ''}>${o || '未評'}</option>`).join('')}</select></td>
              <td><input class="input" data-f="actual" aria-label="${esc(it.label)} 實際值" value="${esc(v.actual || '')}" maxlength="200" ${editable ? '' : 'disabled'}></td>
              <td class="num" data-f="score">—</td></tr>`;
          }).join('')}
          <tr class="grand"><td colspan="3">合計（滿分 70）</td><td class="num" data-role="kpi-total">—</td></tr></tbody></table></div>` : '<p class="ev-note">這個範本還沒有項目，請人資到「設定」建立。</p>'}
        ${editable ? '<div class="btn-row"><button type="button" class="btn btn-primary" data-role="save-kpi">儲存 KPI 評分</button></div><p class="field-hint" data-role="kpi-msg"></p>' : ''}</div>`;
    }
    html += `<div class="card"><div class="card-title">主管加減分與回饋</div>
      <div class="ev-grid2">
        <div class="field"><label class="field-label" for="ev-adj-att">態度加減分</label><input class="input" id="ev-adj-att" type="number" step="0.5" value="${p.sup.adjAtt}" ${editable ? '' : 'disabled'}></div>
        <div class="field"><label class="field-label" for="ev-adj-perf">表現加減分</label><input class="input" id="ev-adj-perf" type="number" step="0.5" value="${p.sup.adjPerf}" ${editable ? '' : 'disabled'}></div>
      </div>
      <div class="field"><label class="field-label" for="ev-adj-reason">加減分原因（同仁看不到）</label><input class="input" id="ev-adj-reason" maxlength="500" value="${esc(p.sup.adjReason)}" ${editable ? '' : 'disabled'}></div>
      <div class="field"><label class="field-label" for="ev-feedback">給同仁的回饋（會出現在他的「我的成績」）</label><textarea class="input" id="ev-feedback" rows="3" maxlength="2000" ${editable ? '' : 'disabled'}>${esc(p.sup.feedback)}</textarea></div>
      ${editable ? '<div class="btn-row"><button type="button" class="btn btn-primary" data-role="save-sup">儲存加減分與回饋</button></div><p class="field-hint" data-role="sup-msg"></p>' : ''}</div>`;
    box.innerHTML = html;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const kpiRows = Array.from(box.querySelectorAll('[data-role="kpi-row"]'));
    const collectKpi = () => {
      const o = {};
      kpiRows.forEach((tr) => { o[tr.dataset.key] = { sel: tr.querySelector('[data-f="sel"]').value, actual: tr.querySelector('[data-f="actual"]').value }; });
      return o;
    };
    const paintKpi = () => {
      if (!p.tpl || !p.tpl.items.length) return;
      const sel = collectKpi();
      kpiRows.forEach((tr) => {
        const it = p.tpl.items.find((x) => x.key === tr.dataset.key);
        const s = evKpiItemScore(it, sel[it.key].sel);
        tr.querySelector('[data-f="score"]').textContent = s === null ? '—' : r1(s);
      });
      const t = evKpiTotal(p.tpl.items, sel);
      const tot = box.querySelector('[data-role="kpi-total"]');
      if (tot) tot.textContent = t === null ? '未評完' : r1(t);
    };
    kpiRows.forEach((tr) => tr.querySelector('[data-f="sel"]').addEventListener('change', paintKpi));
    paintKpi();

    const tplSel = box.querySelector('#ev-tpl');
    if (tplSel && editable) tplSel.addEventListener('change', async () => {
      const res2 = await ctx.api.call('eval', 'evSupSave', { emp: p.emp, quarter: p.quarter, tpl_title: tplSel.value });
      if (!res2 || !res2.ok) { ctx.ui.toast(errText(res2), 'danger'); return; }
      person();
    });
    async function save(btn, msgEl, payload) {
      const stop = btnWaiting(btn, '儲存中');
      const res2 = await ctx.api.call('eval', 'evSupSave', Object.assign({ emp: p.emp, quarter: p.quarter }, payload));
      stop(true);
      if (!alive) return;
      if (!res2 || !res2.ok) { msgEl.textContent = '儲存失敗：' + errText(res2); return; }
      try { await load(); } catch (e) { /* 畫面更新失敗不影響已存 */ }
      const m = el.querySelector(`[data-role="${msgEl.dataset.role}"]`);
      if (m) m.textContent = '✅ 已儲存';
    }
    const sk = box.querySelector('[data-role="save-kpi"]');
    if (sk) sk.addEventListener('click', () => save(sk, box.querySelector('[data-role="kpi-msg"]'), { kpi: collectKpi() }));
    const ss = box.querySelector('[data-role="save-sup"]');
    if (ss) ss.addEventListener('click', () => save(ss, box.querySelector('[data-role="sup-msg"]'), {
      adj_att: Number(box.querySelector('#ev-adj-att').value || 0), adj_perf: Number(box.querySelector('#ev-adj-perf').value || 0),
      adj_reason: box.querySelector('#ev-adj-reason').value, feedback: box.querySelector('#ev-feedback').value
    }));
  }

  load();
  return () => { alive = false; };
}
