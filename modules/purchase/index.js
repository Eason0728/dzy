/**
 * modules/purchase/index.js — 貨單核對：把貨單辨識系統的會計頁嵌進內容區（iframe）並自動登入；首頁提醒待核對、辨識失敗張數。
 * 握手在 embed.js；張數在 counts.js（兩者都不碰管理系統登入 token，只拿一次性入場券）。
 */
'use strict';

import { createEmbed } from './embed.js';
import { getCounts, countAlerts } from './counts.js';

const embed = createEmbed({
  title: '貨單核對',
  tip: '用管理系統帳號自動登入；看得到哪幾個品牌由貨單系統的帳號頁設定'
});

export default {
  mount: embed.mount,
  onRoute: embed.onRoute,
  async badge(ctx) {
    const c = await getCounts(ctx);
    return c ? c.review : null;
  },
  async alerts(ctx) {
    const c = await getCounts(ctx);
    return c ? countAlerts(c) : null;
  }
};
