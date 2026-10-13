# 交辦給 Mac mini 上的 Claude：員工名單統一第 5 段（佈告欄接上管理系統，只檢查不切換）

（Eason 整段貼給 mini 的 Claude。本文不含網址、金鑰；那些值只在 mini 本機的 `.env`。）

## 背景
- 管理系統（dzy-platform）已有給佈告欄用的名單出口 `svcDirectory`，沒設鑰匙前一律拒絕。
- 佈告欄 v0.7.5 已合併進 main（PR #38）、Google 橋接已部署 @34。預設 `STAFF_SOURCE` 沒設＝照舊從打卡同步，行為不變。
- **本段只做到「搬家檢查報告」**：設鑰匙、更新佈告欄程式、跑 `migrate`（只報告、不寫入）。`--apply` 與切換由 MacBook 看完報告再交辦。

三條硬規則：
- **你不讀、不印任何金鑰與網址。**驗證只看數字或代碼。不要 cat `.env`。
- **不要加 `--apply`、不要設 `STAFF_SOURCE`、不要動 `CLOCK_WRITE`。**
- 任何一步結果和「期望」不同：把現象貼給 Eason，**停**，不要自己修。
- 如果另一個對話正在做員工名單統一第 4 段、也在重啟 mini 平台：先停，等那邊做完再開始。

## 步驟
1. **在本機產生共用鑰匙，寫進兩邊 .env（不印出來）。**
   ```sh
   P="$HOME/dzy-minikit/apps/dzy-platform/.env"; B="$HOME/dzy-bulletin/server/.env"
   grep -c '^GAS_PROP_BULLETIN_SVC_KEY=' "$P"; grep -c '^BULLETIN_SVC_KEY=' "$B"; grep -c '^DZY_PLATFORM_URL=' "$B"
   ```
   期望三個都是 0。若不是 0：停、回報（不要覆蓋）。是 0 才接著跑：
   ```sh
   K=$(openssl rand -hex 24)
   printf 'GAS_PROP_BULLETIN_SVC_KEY=%s\n' "$K" >> "$P"
   printf 'BULLETIN_SVC_KEY=%s\nDZY_PLATFORM_URL=http://127.0.0.1:8799/platform/api\n' "$K" >> "$B"
   unset K; chmod 600 "$P" "$B"
   grep -c '^GAS_PROP_BULLETIN_SVC_KEY=.\{48\}$' "$P"; grep -c '^BULLETIN_SVC_KEY=.\{48\}$' "$B"; grep -c '^DZY_PLATFORM_URL=http://127.0.0.1:8799/platform/api$' "$B"
   [ "$(grep '^GAS_PROP_BULLETIN_SVC_KEY=' "$P" | cut -d= -f2 | shasum)" = "$(grep '^BULLETIN_SVC_KEY=' "$B" | cut -d= -f2 | shasum)" ] && echo 兩邊相同
   ```
   期望：三個 1、印「兩邊相同」。

2. **重啟管理系統平台（讓它讀到新鑰匙）。**
   `export PATH="$HOME/.local/node/bin:$PATH"; cd "$HOME/dzy-minikit" && git pull --ff-only -q; bash kit/bin/stop.sh apps/dzy-platform && bash kit/bin/start.sh apps/dzy-platform && sleep 3 && bash kit/bin/status.sh apps/dzy-platform`
   期望：運行中。`curl -s -m 5 http://127.0.0.1:8799/platform/health` 只看 `level`，期望不是 red。

3. **更新佈告欄程式到 main**：照 `~/dzy-bulletin/server/DEPLOY.md` 附錄 B 的指令區塊做（期望 `→` 後面是 b25e42d 或更新），三個常駐範本 diff 應為空白。伺服器是附錄 A（system domain）：用 kill 讓 KeepAlive 重起，印出新舊 PID 確認已換；再 `curl -s http://127.0.0.1:8793/health` 只看 `ok`／燈號。
   期望：PID 換了、health 正常、版本 0.7.5。

4. **搬家檢查（只報告，不寫入）。**
   `cd ~/dzy-bulletin && node server/staff-dzy.js migrate; echo "exit=$?"`
   這一步會向管理系統要名單；輸出只有 S-xxx 編號、沒有姓名。exit 1（不通過）是**預期內可能**的結果，照實回報即可，不要自己做 `--map`。

5. **回報。** 請 Eason 把下面整段貼回 MacBook 的 Claude：
```
第 5 段（mini）完成到搬家檢查
- 鑰匙：三個 1、兩邊相同 <是/否>
- 平台 health level：<green/yellow/red>
- 佈告欄：<舊 hash> → <新 hash>；PID <舊>→<新>；health <ok/其他>
- migrate 輸出（原樣貼全部行）：
<貼這裡>
- exit：<0/1>
- 卡住的步驟：<編號與現象，或「無」>
```
