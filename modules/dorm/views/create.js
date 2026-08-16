/**
 * modules/dorm/views/create.js — 宿舍合約・建立合約單、產生簽署連結畫面（T3-3）
 *
 * 正本規格：docs/spec.md §4.6（mount(el,ctx) 回傳 unmount）、§4.7（ctx 逐字元形狀）、
 * §4.10（ctx.ui／ctx.fmt 簽章；UI 一律用 platform/css/components.css 既有 class，
 * 不新增色碼、不內嵌樣式）。
 *
 * 來源：/Users/guoeason/mala-dorm-contract/admin.html（唯讀不准改）「建立合約單」段——
 * HTML 表單 88-111 行、表單連動與送出的 JS 邏輯 159-220 行。
 * 後端規則核對（不是猜的，行號如下）：
 *   - ~/mala-dorm-contract/apps-script/Api.gs
 *     createContract() 110-163 行：必填欄位檢查 111-113 行（name／room／term_start）、
 *     床位規則 116-123 行（多床房未指定床位 118-120 行拋「必須指定床位：…」；
 *     整間出租卻帶床位 121-123 行拋「是整間出租，不應指定床位」）、住宿方式判斷 124 行、
 *     床位／房型衝突的強制建立警告 126-129 行、租期計算 131-134 行、
 *     成功回傳形狀 158-162 行（含 sign_url，前端不必自己組簽約連結）。
 *   - ~/mala-dorm-contract/apps-script/Core.gs
 *     rentOf() 151-160 行（房型月租金；單人房+合租另有專屬費率）、
 *     addMonthsMinusDay() 126-131 行（租期迄日＝起日＋n個月−1天）。
 *   - ~/mala-dorm-contract/apps-script/Setup.gs
 *     DEFAULT_SETTINGS 31-57 行：rate.單人房=3500（32行）、rate.雙人房=2000（33行）、
 *     rate.四人房=1500（34行）、rate.單人房合租=1750（35行）、term.months=6（49行）。
 *
 * 【資料層取捨，記在這裡供之後任務參照】
 * modules/dorm/api.js（T3-1，已驗收，本任務唯讀不准改）本身只包三個讀取類 action
 * （rooms／list／contract）；本頁需要的房間清單用它的 getRooms()。但「建立合約」是
 * 寫入類 action，api.js 沒有對應函式（也不在本任務「只准動」的檔案清單內，不能加）。
 * 這裡直接呼叫 ctx.api.call('dorm','create',payload)——這本來就是 spec §4.7 定義的
 * 平台介面，api.js 只是部分讀取 action 的便利包裝，不是唯一合法通道。這個做法與同批
 * 平行任務 modules/dorm/views/list.js 的 onToggleTerminate()（直接呼叫
 * ctx.api.call('dorm','terminate',...)，理由寫在該檔檔頭）完全一致，不是本檔自創的例外。
 *
 * 【床位衝突的「強制建立」流程——原本做不出來，2026-08-16 平台層補洞後接回來】
 * 舊版 admin.html 建單遇到衝突（同床位／同房已有在住或待簽合約）時，後端 createContract()
 * 在 Api.gs 126-129 行（`if (!p.force) { const conflict = occupancyConflict(...); if
 * (conflict) return {ok:false, warn:'床位重複', message:'…確定要建立嗎？'}; }`，force 這個
 * 參數名讀 128 行下一行 `createContract` 用到 `p.force` 的地方）回這個軟性警告，前端接到後
 * 跳 confirm，按確定就帶 force:1 重送一次（admin.html 204-207 行）。原本卡在
 * platform/api.js（本任務唯讀，屬紅線不准改）的 transformResponse_() 對 dorm 後端的
 * {ok:false} 只保留 `error` 欄位，`warn`／`message` 會被丟掉；2026-08-16 平台層已補上
 * （spec §4.8 同步更新）：訊息取用順序改成 `error`→`message`→通用字，其餘欄位（含 `warn`）
 * 原樣放進 `data`。本頁現在看到的形狀是 `{ok:false, error:'<message>', data:{warn:'床位
 * 重複'}}`——用 `res.data.warn==='床位重複'` 判斷、`ctx.ui.confirm(res.error)` 問一次
 * （訊息就是後端給的那句，不是通用字），確認才帶 `force:true`（Api.gs 讀的是 truthy 值，
 * 同 form 版原本送 `force:1` 一樣成立）重送「一次」，取消則完全不再呼叫後端。
 */
