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
  keepAlive: 30 * 60 * 1000,   // 切走後保留 30 分鐘（2026-10-21 Eason：不用最新狀態沒關係；登出管理系統時一起卸載）
  requires: ['platform.self'],
  views: [
    { id: 'profile', name: '個人資料', requires: ['platform.self'] },
    { id: 'unit', name: '單位通訊錄', requires: ['platform.self'] },
    // 2026-10-12：認領後主管審核。platform.review 是後端依職級自動加的衍生權限（單位主管才有），
    // platform.staff（人資）也能審；兩者都沒有的人看不到這個分頁
    { id: 'review', name: '待審核', requires: ['platform.review', 'platform.staff'] },
    // 2026-10-13 員工名單統一：店長的「我的單位」（新增／離職／打卡連結）與「打卡對照」（對／不對）
    // 2026-10-30 platform.unitstaff：個別例外「可新增同仁」（staff.add@<本店>）的衍生權限，跟店長一樣用這兩頁（不給待審核）
    { id: 'team', name: '我的單位', requires: ['platform.review', 'platform.unitstaff'] },
    { id: 'clock', name: '打卡對照', requires: ['platform.review', 'platform.unitstaff'] }
  ],
  entry: () => import('./index.js')
};
