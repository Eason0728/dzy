/**
 * modules/audit-stock/views/report.js — 月初盤點抽查・報告畫面（T2-4 第一段）
 *
 * 正本規格：docs/spec.md §4.6（mount(el,ctx) 回傳 unmount）、§4.7（ctx 逐字元形狀，
 * 含 viewId／params）、§4.10（ctx.ui／ctx.fmt 簽章；UI 一律用 platform/css/components.css
 * 既有 class，不新增色碼、不內嵌樣式）。
 *
 * 來源：~/mala-audit/js/views/report.js（331 行，window.Views.report = {render(el, app)}，
 * 契約只用 app.state／app.navigate／app.reload；report.js 實際上完全沒呼叫 navigate／reload，
 * 是純讀畫面）。單月報告／年度總表切換；列印走 window.print()。
 *
 * DOM 結構與 class 名盡量原樣保留（既有 e2e 的選擇器才不會失效，對照
 * ~/mala-audit/test/e2e_t6.py 逐條核對過）：id（report-store-select／report-month-select／
 * report-annual-store-select／report-print-btn）與結構性 class（report-controls／
 * report-print-area／report-month／report-annual／report-header／report-meta／report-rate／
 * report-empty／report-rest／report-table／report-detail-table／report-vault／
 * report-vault-table／report-anomaly／report-note／report-empty-note／anomaly-lines／
 * anomaly-line／report-annual-table／mode-toggle／mode-btn／no-print）都保留；舊版樣式
 * 在 mala-audit 自己的 css/base.css（這裡沒有搬過來，任務範圍只有這兩支 view），改疊
 * platform 既有的 .card／.table／.table-wrap／.btn／.tag／.field 等 class 負責實際外觀
 * （同 overview.js／fill.js 的做法）。
 *
 * 資料一律經 audit-shared/api.js 的 getAll(ctx) 取得（不自己呼叫 ctx.api）；這兩支畫面
 * 唯讀，不送出任何資料，不必用到 submit()。
 *
 * 格式化一律用 ctx.fmt.esc()（透過下面的 escEl() 小工具，同 overview.js／fill.js 慣例：
 * 顯示後端資料才經 escEl，畫面上寫死的中文標籤用 el() 的 text 屬性即可，不必多繞一層）
 * 與 umd-bridge 的 Format.monthLabel()。
 *
 * 與舊版行為差異（沒有就不必列，這裡列出的都是刻意的取捨，見任務回報「與舊版差異」）：
 * 1. 舊版「預設店別」除了 localStorage『audit_last_store』，還會先看 root.AuditState.store
 *    （同一個瀏覽器分頁、同一次 session 內、稽核填寫頁選過的店，即使還沒真的送出也記得）。
 *    新架構沒有這種跨分頁模組共用的記憶體全域物件，改用 fill.js 本來就會寫入的
 *    localStorage『audit_last_store』（FillSubmit.loadLastStore()，同一把 key）——
 *    差別只在「這次 session 選過但還沒送出」這種情況，舊版記得住、新版記不住。
 * 2. 拿掉舊版列印按鈕的行內 style="margin-top:8px"（spec §4.10 不得內嵌樣式）；改用
 *    platform 既有的 .btn class 版面，視覺上少了那 8px 間距，不影響功能與內容。
 * 3. 新架構下每次切進這個分頁都是全新掛載（見 index.js 的 teardown+remount），使用者上次
 *    選的模式／店別／月份不會像舊版那樣跨「切到別分頁又切回來」保留；每次以 ctx.params
 *    （若有 store+month，同舊版視為「從總覽點格子進來」強制切到單月模式）或預設值重新算。
 */
'use strict';

import * as sharedApi from '../../audit-shared/api.js';
import { Format } from '../../audit-shared/umd-bridge.js';
import { loadLastStore } from './fill-submit.js';

// ============================================================
// 小工具：DOM 建構（做法同 overview.js／fill.js，模組自己一份）
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