'use strict';

import { getRooms } from '../api.js';

const BACKEND_ID = 'dorm';

// 房型月租金：與 Setup.gs 的 DEFAULT_SETTINGS 一致（見檔頭行號），同舊版 admin.html
// 159-166 行的前端預覽邏輯——這裡只是「送出前給人看的預覽」，真正寫進試算表的金額
// 一律由後端 rentOf() 依 settings 權威計算；兩邊數字要一致，這正是這條驗收的重點。
const RENT_RATES = { 單人房: 3500, 雙人房: 2000, 四人房: 1500 };
const RENT_SHARED_SINGLE_RATE = 1750;
const DEFAULT_TERM_MONTHS = 6; // 同 Setup.gs 的 term.months 預設值（49 行）

// ============================================================
// 小工具：DOM 建構（模組自己一份，做法同 modules/dorm/views/list.js／audit-stock 各分頁）
// ============================================================

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      // hidden 走 IDL 屬性（同 fill.js 的慣例），其餘地方一律用 `.hidden = true/false` 切換。
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
// 純函式：房型判斷、租金／租期預覽、送出前驗證（不碰 DOM，可直接單元測試）
// ============================================================

/** roomDef：{room, beds:[], type} 的其中一筆（來自 getRooms() 的 rooms 陣列）。 */
export function computeRent(roomDef, occupancy) {
  if (!roomDef) return null;
  if (roomDef.type === '單人房' && occupancy === '合租') return RENT_SHARED_SINGLE_RATE;
  const rate = RENT_RATES[roomDef.type];
  return rate === undefined ? null : rate;
}

/**
 * 租期迄日預覽：起日 + 6 個月 − 1 天（同舊版 admin.html 179-183 行、Core.gs
 * addMonthsMinusDay()）。真正寫進試算表的迄日一樣由後端權威計算，這裡只是預覽。
 */
