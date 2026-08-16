/**
 * modules/dorm/index.js — 宿舍合約模組本體（T3-2）
 *
 * 正本規格：docs/spec.md §4.6（模組本體 mount/unmount/badge/onRoute）、§4.7（ctx，
 * 含 viewId／同一個 ctx 物件原地更新的規則）。做法照抄已驗收的 modules/audit-stock/index.js
 * （殼只在「換模組」時呼叫 mount/unmount，同模組內切分頁改叫 onRoute(ctx)；用 ctx.viewId
 * 分派到對應分頁的 mount 函式；沒有 mounter 的分頁顯示「此分頁尚未完成」佔位卡片，不崩潰）。
 *
 * 三個分頁都已接線（2026-08-17 補）：T3-2 建骨架時只有 list，create／handover 由平行任務
 * 實作完成（T3-3／T3-4，各自的 node 測試直接 import 畫面檔所以全綠），但沒人回頭把
 * mounter 接進本表——實際點開那兩個分頁只會看到「此分頁尚未完成」佔位卡片。
 * 這正是「跨層接縫測試抓不到」的典型案例，e2e ⑥（建單→點交流程）現在會守住這條。
 * renderView() 對任何不在表裡的 viewId 仍回退到佔位卡片，不崩潰。
 *
 * 【模組層狀態（做法照 audit-stock，見它的 index.js 檔頭說明）】
 * list 本身不需要跨分頁記住任何東西，但還是比照 audit-stock 建立這一份 moduleState／
 * moduleStateApi：切分頁（onRoute）不重置，只有離開模組（unmount）才清空。這是為了讓
 * 之後接手 create／handover 的平行任務有現成的地方可以放「剛建好的合約」「上次選的房間」
 * 之類要在分頁間傳遞的狀態，不必另外重刻一套一樣的機制；多傳一個參數給用不到它的
 * mountList 也沒有副作用（JS 忽略多餘參數，同 audit-stock 的 overview.js／my.js 現況）。
 *
 * 【badge()：30 天內到期的「在住」合約數】
 * 資料來源是已驗收、唯讀的 api.js（listContracts），不自己呼叫 ctx.api.call、不重刻一份
 * 資料層。算不出來（後端失敗、格式不符、fmt 算不出日期字串）一律回 null，絕不讓首頁壞掉
 * （spec §4.6）；逾時上限由平台殼負責（5 秒），這裡不必自己加計時器。
 * 判斷「30 天內到期」用 ctx.fmt.date() 把今天／30 天後都轉成 'YYYY-MM-DD' 字串，跟
 * 合約的 term_end 字串直接比大小（YYYY-MM-DD 格式天生可以照字串序排序），不用 Date
 * 物件相減——理由同 platform/fmt.js 檔頭：這是台灣營運資料，經 ctx.fmt 統一轉換能避開
 * 執行環境時區不是台北時所造成的偏移。
 */
'use strict';

import { mountList } from './views/list.js';
import { mountCreate } from './views/create.js';
import { mountHandover } from './views/handover.js';
import { listContracts } from './api.js';

const VIEW_MOUNTERS = {
  list: mountList,
  create: mountCreate,
  handover: mountHandover
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DUE_SOON_DAYS = 30;

let currentEl = null;
let currentViewUnmount = null;

// ---- 狀態保留（同 audit-stock 的做法，見檔頭說明）----
let moduleState = {};

const moduleStateApi = {
  get() {
    return moduleState;
  },
  set(patch) {
    moduleState = Object.assign({}, moduleState, patch);
  }
};

function teardownCurrentView() {
  if (typeof currentViewUnmount === 'function') {
    try {
      currentViewUnmount();
    } catch (err) {
      console.error('[dorm] 分頁 unmount 失敗', err);
    }
  }
  currentViewUnmount = null;
}

function renderView(el, ctx) {
  teardownCurrentView();
  while (el.firstChild) el.removeChild(el.firstChild);

  const mounter = VIEW_MOUNTERS[ctx.viewId];
  if (!mounter) {
    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = '此分頁尚未完成';
    card.appendChild(title);
    el.appendChild(card);
    return;
  }

  const maybeUnmount = mounter(el, ctx, moduleStateApi);
  currentViewUnmount = typeof maybeUnmount === 'function' ? maybeUnmount : null;
}

/** 30 天內到期、狀態為「在住」的合約數；任何一步算不出來都回 null，不拋錯。 */
async function computeDueSoonBadge(ctx) {
  try {
    const res = await listContracts(ctx);
    if (!res || res.ok !== true) return null;

    const contracts = res.data && res.data.contracts;
    if (!Array.isArray(contracts)) return null;

    if (!ctx.fmt || typeof ctx.fmt.date !== 'function') return null;
    const todayStr = ctx.fmt.date(new Date());
    const cutoffStr = ctx.fmt.date(new Date(Date.now() + DUE_SOON_DAYS * MS_PER_DAY));
    if (!todayStr || !cutoffStr) return null;

    return contracts.filter((c) => (
      c && c.status === '在住' &&
      typeof c.term_end === 'string' &&
      c.term_end >= todayStr &&
      c.term_end <= cutoffStr
    )).length;
  } catch (err) {
    console.error('[dorm] badge() 算不出來，回 null', err);
    return null;
  }
}

export default {
  mount(el, ctx) {
    currentEl = el;
    renderView(el, ctx);
    return function unmount() {
      teardownCurrentView();
      currentEl = null;
      // 離開模組才清掉模組層狀態（同 audit-stock：切分頁不重置，離開模組才清）。
      moduleState = {};
    };
  },
  onRoute(ctx) {
    if (currentEl) renderView(currentEl, ctx);
  },
  badge(ctx) {
    return computeDueSoonBadge(ctx);
  }
};
