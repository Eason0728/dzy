/**
 * modules/staff/manifest.js — 同仁名單（後台；個人帳號管理第一期，docs/personnel/spec.md §7.5）
 */
'use strict';

export default {
  id: 'staff',
  ns: 'platform',
  backend: 'platform',
  name: '同仁名單',
  desc: '匯入編號、確認開通、停用',
  icon: 'staff',
  requires: ['platform.staff'],
  views: [
    { id: 'list', name: '名單', requires: ['platform.staff'] },
    { id: 'import', name: '匯入', requires: ['platform.staff'] }
  ],
  entry: () => import('./index.js')
};
