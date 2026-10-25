# 規格：管理系統 LINE 認身分（核心＋B 重設密碼＋C 一鍵開通）
版本：v1.2 / 2026-10-25（**範圍縮小：只做 B 重設密碼，C 一鍵開通取消**；v1.1 為設計審查修正）｜需求正本：requirements.md v1.0

## 0. Eason 的決定（2026-10-25）
- **R3（上線前，最新、優先於下列）：只做 LINE 重設密碼；第一次申請帳號維持原認領流程，不做 LINE 開通。** 實作：前端拿掉開通入口；mini 路由 op／want 為 claim 一律 400 bad_input；GAS lineAuthClaim_ 一律回 off、check want claim 回 off；LineHub 只認「重設密碼」。下文所有 C／claim 相關段落保留作紀錄，但已停用。
- R1（設計審查後）：**LINE 開通恢復主管審核**——LINE 只代填身分（姓名、編號、主店單位），送出後 status＝pending，照現有 unitPending／unitApprove 流程。推翻需求 v1.0 第 2 題「免審」。
- R2（設計審查後）：**LINE 重設維持只看可信綁定，不加生日**。已知風險（GPT #1）：同事冒綁＋打一次卡＋等 7 天可重設已開通帳號；Eason 知情接受。緩解＝§3.2 人資停用鈕、§5 總開關、staff_log 紀錄。
- S1 職稱：LINE 開通只能選 pt／ft；其他職稱導原認領流程（R1 後仍保留，少一個審核時要細看的點）
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
本案新增的部分：原始 LINE userId 只在 mini 記憶體裡一瞬間，不落盤、不進 log、不進平台資料。

## 2. 打卡端（六店 Liff.js＋SvcStaff.js，各自部署）
- roster 新欄 `line_ok_at`（台北 ISO 字串）：LINE 打卡**兩條路**（`liff_punch`，以及光復 line_quick_clock 伺服器對伺服器呼叫的 `liff_clock`）寫入 events 成功（status ok）後，由共用 helper 寫一格；寫失敗吞掉、不影響打卡回應（GPT #9）。
- 綁定（liff_bind）與解綁（mgr_line_unbind）時清空 `line_ok_at`，讓重綁重新計算。`line_bound_at` 現況就是「這次綁定的時間」（重綁覆蓋、解綁清空），直接沿用。
- `svc_roster` 每列多回：`line_h`（Script Property `LINE_MAP_KEY` 未設或沒綁＝空字串）、`line_kid`、`line_bound_at`、`line_ok_at`。原始 userId 不回。
- 資料盤點更正（GPT #12）：打卡端 roster、liff_bind_log 本來就存原始 userId（既有設計，本案不改）；本案新增的平台端只存 line_h。
- 六店 `LINE_MAP_KEY` 同一把（≥32 字），與 mini `.env LINE_MAP_KEY` 相同。舊版平台不認新欄位＝自動忽略，所以打卡端可先上。
- 光復 LineHub.js：文字「開通管理系統」「重設密碼」→ 回覆（reply，不吃額度）一張卡片，按鈕連 `https://liff.line.me/<新 LIFF ID>?m=claim|reset`。

## 3. 平台資料（~/dzy/apps-script/platform）
- `staff_clock` 表頭追加 `line_h`、`line_kid`、`line_bound_at`、`line_ok_at`（CLK_MAP_HEADERS 尾端；clkSave_ 依表頭整列寫，既有分頁表頭要自動補欄，比照 CLK_STAFF_EXTRA 做法）。
- `clockRosterApply_` 每晚把 svc_roster 三欄寫進對應的 staff_clock 列。
- **可信綁定**（純函式 `lineTrust_(row, ctx)`）：state＝confirmed 且 roster_active 嚴格為 TRUE 且 line_h 非空 且 line_kid＝目前金鑰版本 且 now − line_bound_at ≥ 7 天 且 line_ok_at > line_bound_at 且 該店最後成功同步 ≤ 26 小時（clock-sync 狀態）且 line_bound_at > 該同仁的 line_revoked_at（§3.2）。
- **找人**：只看 state＝confirmed 且 roster_active＝TRUE 的列；line_h 對到的 emp_no 去重後恰好 1 位才算；0＝not_bound、≥2＝ambiguous（失效、已離職的舊列不計）。同一人多店綁定：任一店可信即可（全公司撤銷靠 §3.2）。
- **主店**（開通用，比 storeHomeFn_ 嚴）：該 emp_no 恰好一筆 confirmed＋roster_active＝TRUE＋role＝home；否則 need_review。

### 3.2 人資停用鈕（GPT #3、#4）
- staff 尾端欄 `line_revoked_at`（毫秒）；同仁名單詳細頁「停用此人的 LINE 開通／重設」（platform.staff），按下寫現在時間＋staff_log `line_revoke`。之後只有**在這時間之後重新綁定**且再滿 7 天＋LINE 打卡才恢復。
- 停用帳號（disabled）、撤回認領時一併寫 line_revoked_at。

