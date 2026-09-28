/**
 * modules/audit-stock/views/stores.js — 月初盤點抽查・門市管理（2026-09-28）
 *
 * 會計新增／停用稽核門市。後端是 ~/mala-audit/apps-script/Code.gs 的
 * addStore／setStoreStatus（2026-09-28 新增，舊站 eason0728.github.io/mala-audit 的
 * 「門市管理」畫面打的是同一組 action）。
 *
 * - 門市清單讀 getAll 的 config.all_stores（含停用）；後端還沒更新時退回 config.stores。
 * - 新增：只填店名，店代碼由後端自動給（st-01、st-02…），同時在試算表建同名顯示分頁。
 * - 停用：不再出現在兩張稽核表的店別選單與總覽，歷史紀錄與顯示分頁都保留，可重新啟用。
 * - 改名（renameStore）：店代碼不變、歷史紀錄不受影響；試算表分頁原本跟店名同名才會跟著改。
 * - 門市清單是兩個稽核模組共用的，所以這裡寫入成功後 submit() 會 invalidate 共用快取，
 *   營運稽核表那邊下次讀到的也是新清單。
 *
 * 已知限制：dzy「人員管理」的所屬節點選單（apps-script/platform/Users.gs 的
 * USR_VALID_NODES、modules/users/views/list.js）仍是寫死的五店，
 * 新門市暫時不能指派店長帳號——那要動平台層，另案處理。
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
  (children || []).forEach((c) => { if (c) node.appendChild(c); });
  return node;
}

export function mountStores(root, ctx) {
  let destroyed = false;
  let stores = [];
  let busy = false;

  function canWrite() {
    return typeof ctx.can === 'function' ? ctx.can('audit.write') : false;
  }

  function render() {
    while (root.firstChild) root.removeChild(root.firstChild);

    if (!canWrite()) {
      root.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '門市管理' }),
        el('p', { class: 'field-hint', text: '僅會計可新增或停用門市。' })
      ]));
      return;
    }

    // ---- 新增門市 ----
    const input = el('input', {
      class: 'input', id: 'store-new-name', type: 'text', maxlength: '20',
      placeholder: '例：一悟燒肉竹北'
    });
    const addBtn = el('button', {
      class: 'btn btn-primary btn-block', id: 'store-add-btn', type: 'button', text: '新增門市'
    });
    addBtn.addEventListener('click', () => onAdd(input));
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title', text: '新增門市' }),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', for: 'store-new-name', text: '門市名稱' }),
        input,
        el('div', { class: 'field-hint', text: '新增後兩張稽核表的店別選單都會出現，試算表會自動多一個同名分頁。' })
      ]),
      addBtn
    ]));

    // ---- 門市清單 ----
    const tbody = el('tbody');
    stores.forEach((s) => {
      const toggle = el('button', {
        class: 'btn ' + (s.active ? 'btn-danger' : 'btn-secondary') + ' store-toggle',
        type: 'button',
        'data-store': s.code,
        text: s.active ? '停用' : '重新啟用'
      });
      toggle.addEventListener('click', () => onToggle(s));
      const renameBtn = el('button', {
        class: 'btn btn-secondary store-rename', type: 'button', 'data-store': s.code, text: '改名'
      });
      renameBtn.addEventListener('click', () => onRename(s));
      const nameCell = el('td', null, [
        document.createTextNode(s.name),
        s.active ? null : el('span', { class: 'tag tag-danger', text: '停用中' })
      ]);
      tbody.appendChild(el('tr', { 'data-store': s.code }, [nameCell, el('td', null, [renameBtn, document.createTextNode(' '), toggle])]));
    });
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title', text: '門市清單' }),
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'table', id: 'store-list' }, [
          el('thead', null, [el('tr', null, [el('th', { text: '門市' }), el('th', { text: '' })])]),
          tbody
        ])
      ]),
      el('p', { class: 'field-hint', text: '停用＝不再出現在店別選單與總覽，歷史紀錄與試算表分頁都保留。' })
    ]));
  }

  async function load() {
    ctx.ui.loading(true);
    try {
      const res = await sharedApi.getAll(ctx);
      if (destroyed) return;
      if (!res || res.ok !== true) {
        ctx.ui.toast((res && res.error) || '發生錯誤，請稍後再試', 'danger');
        return;
      }
      const config = (res.data && res.data.config) || {};
      stores = (config.all_stores && config.all_stores.length)
        ? config.all_stores
        : (config.stores || []).map((s) => ({ code: s.code, name: s.name, active: true, order: s.order }));
      render();
    } catch (err) {
      console.error('[audit-stock] 門市管理載入失敗', err);
      if (!destroyed) ctx.ui.toast('發生錯誤，請稍後再試', 'danger');
    } finally {
      if (!destroyed) ctx.ui.loading(false);
    }
  }

  async function write(action, payload, okText) {
    if (busy) return;
    busy = true;
    ctx.ui.loading(true);
    try {
      const res = await sharedApi.submit(ctx, action, payload);
      if (destroyed) return;
      if (!res || res.ok !== true) {
        ctx.ui.toast((res && res.error) || '沒有成功，請再試一次', 'danger');
        return;
      }
      ctx.ui.toast(res.data && res.data.dryRun ? '試跑模式：未實際寫入' : okText, 'ok');
      await load();
    } catch (err) {
      console.error('[audit-stock] 門市管理寫入失敗', err);
      if (!destroyed) ctx.ui.toast('網路不穩，這次沒有送出，請再試一次', 'danger');
    } finally {
      busy = false;
      if (!destroyed) ctx.ui.loading(false);
    }
  }

  async function onAdd(input) {
    const name = String(input.value || '').trim();
    if (!name) {
      ctx.ui.toast('請填門市名稱', 'warn');
      return;
    }
    if (!(await ctx.ui.confirm('確定新增門市「' + name + '」？'))) return;
    await write('addStore', { name }, '已新增「' + name + '」');
  }

  async function onRename(s) {
    const input = el('input', { class: 'input', id: 'store-rename-input', type: 'text', maxlength: '20' });
    input.value = s.name;
    const body = el('div', { class: 'field' }, [
      el('label', { class: 'field-label', for: 'store-rename-input', text: '新名稱' }),
      input,
      el('div', { class: 'field-hint', text: '歷史紀錄不受影響；試算表分頁原本跟店名同名的會一起改名。' })
    ]);
    const choice = await ctx.ui.dialog({
      title: '修改「' + s.name + '」名稱',
      body,
      actions: [
        { label: '取消', value: null, variant: 'secondary' },
        { label: '儲存', value: 'save', variant: 'primary' }
      ]
    });
    if (choice !== 'save') return;
    const name = String(input.value || '').trim();
    if (!name || name === s.name) return;
    await write('renameStore', { store: s.code, name }, '已把「' + s.name + '」改名為「' + name + '」');
  }

  async function onToggle(s) {
    const status = s.active ? '停用' : '啟用';
    const ask = s.active
      ? '確定停用「' + s.name + '」？停用後不會出現在店別選單與總覽，歷史紀錄保留，之後可重新啟用。'
      : '確定重新啟用「' + s.name + '」？';
    if (!(await ctx.ui.confirm(ask))) return;
    await write('setStoreStatus', { store: s.code, status },
      (s.active ? '已停用「' : '已重新啟用「') + s.name + '」');
  }

  load();

  return function unmount() {
    destroyed = true;
  };
}
