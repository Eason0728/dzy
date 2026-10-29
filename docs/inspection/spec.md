# 營運巡檢（modules/inspection）— 規格

版本：v1 / 2026-10-27　狀態：本機可測版，等 Eason 試用後上線

## 0. 緣起與決定

舊站 `Eason0728/mala-inspection`（https://eason0728.github.io/mala-inspection/）2026-09-02 上線，
後端 Apps Script 有部署，但到 2026-10-27 **0 筆資料**、通行碼仍是預設 1688 且後端網址在公開 repo。
Eason 2026-10-27 在確認頁回答（https://claude.ai/artifact/FrnJiNgcDTvDa5qS9RVfja）：

| 題 | 決定 |
|---|---|
| 1 | A：照現成搬（四張表、算分、拍照、報告），一組通行碼改成管理系統帳號 |
| 2 | A：與營運稽核並存（稽核＝合規是非題、會計做；巡檢＝品質評分、主管做） |
| 3 | A：依職稱分（見 §2） |
| 4 | **B：全集團都開**；菜色題之後各品牌再補 |
| 5 | A：搬好試過後，舊網址換搬家頁、換掉通行碼 |
| 追加 | 2026-10-27：「小辛辣的題目使用預設，墨竹亭的題目先空白並開放可以自行新增題目」→ 新增「題目設定」分頁；一悟比照墨竹亭（先空白，Eason 沒指定，可改） |

## 1. 架構

- 原生模組（不嵌 iframe）：`modules/inspection/`，ns／backend＝platform，dept `ops`（營運部門，排在門市營運後）。
- 後端：`apps-script/platform/Inspect.gs`（平台後端，正本在 Mac mini）。舊 Apps Script 後端不用了（0 筆資料，不搬資料）。
- 資料：分頁 `insp_records` 一次巡檢一列（answers／summary 存 JSON、bank_ver 記題庫版本）。
- 照片：沿用表單簽核的照片庫（mini `apv-files`、`/platform/svc/apv-file-put|get`、kind receipt、JPEG ≤180KB、每晚異機備份）。
  送出時綁 form_id `INSP:<巡檢編號>`；`Approvals.gs apvFileAccess_` 對 `INSP:` 開頭轉給 `inspFileCanView_`＝看得到那筆巡檢才看得到照片。
  ⚠ 依賴表單簽核已初始化（正式環境 2026-10-18 已初始化）。系統管理者帳號（沒有同仁身分）不能附照片。
- 算分在前端（`scoring.js`，逐條照舊站 spec §4，D1–D3 定案不變）；送出存「當下算好的摘要」＋**當下的題目快照**（records.forms），題目改版不回頭改舊報告。
- 題目：分頁 `insp_bank` 一品牌一列（forms JSON、ver＝`<品牌>-v<n>`）；沒存過＝前端預設（`questions.js defaultForms`：小辛辣＝舊站原題，墨竹亭、一悟＝空白）。開始巡檢時讀一次、跟著草稿存（填到一半有人改題目也對得上）。

## 2. 權限（PERM_GRANTABLE 加四碼，不鎖碼）

| 權限碼 | 意思 | 預設給誰（`INSP_PERM_DEFAULT_RULES`，admin 按「初始化營運巡檢」補進 perm_map） |
|---|---|---|
| `platform.insp-all` | 看全集團門市 | 總部營運部全部職稱、執行長／總經理／董事長 |
| `platform.insp-brand` | 看自己品牌的門市 | 品牌辦公室總監、區督導 |
| `platform.insp-own` | 只看自己那家店 | 門市店長、區經理 |
| `platform.insp-do` | 可以巡檢（只能巡上面看得到的店） | 營運部、品牌總監、區督導、區經理 |
| `platform.insp-bank` | 題目設定（有 insp-all＝三個品牌，否則只有自己品牌） | 營運部全部職稱、品牌總監 |

- 可巡檢門市＝org 裡 ladder store、啟用、品牌是 mzt／mala／yiwu（不含中央工廠、停用店）。
- 作廢（打錯店、測試資料）：**2026-10-30 起改看獨立權限碼 `platform.insp-void`**（預設規則只給總部營運部全部職稱；不鎖碼，人資可在權限設定開給別人）與 admin。執行長以上有 `insp-all` 只看不作廢。作廢後該筆與照片只有 insp-void／admin 看得到。
- 區督導目前看整個品牌（不依區域裁切）；要改成只看自己區，改 `inspScopeOf_` 用 `regionIndexLive_`。

## 3. 題庫

- 小辛辣：沒存過時用舊站原題（89 題）；存過後用存的版本。
- 墨竹亭、一悟：預設空白；沒有題目時「開始巡檢」會提示找營運部或品牌總監。
- 題目設定（`views/bank.js`）：四張表固定，每張表可加「評分分類」（有權重，加總 100%）、「加分項分類」、「加重扣分分類」；
  題目可改字、改種類（0～5 分／重大缺失／只有 0 或 5／打勾加分／自由填寫加分／勾選扣總分）、上下移、刪除；存檔要帶目前版本號，別人剛改過會擋下。
- 後端 `inspCleanForms_` 檢查：四張表順序、分類代號不重複、權重 1%～100% 且加總 100%、題目不可空白、分數 1～20、自由填寫最多 1～10 項、全部 ≤300 題。

## 4. actions（Code.gs 白名單＋分派；讀取三支列 dryrun.js READ_ACTIONS，上線時也要列 minikit app.json readActions）

