# 人資同仁考勤作廢＋退回重核｜進度

開工：2026-11-13（Eason 回「開工，退回給店長重核也一起做」）
確認頁：docs/att-void-hr/kickoff.html（https://claude.ai/artifact/JRJuoRVGfqPybsm7g2PLGF）六題全照推薦：
1A 新權限碼 att.void（個別例外，admin／人資主管可設，不能設給自己）
2A 全集團　3A 四種單都可　4A 主管代開的不開放　5A 只能作廢　6A 連唯讀班表

開工時 commit：dzy f00b349、mala-store-ops 見下、dzy-store-pages 806f68d

## 第二部分：退回給店長重核（開工後新增，設計未定 → 紅燈等 Eason）

## 決定紀錄
mala-store-ops 開工 4c7b4b1
- 綠：權限碼中文名「考勤作廢」；作廢名單直接用 storeAttLists_(flags hrHead) 算，不另寫規則。
- 綠：營運系統另用 ownSet（含 own_clocks）擋本人，管理系統名單漏扣時也擋得住。
- 綠：手機一頁核定不加作廢鈕，沿用「唯讀請到完整頁」。
- 黃：admin／人資主管持有 att.void 不另給名單（本來就能作廢）。
- 紅（等 Eason）：確認頁第 6 題說「連唯讀班表」，但現行規則人資同仁職稱不給唯讀班表 → 先照現行規則不給。
- 紅（等 Eason）：「退回給店長重核」六題設計。
