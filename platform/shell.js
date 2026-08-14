/**
 * platform/shell.js — 殼：開機、路由、導覽、掛載／卸載模組 (T1-8)
 *
 * 正本規格：docs/spec.md §4.5（manifest 格式）、§4.6（模組本體 mount/unmount/badge）、
 * §4.7（ctx 形狀）、§4.9（路由字串）、§6.1（開機流程）、§6.2（導覽兩層）。
 *
 * ⚠ 分層鐵律（本檔存在的理由）：這一支完全不認識任何一個具體模組。
 * 它只認得 registry.js 給的清單（每個項目是驗證過的 manifest 物件），
 * 一路只透過 manifest.id／manifest.ns／manifest.backend／manifest.views／manifest.entry
 * 這些「資料」在動作，不對任何特定字串值做 if 判斷。加一個新模組只要 registry.js
 * 多一行，這支程式碼一個字都不必改——這是這個任務唯一的失敗判準。
 *
 * 生命週期規則（任務指示第 6 點）：
 *   - 切「模組」前，先呼叫前一個模組本體的 unmount()（如果有），再呼叫新模組的
 *     mount(el, ctx)；mount() 若回傳函式，那個函式也視同 unmount，一併記錄、
 *     切走時一併呼叫。
 *   - 同一個模組內部切分頁，不重新 mount/unmount 整個模組——第二層分頁列（依
 *     manifest.views 動態產生）只是路由跳轉的觸發器，模組本體怎麼因應分頁切換是
 *     模組自己的事（ctx 沒有帶 viewId 這個欄位，殼也不該替模組決定這件事）。
 *
 * 開機（spec §6.1）：restore() 成功 → 進首頁；失敗 → 顯示登入頁（platform/views/login.js，
 * 已完成、不改）。登入成功時 login.js 會呼叫 app.onSuccess()，這裡接手往下走。
 *
 * 未登入的第二道保險（任務指示第 8 點）：即使有人手動改網址列的 hash，
 * 全域的 hashchange 監聽器一開頭就檢查 auth.getUser()，沒有身分一律不處理。
 */

'use strict';

import * as auth from './auth.js';
import { call as backendCall } from './api.js';
import * as ui from './ui.js';
import * as fmt from './fmt.js';
import { loadManifests } from './registry.js';
import { reportManifest } from './manifest-check.js';
import { render as renderLogin } from './views/login.js';

/** spec §4.6：badge() 逾時上限 5 秒，逾時視同 null（不得讓首頁壞掉）。 */
const BADGE_TIMEOUT_MS = 5000;

// ============================================================
// 模組層級狀態
// ============================================================

let rootEl = null;

let navMobileEl = null;
let navDesktopEl = null;
let viewNavEl = null;
let viewContentEl = null;

/** registry 載入、驗證過的全部 manifest（不論這個使用者有沒有權限） */
let allManifests = [];
/** 依 can() 過濾出「這個使用者有權限」的 manifest 清單——首頁卡片與第一層導覽只認這份 */
let permittedModules = [];

/** 目前掛載的模組（manifest）與分頁 id；home 畫面時兩者皆為 null */
let currentModule = null;
let currentView = null;
/** 目前掛載的模組本體（index.js 的 default export），供切走時呼叫它的 unmount() */
let currentModuleBody = null;
/** 目前掛載呼叫 mount() 時回傳的函式（若有），視同額外一個 unmount，切走時也要呼叫 */
let currentMountUnmount = null;

// ============================================================
// 小工具：DOM 建構（不用 innerHTML 塞結構——需要能被查、能被點的節點一律用
// createElement／appendChild 組，innerHTML 只用來清空)
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

function clearChildren(node) {
  if (!node || !node.children) return;
  while (node.children.length) node.removeChild(node.children[0]);
}

/** 由 startEl 往上找第一個帶有 attrName（可指定 attrValue）的祖先節點，找不到回 null。 */
function findAncestorWithAttr(startEl, attrName, attrValue) {
  let node = startEl;
  while (node && typeof node.getAttribute === 'function') {
    const v = node.getAttribute(attrName);
    if (v !== null && v !== undefined && (attrValue === undefined || v === attrValue)) return node;
    node = node.parentNode;
  }
  return null;
}

