# 規格：管理系統第三期表單簽核

版本：v1.1 / 2026-10-18（Eason 已確認：權限表照他的「門店支出」表、只給權限人簽、營運主管＝品牌總監、總部店長換部門主管、四題照推薦）
上游：`requirements.md` v1.1。契約沿用 `~/dzy/docs/spec.md §4`（manifest、權限碼、回傳形狀、ctx），本檔不重抄。

## 0. 探到、會改變設計的四件事
| 事實 | 證據 | 設計因此 |
|---|---|---|
| mini 平台後端啟動時把**整個資料庫載進記憶體** | `~/dzy-minikit/kit/gasshim/sheets.js` load()（約 218 行） | 照片**不能**存進資料表（會吃記憶體），改存成磁碟檔案，資料表只記檔名 |
| .gs 裡 `UrlFetchApp`、`DriveApp` 被擋 | `kit/gasshim/services.js:15` | 寫檔、通知匣都放 Node 端 `jobs.js`（跟名單同步員同一支） |
| 請求本體上限 256 KB | `kit/runner/server.js:38` MAX_BODY | 手機端先壓縮，一次傳一張 ≤ 180 KB |
| jobs 可掛本機路由 `POST /platform/svc/<名>` | `server.js:427`、`jobs.js` auto-support | 照片上傳／讀取走 svc 路由，**不改 kit** |

## 1. 架構總覽
```
手機（dzy 前端 modules/approvals）
   ├─ POST /platform/api     ── 表單、簽核、門檻（.gs：Approvals.gs、ApprovalRoute.gs）
   └─ POST /platform/svc/apv-file-put|get ── 照片（jobs.js → 驗身分 runGas('apvFileAuthorize_') → 讀寫磁碟）
Mac mini dzy-platform
   ├─ 資料表 apv_*（SQLite，03:40 隨既有備份）
   ├─ 照片 ~/dzy-platform-data/apv-files/YYYY/MM/<檔號>.jpg（每日另備份，見 §8）
   └─ jobs.js 每天 09:50 → runGas('apvDigest_') → POST 通知匣（10:00 彙整發給 Eason）
```
- 前端新模組 `modules/approvals`：`dept` 不填（排在首頁下，所有人都會用）；`platform/` 只動 `registry.js` 一行（分層規矩）。
- 後端新檔 `Approvals.gs`（action handler）、`ApprovalRoute.gs`（純函式：路線計算、門檻比對，方便單元測試）。
  兩檔都要列進 minikit `app.json` 的 `gas`／`gasSource`；讀取 action 列進 `readActions` ＋ `platform/dryrun.js READ_ACTIONS`。

## 2. 資料表（新分頁，setupApprovals 只補不覆蓋）
### apv_forms（一張單一列）
| 欄 | 說明 |
|---|---|
| id | 單號，格式**逐字**：`APV-` ＋ 台北日期 `YYMMDD` ＋ `-` ＋ 當天三位流水，例 `APV-261018-001` |
| type | `purchase` 請購／`expense` 請款／`personnel` 人事異動 |
| status | 見 §3 |
| sender | 送件人 DZY 編號 |
| unit | 送件時的單位代碼（快照） |
| subject | 人事異動的對象 DZY 編號；其他空 |
| amount | 整數元（請購＝明細加總；請款＝金額；人事空） |
| body_json | 表單內容（§4） |
| route_json | 路線快照（§5.4） |
| step | 目前在第幾關（0 起算）；結案後空 |
| step_at | 進入目前這關的時間（毫秒）→ 算卡關 |
| handler_dept | 承辦部門代碼 `fin`／`pur`／`hr` |
| created_at／updated_at | 毫秒 |
| rev | 第幾版（退回改完再送 +1） |

### apv_events（只追加，不改不刪）
`at, form_id, rev, actor, action, note`；action＝submit／approve／reject／skip（空缺跳過）／reassign／withdraw／handle／sign。
note 不寫個資（退回原因、承辦備註本來就要給送件人看，例外允許）。

### apv_files（照片的帳，不放照片本身）
`id（F＋時間戳36進位＋4碼亂數）, owner, form_id（未綁定＝空）, path, bytes, sha256, created_at`。
未綁定超過 24 小時的檔由 jobs 每日清掉。

