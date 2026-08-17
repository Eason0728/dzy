/**
 * modules/users/views/list.js — 人員清單畫面（T1-11；2026-08-15 對抗審查後修正兩個缺陷）
 *
 * 正本規格：docs/spec.md §4.3（角色→中文對照，2026-08-15 起改由後端 listRoles 動態
 * 回傳，不再是這個檔案裡的常數）、§4.4（節點代號→中文對照，節點仍是 spec 定死的
 * 五個，前端硬編碼是正確的，不隨角色一起動態化）、§4.7（ctx 逐字元形狀）、
 * §4.10（ctx.ui／ctx.fmt 簽章——dialog() 的 body 已在 2026-08-14 改成同時接受
 * 字串與 DOM 元素）、§5.2（listRoles 是 2026-08-15 新增的 action，
 * 回傳 {roles:[{role, name_zh, perms}]}}）。
 *
 * 表單彈窗為什麼還是模組自己刻（取代舊版「body 只吃純文字」的理由——
 * 那個理由 2026-08-14 已經不成立，ctx.ui.dialog() 的 body 現在可以塞真正的 DOM 節點，
 * 已經試過改用它，結論記錄如下）：
 *
 * 新增／修改使用者、重設密碼這兩個表單彈窗，繼續是模組自己組的 DOM
 *（沿用 platform/css/components.css 既有的 class：.dialog-overlay／.dialog／
 * .dialog-title／.dialog-body／.dialog-actions／.field／.field-label／
 * .field-hint／.input／.btn／.btn-primary／.btn-secondary，不新增任何 class、
 * 不內嵌樣式、不碰 platform/ 一個字）。原因不是 body 塞不下表單（那已經解決了），
 * 而是另一個更根本、目前 ctx.ui.dialog() 還做不到的缺口：
 *
 *   ctx.ui.dialog() 回傳單純一個 Promise<value>；它內部的 close() 是自己的閉包，
 *   沒有任何管道讓呼叫端「從外部」把一個已經開著的對話框強制關掉——沒有回傳
 *   { close() } 這樣的把手，也不接受 AbortSignal 之類的取消訊號。
 *
 *   而這次要修的缺陷①正是「unmount() 要能把開著的彈窗真的關掉（含拿掉
 *   document 上的 keydown 監聽）」。如果表單彈窗改用 ctx.ui.dialog()，
 *   unmount() 就完全沒有辦法叫它關閉——使用者切模組時彈窗一樣會留在畫面上、
 *   一樣能按送出，等於把要修的 bug 原封不動地搬進「共用元件」裡，缺陷沒修好。
 *   所以這裡繼續用模組自己刻的彈窗，靠自己持有的 close() 做到「unmount 時強制
 *   關閉」；下面的 openUserFormDialog／openPasswordDialog 都多了一個 handle
 *   參數，讓呼叫端（mountList 的 unmount）能拿到 close() 的參照。
 *
 *   真正的是非二選一確認（停用／啟用、重設密碼前的二次確認）仍照規格用
 *   ctx.ui.confirm()——那是一次性、不需要被模組從外部取消的互動，沒有這個缺口。
 *
 *   要讓以後的表單彈窗真的能改用共用元件，platform/ui.js 的 dialog() 需要多回傳
 *   一個外部可呼叫的 close(value)（或接受 AbortSignal）；這是平台層變更，本次
 *   任務規定不准動 platform/，因此只記錄在這裡、不動手實作。
 *
 * 角色下拉選單（2026-08-15 修正掉的另一個缺陷）：
 * 原本 ROLE_OPTIONS 把五個角色寫死在這個檔案裡，跟「roles 分頁可設定、加角色
 * 不改程式」互相矛盾——在試算表加一個角色，UI 認不得也指派不了。現在改成掛載
 * 時呼叫 ctx.api.call('users', 'listRoles', {})（spec §5.2），用回傳的 name_zh
 * 當顯示名、role 當選項值。listRoles 失敗或格式不符時不讓畫面壞掉：roleLabel()
 * 退回顯示原始代號（角色欄不會空白／不會炸），表單的角色下拉退回顯示手上已有的
 * 資料（見下面 loadRoles()／roleLabel() 的註解）。節點代號（NODE_OPTIONS）維持
 * 硬編碼——那是 spec §4.4 定死的五個，不受這次修正影響，不要跟著角色一起改掉。
 */
