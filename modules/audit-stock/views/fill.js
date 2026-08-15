/**
 * modules/audit-stock/views/fill.js — 月初盤點抽查・稽核填寫畫面（T2-3）
 *
 * 正本規格：docs/spec.md §4.6（mount(el,ctx) 回傳 unmount）、§4.7（ctx，含 viewId／params）、
 * §4.10（ctx.ui／ctx.fmt 簽章；UI 一律用 platform/css/components.css 既有 class，
 * 不新增色碼、不內嵌樣式）。
 *
 * 來源：~/mala-audit/js/views/audit.js（1157 行，window.Views.audit = {render}），
 * 拆成三支：本檔（骨架＋抽樣區＋品項清單，對照原檔 T4「抽樣區」段落）、
 * fill-cashbox.js（金庫抽查，對照原檔 615-645 行）、fill-submit.js（驗證／建送出內容／
 * 草稿，不碰 DOM 的純函式，對照原檔 44-97、252-300、647-777 行）。三支的行為合起來
 * 就是原檔的 render()，DOM 結構與 class 名盡量原樣保留（既有 e2e 的選擇器才不會失效）：
 * id（audit-store／audit-month／audit-drafts-card／audit-drafts-list／audit-mode-group／
 * audit-mode-hint／audit-draw／audit-add-input／audit-item-datalist／audit-add-unit／
 * audit-add-btn／audit-add-hint／audit-add-error／audit-count-warning／audit-items／
 * audit-vault-card／audit-vault-body／audit-tip-amount／audit-note／audit-submit-error／
 * audit-submit-btn／audit-retry-btn）與結構性 class（audit-item-row／audit-item-fill／
 * audit-item-qty-row／audit-choice-group／audit-verdict-btn／audit-vault-btn／
 * audit-anomaly-detail／audit-draft-row 等）都保留；舊版用 JS 內嵌 <style> 標記 active／
 * 顏色，這裡改疊 platform 既有的 .card／.table／.btn／.btn-primary／.btn-secondary／
 * .tag／.field／.input 等 class 負責外觀（spec §4.10：不新增色碼、不內嵌樣式）。
 *
 * 資料一律經 audit-shared/api.js 的 getAll(ctx)／submit(ctx, action, payload) 取得與
 * 送出（不自己呼叫 ctx.api），成功送出後 submit() 會自動 invalidate() 快取，下一次
 * 進報告頁（T2-4，尚未實作）呼叫 getAll() 就會拿到剛送出的新資料——這也是本檔不必
 * 像舊版 app.reload() 那樣手動重抓一次的原因（見下方 performSubmit() 的說明）。
 *
 * 寫入權限一律用 ctx.can('audit.write') 判斷（不比對角色代號字串，同 overview.js 的
 * 理由：manifest.js 的 fill 分頁本身就 requires:['audit.write']，正常路由不會讓沒權限
 * 的人進到這裡；這裡的 canWrite 檢查是第二道防線——見 spec §4.6 對「模組不得只信任
 * 平台已經擋過一次」的一貫做法，overview.js 的 canWrite 也是同樣用途）。沒有寫入權限
 * 時完全不畫表單，只顯示提示卡片，符合「看不到送出控制項」這條驗收。
 *
 * 覆蓋確認：舊版用一張行內卡片（#audit-overwrite-dialog）＋自己的確認／取消鈕；
 * 這裡改用 ctx.ui.confirm()（spec §4.10 已提供的標準確認框）——對使用者來說是同一個
 * 操作（送出前被問一次「確定要覆蓋嗎」）、同一個結果（確認才送出、取消不送出），
 * 只是介面元件從模組自己刻的卡片換成平台既有元件，行為等價，DOM 少了一組 id
 * （audit-overwrite-dialog 等），這點記在任務回報的「與舊版差異」。
 *
 * 抽查標準項數 SAMPLE_SIZE、金庫抽查、驗證、建送出內容、草稿存取都在另外兩支，
 * 本檔只負責畫面骨架、抽樣/品項清單的 DOM 與事件、以及把各段串起來。
 */
'use strict';

import * as sharedApi from '../../audit-shared/api.js';
import { Sampling, Format } from '../../audit-shared/umd-bridge.js';
import * as FillSubmit from './fill-submit.js';
import { mountVaultCard, buildChoiceGroup } from './fill-cashbox.js';

