# 收支管理（財務部門）— 進度

## 2026-10-26 上線完成
- 前端 dzy 3b3b215（modules/cashbook、registry 一行、api.js PROXY_NS、dryrun.js 白名單、Auth.gs／Perms.gs）。
- 現金帳伺服器 mala-cashbook 64acc37（管理代轉通道 ADMIN_SVC_KEY、admin_log、會計鎖 LOCKED_BY_ACCT、ADMIN_LOGIN_OFF 開關）。
- 門市營運 mala-store-ops cf67de5（LOCKED_BY_ACCT 中文訊息）。
- mini 套件 dzy-minikit 222e15a（proxy-hook cashbook、app.json PROXY_URL_CASHBOOK、set-cashbook-secret.js、gas 同步）。
- Eason 在 mini 完成金鑰與重啟、在權限設定打開財務部門「收支管理」；會計驗收通過（Eason：「ＡＢ都好了」）。外網代轉 ns cashbook 回 401 NO_TOKEN。

## 待辦
- [ ] **約 2026-11-09：舊管理通行碼入口退場**（Eason Q2：並行兩週）。先確認會計已改用管理系統，再交辦 mini：現金帳 `server/.env` 加 `ADMIN_LOGIN_OFF=1` → `sudo launchctl kickstart -k system/com.mala.cashbook`；舊設定頁應顯示「會計功能已搬到管理系統 → 財務部門 → 收支管理」；接著換管理通行碼（設定頁已不能用，改由 mini 資料庫層重設，Eason 本人操作）。
- 注意：調撥對話（transfer-fin-req）放寬了 cashbook-module 測試的 registry 位置檢查、改了 minikit kit/runner/proxy.js（不允許動作回 403）；之後動同一批檔合併時對一下。