'use strict';

// ── §4.4 節點代號 → 中文（spec 定死的五個 + 空字串，前端硬編碼是正確的）──
const NODE_OPTIONS = [
  { value: '', label: '不限節點' },
  { value: 'sxl-gf', label: '麻的小辛辣 光復店' },
  { value: 'ck', label: '中央廚房' },
  { value: 'mzt-gf', label: '墨竹亭 光復店' },
  { value: 'mzt-js', label: '墨竹亭 金山店' },
  { value: 'mzt-lzl', label: '墨竹亭 六張犁店' }
];

const NODE_LABEL = {};
NODE_OPTIONS.forEach((o) => { NODE_LABEL[o.value] = o.label; });

const MIN_PASSWORD_LEN = 8;

/**
 * 角色顯示名。roleMap 由 loadRoles()（呼叫 spec §5.2 的 listRoles）動態填入，
 * 找不到對應項目（角色清單還沒載入完成、listRoles 失敗、或試算表刪掉了這個角色）
 * 就退回顯示原始代號，不讓表格空白或整個畫面壞掉。
 */
function roleLabel(role, roleMap) {
  return (roleMap && roleMap[role]) || role || '';
}

function nodeLabel(node) {
  if (node === undefined || node === null || node === '') return NODE_LABEL[''];
  return NODE_LABEL[node] || node;
}

function isActiveTrue(v) {
  return v === true || v === 'TRUE' || v === 'true';
}

/**
 * 顯示 created_at／last_login_at。直接用 ctx.fmt.datetime()，模組不做任何補救。
 *
 * 歷史（留著當教訓）：本函式原本有一層防呆，因為 platform/fmt.js 的 toDate() 只認得
 * 純日期 'YYYY-MM-DD'，讀不懂後端寫進試算表的 'YYYY-MM-DD HH:mm:ss'，整欄會空白。
 * 2026-08-14 已修在平台層（fmt.js 同時支援後端格式、ISO、純日期，並修掉純日期被當成
 * UTC 而偏移八小時的 bug），因此這裡的防呆拿掉——**模組不該長期扛平台的缺陷**，
 * 那會讓每個模組都各自繞一次路，正是這個專案要消滅的重複。
 */
function displayDatetime(ctx, raw) {
  return ctx.fmt.datetime(raw);
}

// ============================================================
// 小工具：DOM 建構、事件委派找祖先節點（做法沿用 platform/shell.js 的風格，
// 但這裡是模組自己的一份，不是共用——平台層沒有輸出這個工具給模組用）
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
// 表單彈窗（新增／修改使用者、重設密碼）—— 見檔頭說明
// ============================================================

function makeInputField(container, { label, type, value, name }) {
  const input = el('input', { type, class: 'input', 'data-field': name });
  input.value = value || '';
  container.appendChild(
    el('div', { class: 'field' }, [el('label', { class: 'field-label', text: label }), input])
  );
  return input;
}

function makeSelectField(container, { label, options, value, name }) {
  const select = el('select', { class: 'input', 'data-field': name });
  for (const opt of options) {
    const optionEl = el('option', { value: opt.value, text: opt.label });
    select.appendChild(optionEl);
  }
  select.value = value || '';
  container.appendChild(
    el('div', { class: 'field' }, [el('label', { class: 'field-label', text: label }), select])
  );
  return select;
}

/**
 * 新增／修改使用者表單彈窗。
 * @param {object|null} existingUser 修改時傳現有使用者物件；新增傳 null
 * @param {Array<{value:string,label:string}>} roleOptions 目前的角色選項（來自 listRoles，
 *   可能是空陣列——例如 listRoles 還沒回來或失敗，這時下拉會沒有選項可選，但不會拋錯）
 * @param {object} [handle] 呼叫端（mountList 的 unmount）用來強制關閉這個彈窗的把手，
 *   會被設成 handle.close = close（見檔頭「為什麼還是模組自己刻」的說明）
 * @returns {Promise<{username, name, role, node, password?}|null>} 取消或被強制關閉回 null
 */
