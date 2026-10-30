/**
 * modules/eval/lib.js — 績效評核共用小工具：樣式、星等元件、草稿、等待鈕、季度文字。
 * 計分不在這裡（後端 EvalCalc.gs 算；前端即時小計用 modules/eval-shared/calc.js）。
 */
'use strict';

export const STYLE = `
.ev-wrap{display:flex;flex-direction:column;gap:16px;max-width:860px}
.ev-note{color:var(--muted);font-size:14px;line-height:1.6}
.ev-person{border:1px solid var(--line);border-radius:var(--radius);background:var(--card)}
.ev-person>summary{cursor:pointer;padding:12px 14px;font-weight:600;display:flex;gap:8px;align-items:center;list-style:none}
.ev-person>summary::-webkit-details-marker{display:none}
.ev-person[open]>summary{border-bottom:1px solid var(--line)}
.ev-person .ev-body{padding:8px 14px 14px;display:flex;flex-direction:column;gap:14px}
.ev-cat{font-weight:700;margin-top:4px}
.ev-item{display:flex;flex-direction:column;gap:6px}
.ev-item-label{font-weight:600}
.ev-stars{display:flex;gap:4px}
.ev-star{width:40px;height:40px;border-radius:8px;border:1px solid var(--line);background:var(--card);font-size:22px;line-height:1;cursor:pointer;color:#bbb}
.ev-star.on{color:var(--warn);border-color:var(--warn);background:var(--warn-light)}
.ev-star:disabled{cursor:default}
.ev-levels{font-size:13px;color:var(--muted);margin:0;padding-left:0;list-style:none}
.ev-levels li.on{color:var(--ink);font-weight:600}
.ev-state{font-size:13px;color:var(--muted);font-weight:400;margin-left:auto}
.ev-state.done{color:var(--ok)}
.ev-table td.num,.ev-table th.num{text-align:right;font-variant-numeric:tabular-nums}
.ev-table tr.sub td{font-weight:700;background:var(--bg)}
.ev-table tr.grand td{font-weight:700;border-top:2px solid var(--line)}
.ev-down{color:var(--danger)}
.ev-msg{border-left:3px solid var(--line);padding:6px 10px;margin:6px 0;white-space:pre-wrap}
.ev-msg small{display:block;color:var(--muted);margin-top:4px}
.ev-hl{background:var(--warn-light)}
.ev-row-act{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ev-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media (max-width:640px){.ev-grid2{grid-template-columns:1fr}.ev-star{width:36px;height:36px}}
@media print{.ev-noprint{display:none!important}.ev-print-head{display:block!important}}
.ev-print-head{display:none;font-size:18px;font-weight:700;margin-bottom:8px}
`;

export function addStyle(el) {
  const s = document.createElement('style');
  s.textContent = STYLE;
  el.appendChild(s);
}

/** '2026-Q4' → '2026 年第 4 季' */
export function qLabel(q) {
  const m = /^(\d{4})-Q([1-4])$/.exec(String(q || ''));
  return m ? `${m[1]} 年第 ${m[2]} 季` : String(q || '');
}

export const r1 = (n) => (n === null || n === undefined || n === '' ? '—' : String(Math.round(Number(n) * 10) / 10));

/**
 * 慢動作按鈕（舊站 btnWaiting）：顯示「文字…」，一秒後起「文字… N 秒」。回傳 done(enable=true)。
 */
export function btnWaiting(btn, text) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = text + '…';
  const t0 = Date.now();
  const timer = setInterval(() => { btn.textContent = `${text}… ${Math.floor((Date.now() - t0) / 1000)} 秒`; }, 1000);
  return (enable = true) => { clearInterval(timer); btn.textContent = orig; btn.disabled = !enable; };
}

/** 草稿（只認本人；比照稽核草稿 dzy.u.<user id>.*）。localStorage 失敗一律忽略 */
export function draftKey(ctx, kind, quarter) {
  const uid = ctx.user && ctx.user.id ? ctx.user.id : 'anon';
  return `dzy.u.${uid}.ev_draft_${kind}_${quarter}`;
}
export function draftLoad(key) { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
export function draftSave(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 無痕或滿了：忽略 */ } }
export function draftClear(key) { try { localStorage.removeItem(key); } catch (e) { /* 忽略 */ } }

