/**
 * modules/audit-ops/views/fill.js — 營運稽核表・稽核填寫畫面（T2-5）
 *
 * 正本規格：docs/spec.md §4.6（mount(el,ctx) 回傳 unmount）、§4.7（ctx，含 viewId／params）、
 * §4.10（ctx.ui／ctx.fmt 簽章；UI 一律用 platform/css/components.css 既有 class，
 * 不新增色碼、不內嵌樣式）。
 *
 * 來源：~/mala-audit/js/views/ops.js（457 行，window.Views.ops = {render}）。原檔是單一
 * render() 直接組 innerHTML 字串＋querySelectorAll 綁事件；這裡照 audit-stock/views/fill.js
 * （T2-3 已驗收的範本）的做法改成 DOM 建構（el()/escEl()）＋目標式局部重繪，純規則
 * （驗證／建送出內容／草稿）抽到 fill-submit.js，不碰 DOM 方便單元測試。DOM 結構與
 * class 名盡量原樣保留（既有 e2e 的選擇器才不會全部失效）：id（ops-store／ops-month／
 * ops-auditor／ops-submit／ops-message／ops-s-pass／ops-s-fail／ops-s-pending）與
 * 結構性 class（ops-drafts／ops-draft-link／ops-filter／ops-group／ops-item／
 * is-fail／is-pass／ops-item-text／ops-tag-track／ops-item-btns／ops-vbtn／
 * sel-pass／sel-fail／ops-tbtn／sel／ops-note／ops-empty／ops-stats／ops-filters）
 * 都保留；舊版用 JS 內嵌 class 標記顏色，這裡改疊 platform 既有的 .card／.btn／
 * .btn-primary／.btn-secondary／.tag／.tag-ok／.tag-danger／.tag-warn／.field／
 * .input 等 class 負責外觀（spec §4.10：不新增色碼、不內嵌樣式）。
 *
 * 這張表不能拿掉的兩條規則（任務指示明講：拿掉任何一條就是把這張表變成裝飾品）：
 * ①未完成的項目必填說明 ②稽核人員必填。兩條都在 fill-submit.js 的 auditorError()／
 * missingNoteError() 裡各自獨立實作，這裡的 doSubmit() 依原檔順序（先查稽核人員、
 * 再查未完成說明）呼叫，行為逐字元對照原檔 submit()。
 *
 * 資料一律經 audit-shared/api.js 的 getAll(ctx)／submit(ctx, action, payload) 取得與
 * 送出（不自己呼叫 ctx.api），成功送出後 submit() 會自動 invalidate() 快取。
 *
 * 寫入權限一律用 ctx.can('audit.write') 判斷（不比對角色代號字串，同 audit-stock 的
 * fill.js／overview.js 的理由）。沒有寫入權限時完全不畫表單，只顯示提示卡片，符合
 * 「看不到送出控制項」這條驗收。
 *
 * 與舊版行為上的已知差異，見檔案最下方「與舊版差異」註記。
 *
 * 【狀態保留（Eason 2026-08-15 指示補，任務①）】index.js 呼叫本函式時會多傳一個第三參數
 * `moduleState`（{get(), set(patch)}，見 modules/audit-ops/index.js 檔頭說明；這是
 * audit-ops 自己的一份，不與 audit-stock 共用）：做法逐字元照抄
 * modules/audit-stock/views/fill.js（任務①已驗收的範本）。獨立單元測試
 * （test/audit-ops.test.mjs）呼叫 `mountFill(root, ctx)` 不帶第三參數時行為不變。
 */
'use strict';

import * as sharedApi from '../../audit-shared/api.js';
import { OpsChecklist, Format } from '../../audit-shared/umd-bridge.js';
import * as FillSubmit from './fill-submit.js';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'pass', label: '合格' },
  { key: 'fail', label: '未完成' },
  { key: 'track', label: '追蹤' },
  { key: 'pending', label: '未檢查' }
];

// 本模組唯一支援的年份，同 overview.js 的 YEARS（之後要加年份，兩檔一起加）。
const YEAR = '2026';

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function buildMonthList() {
  const months = [];
  for (let m = 1; m <= 12; m++) months.push(YEAR + '-' + pad2(m));
  return months;
}

// ============================================================
// 小工具：DOM 建構（做法同 audit-stock/views/fill.js，模組自己一份）
// ============================================================

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'hidden') node.hidden = true;
      else node.setAttribute(key, value);
    }
  }
  if (children) {
    for (const child of children) if (child) node.appendChild(child);
  }
  return node;
}