/** 在 root 底下深度優先找第一個符合 predicate 的子孫節點。 */
function findDescendant(root, predicate) {
  if (!root || !root.children) return null;
  for (const child of root.children) {
    if (predicate(child)) return child;
    const found = findDescendant(child, predicate);
    if (found) return found;
  }
  return null;
}

// ============================================================
// 路由字串解析／組裝（spec §4.9）
// ============================================================

/** '#/<moduleId>/<viewId>?<k>=<v>&...' → { moduleId, viewId, params } */
function parseHash(hash) {
  let h = String(hash || '');
  if (h.startsWith('#')) h = h.slice(1);
  if (h.startsWith('/')) h = h.slice(1);

  const qIndex = h.indexOf('?');
  const pathPart = qIndex === -1 ? h : h.slice(0, qIndex);
  const queryPart = qIndex === -1 ? '' : h.slice(qIndex + 1);

  const segments = pathPart.split('/').filter(Boolean);
  const moduleId = segments[0] || null;
  const viewId = segments[1] || null;

  const params = {};
  if (queryPart) {
    const usp = new URLSearchParams(queryPart);
    for (const [k, v] of usp.entries()) params[k] = v;
  }

  return { moduleId, viewId, params };
}

function buildQueryString(params) {
  if (!params || typeof params !== 'object') return '';
  const usp = new URLSearchParams();
  let has = false;
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
    has = true;
  }
  return has ? `?${usp.toString()}` : '';
}

/** 內部一律走這支：設定 hash 並立刻同步跑一次路由，不倚賴瀏覽器非同步觸發 hashchange。 */
function navigateTo(hash) {
  window.location.hash = hash;
  route();
}

// ============================================================
// 權限判斷（任一個 requires 符合即可，spec §4.5／任務指示第 2、4 點）
// ============================================================

function isModulePermitted(manifest) {
  const req = Array.isArray(manifest && manifest.requires) ? manifest.requires : [];
  return req.some((p) => auth.can(p));
}

function isViewPermitted(view) {
  const req = Array.isArray(view && view.requires) ? view.requires : [];
  if (req.length === 0) return true;
  return req.some((p) => auth.can(p));
}

// ============================================================
// ctx（spec §4.7，逐字元只准這 7 個欄位）
// ============================================================

function callModuleBackend(moduleId, action, payload) {
  const manifest = allManifests.find((m) => m.id === moduleId);
  if (!manifest) {
    return Promise.resolve({ ok: false, error: `殼找不到這個模組：${moduleId}` });
  }
  return backendCall(manifest.backend, action, payload);
}

const sharedApi = { call: callModuleBackend };

function buildCtx(manifest, params) {
  return {
    user: auth.getUser(),
    can: auth.can,
    api: sharedApi,
    ui,
    fmt,
    nav: (viewId, navParams) => navigateTo(`#/${manifest.id}/${viewId}${buildQueryString(navParams)}`),
    params: params || {}
  };
}

// ============================================================
// badge()：非同步、5 秒逾時、拋錯或逾時一律視同沒有數字（spec §4.6）
// ============================================================

function withTimeout(promiseOrValue, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);

    Promise.resolve(promiseOrValue)
      .then((v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v === undefined ? null : v);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      });
  });
}

async function loadBadge(manifest) {
  let body;
  try {
    const modBody = await manifest.entry();
    body = modBody && modBody.default;
  } catch (err) {
    console.error(`[shell] 模組本體載入失敗，badge 略過：${manifest.id}`, err);
    return;
  }
  if (!body || typeof body.badge !== 'function') return;

  const ctx = buildCtx(manifest, {});
  let raw;
  try {
    raw = body.badge(ctx);
  } catch (err) {
    console.error(`[shell] badge() 拋錯，該卡片不顯示數字：${manifest.id}`, err);
    return;
  }

  const value = await withTimeout(raw, BADGE_TIMEOUT_MS);
  if (typeof value !== 'number' || !Number.isFinite(value)) return;

  const badgeEl = findDescendant(
    viewContentEl,
    (n) => n.getAttribute && n.getAttribute('data-role') === 'badge' && n.getAttribute('data-module') === manifest.id
  );
  if (badgeEl) badgeEl.textContent = String(value);
}

// ============================================================
// 生命週期：unmount 前一個模組
// ============================================================

