// 小幫手管理「用量」：換月份時舊請求晚回來不畫（2026-11-05 Fable 審查第 1 條）。極簡假 DOM，⚠ 全部是假資料。
// 情境：開頁（本月 aihUsage 還在路上）→ 換到上個月 → 上個月先回 → 本月的晚回。畫面要維持上個月，問答紀錄只打上個月一次。
'use strict';

let passed = 0, failed = 0;
const ok = (c, msg, extra) => { if (c) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg + (extra === undefined ? '' : ' ' + JSON.stringify(extra))); } };

function el(tag) {
  return {
    tag, attrs: {}, kids: [], listeners: {}, _text: '',
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    appendChild(c) { this.kids.push(c); c.parent = this; return c; }, removeChild(c) { this.kids = this.kids.filter((x) => x !== c); },
    get firstChild() { return this.kids[0]; },
    get textContent() { return this._text || this.kids.map((k) => k.textContent).join(''); }, set textContent(v) { this._text = v; this.kids = []; },
    set innerHTML(_) { throw new Error('innerHTML 不准用'); },
    find(role) { if (this.attrs['data-role'] === role) return this; for (const k of this.kids) { const r = k.find && k.find(role); if (r) return r; } return null; },
    get value() { return this._v; }, set value(v) { this._v = v; }
  };
}
globalThis.document = { createElement: el, createTextNode: (t) => ({ textContent: String(t), find() { return null; } }) };
globalThis.window = globalThis;
const { mountUsage } = await import('../modules/ai-help/views/usage.js');

const pending = [];
const api = { call(ns, action, p) { return new Promise((res) => pending.push({ action, p, res })); } };
const client = { usage: async () => ({ ok: false, error: 'x' }) };
const root = el('div');
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
mountUsage(root, { api }, { client });
const sel = root.kids[0].kids[0];
await flush();
const thisMonth = sel.kids[0].value, prevMonth = sel.kids[1].value;
sel.value = prevMonth; sel.listeners.change[0]();
await flush();
const usageOf = (m) => pending.find((x) => x.action === 'aihUsage' && x.p.month === m);
usageOf(prevMonth).res({ ok: true, data: { month: prevMonth, count: 1, answered_ratio: 1, down_ratio: 0, by_day: [{ day: prevMonth + '-01', count: 1 }], paused: false } });
await flush();
usageOf(thisMonth).res({ ok: true, data: { month: thisMonth, count: 99, answered_ratio: 0.5, down_ratio: 0, by_day: [{ day: thisMonth + '-02', count: 99 }], paused: true } });
await flush();
const body = root.kids[1];
ok(body.find('stat-題數').textContent === '1', '舊月份的 aihUsage 晚回來不蓋掉目前月份的數字', body.find('stat-題數').textContent);
ok(body.find('usage-day').textContent.startsWith(prevMonth), '每日題數維持目前月份');
const logs = pending.filter((x) => x.action === 'aihLogList');
ok(logs.length === 1 && logs[0].p.month === prevMonth && logs[0].p.limit === 50 && !('before' in logs[0].p), '問答紀錄只打目前月份一次 {month, limit:50}', logs.map((x) => x.p));
logs[0].res({ ok: true, data: { month: prevMonth, total: 1, items: [{ id: 'aih_x', ts: '2026-10-02T02:00:00Z', m: '', v: '', q: '<b>假問題</b>', kind: 'unknown', answer: '這題我還不會', kb_ids: '', feedback: 'down' }], next: '' } });
await flush();
const cards = body.kids.filter((k) => k.attrs['data-role'] === 'log-card');
ok(cards.length === 1 && cards[0].find('log-q').textContent === '<b>假問題</b>', '問答紀錄卡一張、問題當純文字');
ok(cards[0].find('log-kind').textContent === '沒答出來' && !!cards[0].find('log-down'), '結果與 👎');
const more = cards[0].kids.find((k) => k.attrs.class === 'aim-act').kids[0];
ok(more.hidden === true, '沒有下一頁 → 「再顯示更多」藏起來');

// 第一頁讀不到 → 出現「重新讀取」，按了再打一次
sel.value = thisMonth; sel.listeners.change[0]();
await flush();
usageOf(thisMonth).res({ ok: true, data: { month: thisMonth, count: 0, answered_ratio: 0, down_ratio: 0, by_day: [], paused: false } });
const u2 = pending.filter((x) => x.action === 'aihUsage' && x.p.month === thisMonth);
u2[u2.length - 1].res({ ok: true, data: { month: thisMonth, count: 0, answered_ratio: 0, down_ratio: 0, by_day: [], paused: false } });
await flush();
const l2 = pending.filter((x) => x.action === 'aihLogList' && x.p.month === thisMonth);
l2[0].res({ ok: false, error: 'busy' });
await flush();
const card2 = root.kids[1].find('log-card');
const btn2 = card2.kids.find((k) => k.attrs.class === 'aim-act').kids[0];
ok(btn2.hidden === false && btn2.textContent === '重新讀取' && card2.find('log-err').textContent.includes('系統忙碌'), '第一頁讀不到 → 顯示錯誤＋「重新讀取」', [btn2.hidden, btn2.textContent]);
btn2.listeners.click[0]();
await flush();
ok(pending.filter((x) => x.action === 'aihLogList' && x.p.month === thisMonth).length === 2, '按「重新讀取」再打一次');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
