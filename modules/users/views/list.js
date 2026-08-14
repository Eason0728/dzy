/**
 * modules/users/views/list.js — 人員清單畫面（T1-11）
 *
 * 正本規格：docs/spec.md §4.3（角色→中文對照）、§4.4（節點代號→中文對照）、
 * §4.7（ctx 逐字元形狀）、§4.10（ctx.ui／ctx.fmt 簽章）、§5.2（四個 action 的
 * payload／回傳）。
 *
 * 設計說明（給下一個維護者）：
 * platform/ui.js 的 ctx.ui.dialog({title, body, actions}) 的 body 只接受純文字
 * （內部固定 `bodyEl.innerHTML = esc(body)`，見 platform/ui.js 與
 * test/ui.test.mjs 的斷言），沒有辦法塞進真正的 <input> 表單欄位。
 * 新增／修改使用者、重設密碼都需要收使用者輸入的文字（帳號、姓名、密碼），
 * 純文字訊息框做不到。
 *
 * 因此這裡「新增／修改」「重設密碼」用的表單彈窗是這個模組自己組的 DOM，
 * 但完全沿用 platform/css/components.css 既有的 class（.dialog-overlay／
 * .dialog／.dialog-title／.dialog-body／.dialog-actions／.field／
 * .field-label／.field-hint／.input／.btn／.btn-primary／.btn-secondary），
 * 不新增任何 class、不內嵌樣式、不碰 platform/ 一個字——單純是「表單彈窗」
 * 而非呼叫 ctx.ui.dialog() 這個函式本身。真正的是非二選一確認（停用／啟用、
 * 重設密碼前的二次確認）一律照規格用 ctx.ui.confirm()。
 * 這不是繞過平台層，而是平台層目前提供的 ui.dialog 本來就只設計給「訊息 + 按鈕」
 * 用，表單是模組自己的事——如果之後有更多模組也需要表單彈窗，才值得回頭跟平台
 * 提議加一個共用的表單彈窗原語。
 */
'use strict';

// ── §4.3 角色 → 中文 ──────────────────────────────────────
const ROLE_OPTIONS = [
  { value: 'admin', label: '系統管理者' },
  { value: 'manager', label: '部門主管' },
  { value: 'accountant', label: '會計' },
  { value: 'storelead', label: '店長' },
  { value: 'staff', label: '員工' }
];

// ── §4.4 節點代號 → 中文 ──────────────────────────────────
const NODE_OPTIONS = [
  { value: '', label: '不限節點' },
  { value: 'sxl-gf', label: '麻的小辛辣 光復店' },
  { value: 'ck', label: '中央廚房' },
  { value: 'mzt-gf', label: '墨竹亭 光復店' },
  { value: 'mzt-js', label: '墨竹亭 金山店' },
  { value: 'mzt-lzl', label: '墨竹亭 六張犁店' }
];

const ROLE_LABEL = {};
ROLE_OPTIONS.forEach((o) => { ROLE_LABEL[o.value] = o.label; });
const NODE_LABEL = {};
NODE_OPTIONS.forEach((o) => { NODE_LABEL[o.value] = o.label; });

const MIN_PASSWORD_LEN = 8;

function roleLabel(role) {
  return ROLE_LABEL[role] || role || '';
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
 * @returns {Promise<{username, name, role, node, password?}|null>} 取消回 null
 */
function openUserFormDialog(existingUser) {
  const isEdit = !!existingUser;

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
      label: '角色', options: ROLE_OPTIONS, name: 'role',
      value: isEdit ? existingUser.role : ROLE_OPTIONS[0].value
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
 * 取消／Esc／點背景 → resolve(null)。
 * @param {object} user
 * @returns {Promise<string|null>}
 */
function openPasswordDialog(user) {
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
      tr.appendChild(textCell(roleLabel(u.role)));
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
    const payload = await openUserFormDialog(null);
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
    const payload = await openUserFormDialog(user);
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
    const newPassword = await openPasswordDialog(user); // 太短已在彈窗裡被擋下，這裡拿到的一定是合格長度或 null
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

  loadUsers();

  return function unmount() {
    destroyed = true;
    addBtn.removeEventListener('click', onAddClick);
    tbody.removeEventListener('click', onRowClick);
    if (card.parentNode) card.parentNode.removeChild(card);
  };
}