async function teardownCurrent() {
  if (currentModuleBody && typeof currentModuleBody.unmount === 'function') {
    try {
      await currentModuleBody.unmount();
    } catch (err) {
      console.error('[shell] 模組 unmount() 失敗', err);
    }
  }
  if (typeof currentMountUnmount === 'function') {
    try {
      await currentMountUnmount();
    } catch (err) {
      console.error('[shell] mount() 回傳的 unmount 函式失敗', err);
    }
  }
  currentModuleBody = null;
  currentMountUnmount = null;
  currentModule = null;
  currentView = null;
}

// ============================================================
// 導覽渲染（spec §6.2：兩層，事件委派各綁一次）
// ============================================================

function renderTopNav() {
  const activeId = currentModule ? currentModule.id : '__home__';
  const items = [{ id: '__home__', label: '首頁' }]
    .concat(permittedModules.map((m) => ({ id: m.id, label: m.name })))
    .concat([{ id: '__logout__', label: '登出' }]);

  const buildButtons = () =>
    items.map((it) =>
      el('button', {
        type: 'button',
        class: `nav-item${it.id === activeId ? ' is-active' : ''}`,
        'data-nav': it.id,
        text: it.label
      })
    );

  clearChildren(navMobileEl);
  buildButtons().forEach((b) => navMobileEl.appendChild(b));
  clearChildren(navDesktopEl);
  buildButtons().forEach((b) => navDesktopEl.appendChild(b));
}

function renderViewNav(manifest) {
  clearChildren(viewNavEl);
  if (!manifest) return;
  const views = manifest.views.filter(isViewPermitted);
  for (const v of views) {
    viewNavEl.appendChild(
      el('button', {
        type: 'button',
        class: `nav-item${v.id === currentView ? ' is-active' : ''}`,
        'data-view': v.id,
        text: v.name
      })
    );
  }
}

function renderHomeCards() {
  clearChildren(viewContentEl);
  for (const m of permittedModules) {
    const firstView = m.views.find(isViewPermitted);
    const target = firstView ? `#/${m.id}/${firstView.id}` : '#/home';
    const badgeEl = el('div', { 'data-role': 'badge', 'data-module': m.id });
    const card = el(
      'div',
      {
        class: 'card card-link',
        'data-role': 'module-card',
        'data-module': m.id,
        'data-target': target
      },
      [el('div', { class: 'card-title', text: m.name }), el('p', { class: 'text-muted', text: m.desc }), badgeEl]
    );
    viewContentEl.appendChild(card);
  }
  for (const m of permittedModules) loadBadge(m);
}

// ============================================================
// 事件委派（各綁一次，重畫內容不重綁——任務指示第 5 點）
// ============================================================

function onTopNavClick(e) {
  const btn = findAncestorWithAttr(e.target, 'data-nav');
  if (!btn) return;
  const id = btn.getAttribute('data-nav');

  if (id === '__logout__') {
    doLogout();
    return;
  }
  if (id === '__home__') {
    navigateTo('#/home');
    return;
  }
  const manifest = permittedModules.find((m) => m.id === id);
  if (!manifest) return;
  const firstView = manifest.views.find(isViewPermitted);
  if (!firstView) {
    ui.toast('沒有權限', 'warn');
    return;
  }
  navigateTo(`#/${manifest.id}/${firstView.id}`);
}

function onViewNavClick(e) {
  const btn = findAncestorWithAttr(e.target, 'data-view');
  if (!btn || !currentModule) return;
  const viewId = btn.getAttribute('data-view');
  navigateTo(`#/${currentModule.id}/${viewId}`);
}

function onViewContentClick(e) {
  const card = findAncestorWithAttr(e.target, 'data-role', 'module-card');
  if (!card) return;
  const target = card.getAttribute('data-target');
  if (target) navigateTo(target);
}

// ============================================================
// 畫面骨架（登入後才建立一次；委派監聽器綁在這幾個穩定容器上）
// ============================================================

function ensureShellDom() {
  clearChildren(rootEl);

  navMobileEl = el('nav', { class: 'bottom-nav', 'data-role': 'nav-mobile' });
  navDesktopEl = el('aside', { class: 'sidebar', 'data-role': 'nav-desktop' });
  viewNavEl = el('div', { class: 'section', 'data-role': 'view-nav' });
  viewContentEl = el('div', { 'data-role': 'view-content' });

  const pageEl = el('div', { class: 'page' }, [viewNavEl, viewContentEl]);
  const mainEl = el('div', { class: 'app-main' }, [pageEl]);
  const shellEl = el('div', { class: 'app-shell' }, [navMobileEl, navDesktopEl, mainEl]);

  rootEl.appendChild(shellEl);

  navMobileEl.addEventListener('click', onTopNavClick);
  navDesktopEl.addEventListener('click', onTopNavClick);
  viewNavEl.addEventListener('click', onViewNavClick);
  viewContentEl.addEventListener('click', onViewContentClick);
}

