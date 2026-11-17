# 我的資料 → 設定：每人提醒開關（2026-11-17）

Eason：「在我的資料裡面新增一個設定分頁，設定裡面讓每個人可以自己控制每個功能的提醒開關」。
開工確認頁 https://claude.ai/artifact/2ze85ZNbdtHZdB4oDHdEPi ，Eason 回「開工」＝五題都照推薦（A）。

## 決定
1. 只管管理系統裡的提醒：首頁「要處理的事」／各功能卡片、待處理（含快速核准 quick）、側邊欄數字。**不管** LINE 私訊（補休檢查、綁到別店、打卡 LINE 開通，在打卡系統）、LINE 群組考勤異常、表單簽核通知匣彙整、佈告欄未讀數。LINE 私訊下一期另案。
2. 跟著帳號走：後端分頁 `user_prefs`（uid｜prefs_json｜updated_at），本機 `dzy.u.<id>.alert_off` 只是快取。
3. 一個功能一個開關，三處一起關；功能本身照常點得進去。
4. 「我的資料」的帳號狀態提醒（資料被退回、待確認、改了組織欄等確認）固定開啟：模組 alerts() 回 `keep: true`，manifest `alertsKeep: true`，關掉時殼照跑 alerts() 只留 keep 項目。首頁與待處理多一行「你關了 N 項提醒（…）→ 到設定調整」。
5. 預設全部開（沒有那一列＝空陣列）。

## 做法
- 後端 `apps-script/platform/Prefs.gs`：`myPrefsGet`（讀，任何已登入帳號，只讀自己）、`myPrefsSave {alerts_off:[模組 id]}`（寫，MUTATING_ACTIONS 上鎖；身分只認 token；id 格式 `^[a-z][a-z0-9-]{0,30}$`、最多 60 個；第一次存檔自動建表）。`myPrefsGet` 列在 dryrun READ_ACTIONS 與 minikit readActions；`myPrefsSave` 不列（試跑攔下，畫面說「試跑模式不會存檔」）。
- 殼 `platform/alert-prefs.js`（狀態＋本機快取）＋ `platform/shell.js`：enterApp 先套本機快取、背景 myPrefsGet，不同就重算；`loadHomeGroup` 遇到關掉的模組不跑 badge()／alerts()（alertsKeep 例外）、卡片標「提醒已關閉」、側邊欄數字清掉；`applyLastBadges` 跳過；`runModuleHook('quick')` 跳過。
- `ctx.alertPrefs`（list／off／save）只給 manifest `alertSettings: true` 的模組，manifest-check 只准 `me`。
- 畫面 `modules/me/views/settings.js`：依側邊欄部門分組，一按就存；失敗開關退回並顯示原因。每列小字在 `ALERT_SUBS`（新模組有提醒要補一行，沒補就用 manifest.desc）。

## 已知限制
- 系統帳號裡只有本來就看得到「我的資料」的（admin 等有 `*` 或 platform.self）才有設定分頁；其他系統角色（會計、店長舊帳號）沒有。
- 「我的資料」關掉時 alerts() 仍會打 unitPending／clockAlerts（為了取固定開啟的帳號狀態，順便算了沒顯示）。
- 模組自己頁面裡的數字（例如考勤頁頂分頁的待審數）不受開關影響。

## 測試
- `test/alert-prefs.mock.test.mjs`（41 項：後端讀寫、一人一列、夾帶 uid 無效、格式錯、停用、壞 JSON、白名單、前端純函式、manifest）。
- e2e ㉖ `test/e2e/e2e_t26_alert_prefs.py`（埠 8866；關掉→側邊欄消失、首頁標示與提示、換瀏覽器仍關、提示連到設定、打開回來、存檔失敗退回、試跑、375／320 寬）。mini 上登入頁偶爾 30 秒出不來（主線同支 e2e 同樣），t26 自己重試三次。
