/**
 * modules/remit/manifest.js — 匯款清單（財務部門，2026-11-18 Eason；規格 docs/remit/progress.md）
 * 個人代墊、單位請款照核決權限簽完、再經財務部主管核准後，自動列進這裡「待出帳」；單位會計出帳後標記已匯款＝結案。
 * 也在這裡設定廠商銀行帳戶、各單位的會計。原生畫面，打平台後端（Approvals.gs 第 11 節），所以 ns／backend＝platform。
 * 權限碼 platform.remit（財務部門預設有、可在權限設定個別加人；不鎖碼）。
 */
'use strict';

export default {
  id: 'remit',
  ns: 'platform',
  backend: 'platform',
  name: '匯款清單',
  desc: '個人代墊、單位請款的出帳與廠商帳戶',
  icon: 'remit',
  work: 'money',               // 手機「功能」頁的工作分類（platform/config.js WORK_GROUPS）
  keepAlive: 30 * 60 * 1000,   // 切走後保留 30 分鐘（同財務部門其他功能；登出時一起卸載）
  dept: 'fin',
  requires: ['platform.remit'],
  views: [
    { id: 'list', name: '匯款清單', requires: ['platform.remit'] },
    { id: 'vendors', name: '廠商帳戶', requires: ['platform.remit'] },
    { id: 'accts', name: '單位會計', requires: ['platform.remit'] }
  ],
  entry: () => import('./index.js')
};
