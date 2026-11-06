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
 *     manifest.views 動態產生）只是路由跳轉的觸發器。殼會「原地」更新模組已經拿到
 *     的那個 ctx 物件的 viewId／params（不是換一個新物件，模組可能已經把 ctx 存起來），
 *     並在模組有實作選填的 onRoute(ctx) 時呼叫它一次；沒實作的模組行為不變
 *     （spec §4.6／§4.7，2026-08-15 對抗審查後補的契約，修正原本 ctx 沒有分頁狀態的缺陷）。
 *
 * 導覽只跑一次路由（2026-08-15 對抗審查後修正）：navigateTo(hash) 只改 window.location.hash，
 * 真的改變時完全依賴瀏覽器隨後觸發的 hashchange 事件去跑 route()，不在這裡再直接呼叫一次
 * ——原本「改 hash 又立刻呼叫 route()」在 hash 真的變動時會讓 hashchange 事件重複觸發一次
 * route()，模組因此被掛載兩次。只有「設成目前這個值」這種瀏覽器不會觸發 hashchange 的情況
 * （例如點目前已經在的那一頁），才由 navigateTo 自己補呼叫一次 route()，維持「點下去一定會
 * 重新走一次路由」的行為。
 *
 * 開機（spec §6.1）：restore() 成功 → 進首頁；失敗 → 顯示登入頁（platform/views/login.js，
 * 已完成、不改）。登入成功時 login.js 會呼叫 app.onSuccess()，這裡接手往下走。
 *
 * 未登入的第二道保險（任務指示第 8 點）：即使有人手動改網址列的 hash，
 * 全域的 hashchange 監聽器一開頭就檢查 auth.getUser()，沒有身分一律不處理。
 */

'use strict';

import * as auth from './auth.js';
import { call as backendCall, setSessionExpiredHandler } from './api.js';
import { setDryRunNotifier } from './dryrun.js';
import * as ui from './ui.js';
import * as fmt from './fmt.js';
import { loadManifests } from './registry.js';
import { DEPARTMENTS, WORK_GROUPS } from './config.js';
import { reportManifest } from './manifest-check.js';
import { render as renderLogin } from './views/login.js';
import { sanitizeTabs, pickDynamicView, alertViewId } from './tabs.js';

/** spec §4.6：badge() 逾時上限 5 秒，逾時視同 null（不得讓首頁壞掉）。 */
const BADGE_TIMEOUT_MS = 5000;

// ============================================================
// 模組層級狀態
// ============================================================

let rootEl = null;

let navDesktopEl = null;
let sideNavEl = null;
let sideUserEl = null;
let pageTitleEl = null;
let pageSubEl = null;
let viewNavEl = null;
let viewContentEl = null;
/** 保留中的嵌入模組（manifest.keepAlive 毫秒，2026-10-20 Eason：切走保留 30 分鐘、登出管理系統一起登出）：
 *  每個這種模組掛在自己的容器（keepRootEl 底下），切走時只藏起來、不 unmount，iframe 不會重新載入。 */
let keepRootEl = null;
let currentHost = null;
const parked = new Map();   // moduleId → { host, body, unmount, ctx, timer }

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
/** 目前掛載模組拿到的那個 ctx 物件（spec §4.7）——同模組內換分頁／params 改變時，
 *  要原地更新這個物件本身的 viewId／params，不能換一個新物件（模組可能已經存起來）。 */
let currentCtx = null;
/** 動態分頁（platform/tabs.js）：模組 id → 該模組最近一次交來的分頁 */
const dynTabs = {};

/** 手機版（≤860px，2026-11-06）：上方一行頁名、底部四格。電腦版由 CSS 藏起來。 */
let mBarEl = null;
let mTitleEl = null;
let mBackEl = null;
let mTabsEl = null;
/** 目前在哪個殼頁面（home／apps／todo／account）；模組畫面時為 null */
let currentShellPage = null;
/** 最近一次的殼頁面：模組頁的「‹」回這裡 */
let lastShellPage = 'home';
/** 各模組 badge()／alerts() 的最近一次結果：moduleId → {items, badge, failed}（首頁與「待處理」共用） */
const alertCache = {};

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

/**
 * 內部一律走這支：改 window.location.hash。
 * hash 真的變了 → 只依賴瀏覽器隨後觸發的 hashchange 事件去跑 route()，這裡不再直接呼叫，
 * 避免 route() 在同一次導覽裡跑兩次（模組被掛載兩次／unmount-mount 與 manifest.entry()
 * 的非同步載入互相競態，見檔頭說明）。
 * hash 沒有變（設成目前這個值，瀏覽器不會觸發 hashchange）→ 自己補呼叫一次 route()，
 * 讓「點目前已經在的那一頁」仍然正確重跑一次路由。
 */
