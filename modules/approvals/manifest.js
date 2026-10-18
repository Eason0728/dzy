/**
 * modules/approvals/manifest.js — 表單簽核（第三期，docs/approvals/spec.md §7、§14）
 * 打的是平台後端（apvXxx action 都在 platform 那支），所以 ns／backend 都是 platform（同 me、bulletin，spec §4.1 backend＝ns）。
 * 不填 dept：所有已開通同仁都會用，排在首頁下面（spec §1）。
 * 權限一律後端判；這裡的 requires 只決定分頁看不看得到：
 * - 送單／我的單／待我簽／待我辦／全部單據：platform.login（人人看得到；沒資格的人打開只會看到「沒有待辦」，
 *   因為「誰是承辦部門的人」前端沒有對應權限碼，不能在 manifest 判斷，spec §6 也說不新增權限碼）。
 * - 核決權限：只有 role admin。沿用 perms 模組的做法：platform.permex 沒有任何規則會給，只有 admin 的 `*` 符合。
 */
'use strict';

export default {
  id: 'approvals',
  ns: 'platform',
  backend: 'platform',
  name: '表單簽核',
  desc: '請購、請款、人事異動簽核',
  icon: 'approvals',
  requires: ['platform.login'],
  views: [
    { id: 'submit', name: '送單', requires: ['platform.login'] },
    { id: 'mine', name: '我的單', requires: ['platform.login'] },
    { id: 'sign', name: '待我簽', requires: ['platform.login'] },
    { id: 'handle', name: '待我辦', requires: ['platform.login'] },
    { id: 'all', name: '全部單據', requires: ['platform.login'] },
    { id: 'thr', name: '核決權限', requires: ['platform.permex'] }
  ],
  entry: () => import('./index.js')
};
