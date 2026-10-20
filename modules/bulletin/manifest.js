/**
 * modules/bulletin/manifest.js — 公告專區（2026-10-16 Eason：「我的資料」下面加公告專區，內容就是電子佈告欄）
 * 佈告欄本身是獨立系統（https://dzy-bulletin.github.io，後端在 Mac mini，自己的登入），這裡只把它嵌進來，
 * 不呼叫任何後端；ns／backend 借用 platform（spec §4.1 backend＝ns）。
 * platform.login＝每個登入者都有的前端權限（platform/auth.js can()），所以人人看得到。
 * 公告管理／新增公告：platform.bulletin（Staff.gs stfBulletinAdmins_，同仁名單逐人勾選）。
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
    // 2026-10-20：佈告欄自己的「📌 公告／🗂 歷史區」切換搬到這一列（nav.js BOARD_TABS，測試比對）
    { id: 'board', name: '公告', requires: ['platform.login'] },
    { id: 'hist', name: '歷史區', requires: ['platform.login'] },
    // 2026-10-17：公告管理權限（同仁名單勾選＝platform.bulletin；admin 本來就有）
    { id: 'manage', name: '公告管理', requires: ['platform.bulletin'] },
    { id: 'new', name: '新增公告', requires: ['platform.bulletin'] }
  ],
  entry: () => import('./index.js')
};
