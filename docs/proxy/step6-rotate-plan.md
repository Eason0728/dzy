# 代轉部署第 6 步：換掉稽核、宿舍舊通行碼（規劃＋操作手冊）

（本檔在 public repo：不放通行碼、網址、試算表 ID。連結由 MacBook 的 Claude 在對話裡給 Eason。）

## 為什麼要換
10-12 以前，每個登入管理系統的人，瀏覽器都拿過稽核、宿舍的通行碼；第 5 步關掉開關後，**新登入不再拿到**，但**已經拿過的碼還是有效**。
換碼後，碼只存在兩個地方：舊後端的試算表、mini 的資料庫 `module_secrets`。從此「停用帳號＝收回權限」才成立。

## 前提（缺一不做）
1. 第 5 步已完成且回報「登入 secrets：沒有」（開關沒關就換，新碼會再被發出去）。
2. 舊獨立網址版處理方式：已決定 A（見下節）。
3. 排程（2026-10-14 更新）：管理系統尚未開放同仁、舊網址版已沒人用 → **日期與時段限制取消**，Eason 照順序一口氣做：第 4 段打開寫入 → 第 5 步 → 產生新碼 → 第 6 步 → 舊網址「已搬家」說明頁 → 員工名單第 5 段 → 組織改版。唯一條件：mini 上沒有別的交辦在跑。
4. 整段約 15 分鐘，其中**管理系統全部停 3–5 分鐘**（登入也不能用；目前沒有同仁在用，不必挑時段）。

## 已決定：舊獨立網址版一起退場（Eason 2026-10-14 選 A）
- 新碼只有 Eason 與 mini 知道，**不發給任何人**；事前產生碼用預設的 16 字亂碼。
- 換碼當下，舊稽核網址、舊宿舍後台（admin.html）就登不進去了＝實質退場。
- ⚠ **舊宿舍站的 `sign.html`、`handover.html` 不能關**：宿舍舊後端產生的簽約／點交連結（包括從管理系統建的）都指向舊宿舍站這兩頁，只帶簽約 token、不用通行碼，換碼不影響。只能退 `admin.html`。
- 退場後續（另案，換碼後做；會被員工看到，先給本機預覽再推）：舊稽核首頁、舊宿舍 admin.html 換成「已搬到管理系統」的轉址說明頁。

## 原始選項（留檔）
這三個碼現在**同時也是舊網址版的登入通行碼**（使用者手動輸入）：

| 碼 | 舊網址版誰在輸入 | mini 那邊叫 |
|---|---|---|
| 會計通行碼 | 舊稽核網址：會計（可寫） | audit / write |
| 主管通行碼 | 舊稽核網址：主管（唯讀） | audit / read |
| 宿舍管理端通行碼 | 舊宿舍後台 admin.html | dorm / write |

- **A（推薦）舊網址版這次一起退場**：新碼只有 Eason 與 mini 知道、不發給任何人；大家只走管理系統。碼可以很長很亂。
- **B 舊網址版繼續用**：新碼要發給會計／主管，等於又散出去，「停用帳號就收回」對舊網址版仍不成立；碼要好輸入。
- 另：舊稽核 repo（public）`js/mock-data.js` 有兩個「示範用」通行碼常數，新碼**不可**跟它們一樣。

## 分工與步驟

### 事前（Eason，約 5 分鐘）
1. 在自己電腦（不是對話裡）產生三個新碼，存進密碼管理器，**不要貼給任何 Claude、不要傳 LINE**：
   ```sh
   for n in 會計 主管 宿舍; do printf '%s：' "$n"; openssl rand -base64 18 | tr -d '/+=' | cut -c1-16; done
   ```
   （選 B 的話改成好輸入的：至少 8 字、英文＋數字混合、不可純數字。）
2. 確認兩張試算表開得起來（連結看對話）：
   - 稽核試算表 →「設定」分頁，找到「會計通行碼」「主管通行碼」兩列。
   - 宿舍試算表 →「settings」分頁，找到 key＝`admin.pass` 那列（值在 B 欄）。

### 換碼（mini 的 Claude ＋ Eason 輪流，照順序，一步一回報）

**M1【mini Claude】準備**（還不停機）
```sh
cd ~/dzy-minikit && git pull --ff-only && ls apps/dzy-platform/rotate-secrets.js
export PATH="$HOME/.local/node/bin:$PATH"; node --check apps/dzy-platform/rotate-secrets.js && echo ok
curl -s -m 5 http://127.0.0.1:8799/platform/health | head -c 160; echo
```
期望：檔案在、`ok`、health green。回報後等 Eason 說「開始」。