/**
 * 一題星等：label＋五顆星＋五級說明（預設展開，Eason 2026-10-02 指定）。
 * onChange(value)；value 1～5 或 null。readOnly 時不能點。
 */
export function starItem(esc, item, value, onChange, readOnly) {
  const box = document.createElement('div');
  box.className = 'ev-item';
  box.setAttribute('data-role', 'ev-item');
  box.setAttribute('data-key', item.key);
  const lv = Array.isArray(item.levels) ? item.levels : [];
  box.innerHTML = `<div class="ev-item-label">${esc(item.label)}</div>
    <div class="ev-stars" role="radiogroup" aria-label="${esc(item.label)}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="ev-star" data-star="${n}" aria-label="${n} 顆星" ${readOnly ? 'disabled' : ''}>★</button>`).join('')}</div>
    ${lv.length ? `<ul class="ev-levels">${lv.map((t, i) => `<li data-lv="${5 - i}">${5 - i}★ ${esc(t)}</li>`).join('')}</ul>` : ''}`;
  let v = value || null;
  const paint = () => {
    box.querySelectorAll('.ev-star').forEach((b) => b.classList.toggle('on', v !== null && Number(b.dataset.star) <= v));
    box.querySelectorAll('.ev-levels li').forEach((li) => li.classList.toggle('on', v !== null && Number(li.dataset.lv) === v));
  };
  if (!readOnly) {
    box.querySelectorAll('.ev-star').forEach((b) => b.addEventListener('click', () => { v = Number(b.dataset.star); paint(); onChange && onChange(v); }));
  }
  paint();
  return box;
}

/** 一組題目（態度／表現）→ 回傳 {el, values()}；values 長度＝題數，未評為 null */
export function starGroup(esc, title, bank, initial, onChange, readOnly) {
  const el = document.createElement('div');
  el.className = 'ev-cat-wrap';
  const vals = bank.map((_, i) => (initial && initial[i]) || null);
  const h = document.createElement('div');
  h.className = 'ev-cat';
  h.textContent = title;
  el.appendChild(h);
  bank.forEach((it, i) => el.appendChild(starItem(esc, it, vals[i], (v) => { vals[i] = v; onChange && onChange(); }, readOnly)));
  return { el, values: () => vals.slice(), complete: () => vals.every((v) => v !== null) };
}

/** 後端 evFail_(code, message) 的錯誤碼 → 人話（沒帶 message 時用；對照 apps-script/platform/Eval.gs） */
const ERR_ZH = {
  window_closed: '現在不是填寫期間（每季第一個月 1～5 號）',
  bad_request: '資料格式不對，請檢查後再試',
  forbidden: '沒有權限',
  unauthorized: '登入已過期，請重新登入',
  duplicate: '已經有一筆相同的資料',
  not_in_unit: '這位同仁不在你的單位',
  not_inited: '績效評核還沒初始化，請系統管理員先設定',
  no_scope: '你目前沒有可評核的對象',
  finalized: '這一季已經定稿，不能再改',
  busy: '系統忙碌中，請稍後再試'
};
/**
 * 錯誤回應 → 給人看的字。平台 api.js transformResponse_ 會把後端 {ok:false, error:code, message:文字} 壓成
 * {error: code, data:{message}}（2026-10-29 資料帶入測試：畫面只剩「儲存失敗：window_closed」）→ 先讀 data.message，
 * 再讀 message，再把已知碼翻中文，最後才原樣顯示 error。
 */
export function errText(r) {
  if (!r) return '連不上伺服器，請稍後再試';
  const m = (r.data && typeof r.data.message === 'string' && r.data.message) || (typeof r.message === 'string' && r.message) || '';
  if (m) return m;
  const code = typeof r.error === 'string' ? r.error : '';
  return ERR_ZH[code] || code || '發生錯誤';
}
