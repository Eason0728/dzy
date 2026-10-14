# 交辦給 Mac mini 上的 Claude：關掉「登入時順便發稽核／宿舍通行碼」的過渡開關（代轉部署第 5 步）

（Eason 整段貼給 mini 的 Claude。本文不含網址、金鑰；那些值只在 mini 本機。）

## 背景
- 2026-10-12 起稽核、宿舍改由 mini 代轉（契約 `apps/dzy-platform/PROXY.md`）。新前端 2026-10-12 20:10 上線，不再讀通行碼。
- 過渡期 `.env` 有一行 `GAS_PROP_LEGACY_SECRETS=1`，讓還開著舊網頁的人能用；副作用是**登入／me 仍把稽核、宿舍通行碼發給瀏覽器**。2026-10-14 11:38 你回報這行數＝1。
- 第 4 步實測：Eason 2026-10-14 確認店長、會計開過稽核，主管開過宿舍，都正常。
- **本次只做一件事**：刪掉那一行 → 只重啟 dzy-platform → 確認登入不再回通行碼。
- 換通行碼是下一步（第 6 步），**不在這份交辦裡**。

三條硬規則：
- **你不讀、不印任何金鑰、通行碼、網址。**不要 cat `.env`、不要印 module_secrets 內容。驗證只看數字或代碼。
- **`.env` 只准刪 `GAS_PROP_LEGACY_SECRETS` 那一行**，其他一個字都不動（`CLOCK_WRITE` 等保持原樣）。不碰別的系統（transfer、mztloss、dorm、佈告欄）。
- 任何一步結果和「期望」不同：把現象貼給 Eason，**停**，不要自己修。

## 步驟

0. **先確認時間與沒人在動 mini。**
   - 時間不限（2026-10-14 Eason：管理系統尚未開放同仁、舊網址版已沒人用，取消時段限制）。
   - 「員工名單統一第 5 段（佈告欄）」或其他交辦若還沒回報完成 → 停，等那邊做完。

1. **前置證據：新前端真的有人在用代轉（只數行數）。**
   ```sh
   DATA="$HOME/dzy-platform-data"
   for k in 'proxy:audit\.[A-Za-z]* ok ' 'proxy:dorm\.[A-Za-z]* ok ' 'proxy:audit\.[A-Za-z]* upstream_not_ok' 'proxy:dorm\.[A-Za-z]* upstream_not_ok' 'NO_SECRET'; do
     printf '%s → ' "$k"; cat "$DATA"/logs/server.log* 2>/dev/null | grep -E "^2026-10-1[2-9]" | grep -cE "$k"; done
   cat "$DATA"/logs/server.log* 2>/dev/null | grep -E 'proxy:(audit|dorm)\.[A-Za-z]* ok ' | tail -n 1 | cut -c1-25
   ```
   期望：audit ok 與 dorm ok 都 > 0；NO_SECRET＝0；最後一筆成功時間是近兩天。
   任一 ok＝0 → 停，回報（代表那個模組還沒人實際用代轉成功過，關開關前要先實測）。

2. **刪前三個數字。**
   ```sh
   cd ~/dzy-minikit
   grep -c '^GAS_PROP_LEGACY_SECRETS' apps/dzy-platform/.env
   sqlite3 -readonly "$HOME/dzy-platform-data/app.db" "select count(*) from meta where k='prop:LEGACY_SECRETS';"
   ps eww "$(cat "$HOME/dzy-platform-data/server.pid")" | grep -c 'GAS_PROP_LEGACY_SECRETS'
   ```
   期望：1、0、0。
   - 第二個不是 0 ＝資料庫裡有執行期覆寫（它會**蓋過** `.env`，刪 .env 也沒用）→ 停，回報。
   - 第三個不是 0 ＝旗標是從行程環境變數帶進來的（環境變數優先於 .env）→ 停，回報。

3. **刪那一行（先備份到 repo 外的 `~/dzy-minikit-work`，不會被 git 收進去）。**
   ```sh
   cd ~/dzy-minikit/apps/dzy-platform
   mkdir -p "$HOME/dzy-minikit-work" && chmod 700 "$HOME/dzy-minikit-work"
   cp -p .env "$HOME/dzy-minikit-work/platform-env.bak-$(date +%Y%m%d-%H%M)"
   sed -i '' '/^GAS_PROP_LEGACY_SECRETS=/d' .env
   grep -c '^GAS_PROP_LEGACY_SECRETS' .env; wc -l < .env; wc -l < "$(ls -t "$HOME"/dzy-minikit-work/platform-env.bak-* | head -1)"
   ```
   期望：0；新檔行數＝備份行數減 1。

