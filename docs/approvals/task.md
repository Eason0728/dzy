# 任務清單：管理系統第三期表單簽核

每個任務 100–200 行程式碼內；契約一律照 plan.md「共用契約」。驗收要貼「實際指令＋輸出」。

## P0 探
### T0-1 備份端能不能收圖（只讀不寫正式資料）
- 輸入：minikit `kit/lib/backup.js`、通用備份端程式（`BACKUP_URL` 指向的那支，grep minikit 文件找原始碼）。
- 輸出：`docs/approvals/progress.md` 加一節「照片備份探測」：能／不能、單檔上限、怎麼呼叫。不准實打寫入；讀不出來寫「未確認」交 Eason。
### T0-2 通知匣 from 清單加「表單簽核」
- 輸入：`~/mala-notify-inbox/docs/spec.md:98-109`。輸出：清單加一列（文件＋GAS 若有白名單）。驗收：`grep -n 表單簽核` 兩處命中。

## P1 後端核心（apps-script/platform/）
### T1-1 ApprovalRoute.gs：權限表比對與驗證（純函式）
- `apvPickRow_(rows, amount)` → 該列；`apvValidateTable_(rows)` → `{ok}`／`{ok:false,error}`（金額嚴格遞增、只有最後一列 max 空、role 合法、至少一列）。
- 驗收：`test/apv-route.test.mjs` 邊界 0／5000／5001／10000／10001／30000／30001／999999。
### T1-2 ApprovalRoute.gs：找權限人與往上
- `apvResolveStep_(step, ctx)` → 能簽的 DZY 編號陣列；`apvBuildRoute_(form, sender, table, org, staff)` → route_json；`apvAdvance_(form, ...)` → 下一關或 handling（含 skip、自己不能簽、全空交人資）。
- 驗收：四例子（800 店長／8,600 小辛辣總監／25,000 總經理／42,000 董事長）、總部 8,000→部門主管、ck 8,000→執行長、店長送 3,000→品牌總監、總監空缺→執行長、全空→人資。
### T1-3 Approvals.gs：資料表與 setup、權限表 get/save
- `setupApprovals()` 建 apv_forms／apv_events／apv_files／apv_thresholds／apv_threshold_log（只補不覆蓋，表頭不一致停）、寫預設四列。
- `apvThresholdGet`、`apvThresholdSave`（role admin、寫 log、回 diff）。
- 驗收：mock 測試非 admin 403、存不合法表被擋、log 有前後值。
### T1-4 Approvals.gs：送出、退回再送、撤回
- `apvSubmit`／`apvResubmit`／`apvWithdraw`／`apvRoutePreview`；三種 body 驗證（spec §4）；人事單送件資格；單號流水（同一把鎖內取號）。
- 驗收：請款沒照片被擋、請購金額自動算、一般同仁送別人的人事單被擋、撤回只在無人核准時。
### T1-5 Approvals.gs：簽核、承辦、改派、本人簽名
- `apvDecide`／`apvHandle`／`apvReassign`／`apvSign`；每一步寫 apv_events。
- 驗收：沒資格的人核准 403、退回沒原因被擋、承辦只限該部門（含兼任）、改派只限 platform.staff。
### T1-6 Approvals.gs：查詢與匯出
- `apvMine`／`apvTodo`（含 overdue 旗標 ≥72h）／`apvGet`（看得到誰的規則 spec §6）／`apvList`／`apvExport`。
- 驗收：看不到別人的單（直接打 action 也拿不到）、人事單薪資只給路線上的人與人資、匯出加總正確。
### T1-7 Code.gs 接線
- 白名單、MUTATING_ACTIONS、switch case；`platform/dryrun.js READ_ACTIONS` 補讀取 action。
- 驗收：既有全部測試＋新測試綠；`test/proxy-authorize.test.mjs` 仍綠。

## P2 照片與排程（~/dzy-minikit/apps/dzy-platform/jobs.js ＋ .gs 全域函式）
### T2-1 .gs 端：apvFileAuthorize_、apvFileRegister_、apvFileCanRead_、apvFileSweep_、apvDigest_
- 驗收：mock 測試每支的正反向；digest 超過 1000 字截斷「…另 N 張」。
### T2-2 jobs.js：照片 put／get 路由
- JPEG 檔頭、≤180 KB、每人每天 60 張、檔案權限 600、log 過 scrub。
- 驗收：`test/apps/` 新測試；本機起平台用 curl 上傳讀回 sha256 相同。
### T2-3 jobs.js：每日 09:50 彙整送通知匣、03:50 照片備份、孤兒清除、health
- 照 T0-1 結果決定備份做法。重試到 10:30；連兩天失敗 health warn。
- 驗收：假通知匣端點測試送出 body 正確；沒卡關不送。

## P3 前端（modules/approvals）
### T3-1 manifest、index、registry 一行、選單圖示（tools/make-icons.py 加一列）
### T3-2 送單：三種表單畫面＋草稿（`dzy.u.<id>.apv_draft_<type>`）
### T3-3 照片壓縮上傳元件（長邊 1600、JPEG，>180 KB 降畫質，最多 5 張，縮圖）
### T3-4 路線預覽＋送出；我的單（狀態、卡在誰、退回原因、改完再送、撤回）
### T3-5 待我簽、待我辦（卡片、照片大圖、核准／退回／已處理）、離職本人簽名（ctx.ui.signaturePad）
### T3-6 全部單據（篩選、改派、匯出 CSV UTF-8 BOM）
### T3-7 核決權限設定頁（Eason 表格樣式：金額輸入、權限人點選、門市／總部兩排、新增／刪除一級、儲存前 diff）
### T3-8 首頁 alerts（待我簽 N、待我辦 N、卡 3 天紅色）
- P3 每個畫面任務的驗收都包含「從入口點得到」（不是檔案存在就算），並在真瀏覽器點一次。

## P4 整合關
### T4-1 minikit app.json（gas／gasSource／readActions）、`sync-gas.sh dzy-platform`、套件測試數字
### T4-2 e2e：送 8,600 請款含照片 → 總監核准 → 財務已處理；退回再送；權限表新增一級；手機寬度
### T4-3 上線前雙審（Fable＋GPT 互盲，三塊高風險）→ 修完
### T4-4 裁判腳本：四例子＋邊界金額＋空缺，輸出對照表

## P5 上線
### T5-1 給 mini 的交辦（直接貼對話）：同步、setupApprovals、.env 填 NOTIFY_INBOX_*（Eason）、外網驗證
### T5-2 推前端；BOSS dryrun 走四例子；一張真的小額請款
### T5-3 落地清單八項（progress.md）
