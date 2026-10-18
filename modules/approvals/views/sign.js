/**
 * 待我簽（spec §7）：卡片＝單號、送件人、金額、照片縮圖；核准／退回；離職單本人簽名關。
 */
'use strict';

import { mountCardList } from '../list-view.js';

export function mountSign(el, ctx) {
  return mountCardList(el, ctx, {
    scope: 'sign',
    title: '待我簽',
    hint: '輪到你簽的單。展開明細可以看內容與照片；退回要寫原因。',
    empty: '目前沒有等你簽的單',
    load: async () => {
      const r = await ctx.api.call('approvals', 'apvTodo', {});
      if (!r || !r.ok) return r || { ok: false };
      return { ok: true, sections: [{ forms: Array.isArray(r.data && r.data.sign) ? r.data.sign : [] }] };
    }
  });
}
