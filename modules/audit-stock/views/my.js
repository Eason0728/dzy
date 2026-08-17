/**
 * modules/audit-stock/views/my.js — 月初盤點抽查・我的門市（T2-6，requirements F10 唯一新增功能）
 *
 * 正本規格：docs/spec.md §4.6（mount(el,ctx) 回傳 unmount）、§4.7（ctx 逐字元形狀）、
 * §4.10（ctx.ui／ctx.fmt 簽章；UI 一律用 platform/css/components.css 既有 class，不新增
 * 色碼、不內嵌樣式）、§7（店長節點裁切——**平台層已經做掉了**，本檔不得再裁一次）。
 * requirements.md §3（角色）、F10（店長視角要看什麼：自己節點的合格率、被抓到的問題、
 * 未完成追蹤清單，唯讀）。
 *
 * 權限：manifest.js 的 my 分頁 requires:['audit.read.own']，正常路由只有店長（或
 * 擁有萬用字元的 admin）能進到這裡。
 *
 * 【資料裁切（重要，任務指示反覆強調的地雷）】
 * ctx.api.call 實際打的是 platform/api.js 的 call()，它在 transformResponse_() 裡已經依
 * spec §7 把 records／details 這類「一列一店」的陣列裁到只剩 ctx.user.node 這個節點
 * （見 platform/api.js 的 maybeFilterOwnNode_()）。本檔透過 audit-shared/api.js 的
 * getAll(ctx) 拿到的 data 因此本來就只有自己店的資料，**不在這裡用 ctx.user.node 再篩一次
 * records/details**——裁兩次是任務指示明講的地雷（兩邊過濾邏輯稍有出入，就會變成「有時候
 * 看得到、有時候看不到」，比完全不裁切更難查）。ctx.user.node 只用來：①決定畫面上要標示
 * 「這是哪一家店」（config.stores 這份對照表沒有被裁切，見 platform/api.js 檔頭說明：
 * 它的欄位是 code 不是 store，天生不會被裁切器誤裁）；②admin 等全節點角色也符合
 * audit.read.own（萬用字元 `*` 涵蓋任何權限碼）而可能經由手動改網址點進本頁，這種情況下
 * data 不會被平台層裁切（hasFull 為真），此時沒有單一「自己節點」可言，畫面用
 * 「未設定所屬節點」這種安全的空狀態呈現，不假裝算得出來。
 *
 * 【唯讀（任務指示明講：完全沒有任何可寫入的控制項——沒有送出、沒有編輯、沒有標記）】
 * 整支檔案不建立任何 <button>／<input>／<select>／<textarea>／<a> 節點，也不掛任何會
 * 觸發資料變更的事件監聽器；純粹讀取 sharedApi.getAll(ctx) 後排版顯示。
 *
 * 【三個區塊怎麼從資料算出來】
 * 「合格率」與「被抓到的問題」都取自己節點**最新一筆**紀錄（依 month 字串比較，YYYY-MM
 * 格式天生可以直接用字串排序）：若最新一筆是「輪休」狀態，比照 report.js 顯示「本月輪休」；
 * 若完全沒有紀錄，顯示「尚無稽核紀錄」。「被抓到的問題」＝該筆紀錄裡 verdict==='異常' 的
 * 明細（reason／note 當說明）。
 * 「未完成追蹤清單」：月初盤點抽查沒有像營運稽核表那樣的獨立「追蹤」旗標（那是 ops 專屬
 * 概念，見 modules/audit-ops/views/fill-submit.js 的 track 欄位）——盤點的異常項目本質上
 * 就是「複盤數與盤點數對不上，下次稽核才會再確認是否已改善」，沒有中途「標記已改善」這個
 * 動作，所以「還有哪幾項沒改」在這裡就是同一份異常清單，只是換一個角度說明（本次稽核發現、
 * 尚待下次複盤確認改善）。這不是遺漏或偷懶，是照抄資料模型本身沒有更細的分辨力（任務回報
 * 「與舊版差異」會提到這點）。
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
    el('p', { class: 'field-hint', text: '下次複盤會再確認這些品項是否已經改善。' }),
    trackListEl
  ]);

  // 歷史紀錄（2026-08-17 新增，Eason 指示「要有查詢歷史紀錄」）。
  // 刻意做成**純表格、零控制項**：本檔的唯讀保證（檔頭）與 test/audit-ops.test.mjs
  // 「店長視角不得有任何 button/input/select/textarea」那條斷言都要繼續成立。
  // 資料本來就已經在手上（平台層已裁到只剩自己店，見檔頭），所以不必再打一次後端，
  // 也沒有「查詢」按鈕的必要——一次把該店所有月份列出來，最新的在最上面。
  const historyBodyEl = el('tbody', { id: 'my-history-body' });
  const historyCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title', text: '歷史紀錄' }),
    el('p', { class: 'field-hint', text: '這家店歷次月初盤點抽查的結果，最新的在最上面。' }),
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'table', id: 'my-history-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: '月份' }),
            el('th', { text: '狀態' }),
            el('th', { text: '正確率' }),
            el('th', { text: '被抓到的問題' })
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
   * 「被抓到的問題」欄列出該月 verdict==='異常' 的品項名稱；輪休月與零異常各有自己的說法，
   * 不要一律顯示破折號——店長看到「—」會分不清是沒稽核還是全對。
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
      const anomalies = isRest ? [] : (details || [])
        .filter((d) => d.record_key === r.record_key && d.verdict === '異常');

      const rateTd = el('td');
      if (isRest) {
        rateTd.appendChild(el('span', { class: 'field-hint', text: '—' }));
      } else {
        rateTd.appendChild(escEl(ctx, 'span', { class: 'tag tag-ok' }, r.correct_rate + '%'));
      }

      const issuesTd = el('td');
      if (isRest) {
        issuesTd.appendChild(el('span', { class: 'field-hint', text: '本月輪休' }));
      } else if (!anomalies.length) {
        issuesTd.appendChild(el('span', { class: 'field-hint', text: '全部正確' }));
      } else {
        issuesTd.appendChild(escEl(ctx, 'span', {}, anomalies.map((d) => d.item).join('、')));
      }

      historyBodyEl.appendChild(el('tr', { 'data-role': 'history-row', 'data-month': r.month }, [
        escEl(ctx, 'td', {}, r.month),
        escEl(ctx, 'td', {}, r.status),
        rateTd,
        issuesTd
      ]));
    }
  }

  function buildIssueRow(d) {
    const reasonText = d.reason ? ('原因：' + d.reason) : '';
    const noteText = d.note ? ('　備註：' + d.note) : '';
    return el('li', {}, [
      escEl(ctx, 'span', { class: 'audit-item-name' }, d.item),
      el('span', { class: 'field-hint', text: reasonText + noteText || '（無說明）' })
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
    rateEl.appendChild(escEl(ctx, 'span', { class: 'tag tag-ok' }, record.correct_rate + '%'));

    const anomalies = (details || []).filter(
      (d) => d.record_key === record.record_key && d.verdict === '異常'
    );

    if (!anomalies.length) {
      issuesListEl.appendChild(el('li', { class: 'field-hint', text: '本次稽核全部正確，沒有被抓到的問題' }));
      trackListEl.appendChild(el('li', { class: 'field-hint', text: '沒有需要追蹤的品項' }));
    } else {
      anomalies.forEach((d) => {
        issuesListEl.appendChild(buildIssueRow(d));
        trackListEl.appendChild(buildIssueRow(d));
      });
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
      const records = (res.data && res.data.records) || [];
      const details = (res.data && res.data.details) || [];
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
