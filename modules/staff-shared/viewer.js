/** 從 ctx 判斷看的人是總部還是店長（只決定顯示，真正的權限在後端） */
export function viewerOf(ctx) {
  const isHq = !!ctx.can('platform.staff');
  return { isHq, isLead: !isHq && !!ctx.can('platform.review'), user: ctx.user };
}
