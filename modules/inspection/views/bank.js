/**
 * 題目設定：選品牌 → 四張表（服務／環境／菜色／經營評鑑）各自的分類與題目，可新增、改字、刪除、上下移、存檔。
 * Eason 2026-10-27：小辛辣用預設題目；墨竹亭（與一悟）先空白、開放自行新增。
 * 誰能改：platform.insp-bank（營運部全部品牌、品牌總監只有自己品牌；後端 inspBankSave 判）。
 * 存檔後新開的巡檢用新題目；已送出的巡檢存的是當時的題目，不受影響。
 */
'use strict';

import { defaultForms } from '../questions.js';
import { BONUS_CAP } from '../scoring.js';
import { errText } from '../lib.js';

/** 一張表全部加分題可拿的總分（打勾加分 points、自由填寫 points×max） */
export function bonusPossible(f) {
  return f.categories.filter((c) => c.role === 'bonus').reduce((s, c) => s + c.items.reduce((t, it) => t + (it.type === 'bonus_free' ? (Number(it.points) || 0) * (Number(it.max) || 0) : (Number(it.points) || 0)), 0), 0);
}
const ROLE_NAME = { scored: '評分題', bonus: '加分項', penalty: '加重扣分' };
const TYPE_BY_ROLE = {
  scored: [['score', '0～5 分'], ['critical', '重大缺失（正常 5／發生 0）'], ['binary', '只有 0 或 5']],
  bonus: [['bonus', '打勾加分'], ['bonus_free', '自由填寫加分']],
  penalty: [['penalty', '勾選扣總分']]
};

function uid() { return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }

export function mountBank(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let me = null;
  let brand = '';
  let ver = '';
  let forms = null;
  let tab = 'service';
  let dirty = false;

  el.innerHTML = '<p class="ip-note">載入中…</p>';
  (async () => {
    const r = await ctx.api.call('inspection', 'inspMe', {});
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc(errText(r))}</p></div>`; return; }
    me = r.data;
    if (!me.ready) { el.innerHTML = `<div class="card"><p>${esc(errText({ error: 'not_inited' }))}</p></div>`; return; }
    const brands = me.bank_brands || [];
    if (!brands.length) { el.innerHTML = '<div class="card"><p>你沒有設定題目的權限（權限設定 →「營運巡檢：題目設定」）。</p></div>'; return; }
    brand = (ctx.params && ctx.params.brand && brands.some((b) => b.brand === ctx.params.brand)) ? ctx.params.brand : brands[0].brand;
    load();
  })();

  async function load() {
    el.innerHTML = '<p class="ip-note">載入中…</p>';
    const r = await ctx.api.call('inspection', 'inspBankGet', { brand });
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc(errText(r))}</p></div>`; return; }
    ver = r.data.ver || '';
    forms = JSON.parse(JSON.stringify(r.data.forms || defaultForms(brand)));
    dirty = false;
    render();
  }

  function form() { return forms.find((f) => f.id === tab) || forms[0]; }

  function render() {
    const brands = me.bank_brands || [];
    const f = form();
    const n = forms.reduce((s, x) => s + x.categories.reduce((t, c) => t + c.items.length, 0), 0);
    el.innerHTML = `<div class="card"><div class="ip-row">
        <label>品牌 <select class="input" data-role="brand">${brands.map((b) => `<option value="${esc(b.brand)}"${b.brand === brand ? ' selected' : ''}>${esc(b.brand_name)}</option>`).join('')}</select></label>
        <span class="ip-note">${ver ? `目前版本 ${esc(ver)}` : '尚未存過（顯示的是預設）'}・共 ${n} 題</span></div>
        <p class="ip-note">存檔後，新開的巡檢用新題目；已送出的巡檢不受影響。評分題的分類權重加起來要 100%。每張表的加分總額上限 +${BONUS_CAP}（超過不計；一張表可拿的加分加起來不能超過 ${BONUS_CAP * 2}）。</p></div>
      <div class="ip-tabs">${forms.map((x) => `<button class="ip-tab${x.id === tab ? ' on' : ''}" data-tab="${x.id}">${esc(x.name)}<span class="n">${x.categories.reduce((t, c) => t + c.items.length, 0) || ''}</span></button>`).join('')}</div>
      <div class="card"><div class="card-title">${esc(f.name)}${f.inOperational ? '（算進營運巡檢總分）' : '（單獨計分）'}</div>
        <label>表頭說明 <input class="input" data-role="heading" value="${esc(f.heading || '')}" maxlength="60"></label>
        <div data-role="cats">${f.categories.map((c, ci) => catHtml(c, ci, f.categories.length)).join('') || '<p class="ip-note">這張表還沒有題目。</p>'}</div>
        <div class="ip-row">
          <button class="btn" data-act="addcat" data-role-v="scored">＋ 評分分類</button>
          <button class="btn" data-act="addcat" data-role-v="bonus">＋ 加分項分類</button>
          <button class="btn" data-act="addcat" data-role-v="penalty">＋ 加重扣分分類</button>
        </div></div>
      <div class="ip-sticky"><span class="ip-note" data-role="dirty">${dirty ? '有改動還沒存' : '沒有未存的改動'}</span>
        <div class="ip-row"><button class="btn" data-act="reload">放棄改動</button><button class="btn btn-primary" data-act="save">存檔</button></div></div>`;
    bind();
  }

  function catHtml(c, ci, total) {
    const w = c.role === 'scored' ? `<label>權重 <input class="input" type="number" min="1" max="100" step="1" style="width:80px" data-act="weight" data-ci="${ci}" value="${Math.round((c.weight || 0) * 100)}">%</label>` : '';
    const items = c.items.map((it, ii) => itemHtml(c, ci, it, ii)).join('');
    return `<div class="ip-item" data-ci="${ci}">
      <div class="ip-row"><strong>${ROLE_NAME[c.role]}</strong>
        <input class="input" style="flex:1;min-width:160px" data-act="catname" data-ci="${ci}" value="${esc(c.name)}" maxlength="30" placeholder="分類名稱">
        ${w}
        <button class="btn btn-sm" data-act="catup" data-ci="${ci}"${ci === 0 ? ' disabled' : ''} aria-label="分類上移">↑</button>
        <button class="btn btn-sm" data-act="catdown" data-ci="${ci}"${ci === total - 1 ? ' disabled' : ''} aria-label="分類下移">↓</button>
        <button class="btn btn-sm btn-danger" data-act="catdel" data-ci="${ci}">刪除分類</button></div>
      ${items || '<p class="ip-note">這個分類還沒有題目。</p>'}
      <div><button class="btn btn-sm" data-act="additem" data-ci="${ci}">＋ 新增題目</button></div></div>`;
  }

  function itemHtml(c, ci, it, ii) {
    const types = TYPE_BY_ROLE[c.role];
    const pts = (it.type === 'bonus' || it.type === 'bonus_free' || it.type === 'penalty')
      ? `<label>分數 <input class="input" type="number" min="1" max="20" style="width:70px" data-act="points" data-ci="${ci}" data-ii="${ii}" value="${Number(it.points) || 1}"></label>` : '';
    const max = it.type === 'bonus_free' ? `<label>最多 <input class="input" type="number" min="1" max="10" style="width:60px" data-act="max" data-ci="${ci}" data-ii="${ii}" value="${Number(it.max) || 1}"> 項</label>` : '';
    return `<div class="ip-ev" style="border-top:1px dashed var(--line);padding-top:8px">
      <div class="ip-row"><span>${ii + 1}.</span>
        <select class="input" data-act="type" data-ci="${ci}" data-ii="${ii}">${types.map(([v, n]) => `<option value="${v}"${it.type === v ? ' selected' : ''}>${n}</option>`).join('')}</select>
        ${pts}${max}
        <button class="btn btn-sm" data-act="itemup" data-ci="${ci}" data-ii="${ii}"${ii === 0 ? ' disabled' : ''} aria-label="題目上移">↑</button>
        <button class="btn btn-sm" data-act="itemdown" data-ci="${ci}" data-ii="${ii}"${ii === c.items.length - 1 ? ' disabled' : ''} aria-label="題目下移">↓</button>
        <button class="btn btn-sm btn-danger" data-act="itemdel" data-ci="${ci}" data-ii="${ii}">刪除</button></div>
      <textarea class="input" rows="2" data-act="text" data-ci="${ci}" data-ii="${ii}" maxlength="300" placeholder="題目內容">${esc(it.text)}</textarea></div>`;
  }

  function touch() { dirty = true; const d = el.querySelector('[data-role=dirty]'); if (d) d.textContent = '有改動還沒存'; }
  function swap(arr, i, j) { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }

  function bind() {
    el.querySelector('[data-role=brand]').onchange = async (e) => {
      if (dirty && !(await ctx.ui.confirm('有改動還沒存，切換品牌會放棄這些改動？'))) { e.target.value = brand; return; }
      brand = e.target.value; tab = 'service'; load();
    };
    el.querySelector('[data-role=heading]').oninput = (e) => { form().heading = e.target.value; touch(); };
    el.onclick = async (e) => {
      const t = e.target.closest('[data-act],[data-tab]');
      if (!t || !el.contains(t) || t.disabled) return;
      if (t.dataset.tab) { tab = t.dataset.tab; render(); return; }
      const f = form();
      const ci = Number(t.dataset.ci), ii = Number(t.dataset.ii);
      const cats = f.categories;
      switch (t.dataset.act) {
        case 'addcat': {
          const role = t.dataset.roleV;
          const left = 100 - cats.filter((c) => c.role === 'scored').reduce((s, c) => s + Math.round((c.weight || 0) * 100), 0);
          cats.push({ id: uid(), name: role === 'scored' ? '新分類' : (role === 'bonus' ? '加分項目' : '加重扣分項目'), role,
            weight: role === 'scored' ? Math.max(0, left) / 100 : undefined,
            items: [{ n: 1, type: TYPE_BY_ROLE[role][0][0], text: '', points: role === 'penalty' ? 10 : 2, max: 2 }] });
          touch(); render(); break;
        }
        case 'catdel':
          if (!(await ctx.ui.confirm(`刪除「${cats[ci].name}」和底下 ${cats[ci].items.length} 題？`))) return;
          cats.splice(ci, 1); touch(); render(); break;
        case 'catup': swap(cats, ci, ci - 1); touch(); render(); break;
        case 'catdown': swap(cats, ci, ci + 1); touch(); render(); break;
        case 'additem': {
          const c = cats[ci];
          c.items.push({ n: c.items.length + 1, type: TYPE_BY_ROLE[c.role][0][0], text: '', points: c.role === 'penalty' ? 10 : 2, max: 2 });
          touch(); render();
          const ta = el.querySelectorAll(`textarea[data-ci="${ci}"]`);
          if (ta.length) ta[ta.length - 1].focus();
          break;
        }
        case 'itemdel': cats[ci].items.splice(ii, 1); touch(); render(); break;
        case 'itemup': swap(cats[ci].items, ii, ii - 1); touch(); render(); break;
        case 'itemdown': swap(cats[ci].items, ii, ii + 1); touch(); render(); break;
        case 'reload':
          if (dirty && !(await ctx.ui.confirm('放棄所有還沒存的改動？'))) return;
          load(); break;
        case 'save': save(); break;
        default: break;
      }
    };
    el.oninput = (e) => {
      const t = e.target;
      const act = t.dataset && t.dataset.act;
      if (!act) return;
      const c = form().categories[Number(t.dataset.ci)];
      if (!c) return;
      const it = c.items[Number(t.dataset.ii)];
      if (act === 'catname') c.name = t.value;
      else if (act === 'weight') c.weight = Number(t.value) / 100;
      else if (act === 'text' && it) it.text = t.value;
      else if (act === 'points' && it) it.points = Number(t.value);
      else if (act === 'max' && it) it.max = Number(t.value);
      else return;
      touch();
    };
    el.onchange = (e) => {
      const t = e.target;
      if (!t.dataset || t.dataset.act !== 'type') return;
      const it = form().categories[Number(t.dataset.ci)].items[Number(t.dataset.ii)];
      it.type = t.value; touch(); render();
    };
  }

  /** 送出前前端先檢查一次（後端還會再檢查） */
  function check() {
    for (const f of forms) {
      const sc = f.categories.filter((c) => c.role === 'scored');
      for (const c of f.categories) {
        if (!String(c.name || '').trim()) return `「${f.name}」有分類沒有名稱`;
        for (const it of c.items) if (!String(it.text || '').trim()) return `「${f.name}・${c.name}」有題目沒有內容`;
      }
      for (const c of sc) {
        const w = Math.round((c.weight || 0) * 100);
        if (!(w >= 1 && w <= 100)) return `「${f.name}・${c.name}」的權重要在 1%～100%（目前 ${w}%）`;
      }
      if (sc.length) {
        const sum = sc.reduce((s, c) => s + Math.round((c.weight || 0) * 100), 0);
        if (sum !== 100) return `「${f.name}」評分分類的權重加起來是 ${sum}%，要剛好 100%`;
      }
      // 2026-10-30：每張表可拿的加分合計不能明顯超過上限（後端 inspCleanForms_ 同一條：> BONUS_CAP×2 擋下）
      const possible = bonusPossible(f);
      if (possible > BONUS_CAP * 2) return `「${f.name}」加分題合計可拿 ${possible} 分，超過上限 ${BONUS_CAP} 太多（最多 ${BONUS_CAP * 2}），請調低分數或減少題目`;
    }
    return '';
  }

  async function save() {
    const msg = check();
    if (msg) { ctx.ui.toast(msg, 'error'); return; }
    forms.forEach((f) => f.categories.forEach((c) => c.items.forEach((it, i) => { it.n = i + 1; })));
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('inspection', 'inspBankSave', { brand, forms, expected_ver: ver }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (r && r.ok && r.dryrun) { ctx.ui.toast('試跑模式：題目沒有真的存檔', 'info'); return; }
    if (r && r.ok) { ctx.ui.toast('題目已存檔', 'success'); ver = r.data.ver; dirty = false; render(); return; }
    ctx.ui.toast(errText(r), 'error');
  }

  return () => { alive = false; el.onclick = null; el.oninput = null; el.onchange = null; };
}

