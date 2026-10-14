# 交辦給 Mac mini 上的 Claude：員工名單統一第 4 段之二－1（用新程式重跑今天的每日同步，寫入仍關）

（Eason 整段貼給 mini 的 Claude。本文不含網址、金鑰。）

## 背景
今天 01:52 的每日同步是舊程式跑的。開寫入前要先用新程式重算一次「主店／支援店」。同步員看狀態檔 `clock-sync-state.json` 的 `daily.date` 判斷今天跑過沒，清掉它再重啟，新程式會立刻補跑。
`CLOCK_WRITE=0` 時重跑只更新名冊與標籤，不會動六店打卡。**本段不開寫入，`.env` 一個字都不改。**

三條硬規則：不讀不印金鑰與網址、不 cat `.env`；結果與期望不同就貼給 Eason 並**停**；不要自己修。

## 步驟
1. **停平台、清今天的日期、再啟動。**（現在已是自動啟動，用 stop.sh 停掉後要再 start.sh）
   ```
   export PATH="$HOME/.local/node/bin:$PATH"; cd ~/dzy-minikit
   bash kit/bin/stop.sh apps/dzy-platform
   F="$HOME/dzy-platform-data/clock-sync-state.json"; cp "$F" "$F.bak-$(date +%H%M)"
   node -e 'const fs=require("fs"),f=process.argv[1],s=JSON.parse(fs.readFileSync(f,"utf8"));console.log("原本 daily.date=",s.daily&&s.daily.date);s.daily={date:"",failed:[],lastTry:0};fs.writeFileSync(f,JSON.stringify(s),{mode:0o600})' "$F"
   bash kit/bin/start.sh apps/dzy-platform && sleep 3 && bash kit/bin/status.sh apps/dzy-platform
   ```
   期望：印出原本的日期（今天）、最後顯示運行中。

2. **等補跑完成（最多 5 分鐘），看紀錄。**
   `sleep 120; grep -nE "daily 開始|daily store=|daily apply|jobs 啟動完成" "$HOME/dzy-platform-data/logs/server.log" | tail -n 10`
   期望：一行新的 `daily 開始 <今天>`、六行 `daily store=<店> ok`（六張犁名冊空會多一行 warn，正常）、一行 `daily apply ok`。沒出現就再等 2 分鐘看一次；還沒有就停。

3. **健康檢查。**本機 `/platform/health` 只取 `level` 與 `reasons`，期望 green、reasons 空；`grep -cE "https://|CLOCK_KEY|svc_key|HUB_SVC" "$HOME/dzy-platform-data/logs/server.log"` 期望 0。

4. **回報**（請 Eason 整段貼回 MacBook）：
```
第 4 段之二－1 完成
- 原本 daily.date：<日期>
- 補跑紀錄：<daily 開始…／六店各 ok 或錯誤代碼／daily apply ok 或 fail:代碼>
- health：<level>；reasons：<代碼或「無」>
- log 含網址或金鑰：<0 或次數>
- 卡住的步驟：<編號與現象，或「無」>
```
