/**
 * modules/audit-stock/views/fill-cashbox.js — 稽核填寫：金庫抽查＋共用的兩態切換鈕（T2-3 第二段）
 *
 * 正本規格：docs/spec.md §4.10（ctx.fmt.esc／UI 一律用 platform/css/components.css
 * 既有 class，不新增色碼、不內嵌樣式）。
 * 來源：~/mala-audit/js/views/audit.js 金庫區塊（vaultChoiceGroup／renderVaultBody／
 * renderVault，原檔 615-645 行一帶）。
 *
 * 舊版金庫三個核定（零找金／零用金／小費相符）與「填寫方式」「單項正確／異常」
 * 都是同一種 UI：一組互斥的切換鈕，選中的用行內樣式標成 active。這裡改用 platform
 * 既有的 .btn-primary（選中）／.btn-secondary（未選中）互換來表示 active 狀態，
 * 不新增色碼、不內嵌樣式（spec §4.10）——所以 buildChoiceGroup() 順便輸出給
 * fill.js 共用（填寫方式、單項正確／異常都是同一顆元件），不是本檔獨有。
 * DOM 的 data-group／data-value／既有 id（audit-vault-card／audit-vault-body／
 * audit-tip-amount／audit-note）原樣保留。
 */
'use strict';

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

/** 顯示後端資料一律經 ctx.fmt.esc()（同 modules/audit-stock/views/overview.js 的 escEl() 慣例）。 */
function escEl(ctx, tag, attrs, value) {
  const node = el(tag, attrs);
  node.innerHTML = ctx.fmt.esc(value);
  return node;
}

/** 標準金額顯示：10000 → '1 萬'；整萬數一律顯示「N 萬」，其他原數字顯示（照抄 stdLabel()）。 */
export function stdLabel(std) {
  if (typeof std !== 'number' || !std) return String(std || '');
  if (std % 10000 === 0) return (std / 10000) + ' 萬';
  return String(std);
}

/**
 * 一組互斥切換鈕（二選一或多選一）：選中的用 .btn-primary，未選中用 .btn-secondary，
 * class 額外掛 `active` 方便測試／既有 e2e 選擇器辨識目前選了哪個。
 * @param {string} group        data-group 值（例 'change_fund'）
 * @param {string[]} options    可選值（例 ['正確','不正確']）
 * @param {string} current      目前選中的值
 * @param {function} onPick     (group, value) => void
 * @param {string} [btnClass]   額外掛在每顆按鈕上的 class（例 'audit-vault-btn'）
 */
export function buildChoiceGroup(group, options, current, onPick, btnClass) {
  const wrap = el('div', { class: 'audit-choice-group card-row', 'data-group': group });
  options.forEach((v) => {
    const active = current === v;
    const cls = ['btn', active ? 'btn-primary' : 'btn-secondary', btnClass, active ? 'active' : '']
      .filter(Boolean).join(' ');
    const btn = el('button', {
      type: 'button', class: cls, 'data-group': group, 'data-value': v, text: v
    });
    btn.addEventListener('click', () => onPick(group, v));
    wrap.appendChild(btn);
  });
  return wrap;
}

/**
 * 掛上金庫抽查卡片。呼叫端（fill.js）負責存草稿／重繪其他區塊；本函式只管
 * 金庫這張卡片自己的 DOM 與互動。
 *
 * @param {object} ctx
 * @param {function} getConfig  () => config（spec §4.8 的 config，含 change_fund_std／
 *                              petty_cash_std）——傳函式而不是物件本身，因為 fill.js 在
 *                              loadData() 拿到後端資料後會把外層 config 變數整個重新指派
 *                              （不是原地改內容），傳物件參照的話這裡拿到的會是掛載當下
 *                              那個空殼、看不到後來載入的真正設定。
 * @param {function} getState   () => vaultState（{change_fund,petty_cash,tip_amount,tip_match,note}）
 * @param {function} onChange   (patch) => void，欄位變動時呼叫，呼叫端合併進 vaultState
 * @returns {{el: HTMLElement, refresh: function}} refresh() 依 getState() 目前值重繪（切店／月／還原草稿時呼叫）
 */
export function mountVaultCard(ctx, getConfig, getState, onChange) {
  const bodyEl = el('div', { id: 'audit-vault-body' });
  const noteEl = el('textarea', {
    id: 'audit-note', class: 'input', rows: '3', placeholder: '（選填）'
  });
  noteEl.addEventListener('input', () => onChange({ note: noteEl.value }));

  const card = el('div', { class: 'card', id: 'audit-vault-card' }, [
    el('div', { class: 'card-title', text: '金庫抽查' }),
    bodyEl,
    el('div', { class: 'field' }, [
      el('label', { for: 'audit-note', class: 'field-label', text: '整單備註' }),
      noteEl
    ])
  ]);

  function refresh() {
    const state = getState();
    const config = getConfig() || {};
    while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);

    const tipInput = el('input', {
      type: 'number', step: 'any', inputmode: 'decimal', id: 'audit-tip-amount', class: 'input',
      value: state.tip_amount === undefined || state.tip_amount === null ? '' : state.tip_amount
    });
    tipInput.addEventListener('input', () => onChange({ tip_amount: tipInput.value }));

    bodyEl.appendChild(el('div', { class: 'audit-vault-row field' }, [
      escEl(ctx, 'label', { class: 'field-label' }, '零找金（標準 ' + stdLabel(config.change_fund_std) + '）'),
      buildChoiceGroup('change_fund', ['正確', '不正確'], state.change_fund,
        (g, v) => onChange({ [g]: v }), 'audit-vault-btn')
    ]));
    bodyEl.appendChild(el('div', { class: 'audit-vault-row field' }, [
      escEl(ctx, 'label', { class: 'field-label' }, '零用金（標準 ' + stdLabel(config.petty_cash_std) + '）'),
      buildChoiceGroup('petty_cash', ['正確', '不正確'], state.petty_cash,
        (g, v) => onChange({ [g]: v }), 'audit-vault-btn')
    ]));
    bodyEl.appendChild(el('div', { class: 'audit-vault-row field' }, [
      el('label', { for: 'audit-tip-amount', class: 'field-label', text: '小費金額' }),
      tipInput,
      buildChoiceGroup('tip_match', ['相符', '不相符'], state.tip_match,
        (g, v) => onChange({ [g]: v }), 'audit-vault-btn')
    ]));

    noteEl.value = state.note || '';
  }

  refresh();
  return { el: card, refresh };
}
