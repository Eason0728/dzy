/**
 * 待我辦（spec §7）：財務／採購／人資部的人，簽完的單按「已處理」或退回送件人；
 * 人資／admin 另外會看到「找不到簽核人」的單（exception），可以改派。
 */
'use strict';

import { mountCardList } from '../list-view.js';

export function mountHandle(el, ctx) {
  return mountCardList(el, ctx, {
    scope: 'handle',
    title: '待我辦',
    hint: '簽核完成、輪到你的部門承辦的單。處理完按「已處理」，有問題退回送件人。',
    empty: '目前沒有等你辦的單',
    load: async () => {
      const r = await ctx.api.call('approvals', 'apvTodo', {});
      if (!r || !r.ok) return r || { ok: false };
      const d = r.data || {};
      return { ok: true, sections: [
        { title: '待承辦', forms: Array.isArray(d.handle) ? d.handle : [] },
        { title: '找不到合格簽核人（請指派）', forms: Array.isArray(d.exception) ? d.exception : [] }
      ] };
    }
  });
}
