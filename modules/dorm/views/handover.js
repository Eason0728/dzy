/**
 * modules/dorm/views/handover.js — 宿舍合約・退宿點交畫面（T3-4）
 *
 * 正本規格：docs/spec.md §4.6（mount(el,ctx) 回傳 unmount）、§4.7（ctx 逐字元形狀，
 * 含 params）、§4.10（ctx.ui／ctx.fmt 簽章；簽名板一律 `ctx.ui.signaturePad(canvasEl)`，
 * 回傳 `{isEmpty(),toDataURL(),clear(),destroy()}`——`destroy()` 是 platform/ui.js
 * 2026-08-15 對抗審查後補的，見該檔 341-356 行：簽名板掛了 window 層級的 mouseup
 * 監聽，模組進出這個分頁時若不解除會一直累積，unmount 時必須呼叫）。
 *
 * 來源：/Users/guoeason/mala-dorm-contract/handover.html（唯讀不准改，258 行）——
 * 版面骨架 79-142 行（設備逐項檢查、清潔勾選、應賠償金額合計、簽名區、送出列）、
 * 互動與計算邏輯 144-256 行（seg 按鈕切換、「未歸還」自動視為異常 154-160 行、
 * update() 算合計與送出按鈕條件 196-214 行、submit() 組 payload 216-228 行）。
 * 後端規則核對（不是猜的，行號如下）：
 *   - ~/mala-dorm-contract/apps-script/Handover.gs
 *     createHandover() 10-36 行：requireAdmin、僅「在住」合約可開、已有未完成點交單
 *     直接回同一張（reused）、成功回 {handover_id, token, url}。
 *     getHandoverByToken() 38-72 行：回 {state, handover, equip:[{item,price}], cleaning_fee}；
 *     equip 只列「簽約時有點收」的設備（59-68 行），价格 `s['price.'+item]` 來自 settings。
 *     calcCompensation() 75-90 行：權威賠償計算——「異常＋未歸還」才計價（81-84 行，
 *     已歸還一律 0），勾選需清潔另加清潔費（85-88 行）。
 *     submitHandover() 92-139 行：token 必填、simg_png 必填（100 行）、items 不可空
 *     （103 行）、每個 item.item 必須在 EQUIP_ITEMS 內（104-106 行）、已簽過直接回
 *     {ok:false, error:'這張點交單已經完成了', state:'signed'}（99 行）。
 *
 * 【入口參數：本頁怎麼知道要點交哪一張合約，設計判斷記在這裡】
 * 舊版是兩步：admin.html 的「開點交單」按鈕呼叫 handoverCreate(contract_id) 拿到
 * token/url，另開分頁載入 handover.html?t=token，那支頁面才用 token 呼叫 handover
 * action 取設備清單（見上）。manifest.js 把 handover 定義成平台內、需要 dorm.write
 * 的分頁（不是像 sign.html 那樣殼外、免登入的 token 頁——spec §4.5／§11 T2 只把
 * sign.html 定為殼外，handover 分頁沒有這條），代表這個分頁是操作人員（例如宿舍長）
 * 在同仁面前、用自己的登入身分現場操作，不是給同仁自己開的公開連結。本頁因此支援
 * 兩種進入方式（哪一種由平行任務 list.js／index.js 的路由決定，本頁不假設只有一種）：
 *   1. `ctx.params.contract_id`：比照舊版 admin.html「開點交單」按鈕，本頁自己呼叫
 *      handoverCreate 拿 token（已有未完成點交單就直接沿用，同後端 reused 邏輯）。
 *   2. `ctx.params.token`：已經有點交單 token（例如清單頁已經開過一次），直接跳過
 *      handoverCreate 那一步，省一次呼叫。
 * 兩者都沒有 → 顯示「缺少合約編號」的錯誤卡片，不猜、不硬打後端。
 *
 * 【資料層取捨】跟 create.js 同一個理由：modules/dorm/api.js（T3-1，已驗收，唯讀不准改）
 * 只有 rooms／list／contract 三個讀取 action，沒有 handoverCreate／handover／
 * handoverSign，這裡直接呼叫 ctx.api.call('dorm', action, payload)——與同批平行任務
 * modules/dorm/views/list.js 的 onToggleTerminate()（直接呼叫 ctx.api.call('dorm',
 * 'terminate',...)）做法一致。
 */
