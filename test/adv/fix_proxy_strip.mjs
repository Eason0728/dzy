// node test/adv/fix_proxy_strip.mjs —— 對抗驗證 ⑧「代轉請求剝除 operator／adminKey／admin_key／pin_master／key／level／scope／account」
// 攻擊：(1) 代轉 ns 頂層八欄位全剝、巢狀同名不動、dorm 的 payload.token 不能被剝；
//      (2) platform ns 不能被誤傷（approvals 的 scope 之類只在前端用，但保險起見 platform 一律只剝 token）；
//      (3) 用真的 call()＋假 fetch 看送出去的 body，不看註解。
'use strict';
import { call, proxyUrl } from '../../platform/api.js';
import { BACKENDS } from '../../platform/config.js';

let failed = 0, passed = 0;
function ok(c, label, extra) { if (c) passed++; else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  actual=' + JSON.stringify(extra) : '')); } }

let sent = null;
globalThis.fetch = async (url, opts) => { sent = { url: String(url), body: JSON.parse(opts.body) }; return { status: 200, json: async () => ({ ok: true, data: {} }) }; };

const DIRTY = { store: 'sxl-gf', operator: 'me', adminKey: 'k', admin_key: 'k', pin_master: 'p', key: 'k', level: 'admin', scope: '*', account: 'acc', token: 'sign-token', action: 'evil', code: 'c', pass: 'p', nested: { key: 'keep', level: 'keep', account: 'keep' } };

for (const ns of ['audit', 'dorm', 'payroll', 'cashbook', 'transfer', 'pnl', 'attendance', 'schedule']) {
  sent = null;
  await call(ns, 'whatever', { ...DIRTY });
  const p = sent && sent.body.payload;
  ok(sent && sent.url === proxyUrl() && sent.body.ns === ns, `${ns} 走代轉網址`, sent && sent.url);
  const leaked = ['operator', 'adminKey', 'admin_key', 'pin_master', 'key', 'level', 'scope', 'account', 'action', 'code', 'pass'].filter((k) => p && k in p);
  ok(leaked.length === 0, `${ns} 頂層敏感欄位全剝`, leaked);
  ok(p && p.store === 'sxl-gf' && p.token === 'sign-token', `${ns} 一般欄位與 payload.token（宿舍簽約 token）保留`, p);
  ok(p && p.nested && p.nested.key === 'keep' && p.nested.level === 'keep' && p.nested.account === 'keep', `${ns} 巢狀同名不動`, p && p.nested);
  ok(sent.body.action === 'whatever', `${ns} action 由平台決定（payload.action 不能覆寫）`, sent.body.action);
}

// platform ns：只剝 token；其他欄位（含 key／scope／level）照送——eval evBankSave 的 items[].key 是巢狀本來就不會動，這裡確認頂層也不被誤剝
{
  sent = null;
  await call('platform', 'evBankSave', { brand: 'mala', key: 'top-key', scope: 'mine', level: 'x', account: 'a', token: 'drop-me', items: [{ key: 'q1' }] });
  const p = sent.body.payload;
  ok(sent.url === BACKENDS.platform, 'platform 走平台網址');
  ok(!('token' in p) && p.key === 'top-key' && p.scope === 'mine' && p.level === 'x' && p.account === 'a' && p.items[0].key === 'q1', 'platform ns 不剝 key／scope／level／account，只剝 token', p);
}
// 原始 payload 物件不能被改到（呼叫端之後還要用）
{
  const mine = { ...DIRTY };
  await call('cashbook', 'x', mine);
  ok(mine.operator === 'me' && mine.key === 'k', '呼叫端自己的物件沒被 delete 到');
}

console.log(`fix_proxy_strip: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
