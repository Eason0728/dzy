# 規格：管理系統 LINE 認身分（核心＋B 重設密碼＋C 一鍵開通）
版本：v1.0 / 2026-10-25（Eason 確認：S1–S3 皆推薦）｜需求正本：requirements.md v1.0

## 0. Eason 的決定（2026-10-25，三題皆推薦）
- S1 職稱：LINE 開通（免審）只開放計時人員 pt／正職人員 ft；其他職稱回 need_review 導原認領流程
- S2 單位：自動帶打卡主店（storeHomeFn_ 判定的唯一主店）、不能改；沒有唯一主店＝need_review
- S3 六店打卡程式在 LINE 打卡成功時寫 roster.line_ok_at（不採「任何成功打卡」）

## 1. 架構總覽
```
同仁手機 LINE ──LIFF 小頁面（dzy.mozhuting.com/line.html）
   │ id token
   ▼
Mac mini dzy-platform node 路由 /platform/svc/line-auth
   │ ① 向 LINE 驗 id token（client_id 2011292256）→ userId
   │ ② line_h = HMAC-SHA256(LINE_MAP_KEY, userId)
   │ ③ 呼叫平台 GAS 全域函式（不進 Code.gs 分派表）
   ▼
平台資料（staff_clock 新三欄 ← 每晚 00:10 同步 ← 六店 svc_roster 新三欄）
```
原始 LINE userId 只在 mini 記憶體裡一瞬間，不落盤、不進 log、不進試算表。

## 2. 打卡端（六店 Liff.js＋SvcStaff.js，各自部署）
- roster 新欄 `line_ok_at`（台北 ISO 字串）：`liff_punch` 寫入 events 成功（status ok）後寫一格；寫失敗吞掉、不影響打卡回應。
- 綁定（liff_bind）與解綁（mgr_line_unbind）時清空 `line_ok_at`，讓重綁重新計算。`line_bound_at` 現況就是「這次綁定的時間」（重綁覆蓋、解綁清空），直接沿用。
- `svc_roster` 每列多回：`line_h`（Script Property `LINE_MAP_KEY` 未設或沒綁＝空字串）、`line_bound_at`、`line_ok_at`。原始 userId 不回。
- 六店 `LINE_MAP_KEY` 同一把（≥32 字），與 mini `.env LINE_MAP_KEY` 相同。舊版平台不認新欄位＝自動忽略，所以打卡端可先上。
- 光復 LineHub.js：文字「開通管理系統」「重設密碼」→ 回覆（reply，不吃額度）一張卡片，按鈕連 `https://liff.line.me/<新 LIFF ID>?m=claim|reset`。

## 3. 平台資料（~/dzy/apps-script/platform）
- `staff_clock` 表頭追加 `line_h`、`line_bound_at`、`line_ok_at`（CLK_MAP_HEADERS 尾端；clkSave_ 依表頭整列寫，既有分頁表頭要自動補欄，比照 CLK_STAFF_EXTRA 做法）。
- `clockRosterApply_` 每晚把 svc_roster 三欄寫進對應的 staff_clock 列。
- **可信綁定**（純函式 `lineTrust_(row, nowMs)`）：state=confirmed 且 roster_active≠FALSE 且 line_h 非空 且 now − line_bound_at ≥ 7 天 且 line_ok_at > line_bound_at。
- **找人**：line_h 在 staff_clock 對到的 emp_no 去重後恰好 1 位才算；0＝not_bound、≥2＝ambiguous。同一人多店綁定任一店可信即可。

