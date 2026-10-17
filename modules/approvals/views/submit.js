/**
 * 送單（spec §4、§7、§14）：選表單 → 填 → 拍照 → 預覽路線 → 送出。
 * - 請購：品項明細（金額由 apvCalcAmount 算，伺服器會重算並忽略前端金額）、廠商、用途、需求日、照片選填。
 * - 請款：支出日、類別、金額、說明、付款對象、（選填）對應請購單、收據照片 1～5 張。
 * - 人事異動：離職／調職／調薪；離職要本人簽名（本人送＝簽名板；主管替送＝對象線上簽或附紙本簽名照）。
 * - 草稿：請購／請款存 localStorage dzy.u.<id>.apv_draft_<type>；人事單不存（含薪資，spec §14.7）。照片檔號不存進草稿（未綁定 24 小時會被清）。
 * - 送出帶 client_id；失敗重試沿用同一個 client_id（後端同 sender＋client_id 回原單），成功後才換新的。
 * - 改完再送：?resubmit=<單號> → apvGet 帶入內容 → apvResubmit {id, rev, body, files}。
 */
'use strict';

import {
  TYPES, TYPE_LABEL, CATEGORY, KIND_LABEL, ROLE_LABEL, DEPT_LABEL, calcPurchase, checkExpenseAmount, toNum, money,
  loadDraft, saveDraft, clearDraft, newClientId, errText, isConflict, DRAFT_TYPES
} from '../lib.js';
import { createPhotoPicker, domOf } from '../widgets.js';
import { uploadSignature } from '../photo.js';

function store() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }

