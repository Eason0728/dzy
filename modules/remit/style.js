/**
 * modules/remit/style.js — 匯款清單自己的樣式（由模組注入，platform 零改動；同 modules/staff/views/list-cards.js 的做法）
 * 電腦版：表格；≤860px：每列變一張卡（td 帶 data-label）。顏色一律用平台的 CSS 變數，新舊外觀都跟著走。
 */
'use strict';

const CSS = `
.remit-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.remit-bar .remit-sum{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums}
.remit-chip{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:4px 12px;font:inherit;cursor:pointer}
.remit-chip[aria-pressed="true"]{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:700}
.remit-table td.num,.remit-table th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.remit-table .remit-acts{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.remit-table .remit-sub{color:var(--muted);font-size:.86em}
.remit-bank{font-size:.9em;line-height:1.45}
.remit-due{color:var(--danger);font-weight:700}
@media (max-width:860px){
  .remit-table thead{display:none}
  .remit-table,.remit-table tbody,.remit-table tr,.remit-table td{display:block;width:100%}
  .remit-table tr{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;margin-bottom:10px}
  .remit-table td{border:0;padding:2px 0}
  .remit-table td[data-label]::before{content:attr(data-label) "　";color:var(--muted);font-size:.86em}
  .remit-table td.num{text-align:left;font-size:1.1em;font-weight:700}
  .remit-table td.remit-payee{font-weight:700;font-size:1.02em}
  .remit-table .remit-acts{justify-content:flex-start;margin-top:6px}
  .remit-bar .remit-sum{margin-left:0;width:100%}
}
`;

export function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById('remit-style')) return;
  const st = document.createElement('style');
  st.id = 'remit-style';
  st.textContent = CSS;
  document.head.appendChild(st);
}
