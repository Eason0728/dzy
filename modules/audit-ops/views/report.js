/**
 * modules/audit-ops/views/report.js — 營運稽核表・報告畫面（T2-5）
 *
 * 正本規格：docs/spec.md §4.6（mount(el,ctx) 回傳 unmount）、§4.7（ctx，含 params）、
 * §4.10（ctx.ui／ctx.fmt 簽章；UI 一律用 platform/css/components.css 既有 class，
 * 不新增色碼、不內嵌樣式）。
 *
 * 來源：~/mala-audit/js/views/opsreport.js（178 行，window.Views.opsreport = {render}）。
 * 單月報告，可列印／存 PDF；沿用月初盤點報告頁的 class 名（report-print-area／
 * report-table／report-controls／no-print），DOM 結構與 class 名盡量原樣保留（既有
 * e2e 的選擇器才不會失效）；改用 el()/escEl() 建構 DOM（做法同本模組 overview.js／
 * fill.js），拿掉行內樣式，改疊 platform 既有的 .card／.table／.table-wrap／.btn／
 * .tag 等 class（spec §4.10：不新增色碼、不內嵌樣式）。
 *
 * 資料一律經 audit-shared/api.js 的 getAll(ctx) 取得（不自己呼叫 ctx.api）；每次掛載
 * 都是全新的一次 loadData()，不像舊版用模組級 var state 跨 render() 記店／月——這裡
 * 改成用 ctx.params 帶入（同 index.js 每次換分頁都是全新 mount() 的架構，見 spec §4.6），
 * 使用者從總覽點格子過來（ctx.nav('report',{store,month})）一樣能落在正確的店／月。
 *
 * 沒有另外的權限判斷：舊版 opsreport.js 本身也沒有角色檢查，manifest.js 的 report 分頁
 * 本身就 requires:['audit.read']，一致交由平台層路由把關（同 overview.js 的做法）。
 *
 * 【狀態保留（Eason 2026-08-15 指示補，任務①）】index.js 呼叫本函式時會多傳一個第三參數
 * `moduleState`（{get(), set(patch)}，見 modules/audit-ops/index.js 檔頭說明）：掛載時若
 * moduleState 有值，優先於「猜一個預設值」（僅次於 ctx.params，那代表更明確的使用者意圖）；
 * 使用者改選店／月時寫回。獨立單元測試不帶第三參數時行為不變。
 */
'use strict';

import * as sharedApi from '../../audit-shared/api.js';
import { Format } from '../../audit-shared/umd-bridge.js';

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'hidden') node.hidden = true;
      else node.setAttribute(key, value);
    }
  }
  if (children) {
    for (const child of children) if (child) node.appendChild(child);
  }
  return node;
}

function escEl(ctx, tag, attrs, value) {
  const node = el(tag, attrs);
  node.innerHTML = ctx.fmt.esc(value);
  return node;
}

/** 讀取模組層狀態（moduleState 可能是 undefined，見檔頭「狀態保留」說明）。 */
function readModuleState(moduleState) {
  if (moduleState && typeof moduleState.get === 'function') return moduleState.get() || {};
  return {};
}
function writeModuleState(moduleState, patch) {
  if (moduleState && typeof moduleState.set === 'function') moduleState.set(patch);
}

/**
 * @param {HTMLElement} root 殼／index.js 給的掛載點
 * @param {object} ctx spec §4.7
 * @param {{get:function, set:function}} [moduleState] 模組層「目前選的店別／月份」（任務①，選填）
 * @returns {function} unmount
 */
