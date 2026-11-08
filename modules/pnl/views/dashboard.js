/**
 * modules/pnl/views/dashboard.js — 儀表板（原生化 P3 T14；行為對照舊網站 ~/mala-pnl-auto/gas/dashboard.html）
 * 門市（可看全部時多「全部門市」）＋月份；頁首「本月待補 N 項 → 前往填資料」（全部門市只顯示各店合計、不附連結）；
 * 六列（營業額、稅後淨利、食材、人事、可控、不可控）：本月金額＋佔營收＋較上月＋12 個月走勢（自繪 SVG）。
 * 沒有科目明細與待補清單（Eason 2026-09-29 拿掉）。純函式在 dashboard-lib.js。
 */
'use strict';

import { call, errText } from '../lib/api.js';
import { getSettings, storeOptions, settle, sel, canWrite } from '../state.js';
import { currentMonth } from '../bridge.js';
import { loadingHtml, noticeHtml, errorHtml, storeSelectHtml, monthSelectHtml } from './common.js';
import {
  METRICS, LEGEND_DEFAULT_MAX, safeNum, fmtInt, fmtPct1, sameStringSet, metricValue, deltaInfo, monthIsEmpty, countPending,
  statusText, statusTextAll, estimatedBlocks, estimateNotes, metricTitle, brandOptions, assignSeriesColors, visibleStoreIds,
  defaultHidden, sumMultiAt, chartGeometry, chartSvg, tooltipRows, buildStoreSeries, buildMultiSeries,
  buildPnlCsvRows, buildEntriesCsvRows, buildCsv, withBom, csvFilename, threeLinesHtml
} from './dashboard-lib.js';

const STYLE = `
.pnl-filters{display:grid;grid-template-columns:1fr 1fr;gap:var(--gap)}
.pnl-status{margin:0;color:var(--muted);font-size:14px}
.pnl-pending-hint{margin:0;font-size:14px}
.pnl-metric{display:grid;grid-template-columns:260px 1fr;gap:16px;padding:16px;border:1px solid var(--line);border-radius:var(--radius);background:var(--card);box-shadow:var(--shadow);margin-top:var(--gap)}
.pnl-metric-title{font-weight:600;margin-bottom:6px}
.pnl-metric-value{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.pnl-metric-pct,.pnl-metric-delta,.pnl-metric-sub{font-size:13px;color:var(--muted);margin-top:4px}
.pnl-metric-sub div{display:flex;justify-content:space-between;gap:8px}
.pnl-delta-up{color:var(--ok)}.pnl-delta-down{color:var(--danger)}
.pnl-chart-box{position:relative;min-width:0}
.pnl-chart-title{font-size:13px;color:var(--muted);margin-bottom:4px}
.pnl-chart-host{position:relative}
.pnl-chart{display:block;max-width:100%;touch-action:pan-y}
.pnl-chart-empty{color:var(--muted);font-size:14px;padding:24px 0}
.pnl-tip{position:absolute;top:12px;z-index:2;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);padding:6px 10px;font-size:12px;pointer-events:none;white-space:nowrap}
.pnl-tip-row{display:flex;align-items:center;gap:6px;margin-top:2px}
.pnl-key{display:inline-block;width:16px;border-top:3px solid currentColor}
.pnl-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pnl-pill,.pnl-legend-item{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:4px 12px;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.pnl-pill[aria-pressed=true]{background:var(--brand);border-color:var(--brand);color:var(--ink-inverse)}
.pnl-legend-item[aria-pressed=false]{opacity:.45;text-decoration:line-through}
.pnl-note{margin:8px 0 0;font-size:13px;color:var(--muted)}
.pnl-three-title{font-weight:600}
.pnl-three-draft{margin-left:6px;padding:1px 8px;border-radius:999px;background:var(--line);color:var(--ink);font-size:12px;font-weight:400}
.pnl-three-line{margin:0}
.pnl-skel{display:block;border-radius:6px;background:var(--line);animation:pnl-pulse 1.2s ease-in-out infinite}
.pnl-skel-v{height:28px;width:150px;margin-bottom:8px}.pnl-skel-l{height:12px;width:110px;margin-top:8px}.pnl-skel-c{height:168px;width:100%}
@keyframes pnl-pulse{50%{opacity:.4}}
@media (max-width:767px){.pnl-metric{grid-template-columns:1fr;padding:12px}.pnl-metric-value{font-size:22px}}
`;

