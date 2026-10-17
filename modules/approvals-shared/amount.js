/**
 * modules/approvals-shared/amount.js — 表單簽核金額（spec §14.6 唯一式子）
 * 與 apps-script/platform/ApprovalRoute.gs 的 apvCalcAmount_ 逐字相同（只差函式名）；
 * test/apv-route.test.mjs 比對兩邊原始碼與結果。要改兩邊一起改。
 */

'use strict';

export function apvCalcAmount(type, body) {
  var bad = { ok: false, error: 'bad_amount' };
  if (type === 'purchase') {
    var items = body && body.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 30) return { ok: false, error: 'bad_request' };
    var total = 0;
    var subtotals = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it !== 'object') return { ok: false, error: 'bad_request' };
      var q = it.qty;
      var p = it.price;
      if (typeof q !== 'number' || typeof p !== 'number' || !isFinite(q) || !isFinite(p)) return bad;
      if (!(q > 0) || q > 9999 || Math.abs(q * 100 - Math.round(q * 100)) > 1e-7) return bad;
      if (!(p > 0) || p > 1000000 || Math.floor(p) !== p) return bad;
      var s = Math.round(q * p);
      subtotals.push(s);
      total += s;
    }
    if (!(total > 0) || total > 10000000) return bad;
    return { ok: true, amount: total, subtotals: subtotals };
  }
  if (type === 'expense') {
    var a = body && body.amount;
    if (typeof a !== 'number' || !isFinite(a) || Math.floor(a) !== a || a < 1 || a > 10000000) return bad;
    return { ok: true, amount: a, subtotals: [] };
  }
  return { ok: true, amount: null, subtotals: [] };
}
