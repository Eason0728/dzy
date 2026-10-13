# 交辦給 Mac mini 上的 Claude：員工名單統一｜更新 1（主店判斷修正＋總部指定主店）

（Eason 整段貼給 mini 的 Claude。本文不含網址、金鑰。）

背景：第 3 段已上線。這次更新管理系統後端兩個檔（StaffClock.gs、Code.gs）：沒有單位（還沒認領帳號）的同仁改用打卡資料推斷主店；店長清單改依打卡帳號所在店過濾；新增總部「指定主店」（clockSetHome）。MacBook 已同步進 minikit main。你只要 pull、重啟、驗證。規則同第 3 段：不讀不印金鑰網址、`CLOCK_WRITE` 保持 0、結果不符就停。

1. `cd ~/dzy-minikit && git pull --ff-only && git log --oneline -1`。期望：fast-forward，最新一筆含「總部指定主店 clockSetHome」。`grep -c clkHomeStoreFor_ apps/dzy-platform/gas/StaffClock.gs` 期望 ≥1；`grep -c clockSetHome apps/dzy-platform/gas/Code.gs` 期望 ≥1。
2. 重啟：`export PATH="$HOME/.local/node/bin:$PATH"; cd "$HOME/dzy-minikit" && bash kit/bin/stop.sh apps/dzy-platform && bash kit/bin/start.sh apps/dzy-platform && sleep 3 && bash kit/bin/status.sh apps/dzy-platform`。期望：運行中。
3. `tail -n 40 "$HOME/dzy-platform-data/logs/server.log" | grep -c "jobs 啟動完成"` 期望 ≥1；`grep -c NO_SUCH_FUNCTION "$HOME/dzy-platform-data/logs/server.log"` 期望 0。
4. 對本機 `/platform/health` GET，只取 level 與 reasons，期望 level 不是 red。
5. 回報（Eason 貼回 MacBook）：
```
更新 1 完成
- minikit HEAD：<短 hash>
- 運行中：<是/否>；jobs 啟動：<有/無>；NO_SUCH_FUNCTION：<0 或次數>
- health level：<green/yellow/red>；reasons：<代碼或「無」>
```
