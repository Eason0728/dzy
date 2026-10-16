/**
 * modules/bulletin/manifest.js — 公告專區（2026-10-16 Eason：「我的資料」下面加公告專區，內容就是電子佈告欄）
 * 佈告欄本身是獨立系統（https://dzy-bulletin.github.io，後端在 Mac mini，自己的登入），這裡只把它嵌進來，
 * 不呼叫任何後端；ns／backend 借用 platform（spec §4.1 backend＝ns）。
 * platform.login＝每個登入者都有的前端權限（platform/auth.js can()），所以人人看得到。
 */
'use strict';

export default {
  id: 'bulletin',
  ns: 'platform',
  backend: 'platform',
  name: '公告專區',
  desc: '集團公告與簽名回條',
  icon: 'bulletin',
  requires: ['platform.login'],
  views: [
    { id: 'board', name: '電子佈告欄', requires: ['platform.login'] }
  ],
  entry: () => import('./index.js')
};
