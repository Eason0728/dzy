/**
 * modules/me/views/team.js — 我的單位（店長；員工名單統一 D1～D3，docs/personnel/master-data/spec.md §4.1／§4.2）
 * 新增同仁、登記／撤銷離職、顯示打卡連結。資料是 staffUnitList（後端只回自己單位、不含手機生日地址）。
 * 2026-11-06 新進同仁申請（docs/self-apply）：只有「可新增同仁」例外（platform.unitstaff）、沒有「待審核」分頁的人，
 * 申請清單放在這頁上方（有店長／人資身分的人照舊在「待審核」審）。
 */
'use strict';

import { mountTeam } from '../../staff-shared/clock-ui.js';
import { viewerOf } from '../../staff-shared/viewer.js';
import { mountApplies } from './applies.js';

export function mountTeamView(el, ctx) {
  const onlyUnitStaff = ctx.can('platform.unitstaff') && !ctx.can('platform.review') && !ctx.can('platform.staff');
  if (!onlyUnitStaff) return mountTeam(el, { ctx, mod: 'me', viewer: viewerOf(ctx) });
  const top = document.createElement('div');
  top.setAttribute('data-role', 'team-applies');
  const body = document.createElement('div');
  el.appendChild(top);
  el.appendChild(body);
  const u1 = mountApplies(top, ctx);
  const u2 = mountTeam(body, { ctx, mod: 'me', viewer: viewerOf(ctx) });
  return () => { if (typeof u1 === 'function') u1(); if (typeof u2 === 'function') u2(); };
}
