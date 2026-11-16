# 管理系統介面改版（?ui=new）進度

開工：2026-11-16，Eason 回「開工，7A」。開工時 commit：origin/main 5ca870d。
確認頁：https://claude.ai/artifact/89cFifm7Ct658VRXiXmg8V（本機 ~/dev/dzy-redesign-shots/kickoff.html）

## 定案
1. 方向 1 三家融合：外觀照 Apple（淺灰底、白色圓角清單、半透明側邊欄），首頁三個大數字＋依急迫排序（特斯拉），資料多的頁用整齊表格（微軟）。
2. 重點色 B：Apple 藍 #0071e3（選中、主要按鈕、連結）；紅色只給逾期／異常／件數紅點。
3. 範圍 B：dzy 外框＋首頁＋共用元件＋9 個嵌入子系統（門市營運、考勤、排班、薪酬、損益、貨單、調撥、收支、公告）只換樣式。
4. 第 4 題：營運系統同一輪換，不解除「兩邊長一樣」。
5. 深色模式不做。 6. 登入頁不動。 7. 保留彩色圖示（7A），只改大小圓角。 8. 先 ?ui=new 測試網址，Eason 看過才換全部。

## 不可降標準
- 375／320 寬 58 個畫面無橫向捲軸；axe-core 對比 0 錯（首頁、功能頁、同仁名單、表單簽核）；首頁第二次開 ≤1 秒先顯示件數；data-role/data-nav/data-view/.nav-item 保留。

## 紅線
- 動後端／計算邏輯停下問；任何正式上線（push main、子系統 Pages、mini update）先問。dzy 帳號 clasp 未登入 → 停下請 Eason 從 MacBook 推。

## 決定紀錄
- 綠：開關做成 index.html 開頭的行內程式（要在畫面出來前決定，避免先閃舊外觀）；`?ui=new`／`?ui=old` 記在分頁 sessionStorage `dzy.ui`；總開關 `UI_NEW_DEFAULT`。
- 綠：新外觀全部寫在 `platform/css/ui-new.css`，選擇器都掛 `:root[data-ui="new"]`，沒開時零作用；不動 tokens.css 原值。
- 綠：盤點後「9 個子系統」實際是 5 套程式：營運系統（門市營運／排班／考勤三個模組同一套，repo mala-store-ops → dzy-store Pages）、佈告欄（dzy-bulletin）、貨單（dzy-purchase）、薪酬（mala-clock-in payroll.html）、調撥（mala-transfer report.html）。收支管理、損益試算已是管理系統原生模組（不嵌 iframe），自動跟著換。
- 綠：電腦版首頁在新外觀多一段「三個大數字＋要處理的事（最多 8 筆，依已逾期→今天→這週）」，下面接原本各功能卡片（data-role=module-card 保留給 e2e）；手機首頁也加三個大數字。
- 綠：嵌入的子系統網址多帶 `&ui=new`（只在新外觀開著時），由各模組讀 `<html data-ui>`。
