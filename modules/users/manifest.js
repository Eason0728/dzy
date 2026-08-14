/**
 * modules/users/manifest.js — 人員管理模組 manifest（T1-11）
 *
 * 正本規格：docs/spec.md §4.1（代號與 ns／backend 約束）、§4.2（權限碼）、
 * §4.5（manifest 格式）。
 *
 * 這個模組的權限命名空間就是 platform 自己（不是某個既有系統），
 * 所以 ns 與 backend 都設成 'platform'——符合 §4.1「backend 必須等於 ns」的約束，
 * 呼叫 ctx.api.call('users', 'listUsers', ...) 時，殼會用這裡的 backend 打
 * apps-script/platform/ 那支後端。
 */
'use strict';

export default {
  id: 'users',
  ns: 'platform',
  backend: 'platform',
  name: '人員管理',
  desc: '新增／停用帳號、重設密碼',
  icon: 'users',
  requires: ['platform.users'],
  views: [
    { id: 'list', name: '人員清單', requires: ['platform.users'] }
  ],
  entry: () => import('./index.js')
};