4. **只重啟 dzy-platform（不動另外三個系統）。**
   現在由 LaunchAgent `com.dzy.minikit` 管。只殺 node，讓 dzy-platform 自己的重啟迴圈 5 秒後用新 `.env` 拉起來：
   ```sh
   export PATH="$HOME/.local/node/bin:$PATH"; cd ~/dzy-minikit; DATA="$HOME/dzy-platform-data"
   OLD=$(cat "$DATA/server.pid"); kill "$OLD"; sleep 10; NEW=$(cat "$DATA/server.pid"); echo "舊 $OLD 新 $NEW"
   curl -s -m 5 http://127.0.0.1:8799/platform/health | head -c 160; echo
   bash kit/bin/autostart-status.sh
   ```
   期望：新舊 pid 不同；health `level` 是 green；autostart-status 顯示 LaunchAgent 仍載入、四個系統都在跑。
   （**不要**用 `stop.sh apps/dzy-platform`：它會連重啟迴圈一起停，之後只能手動 `start.sh`（脫離自動啟動）或重跑 `install-autostart.sh`（會把四個系統全部重啟）。）

5. **驗旗標真的關了（你能做的部分）。**
   ```sh
   ps eww "$(cat "$HOME/dzy-platform-data/server.pid")" | grep -c 'GAS_PROP_LEGACY_SECRETS'
   curl -s -m 5 -XPOST http://127.0.0.1:8799/platform/proxy -d '{"ns":"audit","action":"getAll"}' | head -c 80; echo
   ```
   期望：0；代轉仍在（回 `NO_TOKEN`）。

6. **【Eason】驗登入回應沒有通行碼。** 請 Eason 在 mini 的終端機自己貼下面這段（帳號密碼由他自己輸入，畫面不顯示密碼；只印「有／沒有」，不印內容）：
   ```sh
   export PATH="$HOME/.local/node/bin:$PATH"
   read -r -p '帳號：' U; read -r -s -p '密碼：' P; echo
   U="$U" P="$P" node -e '
   fetch("http://127.0.0.1:8799/platform/api",{method:"POST",headers:{"Content-Type":"text/plain"},
     body:JSON.stringify({action:"login",token:"",payload:{username:process.env.U,password:process.env.P}})})
   .then(r=>r.json()).then(j=>{const d=(j&&j.data)||{};
     console.log("登入成功：", j.ok===true, "｜通行碼欄位 secrets：", Object.prototype.hasOwnProperty.call(d,"secrets")?"有（開關還開著）":"沒有");})
   .catch(e=>console.log("連不上：", e.message));'
   unset U P
   ```
   期望：`登入成功： true ｜通行碼欄位 secrets： 沒有`。
   （這次登入只多發一張登入憑證，不影響他手機、電腦上已登入的狀態。）

7. **【Eason】外網實測一次。** 手機開管理系統（Cmd+Shift+R 或重開頁面）→ 月初盤點抽查打得開、宿舍合約清單打得開。

8. **回報。**請 Eason 把下面整段貼回 MacBook 的 Claude：
   ```
   第 5 步回報（時間：____）
   - 0 時間／無其他交辦：OK / 不 OK
   - 1 代轉成功次數：audit ok=__ dorm ok=__ audit upstream_not_ok=__ dorm upstream_not_ok=__ NO_SECRET=__ 最後成功=____
   - 2 刪前：.env 行數=__ 資料庫覆寫=__ 行程環境=__
   - 3 刪後 .env 行數=__（新 __ 行／備份 __ 行）
   - 4 舊 pid=__ 新 pid=__ health=____ LaunchAgent 載入=是/否 四系統在跑=是/否
   - 5 行程環境=__ 代轉回=____
   - 6 登入 secrets：有 / 沒有
   - 7 手機稽核／宿舍：OK / 不 OK（哪個畫面、什麼字）
   ```

## 出事怎麼退
登入後稽核或宿舍打不開、且看得出跟這次有關：
```sh
cd ~/dzy-minikit/apps/dzy-platform && cp -p "$(ls -t "$HOME"/dzy-minikit-work/platform-env.bak-* | head -1)" .env
DATA="$HOME/dzy-platform-data"; kill "$(cat "$DATA/server.pid")"; sleep 10; curl -s -m 5 http://127.0.0.1:8799/platform/health | head -c 160; echo
```
（新前端本來就不讀通行碼，理論上關開關不會讓新前端壞；會壞的只有還開著 10-12 以前舊網頁的人，重整就好。）
備份檔 `~/dzy-minikit-work/platform-env.bak-*` 第 6 步換碼完成後再刪。
