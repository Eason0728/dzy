# 任務清單：管理系統 LINE 認身分
依據 plan.md v0.1。每個任務 100–200 行以內；驗收要附實際指令與輸出。

## P1 打卡端（mala-clock-in，分支 line-auth）
- **T1-1 line_ok_at 寫入與清空**（Liff.gs／Liff.js）
  - 輸入：liff_punch 成功（events 寫入 status ok）、liff_bind、mgr_line_unbind
  - 輸出：roster 欄 line_ok_at（缺欄自動補表頭）；bind／unbind 清空；寫失敗不影響回應
  - 驗收：tests/line-ok-at.test.js（成功寫、被擋不寫、bind 清、unbind 清、寫失敗打卡照常）全綠；既有測試全綠
- **T1-2 svc_roster 三新欄**（SvcStaff.gs）
  - 輸出：line_h（LINE_MAP_KEY 未設＝空）、line_bound_at、line_ok_at
  - 驗收：tests/svc-roster-line.test.js 用 fixture 向量比對 line_h；未綁三欄空字串；回應不含原始 userId
- **T1-3 LineHub 關鍵字**（LineHub.gs，只光復）
  - 輸入：文字「開通管理系統」「重設密碼」
  - 輸出：reply 一張按鈕卡片（LIFF 網址由 Script Property `DZY_LINE_LIFF_URL`，未設＝回「準備中」）
  - 驗收：tests/linehub-dzy-keyword.test.js；不呼叫 push API
- **T1-4 六店部署補丁**：照 patch_direct.py 形狀做 check／deploy 腳本（三方比對、只換 Liff.js／SvcStaff.js／光復 LineHub.js、拉回逐檔比）；先在暫存目錄套補丁驗 node --check

## P2 平台後端（dzy，分支 line-auth）
- **T2-1 staff_clock 三新欄**：CLK_MAP_HEADERS 尾端加欄＋既有分頁自動補表頭；clockRosterApply_ 寫入
  - 驗收：test/staff-clock.mock.test.mjs 新段落（舊表頭自動補、三欄寫入、舊版 svc_roster 沒有新鍵時寫空不報錯）
- **T2-2 lineTrust_＋找人**：純函式
  - 驗收：test/line-auth.test.mjs（剛好 7 天、差 1 秒、ok_at＝bound_at、ok_at 空、未 confirmed、roster_active FALSE、兩人同 line_h＝ambiguous、多店一店可信即可）
- **T2-3 lineAuthCheck_**：回 mode 與畫面要的欄位（姓名、編號、主店單位名、可選職稱 pt／ft、days_left）
  - 驗收：各 mode 各一案；blocked 涵蓋 disabled／pending／rejected；無唯一主店＝need_review
- **T2-4 lineAuthReset_**：重查＋密碼規則＋salt/hash＋token_after＋清鎖＋staff_log
  - 驗收：重設後舊 token 失效、新密碼可登入、忘記密碼鎖清掉、staff_log line_reset_ok、非 reset mode 拒絕
- **T2-5 lineAuthClaim_**：抽出 handleStaffConfirm_ 的核准副作用成共用函式 stfConfirmEffects_，兩路共用
  - 驗收：LINE 開通與「認領＋主管核准」產生的 staff 列（除 actor／時間）逐欄相同；職稱非 pt／ft＝need_review；單位不可改；分派表不含 lineAuth*（比照 proxy-authorize 測試）；既有 staff*.mock 全綠

## P3 Mac mini（dzy-minikit，分支 line-auth）
- **T3-0 CORS 探針**：kit 路由能否被 dzy.mozhuting.com 瀏覽器呼叫（本機 runner＋devserver 實測）；結論寫進 spec §5
- **T3-1 lineauth.js**：LINE 驗證（可注入假伺服器）、HMAC、限流（IP 10 分 30 次、line_h 每天 5 次）、呼叫 gas 全域函式；掛 routes
  - 驗收：test/apps/lineauth.test.js（假 token 拒、aud 錯拒、exp 過拒、限流 429、金鑰缺回 server_error、log 不含 token／userId／line_h）
- **T3-2 設定**：app.json props `LINE_MAP_KEY`、`LINE_CHANNEL_ID`、gas 清單；backupExclude 不需要（金鑰在 .env）；只套自己的 gas 改動＋SOURCE.sha256 那幾行
  - 驗收：minikit npm test（mini 上固定 7 項環境失敗以外全綠）；gas 雜湊與 dzy 分支逐字相同

## P4 前端（dzy）
- **T4-1 line.html＋views/line-auth.js**：LIFF init、check、三種畫面（開通、重設、說明），沿用 claim.js／forgot.js 的欄位元件與密碼規則
  - 驗收：test/line-auth-front.test.mjs（各 mode 畫面、錯誤代碼中文）
- **T4-2 登入頁兩按鈕＋同仁名單紀錄**：LIFF 網址設定在 platform/config.js（未設＝按鈕不顯示）
  - 驗收：e2e 新支 t14（假 LIFF＋假 mini：開通、重設、not_trusted 三條）；既有 e2e 全部通過（看 exit code）

## P5 上線
- **T5-1 上線前審**：Fable＋GPT 互盲，只審權限／寫外部系統；兩邊都挑到直接修
- **T5-2 部署**（spec §7 順序）＋給 Eason 的 LIFF 建立步驟、mini 交辦（zsh read -rs 寫法）
- **T5-3 落地清單**八項＋dzy-admin、mala-clock-in skill 更新＋記憶
