/**
 * modules/ai-help/manifest.js — 小幫手管理（資訊部門，2026-11-02；docs/ai-helper/spec.md §8、§12）
 * 管理 AI 小幫手：處理待回答（AI 擬答→上架）、知識庫（搜尋、編輯、上架／下架、看歷史回到舊版本）、用量。
 * 原生畫面，打平台後端（AiHelp.gs 的 aih* action，ns／backend＝platform）；金額與「AI 擬答」走 Mac mini 的 svc 路由 /platform/svc/ai-help。
 * 權限 platform.aihelp＝鎖碼，只有系統管理者能給；真正的把關在後端（aihEnter_）。
 */
'use strict';

export default {
  id: 'ai-help',
  ns: 'platform',
  backend: 'platform',
  name: '小幫手管理',
  desc: '待回答、知識庫、用量',
  icon: 'ai-help',
  work: 'system',              // 手機「功能」頁的工作分類（platform/config.js WORK_GROUPS）
  dept: 'it',
  requires: ['platform.aihelp'],
  views: [
    { id: 'pending', name: '待回答', requires: ['platform.aihelp'] },
    { id: 'kb', name: '知識庫', requires: ['platform.aihelp'] },
    { id: 'usage', name: '用量', requires: ['platform.aihelp'] }
  ],
  entry: () => import('./index.js')
};