function openUserFormDialog(existingUser, roleOptions, handle) {
  const isEdit = !!existingUser;
  const options = Array.isArray(roleOptions) ? roleOptions : [];
  // 修改時，就算目前使用者的角色代號已經不在最新的角色清單裡（試算表刪掉了這個角色、
  // 或 listRoles 剛好失敗），下拉選單也要保留這個人現在的角色可以被選到，不然畫面上
  // 會變成「選了一個看不見的值」。新增沒有這個問題（新增本來就沒有既有角色）。
  const formRoleOptions = (isEdit && existingUser.role && !options.some((o) => o.value === existingUser.role))
    ? options.concat([{ value: existingUser.role, label: existingUser.role }])
    : options;

  return new Promise((resolve) => {
    const errorEl = el('div', { class: 'field-hint', 'data-role': 'form-error' });

    const bodyEl = el('div', { class: 'dialog-body' });
    const usernameInput = makeInputField(bodyEl, {
      label: '帳號', type: 'text', name: 'username',
      value: isEdit ? existingUser.username : ''
    });
    const nameInput = makeInputField(bodyEl, {
      label: '姓名', type: 'text', name: 'name',
      value: isEdit ? existingUser.name : ''
    });
    let passwordInput = null;
    if (!isEdit) {
      passwordInput = makeInputField(bodyEl, {
        label: `密碼（至少 ${MIN_PASSWORD_LEN} 個字元）`, type: 'password', name: 'password', value: ''
      });
    }
    const roleSelect = makeSelectField(bodyEl, {
      label: '角色', options: formRoleOptions, name: 'role',
      value: isEdit ? existingUser.role : (formRoleOptions[0] ? formRoleOptions[0].value : '')
    });
    const nodeSelect = makeSelectField(bodyEl, {
      label: '所屬節點', options: NODE_OPTIONS, name: 'node',
      value: isEdit ? (existingUser.node || '') : ''
    });
    bodyEl.appendChild(errorEl);

    const cancelBtn = el('button', { type: 'button', class: 'btn btn-secondary', 'data-role': 'cancel', text: '取消' });
    const submitBtn = el('button', {
      type: 'button', class: 'btn btn-primary', 'data-role': 'submit', text: isEdit ? '儲存' : '新增'
    });
    const actionsEl = el('div', { class: 'dialog-actions' }, [cancelBtn, submitBtn]);

    const box = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: 'dialog-title', text: isEdit ? '修改使用者' : '新增使用者' }),
      bodyEl,
      actionsEl
    ]);
    const overlay = el('div', { class: 'dialog-overlay', 'data-role': 'user-form-overlay' }, [box]);

    let closed = false;
    function close(value) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.removeEventListener('click', onOverlayClick);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(value);
    }
    // 讓外部（目前只有 mountList 的 unmount()）能強制關掉這個還開著的彈窗——
    // ctx.ui.dialog() 現在做不到這件事，見檔頭「為什麼還是模組自己刻」的說明。
    if (handle) handle.close = close;

    function onKeydown(e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        close(null);
      }
    }
    function onOverlayClick(e) {
      if (e.target === overlay) close(null);
    }

    cancelBtn.addEventListener('click', () => close(null));
    submitBtn.addEventListener('click', () => {
      const username = (usernameInput.value || '').trim();
      const name = (nameInput.value || '').trim();
      if (!username || !name) {
        errorEl.textContent = '帳號與姓名為必填';
        return;
      }
      const payload = { username, name, role: roleSelect.value, node: nodeSelect.value };
      if (!isEdit) {
        const password = passwordInput.value || '';
        if (password.length < MIN_PASSWORD_LEN) {
          errorEl.textContent = `密碼至少需要 ${MIN_PASSWORD_LEN} 個字元`;
          return;
        }
        payload.password = password;
      }
      close(payload);
    });

    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown, true);
    document.body.appendChild(overlay);
  });
}