/** 顯示後端資料一律經 ctx.fmt.esc()（同 overview.js／fill.js 的 escEl() 慣例）。 */
function escEl(ctx, tag, attrs, value) {
  const node = el(tag, attrs);
  node.innerHTML = ctx.fmt.esc(value);
  return node;
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

const MODE_MONTH = 'month';
const MODE_ANNUAL = 'annual';

/**
 * @param {HTMLElement} root 殼／index.js 給的掛載點
 * @param {object} ctx spec §4.7
 * @returns {function} unmount
 */
export function mountReport(root, ctx) {
  let destroyed = false;

  // ---- 資料狀態 ----
  let config = { stores: [] };
  let records = [];
  let details = [];

  // ---- 畫面狀態 ----
  let mode = MODE_MONTH;
  let store = null;
  let month = null;
  let annualStore = null;
  const params = ctx.params || {};

  // ============================================================
  // 衍生資料（同舊版同名函式，逐字元照抄邏輯）
  // ============================================================

  function getYear() {
    if (params.month) return String(params.month).slice(0, 4);
    if (records.length) {
      const years = records.map((r) => String(r.month).slice(0, 4)).sort();
      return years[years.length - 1];
    }
    return String(new Date().getFullYear());
  }

  function storeList() {
    return (config.stores || []).slice().sort((a, b) => a.order - b.order);
  }

  function storeName(code) {
    const found = storeList().filter((s) => s.code === code)[0];
    return found ? found.name : (code || '');
  }

  function findRecord(st, mo) {
    const matches = records.filter((r) => r.store === st && r.month === mo);
    return matches.length ? matches[0] : null;
  }

  function findDetails(recordKey) {
    return details.filter((d) => d.record_key === recordKey);
  }

  // 預設店別：見檔頭「與舊版行為差異」第 1 點。
  function defaultStore() {
    const codes = storeList().map((s) => s.code);
    const saved = loadLastStore();
    if (saved && codes.indexOf(saved) !== -1) return saved;
    return codes[0] || null;
  }

  // 預設月份：看的年份是今年 → 當月；是別的年份 → 該年一月（同舊版）
  function defaultMonth() {
    const year = getYear();
    const now = new Date();
    if (String(now.getFullYear()) === String(year)) {
      return year + '-' + pad2(now.getMonth() + 1);
    }
    return year + '-01';
  }

  // 依 ctx.params 初始化選擇；params 帶 store+month 視為「從總覽點格子進來」，強制切到單月模式
  // （同舊版 initFromParams()；新架構每次進這個分頁都是全新掛載，不需要舊版 lastParamsKey
  // 那組「這次 render 跟上次是不是同一組 params」的比對，見檔頭差異第 3 點）。
  function applyParams() {
    if (params.store && params.month) {
      mode = MODE_MONTH;
      store = params.store;
      month = params.month;
      annualStore = params.store;
    }
    if (!store) store = defaultStore();
    if (!annualStore) annualStore = store;
    if (!month) month = defaultMonth();
  }

  // ---- 換行轉「列」：保留原本的自動編號文字，逐行各自一個區塊 ----
  function anomalyLinesEl(text) {
    if (!text) return el('p', { class: 'report-empty-note field-hint', text: '無異常' });
    const lines = String(text).split('\n').filter((l) => l.length > 0);
    return el('div', { class: 'anomaly-lines' },
      lines.map((line) => escEl(ctx, 'div', { class: 'anomaly-line' }, line)));
  }

  // ============================================================
  // 骨架（固定不變的節點只建一次；內容隨狀態變動局部重建）
  // ============================================================

  const heading = el('h2', { text: '報告' });

  const monthModeBtn = el('button', { type: 'button', class: 'btn mode-btn', 'data-mode': MODE_MONTH, text: '單月報告' });
  const annualModeBtn = el('button', { type: 'button', class: 'btn mode-btn', 'data-mode': MODE_ANNUAL, text: '年度總表' });
  function onMonthModeClick() { mode = MODE_MONTH; renderAll(); }
  function onAnnualModeClick() { mode = MODE_ANNUAL; renderAll(); }
  monthModeBtn.addEventListener('click', onMonthModeClick);
  annualModeBtn.addEventListener('click', onAnnualModeClick);
  const modeToggle = el('div', { class: 'mode-toggle card-row no-print' }, [monthModeBtn, annualModeBtn]);

  const controlsEl = el('div');
  const reportEl = el('div');

  function onPrintClick() {
    // 非瀏覽器環境（node 測試）沒有 window，一律當作沒有列印功能，不拋例外
    // （spec §4.10 的一貫規則：非法／不存在的輸入絕不拋例外）。
    if (typeof window !== 'undefined' && typeof window.print === 'function') window.print();
  }
  const printBtn = el('button', { type: 'button', id: 'report-print-btn', class: 'btn btn-secondary no-print', text: '列印／存 PDF' });
  printBtn.addEventListener('click', onPrintClick);

  root.appendChild(heading);
  root.appendChild(modeToggle);
  root.appendChild(controlsEl);
  root.appendChild(reportEl);
  root.appendChild(printBtn);

  // ============================================================
  // 渲染：模式切換鈕
  // ============================================================

  function renderModeButtons() {
    [monthModeBtn, annualModeBtn].forEach((btn) => {
      const active = btn.getAttribute('data-mode') === mode;
      btn.className = 'btn ' + (active ? 'btn-primary' : 'btn-secondary') + ' mode-btn' + (active ? ' active' : '');
    });
  }

  // ============================================================
  // 渲染：控制列（依模式切換內容）
  // ============================================================

  function buildMonthControls() {
    const storeSelect = el('select', { id: 'report-store-select', class: 'input' });
    storeList().forEach((s) => storeSelect.appendChild(escEl(ctx, 'option', { value: s.code }, s.name)));
    storeSelect.value = store;
    storeSelect.addEventListener('change', () => {
      store = storeSelect.value;
      renderReport();
    });

    const year = getYear();
    const monthSelect = el('select', { id: 'report-month-select', class: 'input' });
    for (let m = 1; m <= 12; m++) {
      const full = year + '-' + pad2(m);
      monthSelect.appendChild(el('option', { value: full, text: Format.monthLabel(full) }));
    }
    monthSelect.value = month;
    monthSelect.addEventListener('change', () => {
      month = monthSelect.value;
      renderReport();
    });

    return el('div', { class: 'report-controls card-row no-print' }, [
      el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'report-store-select', text: '店別' }), storeSelect]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'report-month-select', text: '月份' }), monthSelect])
    ]);
  }

  function buildAnnualControls() {
    const sel = el('select', { id: 'report-annual-store-select', class: 'input' });
    storeList().forEach((s) => sel.appendChild(escEl(ctx, 'option', { value: s.code }, s.name)));
    sel.value = annualStore;
    sel.addEventListener('change', () => {
      annualStore = sel.value;
      renderReport();
    });

    return el('div', { class: 'report-controls card-row no-print' }, [
      el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'report-annual-store-select', text: '店別' }), sel])
    ]);
  }

  function renderControls() {
    while (controlsEl.firstChild) controlsEl.removeChild(controlsEl.firstChild);
    controlsEl.appendChild(mode === MODE_ANNUAL ? buildAnnualControls() : buildMonthControls());
  }

  // ============================================================
  // 渲染：單月報告
  // ============================================================

  function buildDetailRow(d) {
    return el('tr', {}, [
      escEl(ctx, 'td', {}, d.item),
      escEl(ctx, 'td', {}, d.unit),
      escEl(ctx, 'td', {}, d.book_qty),
      escEl(ctx, 'td', {}, d.recount_qty),
      escEl(ctx, 'td', {}, d.verdict),
      escEl(ctx, 'td', {}, d.reason || '')
    ]);
  }

  function buildMonthReport() {
    const displayName = storeName(store);
    const monthLbl = Format.monthLabel(month);
    const record = findRecord(store, month);

    const head = el('div', { class: 'report-header' }, [
      el('h3', {}, [escEl(ctx, 'span', {}, displayName), el('span', { text: ' ' + monthLbl + ' 稽核報告' })])
    ]);
    const wrap = el('div', { class: 'report-print-area report-month card' }, [head]);

    if (!record) {
      head.appendChild(el('p', { class: 'report-empty field-hint', text: '無稽核紀錄' }));
      return wrap;
    }

    if (record.status === '輪休') {
      head.appendChild(el('p', { class: 'report-meta field-hint', text: '登記日期：' + (record.audit_date || '') }));
      head.appendChild(el('p', { class: 'report-rest', text: '本月輪休' }));
      return wrap;
    }

    head.appendChild(el('p', { class: 'report-meta field-hint', text: '稽核日期：' + (record.audit_date || '') }));
    head.appendChild(el('div', { class: 'report-rate' }, [
      el('span', { text: '正確率 ' }),
      escEl(ctx, 'span', { class: 'tag tag-ok' }, record.correct_rate + '%')
    ]));

    const detailList = findDetails(record.record_key);
    const detailBody = el('tbody', {},
      detailList.length
        ? detailList.map(buildDetailRow)
        : [el('tr', {}, [el('td', { colspan: '6', text: '無抽查明細' })])]);
    const detailTable = el('table', { class: 'table report-table report-detail-table' }, [
      el('thead', {}, [el('tr', {}, ['品項', '單位', '盤點數', '複盤數', '判定', '異常原因'].map((t) => el('th', { text: t })))]),
      detailBody
    ]);
    wrap.appendChild(el('h4', { text: '抽查明細' }));
    wrap.appendChild(el('div', { class: 'table-wrap' }, [detailTable]));

    const vaultTable = el('table', { class: 'table report-table report-vault-table' }, [
      el('tbody', {}, [
        el('tr', {}, [
          el('th', { text: '零找金' }), escEl(ctx, 'td', {}, record.change_fund),
          el('th', { text: '零用金' }), escEl(ctx, 'td', {}, record.petty_cash)
        ]),
        el('tr', {}, [
          el('th', { text: '小費金額' }), escEl(ctx, 'td', {}, record.tip_amount),
          el('th', { text: '小費相符' }), escEl(ctx, 'td', {}, record.tip_match)
        ])
      ])
    ]);
    wrap.appendChild(el('div', { class: 'report-vault' }, [
      el('h4', { text: '金庫抽查' }),
      el('div', { class: 'table-wrap' }, [vaultTable])
    ]));

    wrap.appendChild(el('div', { class: 'report-anomaly' }, [
      el('h4', { text: '複盤異常說明' }),
      anomalyLinesEl(record.anomaly_text)
    ]));

    wrap.appendChild(el('div', { class: 'report-note' }, [
      el('h4', { text: '備註' }),
      record.note ? escEl(ctx, 'p', {}, record.note) : el('p', { text: '（無）' })
    ]));

    return wrap;
  }

  // ============================================================
  // 渲染：年度總表（重現既有 sheet 分頁樣式）
  // ============================================================

  function buildAnnualRow(st, year, m) {
    const monthStr = year + '-' + pad2(m);
    const label = Format.monthLabel(monthStr);
    const record = findRecord(st, monthStr);

    const labelCell = el('td', { text: label });
    if (!record) {
      return el('tr', {}, [labelCell, el('td'), el('td'), el('td'), el('td'), el('td'), el('td'), el('td'), el('td')]);
    }
    if (record.status === '輪休') {
      return el('tr', {}, [labelCell, el('td'), el('td', { text: '輪休' }), el('td'), el('td'), el('td'), el('td'), el('td'), el('td')]);
    }
    return el('tr', {}, [
      labelCell,
      escEl(ctx, 'td', {}, record.sample_count),
      escEl(ctx, 'td', {}, record.correct_count),
      escEl(ctx, 'td', {}, record.correct_rate + '%'),
      escEl(ctx, 'td', {}, record.change_fund),
      escEl(ctx, 'td', {}, record.petty_cash),
      escEl(ctx, 'td', {}, record.tip_match),
      escEl(ctx, 'td', {}, record.tip_amount),
      el('td', { class: 'report-anomaly-cell' }, [record.anomaly_text ? anomalyLinesEl(record.anomaly_text) : null])
    ]);
  }

  function buildAnnualReport() {
    const year = getYear();
    const displayName = storeName(annualStore);

    const rows = [];
    for (let m = 1; m <= 12; m++) rows.push(buildAnnualRow(annualStore, year, m));

    const table = el('table', { class: 'table report-table report-annual-table' }, [
      el('thead', {}, [el('tr', {}, [
        '月份', '盤點抽查數量', '複盤正確數量', '正確率', '零找金', '零用金', '小費是否正確', '小費金額', '複盤異常說明'
      ].map((t) => el('th', { text: t })))]),
      el('tbody', {}, rows)
    ]);

    return el('div', { class: 'report-print-area report-annual card' }, [
      el('h3', {}, [escEl(ctx, 'span', {}, displayName), el('span', { text: ' ' + year + ' 年度總表' })]),
      el('div', { class: 'table-wrap' }, [table])
    ]);
  }

  function renderReport() {
    while (reportEl.firstChild) reportEl.removeChild(reportEl.firstChild);
    reportEl.appendChild(mode === MODE_ANNUAL ? buildAnnualReport() : buildMonthReport());
  }

  function renderAll() {
    renderModeButtons();
    renderControls();
    renderReport();
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
      applyParams();
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
    monthModeBtn.removeEventListener('click', onMonthModeClick);
    annualModeBtn.removeEventListener('click', onAnnualModeClick);
    printBtn.removeEventListener('click', onPrintClick);
    [heading, modeToggle, controlsEl, reportEl, printBtn].forEach((n) => {
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
  };
}
