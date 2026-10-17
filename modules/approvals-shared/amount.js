/**
 * modules/approvals-shared/amount.js — 請購金額唯一式子（docs/approvals/spec.md §14.6）
 *
 * ⚠ 暫行版：後端實作者會另建同名檔（apvCalcAmount，與 Approvals.gs 的 apvCalcAmount_ 逐字比對）。
 * 合併時以對方為準；前端只透過 modules/approvals/lib.js 的 calcPurchase() 呼叫並正規化回傳，
 * 所以對方的回傳形狀只要是「數字」或「含 ok／amount／subtotals 的物件」都接得住。
 *
 * 規則：qty 數字、0 < qty ≤ 9999、最多兩位小數；price 整數元、0 < price ≤ 1,000,000；
 *       subtotal = Math.round(qty × price)；amount = Σ subtotal；amount ≤ 10,000,000。
 *       負數、0、字串、NaN、Infinity 一律 bad_amount。
 * 反例：qty=1.5、price=333 → 小計 500（499.5 四捨五入）。
 */
'use strict';

const MAX_AMOUNT = 10000000;

function isNum(v) { return typeof v === 'number' && isFinite(v); }

/**
 * @param {Array<{qty:number, price:number}>} items
 * @returns {{ok:true, amount:number, subtotals:number[]} | {ok:false, error:'bad_amount', row?:number}}
 */
export function apvCalcAmount(items) {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'bad_amount' };
  const subtotals = [];
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const qty = it.qty;
    const price = it.price;
    if (!isNum(qty) || !(qty > 0) || qty > 9999) return { ok: false, error: 'bad_amount', row: i };
    if (Math.abs(Math.round(qty * 100) - qty * 100) > 1e-6) return { ok: false, error: 'bad_amount', row: i };
    if (!isNum(price) || !Number.isInteger(price) || !(price > 0) || price > 1000000) return { ok: false, error: 'bad_amount', row: i };
    const sub = Math.round(qty * price);
    subtotals.push(sub);
    total += sub;
  }
  if (!(total > 0) || total > MAX_AMOUNT) return { ok: false, error: 'bad_amount' };
  return { ok: true, amount: total, subtotals };
}
