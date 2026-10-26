/**
 * 我的成績：三張留言卡 → 各季小計 → 查詢季度 → 該季細項（含主管加減分、實際分數、等第或時薪落點）。
 * 規則同舊站：本季在每季第一個月 10 號前不公布（後端擋）；實際分數上限 100；正職看等第、計時看時薪。
 * 後端只回彙總，看不到任何人給幾分。
 */
'use strict';

import { qLabel, r1, errText } from '../lib.js';
import { evWageTierIndex as wageIdx } from '../../eval-shared/calc.js';

export function mountMine(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  el.innerHTML = '<p class="ev-note">載入中…</p>';

  (async () => {
    const r = await ctx.api.call('eval', 'evMyScores', {});
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc(errText(r))}</p></div>`; return; }
    const d = r.data;
    const qs = d.quarters || [];
    const latestQ = qs.length ? qs[qs.length - 1].quarter : '';
    const isFt = d.kind === 'ft';

    // ── 留言卡：最新一季展開、舊季收合 ──
    function msgCard(title, list, emptyText) {
      if (!list.length) return `<div class="card"><div class="card-title">${title}</div><p class="ev-note">${emptyText}</p></div>`;
      const byQ = {};
      list.forEach((m) => { (byQ[m.quarter] = byQ[m.quarter] || []).push(m); });
      const keys = Object.keys(byQ).sort().reverse();
      return `<div class="card"><div class="card-title">${title}</div>` + keys.map((q, i) => {
        const body = byQ[q].map((m) => `<div class="ev-msg">${esc(m.text)}${m.kind === 'peer' ? `<small>— ${m.from ? esc(m.from) : '匿名夥伴'}</small>` : ''}</div>`).join('');
        return i === 0 ? `<div><strong>📅 ${esc(qLabel(q))}</strong>${body}</div>` : `<details><summary>📅 ${esc(qLabel(q))}（${byQ[q].length} 則）</summary>${body}</details>`;
      }).join('') + '</div>';
    }
    const peerMsgs = (d.messages || []).filter((m) => m.kind === 'peer');
    const selfMsgs = (d.messages || []).filter((m) => m.kind === 'self');
    const fb = (d.feedback || []).map((f) => ({ quarter: f.quarter, text: f.text, kind: 'fb' }));

    let html = msgCard('💬 夥伴對你說的話', peerMsgs, '還沒有夥伴留言給你') +
      msgCard('✍️ 你寫給自己的話', selfMsgs, '你還沒寫過給自己的話') +
      msgCard('🧭 主管給你的回饋', fb, '還沒有主管回饋');

    if (d.newbie) {
      html += `<div class="card"><div class="card-title">🌱 入職考核（${esc(d.newbie.at)}）</div>
        <p>態度 ${r1(d.newbie.attitude)}／30　表現 ${r1(d.newbie.performance)}／70　<strong>合計 ${r1(d.newbie.total)} 分</strong></p>
        <p class="ev-note">到職滿一個月由店長考核一次，不併入每季分數。</p>${pt() ? wageTable(d.newbie.total) : ''}</div>`;
    }

    if (!qs.length) {
      html += '<div class="card"><p>目前還沒有可以查詢的季度成績。每季第一個月 10 號以後會公布上一季的成績。</p></div>';
      el.innerHTML = html;
      return;
    }

    // ── 各季小計 ──
    html += `<div class="card"><div class="card-title">各季小計</div><div class="table-wrap"><table class="table ev-table">
      <thead><tr><th>季度</th><th class="num">態度</th><th class="num">表現</th><th class="num">主管調整</th><th class="num">實際分數</th>${isFt ? '<th>等第</th>' : ''}</tr></thead><tbody>` +
      qs.slice().reverse().map((q) => {
        const adj = (Number(q.adjAtt) || 0) + (Number(q.adjPerf) || 0);
        const hasAdj = Number(q.adjAtt) !== 0 || Number(q.adjPerf) !== 0;
        return `<tr><td>${esc(qLabel(q.quarter))}</td><td class="num">${r1(q.attitude)}</td><td class="num">${q.performance === null ? '未計' : r1(q.performance)}</td>
          <td class="num">${hasAdj ? (adj > 0 ? '+' : '') + r1(adj) : '—'}</td><td class="num"><strong>${r1(q.total)}</strong>${q.total === 100 ? '（上限100）' : ''}</td>${isFt ? `<td>${esc(q.grade || '—')}</td>` : ''}</tr>`;
      }).join('') + '</tbody></table></div></div>';

    html += qs.length > 1
      ? `<div class="field"><label class="field-label" for="ev-q">🔎 查詢季度</label><select class="input" id="ev-q">${qs.slice().reverse().map((q) => `<option value="${esc(q.quarter)}">${esc(qLabel(q.quarter))}</option>`).join('')}</select></div>`
      : '';
    html += '<div data-role="detail"></div>';
    el.innerHTML = html;

    function pt() { return d.kind === 'pt'; }
    function diff(cur, prev) {
      if (prev === null || prev === undefined || cur === null || cur === undefined) return '';
      const v = Math.round((cur - prev) * 10) / 10;
      if (v === 0) return '<span class="ev-note">（持平）</span>';
      return v > 0 ? `<span>▲${v}</span>` : `<span class="ev-down">▼${Math.abs(v)}</span>`;
    }
    function wageTable(score) {
      const tiers = d.wageTiers || [];
      if (!tiers.length) return '';
      const idx = wageIdx(tiers, score);
      return `<div class="table-wrap"><table class="table ev-table"><thead><tr><th>分數區間</th><th>時薪</th></tr></thead><tbody>` +
        tiers.map((t, i) => `<tr class="${i === idx ? 'ev-hl' : ''}"><td>${esc(t[0])}${i === idx ? `　◀ 落點 ${r1(score)} 分` : ''}</td><td>${esc(/^\d+$/.test(t[1]) ? t[1] + ' 元' : t[1])}</td></tr>`).join('') + '</tbody></table></div>';
    }
    function gradeTable(grade) {
      return `<div class="table-wrap"><table class="table ev-table"><thead><tr><th>等第</th><th>分數</th><th>獎金發放基數</th></tr></thead><tbody>` +
        (d.gradeTable || []).map((g, i, a) => `<tr class="${g.grade === grade ? 'ev-hl' : ''}"><td>${esc(g.grade)}</td><td>${g.min} 分以上${i > 0 ? `、未滿 ${a[i - 1].min}` : ''}</td><td>${g.base}</td></tr>`).join('') + '</tbody></table></div>';
    }

    function detail(q) {
      const i = qs.findIndex((x) => x.quarter === q);
      const cur = qs[i];
      const prev = i > 0 ? qs[i - 1] : null;
      const rows = [];
      const items = (labels, vals, max, prevVals) => (labels || []).map((lb, j) => `<tr><td>${esc(lb)}</td><td class="num">${vals ? r1(vals[j]) : '—'}</td><td class="num">${max}</td><td class="num">${vals && prevVals ? diff(vals[j], prevVals[j]) : ''}</td></tr>`).join('');
      const attMax = cur.kind === 'ft' ? 6 : 5;
      const sameLab = (a, b) => a && b && JSON.stringify(a) === JSON.stringify(b);
      rows.push(`<tr class="sub"><td colspan="4">職能態度（滿分 30 分）</td></tr>`);
      rows.push(items(cur.attLabels, cur.attItems, attMax, prev && sameLab(prev.attLabels, cur.attLabels) ? prev.attItems : null));
      rows.push(`<tr class="sub"><td>態度小計</td><td class="num">${r1(cur.attitude)}</td><td class="num">30</td><td class="num">${prev ? diff(cur.attitude, prev.attitude) : ''}</td></tr>`);
      if (cur.kind === 'ft') {
        rows.push(`<tr class="sub"><td colspan="4">職能表現｜主管 KPI（滿分 70 分）</td></tr>`);
        rows.push((cur.kpi || []).map((k) => `<tr><td>${esc(k.label)}${k.target || k.actual ? `<div class="ev-note">🎯 ${esc(k.target || '—')}｜實際 <span class="ev-down">${esc(k.actual || '—')}</span></div>` : ''}</td><td class="num">${k.score === null ? '未評' : r1(k.score)}</td><td class="num">${k.weight}</td><td></td></tr>`).join(''));
      } else {
        rows.push(`<tr class="sub"><td colspan="4">職能表現（滿分 70 分）</td></tr>`);
        rows.push(items(cur.perfLabels, cur.perfItems, 5, prev && sameLab(prev.perfLabels, cur.perfLabels) ? prev.perfItems : null));
      }
      rows.push(`<tr class="sub"><td>表現小計</td><td class="num">${cur.performance === null ? '未計' : r1(cur.performance)}</td><td class="num">70</td><td class="num">${prev ? diff(cur.performance, prev.performance) : ''}</td></tr>`);
      const hasAdj = Number(cur.adjAtt) !== 0 || Number(cur.adjPerf) !== 0;
      const gradeTxt = cur.kind === 'ft' && cur.grade ? `　<span class="tag">${esc(cur.grade)} 等</span>` : '';
      if (hasAdj) {
        rows.push(`<tr class="grand"><td>態度＋表現</td><td class="num">${r1(cur.subtotal)}</td><td class="num">100</td><td></td></tr>`);
        const adj = (Number(cur.adjAtt) || 0) + (Number(cur.adjPerf) || 0);
        rows.push(`<tr><td>主管加減分</td><td class="num">${adj > 0 ? '+' : ''}${r1(adj)}</td><td></td><td></td></tr>`);
        rows.push(`<tr class="grand"><td>實際分數（含加減分）${gradeTxt}</td><td class="num">${r1(cur.total)}${cur.total === 100 ? '（上限100）' : ''}</td><td class="num">100</td><td class="num">${prev ? diff(cur.total, prev.total) : ''}</td></tr>`);
      } else {
        rows.push(`<tr class="grand"><td>總分（態度＋表現）${gradeTxt}</td><td class="num">${r1(cur.total)}</td><td class="num">100</td><td class="num">${prev ? diff(cur.total, prev.total) : ''}</td></tr>`);
      }
      let out = `<div class="card"><div class="card-title">${esc(qLabel(q))} 細項${cur.source === 'hist' ? '（舊系統匯入）' : ''}</div>
        <div class="table-wrap"><table class="table ev-table"><thead><tr><th>項目</th><th class="num">得分</th><th class="num">配分</th><th class="num">與上季比</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></div>`;
      // 自評 vs 他評（只有即時計算的季度有）
      if (cur.selfAtt && cur.peerAttItems) {
        const sAtt = cur.kind === 'ft' ? cur.selfAtt.map((v) => v * 1.2) : cur.selfAtt;
        const line = (lb, s, p) => `<tr><td>${esc(lb)}</td><td class="num">${r1(s)}</td><td class="num">${r1(p)}</td></tr>`;
        out += `<div class="card"><div class="card-title">自評 vs 同事評</div><div class="table-wrap"><table class="table ev-table"><thead><tr><th>項目</th><th class="num">你給自己</th><th class="num">同事平均</th></tr></thead><tbody>` +
          (cur.attLabels || []).map((lb, j) => line(lb, sAtt[j], cur.peerAttItems[j])).join('') +
          (cur.kind === 'pt' && cur.selfPerf && cur.peerPerfItems ? (cur.perfLabels || []).map((lb, j) => line(lb, cur.selfPerf[j], cur.peerPerfItems[j])).join('') : '') +
          '</tbody></table></div></div>';
      }
      out += cur.kind === 'ft'
        ? `<div class="card"><div class="card-title">考核等第 × 獎金發放基數</div>${gradeTable(cur.grade)}</div>`
        : `<div class="card"><div class="card-title">下一季時薪對照</div>${wageTable(cur.total)}</div>`;
      return out;
    }
    const box = el.querySelector('[data-role="detail"]');
    box.innerHTML = detail(latestQ);
    const sel = el.querySelector('#ev-q');
    if (sel) sel.addEventListener('change', () => { box.innerHTML = detail(sel.value); });
  })();
  return () => { alive = false; };
}

