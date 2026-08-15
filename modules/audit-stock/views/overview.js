/**
 * modules/audit-stock/views/overview.js — 月初盤點抽查・總覽畫面（T2-2）
 *
 * 正本規格：docs/spec.md §4.6（mount(el,ctx) 回傳 unmount）、§4.7（ctx 逐字元形狀）、
 * §4.10（ctx.ui／ctx.fmt 簽章；UI 一律用 platform/css/components.css 既有 class，
 * 不新增色碼、不內嵌樣式）。
 *
 * 來源：~/mala-audit/js/views/overview.js（204 行，window.Views.overview = {render}）。
 * DOM 結構與資料語意盡量原樣保留（既有 e2e 的選擇器才不會全部失效）：id
 * （overview-year／btn-start-audit／btn-mark-rest／rest-dialog／rest-store／
 * rest-month／rest-error／rest-confirm／rest-cancel）與舊版的結構性 class
 * （overview-toolbar／overview-actions／overview-grid-wrap／overview-grid／
 * grid-cell，含 data-store／data-month／data-clickable）都保留，但拿掉全部行內
 * style，改疊上 platform 既有的 .card／.table／.table-wrap／.btn／.tag／.field
 * 等 class 負責實際外觀——舊版本身就沒有這套元件可用，是這次搬遷才補上的。
 *
 * 資料一律經 audit-shared/api.js 的 getAll(ctx)／submit(ctx, action, payload)
 * 取得與送出（不自己呼叫 ctx.api），成功送出後 submit() 會自動 invalidate 快取。
 *
 * 角色判斷：舊版用 app.state.role === 'accountant' 決定要不要顯示「開始稽核」
 * 「標記輪休」兩個動作。舊系統只有 accountant／viewer 兩種角色，只有 accountant
 * 能寫入；新系統的權限碼對照（spec §4.2／§4.3）裡，也只有 accountant（與萬用字元
 * admin）持有 audit.write，其餘角色都沒有——與舊版行為等價，所以改用
 * ctx.can('audit.write') 判斷，而不是比對角色代號字串（角色代號本身不是 ctx 該給
 * 模組拿來做業務判斷的東西，spec §4.7 只保證 ctx.user.role 存在，沒保證角色清單
 * 不會再變動；can() 才是穩定的判斷介面）。
 */
'use strict';

import * as sharedApi from '../../audit-shared/api.js';

const YEARS = ['2026']; // 預留多年：之後只要加這個陣列（同舊版）

// 對照 modules/audit-shared/format.js 的 monthLabel()：純顯示用的靜態月份中文對照表，
// 不是業務邏輯，不值得為了這一個用途另外搭一層 UMD→ESM 轉接（那是後續任務要做的事）。
const MONTH_LABELS = {
  '01': '一月', '02': '二月', '03': '三月', '04': '四月',
  '05': '五月', '06': '六月', '07': '七月', '08': '八月',
  '09': '九月', '10': '十月', '11': '十一月', '12': '十二月'
};