**M2【mini Claude】停管理系統後端**（從這裡開始管理系統暫停）
```sh
cd ~/dzy-minikit && bash kit/bin/stop.sh apps/dzy-platform
curl -s -m 3 http://127.0.0.1:8799/platform/health || echo "已停"
mkdir -p "$HOME/dzy-minikit-work" && chmod 700 "$HOME/dzy-minikit-work"
sqlite3 "$HOME/dzy-platform-data/app.db" ".backup '$HOME/dzy-minikit-work/platform-app.db.bak-$(date +%Y%m%d-%H%M)'" && ls -l "$HOME"/dzy-minikit-work/platform-app.db.bak-* | tail -1
```
期望：`已停`；備份檔大小不是 0（用 `.backup` 才會連同 WAL 裡還沒寫回的資料一起備；`~/dzy-minikit-work` 是 700，不在 repo 裡）。

**E1【Eason，在 mini 終端機】寫新碼進 mini**（畫面不會顯示碼；每個碼輸入兩次）
```sh
cd ~/dzy-minikit && export PATH="$HOME/.local/node/bin:$PATH" && node apps/dzy-platform/rotate-secrets.js
```
期望最後看到「已更新 audit/write」「已更新 audit/read」「已更新 dorm/write」「完成」。
出現【停】＝什麼都沒寫，照訊息修正後重跑同一行。

**E2【Eason，在任何電腦】改兩張試算表**（直接在儲存格貼新碼，貼完按 Enter，不要留空白）
- 稽核「設定」：會計通行碼 ← 新會計碼；主管通行碼 ← 新主管碼。
- 宿舍「settings」：`admin.pass` 的 B 欄 ← 新宿舍碼。
- 儲存格若被 Google 自動轉成數字或日期（左上角出現綠色三角）→ 改成「純文字」格式後重貼。

**M3【mini Claude】開回來**
```sh
cd ~/dzy-minikit && bash kit/bin/start.sh apps/dzy-platform; sleep 8
curl -s -m 5 http://127.0.0.1:8799/platform/health | head -c 160; echo
bash kit/bin/autostart-status.sh
```
期望：health green。
註：用 `start.sh` 開回來的 dzy-platform 暫時不在自動啟動底下（另外三個系統不受影響）；當掉照樣 5 秒自己重啟，下次 mini 重開機登入後自動回到 LaunchAgent 管。不用 `install-autostart.sh` 是因為它會把四個系統全部重啟。

**E3【Eason，手機】實測**（Cmd+Shift+R 或重開頁面）
1. 管理系統登入 → 月初盤點抽查打得開、有資料（＝會計碼通了）。
2. 宿舍合約 → 清單有資料（＝宿舍碼通了）。
3. 請一位店長打開稽核、看得到自己店（＝主管碼通了；店長走唯讀碼）。目前沒開放同仁 → 這項略過，改由 Eason 用一個只有唯讀權限的測試帳號開一次稽核；沒有這種帳號也可略過，之後開放時第一位店長打開就是實測。

**M4【mini Claude】查 log**（E3 做完後）
```sh
DATA="$HOME/dzy-platform-data"
cat "$DATA"/logs/server.log* | grep -E 'proxy:(audit|dorm)\.' | tail -n 30 | awk '{print $1, $2, $3}'
```
期望：換碼後的 `proxy:audit.getAll ok`、`proxy:dorm.list ok` 都有；沒有 `upstream_not_ok`（＝舊後端說通行碼錯，代表某邊漏改或打錯）。
有 `upstream_not_ok` → 停，回報是 audit 還是 dorm，Eason 回頭比對那張試算表的那一格。

**收尾【mini Claude】**（M4 確認都是 ok 之後）
```sh
rm -f "$HOME"/dzy-minikit-work/platform-app.db.bak-* "$HOME"/dzy-minikit-work/platform-env.bak-*
```
（兩個備份都含舊碼／金鑰，確認不用回退就刪。）

## 出事怎麼退
- E3 打不開、log 有 `upstream_not_ok`：九成是試算表那格跟 mini 不一致 → Eason 重貼那一格即可，不必停機。
- mini 起不來或登入壞掉：
  ```sh
  cd ~/dzy-minikit && bash kit/bin/stop.sh apps/dzy-platform
  D="$HOME/dzy-platform-data"; rm -f "$D/app.db-wal" "$D/app.db-shm"
  cp -p "$(ls -t "$HOME"/dzy-minikit-work/platform-app.db.bak-* | head -1)" "$D/app.db" && chmod 600 "$D/app.db"
  bash kit/bin/start.sh apps/dzy-platform
  ```
  退回後 mini 用的是舊碼 → Eason 把兩張試算表也改回舊碼（密碼管理器裡留著）。

## 回報格式（Eason 貼回 MacBook 的 Claude）
```
第 6 步回報（時間：____）
- M1 檔案／語法／health：__
- M2 停機：__ 備份：__
- E1 rotate-secrets：已更新 __ 列 / 出現【停】：____
- E2 兩張試算表：已改 / 卡在 ____
- M3 health：__
- E3 手機：稽核 __ 宿舍 __ 店長 __
- M4 換碼後 ok 筆數：audit __ dorm __；upstream_not_ok：__
```
