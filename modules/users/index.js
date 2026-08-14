/**
 * modules/users/index.js — 人員管理模組本體（T1-11）
 *
 * 正本規格：docs/spec.md §4.6（模組本體 mount/unmount/badge）、§4.7（ctx）。
 *
 * badge() 固定回 null：人員數不是待辦事項，不該在首頁卡片上顯示數字
 * （任務指示第 2 點）。實際畫面邏輯都在 views/list.js，這裡只是薄薄一層轉接，
 * 方便未來要拆出更多分頁時，manifest.views 增加項目、這裡對應多加一個 view 模組即可。
 */
'use strict';

import { mountList } from './views/list.js';

export default {
  mount(el, ctx) {
    return mountList(el, ctx);
  },
  badge(ctx) {
    return null;
  }
};