function monthLabel(month) {
  const mm = String(month).split('-')[1];
  return MONTH_LABELS[mm] || mm;
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function monthCols() {
  const cols = [];
  for (let m = 1; m <= 12; m++) cols.push(pad2(m));
  return cols;
}

// ============================================================
// 小工具：DOM 建構（做法同 modules/users/views/list.js，模組自己一份，
// 平台層沒有輸出這個工具給模組用）
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

/** 顯示後端資料一律經 ctx.fmt.esc()（同 modules/users/views/list.js 的 textCell() 慣例）。 */
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
export function mountOverview(root, ctx) {
  let destroyed = false;
  let config = { stores: [] };
  let records = [];
  let recordMap = {}; // record_key -> record，renderGrid() 重建，buildGridCell() 讀
  let year = YEARS[0];
  const canWrite = ctx.can('audit.write');

  // ---- 骨架：年份工具列 ----
  const yearSelect = el('select', { id: 'overview-year', class: 'input' });
  YEARS.forEach((y) => yearSelect.appendChild(el('option', { value: y, text: y })));
  yearSelect.value = year;

  const toolbar = el('div', { class: 'overview-toolbar card-row' }, [
    el('label', { for: 'overview-year', class: 'field-label', text: '年份' }),
    yearSelect
  ]);

  // ---- 骨架：會計限定的動作列（開始稽核／標記輪休）----
  let startBtn = null;
  let markRestBtn = null;
  let actionsRow = null;
  if (canWrite) {
    startBtn = el('button', {
      type: 'button', id: 'btn-start-audit', class: 'btn btn-primary', text: '開始稽核'
    });
    markRestBtn = el('button', {
      type: 'button', id: 'btn-mark-rest', class: 'btn btn-secondary', text: '標記輪休'
    });
    actionsRow = el('div', { class: 'overview-actions card-row' }, [startBtn, markRestBtn]);
  }

  // ---- 骨架：抽查總覽表格 ----
  const theadEl = el('thead');
  const tbodyEl = el('tbody');
  const table = el('table', { class: 'table overview-grid' }, [theadEl, tbodyEl]);
  const tableWrap = el('div', { class: 'table-wrap overview-grid-wrap' }, [table]);

  const cardTitle = el('div', { class: 'card-title', text: '總覽' });
  const gridCard = el('div', { class: 'card' },
    [cardTitle, toolbar].concat(actionsRow ? [actionsRow] : []).concat([tableWrap]));

  // ---- 骨架：標記輪休表單（會計限定，預設隱藏；沿用舊版「行內卡片」而非浮層對話框）----
  let restDialogCard = null;
  let restStoreSelect = null;
  let restMonthSelect = null;
  let restErrorEl = null;
  let restConfirmBtn = null;
  let restCancelBtn = null;

  if (canWrite) {
    restStoreSelect = el('select', { id: 'rest-store', class: 'input' });
    restMonthSelect = el('select', { id: 'rest-month', class: 'input' });
    restErrorEl = el('p', { id: 'rest-error', class: 'field-hint', hidden: 'true' });
    restConfirmBtn = el('button', {
      type: 'button', id: 'rest-confirm', class: 'btn btn-primary', text: '確認'
    });
    restCancelBtn = el('button', {
      type: 'button', id: 'rest-cancel', class: 'btn btn-secondary', text: '取消'
    });

    restDialogCard = el('div', { id: 'rest-dialog', class: 'card', hidden: 'true' }, [
      el('div', { class: 'card-title', text: '標記輪休' }),
      el('div', { class: 'field' }, [
        el('label', { for: 'rest-store', class: 'field-label', text: '店別' }),
        restStoreSelect
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'rest-month', class: 'field-label', text: '月份' }),
        restMonthSelect
      ]),
      restErrorEl,
      el('div', { class: 'dialog-actions' }, [restCancelBtn, restConfirmBtn])
    ]);
  }

  root.appendChild(gridCard);
  if (restDialogCard) root.appendChild(restDialogCard);

  // ============================================================
  // 渲染
  // ============================================================

  function renderGrid() {
    const cols = monthCols();
    const stores = (config.stores || []).slice().sort((a, b) => a.order - b.order);
    recordMap = {};
    records.forEach((r) => { recordMap[r.record_key] = r; });

    while (theadEl.firstChild) theadEl.removeChild(theadEl.firstChild);
    const headCells = [el('th', { text: '店別' })].concat(
      cols.map((mm) => el('th', { text: Number(mm) + '月' }))
    );
    theadEl.appendChild(el('tr', {}, headCells));

    while (tbodyEl.firstChild) tbodyEl.removeChild(tbodyEl.firstChild);
    stores.forEach((store) => {
      const cells = cols.map((mm) => buildGridCell(store, mm));
      tbodyEl.appendChild(el('tr', {}, [escEl(ctx, 'th', {}, store.name)].concat(cells)));
    });

    if (canWrite) renderRestOptions(stores, cols);
  }

  function buildGridCell(store, mm) {
    const month = year + '-' + mm;
    const key = store.code + '_' + month;
    const rec = recordMap[key];

    const td = document.createElement('td');
    td.className = 'grid-cell';
    td.setAttribute('data-store', store.code);
    td.setAttribute('data-month', month);

    if (rec && rec.status === '已稽核') {
      td.setAttribute('data-clickable', '1');
      td.appendChild(escEl(ctx, 'span', { class: 'tag tag-ok' }, rec.correct_rate + '%'));
      td.addEventListener('click', () => {
        ctx.nav('report', { store: store.code, month });
      });
    } else if (rec && rec.status === '輪休') {
      td.textContent = '輪休';
    } else {
      td.textContent = '—';
    }
    return td;
  }

  function renderRestOptions(stores, cols) {
    while (restStoreSelect.firstChild) restStoreSelect.removeChild(restStoreSelect.firstChild);
    stores.forEach((s) => {
      restStoreSelect.appendChild(escEl(ctx, 'option', { value: s.code }, s.name));
    });

    while (restMonthSelect.firstChild) restMonthSelect.removeChild(restMonthSelect.firstChild);
    cols.forEach((mm) => {
      restMonthSelect.appendChild(el('option', { value: mm, text: monthLabel(year + '-' + mm) }));
    });
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
      renderGrid();
    } catch {
      if (!destroyed) ctx.ui.toast('發生錯誤，請稍後再試', 'danger');
    } finally {
      if (!destroyed) ctx.ui.loading(false);
    }
  }

  // ============================================================
  // 事件
  // ============================================================

  function onYearChange() {
    year = yearSelect.value;
    renderGrid();
  }
  yearSelect.addEventListener('change', onYearChange);

  function onStartAuditClick() {
    ctx.nav('fill');
  }

  function onMarkRestClick() {
    restErrorEl.hidden = true;
    restDialogCard.hidden = false;
  }

  function onRestCancelClick() {
    restDialogCard.hidden = true;
  }

  async function onRestConfirmClick() {
    const storeCode = restStoreSelect.value;
    const mm = restMonthSelect.value;
    const month = year + '-' + mm;
    restConfirmBtn.disabled = true;
    try {
      const res = await sharedApi.submit(ctx, 'markRest', { store: storeCode, month });
      if (destroyed) return;
      if (res && res.ok) {
        restDialogCard.hidden = true;
        await loadData();
      } else {
        restErrorEl.textContent = '標記輪休失敗，請重試';
        restErrorEl.hidden = false;
      }
    } finally {
      if (!destroyed) restConfirmBtn.disabled = false;
    }
  }

  if (canWrite) {
    startBtn.addEventListener('click', onStartAuditClick);
    markRestBtn.addEventListener('click', onMarkRestClick);
    restCancelBtn.addEventListener('click', onRestCancelClick);
    restConfirmBtn.addEventListener('click', onRestConfirmClick);
  }

  loadData();

  return function unmount() {
    destroyed = true;
    yearSelect.removeEventListener('change', onYearChange);
    if (canWrite) {
      startBtn.removeEventListener('click', onStartAuditClick);
      markRestBtn.removeEventListener('click', onMarkRestClick);
      restCancelBtn.removeEventListener('click', onRestCancelClick);
      restConfirmBtn.removeEventListener('click', onRestConfirmClick);
    }
    if (gridCard.parentNode) gridCard.parentNode.removeChild(gridCard);
    if (restDialogCard && restDialogCard.parentNode) restDialogCard.parentNode.removeChild(restDialogCard);
  };
}