function downloadCsvFile(filename, csvWithBom) {
  const url = URL.createObjectURL(new Blob([csvWithBom], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.setAttribute('data-role', 'pnl-download');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountDashboard(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let seq = 0;
  let settings = null;
  let storeList = [];          // 單店清單（不含 ALL）
  let nameMap = {};
  let cur = null;              // 最近一次成功載入：{store, month, data, trend, multi}
  let brandFilter = '全部';
  let legendTouched = false;
  let hidden = {};
  let seriesByMetric = {};
  let resizeTimer = null;
  let lastW = 0;

  const nowMonth = () => currentMonth();
  const nameOf = (sid) => nameMap[sid] || sid;
  const q = (s) => el.querySelector(s);

  function buildNames() {
    const cnt = {};
    storeList.forEach((s) => { cnt[s.name || s.store_id] = (cnt[s.name || s.store_id] || 0) + 1; });
    nameMap = {};
    storeList.forEach((s) => {
      const n = s.name || s.store_id;
      nameMap[s.store_id] = cnt[n] > 1 && s.brand ? s.brand + n : n;
    });
  }

  async function boot() {
    el.innerHTML = loadingHtml('讀取中…');
    const r = await getSettings(ctx);
    if (!alive) return;
    if (!r.ok) { el.innerHTML = errorHtml(esc, errText(r)); return; }
    settings = r.data;
    storeList = storeOptions(settings, false);
    buildNames();
    const options = storeOptions(settings, true).map((s) => ({ store_id: s.store_id, name: s.store_id === 'ALL' ? '全部門市' : nameOf(s.store_id) }));
    if (!options.length) { el.innerHTML = noticeHtml(esc, '尚未設定門市：請管理者到「設定 ▸ 門市」新增。', 'pnl-no-store'); return; }
    settle(options, ctx.params);
    el.innerHTML = `<style data-pnl="dashboard">${STYLE}</style>
      <div data-role="pnl-three-lines-host"></div>
      <div class="card stack" data-role="pnl-dash-head">
        <div class="pnl-filters">${storeSelectHtml(esc, options, sel.store, 'pnl-dash-store')}${monthSelectHtml(esc, sel.month, nowMonth(), 'pnl-dash-month')}</div>
        <div class="pnl-bar" data-role="pnl-downloads">
          <button type="button" class="btn" data-act="pnl-csv-pnl" disabled>下載損益表 CSV</button>
          <button type="button" class="btn" data-act="pnl-csv-entries" disabled>下載明細 CSV</button>
        </div>
        <p class="pnl-status" data-role="pnl-month-status"></p>
        <p class="pnl-pending-hint" data-role="pnl-pending-hint" hidden></p>
      </div>
      <div data-role="pnl-dash-body"></div>`;
    load();
  }

  function setThreeLines(tl) { const h = q('[data-role="pnl-three-lines-host"]'); if (h) h.innerHTML = threeLinesHtml(esc, tl); }

  function setBody(html) { const b = q('[data-role="pnl-dash-body"]'); if (b) b.innerHTML = html; return b; }

  function setCsv(on) { el.querySelectorAll('[data-act^="pnl-csv-"]').forEach((b) => { b.disabled = !on; }); }
  const csvLabel = (sid) => (sid === 'ALL' ? '全部' : nameOf(sid));

  async function downloadEntries(btn) {
    const { store, month } = cur;
    btn.disabled = true;
    const r = await call(ctx, 'exportEntries', { store_id: store, month });
    if (!alive) return;
    btn.disabled = false;
    if (!r.ok) { ctx.ui.toast(errText(r), 'error'); return; }
    const meta = {}; storeList.forEach((x) => { meta[x.store_id] = x; });
    const rows = buildEntriesCsvRows((r.data && r.data.entries) || [], {
      accountName: (id) => { const a = ((settings && settings.accounts) || []).find((x) => x.acc_id === id); return a ? a.name : id; },
      storeName: (sid) => (meta[sid] && meta[sid].name) || sid,
      storeBrand: (sid) => (meta[sid] && meta[sid].brand) || ''
    });
    downloadCsvFile(csvFilename('明細', csvLabel(store), month), withBom(buildCsv(rows)));
  }

  function skeleton() {
    setCsv(false);
    setThreeLines(null);
    const status = q('[data-role="pnl-month-status"]'); if (status) status.textContent = '讀取中…';
    const hint = q('[data-role="pnl-pending-hint"]'); if (hint) { hint.hidden = true; hint.textContent = ''; }
    setBody(`<div data-role="pnl-skeleton" aria-busy="true">${METRICS.map((m) => `<div class="pnl-metric" data-metric="${m.key}">
      <div><div class="pnl-metric-title">${esc(m.title)}</div><span class="pnl-skel pnl-skel-v"></span><span class="pnl-skel pnl-skel-l"></span><span class="pnl-skel pnl-skel-l"></span></div>
      <div><div class="pnl-chart-title">每月走勢</div><span class="pnl-skel pnl-skel-c"></span></div></div>`).join('')}</div>`);
  }

  async function fetchMulti(month) {
    const ids = storeList.map((s) => s.store_id);
    const out = { months: [], stores: {} };
    for (let i = 0; i < ids.length; i += 40) {
      const r = await call(ctx, 'getTrendMulti', { store_ids: ids.slice(i, i + 40), month, n: 12 });
      if (!r.ok) return r;
      out.months = (r.data && r.data.months) || out.months;
      Object.assign(out.stores, (r.data && r.data.stores) || {});
    }
    return { ok: true, data: out };
  }

  async function load() {
    const my = ++seq;
    const store = sel.store, month = sel.month;
    skeleton();
    const isAll = store === 'ALL';
    const [m, t] = await Promise.all([
      call(ctx, 'getMonth', { store_id: store, month }),
      isAll ? (storeList.length ? fetchMulti(month) : Promise.resolve({ ok: true, data: { months: [], stores: {} } }))
        : call(ctx, 'getTrend', { store_id: store, month, n: 12 })
    ]);
    if (!alive || my !== seq) return;   // 切店／切月太快：舊回應不蓋新畫面
    const bad = !m.ok ? m : !t.ok ? t : null;
    if (bad) {
      const st = q('[data-role="pnl-month-status"]'); if (st) st.textContent = '';
      setCsv(false);
      setBody(errorHtml(esc, errText(bad)));
      return;
    }
    cur = { store, month, data: m.data || {}, trend: isAll ? null : (t.data || []), multi: isAll ? t.data : null };
    render();
  }

  // ---- 畫面 ----
  function render() {
    const { store, month, data } = cur;
    const isAll = store === 'ALL';
    const empty = monthIsEmpty(data, isAll);
    const result = data.result || null;
    const accounts = (settings && settings.accounts) || [];

    setCsv(true);
    setThreeLines(data.three_lines);
    q('[data-role="pnl-month-status"]').textContent = isAll ? statusTextAll(data, nameOf) : statusText(data);

    // 本月待補 N 項
    const hint = q('[data-role="pnl-pending-hint"]');
    const n = empty ? 0 : countPending(result, isAll);
    hint.textContent = '';
    hint.hidden = !n;
    if (n) {
      const text = (isAll ? '本月各店合計待補 ' : '本月待補 ') + n + ' 項';
      if (isAll || !canWrite(settings)) hint.textContent = text;
      else hint.innerHTML = `<a href="#/pnl/pending" data-act="pnl-goto-pending" data-role="pnl-pending-link">${esc(text)} → 前往填資料</a>`;
    }

    // 圖例／品牌
    const brands = isAll ? brandOptions(storeList) : [];
    if (brandFilter !== '全部' && brands.indexOf(brandFilter) === -1) brandFilter = '全部';
    const colors = assignSeriesColors(storeList.map((s) => s.store_id));
    let ids = [];
    if (isAll) {
      ids = visibleStoreIds(cur.multi, storeList, brandFilter);
      if (!legendTouched) hidden = defaultHidden(ids);
    }

    // 本月數字
    const months = isAll ? (cur.multi && cur.multi.months) || [] : (cur.trend || []).map((r) => r.month);
    const curIdx = months.indexOf(month);
    let headRow = empty ? null : result, prevRow = data.prev || null;
    let mismatch = false;
    if (isAll && prevRow) mismatch = !sameStringSet(Object.keys(data.status || {}), data.prev_stores || []);
    if (isAll && brandFilter !== '全部' && cur.multi && curIdx >= 0) {
      headRow = empty ? null : sumMultiAt(cur.multi, ids, curIdx);
      const p = curIdx > 0 ? sumMultiAt(cur.multi, ids, curIdx - 1) : null;
      prevRow = p && p.stores.length ? p : null;
      mismatch = !!(headRow && prevRow && !sameStringSet(headRow.stores, prevRow.stores));
    }
    const partial = !isAll && month === nowMonth() && data.status !== '定稿';
    const estBlocks = !isAll && !empty ? estimatedBlocks(result, accounts) : {};
    const revenue = headRow ? safeNum(headRow.blocks && headRow.blocks['營收']) : 0;

    let html = '';
    if (isAll && (brands.length || ids.length > 1)) {
      html += `<div class="card stack" data-role="pnl-filter-bar">`;
      if (brands.length) {
        html += `<div class="pnl-bar" role="group" aria-label="品牌篩選" data-role="pnl-brand-bar">${['全部'].concat(brands).map((b) =>
          `<button type="button" class="pnl-pill" data-act="pnl-brand" data-brand="${esc(b)}" aria-pressed="${brandFilter === b}">${esc(b)}</button>`).join('')}</div>`;
      }
      if (ids.length > 1) {
        html += `<div class="pnl-bar" role="group" aria-label="圖例（點選可隱藏／顯示該門市的線）" data-role="pnl-legend">${ids.map((sid) => {
          const c = colors[sid];
          return `<button type="button" class="pnl-legend-item" data-act="pnl-legend" data-sid="${esc(sid)}" aria-pressed="${!hidden[sid]}">` +
            `<span class="pnl-key" style="color:${esc(c.color)}${c.dash ? ';border-top-style:dashed' : ''}"></span>${esc(nameOf(sid))}</button>`;
        }).join('')}`;
        if (ids.length > LEGEND_DEFAULT_MAX) {
          const anyHidden = ids.some((sid) => hidden[sid]);
          html += `<button type="button" class="btn" data-act="pnl-legend-all">${anyHidden ? '顯示全部 ' + ids.length + ' 家' : '只顯示前 ' + LEGEND_DEFAULT_MAX + ' 家'}</button>`;
        }
        html += `</div>`;
      }
      if (brandFilter !== '全部') html += `<p class="pnl-note">＊上方六列只含「${esc(brandFilter)}」的單位。</p>`;
      html += `</div>`;
    }
    if (empty) html += noticeHtml(esc, '本月尚未建立草稿', 'pnl-empty-month');
    if (mismatch) html += `<p class="pnl-note" data-role="pnl-mismatch">＊全部合計本月與上月的店家組成不同（上月比較僅涵蓋：${esc((data.prev_stores || []).map(nameOf).join('、'))}），較上月比較僅供參考、不顯示百分比。</p>`;
    if (!isAll && !empty) estimateNotes(result, accounts).forEach((t) => { html += `<p class="pnl-note" data-role="pnl-estimate-note">${esc(t)}</p>`; });

    // 六列
    seriesByMetric = {};
    METRICS.forEach((metric) => {
      const title = metricTitle(metric, estBlocks);
      const estimated = metric.key === 'net' ? Object.keys(estBlocks).length > 0 : metric.blocks.some((b) => estBlocks[b]);
      const val = headRow ? metricValue(metric, headRow) : null;
      let inner = `<div class="pnl-metric-title" data-role="pnl-metric-title">${esc(title)}</div>
        <div class="pnl-metric-value" data-role="pnl-metric-value">NT$ ${val === null ? '—' : esc(fmtInt(val))}</div>`;
      if (headRow) {
        inner += `<div class="pnl-metric-pct" data-role="pnl-metric-pct">佔營收 ${metric.key === 'revenue' ? (revenue ? '100.0%' : '—') : esc(fmtPct1(val, revenue))}</div>`;
        let dtext, dcls = '';
        if (partial) dtext = '— 月中，不比較';
        else if (mismatch) dtext = '— 店家組成不同';
        else {
          const d = deltaInfo(val, prevRow ? metricValue(metric, prevRow) : null);
          dtext = d.arrow + ' ' + d.text;
          if (metric.key === 'revenue' || metric.key === 'net') dcls = d.dir === 'up' ? 'pnl-delta-up' : d.dir === 'down' ? 'pnl-delta-down' : '';
        }
        inner += `<div class="pnl-metric-delta" data-role="pnl-metric-delta">較上月 <span class="${dcls}">${esc(dtext)}</span></div>`;
        if (metric.key === 'food') {
          inner += `<div class="pnl-metric-sub">${['食材', '包材'].map((b) => `<div><span>${b}</span><span>NT$ ${esc(fmtInt(safeNum(headRow.blocks && headRow.blocks[b])))}</span></div>`).join('')}</div>`;
        }
        if (metric.key === 'net') {
          inner += `<div class="pnl-metric-sub"><div><span>營業淨利</span><span>NT$ ${esc(fmtInt(safeNum(headRow.operating_profit)))}</span></div></div>`;
        }
      }
      seriesByMetric[metric.key] = isAll
        ? buildMultiSeries(metric, cur.multi || { stores: {} }, ids, nameOf, colors, hidden, nowMonth())
        : buildStoreSeries(metric, cur.trend, { id: store, name: nameOf(store), color: colors[store] ? colors[store].color : '#2a78d6', month, headRow, estimated, nowMonth: nowMonth() });
      html += `<div class="pnl-metric" data-role="pnl-metric" data-metric="${metric.key}"><div>${inner}</div>
        <div class="pnl-chart-box" data-role="pnl-chart-box"><div class="pnl-chart-title">每月走勢</div><div class="pnl-chart-host" data-metric="${metric.key}"></div></div></div>`;
    });
    if (months.length) html += `<p class="pnl-note" data-role="pnl-footnote">空心點＋虛線＝估算或月中累計（尚未滿月）；滑過或點圖可看各月數字。</p>`;
    const body = setBody(html);
    cur.ids = ids; cur.months = months;
    drawCharts(body);
  }

  function hostWidth(host) { return Math.max(240, Math.floor(host.clientWidth || host.parentNode.clientWidth || 600)); }

  function drawCharts(root) {
    (root || el).querySelectorAll('.pnl-chart-host').forEach((host) => {
      const key = host.getAttribute('data-metric');
      const series = seriesByMetric[key] || [];
      const metric = METRICS.find((m) => m.key === key);
      if (!series.some((s) => s.points.some((p) => p.has))) {
        const allHidden = cur.store === 'ALL' && cur.ids.length > 0 && series.length === 0;
        host.innerHTML = `<div class="pnl-chart-empty" data-role="pnl-chart-empty">${allHidden ? '所有門市都已隱藏，點上方圖例重新顯示' : '資料累積中'}</div>`;
        return;
      }
      const w = hostWidth(host);
      lastW = w;
      host.innerHTML = chartSvg(esc, { title: metric.title, months: cur.months, series, width: w }) + `<div class="pnl-tip" data-role="pnl-tip" hidden></div>`;
      attachHover(host, series, w);
    });
  }

  function attachHover(host, series, w) {
    const svg = host.querySelector('svg');
    const hit = svg.querySelector('[data-role="pnl-hit"]');
    const cross = svg.querySelector('[data-role="pnl-cross"]');
    const hov = svg.querySelector('[data-role="pnl-hover"]');
    const tip = host.querySelector('[data-role="pnl-tip"]');
    const vis = series.filter((s) => s.points.some((p) => p.has));
    const g = chartGeometry(cur.months, vis, w);
    const NS = 'http://www.w3.org/2000/svg';
    function show(idx) {
      const x = g.xFor(idx);
      cross.setAttribute('x1', x.toFixed(1)); cross.setAttribute('x2', x.toFixed(1)); cross.style.display = '';
      while (hov.firstChild) hov.removeChild(hov.firstChild);
      tip.textContent = '';
      const title = document.createElement('div');
      title.textContent = cur.months[idx];
      title.style.fontWeight = '600';
      tip.appendChild(title);
      const rows = tooltipRows(vis, idx);
      if (!rows.length) { const r0 = document.createElement('div'); r0.textContent = '這個月沒有資料'; tip.appendChild(r0); }
      rows.forEach((r) => {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', x.toFixed(1)); c.setAttribute('cy', g.yFor(r.value).toFixed(1)); c.setAttribute('r', '5');
        c.setAttribute('fill', r.color); c.setAttribute('stroke', 'var(--card)'); c.setAttribute('stroke-width', '2');
        hov.appendChild(c);
        const row = document.createElement('div');
        row.className = 'pnl-tip-row';
        const k = document.createElement('span');
        k.className = 'pnl-key'; k.style.color = r.color; if (r.dash) k.style.borderTopStyle = 'dashed';
        row.appendChild(k);
        const v = document.createElement('span'); v.textContent = r.text; row.appendChild(v);
        if (vis.length > 1) { const nm = document.createElement('span'); nm.style.color = 'var(--muted)'; nm.textContent = r.name; row.appendChild(nm); }
        tip.appendChild(row);
      });
      tip.hidden = false;
      const tw = tip.offsetWidth || 160;
      let left = x + 12; if (left + tw > w) left = x - 12 - tw;
      tip.style.left = Math.max(0, left) + 'px';
    }
    function hide() { cross.style.display = 'none'; while (hov.firstChild) hov.removeChild(hov.firstChild); tip.hidden = true; }
    function idxOf(ev) {
      const rect = svg.getBoundingClientRect();
      const x = (ev.clientX - rect.left) * (rect.width ? w / rect.width : 1);
      const stepX = g.n > 1 ? g.innerW / (g.n - 1) : 0;
      return g.n <= 1 ? 0 : Math.max(0, Math.min(g.n - 1, Math.round((x - g.padL) / stepX)));
    }
    hit.addEventListener('pointermove', (ev) => show(idxOf(ev)));
    hit.addEventListener('pointerdown', (ev) => show(idxOf(ev)));
    hit.addEventListener('pointerleave', hide);
  }

  // ---- 事件 ----
  function onClick(ev) {
    const t = ev.target.closest('[data-act]');
    if (!t || !el.contains(t)) return;
    const act = t.getAttribute('data-act');
    if (act === 'pnl-retry') { ev.preventDefault(); if (settings) load(); else boot(); return; }
    if (!cur) return;
    if (act === 'pnl-csv-pnl') {
      const rows = buildPnlCsvRows((settings && settings.accounts) || [], cur.data.result || {});
      downloadCsvFile(csvFilename('損益', csvLabel(cur.store), cur.month), withBom(buildCsv(rows)));
      return;
    }
    if (act === 'pnl-csv-entries') { downloadEntries(t); return; }
    if (act === 'pnl-goto-pending') { ev.preventDefault(); ctx.nav('pending', { store: cur.store, month: cur.month }); return; }
    if (act === 'pnl-brand') { brandFilter = t.getAttribute('data-brand'); render(); return; }
    if (act === 'pnl-legend') {
      legendTouched = true;
      const sid = t.getAttribute('data-sid');
      if (hidden[sid]) delete hidden[sid]; else hidden[sid] = true;
      render(); return;
    }
    if (act === 'pnl-legend-all') {
      legendTouched = true;
      const ids = cur.ids || [];
      hidden = ids.some((sid) => hidden[sid]) ? {} : defaultHidden(ids);
      render();
    }
  }
  function onChange(ev) {
    const r = ev.target.getAttribute && ev.target.getAttribute('data-role');
    if (r === 'pnl-store') { sel.store = ev.target.value; load(); }
    else if (r === 'pnl-month') { sel.month = ev.target.value; load(); }
  }
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!alive || !cur) return;
      const h = q('.pnl-chart-host');
      if (h && Math.abs(hostWidth(h) - lastW) >= 8) drawCharts(el);
    }, 150);
  }

  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  window.addEventListener('resize', onResize);
  boot();

  return function unmount() {
    alive = false;
    clearTimeout(resizeTimer);
    el.removeEventListener('click', onClick);
    el.removeEventListener('change', onChange);
    window.removeEventListener('resize', onResize);
  };
}