'use strict';

const BACKEND_ID = 'dorm';

// ============================================================
// 小工具：DOM 建構（模組自己一份，做法同 create.js／list.js／audit-stock 各分頁）
// ============================================================

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

// ============================================================
// 純函式：賠償金額預覽、送出前驗證（不碰 DOM，可直接單元測試）
// ============================================================

/**
 * 賠償金額「預覽」——對齊 Handover.gs calcCompensation() 75-90 行（見檔頭行號）：
 * 已歸還一律視為 0，只有「異常（normal===false）且未歸還（returned===false）」才計價；
 * 勾選需清潔（needCleaning）另加清潔費。真正寫進試算表的金額一律由後端 calcCompensation()
 * 權威重算（Handover.gs 76 行註解：「金額一律以後端 settings 重算，不信任前端傳來的總額」），
 * 這裡只是送出前給人看的預覽，數字要跟後端算出來的一致，這正是這條驗收的重點。
 * @param {{item:string, normal:boolean, returned:boolean}[]} items
 * @param {boolean} needCleaning
 * @param {(item:string)=>number} priceOf
 * @param {number} cleaningFee
 * @returns {number}
 */
export function calcCompensationPreview(items, needCleaning, priceOf, cleaningFee) {
  let total = 0;
  (items || []).forEach((it) => {
    if (it && it.normal === false && it.returned === false) {
      total += Number(priceOf(it.item)) || 0;
    }
  });
  if (needCleaning) total += Number(cleaningFee) || 0;
  return total;
}

/**
 * 送出前驗證：設備逐項都要點過「正常／異常」與「已歸還／未歸還」、簽名不可空白
 * （任務指示：驗證失敗要說清楚哪一項、為什麼，不是只講「資料有誤」）。
 * @param {{normal:(boolean|undefined), returned:(boolean|undefined)}[]} itemStates
 * @param {{isEmpty:function}|null} padCtl
 * @returns {string[]} 空陣列＝驗證通過
 */
export function validateHandoverSubmit(itemStates, padCtl) {
  const errors = [];
  const incomplete = (itemStates || []).filter((s) => s.normal === undefined || s.returned === undefined).length;
  if (incomplete > 0) {
    errors.push('設備檢查：還有 ' + incomplete + ' 項設備尚未點選「正常／異常」與「已歸還／未歸還」，請逐項確認');
  }
  if (!padCtl || typeof padCtl.isEmpty !== 'function' || padCtl.isEmpty()) {
    errors.push('簽名：尚未簽名，請在下方簽名區簽名後再送出');
  }
  return errors;
}

// ============================================================
// mount
// ============================================================

/**
 * @param {HTMLElement} root 殼／index.js 給的掛載點
 * @param {object} ctx spec §4.7（ctx.params.contract_id 或 ctx.params.token 其中一個，見檔頭說明）
 * @returns {function} unmount
 */
