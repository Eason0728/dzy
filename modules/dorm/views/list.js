/**
 * modules/dorm/views/list.js — 宿舍合約・合約清單畫面（T3-2）
 *
 * 正本規格：docs/spec.md §4.6（mount(el,ctx) 回傳 unmount）、§4.7（ctx 逐字元形狀）、
 * §4.10（ctx.ui／ctx.fmt 簽章；UI 一律用 platform/css/components.css 既有 class，
 * 不新增色碼、不內嵌樣式）。
 *
 * 來源：/Users/guoeason/mala-dorm-contract/admin.html（283 行，「合約一覽」表格，
 * 唯讀不准改）。欄位與狀態呈現照它現況：編號／姓名／房間床位／租金／本期（含 30 日內
 * 到期提示）／期別／狀態（含終止旗標）／簽署。動作欄只做「終止合約」這一項——
 * 「複製連結」「刪除待簽合約」屬於建單流程、「開點交單」是點交流程，manifest.js 的
 * create／handover 分頁由另一支平行任務實作，本檔不做，避免碰到還沒定義好的介面。
 *
 * 資料一律經 ../api.js 的 listContracts(ctx) 取得（已完成、已驗收，42 項測試，
 * 讀取一律走它，本檔不自己組 payload 呼叫 ctx.api.call('dorm','list',...)）。
 *
 * 「終止合約」是本檔唯一的寫入動作。api.js 明講本身只有三個讀取類 action（rooms／
 * list／contract），沒有 terminate——這是刻意的（api.js 的檔頭：T3-1 任務範圍只做
 * 讀取層），所以這裡比照 modules/users/views/list.js 的 callBackend() 慣例，直接呼叫
 * ctx.api.call('dorm', 'terminate', { contract_id })，不因此去改 api.js（不在允許修改
 * 的檔案清單裡）。後端這個 action 是 toggle（見
 * mala-dorm-contract/apps-script/Renewal.gs 的 markTerminate()：已標記就取消、
 * 沒標記就標記），對照舊版 admin.html 的 toggleTerminate()。
 *
 * 【與舊版行為差異：新增二次確認】
 * 舊版 admin.html 的 toggleTerminate() 完全沒有確認步驟，按下「標記終止／取消終止」
 * 立刻打後端。這是任務指示明講要修正的地方——終止合約（含取消終止標記，兩者都會
 * 改變這份法律文件的狀態）是不可逆／高影響動作，改成先跳 ctx.ui.confirm()，使用者
 * 按「取消」則完全不呼叫後端（見 test/dorm-list.test.mjs 的對應測試）。
 *
 * 【權限】終止按鈕只有 ctx.can('dorm.write') 為真才畫出來；只有 dorm.read 的唯讀者
 * （spec §4.2：dorm.read＝看合約清單、dorm.write＝建單、發連結、點交、終止）完全看不到
 * 這顆按鈕，不是畫出來但 disabled——避免「看得到按不動」的困惑，也避免唯讀者被引導去
 * 嘗試一個一定會被後端擋下的動作。
 */
'use strict';

import { listContracts } from '../api.js';

// ============================================================
// 小工具：DOM 建構（模組自己一份，做法同 modules/users/views/list.js／audit-stock 各分頁）
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

/** 顯示後端資料一律經 ctx.fmt.esc()（同其餘分頁的 escEl()／textCell() 慣例）。 */
function escEl(ctx, tag, attrs, value) {
  const node = el(tag, attrs);
  node.innerHTML = ctx.fmt.esc(value);
  return node;
}

function findAncestorWithAttr(startEl, attrName) {
  let node = startEl;
  while (node && typeof node.getAttribute === 'function') {
    const v = node.getAttribute(attrName);
    if (v !== null && v !== undefined) return node;
    node = node.parentNode;
  }
  return null;
}

// ============================================================
// 純函式：欄位呈現（同 admin.html 現況）
// ============================================================

