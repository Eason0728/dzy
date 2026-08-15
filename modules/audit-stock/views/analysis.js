/**
 * modules/audit-stock/views/analysis.js — 月初盤點抽查・異常分析畫面（T2-4 第二段）
 *
 * 正本規格：docs/spec.md §4.6（mount(el,ctx) 回傳 unmount）、§4.7（ctx 逐字元形狀，
 * 含 viewId／params）、§4.10（ctx.ui／ctx.fmt 簽章；UI 一律用 platform/css/components.css
 * 既有 class，不新增色碼、不內嵌樣式）。
 *
 * 來源：~/mala-audit/js/views/analysis.js（214 行，window.Views.analysis = {render(el, app)}，
 * 契約只用 app.state／app.navigate／app.reload；analysis.js 實際上完全沒呼叫
 * navigate／reload，是純讀畫面）。三張表：(a) 累犯品項排行 (b) 異常原因分類統計
 * (c) 各店異常數，都可用起訖月份區間篩選。
 *
 * DOM 結構與 class 名盡量原樣保留（既有 e2e 的選擇器才不會失效，對照
 * ~/mala-audit/test/e2e_t7.py 逐條核對過）：id（an-from／an-to／an-repeat／an-reasons／
 * an-stores，這三個容器 id 是 e2e 直接拿來找 `{id} table` 的，必須保留）、
 * class（an-table／an-range／an-empty／an-muted）都保留。
 *
 * 拿掉的東西：舊版每列後面有一格用行內 style="width:N%" 畫的裝飾用長條圖
 * （.an-bar／.an-barcell，靠 <style> 內嵌 var(--color-primary) 上色）。spec §4.10
 * 明講「不得自行內嵌樣式或新增色碼」，這個視覺化本質上是資料驅動的動態寬度，沒有
 * 平台既有 class 能做到（platform/css/components.css 沒有對應的長條/進度條元件，
 * 這次任務範圍也不含新增 platform CSS）。核對過 e2e_t7.py：它用
 * `tr.querySelectorAll('td')` 逐欄比對，取用到的都是前幾欄（品項/次數/店別月份、
 * 原因/次數、店名/異常數/次數/異常率），從沒用到長條圖那一欄，所以拿掉它不影響任何
 * 既有判讀或既有 e2e 斷言——這點也記在下面「與舊版差異」。
 *
 * 資料一律經 audit-shared/api.js 的 getAll(ctx) 取得（不自己呼叫 ctx.api）；這兩支畫面
 * 唯讀，不送出任何資料，不必用到 submit()。
 *
 * 格式化一律用 ctx.fmt.esc()（透過下面的 escEl() 小工具，同 overview.js／fill.js／
 * report.js 慣例）與 umd-bridge 的 Format.monthLabel()。
 *
 * 與舊版行為差異：
 * 1. 拿掉三張表最後一欄純裝飾用的長條圖視覺化（見上方說明），數字本身（次數／
 *    異常率）原樣保留在前面幾欄，排序邏輯完全不變——同一批資料排出來的名次、
 *    同樣的判讀結論不受影響。
 * 2. 新架構下每次切進這個分頁都是全新掛載（見 index.js 的 teardown+remount），使用者
 *    上次選的起訖區間不會像舊版那樣跨「切到別分頁又切回來」保留，每次重新掛載都是
 *    「不限」。
 */
'use strict';

import * as sharedApi from '../../audit-shared/api.js';
import { Format } from '../../audit-shared/umd-bridge.js';

// ============================================================
// 小工具：DOM 建構（做法同 overview.js／fill.js／report.js，模組自己一份）
// ============================================================

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
  }
  if (children) {
    for (const child of children) if (child) node.appendChild(child);
  }
  return node;
}

/** 顯示後端資料一律經 ctx.fmt.esc()（同 overview.js／fill.js／report.js 的 escEl() 慣例）。 */
function escEl(ctx, tag, attrs, value) {
  const node = el(tag, attrs);
  node.innerHTML = ctx.fmt.esc(value);
  return node;
}

/**
 * @param {HTMLElement} root 殼／index.js 給的掛載點
 * @param {object} ctx spec §4.7
 * @returns {function} unmount
 */
