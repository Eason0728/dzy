/**
 * modules/ai-help/editor.js — 知識庫題目編輯框（待回答「上架」與知識庫「編輯／新增」共用）
 * 欄位：問題、答案、找誰、依據文件、所在頁面、「帶我去」頁面；全部純文字。
 * 回傳 {el, fill(obj), get()}：fill 把一份題目（草稿、AI 擬答、歷史快照）帶進欄位；get 取目前欄位值。
 */
'use strict';

import { h, taipeiDay } from './lib.js';

const FIELD = (label, input, hint) => h('div', { class: 'field' }, [
  h('label', { class: 'field-label' }, label),
  input,
  hint ? h('p', { class: 'field-hint' }, hint) : null
]);

function pageSelect(pages, value, opts) {
  const sel = h('select', { class: 'input', 'data-role': opts.role });
  sel.appendChild(h('option', { value: '' }, opts.noneLabel));
  const list = opts.needView ? pages.filter((p) => p.v) : pages;
  list.forEach((p) => sel.appendChild(h('option', { value: p.m + '|' + p.v }, p.label)));
  sel.value = value;
  if (sel.value !== value) {   // 目前的值不在地圖上（模組被拿掉）：也留一個選項，免得存檔時悄悄改掉
    sel.appendChild(h('option', { value }, value.replace('|', '/') + '（頁面地圖上已找不到）'));
    sel.value = value;
  }
  return sel;
}

/**
 * @param {{pages:Array, isEdit?:boolean}} o
 */
export function createEditor(o) {
  const pages = o.pages || [];
  const question = h('input', { class: 'input', type: 'text', maxlength: '200', 'data-role': 'ed-q' });
  const answer = h('textarea', { class: 'input', rows: '5', maxlength: '1500', 'data-role': 'ed-a' });
  const who = h('input', { class: 'input', type: 'text', maxlength: '100', 'data-role': 'ed-who', placeholder: '例：人資 王小姐、你的店長' });
  const source = h('input', { class: 'input', type: 'text', maxlength: '200', 'data-role': 'ed-source', placeholder: '依據哪份文件或規定' });
  const page = pageSelect(pages, '', { role: 'ed-page', noneLabel: '通用（不限頁面）' });
  const go = pageSelect(pages, '', { role: 'ed-go', noneLabel: '不帶我去', needView: true });
  const verify = h('input', { type: 'checkbox', 'data-role': 'ed-verify' });
  verify.checked = !!o.isEdit;
  const verifyRow = o.isEdit
    ? h('label', { class: 'field-hint', style: 'display:flex;gap:6px;align-items:center' }, [verify, '我已確認內容仍正確（確認日期改成今天，有效期從今天起 180 天）'])
    : null;

  const el = h('div', { class: 'aim-edit', 'data-role': 'ed' }, [
    FIELD('問題（≤200 字）', question),
    FIELD('答案（≤1500 字）', answer),
    FIELD('找誰（沒有可留白）', who),
    FIELD('依據文件', source),
    FIELD('這題屬於哪一頁', page, '選了才會只給看得到那一頁的人用；通用＝人人都能用。'),
    FIELD('答案下面的「帶我去」按鈕', go),
    verifyRow
  ]);

  function setSel(sel, list, m, v, needView) {
    const val = m ? m + '|' + v : '';
    sel.value = val;
    if (sel.value !== val && val) {
      sel.appendChild(h('option', { value: val }, m + (v ? '/' + v : '') + '（頁面地圖上已找不到）'));
      sel.value = val;
    }
  }

  return {
    el,
    fill(d) {
      const x = d || {};
      question.value = x.question || '';
      answer.value = x.answer || '';
      who.value = x.who || '';
      source.value = x.source || '';
      setSel(page, pages, x.m || '', x.v || '');
      setSel(go, pages, x.go_m || '', x.go_v || '', true);
    },
    get() {
      const [m, v] = String(page.value || '').split('|');
      const [gm, gv] = String(go.value || '').split('|');
      const out = {
        question: question.value.trim(), answer: answer.value.trim(), who: who.value.trim(), source: source.value.trim(),
        m: m || '', v: v || '', go_m: gm || '', go_v: gv || ''
      };
      if (o.isEdit && verify.checked) out.verified_at = taipeiDay();
      return out;
    },
    focus() { try { question.focus(); } catch (e) { /* ignore */ } }
  };
}
