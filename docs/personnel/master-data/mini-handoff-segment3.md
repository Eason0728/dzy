# 交辦給 Mac mini 上的 Claude：員工名單統一第 3 段（只讀上線）

（Eason 整段貼給 mini 的 Claude。本文不含網址、金鑰、試算表 ID；那些值只在 mini 本機的 `.env`。）

## 背景
員工名單統一分段上線：
- 第 1 段（已完成，2026-10-14）：六家店打卡後端多了給管理系統用的服務端點，沒設鑰匙前一律拒絕。
- 第 2 段（Eason 已在 mini 終端機跑過一行指令）：`~/dzy-minikit/apps/dzy-platform/.env` 已有六店的 `CLOCK_URL_*`、`CLOCK_KEY_*` 與 `CLOCK_WRITE=0`；六店打卡程式也各自設好 `STAFF_SVC_KEY`。
- **本段（第 3 段）**：mini 換上新版管理系統後端（多了同步員 `jobs.js` 與 `StaffClock.gs`），以**只讀模式**每天同步六店打卡名冊。MacBook 已把程式合併進 minikit 的 main 並同步好 gas，你只要 pull、重啟、驗證。

三條硬規則：
- **你不讀、不印任何金鑰與網址。**驗證只看數字或代碼。不要 cat `.env`。
- **`CLOCK_WRITE` 保持 0。**本段不開寫入。
- 任何一步結果和「期望」不同：把現象貼給 Eason，**停**，不要自己修。

## 步驟
1. **確認 .env 已就緒（只數行數）。**
   `cd ~/dzy-minikit/apps/dzy-platform && for v in GF MZTJS MZTGF MZTLZL HQ CF; do printf "$v url=%s key=%s\n" $(grep -c "^CLOCK_URL_$v=https" .env) $(grep -c "^CLOCK_KEY_$v=." .env); done; grep -c '^CLOCK_WRITE=0$' .env; ls -l .env | awk '{print $1}'`
   期望：六行都是 `url=1 key=1`、`CLOCK_WRITE` 那行印 1、權限 `-rw-------`。

2. **更新 minikit。** `cd ~/dzy-minikit && git pull --ff-only && git log --oneline -3`。期望：fast-forward 成功，看得到「員工名單統一」相關提交。`grep -o StaffClock apps/dzy-platform/app.json | wc -l` 期望 2、`ls apps/dzy-platform/gas/StaffClock.gs` 存在。

3. **重啟平台後端。**
   `export PATH="$HOME/.local/node/bin:$PATH"; cd "$HOME/dzy-minikit" && bash kit/bin/stop.sh apps/dzy-platform && bash kit/bin/start.sh apps/dzy-platform && sleep 3 && bash kit/bin/status.sh apps/dzy-platform`
   期望：運行中。

4. **確認同步員啟動。** `tail -n 40 "$HOME/dzy-platform-data/logs/server.log" | grep -c "jobs 啟動完成"` 期望 ≥1；`grep -c "NO_SUCH_FUNCTION" "$HOME/dzy-platform-data/logs/server.log"` 期望 0。

5. **既有功能沒壞。** 請 Eason 用自己的帳號登入管理系統一次、開「同仁名單」，畫面正常即可（新畫面要等本段結束後 MacBook 才推，現在看到的仍是舊畫面，這是正常的）。

6. **驗證同步員（只看數字或代碼）。**
   - 對本機 `/platform/health` 發 GET（`curl -s -m 5`），只取 `level` 與 `reasons`：期望 level 不是 red。
   - 路由守門：對本機 `/platform/svc/auto-support` POST `{}`，期望回應含 `unauthorized`。
   - 開機補跑：當天 00:10 已過時，啟動後會補跑一次每日同步。等 2 分鐘後 `grep -c "daily store=" "$HOME/dzy-platform-data/logs/server.log"`，期望 ≥6（六店各一行）；有非 ok 的，只貼店代碼與錯誤代碼。
   - log 不得含金鑰或網址：`grep -cE "https://|CLOCK_KEY|svc_key" "$HOME/dzy-platform-data/logs/server.log"` 期望 0。

7. **回報。** 請 Eason 把下面整段貼回 MacBook 的 Claude：
```
第 3 段完成
- minikit HEAD：<短 hash>
- health level：<green/yellow/red>；reasons：<代碼或「無」>
- 六店每日同步：<gf/mztjs/mztgf/mztlzl/hq/cf 各 ok 或錯誤代碼>
- jobs 啟動：<有/無>；NO_SUCH_FUNCTION：<0 或次數>
- auto-support 守門：<unauthorized/其他>
- log 含網址或金鑰：<0 或次數>
- 卡住的步驟：<編號與現象，或「無」>
```