## 4. 平台 GAS 全域函式（只給 mini 路由呼叫，不准進 Code.gs 分派表）
| 函式 | 輸入 | 回傳／動作 |
|---|---|---|
| `lineAuthCheck_(lineH, op, nowMs)` | line_h、op | `{mode, name, emp_no, unit_name, title_options, days_left, nonce}`；mode＝claim／reset／not_bound／not_trusted／ambiguous／blocked（disabled、pending、rejected）／need_review／off；claim／reset 時發 nonce（CacheService 10 分鐘、綁 line_h＋op、一次性） |
| `lineAuthReset_(lineH, nonce, newPw, nowMs)` | nonce、新密碼 | 取 ScriptLock → 消耗 nonce → 重查 check＝reset → 驗密碼規則 → 寫 salt/hash、setTokenAfter_、clearLoginState_、清忘記密碼鎖 → staff_log `line_reset_ok` |
| `lineAuthClaim_(lineH, nonce, form, nowMs)` | nonce、手機、生日、地址、職稱、新密碼 | 取 ScriptLock → 消耗 nonce → 重查 check＝claim → 走與 handleClaimSubmit_ **同一段**寫入（抽成共用 stfClaimWrite_：p_* 組織欄、個資、salt/hash、status＝pending），單位＝主店單位且不可改、職稱限 pt／ft → staff_log `line_claim_ok`（actor `line-self`）。之後由主管照現有流程核准，核准副作用（含 permStaffChangeCheck_）完全沿用 |
- 職稱若不在允許清單→ 回 `need_review`，前端改導原認領流程。
- 失敗原因寫 staff_log `line_fail`（只寫原因代碼，不寫個資）。

## 5. Mac mini 路由 `/platform/svc/line-auth`（minikit apps/dzy-platform，新檔 lineauth.js，照 jobs.js autoSupport 掛法）
- POST JSON `{op: 'check'|'reset'|'claim', id_token, ...}`，text/plain。
- node 端 `POST https://api.line.me/oauth2/v2.1/verify`（id_token＋client_id），驗 aud＝2011292256、exp 未過；失敗回 `invalid_token`。
- 總開關：`.env LINE_AUTH_ON=1` 才收請求（關＝503 off）；GAS 端另有同名開關（§4），兩邊都開才通（GPT #7）。
- id token：iat 必須在 10 分鐘內（GPT #5）；reset／claim 一定要帶 check 發的 nonce。
- 限流（GPT #13）：同 line_h 每天 check 30／reset＋claim 5；同來源 IP 每 10 分鐘 120；全站每分鐘 60（驗 token 前就算）。來源 IP 只取 kit 既有做法（Funnel 代理），不信任 X-Forwarded-For 以外的自填標頭。
- 金鑰（GPT #12）：LINE_MAP_KEY＝隨機 256 位元；`LINE_MAP_KID`（例 `k1`）。打卡端 svc_roster 回 `line_kid`；同步時 kid 與 mini 不同 → 該店 line 資料不算數＋通知匣 warn。
- 回應只含 check 回傳的欄位；log 不印 id_token、userId、line_h。
- `.env`：`LINE_MAP_KEY`、`LINE_CHANNEL_ID=2011292256`；app.json props／backupExclude 照既有金鑰做法。
- CORS（GPT #14）：只允許 `https://dzy.mozhuting.com`（本機測試另列 localhost），其他 Origin 一律拒；T3-0 先驗 kit 是否能設，不能就改走 /platform/api 代轉。

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

## 7b. 回退（GPT #7）
1. GAS 端 `LINE_AUTH_ON` 刪掉（立即全停）→ 2. mini `.env LINE_AUTH_ON` 刪掉＋重啟 → 3. 前端撤按鈕 → 4. 依 staff_log `line_claim_ok`／`line_reset_ok` 清單：可疑的由人資停用＋按 §3.2 停用鈕＋用生日手機或 admin 重設密碼（token_after 讓舊登入全失效）。打卡端新欄位留著無害。

## 8. 測試
- node：lineTrust_ 邊界（剛好 7 天、line_ok_at 等於 bound_at、解綁、roster_active 空白、kid 不符、同步過期、revoked 前後綁定）、ambiguous（含失效舊列不計）、職稱擋、LINE 開通寫出的 staff 列與一般 claimSubmit 逐欄相同、nonce 一次性、總開關、併發（同 nonce 兩次）、全域函式不在分派表（比照 proxyAuthorize_ 測試）、log 不含 userId。
- minikit：lineauth.js 假 LINE 驗證伺服器、限流、金鑰缺時拒絕。
- e2e：line.html 以假 LIFF 跑 claim／reset／not_trusted 三條。
- 上線前關：Fable＋GPT 互盲審（寫外部系統＋權限）。