export function computeTermEndPreview(startStr) {
  if (!startStr) return '';
  const d = new Date(startStr);
  if (Number.isNaN(d.getTime())) return '';
  d.setMonth(d.getMonth() + DEFAULT_TERM_MONTHS);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * 前端驗證：對齊 Api.gs createContract() 111-123 行的規則（見檔頭行號），訊息格式一律
 * 「欄位：原因」，不是只講「資料有誤」（任務指示：送出前的驗證失敗要說清楚哪一欄、為什麼）。
 * @param {{name:string, room:string, bed:string, term_start:string}} form
 * @param {{room:string, beds:string[], type:string}|null} roomDef
 * @returns {string[]} 空陣列＝驗證通過
 */
export function validateCreate(form, roomDef) {
  const errors = [];
  if (!form.name) errors.push('姓名：必填，請輸入承租人姓名');
  if (!form.room) errors.push('房間：必填，請選擇房間');
  else if (!roomDef) errors.push('房間：「' + form.room + '」不是可用的房間選項，請重新選擇');
  if (!form.term_start) errors.push('租期起日：必填，請選擇起日');

  if (roomDef) {
    const hasBeds = Array.isArray(roomDef.beds) && roomDef.beds.length > 0;
    // 對齊 Api.gs 118-120 行：多床房沒指定床位。
    if (hasBeds && !form.bed) {
      errors.push('床位：' + roomDef.room + ' 是多人房，必須指定床位（' + roomDef.beds.join('／') + '）');
    }
    // 對齊 Api.gs 121-123 行：整間出租卻帶了床位。
    if (!hasBeds && form.bed) {
      errors.push('床位：' + roomDef.room + ' 是整間出租，不應指定床位');
    }
  }
  return errors;
}

// ============================================================
// mount
// ============================================================

/**
 * @param {HTMLElement} root 殼／index.js 給的掛載點
 * @param {object} ctx spec §4.7
 * @returns {function} unmount
 */
export function mountCreate(root, ctx) {
  let destroyed = false;
  const canWrite = ctx.can('dorm.write');

  if (!canWrite) {
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-title', text: '建立合約單' }),
      el('p', { class: 'field-hint', text: '沒有建立合約單的權限，無法使用這個分頁。' })
    ]);
    root.appendChild(card);
    return function unmount() {
      destroyed = true;
      if (card.parentNode) card.parentNode.removeChild(card);
    };
  }

  let rooms = [];

  // ---- 骨架 ----
  const nameInput = el('input', { type: 'text', id: 'dorm-create-name', class: 'input' });
  const mailInput = el('input', { type: 'text', id: 'dorm-create-mail', class: 'input' });
  const roomSelect = el('select', { id: 'dorm-create-room', class: 'input' });
  const bedSelect = el('select', { id: 'dorm-create-bed', class: 'input' });
  const bedField = el('div', { class: 'field', id: 'dorm-create-bed-field', hidden: 'true' }, [
    el('label', { class: 'field-label', for: 'dorm-create-bed', text: '床位' }), bedSelect
  ]);
  const occSelect = el('select', { id: 'dorm-create-occ', class: 'input' }, [
    el('option', { value: '自住', text: '自住' }),
    el('option', { value: '合租', text: '合租' })
  ]);
  const occField = el('div', { class: 'field', id: 'dorm-create-occ-field', hidden: 'true' }, [
    el('label', { class: 'field-label', for: 'dorm-create-occ', text: '住宿方式' }), occSelect
  ]);
  const rentPreview = el('p', { id: 'dorm-create-rent', class: 'field-hint' });
  const startInput = el('input', { type: 'date', id: 'dorm-create-start', class: 'input' });
  const endPreview = el('p', { id: 'dorm-create-end', class: 'field-hint' });

  function feeSelect(id) {
    return el('select', { id, class: 'input' }, [
      el('option', { value: '由出租人負擔', text: '由出租人負擔' }),
      el('option', { value: '由承租人負擔', text: '由承租人負擔' })
    ]);
  }
  const mgmtSelect = feeSelect('dorm-create-mgmt');
  const waterSelect = feeSelect('dorm-create-water');
  const powerSelect = feeSelect('dorm-create-power');

  const formCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title', text: '建立合約單' }),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'dorm-create-name', text: '承租人姓名' }), nameInput]),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'dorm-create-mail', text: '通訊地址（選填，同仁簽署時可自填）' }), mailInput]),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'dorm-create-room', text: '房間' }), roomSelect]),
    bedField,
    occField,
    rentPreview,
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'dorm-create-start', text: '租期起日' }), startInput]),
    endPreview,
    el('div', { class: 'card-row' }, [
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '管理費' }), mgmtSelect]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '水費' }), waterSelect]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '電費' }), powerSelect])
    ])
  ]);

  const submitErrorEl = el('p', { id: 'dorm-create-error', class: 'field-hint', hidden: 'true' });
  const submitBtn = el('button', { type: 'button', id: 'dorm-create-submit', class: 'btn btn-primary', text: '建立並產生簽署連結' });

  const resultSummary = el('p', { id: 'dorm-create-summary' });
  const resultLinkCode = el('code', { id: 'dorm-create-link' });
  const copyBtn = el('button', { type: 'button', id: 'dorm-create-copy', class: 'btn btn-secondary', text: '複製連結' });
  const resultCard = el('div', { class: 'card', id: 'dorm-create-result', hidden: 'true' }, [
    el('div', { class: 'card-title', text: '已建立' }),
    resultSummary,
    resultLinkCode,
    copyBtn
  ]);

  root.appendChild(formCard);
  root.appendChild(submitErrorEl);
  root.appendChild(submitBtn);
  root.appendChild(resultCard);

  // ---- 衍生 ----
  function findRoomDef(roomName) {
    return rooms.find((r) => r.room === roomName) || null;
  }

  function renderRoomDependent() {
    const roomDef = findRoomDef(roomSelect.value);
    const hasBeds = !!(roomDef && Array.isArray(roomDef.beds) && roomDef.beds.length > 0);
    bedField.hidden = !hasBeds;
    if (hasBeds) {
      while (bedSelect.firstChild) bedSelect.removeChild(bedSelect.firstChild);
      roomDef.beds.forEach((b) => bedSelect.appendChild(escEl(ctx, 'option', { value: b }, b)));
    }
    const isSolo = !!(roomDef && roomDef.type === '單人房');
    occField.hidden = !isSolo;
    if (!isSolo) occSelect.value = '自住';
    renderRentPreview();
  }

  function renderRentPreview() {
    const roomDef = findRoomDef(roomSelect.value);
    const occupancy = (!occField.hidden && occSelect.value === '合租') ? '合租' : '自住';
    const rent = computeRent(roomDef, occupancy);
    rentPreview.textContent = rent === null ? '月租金：（請先選房間）' : '月租金（預覽）：' + ctx.fmt.money(rent) + ' 元／月';
  }

  function renderEndPreview() {
    const end = computeTermEndPreview(startInput.value);
    endPreview.textContent = end ? '租期迄日（預覽，起日 +' + DEFAULT_TERM_MONTHS + ' 個月）：' + end : '';
  }

  roomSelect.addEventListener('change', renderRoomDependent);
  occSelect.addEventListener('change', renderRentPreview);
  startInput.addEventListener('change', renderEndPreview);

  function hideError() {
    submitErrorEl.hidden = true;
    submitErrorEl.textContent = '';
  }
  function showError(msg) {
    submitErrorEl.textContent = msg;
    submitErrorEl.hidden = false;
  }

  /** 呼叫後端 create action；例外一律收斂成 {ok:false,error}，不往外拋。 */
  async function callCreate(payload) {
    try {
      return await ctx.api.call(BACKEND_ID, 'create', payload);
    } catch (err) {
      return { ok: false, error: (err && err.message) || '建立失敗，請稍後再試' };
    }
  }

  async function onSubmit() {
    hideError();
    const roomDef = findRoomDef(roomSelect.value);
    const hasBeds = !!(roomDef && Array.isArray(roomDef.beds) && roomDef.beds.length > 0);
    const form = {
      name: nameInput.value.trim(),
      mail_addr: mailInput.value.trim(),
      room: roomSelect.value,
      bed: hasBeds ? bedSelect.value : '',
      term_start: startInput.value
    };
    const errors = validateCreate(form, roomDef);
    if (errors.length) {
      showError(errors.join('\n'));
      ctx.ui.toast('請修正下列問題再送出', 'danger');
      return;
    }

    const occupancy = (roomDef.type === '單人房') ? (occSelect.value === '合租' ? '合租' : '自住') : '';
    const payload = {
      name: form.name, mail_addr: form.mail_addr, room: form.room, bed: form.bed,
      term_start: form.term_start, occupancy,
      fee_mgmt: mgmtSelect.value, fee_water: waterSelect.value, fee_power: powerSelect.value
    };

    submitBtn.disabled = true;
    submitBtn.textContent = '建立中…';
    let res = await callCreate(payload);

    // 床位衝突是一種軟性警告，不是硬性驗證失敗（同舊版 admin.html 204-207 行的
    // 「確定要建立嗎」流程）。platform/api.js 2026-08-15 更新後，dorm 後端的
    // {ok:false, warn:'床位重複', message:'...'} 會轉接成
    // {ok:false, error:'<message>', data:{warn:'床位重複', ...}}（spec §4.8）——
    // 用 res.data.warn 判斷，訊息直接用後端給的 res.error（不是通用字），問一次，
    // 確認才帶 force:true 重送「一次」（不遞迴、不再判一次 warn，第二次不管回什麼都走
    // 下面共用的成功／失敗分支），取消就什麼都不做、不顯示錯誤、不再打後端。
    if (res && res.ok !== true && res.data && res.data.warn === '床位重複') {
      if (destroyed) return;
      const confirmed = await ctx.ui.confirm(res.error || '床位重複，確定要建立嗎？');
      if (destroyed) return;
      if (!confirmed) {
        submitBtn.disabled = false;
        submitBtn.textContent = '建立並產生簽署連結';
        return;
      }
      res = await callCreate(Object.assign({}, payload, { force: true }));
    }

    if (destroyed) return;
    submitBtn.disabled = false;
    submitBtn.textContent = '建立並產生簽署連結';

    if (!res || res.ok !== true) {
      showError((res && res.error) || '建立失敗，請稍後再試');
      ctx.ui.toast('建立失敗', 'danger');
      return;
    }

    const data = res.data || {};
    resultSummary.innerHTML = ctx.fmt.esc(form.name) + '　' +
      ctx.fmt.esc(form.room + (form.bed ? ' ' + form.bed : '')) + '　租金 ' +
      ctx.fmt.money(data.rent) + ' 元／月　租期 ' + ctx.fmt.esc(data.term_start) + ' ～ ' + ctx.fmt.esc(data.term_end);
    // sign_url 由後端直接組好（Api.gs 161 行 SITE_BASE + 'sign.html?t=' + token），
    // 本頁不必自己拼網址（新平台的路徑跟舊系統不同，拼了反而會拼錯）。
    resultLinkCode.textContent = data.sign_url || '';
    resultCard.hidden = false;
    copyBtn.textContent = '複製連結';
    ctx.ui.toast('已建立 ' + (data.contract_id || ''), 'ok');
  }

  copyBtn.addEventListener('click', async () => {
    const url = resultLinkCode.textContent || '';
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = '已複製 ✓';
      ctx.ui.toast('已複製連結', 'ok');
    } catch (err) {
      ctx.ui.toast('複製失敗，請手動選取連結複製', 'warn');
    }
  });

  submitBtn.addEventListener('click', () => { onSubmit(); });

  // ---- 初始化：載入房間清單（走已驗收的 api.js，見檔頭「資料層取捨」）----
  async function loadRooms() {
    ctx.ui.loading(true);
    try {
      const res = await getRooms(ctx);
      if (destroyed) return;
      if (!res || res.ok !== true) {
        ctx.ui.toast((res && res.error) || '發生錯誤，請稍後再試', 'danger');
        return;
      }
      rooms = (res.data && res.data.rooms) || [];
      while (roomSelect.firstChild) roomSelect.removeChild(roomSelect.firstChild);
      roomSelect.appendChild(el('option', { value: '', text: '請選擇' }));
      rooms.forEach((r) => roomSelect.appendChild(escEl(ctx, 'option', { value: r.room }, r.room)));
      renderRoomDependent();
    } catch (err) {
      if (!destroyed) ctx.ui.toast('發生錯誤，請稍後再試', 'danger');
    } finally {
      if (!destroyed) ctx.ui.loading(false);
    }
  }

  loadRooms();

  return function unmount() {
    destroyed = true;
    roomSelect.removeEventListener('change', renderRoomDependent);
    occSelect.removeEventListener('change', renderRentPreview);
    startInput.removeEventListener('change', renderEndPreview);
    [formCard, submitErrorEl, submitBtn, resultCard].forEach((n) => {
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
  };
}
