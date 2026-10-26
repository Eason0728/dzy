/**
 * modules/eval/manifest.js — 績效評核（2026-10-26，docs/eval/spec.md）
 * 舊站 mala-eval 搬進人資部門、三品牌＋中央工廠共用。打平台後端（Eval.gs 的 ev* action），ns／backend＝platform。
 * 分頁看不看得到只看這裡的 requires（任一符合）；真正的範圍一律後端判（evScope_）。
 */
'use strict';

export default {
  id: 'eval',
  ns: 'platform',
  backend: 'platform',
  name: '績效評核',
  desc: '每季互評、自評、成績與新人考核',
  icon: 'eval',
  dept: 'hr',
  requires: ['platform.login'],
  views: [
    { id: 'fill', name: '填寫評鑑', requires: ['platform.login'] },
    { id: 'self', name: '自評', requires: ['platform.login'] },
    { id: 'mine', name: '我的成績', requires: ['platform.login'] },
    { id: 'newbie', name: '新人考核', requires: ['platform.eval-manage'] },
    { id: 'results', name: '單位結果', requires: ['platform.eval-manage', 'platform.eval-brand', 'platform.eval-all'] },
    { id: 'settings', name: '設定', requires: ['platform.eval-admin'] }
  ],
  entry: () => import('./index.js')
};