/** 狀態→標籤 class。已退宿沒有對應的變體色（admin.html 用灰色中性樣式），
 *  用不帶變體的 .tag（見 platform/css/components.css）維持中性外觀，不新增色碼。 */
function statusTagClass(status) {
  if (status === '在住') return 'tag tag-ok';
  if (status === '待簽') return 'tag tag-warn';
  return 'tag';
}

/** 期別顯示：'不定期...' 開頭顯示「不定期（月租）」，否則「第 N 期」（同 admin.html）。 */
function termNoLabel(termNo) {
  const s = termNo === undefined || termNo === null ? '' : String(termNo);
  if (!s) return '';
  return s.indexOf('不定期') === 0 ? '不定期（月租）' : '第 ' + s + ' 期';
}

/** 房間／床位顯示：優先用後端算好的 room_bed_display，沒有就自己組（同 admin.html）。 */
function roomBedLabel(c) {
  if (c.room_bed_display) return c.room_bed_display;
  return [c.room, c.bed].filter((v) => v).join(' ');
}

/** 是否「30 日內到期」：狀態在住、term_end 是合法字串、落在今天～30 天後之間（含）。 */
function isDueSoon(c, todayStr, cutoffStr) {
  return !!c && c.status === '在住' &&
    typeof c.term_end === 'string' &&
    c.term_end >= todayStr && c.term_end <= cutoffStr;
}

// ============================================================
// 掛載
// ============================================================

const HEADERS = ['編號', '姓名', '房間/床位', '租金', '本期', '期別', '狀態', '簽署', '操作'];

/**
 * @param {HTMLElement} root 殼／index.js 給的掛載點
 * @param {object} ctx spec §4.7
 * @returns {function} unmount
 */
