/**
 * 用量：本月題數、答得出來比例、👎 比例（aihUsage，由問答紀錄統計）＋本月花費／上限（svc op usage，正本是 Mac mini 的費用帳本）。
 * 金額讀不到（Mac mini 還沒更新、帳本不可用）不影響其他數字，只顯示「—」。
 * 每日題數下面是「問答紀錄」（aihLogList，2026-11-05）：所選月份每一題，新的在前，一次 50 筆、按「再顯示更多」往下接。
 * 問題與回答一律當純文字（h() 建文字節點）；問題在寫進紀錄前已遮掉手機、身分證、email、DZY 編號與在職同仁姓名。
 */
'use strict';

import { h, clear, errText, pct, loadPages, pageLabel } from '../lib.js';
import { getClient } from '../../../platform/helper/client.js';

const usd = (n) => (typeof n === 'number' && isFinite(n) ? 'US$ ' + n.toFixed(2) : '—');
const KIND_ZH = { answered: '答得出來', unknown: '沒答出來' };
const LOG_PAGE = 50;
const ANSWER_SHORT = 80;

/** ISO → 台北「MM-DD HH:mm」；解析不了就原樣 */
function taipeiTime(ts) {
  const ms = Date.parse(ts);
  if (isNaN(ms)) return String(ts || '');
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

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
    const forMonth = month;
    clear(body);
    body.appendChild(h('p', { class: 'aim-note' }, '載入中…'));
    const [u, money] = await Promise.all([ctx.api.call('platform', 'aihUsage', { month }), client.usage()]);
    if (!alive || forMonth !== month) return;   // 換月份時舊請求晚回來：不畫
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
    body.appendChild(logCard(forMonth));
  }

  /** 問答紀錄：先畫卡片，再讀第一頁；「再顯示更多」帶上一頁回的 next */
  function logCard(forMonth) {
    const box = h('div', { class: 'card', 'data-role': 'log-card' }, [h('div', { class: 'card-title' }, '問答紀錄')]);
    const note = h('p', { class: 'aim-note', 'data-role': 'log-count' }, '載入中…');
    const list = h('div', { 'data-role': 'log-list' });
    const more = h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'log-more', hidden: true }, '再顯示更多');
    const err = h('p', { class: 'field-hint', 'data-role': 'log-err' });
    box.appendChild(note); box.appendChild(list); box.appendChild(h('div', { class: 'aim-act' }, [more])); box.appendChild(err);
    let next = '';
    let shown = 0;

    async function page() {
      more.disabled = true;
      err.textContent = '';
      const payload = { month: forMonth, limit: LOG_PAGE };
      if (next) payload.before = next;
      const [r, pages] = await Promise.all([ctx.api.call('platform', 'aihLogList', payload), loadPages()]);
      if (!alive || forMonth !== month) return;
      more.disabled = false;
      if (!r || !r.ok) {
        if (!shown) note.textContent = '';
        err.textContent = '問答紀錄讀不到：' + errText(r);
        more.textContent = shown ? '再顯示更多' : '重新讀取';
        more.hidden = false;
        return;
      }
      const d = r.data || {};
      const items = Array.isArray(d.items) ? d.items : [];
      items.forEach((it) => list.appendChild(row(it, pages)));
      shown += items.length;
      more.textContent = '再顯示更多';
      next = typeof d.next === 'string' ? d.next : '';
      note.textContent = d.total ? '共 ' + Math.max(d.total, shown) + ' 題，顯示 ' + shown + ' 題（新的在前）' : (shown ? '顯示 ' + shown + ' 題（新的在前）' : '這個月沒有問答紀錄。');
      more.hidden = !next;
    }
    more.addEventListener('click', page);
    page();
    return box;
  }

  function row(it, pages) {
    const box = h('div', { class: 'aim-item', 'data-role': 'log-item', 'data-id': it.id });
    const down = it.feedback === 'down';
    box.appendChild(h('div', { class: 'aim-meta' }, [
      h('span', { 'data-role': 'log-time', style: 'white-space:nowrap' }, taipeiTime(it.ts)), '　·　',
      h('span', { 'data-role': 'log-page' }, pageLabel(pages, it.m, it.v)), '　·　',
      h('span', { class: 'aim-chip' + (it.kind === 'answered' ? '' : ' is-paused'), 'data-role': 'log-kind' }, KIND_ZH[it.kind] || it.kind || '—'),
      down ? ' ' : null,
      down ? h('span', { class: 'aim-chip is-paused', 'data-role': 'log-down', title: '同仁按了 👎' }, '👎') : null,
      it.feedback === 'up' ? ' ' : null,
      it.feedback === 'up' ? h('span', { class: 'aim-chip', 'data-role': 'log-up', title: '同仁按了 👍' }, '👍') : null
    ]));
    box.appendChild(h('div', { class: 'aim-q', 'data-role': 'log-q' }, it.q || '（沒有問題內容）'));
    const ans = String(it.answer || '');
    if (ans) {
      const long = ans.length > ANSWER_SHORT;
      const a = h('div', { class: 'aim-a aim-note', 'data-role': 'log-a' }, long ? ans.slice(0, ANSWER_SHORT) + '…' : ans);
      box.appendChild(a);
      if (long) {
        let open = false;
        const tg = h('button', { type: 'button', class: 'btn btn-secondary aim-more', 'data-act': 'log-toggle' }, '看全文');
        tg.addEventListener('click', () => {
          open = !open;
          a.textContent = open ? ans : ans.slice(0, ANSWER_SHORT) + '…';
          tg.textContent = open ? '收起' : '看全文';
        });
        box.appendChild(tg);
      }
    }
    return box;
  }

  load();
  return () => { alive = false; };
}