const { MODE_FULL, MODE_ANOMALY, SAMPLE_SIZE } = FillSubmit;

// ============================================================
// 小工具：DOM 建構（做法同 overview.js／fill-cashbox.js，模組自己一份）
// ============================================================

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      // hidden 走 IDL 屬性（同真實 DOM 的反映規則），因為畫面其餘地方一律用
      // `.hidden = true/false` 這個屬性切換顯示，不是走 attribute——兩邊要用同一套。
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

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

// 本模組唯一支援的年份，同 overview.js 的 YEARS（之後要加年份，兩檔一起加）。
const YEAR = '2026';

function buildMonthList() {
  const months = [];
  for (let m = 1; m <= 12; m++) months.push(YEAR + '-' + pad2(m));
  return months;
}

/**
 * @param {HTMLElement} root 殼／index.js 給的掛載點
 * @param {object} ctx spec §4.7
 * @returns {function} unmount
 */
export function mountFill(root, ctx) {
  let destroyed = false;
  const canWrite = ctx.can('audit.write');

  if (!canWrite) {
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-title', text: '稽核填寫' }),
      el('p', { class: 'field-hint', text: '沒有填寫權限，無法使用這個分頁。' })
    ]);
    root.appendChild(card);
    return function unmount() {
      destroyed = true;
      if (card.parentNode) card.parentNode.removeChild(card);
    };
  }

  // ---- 資料狀態（destroyed 之前都可能被 loadData() 更新）----
  let config = { stores: [], reasons: [] };
  let allItems = [];
  let allDetails = [];
  let records = [];

  // ---- 畫面狀態 ----
  let mode = FillSubmit.loadMode();
  let currentStore = '';
  let currentMonth = '';
  let items = []; // [{name, unit, lastDrawn, book_qty, recount_qty, verdict, reason, note}]
  let vaultState = { change_fund: '', petty_cash: '', tip_amount: '', tip_match: '', note: '' };

  const months = buildMonthList();
  const params = ctx.params || {};

  // ============================================================
  // 骨架
  // ============================================================

  const storeSelect = el('select', { id: 'audit-store', class: 'input' });
  const monthSelect = el('select', { id: 'audit-month', class: 'input' });
  months.forEach((m) => monthSelect.appendChild(el('option', { value: m, text: m + '（' + Format.monthLabel(m) + '）' })));

  const selectCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title', text: '稽核填寫' }),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'audit-store', text: '店' }), storeSelect]),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'audit-month', text: '月份' }), monthSelect])
  ]);

  const draftsList = el('ul', { id: 'audit-drafts-list' });
  const draftsCard = el('div', { class: 'card', id: 'audit-drafts-card', hidden: 'true' }, [
    el('div', { class: 'card-title', text: '未送出的草稿' }),
    el('p', { class: 'field-hint', text: '填到一半離開的內容都還在，點一下就接著填。' }),
    draftsList
  ]);

  const modeHint = el('p', { id: 'audit-mode-hint', class: 'field-hint' });
  const modeGroup = el('div', { id: 'audit-mode-group' });
  const modeCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title', text: '填寫方式' }),
    modeGroup,
    modeHint
  ]);

  const drawBtn = el('button', { type: 'button', id: 'audit-draw', class: 'btn btn-primary', text: '隨機抽 ' + SAMPLE_SIZE + ' 項' });
  const addInput = el('input', { type: 'text', id: 'audit-add-input', class: 'input', list: 'audit-item-datalist' });
  const datalist = el('datalist', { id: 'audit-item-datalist' });
  const addUnitInput = el('input', { type: 'text', id: 'audit-add-unit', class: 'input' });
  const addBtn = el('button', { type: 'button', id: 'audit-add-btn', class: 'btn btn-secondary' });
  const addHintEl = el('p', { id: 'audit-add-hint', class: 'field-hint' });
  const addErrorEl = el('p', { id: 'audit-add-error', class: 'field-hint', hidden: 'true' });
  const warningEl = el('p', { id: 'audit-count-warning', hidden: 'true' });
  const itemsEl = el('ul', { id: 'audit-items' });

  const samplingCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title', text: '品項抽查' }),
    drawBtn,
    el('div', { id: 'audit-add-row' }, [
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '加入品項' }), addInput, datalist]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '單位' }), addUnitInput]),
      addBtn,
      addHintEl,
      addErrorEl
    ]),
    warningEl,
    el('div', { class: 'table-wrap' }, [itemsEl])
  ]);

  const vaultCardHandle = mountVaultCard(ctx, () => config, () => vaultState, (patch) => {
    vaultState = Object.assign({}, vaultState, patch);
    saveDraft();
  });

  const submitErrorEl = el('p', { id: 'audit-submit-error', class: 'field-hint', hidden: 'true' });
  const submitBtn = el('button', { type: 'button', id: 'audit-submit-btn', class: 'btn btn-primary', text: '送出稽核' });
  const retryBtn = el('button', { type: 'button', id: 'audit-retry-btn', class: 'btn btn-secondary', text: '重試送出', hidden: 'true' });

  root.appendChild(selectCard);
  root.appendChild(draftsCard);
  root.appendChild(modeCard);
  root.appendChild(samplingCard);
  root.appendChild(vaultCardHandle.el);
  root.appendChild(submitErrorEl);
  root.appendChild(submitBtn);
  root.appendChild(retryBtn);

  // ============================================================
  // 衍生資料
  // ============================================================

  function currentStoreItems() {
    return allItems.filter((it) => it.store === currentStore && it.active !== false);
  }
  function currentStoreDetails() {
    return allDetails.filter((d) => d.store === currentStore);
  }
  function libraryItem(name) {
    return currentStoreItems().filter((it) => it.name === name)[0] || null;
  }
  function findIndexByName(name) {
    return items.findIndex((it) => it.name === name);
  }

  // ============================================================
  // 渲染：填寫方式
  // ============================================================

  function renderMode() {
    // 不直接用 buildChoiceGroup()：它的按鈕文字＝值本身（MODE_FULL/MODE_ANOMALY），
    // 這裡需要中文標籤，自己組（data-mode／.audit-mode-btn 這組 class／屬性沿用同慣例）。
    while (modeGroup.firstChild) modeGroup.removeChild(modeGroup.firstChild);
    const wrap = el('div', { class: 'audit-choice-group card-row' });
    [
      { v: MODE_FULL, label: '完整 ' + SAMPLE_SIZE + ' 項' },
      { v: MODE_ANOMALY, label: '只填異常項' }
    ].forEach(({ v, label }) => {
      const active = mode === v;
      const btn = el('button', {
        type: 'button',
        class: 'btn ' + (active ? 'btn-primary' : 'btn-secondary') + ' audit-mode-btn' + (active ? ' active' : ''),
        'data-mode': v,
        text: label
      });
      btn.addEventListener('click', () => onModeChange(v));
      wrap.appendChild(btn);
    });
    modeGroup.appendChild(wrap);

    if (mode === MODE_ANOMALY) {
      modeHint.textContent = '只輸入異常的品項，其餘視同正確；正確率固定以 ' + SAMPLE_SIZE + ' 項為分母計算。';
      drawBtn.hidden = true;
      addInput.setAttribute('placeholder', '輸入異常品項名稱加入');
      addBtn.textContent = '加入異常品項';
    } else {
      modeHint.textContent = '抽滿 ' + SAMPLE_SIZE + ' 項逐項核定正確／異常，正確率以實際清單項數為分母。';
      drawBtn.hidden = false;
      addInput.setAttribute('placeholder', '輸入品項名稱加入');
      addBtn.textContent = '加入品項';
    }
    hideAddError();
  }

  function onModeChange(next) {
    if (next === mode) return;
    saveDraft(); // 先把目前模式的內容存起來，再換過去（兩把 key 各存各的）
    mode = next;
    FillSubmit.persistMode(mode);
    tryRestoreOrReset();
  }

  // ============================================================
  // 渲染：品項清單
  // ============================================================

  function renderDatalist() {
    while (datalist.firstChild) datalist.removeChild(datalist.firstChild);
    currentStoreItems().forEach((it) => {
      datalist.appendChild(el('option', { value: it.name }));
    });
  }

  function setWarning(text, kind) {
    warningEl.className = kind ? 'tag ' + kind : '';
    warningEl.textContent = text || '';
    warningEl.hidden = !text;
  }

  function renderWarning() {
    if (mode === MODE_ANOMALY) {
      if (FillSubmit.tooManyAnomalies(mode, items.length, SAMPLE_SIZE)) {
        setWarning('異常 ' + items.length + ' 項，已超過標準 ' + SAMPLE_SIZE + ' 項，請刪除多餘項目後再送出', 'tag-danger');
        return;
      }
      const counts = Format.anomalyOnlyCounts(items.length, SAMPLE_SIZE);
      setWarning('異常 ' + items.length + ' 項，其餘視同正確 → 正確率 ' + counts.correct_rate +
        '%（' + counts.correct_count + '／' + SAMPLE_SIZE + '，分母固定 ' + SAMPLE_SIZE + ' 項）', 'tag');
      return;
    }
    if (items.length === SAMPLE_SIZE) {
      setWarning('', '');
    } else {
      // 品項庫不足 SAMPLE_SIZE 項時會抽不滿——這是正常情況、不是錯誤，只用提示告知，
      // 不擋任何操作（會計可以用下面的「加入品項」現場補，也可以不補直接送出）。
      setWarning('目前 ' + items.length + ' 項（標準 ' + SAMPLE_SIZE + ' 項）', 'tag-warn');
    }
  }

  function hideAddError() {
    addErrorEl.hidden = true;
    addErrorEl.textContent = '';
  }
  function showAddError(msg) {
    addErrorEl.textContent = msg;
    addErrorEl.hidden = false;
  }

  function buildItemRow(it) {
    const anomalyMode = mode === MODE_ANOMALY;
    const isAnomaly = anomalyMode || it.verdict === '異常';

    const nameSpan = escEl(ctx, 'span', { class: 'audit-item-name' }, it.name);
    const unitSpan = it.unit
      ? escEl(ctx, 'span', { class: 'audit-item-unit' }, '(' + it.unit + ')')
      : el('span', { class: 'audit-item-unit tag tag-danger', text: '缺單位' });
    const flagSpan = it.lastDrawn
      ? escEl(ctx, 'span', { class: 'audit-item-flag tag tag-warn' }, '⚠ ' + it.lastDrawn + ' 抽過')
      : null;
    const headLeft = el('span', {}, [nameSpan, unitSpan, flagSpan]);

    const redrawBtn = anomalyMode ? null : el('button', {
      type: 'button', class: 'btn btn-secondary audit-item-redraw', 'data-name': it.name, text: '換一項'
    });
    if (redrawBtn) redrawBtn.addEventListener('click', () => onRedraw(it.name));

    const removeBtn = el('button', {
      type: 'button', class: 'btn btn-danger audit-item-remove', 'data-name': it.name, text: '刪除'
    });
    removeBtn.addEventListener('click', () => onRemove(it.name));

    const headRow = el('div', { class: 'card-row' }, [headLeft, el('span', { class: 'card-row' }, [redrawBtn, removeBtn])]);

    const bookInput = el('input', {
      type: 'number', step: 'any', inputmode: 'decimal', class: 'input audit-book-qty',
      value: it.book_qty === undefined || it.book_qty === null ? '' : it.book_qty
    });
    bookInput.addEventListener('input', () => {
      it.book_qty = bookInput.value;
      saveDraft();
    });

    const recountInput = el('input', {
      type: 'number', step: 'any', inputmode: 'decimal', class: 'input audit-recount-qty',
      value: it.recount_qty === undefined || it.recount_qty === null ? '' : it.recount_qty
    });
    recountInput.addEventListener('input', () => {
      it.recount_qty = recountInput.value;
      saveDraft();
    });

    const qtyChildren = [
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '門市盤點數' }), bookInput]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '會計複盤數' }), recountInput])
    ];
    if (!it.unit) {
      // 品項庫有項目當初沒印單位（留空），抽到這種項目異常說明會少一塊，缺單位的當場補。
      const unitInput = el('input', { type: 'text', class: 'input audit-item-unit-input audit-unit-fix', value: '' });
      unitInput.addEventListener('input', () => {
        it.unit = unitInput.value;
        saveDraft();
      });
      qtyChildren.push(el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '單位' }), unitInput]));
    }
    const qtyRow = el('div', { class: 'audit-item-qty-row card-row' }, qtyChildren);

    const verdictGroup = anomalyMode ? null : buildChoiceGroup(
      'verdict', ['正確', '異常'], it.verdict, (g, v) => onVerdictChange(it.name, v), 'audit-verdict-btn'
    );

    let anomalyDetail = null;
    if (isAnomaly) {
      const reasonSelect = el('select', { class: 'input audit-reason' });
      reasonSelect.appendChild(el('option', { value: '', text: '請選擇' }));
      (config.reasons || []).forEach((r) => reasonSelect.appendChild(el('option', { value: r, text: r })));
      reasonSelect.value = it.reason || '';
      reasonSelect.addEventListener('change', () => {
        it.reason = reasonSelect.value;
        saveDraft();
        renderItems();
      });

      const noteInput = el('input', {
        type: 'text', class: 'input audit-item-note', value: it.note || '',
        placeholder: it.reason === '其他' ? '必填：請說明原因' : '選填'
      });
      noteInput.addEventListener('input', () => {
        it.note = noteInput.value;
        saveDraft();
      });

      anomalyDetail = el('div', { class: 'audit-anomaly-detail card' }, [
        el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '異常原因' }), reasonSelect]),
        el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '備註' }), noteInput])
      ]);
    }

    const fillBlock = el('div', { class: 'audit-item-fill' }, [qtyRow, verdictGroup, anomalyDetail]);
    return el('li', { class: 'audit-item-row', 'data-item': it.name, 'data-unit': it.unit }, [headRow, fillBlock]);
  }

  function renderItems() {
    while (itemsEl.firstChild) itemsEl.removeChild(itemsEl.firstChild);
    items.forEach((it) => itemsEl.appendChild(buildItemRow(it)));
    renderWarning();
    saveDraft();
  }

  function setItems(newItems) {
    items = newItems;
    renderItems();
  }

  function onRedraw(name) {
    const idx = findIndexByName(name);
    if (idx === -1) return;
    const currentNames = items.map((it) => it.name);
    const replacement = Sampling.redrawOne(currentNames, currentStoreItems(), currentStoreDetails());
    if (replacement) {
      items = items.slice();
      items[idx] = FillSubmit.normalizeItem(replacement, mode);
      renderItems();
    } else {
      ctx.ui.toast('已無其他品項可替換', 'warn');
    }
  }

  function onRemove(name) {
    items = items.filter((it) => it.name !== name);
    renderItems();
  }

  function onVerdictChange(name, verdict) {
    const idx = findIndexByName(name);
    if (idx === -1) return;
    items[idx].verdict = verdict;
    if (verdict !== '異常') {
      items[idx].reason = '';
      items[idx].note = '';
    }
    renderItems();
  }

  function addItemByName(name) {
    hideAddError();
    name = (name || '').trim();
    if (!name) {
      showAddError('請先輸入品項名稱');
      return;
    }
    if (items.some((it) => it.name === name)) {
      showAddError('「' + name + '」已在清單中');
      return;
    }
    const hit = libraryItem(name);
    const unit = hit ? (addUnitInput.value.trim() || hit.unit || '') : addUnitInput.value.trim();
    if (!unit) {
      showAddError(hit
        ? '品項庫沒有填「' + name + '」的單位，請補一個（例：包、盒、公斤）'
        : '「' + name + '」不在品項庫，請一併填單位（例：包、盒、公斤）');
      return;
    }
    items = items.concat([FillSubmit.normalizeItem({
      name, unit, lastDrawn: Sampling.lastDrawnOf(name, currentStoreDetails())
    }, mode)]);
    renderItems();
    addInput.value = '';
    addUnitInput.value = '';
    addHintEl.textContent = '';
  }

  // ============================================================
  // 草稿還原／重置
  // ============================================================

  function saveDraft() {
    FillSubmit.saveDraft(currentStore, currentMonth, mode, items, vaultState);
  }

  function applyDraft(draft) {
    items = (draft.items || []).map((it) => FillSubmit.normalizeItem(it, mode));
    const v = draft.vault || {};
    vaultState = {
      change_fund: v.change_fund || '',
      petty_cash: v.petty_cash || '',
      tip_amount: v.tip_amount !== undefined && v.tip_amount !== null ? v.tip_amount : '',
      tip_match: v.tip_match || '',
      note: v.note || ''
    };
  }

  function resetState() {
    items = [];
    vaultState = { change_fund: '', petty_cash: '', tip_amount: '', tip_match: '', note: '' };
  }

  function tryRestoreOrReset() {
    const draft = FillSubmit.loadDraft(currentStore, currentMonth, mode);
    if (draft) {
      applyDraft(draft);
    } else {
      resetState();
    }
    renderMode();
    renderItems();
    vaultCardHandle.refresh();
    renderDrafts();
    hideSubmitError();
    retryBtn.hidden = true;
  }

  // ============================================================
  // 未送出草稿一覽
  // ============================================================

  function storeLabel(code) {
    const hit = (config.stores || []).find((s) => s.code === code);
    return hit ? hit.name : code;
  }

  function renderDrafts() {
    const others = FillSubmit.listDrafts().filter(
      (d) => !(d.store === currentStore && d.month === currentMonth && d.mode === mode)
    );
    while (draftsList.firstChild) draftsList.removeChild(draftsList.firstChild);
    if (!others.length) {
      draftsCard.hidden = true;
      return;
    }
    draftsCard.hidden = false;
    others.forEach((d) => {
      const modeTxt = d.mode === MODE_ANOMALY ? '只填異常項' : '完整 ' + SAMPLE_SIZE + ' 項';
      const resumeBtn = escEl(ctx, 'button', {
        type: 'button', class: 'btn btn-secondary audit-draft-resume', 'data-key': d.key
      }, storeLabel(d.store) + '　' + Format.monthLabel(d.month) + '（' + modeTxt + '·已填 ' + d.count + ' 項）');
      resumeBtn.addEventListener('click', () => resumeDraft(d.key));

      const dropBtn = el('button', {
        type: 'button', class: 'btn btn-danger audit-draft-drop', 'data-key': d.key, text: '丟棄'
      });
      dropBtn.addEventListener('click', () => {
        FillSubmit.dropDraft(d.key);
        renderDrafts();
      });

      draftsList.appendChild(el('li', { class: 'audit-draft-row card-row' }, [resumeBtn, dropBtn]));
    });
  }

  function resumeDraft(key) {
    const payload = FillSubmit.readDraftByKey(key);
    if (!payload) return;
    saveDraft(); // 先保住目前這一份
    currentStore = payload.store;
    currentMonth = payload.month;
    mode = /_anomaly$/.test(key) ? MODE_ANOMALY : MODE_FULL;
    FillSubmit.persistMode(mode);
    storeSelect.value = currentStore;
    monthSelect.value = currentMonth;
    renderDatalist();
    tryRestoreOrReset();
  }

  // ============================================================
  // 送出
  // ============================================================

  function hideSubmitError() {
    submitErrorEl.hidden = true;
    submitErrorEl.textContent = '';
  }
  function showSubmitError(msg) {
    submitErrorEl.textContent = msg;
    submitErrorEl.hidden = false;
  }
  function showSubmitFailure() {
    showSubmitError('送出失敗，草稿已保留，請按下方「重試送出」再試一次');
    retryBtn.hidden = false;
    ctx.ui.toast('送出失敗，請重試', 'danger');
  }

  async function performSubmit() {
    hideSubmitError();
    retryBtn.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = '送出中…';
    const record = FillSubmit.buildRecord({ store: currentStore, month: currentMonth, mode, items, vault: vaultState, sampleSize: SAMPLE_SIZE });
    const details = FillSubmit.buildDetails({ store: currentStore, month: currentMonth, items, mode });
    try {
      const res = await sharedApi.submit(ctx, 'submitAudit', { record, details });
      if (destroyed) return;
      submitBtn.disabled = false;
      submitBtn.textContent = '送出稽核';
      if (res && res.ok) {
        // submit() 成功時已經呼叫過 invalidate()（見 audit-shared/api.js），下一次
        // 進報告頁（T2-4）呼叫 getAll() 就會拿到剛送出的新資料，不必像舊版
        // app.reload() 那樣在這裡手動重抓一次。
        FillSubmit.clearDraft(currentStore, currentMonth);
        ctx.ui.toast('稽核已送出', 'ok');
        ctx.nav('report', { store: currentStore, month: currentMonth });
      } else {
        showSubmitFailure();
      }
    } catch (e) {
      if (destroyed) return;
      submitBtn.disabled = false;
      submitBtn.textContent = '送出稽核';
      showSubmitFailure();
    }
  }

  async function doSubmit() {
    hideSubmitError();
    const errors = FillSubmit.validate({ mode, items, vault: vaultState, sampleSize: SAMPLE_SIZE });
    if (errors.length) {
      showSubmitError(errors.join('\n'));
      ctx.ui.toast('請修正下列問題再送出', 'danger');
      return;
    }
    const key = Format.recordKey(currentStore, currentMonth);
    const existing = records.find((r) => r.record_key === key);
    if (existing) {
      const ok = await ctx.ui.confirm('將覆蓋 ' + (existing.audit_date || '') + ' 的紀錄，確定送出？');
      if (!ok || destroyed) return;
    }
    await performSubmit();
  }

  // ============================================================
  // 事件：選店／選月
  // ============================================================

  function onStoreChange() {
    saveDraft();
    currentStore = storeSelect.value;
    FillSubmit.persistLastStore(currentStore);
    renderDatalist();
    tryRestoreOrReset();
  }
  function onMonthChange() {
    saveDraft();
    currentMonth = monthSelect.value;
    tryRestoreOrReset();
  }
  storeSelect.addEventListener('change', onStoreChange);
  monthSelect.addEventListener('change', onMonthChange);

  drawBtn.addEventListener('click', () => {
    setItems(Sampling.drawSample(currentStoreItems(), currentStoreDetails(), SAMPLE_SIZE).map((it) => FillSubmit.normalizeItem(it, mode)));
  });
  addBtn.addEventListener('click', () => addItemByName(addInput.value));
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault ? e.preventDefault() : null;
      addItemByName(addInput.value);
    }
  });

  submitBtn.addEventListener('click', () => { doSubmit(); });
  retryBtn.addEventListener('click', () => { performSubmit(); });

  // ============================================================
  // 初始化
  // ============================================================

  function pickDefaultStore() {
    const codes = (config.stores || []).map((s) => s.code);
    if (params.store && codes.indexOf(params.store) !== -1) return params.store;
    const saved = FillSubmit.loadLastStore();
    if (saved && codes.indexOf(saved) !== -1) return saved;
    return codes[0] || '';
  }

  async function loadData() {
    ctx.ui.loading(true);
    try {
      const res = await sharedApi.getAll(ctx);
      if (destroyed) return;
      if (!res || res.ok !== true) {
        ctx.ui.toast((res && res.error) || '發生錯誤，請稍後再試', 'danger');
        return;
      }
      config = (res.data && res.data.config) || { stores: [], reasons: [] };
      allItems = (res.data && res.data.items) || [];
      allDetails = (res.data && res.data.details) || [];
      records = (res.data && res.data.records) || [];

      while (storeSelect.firstChild) storeSelect.removeChild(storeSelect.firstChild);
      (config.stores || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)).forEach((s) => {
        storeSelect.appendChild(escEl(ctx, 'option', { value: s.code }, s.name));
      });

      currentStore = pickDefaultStore();
      storeSelect.value = currentStore;

      // 不是從別處帶 month 進來時，若這家店有未送出的草稿，落在那份草稿的月份與模式上
      // （同舊版 latestDraftForStore()：否則只回到店、月份卻是當月，看起來像內容不見了）。
      const resumeTarget = params.month ? null : FillSubmit.latestDraftForStore(currentStore);
      const now = new Date();
      const realMonthStr = String(now.getFullYear()) + '-' + pad2(now.getMonth() + 1);
      currentMonth = params.month
        ? params.month
        : (resumeTarget ? resumeTarget.month : (String(now.getFullYear()) === YEAR ? realMonthStr : months[0]));
      if (months.indexOf(currentMonth) === -1) currentMonth = months[0];
      monthSelect.value = currentMonth;
      mode = resumeTarget ? resumeTarget.mode : mode;

      renderDatalist();
      tryRestoreOrReset();
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
    [selectCard, draftsCard, modeCard, samplingCard, vaultCardHandle.el, submitErrorEl, submitBtn, retryBtn].forEach((n) => {
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
  };
}
