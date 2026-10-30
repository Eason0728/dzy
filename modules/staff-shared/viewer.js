/** 從 ctx 判斷看的人是總部還是店長（只決定顯示，真正的權限在後端） */
export function viewerOf(ctx) {
  const isHq = !!ctx.can('platform.staff');
  // isLead：單位主管（platform.review）或有「可新增同仁」例外的人（platform.unitstaff，2026-10-30）
  return { isHq, isLead: !isHq && !!(ctx.can('platform.review') || ctx.can('platform.unitstaff')), user: ctx.user };
}
