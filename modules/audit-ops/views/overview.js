/**
 * modules/audit-ops/views/overview.js — 營運稽核表・總覽畫面（T2-5）
 *
 * 正本規格：docs/spec.md §4.6（mount(el,ctx) 回傳 unmount）、§4.7（ctx 逐字元形狀）、
 * §4.10（ctx.ui／ctx.fmt 簽章；UI 一律用 platform/css/components.css 既有 class，
 * 不新增色碼、不內嵌樣式）。
 *
 * 來源：~/mala-audit/js/views/opsoverview.js（144 行，window.Views.opsoverview = {render}）。
 * 版面刻意跟月初盤點的總覽（js/views/overview.js）長一樣（原檔檔頭註解就是這麼寫的），
 * 這裡沿用 modules/audit-stock/views/overview.js（T2-2 已驗收的範本）同一套 DOM 建構
 * 手法與 class 疊法：拿掉全部行內 style，改疊 platform 既有的 .card／.table／
 * .table-wrap／.btn／.tag／.field 等 class；結構性 id／class（overview-toolbar／
 * overview-actions／overview-grid-wrap／overview-grid／grid-cell，含
 * data-store／data-month／data-clickable）原樣保留。
 *
 * 與 audit-stock/views/overview.js 的差異只在資料語意：這裡讀 ops_records（不是
 * records）、格子數字是 rec.pass_rate（不是 correct_rate），而且原版 opsoverview.js
 * 本來就沒有「標記輪休」——只有「開始稽核」一顆動作鈕，所以這裡不搬 audit-stock 那組
 * 輪休對話框。
 *
 * 角色判斷：舊版用 app.state.role === 'accountant' 決定要不要顯示「開始稽核」鈕。
 * 新系統改用 ctx.can('audit.write')，理由同 audit-stock/views/overview.js 的檔頭說明
 * （can() 才是穩定的判斷介面，角色代號不是模組該拿來做業務判斷的東西）。
 *
 * 資料一律經 audit-shared/api.js 的 getAll(ctx) 取得（不自己呼叫 ctx.api）。
 */
'use strict';

import * as sharedApi from '../../audit-shared/api.js';
import { OpsChecklist } from '../../audit-shared/umd-bridge.js';

const YEARS = ['2026']; // 與 audit-stock/views/overview.js 同步：之後要加年份，兩檔一起加

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function monthCols() {
  const cols = [];
  for (let m = 1; m <= 12; m++) cols.push(pad2(m));
  return cols;
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      // hidden 走 IDL 屬性（同 audit-stock/views/fill.js 的 el() 慣例），因為畫面其餘地方
      // 一律用 `.hidden = true/false` 這個屬性切換顯示，不是走 attribute——兩邊要用同一套。
      else if (key === 'hidden') node.hidden = true;
      else node.setAttribute(key, value);
    }
  }
  if (children) {
    for (const child of children) if (child) node.appendChild(child);
  }
  return node;
}

/** 顯示後端資料一律經 ctx.fmt.esc()（同 audit-stock/views/overview.js 的 escEl() 慣例）。 */
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
  let recordMap = {}; // record_key -> ops_record，renderGrid() 重建，buildGridCell() 讀
  let year = YEARS[0];
  const canWrite = ctx.can('audit.write');

  // ---- 骨架：年份工具列 ----
  const yearSelect = el('select', { id: 'ops-overview-year', class: 'input' });
  YEARS.forEach((y) => yearSelect.appendChild(el('option', { value: y, text: y })));
  yearSelect.value = year;

  const toolbar = el('div', { class: 'overview-toolbar card-row' }, [
    el('label', { for: 'ops-overview-year', class: 'field-label', text: '年份' }),
    yearSelect
  ]);

  // ---- 骨架：會計限定的動作列（開始稽核；同舊版，沒有標記輪休）----
  let startBtn = null;
  let actionsRow = null;
  if (canWrite) {
    startBtn = el('button', {
      type: 'button', id: 'btn-start-ops', class: 'btn btn-primary', text: '開始稽核'
    });
    actionsRow = el('div', { class: 'overview-actions card-row' }, [startBtn]);
  }

  // ---- 骨架：總覽表格 ----
  const theadEl = el('thead');
  const tbodyEl = el('tbody');
  const table = el('table', { class: 'table overview-grid' }, [theadEl, tbodyEl]);
  const tableWrap = el('div', { class: 'table-wrap overview-grid-wrap' }, [table]);

  const noteEl = el('p', {
    class: 'field-hint',
    text: '格子數字＝合格率（合格數 ÷ ' + OpsChecklist.total + ' 項）。點已稽核的格子看該月報告。'
  });

  const cardTitle = el('div', { class: 'card-title', text: '總覽' });
  const gridCard = el('div', { class: 'card' },
    [cardTitle, toolbar].concat(actionsRow ? [actionsRow] : []).concat([tableWrap, noteEl]));

  root.appendChild(gridCard);

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
      td.appendChild(escEl(ctx, 'span', { class: 'tag tag-ok' }, rec.pass_rate + '%'));
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
      records = (res.data && res.data.ops_records) || [];
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

  function onStartOpsClick() {
    ctx.nav('fill');
  }
  if (canWrite) startBtn.addEventListener('click', onStartOpsClick);

  loadData();

  return function unmount() {
    destroyed = true;
    yearSelect.removeEventListener('change', onYearChange);
    if (canWrite) startBtn.removeEventListener('click', onStartOpsClick);
    if (gridCard.parentNode) gridCard.parentNode.removeChild(gridCard);
  };
}
