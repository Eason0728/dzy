/**
 * modules/staff/views/list-cards.js — 同仁名單手機版卡片樣式（2026-10-26）
 *
 * 寬度 ≤860px（跟殼的手機斷點一致）時，表格每一列改成一張卡：上方編號＋姓名、品牌單位職稱、狀態，
 * 下方主要按鈕整排可換行，其餘收進「更多」（Eason 選 B 版），不用左右滑。電腦版表格完全不變。
 * 樣式由模組自己注入（模組不能改 platform/css），只作用在 .stf-table。
 */
'use strict';

export const CARD_CSS = `
.stf-more { display: none; }
@media (max-width: 860px) {
  .stf-wrap { overflow: visible; border: 0; border-radius: 0; }
  .stf-table { min-width: 0; background: transparent; }
  .stf-table thead { display: none; }
  .stf-table tbody { display: flex; flex-direction: column; gap: var(--space-3); }
  .stf-table tbody tr {
    display: grid; grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas: "emp name" "org org" "status status" "claim claim" "act act";
    gap: 6px 8px; padding: var(--space-3); background: var(--card);
    border: 1px solid var(--line); border-radius: var(--radius);
  }
  .stf-table tbody tr:hover { background: var(--card); box-shadow: none; }
  .stf-table td { display: block; padding: 0; border: 0; white-space: normal; min-width: 0; overflow-wrap: anywhere; }
  .stf-table td:empty { display: none; }
  .stf-table td.c-emp { grid-area: emp; color: var(--muted); font-size: var(--fs-sm); align-self: baseline; }
  .stf-table td.c-name { grid-area: name; font-weight: var(--fw-medium); align-self: baseline; }
  .stf-table td.c-name .tag, .stf-table td.c-name .text-muted { font-weight: normal; }
  .stf-table td.c-org { grid-area: org; }
  .stf-table td.c-status { grid-area: status; }
  .stf-table td.c-claim { grid-area: claim; color: var(--muted); font-size: var(--fs-sm); }
  .stf-table td.c-claim::before { content: "認領 "; }
  .stf-table td.c-act {
    grid-area: act; display: flex; flex-wrap: wrap; gap: 6px;
    padding-top: var(--space-2); border-top: 1px solid var(--line);
  }
  .stf-table td.c-act .btn { white-space: nowrap; }
  .stf-table td.c-none { grid-column: 1 / -1; }
  /* 次要按鈕收進「更多」：按了該列加 stf-open 才展開 */
  .stf-table .stf-sec { display: none; }
  .stf-table tr.stf-open .stf-sec { display: inline-flex; }
  .stf-table .stf-more { display: inline-flex; }
}
`;
