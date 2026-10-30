// node test/adv/fix_err_text.mjs —— 對抗驗證 ⑬（權限設定 errorText）與 ⑮（績效評核 errText）
// 不信任兩邊註解寫的「api.js 會壓成什麼形狀」：直接用真的 platform/api.js call() ＋假 fetch，
// 餵後端原形 permAcFail_(code, message)＝{ok:false,error:message,code} 與 evFail_(code,message)＝{ok:false,error:code,message}，
// 再把 call() 的回傳丟進 errorText／errText，看畫面會顯示什麼。
'use strict';
import { call } from '../../platform/api.js';
import { errorText } from '../../modules/perms/lib.js';
import { errText } from '../../modules/eval/lib.js';

let failed = 0, passed = 0;
function ok(c, label, extra) { if (c) passed++; else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  actual=' + JSON.stringify(extra) : '')); } }

function fetchReturning(json) { globalThis.fetch = async () => ({ status: 200, json: async () => json }); }
async function through(json) { fetchReturning(json); return call('platform', 'x', {}); }

// ── 權限設定（PermActions.gs permAcFail_）──
{
  const r = await through({ ok: false, error: '不能對自己設定例外', code: 'perm_self' });
  ok(errorText(r) === '不能對自己設定例外', 'perm_self 帶人話 → 顯示後端人話', { r, t: errorText(r) });
}
{
  const r = await through({ ok: false, error: '沒有權限', code: 'no_perm' });
  ok(errorText(r) === '沒有權限', 'no_perm → 沒有權限', errorText(r));
}
{
  const r = await through({ ok: false, error: 'perm_locked', code: 'perm_locked' });   // 舊後端只回碼
  ok(errorText(r) === '只有系統管理員能改這個功能的對象', '只有代碼 → 固定句', errorText(r));
}
{
  const r = await through({ ok: false, error: 'perm_admin_only' });   // 沒 code 欄位、error 就是碼
  ok(errorText(r) === '人資主管要請系統管理員設定', 'error 是已知碼、沒 code → 固定句', errorText(r));
}
{
  const r = await through({ ok: false, error: 'weird_code' });
  ok(errorText(r) === 'weird_code', '未知碼原樣（舊行為）', errorText(r));
}
{
  const r = await through({ ok: false });
  ok(errorText(r) === '請求失敗', 'error 空 → api.js 的通用句', errorText(r));
}
ok(errorText(null) === '失敗了，請稍後再試' && errorText({}) === '失敗了，請稍後再試', 'null／{} → 通用句');
{
  globalThis.fetch = async () => { throw new Error('boom'); };
  const r = await call('platform', 'x', {});
  ok(errorText(r) === 'boom', '網路錯誤訊息直接顯示', errorText(r));
}
// 後端人話剛好等於 ERROR_FIXED 的 key？不可能發生，但要確定不會變 undefined
{
  const r = await through({ ok: false, error: 'no_perm', code: 'perm_self' });
  ok(typeof errorText(r) === 'string' && errorText(r).length > 0, 'error 是別的已知碼、code 又不同 → 仍有字', errorText(r));
}

// ── 績效評核（Eval.gs evFail_）──
{
  const r = await through({ ok: false, error: 'window_closed', message: '' });
  ok(errText(r) === '現在不是填寫期間（每季第一個月 1～5 號）', 'window_closed 沒 message → 翻中文', errText(r));
}
{
  const r = await through({ ok: false, error: 'bad_request', message: '分數要 1～5' });
  ok(errText(r) === '分數要 1～5', '有 message → 顯示 message', errText(r));
}
{
  const r = await through({ ok: false, error: 'something_new' });
  ok(errText(r) === 'something_new', '未知碼原樣', errText(r));
}
{
  const r = await through({ ok: false });
  ok(errText(r) === '請求失敗', 'error 空 → api.js 通用句', errText(r));
}
ok(errText(null) === '連不上伺服器，請稍後再試', 'null → 連不上');
{
  // data.message 不是字串（後端亂回）→ 不能顯示 [object Object]
  const r = await through({ ok: false, error: 'forbidden', message: { x: 1 } });
  ok(errText(r) === '沒有權限', 'message 非字串 → 退回翻碼', errText(r));
}

console.log(`fix_err_text: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