export function mountHandover(root, ctx) {
  let destroyed = false;
  const canWrite = ctx.can('dorm.write');

  if (!canWrite) {
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-title', text: '退宿點交' }),
      el('p', { class: 'field-hint', text: '沒有退宿點交的權限，無法使用這個分頁。' })
    ]);
    root.appendChild(card);
    return function unmount() {
      destroyed = true;
      if (card.parentNode) card.parentNode.removeChild(card);
    };
  }

  const params = ctx.params || {};
  const paramToken = params.token || '';
  const paramContractId = params.contract_id || '';

  const container = el('div', { class: 'card', id: 'dorm-handover-container' });
  root.appendChild(container);

  let padCtl = null; // 只在表單真的畫出來時建立一次，unmount 一律嘗試 destroy（見檔頭）

  function clearContainer() {
    while (container.firstChild) container.removeChild(container.firstChild);
  }

  function renderMissingParam() {
    clearContainer();
    container.appendChild(el('div', { class: 'card-title', text: '退宿點交' }));
    container.appendChild(el('p', { class: 'field-hint', text: '缺少合約編號，請從「合約清單」點選「開點交單」進入這個畫面。' }));
  }

  function renderLoadError(msg) {
    clearContainer();
    container.appendChild(el('div', { class: 'card-title', text: '退宿點交' }));
    container.appendChild(el('p', { class: 'field-hint' }, []));
    const p = escEl(ctx, 'p', { class: 'field-hint' }, msg || '發生錯誤，請稍後再試');
    container.appendChild(p);
  }

  function renderSignedSummary(h) {
    clearContainer();
    container.appendChild(el('div', { class: 'card-title', text: '這張點交單已完成' }));
    container.appendChild(escEl(ctx, 'p', {}, (h.name || '') + '　' + (h.room_bed || '')));
    container.appendChild(escEl(ctx, 'p', {}, '點交時間 ' + (h.signed_at || '')));
    container.appendChild(el('p', {}, [
      document.createTextNode('賠償合計 ' + ctx.fmt.money(h.compensation_total || 0) + ' 元')
    ]));
    if (h.pdf_url) {
      const link = escEl(ctx, 'a', { href: h.pdf_url, target: '_blank', class: 'btn btn-secondary' }, '下載點交單 PDF');
      container.appendChild(link);
    }
  }

  // ------------------------------------------------------------
  // 表單畫面（設備逐項檢查、清潔勾選、簽名）
  // ------------------------------------------------------------

  function buildToggle(labelTrue, labelFalse, current, onPick) {
    const wrap = el('div', { class: 'card-row' });
    [[true, labelTrue], [false, labelFalse]].forEach(([v, label]) => {
      const active = current === v;
      const btn = el('button', {
        type: 'button',
        class: 'btn ' + (active ? 'btn-primary' : 'btn-secondary') + (active ? ' active' : ''),
        text: label
      });
      btn.addEventListener('click', () => onPick(v));
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function renderForm(token, equip, cleaningFee) {
    clearContainer();

    const priceMap = {};
    equip.forEach((x) => { priceMap[x.item] = Number(x.price) || 0; });
    const priceOf = (item) => priceMap[item] || 0;

    // itemStates[i] 對應 equip[i]：{normal, returned, note}，normal/returned 未點選前是 undefined。
    const itemStates = equip.map(() => ({ normal: undefined, returned: undefined, note: '' }));
    let cleanOn = false;

    container.appendChild(el('div', { class: 'card-title', text: '退宿點交' }));
    container.appendChild(el('p', { class: 'field-hint', text: '請與宿舍長一起逐項確認。設備完好歸還即不需賠償；異常且未歸還者依簽約時的賠償單價計算。' }));

    const itemsList = el('ul', { id: 'dorm-handover-items' });
    const totalEl = el('p', { id: 'dorm-handover-total' });
    const statusEl = el('p', { id: 'dorm-handover-status', class: 'field-hint' });

    function buildEquipRow(idx) {
      const it = equip[idx];
      const state = itemStates[idx];
      const nameSpan = escEl(ctx, 'span', {}, it.item);
      const priceSpan = el('span', { class: 'field-hint', text: '　賠償單價 ' + ctx.fmt.money(priceOf(it.item)) + ' 元' });
      const head = el('div', { class: 'card-row' }, [nameSpan, priceSpan]);

      const normalToggle = buildToggle('正常', '異常', state.normal, (v) => onNormalChange(idx, v));
      const returnedToggle = buildToggle('已歸還', '未歸還', state.returned, (v) => onReturnedChange(idx, v));

      const rowChildren = [head, normalToggle, returnedToggle];
      if (state.normal === false) {
        const noteInput = el('input', {
          type: 'text', class: 'input', value: state.note || '',
          placeholder: '異常說明（選填，例如床墊污損）'
        });
        noteInput.addEventListener('input', () => { state.note = noteInput.value; });
        rowChildren.push(el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: '異常說明' }), noteInput
        ]));
      }
      return el('li', { class: 'card', 'data-item': it.item }, rowChildren);
    }

    function renderItemsList() {
      while (itemsList.firstChild) itemsList.removeChild(itemsList.firstChild);
      equip.forEach((_, idx) => itemsList.appendChild(buildEquipRow(idx)));
      renderTotalAndStatus();
    }

    function renderTotalAndStatus() {
      const total = calcCompensationPreview(
        equip.map((it, idx) => ({ item: it.item, normal: itemStates[idx].normal, returned: itemStates[idx].returned })),
        cleanOn, priceOf, cleaningFee
      );
      totalEl.textContent = '應賠償金額合計（預覽）：' + ctx.fmt.money(total) + ' 元';

      const doneCount = itemStates.filter((s) => s.normal !== undefined && s.returned !== undefined).length;
      if (doneCount < equip.length) {
        statusEl.textContent = '還有 ' + (equip.length - doneCount) + ' 項設備未點選';
      } else if (!padCtl || padCtl.isEmpty()) {
        statusEl.textContent = '請簽名';
      } else {
        statusEl.textContent = '確認無誤即可送出';
      }
    }

    function onNormalChange(idx, v) {
      itemStates[idx].normal = v;
      if (v === true) itemStates[idx].note = '';
      renderItemsList();
    }
    function onReturnedChange(idx, v) {
      itemStates[idx].returned = v;
      // 對齊舊版 handover.html 154-160 行：選「未歸還」時，若尚未明確點過「正常」，
      // 自動視為異常（沒歸還的東西無從點收為正常）。
      if (v === false && itemStates[idx].normal !== false) {
        itemStates[idx].normal = false;
      }
      renderItemsList();
    }

    renderItemsList();
    container.appendChild(el('div', { class: 'table-wrap' }, [itemsList]));

    // ---- 清潔勾選 ----
    const cleanCheckbox = el('input', { type: 'checkbox', id: 'dorm-handover-clean' });
    cleanCheckbox.addEventListener('change', () => {
      cleanOn = !!cleanCheckbox.checked;
      renderTotalAndStatus();
    });
    const cleanLabel = escEl(ctx, 'label', { for: 'dorm-handover-clean' },
      '房間未回復原狀，或留有私人物品（清潔費 ' + ctx.fmt.money(cleaningFee) + ' 元）');
    container.appendChild(el('div', { class: 'checkbox-row' }, [cleanCheckbox, cleanLabel]));

    container.appendChild(totalEl);

    // ---- 簽名（一律用 ctx.ui.signaturePad，見檔頭）----
    container.appendChild(el('div', { class: 'card-title', text: '承租人簽名' }));
    container.appendChild(el('p', { class: 'field-hint', text: '簽名代表你確認上列點交結果與金額。' }));
    const canvas = el('canvas', { id: 'dorm-handover-pad' });
    container.appendChild(canvas);
    padCtl = ctx.ui.signaturePad(canvas);

    const clearSignBtn = el('button', { type: 'button', class: 'btn btn-secondary', text: '清除重簽' });
    clearSignBtn.addEventListener('click', () => {
      padCtl.clear();
      renderTotalAndStatus();
    });
    container.appendChild(clearSignBtn);

    // ---- 送出 ----
    const submitErrorEl = el('p', { id: 'dorm-handover-error', class: 'field-hint', hidden: 'true' });
    const submitBtn = el('button', { type: 'button', id: 'dorm-handover-submit', class: 'btn btn-primary', text: '確認送出' });

    function hideError() {
      submitErrorEl.hidden = true;
      submitErrorEl.textContent = '';
    }
    function showError(msg) {
      submitErrorEl.textContent = msg;
      submitErrorEl.hidden = false;
    }

    async function onSubmit() {
      hideError();
      const errors = validateHandoverSubmit(itemStates, padCtl);
      if (errors.length) {
        showError(errors.join('\n'));
        ctx.ui.toast('請修正下列問題再送出', 'danger');
        return;
      }

      const items = equip.map((it, idx) => ({
        item: it.item, normal: itemStates[idx].normal, returned: itemStates[idx].returned,
        note: itemStates[idx].note || ''
      }));

      submitBtn.disabled = true;
      submitBtn.textContent = '送出中…';
      let res;
      try {
        res = await ctx.api.call(BACKEND_ID, 'handoverSign', {
          token, items, need_cleaning: cleanOn, sign_png: padCtl.toDataURL(),
          ua: (typeof navigator !== 'undefined' && navigator.userAgent) || ''
        });
      } catch (err) {
        res = { ok: false, error: (err && err.message) || '送出失敗，請稍後再試' };
      }
      if (destroyed) return;
      submitBtn.disabled = false;
      submitBtn.textContent = '確認送出';

      if (!res || res.ok !== true) {
        showError((res && res.error) || '送出失敗，請稍後再試');
        ctx.ui.toast('送出失敗，請重試', 'danger');
        return;
      }

      const data = res.data || {};
      clearContainer();
      container.appendChild(el('div', { class: 'card-title', text: '點交完成' }));
      container.appendChild(el('p', {}, [
        document.createTextNode('應賠償金額合計 ' + ctx.fmt.money(data.compensation_total || 0) + ' 元')
      ]));
      if (data.pdf_url) {
        container.appendChild(escEl(ctx, 'a', { href: data.pdf_url, target: '_blank', class: 'btn btn-secondary' }, '下載點交單 PDF'));
      }
      ctx.ui.toast('點交已送出', 'ok');
    }
    submitBtn.addEventListener('click', () => { onSubmit(); });

    container.appendChild(submitErrorEl);
    container.appendChild(statusEl);
    container.appendChild(submitBtn);
  }

  // ------------------------------------------------------------
  // 載入資料（見檔頭「入口參數」說明）
  // ------------------------------------------------------------

  async function loadHandover() {
    if (!paramToken && !paramContractId) {
      renderMissingParam();
      return;
    }
    ctx.ui.loading(true);
    try {
      let token = paramToken;
      if (!token) {
        const createRes = await ctx.api.call(BACKEND_ID, 'handoverCreate', { contract_id: paramContractId });
        if (destroyed) return;
        if (!createRes || createRes.ok !== true) {
          renderLoadError((createRes && createRes.error) || '開點交單失敗，請稍後再試');
          return;
        }
        token = createRes.data && createRes.data.token;
      }

      const dataRes = await ctx.api.call(BACKEND_ID, 'handover', { token });
      if (destroyed) return;
      if (!dataRes || dataRes.ok !== true) {
        renderLoadError((dataRes && dataRes.error) || '讀取點交單失敗，請稍後再試');
        return;
      }

      const data = dataRes.data || {};
      if (data.state === 'signed') {
        renderSignedSummary(data.handover || {});
      } else {
        renderForm(token, Array.isArray(data.equip) ? data.equip : [], Number(data.cleaning_fee) || 0);
      }
    } catch (err) {
      if (!destroyed) renderLoadError((err && err.message) || '發生錯誤，請稍後再試');
    } finally {
      if (!destroyed) ctx.ui.loading(false);
    }
  }

  loadHandover();

  return function unmount() {
    destroyed = true;
    // 簽名板掛了 window 層級的監聽，只要建立過就一定要 destroy（見檔頭 platform/ui.js
    // 341-356 行的說明）；沒進到表單畫面（缺參數／載入失敗／已簽署摘要）就沒有 padCtl，
    // 這裡用存在判斷保護，不會對 null 呼叫。
    if (padCtl && typeof padCtl.destroy === 'function') padCtl.destroy();
    if (container.parentNode) container.parentNode.removeChild(container);
  };
}
