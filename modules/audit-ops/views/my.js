/**
 * modules/audit-ops/views/my.js — 營運稽核表・我的門市（T2-6，requirements F10 唯一新增功能）
 *
 * 正本規格：docs/spec.md §4.6（mount(el,ctx) 回傳 unmount）、§4.7（ctx 逐字元形狀）、
 * §4.10（ctx.ui／ctx.fmt 簽章；UI 一律用 platform/css/components.css 既有 class，不新增
 * 色碼、不內嵌樣式）、§7（店長節點裁切——**平台層已經做掉了**，本檔不得再裁一次）。
 * requirements.md §3（角色）、F10（店長視角要看什麼：自己節點的合格率、被抓到的問題、
 * 未完成追蹤清單，唯讀）。
 *
 * 做法逐字元照抄 modules/audit-stock/views/my.js（任務①、②已驗收的範本），資料語意換成
 * 營運稽核表：讀 ops_records（不是 records）、格子數字是 pass_rate（不是 correct_rate）。
 *
 * 【資料裁切】同 audit-stock/views/my.js 檔頭說明：ops_records／ops_details 經
 * platform/api.js 的 maybeFilterOwnNode_() 已經裁到只剩自己節點，本檔不得再用
 * ctx.user.node 篩一次——ctx.user.node 只用來標示「這是哪一家店」與判斷本頁能不能顯示。
 *
 * 【唯讀】同 audit-stock/views/my.js：不建立任何 button／input／select／textarea／a，
 * 不掛任何寫入類事件監聽器。
 *
 * 【三個區塊怎麼從資料算出來】
 * 「合格率」＝自己節點最新一筆（依 month 字串排序）「已稽核」紀錄的 pass_rate；若最新一筆
 * 是「輪休」顯示「本月輪休」；完全沒有紀錄顯示「尚無稽核紀錄」（同 audit-stock 的處理）。
 * 「被抓到的問題」＝該筆紀錄裡 verdict==='未完成' 的明細（note 當說明）——這是營運稽核表
 * 唯一的「未通過」判定，逐字元對照 modules/audit-ops/views/fill-submit.js 的 verdict 語意。
 * 「未完成追蹤清單」＝該筆紀錄裡 track===true 的明細——營運稽核表本來就有這個獨立於
 * verdict 的「追蹤」旗標（同仁現場可以把任何一項標記追蹤，不限於未完成的項目），這裡直接
 * 對應，跟「被抓到的問題」是兩份可能重疊、但語意不同的清單（一個是「這次沒過」、一個是
 * 「請持續留意」）——與 audit-stock 那邊沒有獨立旗標、只能借用同一份異常清單的情況不同，
 * 見 audit-stock/views/my.js 檔頭「與舊版差異」說明。
 */
'use strict';

import * as sharedApi from '../../audit-shared/api.js';

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

/** 顯示後端資料一律經 ctx.fmt.esc()（同其餘分頁的 escEl() 慣例）。 */
function escEl(ctx, tag, attrs, value) {
  const node = el(tag, attrs);
  node.innerHTML = ctx.fmt.esc(value);
  return node;
}

/** 依 month 字串（YYYY-MM）挑最新一筆紀錄；沒有紀錄回 null。 */
function pickLatestRecord(records) {
  if (!records || !records.length) return null;
  return records.slice().sort((a, b) => (a.month < b.month ? 1 : (a.month > b.month ? -1 : 0)))[0];
}

/**
 * @param {HTMLElement} root 殼／index.js 給的掛載點
 * @param {object} ctx spec §4.7
 * @returns {function} unmount
 */