export function mountList(root, ctx) {
  let destroyed = false;
  let contracts = [];
  const canWrite = ctx.can('dorm.write');

  const cardTitle = el('div', { class: 'card-title', text: '合約一覽' });

  const theadEl = el('thead', {}, [el('tr', {}, HEADERS.map((h) => el('th', { text: h })))]);
  const tbodyEl = el('tbody', { 'data-role': 'rows' });
  const table = el('table', { class: 'table dorm-list-table' }, [theadEl, tbodyEl]);
  const tableWrap = el('div', { class: 'table-wrap' }, [table]);

  const emptyEl = el('p', {
    class: 'dorm-list-empty field-hint',
    hidden: 'true',
    text: '目前沒有合約資料'
  });

  const card = el('div', { class: 'card' }, [cardTitle, tableWrap, emptyEl]);
  root.appendChild(card);

  // ------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------

  function buildDueCell(c, todayStr, cutoffStr) {
    const td = document.createElement('td');
    td.appendChild(escEl(ctx, 'span', {}, ctx.fmt.date(c.term_start)));
    td.appendChild(el('span', { text: ' ～ ' }));
    td.appendChild(escEl(ctx, 'span', {}, ctx.fmt.date(c.term_end)));
    if (isDueSoon(c, todayStr, cutoffStr)) {
      td.appendChild(el('span', { class: 'tag tag-warn dorm-due-soon', text: '30 日內到期' }));
    }
    return td;
  }

  function buildStatusCell(c) {
    const td = document.createElement('td');
    td.appendChild(escEl(ctx, 'span', { class: statusTagClass(c.status) }, c.status));
    if (c.terminate_flag) {
      td.appendChild(escEl(ctx, 'div', { class: 'field-hint' }, c.terminate_flag));
    }
    return td;
  }

  function buildActionCell(c) {
    const td = document.createElement('td');
    if (canWrite && c.status === '在住') {
      const label = c.terminate_flag ? '取消終止' : '標記終止';
      td.appendChild(el('button', {
        type: 'button',
        class: 'btn btn-danger',
        'data-action': 'toggle-terminate',
        'data-id': c.contract_id,
        text: label
      }));
    }
    return td;
  }

  function buildRow(c, todayStr, cutoffStr) {
    const tr = el('tr', { 'data-role': 'contract-row', 'data-id': c.contract_id });
    tr.appendChild(escEl(ctx, 'td', {}, c.contract_id));
    tr.appendChild(escEl(ctx, 'td', {}, c.name));
    tr.appendChild(escEl(ctx, 'td', {}, roomBedLabel(c)));
    tr.appendChild(escEl(ctx, 'td', {}, ctx.fmt.money(c.rent)));
    tr.appendChild(buildDueCell(c, todayStr, cutoffStr));
    tr.appendChild(escEl(ctx, 'td', {}, termNoLabel(c.term_no)));
    tr.appendChild(buildStatusCell(c));
    tr.appendChild(escEl(ctx, 'td', {}, ctx.fmt.date(c.signed_at)));
    tr.appendChild(buildActionCell(c));
    return tr;
  }

  function renderRows() {
    while (tbodyEl.firstChild) tbodyEl.removeChild(tbodyEl.firstChild);

    if (!contracts.length) {
      tableWrap.hidden = true;
      emptyEl.hidden = false;
      return;
    }

    tableWrap.hidden = false;
    emptyEl.hidden = true;

    const todayStr = ctx.fmt.date(new Date());
    const cutoffStr = ctx.fmt.date(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
    contracts.forEach((c) => {
      if (c) tbodyEl.appendChild(buildRow(c, todayStr, cutoffStr));
    });
  }

  // ------------------------------------------------------------
  // 資料載入
  // ------------------------------------------------------------

  async function loadData() {
    ctx.ui.loading(true);
    try {
      const res = await listContracts(ctx);
      if (destroyed) return;
      if (!res || res.ok !== true) {
        ctx.ui.toast((res && res.error) || '發生錯誤，請稍後再試', 'danger');
        return; // 保留畫面上原本的資料，不因這次刷新失敗清空既有清單
      }
      contracts = res.data.contracts;
      renderRows();
    } catch {
      if (!destroyed) ctx.ui.toast('發生錯誤，請稍後再試', 'danger');
    } finally {
      if (!destroyed) ctx.ui.loading(false);
    }
  }

  // ------------------------------------------------------------
  // 終止合約（唯一的寫入動作；見檔頭「與舊版行為差異」）
  // ------------------------------------------------------------

  async function onToggleTerminate(c) {
    const msg = c.terminate_flag
      ? `確定要取消「${c.name}」的終止標記嗎？`
      : `確定要標記終止「${c.name}」的合約嗎？此動作會通知同仁合約即將終止。`;
    const confirmed = await ctx.ui.confirm(msg);
    if (!confirmed) return; // 取消：完全不呼叫後端

    ctx.ui.loading(true);
    try {
      const res = await ctx.api.call('dorm', 'terminate', { contract_id: c.contract_id });
      if (destroyed) return;
      if (!res || res.ok !== true) {
        ctx.ui.toast((res && res.error) || '發生錯誤，請稍後再試', 'danger');
        return;
      }
      ctx.ui.toast('已更新', 'ok');
      await loadData();
    } catch {
      if (!destroyed) ctx.ui.toast('發生錯誤，請稍後再試', 'danger');
    } finally {
      if (!destroyed) ctx.ui.loading(false);
    }
  }

  function onRowClick(e) {
    const btn = findAncestorWithAttr(e.target, 'data-action');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');
    const c = contracts.find((x) => x && String(x.contract_id) === String(id));
    if (!c) return;
    if (action === 'toggle-terminate') onToggleTerminate(c);
  }

  tbodyEl.addEventListener('click', onRowClick);

  // 初始畫一次空清單的狀態（避免資料回來前畫面完全空白，同 audit-stock 各分頁習慣）
  renderRows();
  loadData();

  return function unmount() {
    destroyed = true;
    tbodyEl.removeEventListener('click', onRowClick);
    if (card.parentNode) card.parentNode.removeChild(card);
  };
}