| action | 讀／寫 | 說明 |
|---|---|---|
| inspMe | 讀 | 可看的店、可巡的店、能否附照片、是否已初始化 |
| inspList | 讀 | {unit?, month?, include_void?} 新到舊，最多 300 筆 |
| inspGet | 讀 | {id} 含作答與照片檔號 |
| inspSubmit | 寫 | {id(INS-…), unit, date, bank_ver, answers, summary, files}；同編號重送＝回原筆 |
| inspVoid | 寫 | {id} 作廢 |
| inspSetup | 寫 | admin：建分頁（insp_records、insp_bank）＋補預設規則（14 條） |
| inspBankGet | 讀 | {brand}；看得到該品牌門市或能設定的人可讀；沒存過回 forms:null |
| inspBankSave | 寫 | {brand, forms, expected_ver}；回新 ver |

## 5. 測試

- `node test/inspection.mock.test.mjs`（70 項：算分、manifest、範圍、照片權限、重送、作廢、題目設定與快照）。
- `python3 test/e2e/e2e_t19_inspection.py`（資料帶入：每次隨機門市、分數、墨竹亭自訂題目，Python 獨立算預期；`E2E_SEED=` 重現；48–50 項＋按鈕稽核）。
- 本機試用：`test/e2e/inspect_backend.mjs`（PORT 預設 8840）＋前端複本 config 指過去。

## 6. 上線步驟（Eason 試用 OK 之後）

1. dzy 分兩段推 main（同績效評核做法）：第一段只有 `Inspect.gs`、`Code.gs`、`Approvals.gs`、`Perms.gs`、`dryrun.js`、測試。
2. minikit：`apps/dzy-platform/app.json` gas／gasSource 加 `Inspect.gs`、readActions 加 `inspMe／inspList／inspGet／inspBankGet`；
   只套這幾個檔的差異（不要整包 sync-gas）；mini pull＋重啟 dzy-platform。
3. 第二段推 registry＋模組＋圖示 → admin 開「營運巡檢」按「初始化營運巡檢」。
4. 舊站 mala-inspection 換搬家頁；舊 Apps Script 通行碼換成隨機長碼（或停用部署）。

## 7. 2026-10-30 Eason 照推薦（三題）

- **加分題封頂**：每張表加分總額上限 **+20**（`modules/inspection/scoring.js` `BONUS_CAP`，`computeBonus` 回 `{total（封頂後）, raw, capped}`）。題目設定頁說明文字寫明上限，且一張表全部加分題可拿的總分 > 40（上限兩倍＝明顯超額）前端 `check()` 與後端 `inspCleanForms_`（`INSP_BONUS_MAX_POSSIBLE`）都擋 `bad_request`。舊報告存的 summary 不重算。
- **作廢巡檢改獨立權限碼**：見下一節（本檔 §8，與 §2 表合併閱讀）。
- **分數捨入**：維持舊站／scoring.js 的 `Math.round(x*10)/10`（各表不先四捨五入；68.95 在浮點裡是 689.4999…→ 68.9）。測試 oracle（test/dd/ops_inspection.mjs、test/e2e/dd_ops_inspection.py）原本用 `floor(x*10+0.5+1e-9)` 才會算成 69，已改成同一套。

## 8. 作廢巡檢權限碼 `platform.insp-void`（2026-10-30 Eason 照推薦）

- `Perms.gs PERM_GRANTABLE` 加第 29 碼 `platform.insp-void`（中文「營運巡檢：作廢巡檢」），**不鎖碼**。
- `Inspect.gs INSP_PERM_DEFAULT_RULES` 加一條 `hq / ops / * → platform.insp-void`（與 insp-all 營運部那條同範圍）。
- `inspScopeOf_().canVoid = admin 或 hasPerm(platform.insp-void)`；`inspVoid`、`inspGet`／`inspList include_void` 看作廢報告、`inspFileCanView_` 看作廢報告的照片，全部跟著 canVoid。
- 前端 `modules/perms/lib.js FEATURE_ORDER／FEATURE_NAMES／FEATURE_DESC` 同步加碼；清單頁「作廢這筆」鈕照舊看 `inspMe.can_void`。
- **上線後 admin 要再按一次「營運巡檢 → 初始化營運巡檢」（inspSetup）**：正式環境 perm_map 已初始化，新預設規則不會自動生效；inspSetup 只補 perm_map 裡還沒有的同一條（ladder／dept／title／perm 都相同就跳過）、不覆蓋、可重按（test/inspection.mock.test.mjs 3d「再按一次不重複補」）。
- minikit：readActions 不用改（inspVoid 是寫入、本來就不在 readActions；沒有新 action）。只需同步 `Perms.gs`、`Inspect.gs` 到 gas/。

### 8.1 對抗驗證補強（2026-10-30）
- 作廢也受「看得到的店」限制：`handleInspVoid_` 找到那筆後 `!c.isAdmin && !c.scope.view[unit]` → `not_found`（美村店長就算拿到 insp-void 也不能作廢光復的；admin 全部）。
- 加分文字：`summaryOf` 的 `forms[]` 多存 `bonus`（封頂後實際算進分數的加分；後端 `inspCleanSummary_` 原樣收 0～999 整數）。報告頁同一列的「加分 ＋N」用存檔 bonus；封頂前送出的舊報告沒存 bonus → 用現算 raw（當時沒封頂，分數就是含 raw），避免與分數欄矛盾。