// ============================================================
// 首頁 / 模組掛載
// ============================================================

async function renderHome() {
  await teardownCurrent();
  renderTopNav();
  clearChildren(viewNavEl);
  renderHomeCards();
}

async function mountModuleView(manifest, view, params) {
  await teardownCurrent();
  currentModule = manifest;
  currentView = view.id;
  renderTopNav();
  renderViewNav(manifest);
  clearChildren(viewContentEl);

  const ctx = buildCtx(manifest, params);

  let body;
  try {
    const modBody = await manifest.entry();
    body = modBody && modBody.default;
  } catch (err) {
    console.error(`[shell] 模組本體載入失敗：${manifest.id}`, err);
    goHomeWithWarning();
    return;
  }
  if (!body || typeof body.mount !== 'function') {
    console.error(`[shell] 模組本體格式不符（缺 mount）：${manifest.id}`);
    goHomeWithWarning();
    return;
  }

  let maybeUnmount;
  try {
    maybeUnmount = await body.mount(viewContentEl, ctx);
  } catch (err) {
    console.error(`[shell] 模組掛載失敗：${manifest.id}`, err);
    goHomeWithWarning();
    return;
  }

  currentModuleBody = body;
  currentMountUnmount = typeof maybeUnmount === 'function' ? maybeUnmount : null;
}

function goHomeWithWarning() {
  ui.toast('沒有權限', 'warn');
  navigateTo('#/home');
}

// ============================================================
// 路由（spec §4.9）
// ============================================================

function route() {
  if (!auth.getUser()) return; // 第二道保險：沒登入絕不處理路由

  const { moduleId, viewId, params } = parseHash(window.location.hash);

  if (!moduleId || moduleId === 'home') {
    renderHome();
    return;
  }

  const manifest = permittedModules.find((m) => m.id === moduleId);
  if (!manifest) {
    goHomeWithWarning();
    return;
  }

  const view = viewId ? manifest.views.find((v) => v.id === viewId) : manifest.views.find(isViewPermitted);
  if (!view || !isViewPermitted(view)) {
    goHomeWithWarning();
    return;
  }

  if (currentModule && currentModule.id === manifest.id) {
    // 同一模組內切分頁：模組本體已經掛著，殼只更新導覽狀態，不重新 mount/unmount
    // （ctx 沒有 viewId 欄位，模組本體自己決定怎麼因應分頁切換）
    currentView = view.id;
    renderTopNav();
    renderViewNav(manifest);
    return;
  }

  mountModuleView(manifest, view, params);
}

// ============================================================
// 開機 / 登入 / 登出（spec §6.1）
// ============================================================

async function enterApp() {
  ensureShellDom();
  const loaded = await loadManifests(reportManifest);
  allManifests = loaded;
  permittedModules = loaded.filter(isModulePermitted);
  route();
}

function showLogin() {
  clearChildren(rootEl);
  const loginRoot = el('div', { 'data-role': 'login-root' });
  rootEl.appendChild(loginRoot);
  renderLogin(loginRoot, { onSuccess: () => { enterApp(); } });
}

async function doLogout() {
  await teardownCurrent();
  auth.logout();
  allManifests = [];
  permittedModules = [];
  window.location.hash = '';
  showLogin();
}

export async function boot(mountEl) {
  rootEl = mountEl;
  const ok = await auth.restore();
  if (ok) {
    await enterApp();
  } else {
    showLogin();
  }
}

// 第二道保險：不管什麼原因（手動改網址列、上一頁/下一頁……）觸發 hashchange，
// 沒有登入身分一律不處理，畫面就停在登入頁不動。
window.addEventListener('hashchange', () => {
  if (!auth.getUser()) return;
  route();
});

// index.html 只有 <div id="app"> 與這支 script，殼自己找到掛載點並開機。
const __mountEl = document.getElementById('app');
if (__mountEl) {
  await boot(__mountEl);
}
