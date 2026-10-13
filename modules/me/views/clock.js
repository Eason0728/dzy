/**
 * modules/me/views/clock.js — 打卡對照（店長；員工名單統一 D4，spec §4.3 第 3 點）
 * 自己單位的 suggested 一列列按「對／不對」；不對＝轉總部。
 */
'use strict';

import { mountClockMap } from '../../staff-shared/clock-ui.js';
import { viewerOf } from '../../staff-shared/viewer.js';

export function mountClockView(el, ctx) {
  return mountClockMap(el, { ctx, mod: 'me', viewer: viewerOf(ctx) });
}
