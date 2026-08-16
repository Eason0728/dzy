# 雲端資源清單

建立當下就記在這裡，避免跨 session／跨 harness 重複建立。上線時同步一份到
`~/.claude/mala-ops/dispatch-rules.md` 第 5 節（任務 T4-6）。

## 本專案新建（2026-08-14）

| 項目 | 值 |
|---|---|
| 試算表 | 鼎兆元管理系統｜帳號權限 |
| 試算表 ID | `1jAH7skTCFxxB8w6V3-zB8VcFQIJ1VWtM_XX2btJQKc4` |
| 試算表網址 | https://drive.google.com/open?id=1jAH7skTCFxxB8w6V3-zB8VcFQIJ1VWtM_XX2btJQKc4 |
| Apps Script | 鼎兆元管理系統｜帳號權限（**容器繫結**於上述試算表） |
| Script ID | `10kayP1WmFO3VDNOM0rVJT-110e4Dvx4ehE8IeNiOcU1vTN_xGzDC65O7` |
| 編輯器網址 | https://script.google.com/d/10kayP1WmFO3VDNOM0rVJT-110e4Dvx4ehE8IeNiOcU1vTN_xGzDC65O7/edit |
| 擁有帳號 | madesiaosinla@gmail.com（與既有九支系統同帳號） |
| 本機路徑 | `~/dzy/apps-script/platform`（`.clasp.json` 已 gitignore） |
| 時區 | 腳本 Asia/Taipei ＋ **試算表本身也要另外設** Asia/Taipei（兩個是獨立設定，見記憶庫 apps-script-clasp-deploy-gotchas 第 15 條） |
| **部署 ID** | `AKfycbww4w5qrdEqFA1UwOxDeZQKzoVahqJPrRDJ9mVUqUSb9-BcWqoHYLyAPN5O35QjX4Rs`（**@3**，2026-08-15；`clasp deployments` 2026-08-17 實查。@1 是 2026-08-14 首次部署的舊版號） |
| **正式網址** | https://script.google.com/macros/s/AKfycbww4w5qrdEqFA1UwOxDeZQKzoVahqJPrRDJ9mVUqUSb9-BcWqoHYLyAPN5O35QjX4Rs/exec |
| 存取設定 | `ANYONE_ANONYMOUS`／`USER_DEPLOYING`（GitHub Pages 前端呼叫必需） |

**狀態**：已授權、已部署、端點實測正常。

⚠ **之後改後端一律 `clasp create-version` ＋ `clasp update-deployment -V <版號> <上面的部署 ID>`。
絕不再 `create-deployment`**——那會產生新網址，前端就斷線了。首次部署是唯一的例外，已經用掉了。

## 沿用既有、本專案不得更動

| 系統 | Script ID | 部署 ID | 註 |
|---|---|---|---|
| 稽核 | `1MKar7OQpp6HKrQg_Vo809NQsgna5bWCVRhoB6tgNjUEZNcj9op-nEkWy` | `AKfycbz5l_aH_qypN6HK6UDT__5NLZDk4A2clyqeqvJzx5JrL9SBVeH5GyDYBCW3gv-CDy7fFQ`（@8） | 容器繫結於稽核試算表 |
| 宿舍合約 | `1UTBAjjdRk5mNpn6OtCzFEcXw858pglyUrVRYX4YRWsbex4h7ifVkBxb1` | `AKfycbyxyhJ35MWTjtvzKr54_9JzGfLZlclyqn2fYLWXgz0muTFzL_tu81nR1r3W332J1igm`（**@17**，2026-08-15；dispatch-rules 第 5 節記載的 @7 已過時） | 獨立 script |

**2026-08-15 對宿舍後端做過的兩次改動**（都經 Eason 明確同意，都是純新增或純記錄修正）：
1. @16：移除 `wipeAll` 端點與 `wipeAllData()`（帶 admin 通行碼就能從網路清空所有合約）
2. @17：`doPost` 補上四個讀取 action（`rooms`／`list`／`contract`／`handover`）。
   新系統一律用 POST（用 GET 會讓通行碼進網址列），而那四個原本只在 `doGet` 有，
   不補的話宿舍模組一筆資料都讀不到——**而且測試 mock 掉後端永遠抓不到這件事**。
   `doGet` 一個字沒動，舊網址與已發出的簽約連結不受影響。
3. 另補提交了一個 2026-07-24 就存在的未提交修改（`Pdf.gs` 重複區塊）：
   git HEAD 存的那版有重複的 `const` 宣告、`node --check` 直接 SyntaxError，
   也就是**線上是好的、Mac 是好的、只有 git 是壞的**。任何人 checkout 還原就會弄掛系統。

⚠ 這兩支**永遠用 `deploy -i` 更新既有部署 ID**，絕不 `create-deployment`（會換網址、前端斷線）。
本專案 Phase 1–4 完全不推送這兩支。

## 例外紀錄：2026-08-14 動過宿舍合約後端一次

spec.md D3 寫「既有後端一行都不改」，這是唯一一次例外，**經 Eason 明確指示**：

- 移除 `Api.gs` 的 `wipeAll` POST 端點（帶 admin 通行碼＋`confirm=WIPE` 就能從網路清空所有合約）
- 移除 `Diag.gs` 的 `wipeAllData()`，原處留註解說明為何不要加回來
- 版本 @15 → **@16**，用 `update-deployment` 更新既有部署 ID，**未建立新部署**（網址不變）
- 動之前先 `clasp pull` 到暫存目錄逐檔比對，確認遠端與本機 11 檔完全一致才推

理由：本專案的設計會把宿舍後台通行碼下發到部門主管的瀏覽器（spec §6.3），
等於讓更多人握有這個端點；正式合約是法律文件，風險與用途完全不成比例。

**除此之外，Phase 1–4 不再推送這兩支既有後端。**

## 資料備份

見 [backup-log.md](./backup-log.md)。
