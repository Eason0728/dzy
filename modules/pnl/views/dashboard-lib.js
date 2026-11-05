/**
 * modules/pnl/views/dashboard-lib.js — 儀表板的純函式（無 DOM；test/pnl-dashboard.test.mjs 測）
 * 對照舊網站 ~/mala-pnl-auto/gas/dashboard.html：METRICS／metricValue／deltaInfo／monthHasData／
 * niceDomain／fmtAxis／走勢圖 SVG／待補數／估算區塊／本月累計至 M/D／多店加總。
 * 字串進 SVG 或 HTML 一律先過 esc（呼叫端傳 ctx.fmt.esc）。
 */
'use strict';

/** 六列（舊網站 METRICS） */
export const METRICS = [
  { key: 'revenue', title: '營業額', blocks: ['營收'] },
  { key: 'net', title: '稅後淨利', blocks: null },
  { key: 'food', title: '食材費用（食材＋包材）', blocks: ['食材', '包材'] },
  { key: 'labor', title: '人事費用', blocks: ['人事'] },
  { key: 'controllable', title: '可控費用', blocks: ['可控'] },
  { key: 'uncontrollable', title: '不可控費用', blocks: ['不可控'] }
];

export const LEGEND_DEFAULT_MAX = 6;
export const BRAND_ORDER = ['鼎兆元', '墨竹亭', '小辛辣'];
/** 類別色（固定順序，色隨門市不隨排名）；用完才重複並改畫虛線 */
export const SERIES_PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

export function safeNum(n) { return typeof n === 'number' && isFinite(n) ? n : 0; }

/** 整數元（先吸收浮點尾差，.5 遠離 0），負數用「−」 */
export function fmtInt(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const a = Math.abs(n);
  const r = Math.floor(Math.round(a * 1e6) / 1e6 + 0.5);
  const s = String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 && r !== 0 ? '−' : '') + s;
}

export function fmtPct1(part, whole) {
  if (typeof part !== 'number' || typeof whole !== 'number' || !isFinite(part) || !isFinite(whole) || whole === 0) return '—';
  return (Math.round((part / whole) * 1000) / 10).toFixed(1) + '%';
}