export function mountMy(root, ctx) {
  let destroyed = false;
  const node = ctx.user && ctx.user.node;

  const storeLabelEl = el('p', { id: 'my-store-label', class: 'field-hint' });
  const headerCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title', text: '我的門市' }),
    storeLabelEl
  ]);

  const rateEl = el('div', { id: 'my-rate' });
  const rateCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title', text: '本月合格率' }),
    rateEl
  ]);

  const issuesListEl = el('ul', { id: 'my-issues-list' });
  const issuesCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title', text: '被抓到的問題' }),
    issuesListEl
  ]);

  const trackListEl = el('ul', { id: 'my-track-list' });
  const trackCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title', text: '未完成追蹤清單' }),
    el('p', { class: 'field-hint', text: '這些項目被標記需要持續留意，尚未取消追蹤。' }),
    trackListEl
  ]);

  // 歷史紀錄（2026-08-17 新增，Eason 指示「要有查詢歷史紀錄」）。做法同 audit-stock 的
  // my.js：**純表格、零控制項**——本檔的唯讀保證與 test/audit-ops.test.mjs
  // 「店長視角不得有任何 button/input/select/textarea」那條斷言都要繼續成立。
  // 資料本來就在手上（平台層已裁到只剩自己店），不必再打一次後端。
  const historyBodyEl = el('tbody', { id: 'my-history-body' });
  const historyCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title', text: '歷史紀錄' }),
    el('p', { class: 'field-hint', text: '這家店歷次營運稽核的結果，最新的在最上面。' }),
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'table', id: 'my-history-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: '月份' }),
            el('th', { text: '狀態' }),
            el('th', { text: '合格率' }),
            el('th', { text: '未完成項目' })
          ])
        ]),
        historyBodyEl
      ])
    ])
  ]);

  root.appendChild(headerCard);
  root.appendChild(rateCard);
  root.appendChild(issuesCard);
  root.appendChild(trackCard);
  root.appendChild(historyCard);

  function renderEmptyState(message) {
    storeLabelEl.textContent = node ? ('目前登入節點：' + node) : '未設定所屬節點，無法判斷要看哪一家店。';
    rateEl.textContent = message;
    while (issuesListEl.firstChild) issuesListEl.removeChild(issuesListEl.firstChild);
    while (trackListEl.firstChild) trackListEl.removeChild(trackListEl.firstChild);
    issuesListEl.appendChild(el('li', { class: 'field-hint', text: message }));
    trackListEl.appendChild(el('li', { class: 'field-hint', text: message }));
    renderHistory([], []);
  }

  /**
   * 歷史紀錄表：一列一個月份，最新在最上面。
   * 「未完成項目」欄列出該月 verdict==='未完成' 的檢查項目；輪休月與全合格各有自己的說法，
   * 不要一律顯示破折號——店長看到「—」會分不清是沒稽核還是全合格。
   */
  function renderHistory(records, details) {
    while (historyBodyEl.firstChild) historyBodyEl.removeChild(historyBodyEl.firstChild);

    const sorted = (records || []).slice()
      .sort((a, b) => (a.month < b.month ? 1 : (a.month > b.month ? -1 : 0)));

    if (!sorted.length) {
      const td = el('td', { class: 'field-hint', text: '尚無稽核紀錄' });
      td.setAttribute('colspan', '4');
      historyBodyEl.appendChild(el('tr', {}, [td]));
      return;
    }

    for (const r of sorted) {
      const isRest = r.status === '輪休';
      const fails = isRest ? [] : (details || [])
        .filter((d) => d.record_key === r.record_key && d.verdict === '未完成');

      const rateTd = el('td');
      if (isRest) {
        rateTd.appendChild(el('span', { class: 'field-hint', text: '—' }));
      } else {
        rateTd.appendChild(escEl(ctx, 'span', { class: 'tag tag-ok' }, r.pass_rate + '%'));
      }

      const failsTd = el('td');
      if (isRest) {
        failsTd.appendChild(el('span', { class: 'field-hint', text: '本月輪休' }));
      } else if (!fails.length) {
        failsTd.appendChild(el('span', { class: 'field-hint', text: '全部合格' }));
      } else {
        failsTd.appendChild(escEl(ctx, 'span', {}, fails.map((d) => d.text).join('、')));
      }

      historyBodyEl.appendChild(el('tr', { 'data-role': 'history-row', 'data-month': r.month }, [
        escEl(ctx, 'td', {}, r.month),
        escEl(ctx, 'td', {}, r.status),
        rateTd,
        failsTd
      ]));
    }
  }

  function buildRow(d) {
    const noteText = d.note ? ('說明：' + d.note) : '（無說明）';
    return el('li', {}, [
      escEl(ctx, 'span', { class: 'audit-item-name' }, d.text),
      el('span', { class: 'field-hint', text: '　' + noteText })
    ]);
  }

  function render(config, records, details) {
    const stores = config.stores || [];
    const storeInfo = stores.find((s) => s.code === node);
    storeLabelEl.textContent = storeInfo
      ? ('目前門市：' + storeInfo.name)
      : (node ? ('目前登入節點：' + node) : '未設定所屬節點，無法判斷要看哪一家店。');

    if (!node) {
      renderEmptyState('未設定所屬節點，無法顯示稽核資料。');
      return;
    }

    renderHistory(records, details);

    const record = pickLatestRecord(records);
    while (issuesListEl.firstChild) issuesListEl.removeChild(issuesListEl.firstChild);
    while (trackListEl.firstChild) trackListEl.removeChild(trackListEl.firstChild);

    if (!record) {
      rateEl.textContent = '尚無稽核紀錄';
      issuesListEl.appendChild(el('li', { class: 'field-hint', text: '尚無稽核紀錄' }));
      trackListEl.appendChild(el('li', { class: 'field-hint', text: '尚無稽核紀錄' }));
      return;
    }

    if (record.status === '輪休') {
      rateEl.textContent = record.month + ' 本月輪休';
      issuesListEl.appendChild(el('li', { class: 'field-hint', text: '本月輪休，無稽核資料' }));
      trackListEl.appendChild(el('li', { class: 'field-hint', text: '本月輪休，無稽核資料' }));
      return;
    }

    rateEl.appendChild(el('span', { class: 'field-hint', text: record.month + '　' }));
    rateEl.appendChild(escEl(ctx, 'span', { class: 'tag tag-ok' }, record.pass_rate + '%'));

    const recordDetails = (details || []).filter((d) => d.record_key === record.record_key);
    const fails = recordDetails.filter((d) => d.verdict === '未完成');
    const tracked = recordDetails.filter((d) => d.track === true);

    if (!fails.length) {
      issuesListEl.appendChild(el('li', { class: 'field-hint', text: '本次稽核全部合格，沒有被抓到的問題' }));
    } else {
      fails.forEach((d) => issuesListEl.appendChild(buildRow(d)));
    }

    if (!tracked.length) {
      trackListEl.appendChild(el('li', { class: 'field-hint', text: '沒有被標記追蹤的項目' }));
    } else {
      tracked.forEach((d) => trackListEl.appendChild(buildRow(d)));
    }
  }

  async function loadData() {
    ctx.ui.loading(true);
    try {
      const res = await sharedApi.getAll(ctx);
      if (destroyed) return;
      if (!res || res.ok !== true) {
        ctx.ui.toast((res && res.error) || '發生錯誤，請稍後再試', 'danger');
        renderEmptyState('發生錯誤，請稍後再試');
        return;
      }
      const config = (res.data && res.data.config) || { stores: [] };
      const records = (res.data && res.data.ops_records) || [];
      const details = (res.data && res.data.ops_details) || [];
      render(config, records, details);
    } catch {
      if (!destroyed) {
        ctx.ui.toast('發生錯誤，請稍後再試', 'danger');
        renderEmptyState('發生錯誤，請稍後再試');
      }
    } finally {
      if (!destroyed) ctx.ui.loading(false);
    }
  }

  loadData();

  return function unmount() {
    destroyed = true;
    [headerCard, rateCard, issuesCard, trackCard, historyCard].forEach((n) => {
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
  };
}