/**
 * 重設密碼表單彈窗——少於 8 字元前端就先擋下（送出時檢查，太短不關窗，
 * 只顯示錯誤訊息，不會 resolve），resolve 的一定是已通過長度檢查的新密碼；
 * 取消／Esc／點背景／被 handle.close() 強制關閉 → resolve(null)。
 * @param {object} user
 * @param {object} [handle] 同 openUserFormDialog 的 handle，用來讓外部強制關閉
 * @returns {Promise<string|null>}
 */
function openPasswordDialog(user, handle) {
  return new Promise((resolve) => {
    const errorEl = el('div', { class: 'field-hint', 'data-role': 'form-error' });
    const bodyEl = el('div', { class: 'dialog-body' });
    const passwordInput = makeInputField(bodyEl, {
      label: `新密碼（至少 ${MIN_PASSWORD_LEN} 個字元）`, type: 'password', name: 'newPassword', value: ''
    });
    bodyEl.appendChild(errorEl);

    const cancelBtn = el('button', { type: 'button', class: 'btn btn-secondary', 'data-role': 'cancel', text: '取消' });
    const submitBtn = el('button', { type: 'button', class: 'btn btn-primary', 'data-role': 'submit', text: '重設' });
    const actionsEl = el('div', { class: 'dialog-actions' }, [cancelBtn, submitBtn]);

    const box = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: 'dialog-title', text: '重設密碼' }),
      bodyEl,
      actionsEl
    ]);
    const overlay = el('div', { class: 'dialog-overlay', 'data-role': 'password-form-overlay' }, [box]);

    let closed = false;
    function close(value) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.removeEventListener('click', onOverlayClick);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(value);
    }
    if (handle) handle.close = close;

    function onKeydown(e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        close(null);
      }
    }
    function onOverlayClick(e) {
      if (e.target === overlay) close(null);
    }

    cancelBtn.addEventListener('click', () => close(null));
    submitBtn.addEventListener('click', () => {
      const pw = passwordInput.value || '';
      if (pw.length < MIN_PASSWORD_LEN) {
        errorEl.textContent = `密碼至少需要 ${MIN_PASSWORD_LEN} 個字元`;
        return; // 太短：不關窗、不 resolve，前端先擋下
      }
      close(pw);
    });

    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown, true);
    document.body.appendChild(overlay);
  });
}

// ============================================================
// 掛載
// ============================================================

const COLUMNS = ['ID', '帳號', '姓名', '角色', '所屬節點', '狀態', '建立時間', '最後登入'];

/**
 * @param {HTMLElement} root 殼給的掛載點（spec §4.6 mount(el, ctx)）
 * @param {object} ctx spec §4.7
 * @returns {function} unmount
 */
