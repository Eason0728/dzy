# 交辦給 Mac mini 上的 Claude：員工名單統一第 4 段之一（換後端＋登入後自動啟動，寫入仍關）

（Eason 整段貼給 mini 的 Claude。本文不含網址、金鑰；那些值只在 mini 本機的 `.env`。）

## 背景
- 第 1–3 段已上線，mini 以只讀模式（`CLOCK_WRITE=0`）每天 00:10 同步六店打卡名冊。
- **本段**：①換上新版管理系統後端（多了總部「在主店建打卡帳號」`clockAddHome`）；②裝「登入後自動啟動」（LaunchAgent `com.dzy.minikit`，取代手動照 START.txt 啟動）；③查今天的每日同步是新程式還是舊程式跑的。
- **寫入下一段才開**（第 4 段之二，等 2026-10-15 00:10 每日同步跑過再說）。

三條硬規則：
- **你不讀、不印任何金鑰與網址。**驗證只看數字或代碼。不要 cat `.env`。
- **`CLOCK_WRITE` 保持 0，`.env` 一個字都不改。**
- 任何一步結果和「期望」不同：把現象貼給 Eason，**停**，不要自己修。

## 步驟
0. **先確認沒人在動 mini。**第 5 段（佈告欄）的交辦若還沒做完，先停，等那邊回報完成再開始。

1. **更新 minikit。**
   `cd ~/dzy-minikit && git pull --ff-only && git log --oneline -3`
   期望：fast-forward 成功。
   `grep -c "function handleClockAddHome_\|clockAddHome" apps/dzy-platform/gas/StaffClock.gs apps/dzy-platform/gas/Code.gs` 期望兩檔都 ≥1；
   `ls kit/bin/install-autostart.sh kit/bin/autostart-run.sh kit/templates/com.dzy.minikit.plist` 三個都在。

2. **查今天的每日同步（只看時間與字樣）。**
   `grep -nE "daily 開始|daily 重試|daily apply|jobs 啟動完成" "$HOME/dzy-platform-data/logs/server.log" | tail -n 12`
   回報每一行的「時間＋字樣」（例：`2026-10-14 01:20 daily 開始 2026-10-14`、`03:05 jobs 啟動完成`）。MacBook 要靠這個判斷：今天的同步是在「更新 1」重啟之前還是之後跑的。

3. **過渡旗標檢查（只數不改）。**
   `grep -c '^GAS_PROP_LEGACY_SECRETS' ~/dzy-minikit/apps/dzy-platform/.env` → 回報數字（期望 0；是 1 就照實回報，**不要刪**）。

4. **停掉手動啟動的系統，改裝自動啟動。**（會讓管理系統、耗損、調撥等約 1 分鐘無法使用）
   ```
   export PATH="$HOME/.local/node/bin:$PATH"; cd ~/dzy-minikit
   for d in apps/*/; do bash kit/bin/stop.sh "${d%/}"; done
   bash kit/bin/install-autostart.sh
   bash kit/bin/autostart-status.sh
   ```
   期望：安裝腳本沒有擋下；最後每個 app 都顯示運行中。
   補 START.txt（只補一次）：
   `grep -q autostart START.txt 2>/dev/null || printf '%s\n' '# 登入後自動啟動：bash kit/bin/install-autostart.sh（移除 uninstall-autostart.sh、狀態 autostart-status.sh）；手動啟動中的系統要先 stop.sh' >> START.txt`

5. **驗證。**
   - `tail -n 60 "$HOME/dzy-platform-data/logs/server.log" | grep -c "jobs 啟動完成"` 期望 ≥1；`grep -c "NO_SUCH_FUNCTION" "$HOME/dzy-platform-data/logs/server.log"` 期望 0。
   - 對本機 `/platform/health`、`/mztloss/health`、`/transfer/health` 各發 GET（`curl -s -m 5`，用本機埠，見 `kit/ports.json`），只取 `level`：期望都不是 red。
   - log 不得含金鑰或網址：`grep -cE "https://|CLOCK_KEY|svc_key" "$HOME/dzy-platform-data/logs/server.log"` 期望 0。
   - **不要**登出／重開機測自動啟動（FileVault 要人到場解鎖）。下次 Eason 本人在 mini 前面時再測。

6. **回報。**請 Eason 把下面整段貼回 MacBook 的 Claude：
```
第 4 段之一完成
- minikit HEAD：<短 hash>
- 今天 daily 紀錄：<每行 時間＋字樣>
- LEGACY_SECRETS 行數：<0/1>
- 自動啟動：<各 app 運行中／哪個沒起來>
- jobs 啟動：<有/無>；NO_SUCH_FUNCTION：<0 或次數>
- health：platform <綠/黃/紅> mztloss <..> transfer <..>
- log 含網址或金鑰：<0 或次數>
- 卡住的步驟：<編號與現象，或「無」>
```
