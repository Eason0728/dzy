/**
 * modules/audit-stock/index.js — 月初盤點抽查模組本體（T2-2／T2-6／T2-8／狀態保留）
 *
 * 正本規格：docs/spec.md §4.6（模組本體 mount/unmount/badge/onRoute）、§4.7（ctx，
 * 含 viewId／同一個 ctx 物件原地更新的規則）、§7（店長節點裁切，平台層已做，模組不重做）。
 *
 * 本模組五個分頁（overview／fill／report／analysis／my，見 manifest.js）共用同一次
 * mount()：殼只在「換模組」時呼叫 mount/unmount，同模組內切分頁改叫 onRoute(ctx)
 * （spec §4.6／shell.js route() 的實際行為），所以這裡用 ctx.viewId 分派到對應分頁的
 * mount 函式，並在 onRoute() 時換掉目前掛著的那個分頁。
 *
 * my（我的門市，T2-6）已補齊：店長唯讀視角，見 views/my.js。
 *
 * 【狀態保留（Eason 2026-08-15 指示補）】
 * 「目前選的店別／月份」提升到這裡（模組層），用 moduleStateApi 這個小物件在 fill／report
 * 之間傳遞：各分頁掛載時讀 moduleStateApi.get()、使用者改選時呼叫 moduleStateApi.set(patch)
 * 寫回。切分頁（onRoute）不重置——moduleState 是這支檔案的模組級變數，onRoute 不會重新
 * 賦值它；只有離開模組（unmount）才清成 {store:null, month:null}。overview／analysis／my
 * 沒有「店別／月份」選擇器（overview 是全店格狀總覽、analysis 是全店異常分析、my 固定顯示
 * 自己節點），跟這個機制無關，多傳一個參數給它們的 mounter 也沒有副作用（JS 忽略多餘參數）。
 * 這個狀態**不跨模組共用**（audit-ops 有自己獨立的一份，各自 import 各自的 index.js，
 * 天生不會共用到同一個模組級變數）。
 *
 * badge()（T2-8）：本月尚未完成盤點（沒有「已稽核」或「輪休」紀錄）的節點數。
 * 店長身分（有 audit.read.own 且沒有 audit.read）時只算自己節點——資料本身已經被平台層
 * （platform/api.js maybeFilterOwnNode_）裁到只剩自己店，這裡只需要用 ctx.user.node
 * 決定「檢查清單只有這一個節點」，不重做裁切（spec §7）。算不出來一律回 null，不拋錯。
 */
'use strict';

import { mountOverview } from './views/overview.js';
import { mountFill } from './views/fill.js';
import { mountReport } from './views/report.js';
import { mountAnalysis } from './views/analysis.js';
import { mountMy } from './views/my.js';
import * as sharedApi from '../audit-shared/api.js';

const VIEW_MOUNTERS = {
  overview: mountOverview,
  fill: mountFill,
  report: mountReport,
  analysis: mountAnalysis,
  my: mountMy
};

// 本模組唯一支援的年份，同各分頁的 YEAR 常數（badge 算「本月」要落在資料涵蓋的年份內）。
const YEAR = '2026';

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/** 同 fill.js 的月份預設邏輯：真實現在年份對得上資料年份才用真實月份，否則退回一月。 */
function currentMonthStr() {
  const now = new Date();
  const y = String(now.getFullYear());
  return y === YEAR ? y + '-' + pad2(now.getMonth() + 1) : YEAR + '-01';
}

let currentEl = null;
let currentViewUnmount = null;

// ---- 狀態保留（見檔頭說明）：模組層的「目前選的店別／月份」----
let moduleState = { store: null, month: null };

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
      console.error('[audit-stock] 分頁 unmount 失敗', err);
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

export default {
  mount(el, ctx) {
    currentEl = el;
    renderView(el, ctx);
    return function unmount() {
      teardownCurrentView();
      currentEl = null;
      // 離開模組才清掉「目前選的店別／月份」（任務①明講：切分頁不重置，離開模組才清）。
      moduleState = { store: null, month: null };
    };
  },
  onRoute(ctx) {
    if (currentEl) renderView(currentEl, ctx);
  },
  async badge(ctx) {
    try {
      const res = await sharedApi.getAll(ctx);
      if (!res || res.ok !== true) return null;

      const config = (res.data && res.data.config) || { stores: [] };
      const records = (res.data && res.data.records) || [];

      const hasFull = ctx.can('audit.read');
      const hasOwn = ctx.can('audit.read.own');
      const isStoreLead = hasOwn && !hasFull;

      let nodeCodes;
      if (isStoreLead) {
        const node = ctx.user && ctx.user.node;
        nodeCodes = node ? [node] : [];
      } else {
        nodeCodes = (config.stores || []).map((s) => s.code);
      }
      if (!nodeCodes.length) return null;

      const month = currentMonthStr();
      const doneNodes = new Set(
        records
          .filter((r) => r.month === month && (r.status === '已稽核' || r.status === '輪休'))
          .map((r) => r.store)
      );

      return nodeCodes.filter((code) => !doneNodes.has(code)).length;
    } catch (err) {
      console.error('[audit-stock] badge() 算不出來，回 null', err);
      return null;
    }
  }
};