export function mountAnalysis(root, ctx) {
  let destroyed = false;

  // ---- 資料狀態 ----
  let config = { stores: [] };
  let records = [];
  let details = [];

  // ---- 畫面狀態：'YYYY-MM' 區間（含端點）；null＝不限（同舊版 state） ----
  let from = null;
  let to = null;

  // ============================================================
  // 衍生資料（同舊版同名函式，逐字元照抄邏輯，只是分母改讀 config/records/details）
  // ============================================================

  function storeList() {
    return (config.stores || []).slice().sort((a, b) => a.order - b.order);
  }

  function storeName(code) {
    const found = storeList().filter((s) => s.code === code)[0];
    return found ? found.name : (code || '');
  }

  // 所有出現過的年月（由明細＋紀錄取聯集，升冪）
  function monthOptions() {
    const set = {};
    records.forEach((r) => { if (r.month) set[r.month] = true; });
    details.forEach((d) => { if (d.month) set[d.month] = true; });
    return Object.keys(set).sort();
  }

  function inRange(month) {
    if (from && month < from) return false;
    if (to && month > to) return false;
    return true;
  }

  // 只取判定＝異常的明細
  function anomalyDetails() {
    return details.filter((d) => d.verdict === '異常' && inRange(d.month));
  }

  // ---- (a) 累犯品項排行 ----
  function repeatOffenders() {
    const map = {};
    anomalyDetails().forEach((d) => {
      const key = d.item;
      if (!map[key]) map[key] = { item: d.item, count: 0, stores: {}, months: [] };
      map[key].count += 1;
      map[key].stores[d.store] = true;
      map[key].months.push(d.month);
    });
    return Object.keys(map).map((k) => {
      const row = map[k];
      row.storeCodes = Object.keys(row.stores);
      row.months.sort();
      return row;
    }).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.item < b.item ? -1 : 1;
    });
  }

  // ---- (b) 原因分類統計 ----
  function reasonStats() {
    const map = {};
    anomalyDetails().forEach((d) => {
      const r = d.reason || '（未填）';
      map[r] = (map[r] || 0) + 1;
    });
    return Object.keys(map).map((k) => ({ reason: k, count: map[k] }))
      .sort((a, b) => b.count - a.count);
  }

  // ---- (c) 各店異常數（含稽核次數與異常率，看得出比例）----
  function storeStats() {
    const detailsList = anomalyDetails();
    const auditedRecords = records.filter((r) => r.status === '已稽核' && inRange(r.month));
    return storeList().map((s) => {
      const mine = auditedRecords.filter((r) => r.store === s.code);
      const anomalies = detailsList.filter((d) => d.store === s.code).length;
      const sampled = mine.reduce((sum, r) => sum + (Number(r.sample_count) || 0), 0);
      return {
        code: s.code,
        name: s.name,
        anomalies,
        audits: mine.length,
        // 異常率＝異常項數 / 抽查總項數（各店累積稽核抽了幾項）；抽查總項數為 0 時
        // （這家店這段期間沒有任何一次已完成的稽核）固定回 0，不做除以零。
        rate: sampled ? Math.round((anomalies / sampled) * 100) : 0
      };
    }).sort((a, b) => b.anomalies - a.anomalies);
  }

  // ============================================================
  // 骨架
  // ============================================================

  const heading = el('h2', { text: '異常分析' });

  const fromSelect = el('select', { id: 'an-from', class: 'input' });
  const toSelect = el('select', { id: 'an-to', class: 'input' });
  function onFromChange() {
    from = fromSelect.value || null;
    // 起訖顛倒時，剛動的那一欄說了算、另一欄讓位跟上（同舊版；不做「兩欄對調」，
    // 那會把使用者剛選的值悄悄改成別的月份）。
    if (from && to && from > to) { to = from; }
    renderAll();
  }
  function onToChange() {
    to = toSelect.value || null;
    if (from && to && from > to) { from = to; }
    renderAll();
  }
  fromSelect.addEventListener('change', onFromChange);
  toSelect.addEventListener('change', onToChange);
  const rangeCard = el('div', { class: 'card an-range card-row' }, [
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'an-from', text: '起' }), fromSelect]),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'an-to', text: '迄' }), toSelect])
  ]);

  const repeatBody = el('div', { id: 'an-repeat' });
  const repeatCard = el('div', { class: 'card' }, [el('div', { class: 'card-title', text: '累犯品項排行' }), repeatBody]);

  const reasonsBody = el('div', { id: 'an-reasons' });
  const reasonsCard = el('div', { class: 'card' }, [el('div', { class: 'card-title', text: '異常原因分類' }), reasonsBody]);

  const storesBody = el('div', { id: 'an-stores' });
  const storesCard = el('div', { class: 'card' }, [el('div', { class: 'card-title', text: '各店異常數' }), storesBody]);

  root.appendChild(heading);
  root.appendChild(rangeCard);
  root.appendChild(repeatCard);
  root.appendChild(reasonsCard);
  root.appendChild(storesCard);

  // ============================================================
  // 渲染：起訖選單（選項來源：monthOptions()，同舊版每次 render 都重算一次）
  // ============================================================

  function renderRangeOptions() {
    const months = monthOptions();
    // 選過的值若已不在可選清單裡（理論上不會發生，資料只增不減；防禦性同舊版邏輯）
    if (from && months.indexOf(from) === -1) from = null;
    if (to && months.indexOf(to) === -1) to = null;

    [fromSelect, toSelect].forEach((sel, idx) => {
      const current = idx === 0 ? from : to;
      while (sel.firstChild) sel.removeChild(sel.firstChild);
      sel.appendChild(el('option', { value: '', text: '不限' }));
      months.forEach((m) => sel.appendChild(el('option', { value: m, text: m + '（' + Format.monthLabel(m) + '）' })));
      sel.value = current || '';
    });
  }

  // ============================================================
  // 渲染：(a) 累犯品項排行
  // ============================================================

  function buildRepeatTable() {
    const rows = repeatOffenders();
    if (!rows.length) return el('p', { class: 'an-empty field-hint', text: '此區間沒有異常紀錄。' });

    const bodyRows = rows.map((r) => {
      const storesTxt = r.storeCodes.map((c) => storeName(c)).join('、');
      return el('tr', {}, [
        escEl(ctx, 'td', {}, r.item),
        el('td', { class: 'num', text: String(r.count) }),
        el('td', {}, [
          escEl(ctx, 'span', {}, storesTxt),
          el('br'),
          escEl(ctx, 'span', { class: 'an-muted' }, r.months.join('、'))
        ])
      ]);
    });
    return el('div', { class: 'table-wrap' }, [
      el('table', { class: 'table an-table' }, [
        el('thead', {}, [el('tr', {}, ['品項', '異常次數', '出現店別／月份'].map((t, i) =>
          el('th', { class: i === 1 ? 'num' : undefined, text: t })))]),
        el('tbody', {}, bodyRows)
      ])
    ]);
  }

  // ============================================================
  // 渲染：(b) 異常原因分類統計
  // ============================================================

  function buildReasonsTable() {
    const rows = reasonStats();
    if (!rows.length) return el('p', { class: 'an-empty field-hint', text: '此區間沒有異常紀錄。' });

    const bodyRows = rows.map((r) => el('tr', {}, [
      escEl(ctx, 'td', {}, r.reason),
      el('td', { class: 'num', text: String(r.count) })
    ]));
    return el('div', { class: 'table-wrap' }, [
      el('table', { class: 'table an-table' }, [
        el('thead', {}, [el('tr', {}, [el('th', { text: '異常原因' }), el('th', { class: 'num', text: '次數' })])]),
        el('tbody', {}, bodyRows)
      ])
    ]);
  }

  // ============================================================
  // 渲染：(c) 各店異常數
  // ============================================================

  function buildStoresTable() {
    const rows = storeStats();
    const bodyRows = rows.map((r) => el('tr', {}, [
      escEl(ctx, 'td', {}, r.name),
      el('td', { class: 'num', text: String(r.anomalies) }),
      el('td', { class: 'num', text: String(r.audits) }),
      el('td', { class: 'num', text: r.rate + '%' })
    ]));
    return el('div', { class: 'table-wrap' }, [
      el('table', { class: 'table an-table' }, [
        el('thead', {}, [el('tr', {}, ['門市', '異常項數', '稽核次數', '異常率'].map((t) =>
          el('th', { class: 'num', text: t })))]),
        el('tbody', {}, bodyRows)
      ])
    ]);
  }

  function renderAll() {
    renderRangeOptions();

    while (repeatBody.firstChild) repeatBody.removeChild(repeatBody.firstChild);
    repeatBody.appendChild(buildRepeatTable());

    while (reasonsBody.firstChild) reasonsBody.removeChild(reasonsBody.firstChild);
    reasonsBody.appendChild(buildReasonsTable());

    while (storesBody.firstChild) storesBody.removeChild(storesBody.firstChild);
    storesBody.appendChild(buildStoresTable());
  }

  // ============================================================
  // 資料載入
  // ============================================================

  async function loadData() {
    ctx.ui.loading(true);
    try {
      const res = await sharedApi.getAll(ctx);
      if (destroyed) return;
      if (!res || res.ok !== true) {
        ctx.ui.toast((res && res.error) || '發生錯誤，請稍後再試', 'danger');
        return;
      }
      config = (res.data && res.data.config) || { stores: [] };
      records = (res.data && res.data.records) || [];
      details = (res.data && res.data.details) || [];
      renderAll();
    } catch {
      if (!destroyed) ctx.ui.toast('發生錯誤，請稍後再試', 'danger');
    } finally {
      if (!destroyed) ctx.ui.loading(false);
    }
  }

  loadData();

  return function unmount() {
    destroyed = true;
    fromSelect.removeEventListener('change', onFromChange);
    toSelect.removeEventListener('change', onToChange);
    [heading, rangeCard, repeatCard, reasonsCard, storesCard].forEach((n) => {
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
  };
}
