/**
 * 用量：本月題數、答得出來比例、👎 比例（aihUsage，由問答紀錄統計）＋本月花費／上限（svc op usage，正本是 Mac mini 的費用帳本）。
 * 金額讀不到（Mac mini 還沒更新、帳本不可用）不影響其他數字，只顯示「—」。
 */
'use strict';

import { h, clear, errText, pct } from '../lib.js';
import { getClient } from '../../../platform/helper/client.js';

const usd = (n) => (typeof n === 'number' && isFinite(n) ? 'US$ ' + n.toFixed(2) : '—');

function months() {
  const out = [];
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  let y = t.getUTCFullYear(), m = t.getUTCMonth() + 1;
  for (let i = 0; i < 6; i++) {
    out.push(y + '-' + (m < 10 ? '0' : '') + m);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

export function mountUsage(el, ctx, shared) {
  let alive = true;
  const client = (shared && shared.client) || getClient();
  const ms = months();
  let month = ms[0];
  const sel = h('select', { class: 'input', 'data-role': 'usage-month', 'aria-label': '月份', style: 'max-width:200px' }, ms.map((m) => h('option', { value: m }, m)));
  const body = h('div', { 'data-role': 'usage-body' });
  el.appendChild(h('div', { class: 'aim-filter' }, [sel]));
  el.appendChild(body);
  sel.addEventListener('change', () => { month = sel.value; load(); });

  function stat(label, value, extra) {
    return h('div', { class: 'aim-stat' }, [h('span', { class: 'aim-note' }, label), h('b', { 'data-role': 'stat-' + label }, value), extra || null]);
  }

  async function load() {
    clear(body);
    body.appendChild(h('p', { class: 'aim-note' }, '載入中…'));
    const [u, money] = await Promise.all([ctx.api.call('platform', 'aihUsage', { month }), client.usage()]);
    if (!alive) return;
    clear(body);
    if (!u || !u.ok) {
      body.appendChild(h('div', { class: 'card' }, [h('p', null, u && u.error === 'not_inited' ? '小幫手還沒初始化。請系統管理者按上方的「初始化小幫手」。' : errText(u))]));
      return;
    }
    const d = u.data || {};
    const cur = money.ok && money.data && money.data.month === month;
    const spent = cur ? money.data.usd : null;
    const cap = cur ? money.data.cap_usd : null;
    const ratio = (typeof spent === 'number' && typeof cap === 'number' && cap > 0) ? Math.min(1, spent / cap) : null;
    body.appendChild(h('div', { class: 'aim-grid' }, [
      stat('題數', String(d.count === undefined ? '—' : d.count)),
      stat('答得出來', pct(d.answered_ratio)),
      stat('👎 比例', pct(d.down_ratio)),
      stat('花費', usd(spent) + (typeof cap === 'number' ? ' ／ ' + usd(cap) : ''),
        ratio === null ? null : h('div', { class: 'aim-bar', 'data-role': 'usage-bar' }, [h('i', { style: 'width:' + Math.round(ratio * 100) + '%' })]))
    ]));
    if (!money.ok) body.appendChild(h('p', { class: 'aim-note', 'data-role': 'usage-money-err' }, '花費暫時讀不到：' + money.error));
    else if (!cur) body.appendChild(h('p', { class: 'aim-note' }, '花費只看得到本月。'));
    body.appendChild(h('p', { class: 'aim-note' }, d.paused ? '目前狀態：已暫停' : '目前狀態：運作中'));
    const days = Array.isArray(d.by_day) ? d.by_day : [];
    const max = days.reduce((a, x) => Math.max(a, x.count || 0), 0) || 1;
    const card = h('div', { class: 'card' }, [h('div', { class: 'card-title' }, '每日題數')]);
    if (!days.length) card.appendChild(h('p', { class: 'aim-note' }, '這個月還沒有人問。'));
    days.forEach((x) => card.appendChild(h('div', { class: 'aim-day', 'data-role': 'usage-day' }, [
      h('span', null, x.day), h('div', { class: 'aim-bar' }, [h('i', { style: 'width:' + Math.round((x.count || 0) / max * 100) + '%' })]), h('span', null, String(x.count))
    ])));
    body.appendChild(card);
  }

  load();
  return () => { alive = false; };
}
