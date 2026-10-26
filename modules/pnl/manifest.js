/**
 * modules/pnl/manifest.js — 損益系統（2026-10-24，財務部門）：把門市自動損益網頁（mala-pnl.github.io，?embed=dzy）嵌進來。
 * 損益後端金鑰只放在 Mac mini 的 module_secrets（pnl/read、pnl/write），瀏覽器拿不到；每次讀寫都經平台代轉 /platform/proxy（ns pnl），
 * 由 proxyAuthorize_ 依 pnl.read／pnl.write／pnl.admin 放行並算出等級，損益後端用影子帳號沿用既有角色與可看門市規則。
 * 文件：docs/pnl-fin/requirements.md、spec.md。
 */
'use strict';

const ANY = ['pnl.read', 'pnl.write', 'pnl.admin'];
const FILL = ['pnl.write', 'pnl.admin'];
const ADMIN = ['pnl.admin'];

export default {
  id: 'pnl',
  ns: 'pnl',
  backend: 'pnl',
  name: '損益系統',
  desc: '各店每月損益、四大費用、待補與定稿',
  icon: 'pnl',
  keepAlive: 30 * 60 * 1000,   // 切走後保留 30 分鐘不重載（比照薪酬管理；登出管理系統時一起卸載）
  dept: 'fin',
  requires: ANY,
  // 頁頂分頁（Eason 2026-10-24 Q4：九個都在頁頂同一列）；要與 bridge.js PNL_PAGES 一致（test/pnl-module.test.mjs 比對）
  views: [
    { id: 'dashboard', name: '儀表板', requires: ANY },
    { id: 'pending', name: '待補', requires: FILL },
    { id: 'food', name: '食材', requires: FILL },
    { id: 'labor', name: '人事', requires: FILL },
    { id: 'controllable', name: '可控', requires: FILL },
    { id: 'uncontrollable', name: '不可控', requires: FILL },
    { id: 'revenue', name: '營業收入', requires: FILL },
    { id: 'import', name: '匯入', requires: FILL },
    { id: 'settings', name: '設定', requires: ADMIN }
  ],
  entry: () => import('./index.js')
};