function navigateTo(hash) {
  const previousHash = window.location.hash;
  window.location.hash = hash;
  if (window.location.hash === previousHash) {
    route();
  }
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
// ctx（spec §4.7，逐字元只准這 8 個欄位——2026-08-15 對抗審查後多了 viewId）
// ============================================================

function callModuleBackend(moduleId, action, payload) {
  // 先按 moduleId 查（spec §4.7 的字面契約）；查不到再按 backend／ns fallback
  // （2026-08-17 修）。原因：spec §6.4 規定 audit-stock／audit-ops 共用一支資料層
  // modules/audit-shared/api.js，那支「共用層」不隸屬任何單一模組，沒有合法的
  // moduleId 可傳，實際傳的是 backend 名 'audit'——只認 moduleId 會讓兩個稽核模組
  // 的每一次後端呼叫都拿到「殼找不到這個模組」（dorm 是 id 恰好等於 backend 才沒事）。
  // §4.1 已約束 backend 必須等於 ns，同 backend 的多個 manifest 解析出的也是同一支
  // 後端，這個 fallback 是純放寬、不改任何既有行為（shell.test.mjs 測試 7 照舊全綠）。
  const manifest = allManifests.find((m) => m.id === moduleId)
    || allManifests.find((m) => m.backend === moduleId);
  if (!manifest) {
    return Promise.resolve({ ok: false, error: `殼找不到這個模組：${moduleId}` });
  }
  return backendCall(manifest.backend, action, payload);
}

const sharedApi = { call: callModuleBackend };
setDryRunNotifier((msg) => ui.toast(msg, 'warn'));

/**
 * @param {object} manifest
 * @param {string|null} viewId 目前分頁 id；badge() 不對應任何已掛載的分頁，固定傳 null（spec §4.7）
 * @param {object} params
 */
function buildCtx(manifest, viewId, params) {
  return {
    user: auth.getUser(),
    auditScope: auth.getAuditScope(), // 後端 audit_scope：'all'｜'none'｜店別代碼陣列｜null（舊後端）
    can: auth.can,
    api: sharedApi,
    ui,
    fmt,
    // 只有這個模組正在畫面上時才換網址（保留中的模組在背景收到訊息，不可以把使用者拉回去）
    nav: (targetViewId, navParams) => {
      if (!currentModule || currentModule.id !== manifest.id) return;
      navigateTo(`#/${manifest.id}/${targetViewId}${buildQueryString(navParams)}`);
    },
    viewId,
    params: params || {},
    // 動態分頁（2026-10-20）：只有 manifest.dynamicTabs 的模組才有，回傳 true＝已更新
    ...(manifest.dynamicTabs ? { tabs: (list) => setModuleTabs(manifest.id, list) } : {})
  };
}

function setModuleTabs(moduleId, list) {
  const clean = sanitizeTabs(list);
  if (!clean) return false;
  dynTabs[moduleId] = clean;
  if (currentModule && currentModule.id === moduleId) renderViewNav(currentModule);
  return true;
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

/** 首頁一組最多顯示幾列提醒；超過的收成一列「還有 N 項」。 */
const ALERTS_MAX_ROWS = 8;
const ALERT_LEVELS = ['error', 'warn', 'info'];

function findGroupBody(moduleId) {
  return findDescendant(
    viewContentEl,
    (n) => n.getAttribute && n.getAttribute('data-role') === 'alert-list' && n.getAttribute('data-module') === moduleId
  );
}

function alertRow(level, text, target) {
  return el('div', {
    class: `todo-row lv-${level}`,
    'data-role': 'alert-row',
    'data-target': target || null,
    role: target ? 'link' : null,
    tabindex: target ? '0' : null
  }, [el('span', { class: 'tx', text }), target ? el('span', { class: 'go', 'aria-hidden': 'true', text: '›' }) : null]);
}

/** 把模組 alerts() 的一項轉成路由字串（規則在 platform/tabs.js alertViewId）。沒有 view 的提醒列 → null＝只顯示、不給連結（2026-10-29）。 */
function alertTarget(manifest, item) {
  const viewId = alertViewId(manifest, item, isViewPermitted);
  if (!viewId) return null;
  const params = item.params && typeof item.params === 'object' ? item.params : null;
  return `#/${manifest.id}/${viewId}${buildQueryString(params)}`;
}

/** 殼自己加的列（件數、模組說明、「還有 N 項」）→ 模組第一個有權限的分頁 */
function moduleHomeTarget(manifest) {
  const view = manifest.views.find(isViewPermitted);
  return view ? `#/${manifest.id}/${view.id}` : null;
}

function fillGroup(manifest, items, badgeValue, failed) {
  const body = findGroupBody(manifest.id);
  if (!body) return;
  clearChildren(body);
  if (failed) {
    body.appendChild(alertRow('note', '暫時讀不到'));
    return;
  }
  if (items === null) {
    // 模組沒實作 alerts()：有 badge 數字就顯示件數，沒有就放模組說明
    if (typeof badgeValue === 'number' && badgeValue > 0) {
      body.appendChild(alertRow('warn', `${badgeValue} 件待處理`, moduleHomeTarget(manifest)));
    } else if (badgeValue === 0) {
      body.appendChild(el('div', { class: 'todo-empty', text: '沒有待辦' }));
    } else {
      body.appendChild(alertRow('note', manifest.desc, moduleHomeTarget(manifest)));
    }
    return;
  }
  if (!items.length) {
    body.appendChild(el('div', { class: 'todo-empty', text: '沒有待辦' }));
    return;
  }
  items.slice(0, ALERTS_MAX_ROWS).forEach((it) => body.appendChild(alertRow(it.level, it.text, alertTarget(manifest, it))));
  if (items.length > ALERTS_MAX_ROWS) {
    body.appendChild(alertRow('note', `還有 ${items.length - ALERTS_MAX_ROWS} 項`, moduleHomeTarget(manifest)));
  }
}

/** alerts() 回傳值清洗：只收 {level,text} 形狀正確的項目；整個不是陣列＝算不出來。 */
function cleanAlerts(raw) {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((it) => it && typeof it.text === 'string' && it.text)
    .map((it) => ({
      level: ALERT_LEVELS.includes(it.level) ? it.level : 'info',
      text: it.text,
      view: typeof it.view === 'string' ? it.view : null,
      params: it.params
    }));
}

/**
 * 首頁每一組：載模組本體 → 並行跑 badge() 與（選填的）alerts()，各自 5 秒逾時、拋錯視同算不出來
 * （spec §4.6）。badge 數字寫進卡片與側邊欄；alerts 畫成提醒列。
 */
async function loadHomeGroup(manifest, isStale) {
  let body;
  try {
    const modBody = await manifest.entry();
    body = modBody && modBody.default;
  } catch (err) {
    console.error(`[shell] 模組本體載入失敗，首頁這組略過：${manifest.id}`, err);
    if (!isStale()) fillGroup(manifest, null, null, true);
    return;
  }
  if (!body) return;

  const run = (fnName) => {
    if (typeof body[fnName] !== 'function') return Promise.resolve(undefined);
    let raw;
    try {
      raw = body[fnName](buildCtx(manifest, null, {}));
    } catch (err) {
      console.error(`[shell] ${fnName}() 拋錯：${manifest.id}`, err);
      return Promise.resolve(null);
    }
    return withTimeout(raw, BADGE_TIMEOUT_MS);
  };

  const hasAlerts = typeof body.alerts === 'function';
  const [badgeRaw, alertsRaw] = await Promise.all([run('badge'), run('alerts')]);

  const value = typeof badgeRaw === 'number' && Number.isFinite(badgeRaw) ? badgeRaw : null;
  // 手機首頁與「待處理」讀這份（不論使用者是否已切走，結果都留著）
  const cleaned = hasAlerts ? cleanAlerts(alertsRaw) : null;
  if (auth.getUser()) {
    alertCache[manifest.id] = { items: cleaned === undefined ? null : cleaned, badge: value, failed: cleaned === undefined };
    onAlertsChanged();
  }
  if (isStale()) return;
  if (value !== null) {
    const badgeEl = findDescendant(
      viewContentEl,
      (n) => n.getAttribute && n.getAttribute('data-role') === 'badge' && n.getAttribute('data-module') === manifest.id
    );
    // 0 不顯示（照營運系統：沒有待辦就不掛數字）
    if (badgeEl) badgeEl.textContent = value > 0 ? String(value) : '';
    setNavBadge(manifest.id, value);
  }

  if (hasAlerts) {
    fillGroup(manifest, cleaned === undefined ? null : cleaned, value, cleaned === undefined);
  } else {
    fillGroup(manifest, null, value, false);
  }
}

// ============================================================
// 生命週期：unmount 前一個模組
// ============================================================

async function teardownCurrent(opts) {
  const destroy = !!(opts && opts.destroy);
  if (!destroy && currentModule && currentModule.keepAlive > 0 && currentHost) {
    // 保留：藏起來、計時，時間到才真的卸載
    const id = currentModule.id;
    const entry = { host: currentHost, body: currentModuleBody, unmount: currentMountUnmount, ctx: currentCtx, timer: null };
    entry.host.hidden = true;
    entry.timer = setTimeout(() => { destroyParked(id); }, currentModule.keepAlive);
    parked.set(id, entry);
    currentHost = null;
    currentModuleBody = null;
    currentMountUnmount = null;
    currentModule = null;
    currentView = null;
    currentCtx = null;
    return;
  }
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
  currentCtx = null;
  if (currentHost) { if (currentHost.parentNode) currentHost.parentNode.removeChild(currentHost); currentHost = null; }
}

/** 清內容區，但保留中的模組（keepRootEl）不動 */
function clearView() {
  for (const c of [...viewContentEl.children]) if (c !== keepRootEl) viewContentEl.removeChild(c);
}

/** 真的卸載一個保留中的模組（時間到、或登出）：照一般流程呼叫 unmount，再移掉它的容器 */
async function destroyParked(id) {
  const e = parked.get(id);
  if (!e) return;
  parked.delete(id);
  clearTimeout(e.timer);
  if (e.body && typeof e.body.unmount === 'function') {
    try { await e.body.unmount(); } catch (err) { console.error('[shell] 模組 unmount() 失敗', err); }
  }
  if (typeof e.unmount === 'function') {
    try { await e.unmount(); } catch (err) { console.error('[shell] mount() 回傳的 unmount 函式失敗', err); }
  }
  if (e.host.parentNode) e.host.parentNode.removeChild(e.host);
}

async function destroyAllParked() {
  for (const id of [...parked.keys()]) await destroyParked(id);
}

// ============================================================
// 導覽渲染（spec §6.2：兩層，事件委派各綁一次）
// ============================================================

/** 角色代號 → 中文（spec §4.3 平台層的角色表；查不到就顯示原代號，不讓畫面壞掉）。 */
/** 各模組最近一次 badge() 的數字：側邊欄每次切頁都會重畫，要靠這份補回件數。 */
const navBadgeCache = {};
/** 側邊欄部門的展開狀態：使用者點過的才記（true／false）；沒點過＝有功能就展開、空的收合 */
const deptOpenState = new Map();

const ROLE_ZH = { admin: '系統管理者', manager: '總監', accountant: '會計', storelead: '店長', staff: '員工' };

/**
 * 名字下方的身分文字（2026-10-26 Eason：顯示職稱）：同仁帳號（role staff）顯示「品牌（總部人員＝部門）＋職稱」，
 * 由 myProfile 的 brand_name／dept_name／title_name 取得（每次載入頁面只問一次，回來再補畫）；系統帳號、還沒拿到、沒有職稱 → 照舊顯示角色。
 */
const navTitle = { uid: null, text: '' };
function roleLabel(user) {
  if (user.role === 'staff' && navTitle.uid === user.id && navTitle.text) return navTitle.text;
  return ROLE_ZH[user.role] || user.role || '';
}
function loadNavTitle(user) {
  if (user.role !== 'staff' || !user.id || navTitle.uid === user.id) return;
  navTitle.uid = user.id;
  navTitle.text = '';
  // 取不到（斷網、忙碌）就把 uid 清掉，下一次重畫側邊欄（切頁）再試一次
  const retryLater = () => { if (navTitle.uid === user.id && !navTitle.text) navTitle.uid = null; };
  backendCall('platform', 'myProfile', {}).then((res) => {
    const d = (res && res.ok && res.data) || {};
    const now = auth.getUser() || {};
    if (!res || !res.ok) { retryLater(); return; }
    if (!d.title_name || navTitle.uid !== user.id || now.id !== user.id) return;
    // 2026-10-26 Eason：職稱前加品牌名稱；總部人員（有部門）改加部門名稱。例：墨竹亭 店長、資訊部 總監
    navTitle.text = [d.dept_name || d.brand_name, d.title_name].filter(Boolean).map(String).join(' ');
    const rl = findDescendant(sideUserEl, (n) => n.className === 'rl');
    if (rl) rl.textContent = navTitle.text;
    pageSubEl.textContent = [now.name, navTitle.text].filter(Boolean).join('・');
  }).catch(retryLater);
}

/**
 * 左側深色側邊欄（外觀照門市營運系統 ~/mala-store-ops/web/js/shell.js sidebarHtml，2026-10-11）：
 * 品牌 → 首頁 → 我的資料 →「部門」標籤 → 十一個部門（可展開，功能依 manifest.dept 掛上）→ 底部使用者區（改密碼／登出）。
 * 手機（≤860px）由 CSS 改成「上排品牌＋使用者、下排圖示選單」，同一份 DOM，不另做第二份導覽。
 */
function renderTopNav() {
  const activeId = currentModule ? currentModule.id : '__home__';

  const navItem = (id, label, iconNode) => el('button', {
    type: 'button',
    class: `nav-item${id === activeId ? ' is-active' : ''}`,
    'data-nav': id,
    'aria-current': id === activeId ? 'page' : null
  }, [el('span', { class: 'ic', 'aria-hidden': 'true' }, [iconNode]), el('span', { class: 'lb', text: label })]);

  // 圖示＝manifest.icon（資料），殼不對值做 if 判斷
  const moduleItem = (m) => navItem(m.id, m.name, el('img', { src: `assets/icons/${m.icon}.png`, alt: '' }));

  clearChildren(sideNavEl);
  sideNavEl.appendChild(navItem('__home__', '首頁', el('img', { src: 'assets/icons/home.png', alt: '' })));
  // 沒掛部門的模組（我的資料）排在首頁下面
  for (const m of permittedModules) if (!m.dept) sideNavEl.appendChild(moduleItem(m));

  // 部門分組（2026-10-16）：有功能的預設展開，點標題切換。手機版由 CSS 隱藏部門標題、把功能攤平成下排圖示（同一份 DOM）。
  // 2026-10-26 Eason：登入者沒有任何功能的部門整個不顯示；一個部門都沒有就連「部門」標籤也不畫。
  if (currentModule && currentModule.dept) deptOpenState.set(currentModule.dept, true);
  const visibleDepts = DEPARTMENTS
    .map((d) => ({ d, mods: permittedModules.filter((m) => m.dept === d.id) }))
    .filter((x) => x.mods.length > 0);
  if (visibleDepts.length) sideNavEl.appendChild(el('div', { class: 'nav-label', text: '部門' }));
  for (const { d, mods } of visibleDepts) {
    const open = deptOpenState.has(d.id) ? deptOpenState.get(d.id) : true;
    const head = el('button', {
      type: 'button',
      class: 'nav-dept-head',
      'data-nav-dept': d.id,
      'aria-expanded': open ? 'true' : 'false'
    }, [
      el('span', { class: 'arrow', 'aria-hidden': 'true', text: open ? '▾' : '▸' }),
      el('span', { class: 'lb', text: d.name }),
      el('span', { class: 'cnt', text: String(mods.length) })
    ]);
    const items = el('div', { class: 'nav-dept-items' }, mods.map(moduleItem));
    sideNavEl.appendChild(el('div', { class: `nav-dept${open ? ' is-open' : ''}`, 'data-dept': d.id }, [head, items]));
  }
  for (const m of permittedModules) if (navBadgeCache[m.id]) setNavBadge(m.id, navBadgeCache[m.id]);

  const user = auth.getUser() || {};
  clearChildren(sideUserEl);
  sideUserEl.appendChild(el('div', { class: 'av', 'aria-hidden': 'true', text: '🙂' }));
  sideUserEl.appendChild(el('div', { class: 'su-main' }, [
    el('div', { class: 'nm', text: user.name || '' }),
    el('div', { class: 'rl', text: roleLabel(user) })
  ]));
  // 修改密碼是平台層自己的功能（不是模組），所有登入者都看得到，不需要任何權限碼。
  sideUserEl.appendChild(el('div', { class: 'su-act' }, [
    el('button', { type: 'button', 'data-nav': '__password__', text: '改密碼' }),
    el('button', { type: 'button', 'data-nav': '__logout__', text: '登出' })
  ]));

  // 內容區頂端頁名：首頁顯示「首頁」、模組顯示模組名；副標＝登入者
  pageTitleEl.textContent = currentModule ? currentModule.name : '待辦與異常';
  pageSubEl.textContent = [user.name, roleLabel(user)].filter(Boolean).join('・');
  loadNavTitle(user);
  renderMobileBar();
}

/** 側邊欄模組名稱右側的待辦件數（與首頁卡片同一個 badge() 結果；0／沒數字不顯示）。 */
function setNavBadge(moduleId, value) {
  navBadgeCache[moduleId] = value;
  const item = findDescendant(sideNavEl, (n) => n.getAttribute && n.getAttribute('data-nav') === moduleId);
  if (!item) return;
  const old = findDescendant(item, (n) => n.className === 'badge');
  if (old) item.removeChild(old);
  if (!value) return;
  item.appendChild(el('i', { class: 'badge', text: String(value), 'aria-label': `${value} 件待處理` }));
}

function renderViewNav(manifest) {
  clearChildren(viewNavEl);
  if (!manifest) return;
  if (manifest.dynamicTabs) {
    for (const t of dynTabs[manifest.id] || []) {
      const kids = [el('span', { text: t.name })];
      if (t.badge) kids.push(el('i', { class: `badge${t.err ? ' err' : ''}`, text: String(t.badge), 'aria-label': `${t.badge} 件待處理` }));
      viewNavEl.appendChild(el('button', { type: 'button', class: `nav-item${t.id === currentView ? ' is-active' : ''}`, 'data-view': t.id }, kids));
    }
    return;
  }
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

/** 每次重畫首頁 +1；非同步回來的結果若不是這一輪的就丟掉（使用者已經切走）。 */
let homeToken = 0;

/**
 * 首頁＝「待辦與異常」（外觀照門市營運系統首頁，2026-10-11）：每個有權限的模組一組，
 * 組頭是模組名＋件數，組內是模組 alerts() 回來的提醒列（點了直接進對應分頁）。
 * 先畫骨架（讀取中…），各組再非同步填。整組卡片點了也能進模組（data-role="module-card"）。
 */
function renderHomeCards() {
  clearView();
  const tok = ++homeToken;
  const isStale = () => tok !== homeToken || currentModule !== null;
  // 手機（≤860px）：先畫「今天要處理的事＋常用」，電腦版卡片接在後面、由 CSS 藏起來（.d-only，資料與 e2e 共用）。
  // 電腦版不畫手機區塊：藏起來的那份排在前面，用文字找元素時會先找到看不見的（2026-11-06 e2e 踩過）。
  const mobile = isMobileWidth();
  if (mobile) viewContentEl.appendChild(renderMobileHome());
  const wrap = el('div', { class: mobile ? 'todo-groups d-only' : 'todo-groups', 'aria-live': 'polite' });
  viewContentEl.appendChild(wrap);
  for (const m of permittedModules) {
    const firstView = m.views.find(isViewPermitted);
    const target = firstView ? `#/${m.id}/${firstView.id}` : '#/home';
    const head = el('div', { class: 'todo-head' }, [
      // 圖示檔名＝manifest.icon（manifest-check 已驗過是合法 id），殼只拿它當資料組路徑。
      el('img', { class: 'module-icon', src: `assets/icons/${m.icon}.png`, alt: '' }),
      el('div', { class: 'card-title', text: m.name }),
      el('div', { class: 'module-badge', 'data-role': 'badge', 'data-module': m.id })
    ]);
    const list = el('div', { class: 'todo-body', 'data-role': 'alert-list', 'data-module': m.id }, [
      el('div', { class: 'todo-empty', text: '讀取中…' })
    ]);
    wrap.appendChild(el('section', {
      class: 'card todo-group module-card',
      'data-role': 'module-card',
      'data-module': m.id,
      'data-target': target
    }, [head, list]));
  }
  for (const m of permittedModules) loadHomeGroup(m, isStale);
}

// ============================================================
// 事件委派（各綁一次，重畫內容不重綁——任務指示第 5 點）
// ============================================================

function onTopNavClick(e) {
  const deptBtn = findAncestorWithAttr(e.target, 'data-nav-dept');
  if (deptBtn) {
    const d = deptBtn.getAttribute('data-nav-dept');
    deptOpenState.set(d, deptBtn.getAttribute('aria-expanded') !== 'true');
    renderTopNav();
    return;
  }
  const btn = findAncestorWithAttr(e.target, 'data-nav');
  if (!btn) return;
  const id = btn.getAttribute('data-nav');

  if (id === '__logout__') {
    doLogout();
    return;
  }
  if (id === '__password__') {
    openChangePassword();
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
  const act = findAncestorWithAttr(e.target, 'data-m-act');
  if (act) {
    onMobileAct(act.getAttribute('data-m-act'));
    return;
  }
  const tile = findAncestorWithAttr(e.target, 'data-role', 'm-tile');
  if (tile) {
    const t = tile.getAttribute('data-target');
    if (t) navigateTo(t);
    return;
  }
  const row = findAncestorWithAttr(e.target, 'data-role', 'alert-row');
  if (row) {
    const t = row.getAttribute('data-target');
    if (t) navigateTo(t);
    return;
  }
  const card = findAncestorWithAttr(e.target, 'data-role', 'module-card');
  if (!card) return;
  const target = card.getAttribute('data-target');
  if (target) navigateTo(target);
}

// ============================================================
// 手機版（≤860px，2026-11-06 Eason：底部四格「首頁／功能／待處理／我」、首頁只列要處理的事、
// 功能照工作分類、每頁右上角「?」問小幫手）。電腦版側邊欄與首頁卡片不動：
// 上方列與底部四格由 CSS 只在手機寬度顯示（.m-bar、.m-tabs）；首頁手機區塊只在手機寬度畫（isMobileWidth）。
// ============================================================

const SHELL_PAGES = { home: '首頁', apps: '功能', todo: '待處理', account: '我' };
const MOBILE_MQ = '(max-width: 860px)';

function isMobileWidth() {
  try { return !!(window.matchMedia && window.matchMedia(MOBILE_MQ).matches); } catch (e) { return false; }
}
/** 首頁停著時跨過 860px（轉橫、拉視窗）→ 重畫成另一種首頁 */
function watchMobileWidth() {
  try {
    const mq = window.matchMedia && window.matchMedia(MOBILE_MQ);
    if (!mq) return;
    const onChange = () => { if (currentShellPage === 'home' && !currentModule && auth.getUser()) renderHomeCards(); };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onChange);
  } catch (e) { /* 沒有 matchMedia（測試環境）＝當電腦版 */ }
}
const TODO_LEVELS = [
  { level: 'error', name: '要緊' },
  { level: 'warn', name: '待處理' },
  { level: 'info', name: '提醒' }
];
/** 手機首頁最多列幾件，其餘收成「還有 N 件 → 看全部」 */
const HOME_TODO_MAX = 6;
const RECENT_MAX = 6;
/** 底部四格圖示（固定字串，不含任何使用者資料） */
const TAB_ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
  apps: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  todo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>',
  account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>'
};

/** 全部模組的提醒攤平成一條清單（照 permittedModules 順序）；沒實作 alerts() 但 badge>0 的算一筆「N 件待處理」 */
function collectTodos() {
  const items = [];
  let loading = 0;
  let failed = 0;
  for (const m of permittedModules) {
    const c = alertCache[m.id];
    if (!c) { loading++; continue; }
    if (c.failed) { failed++; continue; }
    if (c.items) {
      for (const it of c.items) items.push({ m, level: it.level, text: it.text, target: alertTarget(m, it) || moduleHomeTarget(m) });
    } else if (typeof c.badge === 'number' && c.badge > 0) {
      items.push({ m, level: 'warn', text: `${c.badge} 件待處理`, target: moduleHomeTarget(m) });
    }
  }
  return { items, loading, failed };
}

/** 模組磚右上角的數字：要緊＋待處理的件數（提醒不算） */
function tileCount(m) {
  const c = alertCache[m.id];
  if (!c || c.failed) return 0;
  if (c.items) return c.items.filter((it) => it.level !== 'info').length;
  return typeof c.badge === 'number' && c.badge > 0 ? c.badge : 0;
}

function todoRow(t) {
  return el('div', {
    class: `m-row lv-${t.level}`,
    'data-role': 'alert-row',
    'data-target': t.target || null,
    role: t.target ? 'link' : null,
    tabindex: t.target ? '0' : null
  }, [
    el('img', { class: 'm-ic', src: `assets/icons/${t.m.icon}.png`, alt: '' }),
    el('span', { class: 'm-tx' }, [el('span', { class: 'm-t', text: t.text }), el('small', { text: t.m.name })]),
    t.target ? el('span', { class: 'go', 'aria-hidden': 'true', text: '›' }) : null
  ]);
}

/** 依 box 上的 data-max（0＝不限）、data-levels 畫清單；首頁與「待處理」共用 */
function fillTodoBox(box) {
  const max = Number(box.getAttribute('data-max')) || 0;
  const levels = String(box.getAttribute('data-levels') || '').split(',');
  const { items, loading, failed } = collectTodos();
  const list = items.filter((t) => levels.includes(t.level));
  clearChildren(box);
  if (!list.length) {
    box.appendChild(el('div', { class: loading ? 'm-empty' : 'm-empty ok', text: loading ? '讀取中…' : '目前沒有你要處理的事' }));
  } else {
    let shown = 0;
    for (const g of TODO_LEVELS) {
      const rows = list.filter((t) => t.level === g.level);
      const take = max ? rows.slice(0, Math.max(0, max - shown)) : rows;
      if (!take.length) continue;
      shown += take.length;
      box.appendChild(el('div', { class: `m-grp lv-${g.level}`, text: g.name }));
      box.appendChild(el('div', { class: 'm-list' }, take.map(todoRow)));
    }
    if (list.length > shown) {
      box.appendChild(el('button', { type: 'button', class: 'm-more', 'data-m-act': 'tab-todo', text: `還有 ${list.length - shown} 件 → 看全部` }));
    }
    if (loading) box.appendChild(el('div', { class: 'm-note', text: `還有 ${loading} 個功能讀取中…` }));
  }
  if (failed) box.appendChild(el('div', { class: 'm-note', text: `${failed} 個功能暫時讀不到` }));
}

function moduleTile(m) {
  const n = tileCount(m);
  return el('button', {
    type: 'button',
    class: 'm-tile',
    'data-role': 'm-tile',
    'data-module': m.id,
    'data-target': moduleHomeTarget(m) || '#/home'
  }, [
    n ? el('i', { class: 'badge', text: String(n), 'aria-label': `${n} 件待處理` }) : null,
    el('img', { src: `assets/icons/${m.icon}.png`, alt: '' }),
    el('span', { text: m.name })
  ]);
}

/** 「常用」＝最近開過的功能（本機、依帳號分開），不足六個用權限清單前面的補 */
function recentKey() {
  const u = auth.getUser();
  return u && u.id ? `dzy.u.${u.id}.m_recent` : null;
}
function readRecent() {
  try {
    const k = recentKey();
    const v = k ? JSON.parse(window.localStorage.getItem(k) || '[]') : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch (e) { return []; }
}
function pushRecent(id) {
  try {
    const k = recentKey();
    if (k) window.localStorage.setItem(k, JSON.stringify([id].concat(readRecent().filter((x) => x !== id)).slice(0, 12)));
  } catch (e) { /* 私密瀏覽／被鎖：常用就用預設順序 */ }
}
function recentModules() {
  const list = readRecent().map((id) => permittedModules.find((m) => m.id === id)).filter(Boolean);
  for (const m of permittedModules) {
    if (list.length >= RECENT_MAX) break;
    if (!list.includes(m)) list.push(m);
  }
  return list.slice(0, RECENT_MAX);
}

let appsQuery = '';
function fillGrid(box) {
  clearChildren(box);
  if (box.getAttribute('data-kind') === 'recent') {
    box.appendChild(el('div', { class: 'm-grid' }, recentModules().map(moduleTile)));
    return;
  }
  const q = appsQuery.trim();
  const mods = permittedModules.filter((m) => !q || m.name.includes(q) || String(m.desc || '').includes(q));
  const groups = WORK_GROUPS.map((g) => ({ name: g.name, mods: mods.filter((m) => m.work === g.id) }));
  const other = mods.filter((m) => !WORK_GROUPS.some((g) => g.id === m.work));
  if (other.length) groups.push({ name: '其他', mods: other });
  for (const g of groups) {
    if (!g.mods.length) continue;
    const n = g.mods.filter((m) => tileCount(m) > 0).length;
    box.appendChild(el('div', { class: 'm-grp' }, [
      el('span', { text: g.name }),
      n ? el('i', { class: 'badge', text: `${n} 件` }) : null
    ]));
    box.appendChild(el('div', { class: 'm-grid' }, g.mods.map(moduleTile)));
  }
  if (!mods.length) box.appendChild(el('div', { class: 'm-note', text: `找不到「${q}」，試試「考勤」「排班」「盤點」` }));
}

/** 某個模組的提醒回來了：更新底部「待處理」數字、畫面上的清單與功能磚 */
function onAlertsChanged() {
  if (mTabsEl) {
    const n = collectTodos().items.filter((t) => t.level !== 'info').length;
    const b = findDescendant(mTabsEl, (x) => x.getAttribute && x.getAttribute('data-role') === 'm-todo-badge');
    if (b) {
      b.textContent = n ? String(n) : '';
      if (n) b.removeAttribute('hidden'); else b.setAttribute('hidden', '');
    }
  }
  if (!viewContentEl) return;
  const box = findDescendant(viewContentEl, (x) => x.getAttribute && x.getAttribute('data-role') === 'm-todo');
  if (box) fillTodoBox(box);
  const grid = findDescendant(viewContentEl, (x) => x.getAttribute && x.getAttribute('data-role') === 'm-grid');
  if (grid) fillGrid(grid);
}

/** 「功能」「待處理」頁直接進來時（沒先經過首頁）也要有數字：重讀全部模組的提醒 */
function refreshAlerts() {
  for (const m of permittedModules) loadHomeGroup(m, () => true);
}

function renderMobileHome() {
  const box = el('div', { class: 'm-todo', 'data-role': 'm-todo', 'data-max': String(HOME_TODO_MAX), 'data-levels': 'error,warn' });
  fillTodoBox(box);
  const grid = el('div', { 'data-role': 'm-grid', 'data-kind': 'recent' });
  fillGrid(grid);
  return el('div', { class: 'm-page m-home m-only' }, [
    el('h2', { class: 'm-h', text: '你要處理的事' }), box,
    el('h2', { class: 'm-h', text: '常用' }), grid
  ]);
}

function renderAppsPage() {
  const input = el('input', { type: 'search', class: 'input m-search', id: 'm-apps-q', placeholder: '搜尋功能，例如「排班」', 'aria-label': '搜尋功能', autocomplete: 'off' });
  input.value = appsQuery;
  const grid = el('div', { 'data-role': 'm-grid', 'data-kind': 'apps' });
  input.addEventListener('input', () => { appsQuery = input.value; fillGrid(grid); });
  fillGrid(grid);
  viewContentEl.appendChild(el('div', { class: 'm-page' }, [input, grid]));
  refreshAlerts();
}

function renderTodoPage() {
  const box = el('div', { class: 'm-todo', 'data-role': 'm-todo', 'data-max': '0', 'data-levels': 'error,warn,info' });
  fillTodoBox(box);
  viewContentEl.appendChild(el('div', { class: 'm-page' }, [box]));
  refreshAlerts();
}

function accountRow(label, attrs, danger) {
  return el('button', Object.assign({ type: 'button', class: danger ? 'm-row danger' : 'm-row' }, attrs), [
    el('span', { class: 'm-tx' }, [el('span', { class: 'm-t', text: label })]),
    danger ? null : el('span', { class: 'go', 'aria-hidden': 'true', text: '›' })
  ]);
}

function renderAccountPage() {
  const user = auth.getUser() || {};
  const parts = [el('div', { class: 'm-me' }, [
    el('div', { class: 'av', 'aria-hidden': 'true', text: String(user.name || '').slice(0, 1) }),
    el('div', { class: 'm-tx' }, [el('b', { text: user.name || '' }), el('small', { text: roleLabel(user) })])
  ])];
  // manifest.accountMenu 的模組（我的資料）：有權限的分頁逐列放進來
  for (const m of permittedModules.filter((x) => x.accountMenu)) {
    const rows = m.views.filter(isViewPermitted).map((v) => accountRow(v.name, { 'data-role': 'm-tile', 'data-target': `#/${m.id}/${v.id}` }));
    if (!rows.length) continue;
    parts.push(el('div', { class: 'm-grp', text: m.name }));
    parts.push(el('div', { class: 'm-list' }, rows));
  }
  parts.push(el('div', { class: 'm-grp', text: '帳號' }));
  parts.push(el('div', { class: 'm-list' }, [
    accountRow('修改密碼', { 'data-m-act': 'password' }),
    accountRow('問小幫手', { 'data-m-act': 'help' }),
    accountRow('畫面怪怪的？重新整理', { 'data-m-act': 'reload' }),
    accountRow('登出', { 'data-m-act': 'logout' }, true)
  ]));
  viewContentEl.appendChild(el('div', { class: 'm-page' }, parts));
}

/** 殼頁面（功能／待處理／我）；首頁另走 renderHome（要同時畫電腦版卡片） */
async function renderShellPage(id) {
  await teardownCurrent();
  currentShellPage = id;
  lastShellPage = id;
  renderTopNav();
  clearChildren(viewNavEl);
  clearView();
  if (id === 'apps') renderAppsPage();
  else if (id === 'todo') renderTodoPage();
  else renderAccountPage();
}

function renderMobileBar() {
  if (!mBarEl) return;
  const inModule = !!currentModule;
  mTitleEl.textContent = inModule ? currentModule.name : (SHELL_PAGES[currentShellPage] || '首頁');
  if (inModule) mBackEl.removeAttribute('hidden'); else mBackEl.setAttribute('hidden', '');
  mBarEl.setAttribute('data-page', inModule ? 'module' : (currentShellPage || 'home'));
  const active = inModule ? lastShellPage : currentShellPage;
  for (const b of mTabsEl.children) {
    const on = b.getAttribute('data-m-tab') === active;
    b.className = on ? 'is-active' : '';
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
}

function openHelper() {
  const fab = typeof document.querySelector === 'function' ? document.querySelector('[data-role="aih-fab"]') : null;
  if (fab) fab.click();
  else ui.toast('小幫手目前沒有開放', 'warn');
}

function onMobileAct(a) {
  if (a === 'back') navigateTo(`#/${lastShellPage}`);
  else if (a === 'help') openHelper();
  else if (a === 'password') openChangePassword();
  else if (a === 'logout') doLogout();
  else if (a === 'reload') { try { window.location.reload(); } catch (e) { /* ignore */ } }
  else if (a.startsWith('tab-')) navigateTo(`#/${a.slice(4)}`);
}

function onMobileChromeClick(e) {
  const b = findAncestorWithAttr(e.target, 'data-m-act');
  if (b) onMobileAct(b.getAttribute('data-m-act'));
}

function buildMobileChrome() {
  mBackEl = el('button', { type: 'button', class: 'm-back', 'data-m-act': 'back', 'aria-label': '返回', text: '‹', hidden: '' });
  mTitleEl = el('div', { class: 'm-title' });
  mBarEl = el('header', { class: 'm-bar', 'data-role': 'm-bar' }, [
    mBackEl,
    el('span', { class: 'brand-logo m-logo', 'aria-hidden': 'true', text: '鼎兆元' }),
    mTitleEl,
    el('button', { type: 'button', class: 'm-help', 'data-m-act': 'help', 'aria-label': '問小幫手', title: '問小幫手', text: '?' })
  ]);
  mTabsEl = el('nav', { class: 'm-tabs', 'data-role': 'm-tabs', 'aria-label': '主選單' }, Object.keys(SHELL_PAGES).map((id) => {
    const ic = el('span', { class: 'ic', 'aria-hidden': 'true' });
    ic.innerHTML = TAB_ICONS[id];
    return el('button', { type: 'button', 'data-m-act': `tab-${id}`, 'data-m-tab': id }, [
      ic,
      el('span', { class: 'lb', text: SHELL_PAGES[id] }),
      id === 'todo' ? el('i', { class: 'badge', 'data-role': 'm-todo-badge', hidden: '' }) : null
    ]);
  }));
  mBarEl.addEventListener('click', onMobileChromeClick);
  mTabsEl.addEventListener('click', onMobileChromeClick);
  if (!mobileWatched) { mobileWatched = true; watchMobileWidth(); }
}
let mobileWatched = false;

// ============================================================
// AI 小幫手（右下角按鈕，docs/ai-helper/spec.md §2）：殼只負責「登入後掛上、登出卸下」，其餘全在 platform/helper/
// ============================================================

/** 目前網址對應的 {m:模組 id, v:分頁 id}；首頁是 {m:'',v:''} */
function getRoute() {
  return { m: currentModule ? currentModule.id : '', v: currentModule && currentView ? currentView : '' };
}

/** 「帶我去」能不能去：模組有權限 ∧ 分頁存在且有權限（同 isModulePermitted ∧ isViewPermitted） */
function canGoTo(m, v) {
  const manifest = allManifests.find((x) => x.id === m);
  if (!manifest || !isModulePermitted(manifest)) return false;
  const view = manifest.views.find((x) => x.id === v);
  return !!view && isViewPermitted(view);
}

let helperMod = null;
/** 動態載入：小幫手壞了、載不到都不能影響殼 */
function mountHelperSafe(shellEl) {
  import('./helper/widget.js').then((mod) => {
    if (!auth.getUser()) return;   // 載入期間已登出
    helperMod = mod;
    return mod.mountHelper(shellEl, { getRoute, canGo: canGoTo });
  }).catch(() => { /* 小幫手是附加功能，失敗就沒有按鈕 */ });
}
function unmountHelperSafe() {
  if (helperMod) { try { helperMod.unmountHelper(); } catch (e) { /* ignore */ } }
}

// ============================================================
// 畫面骨架（登入後才建立一次；委派監聽器綁在這幾個穩定容器上）
// ============================================================

function ensureShellDom() {
  clearChildren(rootEl);

  // 側邊欄（外觀正本：門市營運系統 ~/mala-store-ops/web/css/app.css .sidebar）
  const brandEl = el('div', { class: 'brand' }, [
    el('span', { class: 'brand-logo', text: '鼎兆元' }),
    el('div', null, [
      el('div', { class: 'bt', text: '鼎兆元管理系統' }),
      el('div', { class: 'bs', text: 'DING ZHAO YUAN' })
    ])
  ]);
  sideNavEl = el('nav', { class: 'side-nav', 'aria-label': '系統選單' });
  sideUserEl = el('div', { class: 'side-user' });
  navDesktopEl = el('aside', { class: 'sidebar', 'data-role': 'nav-desktop' }, [brandEl, sideNavEl, sideUserEl]);

  pageTitleEl = el('h1', { class: 'page-title' });
  pageSubEl = el('div', { class: 'sub' });
  const topbarEl = el('div', { class: 'topbar' }, [pageTitleEl, pageSubEl]);
  viewNavEl = el('div', { class: 'view-tabs', 'data-role': 'view-nav' });
  viewContentEl = el('div', { 'data-role': 'view-content' });

  // 保留中的模組放在內容區裡（測試與其他程式都以內容區為準）；clearView() 清內容區時跳過它
  keepRootEl = el('div', { 'data-role': 'keep-root' });
  viewContentEl.appendChild(keepRootEl);
  const pageEl = el('div', { class: 'page' }, [viewContentEl]);
  buildMobileChrome();
  const mainEl = el('div', { class: 'app-main' }, [mBarEl, topbarEl, viewNavEl, pageEl]);
  const shellEl = el('div', { class: 'app-shell' }, [navDesktopEl, mainEl, mTabsEl]);

  rootEl.appendChild(shellEl);
  mountHelperSafe(shellEl);

  navDesktopEl.addEventListener('click', onTopNavClick);
  viewNavEl.addEventListener('click', onViewNavClick);
  viewContentEl.addEventListener('click', onViewContentClick);
  viewContentEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && findAncestorWithAttr(e.target, 'data-role', 'alert-row')) onViewContentClick(e);
  });
}

// ============================================================
// 首頁 / 模組掛載
// ============================================================

async function renderHome() {
  await teardownCurrent();
  currentShellPage = 'home';
  lastShellPage = 'home';
  renderTopNav();
  clearChildren(viewNavEl);
  renderHomeCards();
}

async function mountModuleView(manifest, view, params) {
  await teardownCurrent();
  currentShellPage = null;
  pushRecent(manifest.id);
  currentModule = manifest;
  currentView = view.id;
  renderTopNav();
  renderViewNav(manifest);
  clearView();

  // 保留中的模組：直接拿回來顯示，不重新 mount（iframe 不重載、不重新登入）
  const kept = parked.get(manifest.id);
  if (kept) {
    parked.delete(manifest.id);
    clearTimeout(kept.timer);
    kept.host.hidden = false;
    currentHost = kept.host;
    currentModuleBody = kept.body;
    currentMountUnmount = kept.unmount;
    currentCtx = kept.ctx;
    // 從左側選單點回來（網址是模組的第一個分頁）→ 停在上次離開的那一頁，網址也改成那一頁
    let vid = view.id;
    const first = manifest.views.find(isViewPermitted);
    if (currentCtx && currentCtx.viewId && first && vid === first.id && currentCtx.viewId !== vid) {
      vid = currentCtx.viewId;
      try { window.history.replaceState(null, '', `#/${manifest.id}/${vid}`); } catch (e) { /* 測試環境沒有 history */ }
      currentView = vid;
      renderViewNav(manifest);
    }
    // 分頁與參數都跟離開時一樣 → 不通知模組（多數模組收到 onRoute 會整頁重畫重讀，保留就白做了）
    const same = currentCtx && currentCtx.viewId === vid && JSON.stringify(currentCtx.params || {}) === JSON.stringify(params || {});
    if (currentCtx) { currentCtx.viewId = vid; currentCtx.params = params || {}; }
    if (!same && currentModuleBody && typeof currentModuleBody.onRoute === 'function') {
      try { currentModuleBody.onRoute(currentCtx); } catch (err) { console.error(`[shell] 模組 onRoute() 拋錯：${manifest.id}`, err); }
    }
    return;
  }
  // 每個模組掛在自己的容器：保留型放 keepRootEl 底下，一般的放內容區（模組卸載時清自己的容器，不會清到別人）
  if (manifest.keepAlive > 0) {
    currentHost = el('div', { 'data-keep': manifest.id });
    keepRootEl.appendChild(currentHost);
  } else {
    currentHost = el('div', { 'data-host': manifest.id });
    viewContentEl.appendChild(currentHost);
  }
  const mountEl = currentHost;

  const ctx = buildCtx(manifest, view.id, params);

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
    maybeUnmount = await body.mount(mountEl, ctx);
  } catch (err) {
    console.error(`[shell] 模組掛載失敗：${manifest.id}`, err);
    goHomeWithWarning();
    return;
  }

  currentModuleBody = body;
  currentMountUnmount = typeof maybeUnmount === 'function' ? maybeUnmount : null;
  // 記住這個 ctx 物件本身：同模組內換分頁時要原地更新它，不能換一個新物件（spec §4.7）。
  currentCtx = ctx;
}

