/**
 * modules/perms/manifest.js — 權限設定（個人帳號第二期，docs/permissions/spec.md §7.1、§13.1）
 * 平台層自己的功能，ns／backend 都是 platform（同 users 模組，spec §4.1 backend＝ns）。
 * 對照表分頁：人資主管（platform.permmap）與 admin 都看得到；
 * 個別例外分頁（2026-10-18）：人資主管也看得到，但只看得到、只能設「收支作廢」「額外考勤核定」「公告管理」三碼（後端 permAcExAuth_ 擋，前端只是不顯示選不了的）。
 * 其餘兩個分頁只有 admin 看得到——platform.permex 沒有任何規則會給，只有 admin 的 `*` 符合。
 */
'use strict';

export default {
  id: 'perms',
  ns: 'platform',
  backend: 'platform',
  name: '權限設定',
  desc: '依職稱給權限、個別例外',
  icon: 'users',
  dept: 'it',
  requires: ['platform.permmap'],
  views: [
    { id: 'map', name: '對照表', requires: ['platform.permmap'] },
    { id: 'ex', name: '個別例外', requires: ['platform.permmap'] },
    { id: 'stores', name: '店別對照', requires: ['platform.permex'] },
    { id: 'audit', name: '權限異動', requires: ['platform.permex'] }
  ],
  entry: () => import('./index.js')
};
