/**
 * modules/staff/views/regions.js — 同仁名單 → 區域（督導負責區，docs/regions/spec.md 第 7、8 節）
 *
 * 上方「切換檢查」（regionCheck）＋目前「依區域審核：關／開」；只有 role admin 看得到開始／停止按鈕。
 * 下方依品牌一塊，每區一張卡：區名、督導（只列該品牌在職區督導）、門市勾選（已在別區的不能勾）、停用。
 * 存檔先 preview（哪些督導多看到／少看到哪幾家店）→ 確認才寫；帶 expected_ver，衝突請使用者重新整理。
 * 畫面資料的轉換都在 regions-model.js（node 測試）。
 */
'use strict';

import { buildBlocks, storeOptions, supervisorOptions, diffLines, isConflict, CONFLICT_TEXT, checkItems, SWITCH_ON_TEXT, SWITCH_OFF_TEXT } from './regions-model.js';
import { clearRegionAlerts } from './regions-alerts.js';

const CANCEL = { label: '取消', value: null, variant: 'secondary' };

export function mountRegions(el, ctx) {
  const esc = ctx.fmt.esc;
  const isAdmin = !!(ctx.user && ctx.user.role === 'admin');
  let alive = true;
  let list = null;
  let org = { brands: [], units: [] };
  let chk = null;
  let seq = 0;
  let dlg = null;

  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';

  async function load() {
    const [r, o, c] = await Promise.all([
      ctx.api.call('staff', 'regionList', {}),
      ctx.api.call('staff', 'orgOptions', {}),
      ctx.api.call('staff', 'regionCheck', {}).catch(() => null)
    ]);
    if (!alive) return;
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc((r && r.error) || '讀不到區域設定')}</p></div>`; return; }
    list = r.data || {};
    if (o && o.ok) org = o.data;
    chk = c && c.ok ? c.data : null;
    draw();
  }

  function checkHtml() {
    const on = chk ? chk.on === true : list.on === true;
    const state = `<span class="tag ${on ? 'tag-ok' : ''}" data-role="switch-state">依區域審核：${on ? '開' : '關'}</span>`;
    let body;
    if (!chk) {
      body = '<p class="text-muted">切換檢查暫時讀不到，請稍後重新整理。</p>';
    } else {
      const c = checkItems(chk, org.brands);
      body = c.items.map((it) => `<div class="stack" data-role="check-item" data-key="${it.key}">
          <div><b>${esc(it.title)}</b>　${it.bad ? `<span class="tag tag-warn">${it.lines.length} 筆</span>` : '<span class="tag tag-ok">沒有</span>'}</div>
          ${it.lines.map((l) => `<div class="text-muted">${esc(l)}</div>`).join('')}
        </div>`).join('') +
        (c.note ? `<p class="text-muted" data-role="att-note">${esc(c.note)}</p>` : '');
      if (isAdmin) {
        const btn = on
          ? '<button type="button" class="btn btn-danger" data-act="switch-off">停止依區域審核</button>'
          : '<button type="button" class="btn btn-primary" data-act="switch-on">開始依區域審核</button>';
        const warn = c.warn ? '<span class="tag tag-danger" data-role="switch-warn">還有門市沒劃區或區域沒有督導，打開後這些店的督導審不到</span>' : '';
        body += `<div class="btn-row">${btn}${warn}</div>`;
      }
    }
    return `<div class="card stack" data-role="region-check">
      <div class="card-row row-wrap"><div class="card-title">切換檢查</div>${state}</div>
      <p class="text-muted">開關打開前先看這裡：門市都劃好區、每區都有督導，督導才不會漏審。</p>
      ${body}</div>`;
  }

  function cardHtml(region) {
    const k = ++seq;
    const isNew = !region.code;
    const sup = supervisorOptions(list.candidates, region.brand, region.supervisor);
    const opts = storeOptions(org, region, list.regions);
    const tags = [];
    if (!isNew && !region.active) tags.push('<span class="tag">已停用</span>');
    if (!isNew && region.active && region.no_supervisor) tags.push(`<span class="tag tag-warn" data-role="tag-no-sup">${region.no_supervisor === 'invalid' ? '督導已離職或調職' : '沒有督導'}</span>`);
    if (!isNew && region.active && (region.store_inactive || []).length) tags.push('<span class="tag tag-warn" data-role="tag-store-inactive">有停用的門市</span>');
    if (!isNew && region.active && (region.store_dup || []).length) tags.push('<span class="tag tag-warn" data-role="tag-store-dup">有重複劃入的門市</span>');
    const supSel = `<select class="input" id="rg-sup-${k}" data-f="supervisor">
        <option value="">（暫時沒有督導）</option>
        ${sup.list.map((c) => `<option value="${esc(c.emp_no)}"${c.emp_no === region.supervisor ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>${sup.stale ? '<div class="field-hint">原本的督導已離職或調職，請重選</div>' : ''}${sup.list.length ? '' : '<div class="field-hint">這個品牌目前沒有在職的區督導</div>'}`;
    const boxes = opts.length ? opts.map((o, i) => `<div class="checkbox-row"><input type="checkbox" id="rg-st-${k}-${i}" data-f="store" value="${esc(o.unit)}"${o.checked ? ' checked' : ''}${o.disabled ? ' disabled' : ''}>
        <label for="rg-st-${k}-${i}">${esc(o.unit_name)}${o.taken_by ? `　<span class="text-muted">已在 ${esc(o.taken_by)}</span>` : ''}</label></div>`).join('')
      : '<p class="text-muted">這個品牌沒有可以劃區的門市</p>';
    return `<div class="card stack" data-role="region-card" data-code="${esc(region.code || '')}" data-brand="${esc(region.brand)}">
      <div class="card-row row-wrap"><div class="card-title">${esc(isNew ? '新區域' : region.name)}</div><span>${tags.join(' ')}</span></div>
      <div class="form-grid-2">
        <div class="field"><label class="field-label" for="rg-name-${k}">區域名稱（最多 12 字）</label><input class="input" id="rg-name-${k}" data-f="name" maxlength="12" value="${esc(region.name || '')}"></div>
        <div class="field"><label class="field-label" for="rg-sup-${k}">督導</label>${supSel}</div>
      </div>
      <div class="field"><span class="field-label">包含的門市</span>${boxes}</div>
      ${isNew ? '' : `<div class="checkbox-row"><input type="checkbox" id="rg-off-${k}" data-f="inactive"${region.active ? '' : ' checked'}><label for="rg-off-${k}">停用這個區域</label></div>`}
      <div class="btn-row"><button type="button" class="btn btn-primary" data-act="save">存檔</button>${isNew ? '<button type="button" class="btn btn-secondary" data-act="discard">取消</button>' : ''}</div>
    </div>`;
  }

  function draw() {
    const blocks = buildBlocks(list, org);
    el.innerHTML = `<div class="stack">${checkHtml()}
      ${blocks.map((b) => `<div class="section stack" data-role="region-brand" data-brand="${esc(b.brand)}">
        <div class="card-row row-wrap"><div class="section-title">${esc(b.brand_name)}</div>
          <button type="button" class="btn btn-secondary" data-act="add" data-brand="${esc(b.brand)}">新增區域</button></div>
        <div class="stack" data-role="region-cards">${b.regions.length ? b.regions.map(cardHtml).join('') : '<p class="text-muted" data-role="no-region">還沒有區域</p>'}</div>
        <p class="text-muted" data-role="unassigned">尚未劃區的門市：${b.unassigned.length ? esc(b.unassigned.map((s) => s.unit_name).join('、')) : '沒有'}</p>
      </div>`).join('')}
      ${blocks.length ? '' : '<div class="card"><p class="text-muted">目前沒有可以劃區的品牌門市</p></div>'}
    </div>`;
  }

  function readCard(card) {
    const q = (s) => card.querySelector(s);
    const off = q('[data-f="inactive"]');
    return {
      code: card.dataset.code || undefined,
      brand: card.dataset.brand,
      name: q('[data-f="name"]').value.trim(),
      supervisor: q('[data-f="supervisor"]').value,
      stores: [...card.querySelectorAll('[data-f="store"]')].filter((x) => x.checked && !x.disabled).map((x) => x.value),
      active: !(off && off.checked)
    };
  }

  function domOf(lines, lead) {
    const d = document.createElement('div');
    d.className = 'stack';
    d.innerHTML = (lead ? `<p class="text-muted">${esc(lead)}</p>` : '') + lines.map((l) => `<div data-role="preview-line">${esc(l)}</div>`).join('');
    return d;
  }

  async function call(action, payload) {
    ctx.ui.loading(true);
    try { return await ctx.api.call('staff', action, payload); } finally { ctx.ui.loading(false); }
  }

  async function conflict() {
    dlg = ctx.ui.dialog({ title: '無法存檔', body: CONFLICT_TEXT, actions: [{ label: '重新整理', value: 'reload', variant: 'primary' }] });
    await dlg;
    dlg = null;
    if (alive) load();
  }

  async function save(card) {
    const region = readCard(card);
    if (!region.name) { ctx.ui.toast('請填區域名稱', 'danger'); return; }
    const pv = await call('regionSave', { region, expected_ver: list.ver, preview: true });
    if (!alive) return;
    if (!pv || !pv.ok) { if (isConflict(pv)) conflict(); else ctx.ui.toast((pv && pv.error) || '存檔失敗', 'danger'); return; }
    dlg = ctx.ui.dialog({
      title: '存檔前確認',
      body: domOf(diffLines(pv.data && pv.data.diff), '這次存檔後，督導看得到的門市會這樣變：'),
      actions: [CANCEL, { label: '確定存檔', value: 'go', variant: 'primary' }]
    });
    const go = await dlg;
    dlg = null;
    if (go !== 'go' || !alive) return;
    const r = await call('regionSave', { region, expected_ver: list.ver });
    if (!alive) return;
    if (!r || !r.ok) { if (isConflict(r)) conflict(); else ctx.ui.toast((r && r.error) || '存檔失敗', 'danger'); return; }
    if (r.dryrun) return;   // 試跑模式：平台已經提示沒有送出
    ctx.ui.toast('區域已存檔', 'ok');
    clearRegionAlerts();
    load();
  }

  async function doSwitch(on) {
    dlg = ctx.ui.dialog({
      title: on ? '開始依區域審核' : '停止依區域審核',
      body: on ? SWITCH_ON_TEXT : SWITCH_OFF_TEXT,
      actions: [CANCEL, { label: on ? '確定開始' : '確定停止', value: 'go', variant: 'danger' }]
    });
    const go = await dlg;
    dlg = null;
    if (go !== 'go' || !alive) return;
    const r = await call('regionSwitch', { on });
    if (!alive) return;
    if (!r || !r.ok) { ctx.ui.toast((r && r.error) || '切換失敗', 'danger'); return; }
    if (r.dryrun) return;
    ctx.ui.toast(on ? '已開始依區域審核' : '已停止依區域審核', 'ok');
    clearRegionAlerts();
    load();
  }

  function onClick(e) {
    const b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b || !el.contains(b) || !list) return;
    const act = b.dataset.act;
    if (act === 'add') {
      const box = el.querySelector(`[data-role="region-brand"][data-brand="${b.dataset.brand}"] [data-role="region-cards"]`);
      const empty = box.querySelector('[data-role="no-region"]');
      if (empty) empty.remove();
      box.insertAdjacentHTML('beforeend', cardHtml({ code: '', name: '', brand: b.dataset.brand, stores: [], supervisor: '', active: true }));
      const inp = box.lastElementChild.querySelector('[data-f="name"]');
      if (inp) inp.focus();
    } else if (act === 'discard') {
      b.closest('[data-role="region-card"]').remove();
    } else if (act === 'save') {
      save(b.closest('[data-role="region-card"]'));
    } else if (act === 'switch-on' || act === 'switch-off') {
      doSwitch(act === 'switch-on');
    }
  }

  el.addEventListener('click', onClick);
  load();
  return () => {
    alive = false;
    el.removeEventListener('click', onClick);
    if (dlg && typeof dlg.close === 'function') dlg.close(null);
  };
}