## 4. 平台 GAS 全域函式（只給 mini 路由呼叫，不准進 Code.gs 分派表）
| 函式 | 輸入 | 回傳／動作 |
|---|---|---|
| `lineAuthCheck_(lineH, nowMs)` | line_h | `{mode, name, emp_no, unit_name, title_options, days_left}`；mode＝claim／reset／not_bound／not_trusted／ambiguous／blocked（disabled、pending、rejected） |
| `lineAuthReset_(lineH, newPw, nowMs)` | 新密碼 | 重查 check＝reset → 驗密碼規則 → 寫 salt/hash、setTokenAfter_、clearLoginState_、清忘記密碼鎖 → staff_log `line_reset_ok` |
| `lineAuthClaim_(lineH, form, nowMs)` | 手機、生日、地址、職稱、新密碼 | 重查 check＝claim → 驗欄位（同 claimSubmit）→ 單位＝主店單位（S2）、職稱限 pt／ft（S1）→ 寫 p_* 後走與 handleStaffConfirm_ 相同的核准副作用（stfApplyConfirm_、stfSave_、stfPruneExtraDept_、permAuditStaffChange_、clkAfterConfirm_），actor＝`line-self` → 寫 users salt/hash → staff_log `line_claim_ok` |
- 職稱若不在允許清單→ 回 `need_review`，前端改導原認領流程。
- 失敗原因寫 staff_log `line_fail`（只寫原因代碼，不寫個資）。

## 5. Mac mini 路由 `/platform/svc/line-auth`（minikit apps/dzy-platform，新檔 lineauth.js，照 jobs.js autoSupport 掛法）
- POST JSON `{op: 'check'|'reset'|'claim', id_token, ...}`，text/plain。
- node 端 `POST https://api.line.me/oauth2/v2.1/verify`（id_token＋client_id），驗 aud＝2011292256、exp 未過；失敗回 `invalid_token`。
- 限流：同來源 IP 每 10 分鐘 30 次；同 line_h 每天 reset＋claim 共 5 次。
- 回應只含 check 回傳的欄位；log 不印 id_token、userId、line_h。
- `.env`：`LINE_MAP_KEY`、`LINE_CHANNEL_ID=2011292256`；app.json props／backupExclude 照既有金鑰做法。
- 未確認：kit 路由是否允許瀏覽器跨網域呼叫（CORS）。任務 1 先驗；不行就改走 /platform/api 代轉同一組全域函式（由 node hook 先驗 token）。

## 6. 前端（~/dzy）
- 新頁 `line.html`＋`platform/views/line-auth.js`（登入前、不進殼）：liff.init → getIDToken → check → 依 mode 畫「開通表單」「重設表單」或說明（not_trusted 顯示還要等幾天、not_bound 說明去綁 LINE 打卡或用原方式）。
- 登入頁加兩顆按鈕「用 LINE 開通」「用 LINE 重設密碼」，連 `https://liff.line.me/<LIFF ID>?m=claim|reset`。
- 同仁名單詳細頁：顯示最近一次 LINE 開通／重設時間（讀 staff_log）。
- LIFF SDK 從 static.line-scdn.net 載入（佈告欄同做法）。

## 7. 部署順序
1. 六店打卡端（新欄位、svc_roster 新回傳、LineHub 關鍵字）＋設 LINE_MAP_KEY
2. mini：.env 金鑰＋平台 GAS（只套自己的改動，不整包 sync）＋lineauth.js → 重啟 → 強制重跑當晚同步
3. Eason 建 LIFF app（channel 2011292256，endpoint `https://dzy.mozhuting.com/line.html`）
4. dzy 前端 push（line.html＋登入頁按鈕）
5. line_ok_at 從打卡端上線才開始記＝上線當天無人符合；綁定已滿 7 天的人上線後用 LINE 打一次卡，隔天 00:10 同步後即可用；新綁的人滿 7 天且其間 LINE 打過卡才可用。

## 8. 測試
- node：lineTrust_ 邊界（剛好 7 天、line_ok_at 等於 bound_at、解綁）、ambiguous、職稱擋、核准副作用與 handleStaffConfirm_ 一致、全域函式不在分派表（比照 proxyAuthorize_ 測試）、log 不含 userId。
- minikit：lineauth.js 假 LINE 驗證伺服器、限流、金鑰缺時拒絕。
- e2e：line.html 以假 LIFF 跑 claim／reset／not_trusted 三條。
- 上線前關：Fable＋GPT 互盲審（寫外部系統＋權限）。
