/**
 * modules/audit-ops/index.js — 營運稽核表模組本體（T2-5／T2-6／T2-8／狀態保留）
 *
 * 正本規格：docs/spec.md §4.6（模組本體 mount/unmount/badge/onRoute）、§4.7（ctx，
 * 含 viewId／同一個 ctx 物件原地更新的規則）、§7（店長節點裁切，平台層已做，模組不重做）。
 *
 * 做法逐字元照抄 modules/audit-stock/index.js（T2-2／T2-6／T2-8 已驗收的範本，含狀態保留
 * 機制）：本模組四個分頁（overview／fill／report／my，見 manifest.js）共用同一次
 * mount()：殼只在「換模組」時呼叫 mount/unmount，同模組內切分頁改叫 onRoute(ctx)
 * （spec §4.6／shell.js route() 的實際行為），所以這裡用 ctx.viewId 分派到對應分頁的
 * mount 函式，並在 onRoute() 時換掉目前掛著的那個分頁。
 *
 * my（我的門市，T2-6）已補齊：店長唯讀視角，見 views/my.js。
 *
 * 【狀態保留（Eason 2026-08-15 指示補）】做法與 audit-stock/index.js 完全對稱，
 * 但這是這個模組**自己的一份**模組層變數，不與 audit-stock 共用（兩張表是不同的表，
 * 會計可能同時在看不同店，硬綁在一起反而錯——見任務指示①）。
 *
 * badge()（T2-8）：未完成追蹤清單的項數——取每個節點「最新一筆已稽核」紀錄裡
 * track===true 的明細列數（同一家店只算最新一筆，避免跨月疊加出不會歸零的數字）。
 * 店長身分（有 audit.read.own 且沒有 audit.read）時只算自己節點，理由同 audit-stock。
 * 算不出來一律回 null，不拋錯。
 */
'use strict';

import { mountOverview } from './views/overview.js';
import { mountFill } from './views/fill.js';
import { mountReport } from './views/report.js';
import { mountMy } from './views/my.js';
import * as sharedApi from '../audit-shared/api.js';

const VIEW_MOUNTERS = {
  overview: mountOverview,
  fill: mountFill,
  report: mountReport,
  my: mountMy
};

let currentEl = null;
let currentViewUnmount = null;

// ---- 狀態保留（見檔頭說明）：模組層的「目前選的店別／月份」，audit-stock 各自一份 ----
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
      console.error('[audit-ops] 分頁 unmount 失敗', err);
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

      const opsRecords = (res.data && res.data.ops_records) || [];
      const opsDetails = (res.data && res.data.ops_details) || [];

      const hasFull = ctx.can('audit.read');
      const hasOwn = ctx.can('audit.read.own');
      const isStoreLead = hasOwn && !hasFull;

      let scopedRecords = opsRecords;
      if (isStoreLead) {
        const node = ctx.user && ctx.user.node;
        if (!node) return null; // 店長沒有所屬節點＝資料算不出來（同 platform/api.js 的保守失敗方向）
        scopedRecords = opsRecords.filter((r) => r.store === node);
      }

      // 每個節點只取最新一筆「已稽核」紀錄（避免跨月疊加，見檔頭說明）。
      const latestByStore = {};
      scopedRecords.forEach((r) => {
        if (r.status !== '已稽核') return;
        const prev = latestByStore[r.store];
        if (!prev || r.month > prev.month) latestByStore[r.store] = r;
      });
      const latestKeys = new Set(Object.values(latestByStore).map((r) => r.record_key));

      return opsDetails.filter((d) => latestKeys.has(d.record_key) && d.track === true).length;
    } catch (err) {
      console.error('[audit-ops] badge() 算不出來，回 null', err);
      return null;
    }
  }
};
