# 技術方案：管理系統 LINE 認身分
版本：v0.1 / 2026-10-25｜依據 spec.md v1.0

## 里程碑
- M1（P1＋P2）：打卡端記錄 LINE 打卡、每晚同步進平台，平台能用 line_h 判斷「可信綁定」——後端可測、對同仁零影響。
- M2（P3）：mini 能驗 LINE 身分並完成重設／開通（用假 LINE 驗證伺服器全程跑通）。
- M3（P4）：同仁從登入頁或 LINE 機器人一路走完。
- M4（P5）：上線前審查＋部署。

## 階段
| Phase | 內容 | repo／分支 | 依賴 |
|---|---|---|---|
| P1 打卡端 | line_ok_at 寫入／清空、svc_roster 三新欄、LineHub 關鍵字卡片 | mala-clock-in `line-auth`（正本 apps-script/）→ 部署到 ~/mala-gas 六店 | 無 |
| P2 平台後端 | staff_clock 三新欄＋自動補表頭、clockRosterApply_ 寫入、lineTrust_、lineAuthCheck_／Reset_／Claim_ | dzy `line-auth`（~/dzy-wt-line-auth） | 契約＝P1 的三欄格式 |
| P3 mini 路由 | lineauth.js：LINE 驗證、HMAC、限流、呼叫全域函式；app.json props／backupExclude；CORS 驗證 | dzy-minikit `line-auth` | P2 函式簽名 |
| P4 前端 | line.html＋views/line-auth.js、登入頁兩按鈕、同仁名單顯示紀錄、e2e | dzy `line-auth` | P3 回應形狀 |
| P5 上線 | Fable＋GPT 互盲審、部署（spec §7）、LIFF 建立、上線後 7 天觀察 | 全部 | P1–P4 |

P1 與 P2 可平行（契約先定，見下）；P3 等 P2；P4 可用假 mini 先做畫面。

## 共用契約（逐字）
- `line_h`：小寫 hex，`HMAC-SHA256(key=LINE_MAP_KEY 的 UTF-8 位元組, msg=LINE userId 原字串的 UTF-8 位元組)`，64 字元。範例：key `test-key-0123456789abcdef0123456789`、userId `U0000000000000000000000000000000a` → 以 node `crypto.createHmac('sha256',key).update(uid).digest('hex')` 的結果為準（測試檔固定此組向量，兩端共用同一份 fixture `test/fixtures/line-h-vector.json`，打卡端 GAS 用 `Utilities.computeHmacSha256Signature(uid, key)` 轉小寫 hex）。
- `line_bound_at`、`line_ok_at`：台北 ISO 字串 `yyyy-MM-ddTHH:mm:ss+08:00`（沿用 nowTaipeiIso()）；沒有＝空字串。
- svc_roster 每列新增鍵：`line_h`、`line_bound_at`、`line_ok_at`（未綁一律三個空字串）。
- 路由請求：`{op:'check'|'reset'|'claim', id_token:string, new_password?:string, form?:{phone,birthday,address,title}}`；回應：`{ok:true, mode, ...}` 或 `{ok:false, error:代碼, message:中文}`。錯誤代碼：invalid_token、rate_limited、not_bound、not_trusted、ambiguous、blocked、need_review、bad_input、server_error。

## 風險與對策
| 風險 | 對策 |
|---|---|
| 打卡端改到打卡主流程 | line_ok_at 寫在 events 寫入成功之後、try/catch 吞錯；回應不等它；judge_live 與既有 e2e 照跑 |
| 平台 minikit gas 落後 dzy main | 只套自己改動的 minikit PR，不整包 sync-gas（dzy-admin skill 教訓） |
| 全域函式被誤加進分派表 | 測試比照 proxyAuthorize_：斷言 Code.gs 分派表不含 lineAuth* |
| CORS 不通 | P3 第一個任務先驗；不通改走 /platform/api＋node hook 先驗 token |
| 核准副作用漏一項 | Claim 直接呼叫抽出的共用函式，handleStaffConfirm_ 也改呼叫它；測試比對兩路寫出的 staff 列一致 |
