/**
 * modules/me/manifest.js — 我的資料（個人帳號管理第一期，docs/personnel/spec.md §7.4）
 * 平台層自己的資料（同仁帳號），ns／backend 都是 platform（同 users 模組，spec §4.1 backend＝ns）。
 */
'use strict';

export default {
  id: 'me',
  ns: 'platform',
  backend: 'platform',
  name: '我的資料',
  desc: '看狀態、改手機地址與職稱',
  icon: 'me',
  requires: ['platform.self'],
  views: [
    { id: 'profile', name: '個人資料', requires: ['platform.self'] },
    { id: 'unit', name: '單位通訊錄', requires: ['platform.self'] }
  ],
  entry: () => import('./index.js')
};