### apv_thresholds（核決權限表；Eason 2026-10-18 給的「門店支出」表）
`form_type, seq, max_amount, store_role, hq_role`；`max_amount` 空＝「以上全部」，每張表只能最後一列空，金額嚴格遞增。
role 代碼（權限人）：`head` 單位主管（門市＝店長；總部＝部門主管；中央工廠＝ck 店長）／`brand_dir` 營運主管＝**該品牌辦公室總監**／`ceo` 執行長／`gm` 總經理／`chair` 董事長。
### apv_threshold_log
`at, actor, form_type, before_json, after_json`。

預設值（上線時 setup 寫入；請購、請款共用這一張，form_type 固定 `spend`）：
| seq | 金額 | 門市權限人 store_role | 總部權限人 hq_role |
|---|---|---|---|
| 1 | 0～5,000 | head 店長 | head 部門主管 |
| 2 | 5,001～10,000 | brand_dir 營運主管（品牌總監） | head 部門主管（總部沒有品牌總監，**替 Eason 先定，待他看**） |
| 3 | 10,001～30,000 | gm 總經理 | gm 總經理 |
| 4 | 30,001 以上 | chair 董事長 | chair 董事長 |

## 3. 狀態
```
送出 → signing（第 step 關）──全部簽完──→ handling（承辦部門）──已處理──→ done
          │  退回（要寫原因）                                  
          └→ rejected ──送件人修改再送（rev+1，路線重算，從第一關）──→ signing
signing 且還沒有任何人核准 → 送件人可撤回 → withdrawn
```
- 人資可在 signing 時「改派」目前這關給指定的人（寫 reassign 事件）。
- 卡關＝`status=signing|handling` 且 `現在 − step_at ≥ 72 小時`。

## 4. 三種表單的 body_json
| 表單 | 欄位（必填打 *） | 檢查 |
|---|---|---|
| purchase | items*［{name*, qty*, unit*, price*}］≤ 30 列、vendor、purpose*、need_date*、files［檔號］≤ 5 | amount＝Σqty×price，四捨五入到元，> 0 |
| expense | spend_date*、category*（設備維修／食材臨時採購／雜支／交通／文具耗材／其他）、amount*、desc*、payee*（`self` 還代墊的人／`vendor`＋vendor_name）、purchase_id（選填，要是自己單位已結案的請購單）、files* ≥ 1 ≤ 5 | 收據至少一張 |
| personnel | kind*（`leave` 離職／`transfer` 調職／`raise` 調薪）、effective*、from{unit,title,pay}、to{unit,title,pay}、reason*、sign_png（離職本人簽名） | 調薪的 pay 是數字；調職的 to.unit 要是啟用中單位 |

離職單本人簽名：送件人＝本人 → 送出時簽；送件人是主管 → 路線第一關插入「本人確認簽名」（對象沒開通帳號 → 主管改附紙本簽名照片，files ≥ 1）。

## 5. 路線怎麼算（ApprovalRoute.gs，純函式）
### 5.1 只給權限人簽（Eason 2026-10-18 選「只給權限人簽」）
- 請購、請款：查核決權限表，金額落在哪一列，**就只有那一列的權限人簽一關**，中間的人不經手。
  例：光復同仁請款 800 → 光復店長；8,600 → 小辛辣總監；25,000 → 總經理；42,000 → 董事長。
- 送件人單位決定用 store_role 還是 hq_role：門市、中央工廠、品牌辦公室用 store_role；總部各部門用 hq_role。
- 人事異動：對象同仁的上一層主管（沿用 stfReviewNeed_ 那套「只往上一層」）一關 → 人資承辦；調薪一律由總經理簽。

### 5.2 找不到權限人時（往右一格）
權限人順序（由低到高）：head → brand_dir → ceo → gm → chair。
1. 「誰是權限人」在**輪到那關時**才找：head＝同單位 sm（總部：同主要部門 hm）；brand_dir＝送件人所屬品牌辦公室的 odir；ceo／gm／chair＝全集團該職稱；都要 status active 且已開通。
2. 找不到人（空缺、沒開通、中央工廠沒有品牌總監）→ 寫 skip 事件，往**更高**的下一個權限人找；到董事長都沒人 → 交人資（platform.staff）。
3. 權限人就是送件人自己（例：店長送 3,000 元）→ 自己不能簽，往更高的下一個權限人（品牌總監）。
4. 同一個權限人有多人 → 任一人核准就過。