export function sameStringSet(a, b) {
  const x = (a || []).slice().sort(), y = (b || []).slice().sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function metricValue(metric, row) {
  if (!row) return 0;
  if (metric.key === 'net') return safeNum(row.net_profit);
  return metric.blocks.reduce((sum, b) => sum + safeNum(row.blocks && row.blocks[b]), 0);
}

export function shiftMonth(month, delta) {
  const t = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  const y = Math.floor(t / 12);
  return y + '-' + String(t - y * 12 + 1).padStart(2, '0');
}

/** 與上月比較（舊網站 deltaInfo 的小基期／虧轉盈／>300% 規則）→ {dir, arrow, text} */
export function deltaInfo(cur, prevVal) {
  if (prevVal === null || prevVal === undefined) return { dir: 'flat', arrow: '–', text: '—' };
  cur = safeNum(cur); prevVal = safeNum(prevVal);
  const diff = cur - prevVal;
  const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '–';
  if (diff === 0) return { dir, arrow, text: '持平' };
  const amt = 'NT$ ' + fmtInt(Math.abs(diff));
  if (prevVal <= 0 && cur > 0) return { dir, arrow, text: '由虧轉盈 +' + amt };
  const money = (diff > 0 ? '+' : '−') + amt;
  if (prevVal <= 0 || Math.abs(prevVal) < Math.abs(cur) * 0.05) return { dir, arrow, text: money };
  const pct = (diff / Math.abs(prevVal)) * 100;
  if (Math.abs(pct) > 300) return { dir, arrow, text: money };
  return { dir, arrow, text: (pct >= 0 ? '+' : '') + (Math.round(pct * 10) / 10).toFixed(1) + '%' };
}

/** 這個月有沒有資料（走勢斷線用）：has_entries=false 或狀態「無」都算沒資料 */
export function monthHasData(row, isAllView) {
  if (!row || row.status === undefined) return true;
  if (row.has_entries === false) return false;
  if (isAllView) {
    if (!row.status || typeof row.status !== 'object') return true;
    const keys = Object.keys(row.status);
    return keys.length > 0 && keys.some((k) => row.status[k] !== '無');
  }
  return row.status !== '無';
}

/** getMonth 回應是不是「完全沒建草稿」 */
export function monthIsEmpty(data, isAll) {
  if (!data) return true;
  if (isAll) {
    const keys = Object.keys(data.status || {});
    return keys.length === 0 || keys.every((k) => data.status[k] === '無');
  }
  return data.status === '無';
}

/** 待補項數：單店＝陣列長度；全部＝各店加總 */
export function countPending(result, isAll) {
  if (!result || !result.pending) return 0;
  if (!isAll) return Array.isArray(result.pending) ? result.pending.length : 0;
  return Object.keys(result.pending).reduce((n, sid) => n + (Array.isArray(result.pending[sid]) ? result.pending[sid].length : 0), 0);
}

/** 「M/D」取自 ISO 字串（來源已是台北時間，不做時區換算） */
export function isoToMD(iso) {
  if (typeof iso !== 'string' || iso.length < 10) return '';
  const m = parseInt(iso.slice(5, 7), 10), d = parseInt(iso.slice(8, 10), 10);
  return m && d ? m + '/' + d : '';
}

/**
 * 月份狀態文字（單店）：「狀態：草稿」＋ POS 手動上傳說明 或 原封不動的「本月累計至 M/D」。
 * 舊網站：來源「匯入:T01」→ POS 已由店長手動上傳（M/D），自動推送暫停；否則找 來源「匯入:POS自動」且備註以「本月累計至」開頭 → 取「；」前。
 */
export function statusText(data) {
  let t = '狀態：' + (data && data.status ? data.status : '無');
  const entries = (data && data.entries) || [];
  const manual = entries.find((e) => e && e.source === '匯入:T01');
  if (manual) {
    const md = manual.created_at ? isoToMD(manual.created_at) : '';
    return t + '　POS 已由店長手動上傳' + (md ? '（' + md + '）' : '') + '，自動推送暫停';
  }
  const mtd = entries.find((e) => e && e.source === '匯入:POS自動' && typeof e.note === 'string' && e.note.indexOf('本月累計至') === 0);
  if (mtd) t += '　' + mtd.note.split('；')[0];
  return t;
}

/** 全部門市的狀態文字：「店名：狀態　店名：狀態」 */
export function statusTextAll(data, nameOf) {
  const parts = Object.keys((data && data.status) || {}).map((sid) => nameOf(sid) + '：' + data.status[sid]);
  return parts.length ? parts.join('　') : '無資料';
}

/** 估算落在哪些區塊 → {人事:true,…}（單店、當月、未定稿才會有） */
export function estimatedBlocks(result, accounts) {
  const out = {};
  if (!result) return out;
  // Codex 審查（2026-11-05）：後端把成本估算（水電等）也併進 result.estimates，非空≠有人事估算；人事專屬訊號是 estimate_basis
  if (result.estimate_basis) out['人事'] = true;
  Object.keys(result.block_estimates || {}).forEach((b) => { out[b] = true; });
  Object.keys(result.cost_estimate_basis || {}).forEach((id) => {
    const acc = (accounts || []).find((a) => a.acc_id === id);
    out[acc && acc.block ? acc.block : '可控'] = true;
  });
  return out;
}

/** 估算說明文字列（人事／食材／包材／費用） */
export function estimateNotes(result, accounts) {
  const notes = [];
  if (!result) return notes;
  const has = result.estimates && Object.keys(result.estimates).length;
  if (has && result.estimate_basis && result.estimate_basis.label) notes.push('人事估算：' + result.estimate_basis.label);
  ['食材', '包材'].forEach((b) => {
    const est = (result.block_estimates || {})[b];
    if (est && est.label) notes.push(b + '估算：' + est.label);
  });
  const cb = result.cost_estimate_basis || {};
  const lbl = Object.keys(cb).map((id) => {
    const acc = (accounts || []).find((a) => a.acc_id === id);
    return (acc ? acc.name : id) + '：' + (cb[id] && cb[id].label ? cb[id].label : '');
  }).join('；');
  if (lbl) notes.push('費用估算：' + lbl);
  return notes;
}

/** 卡片標題後綴：人事等「（估）」、稅後淨利「（含估算）」 */
export function metricTitle(metric, estBlocks) {
  const any = Object.keys(estBlocks || {}).length > 0;
  const est = metric.key === 'net' ? any : metric.blocks.some((b) => estBlocks && estBlocks[b]);
  return metric.title + (est ? (metric.key === 'net' ? '（含估算）' : '（估）') : '');
}

/** 品牌清單（固定順序，其餘排後面） */
export function brandOptions(stores) {
  const seen = {};
  (stores || []).forEach((s) => { if (s.brand) seen[s.brand] = true; });
  const extra = Object.keys(seen).filter((b) => BRAND_ORDER.indexOf(b) === -1).sort();
  return BRAND_ORDER.filter((b) => seen[b]).concat(extra);
}

/** 各店顏色：整份清單一次分配（篩選／隱藏不重新上色）；8 色用完才重複並畫虛線 */
export function assignSeriesColors(storeIds) {
  const out = {};
  storeIds.forEach((sid, i) => {
    out[sid] = { color: SERIES_PALETTE[i % SERIES_PALETTE.length], dash: i >= SERIES_PALETTE.length ? '6 4' : '' };
  });
  return out;
}

/** 全部門市走勢要畫的店：近 12 月有資料、符合品牌 */
export function visibleStoreIds(multi, storeList, brandFilter) {
  return storeList.filter((s) => {
    const rows = multi && multi.stores && multi.stores[s.store_id];
    if (!(rows && rows.some((r) => monthHasData(r, false)))) return false;
    return brandFilter === '全部' || s.brand === brandFilter;
  }).map((s) => s.store_id);
}

/** 圖例預設：超過 6 條，第 7 條以後預設隱藏（使用者沒動過圖例時） */
export function defaultHidden(ids) {
  const h = {};
  ids.slice(LEGEND_DEFAULT_MAX).forEach((sid) => { h[sid] = true; });
  return h;
}

/** 全部門市＋品牌篩選：某月把可見店的區塊加總；回 {blocks, net_profit, operating_profit, stores} */
export function sumMultiAt(multi, ids, idx) {
  const out = { blocks: {}, net_profit: 0, operating_profit: 0, stores: [] };
  ids.forEach((sid) => {
    const r = multi.stores[sid] && multi.stores[sid][idx];
    if (!r || !monthHasData(r, false)) return;
    out.stores.push(sid);
    Object.keys(r.blocks || {}).forEach((b) => { out.blocks[b] = safeNum(out.blocks[b]) + safeNum(r.blocks[b]); });
    out.net_profit += safeNum(r.net_profit);
    out.operating_profit += safeNum(r.operating_profit);
  });
  return out;
}

// ---- 刻度 ----
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}
export function niceDomain(values) {
  let min = 0, max = 0;
  values.forEach((v) => { if (v < min) min = v; if (v > max) max = v; });
  if (min === max) max = min + 1;
  const step = niceStep((max - min) / 4);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t * 100) / 100);
  return { min: lo, max: hi, ticks };
}
/** 軸標：萬為單位，1 萬以下照原數字 */
export function fmtAxis(v) {
  if (v === 0) return '0';
  const abs = Math.abs(v), sign = v < 0 ? '−' : '';
  if (abs >= 10000) {
    const w = abs / 10000;
    return sign + (w >= 100 ? String(Math.round(w)) : String(Math.round(w * 10) / 10)) + '萬';
  }
  return sign + fmtInt(abs);
}
export function monthShort(m) { return m.slice(2, 4) + '/' + m.slice(5, 7); }

