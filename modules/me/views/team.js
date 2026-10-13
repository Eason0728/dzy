/**
 * modules/me/views/team.js — 我的單位（店長；員工名單統一 D1～D3，docs/personnel/master-data/spec.md §4.1／§4.2）
 * 新增同仁、登記／撤銷離職、顯示打卡連結。資料是 staffUnitList（後端只回自己單位、不含手機生日地址）。
 */
'use strict';

import { mountTeam } from '../../staff-shared/clock-ui.js';
import { viewerOf } from '../../staff-shared/viewer.js';

export function mountTeamView(el, ctx) {
  return mountTeam(el, { ctx, mod: 'me', viewer: viewerOf(ctx) });
}