### 5.3 簽完交承辦
purchase → 採購部 `pur`；expense → 財務部 `fin`；personnel → 人資部 `hr`。承辦人＝主要部門或兼任部門是該部門、status active 的人。

### 5.4 快照
送出當下把「權限表那一列、權限人代碼」存進 route_json；之後改權限表不影響已送出的單（requirements §4）。
「誰能簽」不快照（人會異動），輪到那關才找。

## 6. 後端 action（全部經 Code.gs 白名單；寫入類加進 MUTATING_ACTIONS）
| action | 讀／寫 | 誰能用 | 做什麼 |
|---|---|---|---|
| apvRoutePreview | 讀 | 已開通同仁 | 送出前預覽：會簽到哪幾格、現在各格是誰 |
| apvSubmit | 寫 | 已開通同仁（人事異動：店長以上、人資；一般同仁只能送自己的離職單） | 驗欄位、綁照片、算路線、產單號 |
| apvResubmit | 寫 | 送件人，rejected | 改內容、rev+1、重算路線 |
| apvWithdraw | 寫 | 送件人，signing 且無人核准 | 撤回 |
| apvDecide | 寫 | 目前這關有資格的人 | approve／reject（reject 原因必填） |
| apvSign | 寫 | 離職單對象本人 | 本人確認簽名關 |
| apvHandle | 寫 | 承辦部門的人 | 已處理＋備註 → done |
| apvReassign | 寫 | platform.staff | 改派目前這關 |
| apvMine | 讀 | 本人 | 我送的單 |
| apvTodo | 讀 | 本人 | 待我簽、待我辦（首頁提醒也用這支） |
| apvGet | 讀 | 送件人、簽過的人、目前關卡有資格的人、承辦部門、platform.staff | 單一張單＋事件紀錄 |
| apvList | 讀 | 承辦部門看自己部門的；platform.staff 看全部 | 篩月份／種類／狀態 |
| apvExport | 讀 | 財務部、platform.staff | 某月請購＋請款明細列（前端轉 Excel） |
| apvThresholdGet | 讀 | 已開通同仁（送件預覽要用） | 門檻表 |
| apvThresholdSave | 寫 | **role admin** | 整張表覆寫；檢查金額遞增、最後一列空、權限人代碼合法；寫 log |
| apvDigest_／apvFileAuthorize_／apvFileBind_／apvFileSweep_ | — | 只給 jobs.js（全域函式，**不准**進 Code.gs 分派表） | 彙整、照片驗身分、清孤兒檔 |

- **不新增可指派的權限碼**：送件＝已登入同仁；承辦＝依部門自動判定；門檻＝admin。所以權限設定頁、Perms.gs 九碼都不用動。
- 權限一律後端判；前端藏按鈕只是方便。

## 7. 前端（modules/approvals）
| 分頁 | 誰看得到 | 內容 |
|---|---|---|
| 送單 | 所有已開通同仁 | 選表單 → 填 → 拍照（壓到長邊 1600px、JPEG，超過 180 KB 再降畫質）→ 預覽路線 → 送出 |
| 我的單 | 所有 | 狀態、目前卡在誰、退回原因、改完再送、撤回 |
| 待我簽 | 有待簽單的人 | 卡片：單號、送件人、金額、照片縮圖；核准／退回 |
| 待我辦 | 財務／採購／人資部的人 | 已處理＋備註 |
| 全部單據 | 承辦部門、platform.staff | 篩選、匯出 Excel（財務）、改派（人資） |
| 核決權限 | role admin | 一張表（請購、請款共用），長得像 Eason 的「門店支出」表：每列金額輸入框、權限人用點選（門市、總部各一排）、「新增一級」「刪除」、儲存前顯示「改了什麼」 |