/**
 * 走勢圖幾何：series[{id,name,color,dash,points:[{value,has,hollow,note}]}]（points 與 months 等長）
 * → {W,H,padL,padT,innerW,innerH,xs,dom,lines:[{id,color,dash,d,dashed}],dots:[{id,i,cx,cy,color,hollow}]}
 * 線規則：連續「實心有資料」的點連成一段；空心（估算／月中）點以虛線接到前一個有資料的點；沒資料的月份斷線，不畫 0。
 */
export function chartGeometry(months, series, width) {
  const n = months.length;
  const W = Math.max(240, Math.floor(width || 600));
  const H = W < 480 ? 168 : 196;
  const padL = 46, padR = 14, padT = 12, padB = 24;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const xFor = (i) => (n > 1 ? padL + (i * innerW) / (n - 1) : padL + innerW / 2);
  const all = [];
  series.forEach((s) => s.points.forEach((p) => { if (p.has) all.push(p.value); }));
  const dom = niceDomain(all);
  const yFor = (v) => padT + (1 - (v - dom.min) / (dom.max - dom.min)) * innerH;
  const pathD = (pts) => pts.map((p, k) => (k ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const lines = [], dots = [];
  series.forEach((s) => {
    let solid = [];
    for (let i = 0; i <= n; i++) {
      const p = i < n ? s.points[i] : null;
      if (p && p.has && !p.hollow) { solid.push([xFor(i), yFor(p.value)]); continue; }
      if (solid.length >= 2) lines.push({ id: s.id, color: s.color, dash: s.dash, d: pathD(solid), dashed: false });
      if (p && p.has && p.hollow && i > 0 && s.points[i - 1].has) {
        lines.push({ id: s.id, color: s.color, dash: '3 4', d: pathD([[xFor(i - 1), yFor(s.points[i - 1].value)], [xFor(i), yFor(p.value)]]), dashed: true });
      }
      solid = [];
    }
    let last = -1;
    s.points.forEach((p, i) => { if (p.has) last = i; });
    s.points.forEach((p, i) => {
      if (!p.has) return;
      const prevHas = i > 0 && s.points[i - 1].has && !s.points[i - 1].hollow, nextHas = i < n - 1 && s.points[i + 1].has && !s.points[i + 1].hollow;   // 只算實線相連的鄰居
      if (p.hollow || i === last || (!prevHas && !nextHas)) dots.push({ id: s.id, i, cx: xFor(i), cy: yFor(p.value), color: s.color, hollow: !!p.hollow });
    });
  });
  return { W, H, padL, padR, padT, padB, innerW, innerH, n, dom, xFor, yFor, lines, dots };
}

/** 走勢圖 SVG 字串（顏色用管理系統 CSS 變數：線格 --line、文字 --muted、空心點底 --card） */
export function chartSvg(esc, opts) {
  const { months, title } = opts;
  const series = opts.series.filter((s) => s.points.some((p) => p.has));
  if (!series.length) return '';
  const g = chartGeometry(months, series, opts.width);
  const f1 = (x) => x.toFixed(1);
  let s = `<svg class="pnl-chart" width="${g.W}" height="${g.H}" viewBox="0 0 ${g.W} ${g.H}" role="img" data-role="pnl-chart-svg" aria-label="${esc(title)}每月走勢（${esc(monthShort(months[0]))}～${esc(monthShort(months[g.n - 1]))}，${series.length} 條線）">`;
  g.dom.ticks.forEach((t) => {
    const y = g.yFor(t);
    s += `<line x1="${g.padL}" x2="${g.W - g.padR}" y1="${f1(y)}" y2="${f1(y)}" stroke="var(--line)" stroke-width="${t === 0 ? 1.5 : 1}"/>`;
    s += `<text x="${g.padL - 6}" y="${f1(y + 3.5)}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(fmtAxis(t))}</text>`;
  });
  const every = g.W < 420 ? 3 : g.W < 640 ? 2 : 1;
  months.forEach((m, i) => {
    if (i !== g.n - 1 && (g.n - 1 - i) % every !== 0) return;
    s += `<text x="${f1(g.xFor(i))}" y="${g.H - 6}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(monthShort(m))}</text>`;
  });
  g.lines.forEach((l) => {
    const dash = l.dash ? ` stroke-dasharray="${l.dash}"` : '';
    s += `<path d="${l.d}" fill="none" stroke="${esc(l.color)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${dash} data-role="pnl-line" data-dashed="${l.dashed ? 1 : 0}"/>`;
  });
  g.dots.forEach((d) => {
    s += `<circle cx="${f1(d.cx)}" cy="${f1(d.cy)}" r="3.5" stroke="${esc(d.color)}" stroke-width="2" fill="${d.hollow ? 'var(--card)' : esc(d.color)}" data-role="pnl-dot" data-hollow="${d.hollow ? 1 : 0}"/>`;
  });
  s += `<line data-role="pnl-cross" y1="${g.padT}" y2="${g.padT + g.innerH}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 3" style="display:none"/>`;
  s += `<g data-role="pnl-hover"></g>`;
  s += `<rect x="${g.padL - 10}" y="0" width="${g.innerW + 20}" height="${g.H}" fill="transparent" data-role="pnl-hit"/>`;
  return s + '</svg>';
}

/** 提示框內容：某月各線的數字（高到低）→ [{name,color,dash,text}] */
export function tooltipRows(series, idx) {
  return series.map((s) => ({ s, p: s.points[idx] })).filter((x) => x.p && x.p.has)
    .sort((a, b) => b.p.value - a.p.value)
    .map((x) => ({ name: x.s.name, color: x.s.color, dash: x.s.dash, value: x.p.value, text: 'NT$ ' + fmtInt(x.p.value) + (x.p.note ? '（' + x.p.note + '）' : '') }));
}

/** 單店走勢 series（選定月份的點用上方同一份數字；估算／月中累計畫空心） */
export function buildStoreSeries(metric, trend, o) {
  // o: {id,name,color, month, headRow, estimated, nowMonth}
  return [{
    id: o.id, name: o.name, color: o.color, dash: '',
    points: (trend || []).map((r) => {
      const has = monthHasData(r, false);
      const isSel = r.month === o.month;
      const val = isSel && o.headRow ? metricValue(metric, o.headRow) : metricValue(metric, r);
      const partial = has && r.month === o.nowMonth && r.status !== '定稿';
      const est = isSel && !!o.estimated;
      return { value: val, has, hollow: est || partial, note: est ? '含估算' : partial ? '月中累計' : '' };
    })
  }];
}

/** 全部門市走勢 series */
export function buildMultiSeries(metric, multi, ids, nameOf, colors, hidden, nowMonth) {
  const out = [];
  ids.forEach((sid) => {
    if (hidden[sid]) return;
    out.push({
      id: sid, name: nameOf(sid), color: colors[sid].color, dash: colors[sid].dash,
      points: (multi.stores[sid] || []).map((r) => {
        const has = monthHasData(r, false);
        const partial = has && r.month === nowMonth && r.status !== '定稿';
        return { value: metricValue(metric, r), has, hollow: partial, note: partial ? '月中累計' : '' };
      })
    });
  });
  return out;
}

// ======== CSV 產生器（逐字移植自 ~/mala-pnl-auto/src/csv.js PnlCsv，規則同舊網站：UTF-8 BOM＋CRLF、injection 防護、金額 2 位小數、「是否估算」欄）========
var PNL_BLOCKS = ['營收', '食材', '包材', '人事', '可控', '不可控', '營業稅', '營業外收入'];

// Fable 對抗審查建議 3：原本只擋「開頭就是」危險字元，沒擋「前面有空白
// 再接危險字元」（例如 " =SUM(A1)"）——多數試算表軟體會先修剪掉儲存格
// 前導的空白再判斷是不是公式，" =SUM(...)" 還是會被當公式執行。改成：
// （可能有 0 個以上空白，JS 的 \s 本身就涵蓋全形空白 U+3000，不用另外
// 列一次）後面接 `= + - @ |` 之一；或者字串本身就是以 tab／CR 開頭（這
// 兩個字元本身就有控制意義，不管後面接什麼都要防）。`|` 是這輪追加的
// 字元（部分試算表版本的 DDE／管線語法用得到)。
var INJECTION_RE = /^\s*[=+\-@|]|^[\t\r]/;

function textCell(raw) {
  var s = raw === null || raw === undefined ? '' : String(raw);
  if (INJECTION_RE.test(s)) s = "'" + s;
  return s;
}

// polish-v14（ALL CSV 與畫面差 0.01 的根因）：原本用 n.toFixed(2)，它捨入的
// 是「二進位近似值」——1.005 實際存成 1.00499999…，toFixed 得 "1.00"；多店
// 合計時加總順序不同（店序、引擎內加總順序），尾差方向就不同，同一個十進
// 位上剛好 x.xx5 的金額會一邊印 .x2、一邊印 .x3。改成先把「元×10^d」對齊
// 到 1e-4（吸收浮點尾差，真實金額不會有 1/10000 分以下的有效位），再四捨
// 五入（遠離 0）。回傳整數（例如 d=2 就是「分」）；儀表板 fmtInt 也改用這
// 支先到分再到元，畫面與 CSV 同一套捨入。
function roundScaled(n, decimals) {
  var scale = Math.pow(10, decimals);
  var neg = n < 0;
  var c = Math.abs(n) * scale;
  c = Math.round(c * 1e4) / 1e4;
  var r = Math.round(c);
  return neg && r !== 0 ? -r : r;
}

// 金額／數量欄：一律不做 injection 防護（規則明訂「金額欄是數字，負數
// 不加」），非有限數字回傳空字串（沒有值可顯示，避免印出 "NaN"）。
// Fable 對抗審查建議 5：極小負數（捨入後為 0）一律印正零，不印「-0.00」。
function numCell(n, decimals) {
  decimals = decimals === undefined ? 2 : decimals;
  if (typeof n !== 'number' || !isFinite(n)) return '';
  var r = roundScaled(n, decimals);
  var neg = r < 0;
  var a = String(Math.abs(r));
  if (decimals <= 0) return (neg ? '-' : '') + a;
  while (a.length <= decimals) a = '0' + a;
  return (neg ? '-' : '') + a.slice(0, a.length - decimals) + '.' + a.slice(a.length - decimals);
}

// RFC 4180：欄位含逗號／雙引號／換行（\r 或 \n）就整格用雙引號包起來，
// 內部雙引號變成兩個雙引號。
function escapeCsvField(raw) {
  var s = raw === null || raw === undefined ? '' : String(raw);
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCsv(rows) {
  return rows.map(function (row) {
    return row.map(escapeCsvField).join(',');
  }).join('\r\n');
}

// Fable 對抗審查建議 7：位元組順序記號字元一律用 String.fromCharCode
// 加十六進位碼位（65279）產生，原始碼字串常值裡完全不出現那個字元本身
// 或任何形式的跳脫寫法——那個字元在大多數編輯器裡不會顯示任何東西、
// diff 也看不出差異，很容易被工具（格式化器、某些「移除不可見字元」的
// 腳本、甚至某些「貼上時正規化 Unicode」的編輯器）在不知情的情況下吃掉
// 或誤植；先前的版本就是這樣被意外貼進一個看不見的實體字元。用數字碼
// 位建字元，內容跟意圖在原始碼裡永遠是可見、可搜尋的 ASCII，不會再被
// 這類轉換動到。
function withBom(csv) {
  return String.fromCharCode(0xfeff) + csv;
}

// 檔名不合法字元（門市名理論上是管理者自己填的，但保守起見還是清一下，
// 避免存檔時被瀏覽器/作業系統擋掉或截斷）。Fable 對抗審查建議 6：也要清
// 掉 C0 控制字元（\x00-\x1f，例如換行/tab）——門市名雖然是管理者填的，
// 但理論上仍是「後端資料」，不該假設它乾淨到可以直接拼進檔名。
function sanitizeFilenamePart(s) {
  return String(s == null ? '' : s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
}

function csvFilename(prefix, storeLabel, month) {
  return prefix + '_' + sanitizeFilenamePart(storeLabel) + '_' + month + '.csv';
}

// ---- polish-v14：估算科目 → 來源文字（儀表板「科目明細」表與損益表 CSV
// 「是否估算」欄共用同一份判斷，兩邊才不會各算各的對不上）----------------
// result 上三種估算附加欄位（見 gas/api.js）：
//   - estimates {acc_id: 金額}：人事（basis 在 estimate_basis，單一物件）
//     ＋水電瓦斯／抽成固定費（basis 在 cost_estimate_basis[acc_id]）。
//   - block_estimates {區塊: basis}：食材／包材區塊層級調整，basis.acc_ids
//     是這次估算涵蓋的廠商月結類＋庫存科目；只標其中「本月仍待補」的科目
//     （已有真實值的科目列顯示的是真實數字，不能標估算）。
// 回傳 {acc_id: {source, sourceText, blockLevel}}；沒有估算回 {}。
var ESTIMATE_SOURCE_TEXT = {
  labor_clock: '估算（打卡工時）',
  ratio: '估算（歷史比例）',
  vendor_daily_avg: '估算（參考月日均）',
  utility_daily_avg: '估算（上月日均）',
  const_prorate: '估算（固定費攤提）'
};

function estimateSourceText(source) {
  return ESTIMATE_SOURCE_TEXT[source] || '估算';
}

function estimateInfoByAcc(result) {
  var out = {};
  if (!result || typeof result !== 'object') return out;
  var estimates = (result.estimates && typeof result.estimates === 'object') ? result.estimates : {};
  var costBasis = (result.cost_estimate_basis && typeof result.cost_estimate_basis === 'object') ? result.cost_estimate_basis : {};
  var laborBasis = (result.estimate_basis && typeof result.estimate_basis === 'object') ? result.estimate_basis : null;
  var pendingSet = {};
  var hasPendingList = Array.isArray(result.pending);
  (hasPendingList ? result.pending : []).forEach(function (id) { pendingSet[id] = true; });
  Object.keys(estimates).forEach(function (accId) {
    var basis = Object.prototype.hasOwnProperty.call(costBasis, accId) ? costBasis[accId] : laborBasis;
    var source = basis && basis.source ? String(basis.source) : '';
    // Fable 審查 #52 輕：科目本月已有真實值（不在待補）、估算是疊加上去的
    // （例如抽成公式科目的固定費攤提）→ overlay，儀表板徽章改「含估算」。
    var overlay = hasPendingList && !pendingSet[accId];
    out[accId] = { source: source, sourceText: estimateSourceText(source), blockLevel: false, overlay: overlay };
  });
  var blockEstimates = (result.block_estimates && typeof result.block_estimates === 'object') ? result.block_estimates : {};
  Object.keys(blockEstimates).forEach(function (block) {
    var basis = blockEstimates[block] || {};
    var source = basis.source ? String(basis.source) : 'vendor_daily_avg';
    (Array.isArray(basis.acc_ids) ? basis.acc_ids : []).forEach(function (accId) {
      if (!pendingSet[accId] || out[accId]) return;
      out[accId] = { source: source, sourceText: estimateSourceText(source), blockLevel: true, overlay: false };
    });
  });
  return out;
}

// ---- 「下載損益表 CSV」------------------------------------------------
// accounts：科目陣列（App.accounts，含 acc_id/block/name/mode/in_pnl/active/sort）。
// result：getMonth 回來的 result（單店或 ALL 合計皆可，形狀一致）。
// 每個「計入損益」的啟用科目一列：區塊、acc_id、科目、取值方式、金額（2 位小數）、
// 佔營收%；每個區塊後面加一列小計，最後加營業淨利／稅後淨利兩列。
// 這裡的金額全部來自後端 engine 已經算好的 result（不是逐筆明細原始
// 值），已經是乾淨的數字，所以不需要「金額格式錯」狀態欄——那是
// buildEntriesCsvRows（逐筆明細，資料可能本來就壞）才要處理的問題。
// T18b（daily-refresh，人事估算追加）：result.estimates（若有，見
// gas/api.js 的 apiGetMonth_／gas/laborEstimate.js）是 {acc_id: 估算金額}
// ——這些金額**不是**寫進明細的真實資料，只是儀表板／CSV 顯示用的推估值。
// 新增「是否估算」欄：科目本身金額來自 estimates 就標「是」，否則空白；
// 人事小計、營業淨利、稅後淨利只要牽涉到任何估算科目，也一併標「是」，
// 讓看報表的人一眼知道這幾個數字不是定案的真實數字。
// T18d（成本估算追加）：result.block_estimates（若有，見 gas/api.js
// attachCostEstimatesIfApplicable_／gas/costEstimate.js）是
// {區塊: {amount, basis}}——食材／包材整區塊被估算值取代時才會出現，跟
// result.estimates（逐科目）是兩種不同粒度的估算標記，這裡一併考慮，
// 「是否估算」欄與 hasAnyEstimate 才不會漏掉區塊層級的估算。
function buildPnlCsvRows(accounts, result) {
  var revenue = (result.blocks && typeof result.blocks['營收'] === 'number') ? result.blocks['營收'] : 0;
  var estimates = (result && result.estimates && typeof result.estimates === 'object') ? result.estimates : {};
  var blockEstimates = (result && result.block_estimates && typeof result.block_estimates === 'object') ? result.block_estimates : {};
  var estimateInfo = estimateInfoByAcc(result);
  var hasAnyEstimate = Object.keys(estimates).length > 0 || Object.keys(blockEstimates).length > 0;

  function pctText(amount) {
    if (typeof amount !== 'number' || !isFinite(amount) || revenue === 0) return '';
    return (Math.round((amount / revenue) * 1000) / 10).toFixed(1) + '%';
  }

  function sortAccounts(list) {
    return list.slice().sort(function (x, y) {
      var sx = typeof x.sort === 'number' ? x.sort : 0;
      var sy = typeof y.sort === 'number' ? y.sort : 0;
      if (sx !== sy) return sx - sy;
      return x.acc_id < y.acc_id ? -1 : (x.acc_id > y.acc_id ? 1 : 0);
    });
  }

  var rows = [['區塊', 'acc_id', '科目', '取值方式', '金額', '佔營收%', '是否估算']];

  PNL_BLOCKS.forEach(function (block) {
    var blockAccounts = sortAccounts((accounts || []).filter(function (a) {
      return a.active === true && a.in_pnl === true && a.block === block;
    }));
    var blockHasEstimate = false;
    blockAccounts.forEach(function (a) {
      var amountRaw = result.accounts ? result.accounts[a.acc_id] : undefined;
      var amount = typeof amountRaw === 'number' ? amountRaw : 0;
      var isEstimate = Object.prototype.hasOwnProperty.call(estimateInfo, a.acc_id);
      if (isEstimate) blockHasEstimate = true;
      rows.push([
        textCell(block), textCell(a.acc_id), textCell(a.name), textCell(a.mode),
        numCell(amount, 2), textCell(pctText(amount)), textCell(isEstimate ? '是' : '')
      ]);
    });
    var blockTotal = (result.blocks && typeof result.blocks[block] === 'number') ? result.blocks[block] : 0;
    if (Object.prototype.hasOwnProperty.call(blockEstimates, block)) blockHasEstimate = true;
    rows.push([textCell(block), '', textCell('小計'), '', numCell(blockTotal, 2), textCell(pctText(blockTotal)), textCell(blockHasEstimate ? '是' : '')]);
  });

  var op = typeof result.operating_profit === 'number' ? result.operating_profit : 0;
  var np = typeof result.net_profit === 'number' ? result.net_profit : 0;
  rows.push(['', '', textCell('營業淨利'), '', numCell(op, 2), textCell(pctText(op)), textCell(hasAnyEstimate ? '是' : '')]);
  rows.push(['', '', textCell('稅後淨利'), '', numCell(np, 2), textCell(pctText(np)), textCell(hasAnyEstimate ? '是' : '')]);

  return rows;
}

// ---- 明細 CSV：分攤月數／金額的容錯規則，跟 src/engine.js rawSum() 逐條
// 對齊（Fable 對抗審查必修 1）。這裡不 require engine.js，是照它的規格
// 獨立重寫一次（跟 e2e/verify.py 對 engine 的規則是同一種「各自獨立重寫
// 驗證」關係，不是互相抄），兩邊分開改才不會一起錯在同一個地方。 ----

// 對齊 engine.js 的 toFiniteOrNaN()：number 型別原樣回傳（可能仍是
// NaN／Infinity，呼叫端自己再用 isFinite 判斷）；非空字串轉數字；其餘
// （''、null、undefined、物件…）一律 NaN。
function toFiniteOrNaN(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

// 對齊 engine.js rawSum() 的分攤月數規則：缺漏（undefined/null/''）是
// 「契約預設值 1」，不是錯誤；否則要「轉成有限數字」且「是整數」且
// 「≥1」才採用，任何一項不符（非數字、小數、0、負數）都當 1（BAD_SPLIT，
// 金額本身沒有錯，只有分攤月數壞掉，不是整筆略過）。
function effectiveSplitMonths(raw) {
  if (raw === undefined || raw === null || raw === '') return 1;
  var n = toFiniteOrNaN(raw);
  return (isFinite(n) && Number.isInteger(n) && n >= 1) ? n : 1;
}

// 分攤月數是不是真的壞掉（BAD_SPLIT）——跟 effectiveSplitMonths() 用同一
// 套判斷，但這支只回答「原始值有沒有問題」，不回退成 1；缺漏
// （undefined/null/''）是契約預設值，不算壞。CSV 的「狀態」欄用這支決定
// 要不要標「分攤月數格式錯」，避免呼叫端各自重寫一次同樣的條件、兩邊
// 不小心兜出不一致的判斷。
function isBadSplitMonths(raw) {
  if (raw === undefined || raw === null || raw === '') return false;
  var n = toFiniteOrNaN(raw);
  return !(isFinite(n) && Number.isInteger(n) && n >= 1);
}

// ---- 「下載明細 CSV」--------------------------------------------------
// entries：後端 exportEntries 回來的原始明細（含作廢，不含附件URL）。
// opts.accountName(acc_id)／opts.storeName(store_id)：查名稱用的函式
// （前端已經有 App.accounts／storeNameMap，不用再從後端多要一次）。
// 認列金額＝金額 / 分攤月數（跟 engine 的 raw 合計用同一個除法規則）。
//
// Fable 對抗審查必修 2：金額欄位是從 Google 試算表逐格讀出來的原始值，
// 理論上可能是任何型別（人手動改壞儲存格、貼上公式結果字串…）。金額
// 不是有限數字時：「金額」「認列金額」兩欄留空（不印 0，0 是「金額本來
// 就是 0」的意思，跟「這筆資料本身壞掉、看不出金額」是兩件不同的事，
// 混在一起會誤導看報表的人）；另外新增一欄「狀態」標「金額格式錯」。
// 分攤月數壞掉（BAD_SPLIT）不影響金額本身能不能顯示——金額／認列金額
// 照樣算（分攤月數當 1），但「狀態」欄要標「分攤月數格式錯（已當 1）」，
// 讓看報表的人知道認列金額不是照原始分攤月數算出來的。兩種問題同時發生
// （金額也壞、分攤月數也壞）時，金額格式錯優先顯示——那種情況下認列
// 金額本來就算不出來，分攤月數壞不壞已經不是重點。
// 設計選擇（二選一，這裡選前者，理由如下）：
//   (a) 「狀態」獨立成一欄，只用來標資料品質問題；「作廢」維持原本
//       獨立的欄位（是／否）——採用這個做法。
//   (b) 把「作廢」跟資料品質問題合併成同一欄（例如同一欄裡可能出現
//       「作廢」或「金額格式錯」）。
// 選 (a) 的理由：「作廢」是使用者主動的動作（在系統裡按下作廢），
// 「金額格式錯」是資料本身的品質問題（可能是作廢的、也可能是還在生效
// 的明細），兩者語意不同、也不互斥（一筆明細可以「已作廢」又「金額格
// 式錯」）——合併成同一欄要嘛得犧牲其中一種狀態不顯示，要嘛要另外設計
// 一套「兩種狀態同時出現要怎麼拼字串」的規則，不如各自一欄清楚。之後
// 如果再新增別的資料品質例外（例如分攤月數也想標出來），也只要在同一
// 個「狀態」欄多加一種文字，不用再開新欄位。
function buildEntriesCsvRows(entries, opts) {
  opts = opts || {};
  var accountName = opts.accountName || function (id) { return id; };
  var storeName = opts.storeName || function (id) { return id; };
  // Fable 審查 #59 輕4：門市欄維持原名，品牌另起一欄（放最後，既有欄位順序不變）。
  var storeBrand = opts.storeBrand || function () { return ''; };

  var rows = [['門市', '月份', 'acc_id', '科目', '金額', '分攤月數', '認列金額', '來源', '備註', '建立者', '建立時間', '作廢', '狀態', '品牌']];

  (entries || []).forEach(function (e) {
    var amountRaw = toFiniteOrNaN(e.amount);
    var amountOk = isFinite(amountRaw);
    var splitMonths = effectiveSplitMonths(e.split_months);

    var amountCell = amountOk ? numCell(amountRaw, 2) : '';
    var recognizedCell = amountOk ? numCell(amountRaw / splitMonths, 2) : '';
    var statusText = !amountOk ? '金額格式錯' : (isBadSplitMonths(e.split_months) ? '分攤月數格式錯（已當 1）' : '');

    rows.push([
      textCell(storeName(e.store_id)), textCell(e.month), textCell(e.acc_id), textCell(accountName(e.acc_id)),
      amountCell, numCell(splitMonths, 0), recognizedCell,
      textCell(e.source), textCell(e.note), textCell(e.created_by), textCell(e.created_at),
      textCell(e.void === true ? '是' : '否'), textCell(statusText), textCell(storeBrand(e.store_id))
    ]);
  });

  return rows;
}


export { textCell, numCell, roundScaled, escapeCsvField, buildCsv, withBom, sanitizeFilenamePart, csvFilename, toFiniteOrNaN, effectiveSplitMonths, isBadSplitMonths, buildPnlCsvRows, estimateInfoByAcc, estimateSourceText, buildEntriesCsvRows, PNL_BLOCKS };
