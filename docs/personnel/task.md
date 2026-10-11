# 任務清單：個人帳號管理（第一期）

每個任務 100～200 行以內；驗收條件寫成可打勾的句子。

## 階段 A：後端
| # | 任務 | 輸入 → 輸出 | 驗收 |
|---|---|---|---|
| A1 | Setup.gs 補 staff／org／staff_log 分頁與 org 預設列；**upsert** roles.staff 的 perms；users 補 K 欄 token_after 表頭 | 空白或既有試算表 → 三分頁存在、表頭逐字照 spec §4 | 既有分頁其他內容不變；重跑不重複寫預設列；既有試算表重跑後 roles.staff perms＝platform.self（ensureTab_ 只在空表寫預設列，不能靠它） |
| A2 | Staff.gs：org 讀取＋§6.5 驗證函式 | payload → `{ok}`／`{ok:false,error}` | 每條規則一個正例一個反例測試；dept 依 unit 是否有 dept 而必填／必空 |
| A3 | staffImport／staffAdd／staffList | names → users＋staff 列 | 編號從最大號＋1；與 unclaimed 同名或名單內重複才整批拒絕；與已認領者同名可建；preview 不寫入；DZY999 上限；admin 以外沒權限被擋 |
| A4 | claimLookup／claimSubmit＋Auth 小改（正規化放第一行、token 加 i、共用驗證函式檢查 token_after） | 名字 → 編號；表單 → token | 只有 unclaimed 回編號；送出後 status＝pending、p_* 有值；hash 空的帳號登入回專屬訊息且計入鎖定；`dzy001`／`DZY001` 共用同一個鎖定計數；admin 帳號大小寫行為不變；unclaim 後舊 token 呼叫 myProfile 被拒 |
| A5 | myProfile／saveMyProfile／myUnit | token → 自己資料 | payload 夾 emp_no 被忽略；active 改組織欄只進 p_*；生日改不了；myUnit 門檻與欄位 |
| A6 | staffConfirm／Reject／SetActive／Unclaim／UnlockReset／Edit | emp_no → 狀態轉移 | 照 spec §5 每條箭頭一個測試；非法轉移回錯；log detail 不含個資 |
| A7 | forgotReset＋登入前限流 | 三欄 → 新密碼 | 錯 5 次鎖 1 小時；24h 第 3 次鎖要後台解；鎖住期間對的也不給過；不回剩餘次數；成功清登入鎖並使舊 token 失效；三種「不存在」回同一句；claimLookup 同姓名查無 5 次才限；全域 600 上限；phone 存成數字時仍比對得上 |
| A8 | Code.gs 白名單與鎖 | — | 新 action 都可分派；寫入類在 MUTATING_ACTIONS；未知 action 照舊拒絕；既有 23 支 node 測試全綠 |

## 階段 B：前端
| # | 任務 | 驗收 |
|---|---|---|
| B1 | login.js 加兩個連結＋帳號提示；hash `#/claim`／`#/forgot` 由 login.js 讀；shell／manifest-check 保留字 | 既有 e2e t1 綠；重整後停在原畫面；認領成功進首頁不跳「沒有權限」 |
| B2 | claim.js 三步 | 連動下拉正確；錯誤訊息白話；成功直接登入 |
| B3 | forgot.js | 不顯示剩餘次數；時間鎖與後台鎖兩種訊息 |
| B4 | modules/me（profile、unit、alerts） | 四種狀態顯示正確；系統帳號顯示「沒有個人資料」不報錯；manifest-check 過 |
| B5 | modules/staff（list、import、alerts） | 依狀態出現正確按鈕；個資預設收合；匯入預覽編號正確 |
| B6 | users 模組排除 staff 角色 | 既有 users-module 測試綠 |
| B7 | e2e 第八支 | 認領→確認→我的資料顯示已確認；忘記密碼錯 5 次鎖 1 小時；零真實網路 |

## 階段 C：上線
| # | 任務 | 驗收 |
|---|---|---|
| C1 | 上線前互盲審（Fable＋GPT） | 雙方都挑到的修完；單邊的讀碼判定 |
| C2 | 部署後端（update-deployment 既有 ID） | doGet 健康檢查 ok；既有帳號登入正常 |
| C3 | 正式試算表補分頁 | 三分頁存在、既有資料不變 |
| C4 | 產出 113 名純文字給 Eason 貼匯入（先按預覽） | 預覽 DZY001＝名單第一位、DZY113＝最後一位；預覽後 staff 分頁列數不變 |
| C5 | 落地清單八項 | progress.md 全打勾或寫不適用 |