- 首頁 `alerts(ctx)`：「待我簽 N 張」「待我辦 N 張」；有卡超過 3 天的用紅色 level。
- 草稿存 localStorage `dzy.u.<user id>.apv_draft_<type>`（沿用稽核草稿只認本人的規矩）。
- 試跑模式 `?dryrun=1`：寫入全部攔下（新讀取 action 補進 READ_ACTIONS）。
- 匯出：前端把 apvExport 的列轉成 CSV（UTF-8 BOM，Excel 直接開，不另載函式庫）。

## 8. 照片
- 上傳：`POST /platform/svc/apv-file-put` body `{token, mime:'image/jpeg', b64}` → jobs.js 呼叫 `runGas('apvFileAuthorize_', token)` 拿 DZY 編號 → 驗 JPEG 檔頭、≤ 180 KB → 寫 `apv-files/YYYY/MM/<檔號>.jpg`（權限 600）→ `runGas('apvFileRegister_')` 記帳 → 回檔號。
- 讀取：`POST /platform/svc/apv-file-get` `{token, id}` → 驗「看得到這張單」才回 base64。
- 每人每天上傳上限 60 張（防灌爆磁碟）。
- 備份：jobs 每天 03:50 把當天新增的照片送到既有的通用備份端（`BACKUP_URL`）。**通用備份端能不能收圖檔＝未確認**，task 第一項先探；收不了就退而求其次：每天 tar 一份到 `~/dzy-platform-data/apv-backup/`，並在 Eason 決定前標「照片只有本機一份」的風險。

## 9. 通知
- jobs.js 每天 09:50 呼叫 `runGas('apvDigest_')`：取卡超過 3 天的單，組成一則（title「表單簽核：N 張卡關」、text 每張一行「單號｜種類｜卡在誰｜幾天」，≤ 1000 字，超過截斷寫「…另 N 張」）。
- POST 通知匣 `{action:'add', from:'表單簽核', level:'normal', key:'apv-YYYYMMDD'}`；env `NOTIFY_INBOX_URL`／`NOTIFY_INBOX_TOKEN`（Eason 在 mini 填）。通知匣 from 清單要先加「表單簽核」。
- 沒有卡關就不送。送失敗：寫 log、隔 30 分鐘重試到 10:30。
- health()：連續兩天 digest 沒送成功 → warn。

## 10. 安全
- 沿用平台 token（authResolveSession_，每次重查 active）。pending／disabled 同仁一律擋。
- 照片路由只認 token，檔號猜到也拿不到（要過「看得到這張單」）。
- 單號、事件、匯出不放身分證、生日、地址；人事單的薪資只有路線上的人、人資看得到。
- 公開 repo：測試資料一律假名＋假編號。

## 11. 測試
- 純函式 `ApprovalRoute.gs`：權限表比對（四個邊界 5,000／5,001／10,000／10,001／30,000／30,001）、門市與總部兩種權限人、品牌總監依品牌找人、空缺往上、自己不能簽、全空交人資、快照不受改權限表影響——每條至少一個案例，含 §5.1 四個例子。
- mock 後端（照 `test/staff.mock.test.mjs`）：每支 action 的權限正反向、狀態轉移、MUTATING 鎖。
- jobs：照片 put/get 權限、180 KB 上限、JPEG 檔頭、孤兒清除、digest 組字與截斷。
- e2e（Playwright 全 mock）：送 8,600 元請款含照片 → 品牌總監核准 → 財務已處理；退回再送；門檻頁新增一級。
- minikit 套件：`test/runner/dzy-platform.test.js` 的 action 數、readActions 跟著改。

## 12. 部署順序（照 dzy-admin 教訓：先 mini、再前端）
1. mini：通知匣 from 加「表單簽核」；`.env` 填 NOTIFY_INBOX_URL／TOKEN（Eason）。
2. mini：同步新 .gs＋jobs.js → 重啟 → setupApprovals 建表＋預設門檻 → 外網打 apvThresholdGet 確認。
3. 推前端（新模組上架）。
4. Eason 用 BOSS 走一次 §5.1 四個例子（`?dryrun=1` 不寫入；之後用一張真的小額請款）。
回退：前端 `git revert`；後端新 action 沒人呼叫即無影響，資料表保留。

## 13. 刻意不做
自訂表單、代理人、主管 LINE 私訊、跟損益系統自動連動、Excel 檔格式（先 CSV）、照片以外的檔案（PDF）。
