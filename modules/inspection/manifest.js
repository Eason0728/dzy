/**
 * modules/inspection/manifest.js — 營運巡檢（2026-10-27，docs/inspection/spec.md）
 * 舊站 mala-inspection 搬進營運部門，全集團門市共用（墨竹亭／小辛辣／一悟各一份題庫）。
 * 打平台後端（Inspect.gs 的 insp* action），ns／backend＝platform；照片走表單簽核的照片庫。
 * 分頁看不看得到只看這裡的 requires（任一符合）；真正看得到哪些店一律後端判（inspScopeOf_）。
 */
'use strict';

const ANY = ['platform.insp-do', 'platform.insp-own', 'platform.insp-brand', 'platform.insp-all', 'platform.insp-bank'];

export default {
  id: 'inspection',
  ns: 'platform',
  backend: 'platform',
  name: '營運巡檢',
  desc: '到店巡檢評分、缺失拍照、報告',
  icon: 'inspection',
  dept: 'ops',
  keepAlive: 30 * 60 * 1000,   // 切走保留 30 分鐘（填到一半去看別的不會不見；草稿另存本機）
  requires: ANY,
  views: [
    { id: 'list', name: '巡檢紀錄', requires: ANY },
    { id: 'fill', name: '新增巡檢', requires: ['platform.insp-do'] },
    { id: 'bank', name: '題目設定', requires: ['platform.insp-bank'] }
  ],
  entry: () => import('./index.js')
};
