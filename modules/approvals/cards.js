/**
 * modules/approvals/cards.js — 單據卡片與明細的 HTML（純字串函式，不碰 DOM，方便測試）
 * 樣式一律沿用 components.css 既有 class（card／tag／btn／table）；少量版面用 inline style 且只引用 tokens 變數。
 */
'use strict';

import { TYPE_LABEL, KIND_LABEL, CATEGORY, STATUS, whereText, visibleActions, money, ROLE_LABEL } from './lib.js';

export const ACTION_LABEL = {
  submit: '送出', resubmit: '改完再送', approve: '核准', reject: '退回', skip: '跳過（沒人可簽）', reassign: '改派',
  withdraw: '撤回', handle: '承辦處理', sign: '本人簽名', void: '作廢'
};

const THUMB = 'width:72px;height:72px;object-fit:cover;border-radius:var(--radius);border:1px solid var(--line);background:var(--bg);cursor:pointer';

export function statusTag(status, esc) {
  const s = STATUS[status] || [status || '', ''];
  return `<span class="tag ${s[1]}">${esc(s[0])}</span>`;
}

/** 照片縮圖列：<img data-file> 由 hydrateImages 之後補 src。kind=sign 的簽名檔不放縮圖（只在明細看） */
export function thumbsHtml(files, esc, max = 5) {
  const list = (files || []).filter((f) => f && f.kind !== 'sign').slice(0, max);
  if (!list.length) return '';
  return `<div class="btn-row" data-role="thumbs">${list.map((f) => `<img data-file="${esc(f.id)}" alt="照片" style="${THUMB}">`).join('')}</div>`;
}

/**
 * 一張單的卡片。scope: sign／handle／mine／all（決定哪些按鈕可能出現，實際看 form.can）。
 */
export function cardHtml(form, scope, esc, fmt) {
  const f = form || {};
  const who = f.sender ? `${f.sender.unit_name || ''} ${f.sender.name || ''}`.trim() : '';
  const subj = f.subject && f.subject.name ? `｜對象：${f.subject.name}` : '';
  const where = whereText(f);
  const acts = visibleActions(f, scope);
  const rejected = f.status === 'rejected' && f.reject_note ? `<p class="field-hint">退回原因：${esc(f.reject_note)}</p>` : '';
  return `
  <div class="card stack" data-role="apv-card" data-id="${esc(f.id)}" data-status="${esc(f.status)}"${f.stuck ? ' data-stuck="1"' : ''}>
    <div class="card-row row-wrap">
      <div class="card-title">${esc(f.id)}　${esc(TYPE_LABEL[f.type] || f.type)}</div>
      <div class="btn-row">${f.stuck ? '<span class="tag tag-danger">卡關</span>' : ''}${statusTag(f.status, esc)}</div>
    </div>
    <p class="text-muted">${esc(who)}${esc(subj)}${typeof f.amount === 'number' ? `｜NT$ ${esc(money(f.amount))}` : ''}${f.created_at ? `｜${esc(fmt.datetime(f.created_at))}` : ''}</p>
    ${where ? `<p>${esc(where)}</p>` : ''}
    ${rejected}
    ${thumbsHtml(f.files, esc)}
    <div data-role="detail"></div>
    <div class="btn-row">
      <button type="button" class="btn btn-secondary" data-act="view">展開明細</button>
      ${acts.map((a) => `<button type="button" class="btn ${a.variant}" data-act="${a.act}">${esc(a.label)}</button>`).join('')}
    </div>
  </div>`;
}

function row(th, td, esc) { return `<tr><th>${esc(th)}</th><td>${td}</td></tr>`; }

export function bodyHtml(form, esc) {
  const b = (form && form.body) || {};
  if (form.type === 'purchase') {
    const items = Array.isArray(b.items) ? b.items : [];
    return `<div class="table-wrap"><table class="table"><thead><tr><th>品名</th><th>數量</th><th>單位</th><th>單價</th></tr></thead><tbody>
      ${items.map((it) => `<tr><td>${esc(it.name)}</td><td>${esc(it.qty)}</td><td>${esc(it.unit)}</td><td>${esc(money(it.price))}</td></tr>`).join('')}
      </tbody></table></div>
      <table class="table"><tbody>${row('廠商', esc(b.vendor || '—'), esc)}${row('用途', esc(b.purpose), esc)}${row('需求日', esc(b.need_date), esc)}${row('合計', `NT$ ${esc(money(form.amount))}`, esc)}</tbody></table>`;
  }
  if (form.type === 'expense') {
    return `<table class="table"><tbody>${row('支出日', esc(b.spend_date), esc)}${row('類別', esc(CATEGORY[b.category] || b.category), esc)}${row('金額', `NT$ ${esc(money(b.amount))}`, esc)}${row('說明', esc(b.desc), esc)}
      ${row('付款對象', b.payee === 'vendor' ? `廠商：${esc(b.vendor_name || '')}` : '還代墊的同仁（自己）', esc)}${b.purchase_id ? row('對應請購單', esc(b.purchase_id), esc) : ''}</tbody></table>`;
  }
  if (form.type === 'personnel') {
    const side = (o) => o ? [o.unit, o.title, o.pay !== undefined && o.pay !== null && o.pay !== '' ? `薪資 ${money(Number(o.pay))}` : ''].filter(Boolean).join('／') : '';
    return `<table class="table"><tbody>${row('種類', esc(KIND_LABEL[b.kind] || b.kind), esc)}${row('生效日', esc(b.effective), esc)}${row('原本', esc(side(b.from) || '—'), esc)}${row('改成', esc(side(b.to) || '—'), esc)}${row('原因', esc(b.reason), esc)}</tbody></table>`;
  }
  return '';
}

export function eventsHtml(events, esc, fmt) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return '';
  return `<div class="field-hint">處理紀錄</div><ul>${list.map((e) => `<li>${esc(fmt.datetime(e.at))}　${esc((e.actor && e.actor.name) || '')}　${esc(ACTION_LABEL[e.action] || e.action)}${e.note ? `：${esc(e.note)}` : ''}</li>`).join('')}</ul>`;
}

/** 展開後的明細（apvGet 回來的 {form, events}） */
export function detailHtml(data, esc, fmt) {
  const form = (data && data.form) || {};
  const files = Array.isArray(form.files) ? form.files : [];
  const imgs = files.map((f) => `<img data-file="${esc(f.id)}" data-big="1" alt="${f.kind === 'sign' ? '簽名' : '照片'}" style="${THUMB}">`).join('');
  const steps = ((form.route && form.route.steps) || []).map((s, i) => {
    const mark = s.status === 'done' ? '✓' : s.status === 'skipped' ? '跳過' : (i === form.step && form.status === 'signing' ? '▶' : '○');
    const names = (s.candidates || []).map((c) => c.name).join('、');
    return `<li>${esc(mark)} ${esc(ROLE_LABEL[s.role] || s.role)}${names ? `（${esc(names)}）` : ''}</li>`;
  }).join('');
  return `<div class="stack" data-role="detail-body">
    ${bodyHtml(form, esc)}
    ${imgs ? `<div class="btn-row">${imgs}</div>` : ''}
    ${steps ? `<div class="field-hint">簽核路線</div><ul>${steps}</ul>` : ''}
    ${eventsHtml(data && data.events, esc, fmt)}
  </div>`;
}