export function mountReport(root, ctx, moduleState) {
  let destroyed = false;
  let config = { stores: [] };
  let opsData = { ops_records: [], ops_details: [] };

  const params = ctx.params || {};
  const carried = params.store && params.month ? {} : readModuleState(moduleState);
  let store = params.store || carried.store || '';
  let month = params.month || carried.month || '';

  /** 把目前有效的店別／月份同步回模組層狀態（任務①）；空字串不寫，避免覆蓋成空值。 */
  function syncModuleState() {
    if (store && month) writeModuleState(moduleState, { store, month });
  }

  const storeSelect = el('select', { id: 'opsreport-store', class: 'input' });
  const monthSelect = el('select', { id: 'opsreport-month', class: 'input' });
  const controlsCard = el('div', { class: 'card no-print report-controls' }, [
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'opsreport-store', text: '店別' }), storeSelect]),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'opsreport-month', text: '月份' }), monthSelect])
  ]);

  const bodyEl = el('div', { class: 'report-print-area report-month card' });
  const printBtn = el('button', { type: 'button', id: 'opsreport-print', class: 'btn btn-secondary no-print', text: '列印／存 PDF' });
  const titleEl = el('div', { class: 'card-title no-print', text: '營運稽核報告' });

  root.appendChild(titleEl);
  root.appendChild(controlsCard);
  root.appendChild(bodyEl);
  root.appendChild(printBtn);

  // ============================================================
  // 小工具
  // ============================================================

  function storeList() {
    return (config.stores || []).slice().sort((a, b) => a.order - b.order);
  }
  function storeName(code) {
    const hit = storeList().filter((s) => s.code === code)[0];
    return hit ? hit.name : code;
  }
  function findRecord() {
    const key = store + '_' + month;
    return (opsData.ops_records || []).filter((r) => r.record_key === key)[0] || null;
  }
  function findDetails(recordKey) {
    return (opsData.ops_details || []).filter((d) => d.record_key === recordKey);
  }

  // ============================================================
  // 渲染：店／月選單
  // ============================================================

  function renderControls() {
    while (storeSelect.firstChild) storeSelect.removeChild(storeSelect.firstChild);
    storeList().forEach((s) => {
      storeSelect.appendChild(escEl(ctx, 'option', { value: s.code }, s.name));
    });
    storeSelect.value = store;

    while (monthSelect.firstChild) monthSelect.removeChild(monthSelect.firstChild);
    const year = String(month).split('-')[0];
    for (let m = 1; m <= 12; m++) {
      const full = year + '-' + pad2(m);
      monthSelect.appendChild(el('option', { value: full, text: Format.monthLabel(full) }));
    }
    monthSelect.value = month;
  }

  // ============================================================
  // 渲染：報告本體
  // ============================================================

  function renderBody() {
    while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
    const record = findRecord();

    const headTitle = escEl(ctx, 'h3', {}, storeName(store) + ' ' + Format.monthLabel(month) + ' 營運稽核報告');
    bodyEl.appendChild(el('div', { class: 'report-header' }, [headTitle]));

    if (!record) {
      bodyEl.appendChild(el('p', { class: 'report-empty field-hint', text: '無稽核紀錄' }));
      return;
    }
    if (record.status === '輪休') {
      bodyEl.appendChild(el('p', { class: 'report-rest field-hint', text: '本月輪休' }));
      return;
    }

    bodyEl.appendChild(escEl(ctx, 'p', { class: 'report-meta field-hint' },
      '稽核日期：' + (record.audit_date || '') + '　稽核人員：' + (record.auditor || '')));
    bodyEl.appendChild(escEl(ctx, 'div', { class: 'report-rate tag tag-ok' }, '合格率 ' + record.pass_rate + '%'));

    // 統計用橫排 chip 不用表格：手機 390px 塞十格表格會把「細項總數」擠成一行一個字（同舊版註解）。
    bodyEl.appendChild(el('div', { class: 'ops-stats card-row' }, [
      el('span', { class: 'tag' }, [el('span', { text: '細項 ' }), escEl(ctx, 'b', {}, String(record.total_count))]),
      el('span', { class: 'tag tag-ok' }, [el('span', { text: '合格 ' }), escEl(ctx, 'b', {}, String(record.pass_count))]),
      el('span', { class: 'tag tag-danger' }, [el('span', { text: '未完成 ' }), escEl(ctx, 'b', {}, String(record.fail_count))]),
      el('span', { class: 'tag' }, [el('span', { text: '未檢查 ' }), escEl(ctx, 'b', {}, String(record.pending_count))]),
      el('span', { class: 'tag tag-warn' }, [el('span', { text: '追蹤 ' }), escEl(ctx, 'b', {}, String(record.track_count))])
    ]));

    const details = findDetails(record.record_key);

    // 未完成清單擺最前面：主管翻報告要看的是「哪裡沒過、要改什麼」（同舊版）。
    const fails = details.filter((d) => d.verdict === '未完成');
    bodyEl.appendChild(el('h4', { text: '未完成項目（' + fails.length + '）' }));
    if (!fails.length) {
      bodyEl.appendChild(el('p', { class: 'report-empty-note field-hint', text: '全部合格' }));
    } else {
      const thead = el('thead', {}, [el('tr', {}, [
        el('th', { text: '分類' }), el('th', { text: '檢查項目' }), el('th', { text: '說明' }), el('th', { text: '追蹤' })
      ])]);
      const tbody = el('tbody');
      fails.forEach((d) => {
        tbody.appendChild(el('tr', {}, [
          escEl(ctx, 'td', { class: 'report-group-cell' }, d.group),
          escEl(ctx, 'td', {}, d.text),
          escEl(ctx, 'td', {}, d.note || ''),
          el('td', { text: d.track ? '★' : '' })
        ]));
      });
      bodyEl.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'table report-table report-ops-fail' }, [thead, tbody])
      ]));
    }

    // 全部項目：用「群組小標列」分段，不要每列都重複一個窄窄的分類欄
    // ——390px 手機上那一欄會被擠成一行一個字（同舊版註解）。
    bodyEl.appendChild(el('h4', { text: '全部檢查項目' }));
    if (!details.length) {
      bodyEl.appendChild(el('p', { class: 'report-empty-note field-hint', text: '無明細' }));
    } else {
      const thead2 = el('thead', {}, [el('tr', {}, [
        el('th', { text: '檢查項目' }), el('th', { text: '判定' }), el('th', { text: '說明' })
      ])]);
      const tbody2 = el('tbody');
      let lastGroup = null;
      details.forEach((d) => {
        if (d.group !== lastGroup) {
          tbody2.appendChild(el('tr', { class: 'report-group-row' }, [
            escEl(ctx, 'th', { colspan: '3' }, d.cat + '｜' + d.group)
          ]));
          lastGroup = d.group;
        }
        tbody2.appendChild(el('tr', {}, [
          escEl(ctx, 'td', {}, d.text),
          escEl(ctx, 'td', { class: 'report-verdict-cell' }, d.verdict + (d.track ? ' ★' : '')),
          escEl(ctx, 'td', {}, d.note || '')
        ]));
      });
      bodyEl.appendChild(el('div', { class: 'table-wrap' }, [
        el('table', { class: 'table report-table report-ops-all' }, [thead2, tbody2])
      ]));
    }
  }

  function renderAll() {
    renderControls();
    renderBody();
  }

  // ============================================================
  // 事件
  // ============================================================

  function onStoreChange() {
    store = storeSelect.value;
    syncModuleState();
    renderAll();
  }
  function onMonthChange() {
    month = monthSelect.value;
    syncModuleState();
    renderBody();
  }
  storeSelect.addEventListener('change', onStoreChange);
  monthSelect.addEventListener('change', onMonthChange);

  function onPrintClick() {
    if (typeof window !== 'undefined' && typeof window.print === 'function') window.print();
  }
  printBtn.addEventListener('click', onPrintClick);

  // ============================================================
  // 初始化
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
      opsData = {
        ops_records: (res.data && res.data.ops_records) || [],
        ops_details: (res.data && res.data.ops_details) || []
      };

      const stores = storeList();
      if (!store || !stores.some((s) => s.code === store)) store = (stores[0] && stores[0].code) || '';
      if (!month) {
        const now = new Date();
        month = String(now.getFullYear()) + '-' + pad2(now.getMonth() + 1);
      }
      syncModuleState();

      renderAll();
    } catch (e) {
      if (!destroyed) ctx.ui.toast('發生錯誤，請稍後再試', 'danger');
    } finally {
      if (!destroyed) ctx.ui.loading(false);
    }
  }

  loadData();

  return function unmount() {
    destroyed = true;
    storeSelect.removeEventListener('change', onStoreChange);
    monthSelect.removeEventListener('change', onMonthChange);
    printBtn.removeEventListener('click', onPrintClick);
    [titleEl, controlsCard, bodyEl, printBtn].forEach((n) => {
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
  };
}