function escEl(ctx, tag, attrs, value) {
  const node = el(tag, attrs);
  node.innerHTML = ctx.fmt.esc(value);
  return node;
}

/** 讀取模組層狀態（moduleState 可能是 undefined，見檔頭「狀態保留」說明）。 */
function readModuleState(moduleState) {
  if (moduleState && typeof moduleState.get === 'function') return moduleState.get() || {};
  return {};
}
function writeModuleState(moduleState, patch) {
  if (moduleState && typeof moduleState.set === 'function') moduleState.set(patch);
}

/**
 * @param {HTMLElement} root 殼／index.js 給的掛載點
 * @param {object} ctx spec §4.7
 * @param {{get:function, set:function}} [moduleState] 模組層「目前選的店別／月份」（任務①，選填）
 * @returns {function} unmount
 */
export function mountFill(root, ctx, moduleState) {
  let destroyed = false;
  const canWrite = ctx.can('audit.write');

  if (!canWrite) {
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-title', text: '營運稽核填寫' }),
      el('p', { class: 'field-hint', text: '沒有填寫權限，無法使用這個分頁。' })
    ]);
    root.appendChild(card);
    return function unmount() {
      destroyed = true;
      if (card.parentNode) card.parentNode.removeChild(card);
    };
  }

  // ---- 資料狀態 ----
  let config = { stores: [] };
  let opsData = { ops_records: [], ops_details: [] };

  // ---- 畫面狀態 ----
  let store = '';
  let month = '';
  let auditor = '';
  let entries = FillSubmit.blankEntries();
  let filter = 'all'; // 同舊版：換店／換月／換草稿不重置篩選，只有第一次載入預設 'all'
  let source = 'new';
  let submitting = false;

  const months = buildMonthList();
  const params = ctx.params || {};

  // ============================================================
  // 骨架
  // ============================================================

  const storeSelect = el('select', { id: 'ops-store', class: 'input' });
  const monthSelect = el('select', { id: 'ops-month', class: 'input' });
  months.forEach((m) => monthSelect.appendChild(el('option', { value: m, text: m + '（' + Format.monthLabel(m) + '）' })));
  const auditorInput = el('input', { type: 'text', id: 'ops-auditor', class: 'input', placeholder: '填寫人姓名' });
  const submittedNoticeEl = el('p', {
    class: 'field-hint',
    text: '這個月已經送出過，現在是修改模式；再送出一次會整筆覆蓋。',
    hidden: 'true'
  });

  const selectCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title', text: '營運稽核填寫' }),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'ops-store', text: '店別' }), storeSelect]),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'ops-month', text: '月份' }), monthSelect]),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'ops-auditor', text: '稽核人員' }), auditorInput]),
    submittedNoticeEl
  ]);

  const draftsEl = el('div', { class: 'card ops-drafts', id: 'ops-drafts', hidden: 'true' });

  const statTotal = el('b', { text: '0' });
  const statPass = el('b', { id: 'ops-s-pass', text: '0' });
  const statFail = el('b', { id: 'ops-s-fail', text: '0' });
  const statTrack = el('b', { text: '0' });
  const statPending = el('b', { id: 'ops-s-pending', text: '0' });
  const statRate = el('b', { text: '0%' });
  const statsEl = el('div', { class: 'ops-stats card-row' }, [
    el('span', { class: 'tag' }, [el('span', { text: '細項 ' }), statTotal]),
    el('span', { class: 'tag tag-ok' }, [el('span', { text: '合格 ' }), statPass]),
    el('span', { class: 'tag tag-danger' }, [el('span', { text: '未完成 ' }), statFail]),
    el('span', { class: 'tag tag-warn' }, [el('span', { text: '追蹤 ' }), statTrack]),
    el('span', { class: 'tag' }, [el('span', { text: '未檢查 ' }), statPending]),
    el('span', { class: 'tag' }, [el('span', { text: '合格率 ' }), statRate])
  ]);

  const filtersEl = el('div', { class: 'ops-filters card-row' });
  const listEl = el('div', { class: 'ops-list', id: 'ops-list' });

  const messageEl = el('p', { id: 'ops-message', class: 'field-hint', hidden: 'true' });
  const submitBtn = el('button', { type: 'button', id: 'ops-submit', class: 'btn btn-primary', text: '送出營運稽核' });

  root.appendChild(selectCard);
  root.appendChild(draftsEl);
  root.appendChild(statsEl);
  root.appendChild(filtersEl);
  root.appendChild(listEl);
  root.appendChild(messageEl);
  root.appendChild(submitBtn);

  // ============================================================
  // 渲染：頂部（店／月／稽核人員／覆蓋提示）
  // ============================================================

  function renderTop() {
    storeSelect.value = store;
    monthSelect.value = month;
    auditorInput.value = auditor;
    submittedNoticeEl.hidden = source !== 'submitted';
  }

  // ============================================================
  // 渲染：未送出草稿一覽（同舊版 render() 裡的 draftsHtml，排除正在填的這筆）
  // ============================================================

  function storeLabel(code) {
    const hit = (config.stores || []).filter((s) => s.code === code)[0];
    return hit ? hit.name : code;
  }

  function renderDrafts() {
    while (draftsEl.firstChild) draftsEl.removeChild(draftsEl.firstChild);
    const currentKey = Format.recordKey(store, month);
    const others = FillSubmit.listDrafts().filter((d) => d.record_key !== currentKey);
    if (!others.length) {
      draftsEl.hidden = true;
      return;
    }
    draftsEl.hidden = false;
    draftsEl.appendChild(el('span', { text: '未送出草稿：' }));
    others.forEach((d) => {
      const label = storeLabel(d.store) + ' ' + Format.monthLabel(d.month);
      const btn = escEl(ctx, 'button', {
        type: 'button', class: 'btn btn-secondary ops-draft-link',
        'data-store': d.store, 'data-month': d.month
      }, label);
      btn.addEventListener('click', () => {
        store = d.store;
        month = d.month;
        writeModuleState(moduleState, { store, month });
        loadEntriesForCurrent();
      });
      draftsEl.appendChild(btn);
    });
  }

  // ============================================================
  // 渲染：統計
  // ============================================================

  function renderStats() {
    const c = FillSubmit.counts(entries);
    statTotal.textContent = String(c.total);
    statPass.textContent = String(c.pass);
    statFail.textContent = String(c.fail);
    statTrack.textContent = String(c.track);
    statPending.textContent = String(c.pending);
    statRate.textContent = c.pass_rate + '%';
  }

  // ============================================================
  // 渲染：篩選鈕
  // ============================================================

  function renderFilters() {
    while (filtersEl.firstChild) filtersEl.removeChild(filtersEl.firstChild);
    FILTERS.forEach((f) => {
      const active = filter === f.key;
      const btn = el('button', {
        type: 'button',
        class: 'btn ' + (active ? 'btn-primary' : 'btn-secondary') + ' ops-filter' + (active ? ' sel' : ''),
        'data-filter': f.key,
        text: f.label
      });
      btn.addEventListener('click', () => {
        filter = f.key;
        renderFilters();
        renderList();
      });
      filtersEl.appendChild(btn);
    });
  }

  // ============================================================
  // 渲染：清單（依分類分組、依篩選顯示；同舊版 listHtml()／itemHtml()）
  // ============================================================

  function matchesFilter(entry) {
    if (filter === 'all') return true;
    if (filter === 'pass') return entry.verdict === '合格';
    if (filter === 'fail') return entry.verdict === '未完成';
    if (filter === 'pending') return entry.verdict === '未檢查';
    if (filter === 'track') return !!entry.track || entry.verdict === '未完成';
    return true;
  }

  function onVerdictClick(id, v) {
    const entry = entries[id];
    entry.verdict = (entry.verdict === v) ? '未檢查' : v; // 再點一次取消，回未檢查（同舊版）
    saveDraftNow();
    renderStats();
    renderList();
  }

  function onTrackClick(id) {
    entries[id].track = !entries[id].track;
    saveDraftNow();
    renderList();
  }

  function buildItemNode(it) {
    const e = entries[it.id] || FillSubmit.emptyEntry();
    const isFail = e.verdict === '未完成';
    const isPass = e.verdict === '合格';
    const cls = 'ops-item' + (isFail ? ' is-fail' : '') + (isPass ? ' is-pass' : '');

    const textEl = escEl(ctx, 'p', { class: 'ops-item-text' }, it.text);
    if (e.track) textEl.appendChild(el('span', { class: 'ops-tag-track tag tag-warn', text: '追蹤' }));

    const passBtn = el('button', {
      type: 'button',
      class: 'btn ' + (isPass ? 'btn-primary' : 'btn-secondary') + ' ops-vbtn' + (isPass ? ' sel-pass' : ''),
      'data-verdict': '合格', 'data-item': it.id, text: '合格'
    });
    passBtn.addEventListener('click', () => onVerdictClick(it.id, '合格'));

    const failBtn = el('button', {
      type: 'button',
      class: 'btn ' + (isFail ? 'btn-primary' : 'btn-secondary') + ' ops-vbtn' + (isFail ? ' sel-fail' : ''),
      'data-verdict': '未完成', 'data-item': it.id, text: '未完成'
    });
    failBtn.addEventListener('click', () => onVerdictClick(it.id, '未完成'));

    const trackBtn = el('button', {
      type: 'button',
      class: 'btn ' + (e.track ? 'btn-primary' : 'btn-secondary') + ' ops-tbtn' + (e.track ? ' sel' : ''),
      'data-track': '1', 'data-item': it.id, text: e.track ? '★ 追蹤中' : '☆ 追蹤'
    });
    trackBtn.addEventListener('click', () => onTrackClick(it.id));

    const btnsRow = el('div', { class: 'ops-item-btns card-row' }, [passBtn, failBtn, trackBtn]);

    const noteEl = el('textarea', {
      class: 'ops-note input', 'data-item': it.id, rows: '2',
      placeholder: '說明 / 缺失描述（判未完成必填）'
    });
    noteEl.value = e.note || '';
    // input 只存不重畫（同舊版：每打一個字就重畫會把輸入游標搶走，打到一半跳掉）。
    noteEl.addEventListener('input', () => {
      entries[it.id].note = noteEl.value;
      saveDraftNow();
    });

    return el('div', { class: cls, 'data-item': it.id }, [textEl, btnsRow, noteEl]);
  }

  function renderList() {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    let lastGroup = null;
    let shown = 0;
    OpsChecklist.flat.forEach((it) => {
      const e = entries[it.id] || FillSubmit.emptyEntry();
      if (!matchesFilter(e)) return;
      if (it.group !== lastGroup) {
        listEl.appendChild(escEl(ctx, 'h3', { class: 'ops-group' }, it.cat + '｜' + it.group));
        lastGroup = it.group;
      }
      listEl.appendChild(buildItemNode(it));
      shown++;
    });
    if (!shown) listEl.appendChild(el('p', { class: 'ops-empty field-hint', text: '這個篩選沒有項目。' }));
  }

  function fullRender() {
    renderTop();
    renderDrafts();
    renderStats();
    renderFilters();
    renderList();
  }

  // ============================================================
  // 草稿存取
  // ============================================================

  function saveDraftNow() {
    FillSubmit.saveDraft(store, month, auditor, entries);
  }

  function loadEntriesForCurrent() {
    hideMessage();
    const loaded = FillSubmit.loadEntriesFor(store, month, opsData);
    entries = loaded.entries;
    auditor = loaded.auditor;
    source = loaded.from;
    FillSubmit.persistLastStore(store);
    fullRender();
  }

  // ============================================================
  // 訊息列
  // ============================================================

  function hideMessage() {
    messageEl.hidden = true;
    messageEl.textContent = '';
  }
  function showMessage(text) {
    messageEl.textContent = text;
    messageEl.hidden = false;
  }

  // ============================================================
  // 送出
  // ============================================================

  async function performSubmit() {
    submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = '送出中…';
    showMessage('送出中…');

    const details = FillSubmit.detailList(entries);
    const record = FillSubmit.buildRecord({ store, month, auditor, details });
    const payloadDetails = FillSubmit.buildDetails({ store, month, details });

    try {
      const res = await sharedApi.submit(ctx, 'submitOpsAudit', { record, details: payloadDetails });
      if (destroyed) return;
      submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = '送出營運稽核';
      if (res && res.ok) {
        // submit() 成功時已經呼叫過 invalidate()（見 audit-shared/api.js），下一次進報告頁
        // 呼叫 getAll() 就會拿到剛送出的新資料，不必像舊版 app.reload() 那樣手動重抓一次。
        FillSubmit.clearDraft(record.record_key);
        hideMessage();
        ctx.ui.toast('營運稽核已送出', 'ok');
        ctx.nav('report', { store, month });
      } else {
        showMessage('送出失敗：' + ((res && res.error) || '請重試'));
      }
    } catch (e) {
      if (destroyed) return;
      submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = '送出營運稽核';
      showMessage('送出失敗：' + e);
    }
  }

  async function doSubmit() {
    hideMessage();
    const details = FillSubmit.detailList(entries);

    // 規則①：稽核人員必填——沒填就只顯示這一條，不疊加其他錯誤（同舊版短路順序）。
    const aErr = FillSubmit.auditorError(auditor);
    if (aErr) {
      showMessage(aErr);
      return;
    }

    // 規則②：判「未完成」的項目必填說明——擋下並把篩選切到「未完成」，方便直接補（同舊版）。
    const mErr = FillSubmit.missingNoteError(details);
    if (mErr) {
      showMessage(mErr.message);
      filter = 'fail';
      renderFilters();
      renderList();
      return;
    }

    await performSubmit();
  }

  submitBtn.addEventListener('click', () => {
    if (submitting) return;
    doSubmit();
  });

  // ============================================================
  // 事件：選店／選月／稽核人員
  // ============================================================

  function onStoreChange() {
    store = storeSelect.value;
    writeModuleState(moduleState, { store });
    loadEntriesForCurrent();
  }
  function onMonthChange() {
    month = monthSelect.value;
    writeModuleState(moduleState, { month });
    loadEntriesForCurrent();
  }
  storeSelect.addEventListener('change', onStoreChange);
  monthSelect.addEventListener('change', onMonthChange);

  auditorInput.addEventListener('input', () => {
    auditor = auditorInput.value;
    saveDraftNow();
  });

  // ============================================================
  // 初始化
  // ============================================================

  function pickDefaultStore() {
    const codes = (config.stores || []).map((s) => s.code);
    if (params.store && codes.indexOf(params.store) !== -1) return params.store;
    const carried = readModuleState(moduleState).store;
    if (carried && codes.indexOf(carried) !== -1) return carried;
    const saved = FillSubmit.loadLastStore();
    if (saved && codes.indexOf(saved) !== -1) return saved;
    return codes[0] || '';
  }

  async function loadData() {
    ctx.ui.loading(true);
    try {
      const res = await sharedApi.getAll(ctx);
      if (destroyed) return;
      if (!res || res.ok !== true) {
        ctx.ui.toast((res && res.error) || '發生錯誤，請稍後再試', 'danger');
        return;
      }
      config = (res.data && res.data.config) || { stores: [] };
      opsData = {
        ops_records: (res.data && res.data.ops_records) || [],
        ops_details: (res.data && res.data.ops_details) || []
      };

      while (storeSelect.firstChild) storeSelect.removeChild(storeSelect.firstChild);
      (config.stores || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)).forEach((s) => {
        storeSelect.appendChild(escEl(ctx, 'option', { value: s.code }, s.name));
      });

      store = pickDefaultStore();
      storeSelect.value = store;

      // 月份優先序同 audit-stock/views/fill.js：params ＞ moduleState（任務①）＞ 當月／預設。
      const carriedMonth = params.month ? null : readModuleState(moduleState).month;
      const now = new Date();
      const realMonthStr = String(now.getFullYear()) + '-' + pad2(now.getMonth() + 1);
      month = params.month
        || (carriedMonth && months.indexOf(carriedMonth) !== -1 ? carriedMonth : null)
        || (String(now.getFullYear()) === YEAR ? realMonthStr : months[0]);
      if (months.indexOf(month) === -1) month = months[0];
      monthSelect.value = month;
      writeModuleState(moduleState, { store, month });

      loadEntriesForCurrent();
    } catch (e) {
      if (!destroyed) ctx.ui.toast('發生錯誤，請稍後再試', 'danger');
    } finally {
      if (!destroyed) ctx.ui.loading(false);
    }
  }

  loadData();

  return function unmount() {
    destroyed = true;
    storeSelect.removeEventListener('change', onStoreChange);
    monthSelect.removeEventListener('change', onMonthChange);
    [selectCard, draftsEl, statsEl, filtersEl, listEl, messageEl, submitBtn].forEach((n) => {
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
  };
}

// ============================================================
// 與舊版差異（供任務回報引用，行為都是刻意的等價轉換，不是遺漏）：
//
// 1. 舊版把「填寫進度」存在模組層 var st（IIFE 模組級變數），只要整個 SPA 沒重新整理，
//    使用者在稽核填寫頁與其他頁之間切換，即使完全沒動過任何欄位，回到這頁也會停在
//    剛才選的店／月。新架構每次切分頁都是全新 mount()（見 spec §4.6），這個「純瀏覽、
//    沒有任何輸入」狀態下的記憶點沒有對應物件可以延續。使用者一旦做過任何輸入（含只是
//    選了店／月，因為 store 切換會呼叫 persistLastStore()），資料就已經進草稿或
//    ops_last_store，重新進頁仍會回到同一份內容——只有「選了店月、完全沒填任何東西、
//    幾秒內就切走又切回」這種極短暫的中間態不會被記住，不影響任何資料完整性。
// 2. 「讀不到店別清單，請重新登入」這條錯誤文案沒有搬：canWrite 本身已代表登入成功
//    （沒有合法 token 走不到這裡），config.stores 為空是理論上不會發生的情況，同
//    audit-stock/views/fill.js 也沒有對這個邊界情況加防禦文案。
// ============================================================