export function mountList(root, ctx) {
  let destroyed = false;
  let users = [];
  let roleOptions = []; // [{value, label}]，由 loadRoles() 動態填入（spec §5.2 listRoles）
  let roleMap = {};     // role -> name_zh，同上；找不到就在 roleLabel() 退回顯示原始代號

  // 目前開著、由這個模組自己刻的彈窗（user-form-overlay／password-form-overlay）的
  // close() 把手集合。unmount() 時要把裡面每一個都強制關掉——見檔頭「缺陷①」說明。
  const openDialogHandles = new Set();

  function trackDialog(openFn, ...args) {
    const handle = {};
    const promise = openFn(...args, handle);
    openDialogHandles.add(handle);
    return promise.finally(() => { openDialogHandles.delete(handle); });
  }

  const addBtn = el('button', {
    type: 'button', class: 'btn btn-primary', 'data-role': 'add-user', text: '新增使用者'
  });
  const headerRow = el('div', { class: 'card-row' }, [
    el('div', { class: 'card-title', text: '人員清單' }),
    addBtn
  ]);

  const headTr = el('tr', {}, COLUMNS.map((label) => el('th', { text: label })).concat([el('th', { text: '操作' })]));
  const thead = el('thead', {}, [headTr]);
  const tbody = el('tbody', { 'data-role': 'rows' });
  const table = el('table', { class: 'table' }, [thead, tbody]);
  const tableWrap = el('div', { class: 'table-wrap' }, [table]);

  const card = el('div', { class: 'card' }, [headerRow, tableWrap]);
  root.appendChild(card);

  function textCell(value) {
    const td = document.createElement('td');
    // 所有顯示到畫面的字串一律經 ctx.fmt.esc()（任務指示第 4 點）。
    td.innerHTML = ctx.fmt.esc(value);
    return td;
  }

  function statusCell(active) {
    const td = document.createElement('td');
    const isActive = isActiveTrue(active);
    const tag = el('span', { class: isActive ? 'tag tag-ok' : 'tag tag-danger' });
    tag.innerHTML = ctx.fmt.esc(isActive ? '啟用' : '停用');
    td.appendChild(tag);
    return td;
  }

  function actionButton(label, variantClass, action, id) {
    return el('button', {
      type: 'button', class: `btn ${variantClass}`, 'data-action': action, 'data-id': id, text: label
    });
  }

  function renderRows() {
    while (tbody.children.length) tbody.removeChild(tbody.children[0]);
    for (const u of users) {
      const isActive = isActiveTrue(u.active);
      const tr = el('tr', { 'data-role': 'user-row', 'data-id': u.id });
      tr.appendChild(textCell(u.id));
      tr.appendChild(textCell(u.username));
      tr.appendChild(textCell(u.name));
      tr.appendChild(textCell(roleLabel(u.role, roleMap)));
      tr.appendChild(textCell(nodeLabel(u.node)));
      tr.appendChild(statusCell(u.active));
      tr.appendChild(textCell(displayDatetime(ctx, u.created_at)));
      tr.appendChild(textCell(displayDatetime(ctx, u.last_login_at)));

      const actionsTd = el('td', {}, [
        actionButton('編輯', 'btn-secondary', 'edit-user', u.id),
        actionButton(isActive ? '停用' : '啟用', 'btn-danger', 'toggle-active', u.id),
        actionButton('重設密碼', 'btn-secondary', 'reset-password', u.id)
      ]);
      tr.appendChild(actionsTd);

      tbody.appendChild(tr);
    }
  }

  /** 後端呼叫的共用包裝：失敗一律 toast 後端訊息，絕不讓例外炸到畫面（任務指示第 5 點）。 */
  async function callBackend(action, payload) {
    try {
      const res = await ctx.api.call('users', action, payload);
      if (!res || res.ok !== true) {
        ctx.ui.toast((res && res.error) || '發生錯誤，請稍後再試', 'danger');
        return null;
      }
      return res;
    } catch {
      // 不顯示技術性訊息（任務指示第 5 點），只給看得懂的中文提示。
      ctx.ui.toast('發生錯誤，請稍後再試', 'danger');
      return null;
    }
  }

  /**
   * 角色清單：呼叫 spec §5.2 的 listRoles，取代原本寫死在這個檔案裡的 ROLE_OPTIONS。
   * 失敗或回傳形狀不對時「維持原樣」（初始是空陣列／空物件）而不是清空已經抓到的
   * 資料或拋錯——roleLabel() 會自動退回顯示原始代號，角色下拉會退回顯示手上已有
   * 的選項，畫面不會壞掉（任務指示的退路要求）。
   */
  async function loadRoles() {
    const res = await callBackend('listRoles', {});
    if (destroyed) return;
    if (res && res.data && Array.isArray(res.data.roles)) {
      const roles = res.data.roles;
      roleOptions = roles.map((r) => ({ value: r.role, label: (r && r.name_zh) || r.role }));
      const map = {};
      for (const r of roles) map[r.role] = (r && r.name_zh) || r.role;
      roleMap = map;
    }
  }

  async function loadUsers() {
    ctx.ui.loading(true);
    try {
      const res = await callBackend('listUsers', {});
      if (destroyed) return;
      users = (res && res.data && Array.isArray(res.data.users)) ? res.data.users : [];
      renderRows();
    } finally {
      ctx.ui.loading(false);
    }
  }

  async function onAddClick() {
    // 2026-08-17 修：角色清單載入失敗時，原本會靜靜開出一個「空的角色下拉」，
    // 使用者只看到選不了角色、完全不知道原因（Eason 實際踩到）。
    // 改成：開之前先確認有選項；沒有就當場重抓一次，仍然沒有就明講原因並不開對話框
    //（開了也建不成帳號——角色是必填，saveUser 會被後端擋下）。
    if (!roleOptions.length) {
      await loadRoles();
      if (destroyed) return;
    }
    if (!roleOptions.length) {
      ctx.ui.toast('讀不到角色清單，無法新增帳號。請重新整理；若持續發生，檢查「帳號權限」試算表的 roles 分頁是否有資料', 'danger');
      return;
    }

    const payload = await trackDialog(openUserFormDialog, null, roleOptions);
    if (!payload) return;
    ctx.ui.loading(true);
    try {
      const res = await callBackend('saveUser', payload);
      if (!res) return;
      ctx.ui.toast('已新增', 'ok');
      await loadUsers();
    } finally {
      ctx.ui.loading(false);
    }
  }

  async function onEditClick(user) {
    // 同 onAddClick：角色清單空的時候先重抓一次（修改時至少還保得住他現在的角色，
    // 所以這裡不擋著不開，只是盡量把選項補回來）
    if (!roleOptions.length) {
      await loadRoles();
      if (destroyed) return;
    }
    const payload = await trackDialog(openUserFormDialog, user, roleOptions);
    if (!payload) return;
    ctx.ui.loading(true);
    try {
      const res = await callBackend('saveUser', { id: user.id, ...payload });
      if (!res) return;
      ctx.ui.toast('已儲存', 'ok');
      await loadUsers();
    } finally {
      ctx.ui.loading(false);
    }
  }

  async function onToggleActive(user) {
    const active = isActiveTrue(user.active);
    const msg = active ? `確定要停用「${user.name}」嗎？` : `確定要啟用「${user.name}」嗎？`;
    const confirmed = await ctx.ui.confirm(msg);
    if (!confirmed) return;
    ctx.ui.loading(true);
    try {
      const res = await callBackend('setActive', { id: user.id, active: !active });
      if (!res) return;
      ctx.ui.toast('已更新', 'ok');
      await loadUsers();
    } finally {
      ctx.ui.loading(false);
    }
  }

  async function onResetPassword(user) {
    const newPassword = await trackDialog(openPasswordDialog, user); // 太短已在彈窗裡被擋下，這裡拿到的一定是合格長度或 null
    if (newPassword === null) return;
    const confirmed = await ctx.ui.confirm(`確定要重設「${user.name}」的密碼嗎？`);
    if (!confirmed) return;
    ctx.ui.loading(true);
    try {
      const res = await callBackend('resetPassword', { id: user.id, newPassword });
      if (!res) return;
      ctx.ui.toast('密碼已重設', 'ok');
    } finally {
      ctx.ui.loading(false);
    }
  }

  function onRowClick(e) {
    const btn = findAncestorWithAttr(e.target, 'data-action');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');
    const user = users.find((u) => String(u.id) === String(id));
    if (!user) return;
    if (action === 'edit-user') onEditClick(user);
    else if (action === 'toggle-active') onToggleActive(user);
    else if (action === 'reset-password') onResetPassword(user);
  }

  addBtn.addEventListener('click', onAddClick);
  tbody.addEventListener('click', onRowClick);

  (async function bootstrap() {
    await loadRoles();
    if (destroyed) return;
    await loadUsers();
  })();

  return function unmount() {
    destroyed = true;
    // 缺陷①：開著的彈窗（新增／修改使用者、重設密碼）要一併關掉，不能留在畫面上
    // 繼續浮著、繼續能按送出。close(null) 會順便拿掉 document 上的 keydown 監聽。
    for (const handle of openDialogHandles) {
      if (handle && typeof handle.close === 'function') handle.close(null);
    }
    openDialogHandles.clear();
    addBtn.removeEventListener('click', onAddClick);
    tbody.removeEventListener('click', onRowClick);
    if (card.parentNode) card.parentNode.removeChild(card);
  };
}