function goHomeWithWarning() {
  ui.toast('沒有權限', 'warn');
  navigateTo('#/home');
}

// ============================================================
// 修改密碼（平台層功能，2026-08-17）
//
// 用共用的 ui.dialog（它吃 DOM body），不自己刻彈窗——這正是共用元件存在的理由。
// 驗證分兩層：這裡先擋明顯錯誤（沒填、太短、兩次不一致），真正的舊密碼比對在後端，
// 前端永遠不碰任何 hash（spec §5.6）。
// ============================================================

function buildPasswordField(labelText, inputId) {
  const input = el('input', {
    class: 'input',
    id: inputId,
    type: 'password',
    autocomplete: inputId === 'pw-old' ? 'current-password' : 'new-password'
  });
  const field = el('div', { class: 'field' }, [
    el('label', { class: 'field-label', for: inputId, text: labelText }),
    input
  ]);
  return { field, input };
}

async function openChangePassword() {
  const oldF = buildPasswordField('目前密碼', 'pw-old');
  const newF = buildPasswordField('新密碼（至少 8 個字元）', 'pw-new');
  const confirmF = buildPasswordField('再輸入一次新密碼', 'pw-new2');
  const errorEl = el('p', { class: 'field-hint', 'data-role': 'pw-error' });

  const body = el('div', { class: 'stack' }, [oldF.field, newF.field, confirmF.field, errorEl]);

  const choice = await ui.dialog({
    title: '修改密碼',
    body,
    actions: [
      { label: '取消', value: null, variant: 'secondary' },
      { label: '確定修改', value: 'ok', variant: 'primary' }
    ]
  });
  if (choice !== 'ok') return;

  const oldPw = oldF.input.value;
  const newPw = newF.input.value;
  const newPw2 = confirmF.input.value;

  if (!oldPw || !newPw) {
    ui.toast('請填寫目前密碼與新密碼', 'warn');
    return openChangePassword();
  }
  if (newPw.length < 8) {
    ui.toast('新密碼至少需要 8 個字元', 'warn');
    return openChangePassword();
  }
  if (newPw !== newPw2) {
    ui.toast('兩次輸入的新密碼不一致', 'warn');
    return openChangePassword();
  }

  ui.loading(true);
  let res;
  try {
    res = await auth.changePassword(oldPw, newPw);
  } finally {
    ui.loading(false);
  }

  if (!res || !res.ok) {
    ui.toast((res && res.error) || '修改失敗', 'danger');
    return;
  }
  ui.toast('密碼已更新，下次登入請用新密碼', 'ok');
}