export function mountSubmit(el, ctx) {
  const esc = ctx.fmt.esc;
  const userId = ctx.user && ctx.user.id;
  let alive = true;
  let type = 'purchase';
  let resub = null;       // {id, rev, step, files:[...]} 改完再送
  let clientId = newClientId();
  let picker = null;      // 照片挑選器
  let pad = null;         // 離職簽名板
  let saveTimer = null;
  let sending = false;
  let dirty = false;      // 有還沒寫進草稿的修改

  const today = () => ctx.fmt.date(new Date());

  // ── 表單 HTML ───────────────────────────────────────
  function itemRow(it, i) {
    return `<div class="card stack" data-role="item-row" data-i="${i}">
      <div class="field"><label class="field-label" for="it-name-${i}">品名</label><input class="input" id="it-name-${i}" data-f="name" maxlength="60" value="${esc(it.name || '')}"></div>
      <div class="form-grid-2">
        <div class="field"><label class="field-label" for="it-qty-${i}">數量</label><input class="input" id="it-qty-${i}" data-f="qty" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(it.qty === undefined ? '' : it.qty)}"></div>
        <div class="field"><label class="field-label" for="it-unit-${i}">單位</label><input class="input" id="it-unit-${i}" data-f="unit" maxlength="8" value="${esc(it.unit || '')}"></div>
        <div class="field"><label class="field-label" for="it-price-${i}">單價（元）</label><input class="input" id="it-price-${i}" data-f="price" type="number" inputmode="numeric" step="1" min="0" value="${esc(it.price === undefined ? '' : it.price)}"></div>
        <div class="field"><div class="field-label">小計</div><div data-role="subtotal">—</div></div>
      </div>
      <div class="btn-row"><button type="button" class="btn btn-secondary" data-act="del-item" data-i="${i}">刪除這列</button></div>
    </div>`;
  }
  function purchaseHtml(v) {
    const items = Array.isArray(v.items) && v.items.length ? v.items : [{}];
    return `
      <div data-role="items">${items.map(itemRow).join('')}</div>
      <div class="btn-row"><button type="button" class="btn btn-secondary" data-act="add-item">新增品項</button><span class="field-hint">最多 30 列</span></div>
      <div class="card"><div class="card-row"><div class="card-title">合計</div><div data-role="total">NT$ 0</div></div></div>
      <div class="field"><label class="field-label" for="f-vendor">廠商（選填）</label><input class="input" id="f-vendor" data-field="vendor" maxlength="60" value="${esc(v.vendor || '')}"></div>
      <div class="field"><label class="field-label" for="f-purpose">用途（必填）</label><textarea class="input" id="f-purpose" data-field="purpose" rows="2" maxlength="200">${esc(v.purpose || '')}</textarea></div>
      <div class="field"><label class="field-label" for="f-need">需求日（必填）</label><input class="input" id="f-need" data-field="need_date" type="date" value="${esc(v.need_date || '')}"></div>
      <div class="field"><div class="field-label">照片（選填，最多 5 張）</div><div data-role="photo-slot"></div></div>`;
  }
  function expenseHtml(v) {
    const cat = Object.keys(CATEGORY).map((k) => `<option value="${k}"${v.category === k ? ' selected' : ''}>${esc(CATEGORY[k])}</option>`).join('');
    const vendor = v.payee === 'vendor';
    return `
      <div class="form-grid-2">
        <div class="field"><label class="field-label" for="f-date">支出日（必填）</label><input class="input" id="f-date" data-field="spend_date" type="date" value="${esc(v.spend_date || today())}"></div>
        <div class="field"><label class="field-label" for="f-cat">類別（必填）</label><select class="input" id="f-cat" data-field="category">${cat}</select></div>
        <div class="field"><label class="field-label" for="f-amount">金額（元，必填）</label><input class="input" id="f-amount" data-field="amount" type="number" inputmode="numeric" step="1" min="1" value="${esc(v.amount === undefined ? '' : v.amount)}"></div>
      </div>
      <div class="field"><label class="field-label" for="f-desc">說明（必填）</label><textarea class="input" id="f-desc" data-field="desc" rows="2" maxlength="200">${esc(v.desc || '')}</textarea></div>
      <div class="field"><div class="field-label">付款對象</div>
        <div class="checkbox-row"><input type="radio" name="payee" id="f-payee-self" value="self" data-field="payee"${vendor ? '' : ' checked'}><label for="f-payee-self">我先代墊，請還給我</label></div>
        <div class="checkbox-row"><input type="radio" name="payee" id="f-payee-vendor" value="vendor" data-field="payee"${vendor ? ' checked' : ''}><label for="f-payee-vendor">直接付給廠商</label></div></div>
      <div class="field" data-role="vendor-name"${vendor ? '' : ' hidden'}><label class="field-label" for="f-vname">廠商名稱</label><input class="input" id="f-vname" data-field="vendor_name" maxlength="60" value="${esc(v.vendor_name || '')}"></div>
      <div class="field"><label class="field-label" for="f-pid">對應請購單號（選填）</label><input class="input" id="f-pid" data-field="purchase_id" maxlength="20" placeholder="APV-261018-001" value="${esc(v.purchase_id || '')}"></div>
      <div class="field"><div class="field-label">收據照片（必填，1～5 張）</div><div data-role="photo-slot"></div></div>`;
  }
  function personnelHtml(v) {
    const kind = v.kind || 'leave';
    const mode = v.mode || 'self';          // leave：self 本人送｜other 主管替送
    const signMode = v.signMode || 'online'; // other：online 對象線上簽｜paper 附紙本
    const sel = (k) => `<option value="${k}"${kind === k ? ' selected' : ''}>${esc(KIND_LABEL[k])}</option>`;
    const needSubject = !(kind === 'leave' && mode === 'self');
    const from = v.from || {};
    const to = v.to || {};
    return `
      <div class="field"><label class="field-label" for="f-kind">種類</label><select class="input" id="f-kind" data-field="kind" data-rerender="1">${sel('leave')}${sel('transfer')}${sel('raise')}</select></div>
      ${kind === 'leave' ? `<div class="field"><div class="field-label">誰要離職</div>
        <div class="checkbox-row"><input type="radio" name="mode" id="f-mode-self" value="self" data-field="mode" data-rerender="1"${mode === 'self' ? ' checked' : ''}><label for="f-mode-self">我自己</label></div>
        <div class="checkbox-row"><input type="radio" name="mode" id="f-mode-other" value="other" data-field="mode" data-rerender="1"${mode === 'other' ? ' checked' : ''}><label for="f-mode-other">替同仁送（主管／人資）</label></div></div>` : ''}
      ${needSubject ? `<div class="field"><label class="field-label" for="f-subject">對象同仁編號（DZY）</label><input class="input" id="f-subject" data-field="subject" maxlength="12" placeholder="DZY9xx" value="${esc(v.subject || '')}"></div>` : ''}
      <div class="field"><label class="field-label" for="f-eff">生效日（必填）</label><input class="input" id="f-eff" data-field="effective" type="date" value="${esc(v.effective || '')}"></div>
      <div class="card stack"><div class="card-title">原本</div><div class="form-grid-2">
        <div class="field"><label class="field-label" for="f-fu">單位</label><input class="input" id="f-fu" data-field="from_unit" maxlength="30" value="${esc(from.unit || '')}"></div>
        <div class="field"><label class="field-label" for="f-ft">職稱</label><input class="input" id="f-ft" data-field="from_title" maxlength="30" value="${esc(from.title || '')}"></div>
        ${kind === 'raise' ? `<div class="field"><label class="field-label" for="f-fp">薪資（元）</label><input class="input" id="f-fp" data-field="from_pay" type="number" inputmode="numeric" min="0" value="${esc(from.pay === undefined ? '' : from.pay)}"></div>` : ''}
      </div></div>
      ${kind === 'leave' ? '' : `<div class="card stack"><div class="card-title">改成</div><div class="form-grid-2">
        ${kind === 'transfer' ? `<div class="field"><label class="field-label" for="f-tu">新單位（必填）</label><input class="input" id="f-tu" data-field="to_unit" maxlength="30" value="${esc(to.unit || '')}"></div>
        <div class="field"><label class="field-label" for="f-tt">新職稱</label><input class="input" id="f-tt" data-field="to_title" maxlength="30" value="${esc(to.title || '')}"></div>` : `<div class="field"><label class="field-label" for="f-tp">新薪資（元，必填）</label><input class="input" id="f-tp" data-field="to_pay" type="number" inputmode="numeric" min="1" value="${esc(to.pay === undefined ? '' : to.pay)}"></div>`}
      </div></div>`}
      <div class="field"><label class="field-label" for="f-reason">原因（必填）</label><textarea class="input" id="f-reason" data-field="reason" rows="2" maxlength="300">${esc(v.reason || '')}</textarea></div>
      ${kind === 'leave' && mode === 'self' ? `<div class="field"><div class="field-label">本人簽名（必填）</div>
        <canvas data-role="sign-pad" style="width:100%;height:160px;border:1px solid var(--line);border-radius:var(--radius);background:var(--card);touch-action:none"></canvas>
        <div class="btn-row"><button type="button" class="btn btn-secondary" data-act="clear-sign">清除重簽</button></div></div>` : ''}
      ${kind === 'leave' && mode === 'other' ? `<div class="field"><div class="field-label">本人簽名怎麼取得</div>
        <div class="checkbox-row"><input type="radio" name="signmode" id="f-sm-online" value="online" data-field="signMode" data-rerender="1"${signMode === 'online' ? ' checked' : ''}><label for="f-sm-online">對象已有帳號，送出後由他本人在線上簽名</label></div>
        <div class="checkbox-row"><input type="radio" name="signmode" id="f-sm-paper" value="paper" data-field="signMode" data-rerender="1"${signMode === 'paper' ? ' checked' : ''}><label for="f-sm-paper">對象沒有帳號，附紙本簽名照（1～2 張）</label></div></div>` : ''}
      ${kind === 'leave' && mode === 'other' && signMode === 'paper' ? '<div class="field"><div class="field-label">紙本簽名照片</div><div data-role="photo-slot"></div></div>' : ''}`;
  }

  // ── 收集／帶入 ──────────────────────────────────────
  const formEl = () => el.querySelector('[data-role="form"]');
  function fieldVal(root, name) {
    const nodes = root.querySelectorAll(`[data-field="${name}"]`);
    if (!nodes.length) return undefined;
    if (nodes[0].type === 'radio') { const c = Array.from(nodes).find((n) => n.checked); return c ? c.value : ''; }
    return nodes[0].value;
  }
  function collect() {
    const root = formEl();
    if (!root) return {};
    const g = (n) => fieldVal(root, n);
    if (type === 'purchase') {
      const items = Array.from(root.querySelectorAll('[data-role="item-row"]')).map((r) => ({
        name: r.querySelector('[data-f="name"]').value.trim(), qty: r.querySelector('[data-f="qty"]').value,
        unit: r.querySelector('[data-f="unit"]').value.trim(), price: r.querySelector('[data-f="price"]').value
      }));
      return { items, vendor: g('vendor'), purpose: g('purpose'), need_date: g('need_date') };
    }
    if (type === 'expense') {
      return { spend_date: g('spend_date'), category: g('category'), amount: g('amount'), desc: g('desc'), payee: g('payee'), vendor_name: g('vendor_name'), purchase_id: g('purchase_id') };
    }
    return {
      kind: g('kind'), mode: g('mode'), signMode: g('signMode'), subject: g('subject'), effective: g('effective'), reason: g('reason'),
      from: { unit: g('from_unit'), title: g('from_title'), pay: g('from_pay') },
      to: { unit: g('to_unit'), title: g('to_title'), pay: g('to_pay') }
    };
  }

  function updateTotals() {
    const root = formEl();
    if (!root || type !== 'purchase') return;
    const vals = collect().items;
    const rowsEls = root.querySelectorAll('[data-role="item-row"]');
    const filled = vals.map((it) => ({ qty: it.qty, price: it.price }));
    const calc = calcPurchase(filled);
    rowsEls.forEach((r, i) => {
      const s = calc.subtotals && calc.subtotals[i];
      r.querySelector('[data-role="subtotal"]').textContent = calc.ok && typeof s === 'number' ? money(s) : '—';
    });
    const tot = root.querySelector('[data-role="total"]');
    if (tot) tot.textContent = calc.ok ? `NT$ ${money(calc.amount)}` : 'NT$ —（數量、單價要填正確）';
  }

  function scheduleSave() {
    if (DRAFT_TYPES.indexOf(type) === -1 || resub) return;
    clearTimeout(saveTimer);
    dirty = true;
    saveTimer = setTimeout(() => { dirty = false; saveDraft(store(), userId, type, collect()); }, 400);
  }

  // ── 畫面 ────────────────────────────────────────────
  function teardownWidgets() {
    if (picker) { picker.destroy(); picker = null; }
    if (pad && typeof pad.destroy === 'function') pad.destroy();
    pad = null;
  }
  function renderForm(v, keepPhotos) {
    const keep = keepPhotos && picker ? picker.ids().map((id) => ({ id })) : (v.__files || []);
    teardownWidgets();
    const root = formEl();
    root.innerHTML = type === 'purchase' ? purchaseHtml(v) : type === 'expense' ? expenseHtml(v) : personnelHtml(v);
    const slot = root.querySelector('[data-role="photo-slot"]');
    if (slot) {
      picker = createPhotoPicker(ctx, { initial: keep, label: type === 'expense' ? '拍收據／選照片' : '拍照／選照片' });
      slot.appendChild(picker.el);
    }
    const cv = root.querySelector('[data-role="sign-pad"]');
    if (cv) pad = ctx.ui.signaturePad(cv);
    updateTotals();
  }
  function draw() {
    const locked = !!resub;
    el.innerHTML = `
      <div class="card stack"><div class="card-title">${resub ? `改完再送　${esc(resub.id)}` : '送單'}</div>
        ${locked ? '<p class="text-muted">這張單被退回了，改好內容後再送出，會從第一關重新簽。</p>' : `<div class="btn-row" data-role="type-tabs">${TYPES.map((t) => `<button type="button" class="btn ${t.id === type ? 'btn-primary' : 'btn-secondary'}" data-type="${t.id}" aria-pressed="${t.id === type}">${esc(t.name)}</button>`).join('')}</div>`}
        <p class="field-hint" data-role="draft-note"></p></div>
      <div class="card stack" data-role="form"></div>
      <div class="card stack"><div class="btn-row">
        <button type="button" class="btn btn-secondary" data-act="preview">預覽簽核路線</button>
        <button type="button" class="btn btn-primary" data-act="send">${resub ? '再送出' : '送出'}</button>
        ${!locked && DRAFT_TYPES.indexOf(type) !== -1 ? '<button type="button" class="btn btn-secondary" data-act="clear-draft">清除草稿</button>' : ''}</div>
        <p class="field-hint" data-role="send-msg"></p></div>`;
  }
  function showType(newType) {
    type = newType;
    clientId = newClientId();
    draw();
    let v = {};
    if (!resub && DRAFT_TYPES.indexOf(type) !== -1) {
      const d = loadDraft(store(), userId, type);
      if (d) { v = d; el.querySelector('[data-role="draft-note"]').textContent = '已帶入上次沒送出的草稿（照片要重新附）。'; }
    }
    if (type === 'personnel') el.querySelector('[data-role="draft-note"]').textContent = '人事異動含個資，不存草稿，離開畫面會清空。';
    renderForm(v, false);
  }

  // ── 驗證與組 payload ────────────────────────────────
  function build() {
    const v = collect();
    const files = picker ? picker.ids() : [];
    const warn = (m) => ({ error: m });
    if (picker && picker.busy()) return warn('照片還在上傳，請稍等');
    if (type === 'purchase') {
      const items = v.items.filter((it) => it.name || it.qty !== '' || it.price !== '' || it.unit);
      if (!items.length) return warn('請至少填一個品項');
      if (items.length > 30) return warn('品項最多 30 列');
      for (let i = 0; i < items.length; i++) {
        if (!items[i].name) return warn(`第 ${i + 1} 個品項沒填品名`);
        if (!items[i].unit) return warn(`第 ${i + 1} 個品項沒填單位`);
      }
      const calc = calcPurchase(items);
      if (!calc.ok) return warn('數量或單價不對（數量最多兩位小數，單價要是整數元，都要大於 0）');
      if (!v.purpose.trim()) return warn('請填用途');
      if (!v.need_date) return warn('請選需求日');
      return { amount: calc.amount, payload: {
        body: { items: items.map((it) => ({ name: it.name, qty: toNum(it.qty), unit: it.unit, price: toNum(it.price) })), ...(v.vendor.trim() ? { vendor: v.vendor.trim() } : {}), purpose: v.purpose.trim(), need_date: v.need_date },
        files }, previewExtra: { amount: calc.amount } };
    }
    if (type === 'expense') {
      if (!v.spend_date) return warn('請選支出日');
      if (!checkExpenseAmount(v.amount)) return warn('金額要是 1 以上的整數元');
      if (!v.desc.trim()) return warn('請填說明');
      if (v.payee === 'vendor' && !v.vendor_name.trim()) return warn('請填廠商名稱');
      if (!files.length) return warn('請款至少要附一張收據照片');
      const b = { spend_date: v.spend_date, category: v.category, amount: toNum(v.amount), desc: v.desc.trim(), payee: v.payee || 'self' };
      if (b.payee === 'vendor') b.vendor_name = v.vendor_name.trim();
      if (v.purchase_id.trim()) b.purchase_id = v.purchase_id.trim();
      return { amount: b.amount, payload: { body: b, files }, previewExtra: { amount: b.amount } };
    }
    // personnel
    const kind = v.kind || 'leave';
    const self = kind === 'leave' && (v.mode || 'self') === 'self';
    const subject = (v.subject || '').trim().toUpperCase();
    if (!self && !/^DZY\d{3,}$/.test(subject)) return warn('請填對象同仁的 DZY 編號');
    if (!v.effective) return warn('請選生效日');
    if (!v.reason.trim()) return warn('請填原因');
    const b = { kind, effective: v.effective, from: {}, to: {}, reason: v.reason.trim() };
    if (v.from.unit.trim()) b.from.unit = v.from.unit.trim();
    if (v.from.title.trim()) b.from.title = v.from.title.trim();
    if (kind === 'transfer') {
      if (!v.to.unit.trim()) return warn('請填新單位');
      b.to.unit = v.to.unit.trim();
      if (v.to.title.trim()) b.to.title = v.to.title.trim();
    }
    if (kind === 'raise') {
      if (!(toNum(v.to.pay) >= 1)) return warn('請填新薪資（數字）');
      b.to.pay = toNum(v.to.pay);
      if (v.from.pay !== '' && v.from.pay !== undefined) { if (!(toNum(v.from.pay) >= 0)) return warn('原薪資要是數字'); b.from.pay = toNum(v.from.pay); }
    }
    let needSign = false;
    if (kind === 'leave') {
      if (self) { if (!pad || pad.isEmpty()) return warn('請先簽名'); needSign = true; }
      else if ((v.signMode || 'online') === 'paper') {
        if (!files.length || files.length > 2) return warn('請附 1～2 張紙本簽名照');
        b.paper_files = files;
      }
    }
    return { amount: undefined, needSign, payload: { body: b, files: kind === 'leave' && !self && (v.signMode || 'online') === 'paper' ? files : [], ...(self ? {} : { subject }) },
      previewExtra: { kind, ...(self ? {} : { subject }) } };
  }

  function routeText(data) {
    const steps = (data && data.steps) || [];
    const lines = steps.map((s, i) => {
      const names = (s.candidates || []).map((c) => c.name).filter(Boolean).join('、');
      const label = (s.override && s.override.to) ? `指派 ${s.override.to}` : (ROLE_LABEL[s.role] || s.role);
      return `<li>第 ${i + 1} 關：${esc(label)}${names ? `（${esc(names)}）` : s.status === 'skipped' ? '（目前沒人可簽，會自動往上）' : ''}</li>`;
    });
    const h = DEPT_LABEL[data && data.handler] || (data && data.handler) || '';
    return `<ol>${lines.join('')}</ol>${h ? `<p>簽完交 ${esc(h)} 承辦。</p>` : ''}`;
  }
  async function previewRoute(extra) {
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('approvals', 'apvRoutePreview', { type, ...extra }); } finally { ctx.ui.loading(false); }
    return r;
  }

  async function onPreview() {
    const b = build();
    if (b.error) { ctx.ui.toast(b.error, 'warn'); return; }
    const r = await previewRoute(b.previewExtra);
    if (!alive) return;
    if (!r || !r.ok) { ctx.ui.toast(errText(r), 'danger'); return; }
    await ctx.ui.dialog({ title: '簽核路線', body: domOf(routeText(r.data)), actions: [{ label: '知道了', value: null, variant: 'primary' }] });
  }

  async function onSend() {
    if (sending) return;
    const msg = el.querySelector('[data-role="send-msg"]');
    msg.textContent = '';
    const b = build();
    if (b.error) { msg.textContent = b.error; ctx.ui.toast(b.error, 'warn'); return; }
    sending = true;
    try {
      const pv = await previewRoute(b.previewExtra);
      if (!alive) return;
      if (!pv || !pv.ok) { msg.textContent = errText(pv); ctx.ui.toast(errText(pv), 'danger'); return; }
      const amountLine = b.amount !== undefined ? `<p>金額 NT$ ${esc(money(b.amount))}</p>` : '';
      const go = await ctx.ui.dialog({ title: `確認送出${TYPE_LABEL[type]}？`, body: domOf(`${amountLine}${routeText(pv.data)}`),
        actions: [{ label: '再檢查', value: null, variant: 'secondary' }, { label: '確定送出', value: 'ok', variant: 'primary' }] });
      if (go !== 'ok' || !alive) return;
      const body = b.payload.body;
      let files = b.payload.files;
      if (b.needSign) {
        ctx.ui.loading(true);
        let up;
        try { up = await uploadSignature(pad.toDataURL()); } finally { ctx.ui.loading(false); }
        if (!up.ok) { msg.textContent = errText({ error: up.error }); ctx.ui.toast(errText({ error: up.error }), 'danger'); return; }
        body.sign_file = up.id;
        files = files.concat([up.id]);
      }
      ctx.ui.loading(true);
      let r;
      try {
        r = resub
          ? await ctx.api.call('approvals', 'apvResubmit', { id: resub.id, rev: resub.rev, body, files })
          : await ctx.api.call('approvals', 'apvSubmit', { client_id: clientId, type, body, files, ...(b.payload.subject ? { subject: b.payload.subject } : {}) });
      } finally { ctx.ui.loading(false); }
      if (!alive) return;
      if (!r || !r.ok) {
        const t = errText(r);
        msg.textContent = t;
        ctx.ui.toast(t, isConflict(r) ? 'warn' : 'danger');
        return;
      }
      if (r.dryrun) { ctx.ui.toast('試跑模式，未真的送出', 'info'); return; }
      clearTimeout(saveTimer);
      dirty = false;      // 送成功了：不要讓還沒到期的存草稿計時器或離開時的補存把草稿寫回去
      clearDraft(store(), userId, type);
      clientId = newClientId();
      ctx.ui.toast(`已送出${r.data && r.data.id ? `，單號 ${r.data.id}` : ''}`, 'ok');
      ctx.nav('mine', {});
    } finally { sending = false; }
  }

  // ── 事件 ────────────────────────────────────────────
  function onClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const tb = t.closest('[data-type]');
    if (tb && !resub) { if (tb.getAttribute('data-type') !== type) showType(tb.getAttribute('data-type')); return; }
    const b = t.closest('[data-act]');
    if (!b) return;
    const a = b.getAttribute('data-act');
    if (a === 'add-item') {
      const items = el.querySelector('[data-role="items"]');
      if (items.children.length >= 30) { ctx.ui.toast('品項最多 30 列', 'warn'); return; }
      items.insertAdjacentHTML('beforeend', itemRow({}, items.children.length));
      scheduleSave();
    } else if (a === 'del-item') {
      const items = el.querySelector('[data-role="items"]');
      if (items.children.length <= 1) { ctx.ui.toast('至少留一列', 'warn'); return; }
      b.closest('[data-role="item-row"]').remove();
      updateTotals();
      scheduleSave();
    } else if (a === 'clear-sign') { if (pad) pad.clear(); }
    else if (a === 'clear-draft') { clearDraft(store(), userId, type); showType(type); ctx.ui.toast('草稿已清除', 'ok'); }
    else if (a === 'preview') onPreview();
    else if (a === 'send') onSend();
  }
  function onInput(e) {
    const t = e.target;
    if (t && t.type === 'file') return;   // 選照片不是改欄位
    if (t && t.getAttribute && t.getAttribute('data-field') === 'payee') {
      const vn = el.querySelector('[data-role="vendor-name"]');
      if (vn) vn.hidden = fieldVal(formEl(), 'payee') !== 'vendor';
    }
    updateTotals();
    scheduleSave();
  }
  function onChange(e) {
    const t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-rerender') === '1') {
      const v = collect();
      if (v.kind !== 'leave') { v.mode = 'self'; }
      renderForm(v, true);
    }
  }
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  el.addEventListener('change', onChange);

  // ── 開場 ────────────────────────────────────────────
  async function start() {
    const rid = ctx.params && ctx.params.resubmit;
    if (!rid) { showType('purchase'); return; }
    el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';
    const r = await ctx.api.call('approvals', 'apvGet', { id: rid });
    if (!alive) return;
    if (!r || !r.ok || !r.data || !r.data.form) {
      el.innerHTML = `<div class="card" data-role="apv-error"><p class="text-muted">${esc(errText(r))}</p></div>`;
      return;
    }
    const f = r.data.form;
    if (!(f.can && f.can.resubmit)) {
      el.innerHTML = '<div class="card"><p class="text-muted">這張單現在不能改完再送</p></div>';
      return;
    }
    resub = { id: f.id, rev: f.rev, step: f.step };
    type = f.type;
    draw();
    const b = f.body || {};
    let v = b;
    if (type === 'personnel') {
      v = { kind: b.kind, effective: b.effective, reason: b.reason, from: b.from || {}, to: b.to || {}, subject: f.subject && f.subject.emp,
        mode: f.subject && f.subject.emp ? 'other' : 'self', signMode: b.paper_files && b.paper_files.length ? 'paper' : 'online' };
      if (b.paper_files) v.__files = b.paper_files.map((id) => ({ id }));
    } else {
      v = { ...b, __files: (f.files || []).filter((x) => x.kind === 'receipt').map((x) => ({ id: x.id })) };
    }
    renderForm(v, false);
  }
  start();

  return () => {
    alive = false;
    clearTimeout(saveTimer);
    if (dirty && !resub && DRAFT_TYPES.indexOf(type) !== -1) saveDraft(store(), userId, type, collect());   // 離開前把最後幾秒的修改存下來
    el.removeEventListener('click', onClick);
    el.removeEventListener('input', onInput);
    el.removeEventListener('change', onChange);
    teardownWidgets();
  };
}