// ============================================================
// 路由（spec §4.9）
// ============================================================

function route() {
  if (!auth.getUser()) return; // 第二道保險：沒登入絕不處理路由

  const { moduleId, viewId, params } = parseHash(window.location.hash);

  // claim／forgot／apply／apply-status 是登入前畫面的路由（login.js 管）；已登入還停在這些網址就當首頁，並把網址清掉
  if (moduleId === 'claim' || moduleId === 'forgot' || moduleId === 'apply' || moduleId === 'apply-status') {
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* 測試環境沒有 history */ }
    renderHome();
    return;
  }
  if (!moduleId || moduleId === 'home') {
    renderHome();
    return;
  }
  // 手機版底部四格的殼頁面（電腦版網址打得到也能用）
  if (moduleId === 'apps' || moduleId === 'todo' || moduleId === 'account') {
    renderShellPage(moduleId);
    return;
  }

  const manifest = permittedModules.find((m) => m.id === moduleId);
  if (!manifest) {
    goHomeWithWarning();
    return;
  }

  let view = viewId ? manifest.views.find((v) => v.id === viewId) : manifest.views.find(isViewPermitted);
  if (manifest.dynamicTabs) {
    // 動態分頁：進得了模組（第一個有權限的 view）就收網址上的分頁 id，內容由模組自己決定
    const gate = manifest.views.find(isViewPermitted);
    view = gate ? { id: pickDynamicView(viewId, dynTabs[manifest.id], gate.id) } : null;
  }
  if (!view || (!manifest.dynamicTabs && !isViewPermitted(view))) {
    goHomeWithWarning();
    return;
  }

  if (currentModule && currentModule.id === manifest.id) {
    // 同一模組內切分頁／query 改變：模組本體已經掛著，殼只更新導覽狀態，不重新 mount/unmount。
    // 但模組要能知道「現在在哪個分頁」，所以原地更新模組手上那個 ctx 物件的 viewId／params
    // （不是換一個新物件——模組可能已經把 ctx 存起來），並在模組有實作選填的 onRoute(ctx)
    // 時呼叫它一次；沒實作的模組行為不變（spec §4.6／§4.7）。
    currentView = view.id;
    renderTopNav();
    renderViewNav(manifest);

    if (currentCtx) {
      currentCtx.viewId = view.id;
      currentCtx.params = params || {};
    }
    if (currentModuleBody && typeof currentModuleBody.onRoute === 'function') {
      try {
        currentModuleBody.onRoute(currentCtx);
      } catch (err) {
        console.error(`[shell] 模組 onRoute() 拋錯：${manifest.id}`, err);
      }
    }
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

/**
 * @param {{expired?:boolean}} [opts] expired＝登入過期（代轉回 401，2026-10-12）：
 *   只清本機、不打後端 logout（token 已失效；也不該因此把其他裝置一起登出）。
 */
async function doLogout(opts) {
  const expired = !!(opts && opts.expired);
  const leavingUser = auth.getUser();   // 先記下是誰（teardown／logout 之後就拿不到了）
  unmountHelperSafe();
  await teardownCurrent({ destroy: true });
  await destroyAllParked();   // 保留中的嵌入頁一起卸載（營運系統等會收到登出）
  // 主動登出與被踢登出（代轉 401）都先清本人的表單簽核草稿（spec approvals §14.7「登出時清掉」；稽核草稿刻意保留，見 auth.purgeLogoutDrafts；2026-10-29 對抗驗證 A）
  try { auth.purgeLogoutDrafts(window.localStorage, leavingUser && leavingUser.id); } catch (e) { /* 共用電腦 storage 被鎖也不擋登出 */ }
  if (expired) {
    auth.expireLocal();
  } else {
    ui.loading(true); // 等後端登出最多 5 秒，期間顯示載入中
    // 2026-10-12：登出＝全部裝置一起登出。auth.logout() 先等後端（最多 5 秒）再清本機，
    // 一定要 await，否則下面的整頁重載會把還在路上的登出請求砍掉
    try { await auth.logout(); } finally { ui.loading(false); }
  }
  allManifests = [];
  permittedModules = [];
  for (const k of Object.keys(navBadgeCache)) delete navBadgeCache[k];
  for (const k of Object.keys(alertCache)) delete alertCache[k];
  appsQuery = '';
  deptOpenState.clear();
  window.location.hash = '';
  showLogin();
  // 2026-10-12 安全修補：共用電腦登出後整頁重載，讓所有模組的記憶體（稽核快取、in-flight、
  // 各模組閉包裡的資料）一次歸零，下一個登入的帳號不可能看到上一個人的資料。
  // 保留 query（?dryrun=1 這類開關），去掉 hash。
  try {
    const loc = window.location;
    if (typeof loc.replace === 'function') loc.replace(loc.pathname + loc.search);
    else if (typeof loc.reload === 'function') loc.reload();
  } catch { /* 非瀏覽器環境（node 測試）沒有 location 可重載，略過 */ }
}

// 代轉回 401（token 失效／帳號被停用）→ 走登入過期流程。同時多支請求都 401 只處理一次。
let expiring = false;
setSessionExpiredHandler(() => {
  if (expiring || !auth.getUser()) return;
  expiring = true;
  try { ui.toast('登入已失效，請重新登入', 'warn'); } catch { /* ignore */ }
  doLogout({ expired: true }).finally(() => { expiring = false; });
});

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
