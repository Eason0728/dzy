# 交辦給 Mac mini 上的 Claude：組織架構改版（換管理系統後端）

（Eason 整段貼給 mini 的 Claude。本文不含網址、金鑰；那些值只在 mini 本機。）

## 背景
- 管理系統平台後端新增：組織改版（品牌辦公室、兼任部門、新審核規則）、BOSS 專用的「切換組織」「退回組織」。
- **新程式對現有資料完全相容**：換上後什麼都不會自己改，要等 Eason 用 BOSS 帳號在網頁按「切換組織」才會動組織表。
- 本次只重啟 `dzy-platform` 一個系統（約 10 秒無法登入管理系統）；耗損、調撥、其他系統不動。

三條硬規則：
- **你不讀、不印任何金鑰與網址**；不要 cat `.env`，`.env` 一個字都不改。
- **不要呼叫 orgUpgrade2026／orgRollback2026**（那是 Eason 在網頁上按的）。
- 任何一步和「期望」不同：把現象貼給 Eason，**停**，不要自己修。

## 步驟
1. **更新 minikit。**
   `cd ~/dzy-minikit && git pull --ff-only && git log --oneline -3`
   期望：fast-forward 成功。
   `grep -c "orgUpgrade2026" apps/dzy-platform/gas/Code.gs apps/dzy-platform/gas/Staff.gs` → 兩檔都 ≥1。
   `grep -c "extra_depts" apps/dzy-platform/gas/StaffClock.gs` → ≥1。

2. **先備份資料庫（只複製，不改）。**
   ```
   D="$HOME/dzy-platform-data"; cp -p "$D/app.db" "$D/app.db.bak-org-20261014" && ls -l "$D"/app.db*
   ```
   期望：多一個 `app.db.bak-org-20261014`，大小與 app.db 相同。（若有 `app.db-wal`／`-shm` 一併照樣複製。）

3. **重啟 dzy-platform（殺 node，重啟迴圈 5 秒內用新程式拉起）。**
   ```
   export PATH="$HOME/.local/node/bin:$PATH"; DATA="$HOME/dzy-platform-data"
   OLD=$(cat "$DATA/server.pid"); kill "$OLD"; sleep 8; NEW=$(cat "$DATA/server.pid"); echo "舊 $OLD 新 $NEW"
   curl -s -m 5 http://127.0.0.1:8799/platform/health | head -c 200; echo
   ```
   期望：新舊 pid 不同；health 的 level 不是 red。

4. **驗證新程式在線（不帶 token，只看錯誤字樣）。**
   ```
   curl -s -m 5 -XPOST http://127.0.0.1:8799/platform/api -d '{"action":"orgUpgrade2026","payload":{"dryrun":true}}' | head -c 200; echo
   tail -n 40 "$HOME/dzy-platform-data/logs/server.log" | grep -cE "NO_SUCH_FUNCTION|ReferenceError|SyntaxError"
   grep -cE "https://|svc_key|CLOCK_KEY" "$HOME/dzy-platform-data/logs/server.log"
   ```
   期望：第一行是「未登入／token」類錯誤，**不是**「未知的 action／不支援」；後兩個數字是 0。

5. **回報。** 請 Eason 把下面整段貼回 MacBook 的 Claude：
```
組織改版後端換好
- minikit HEAD：<短 hash>
- 資料庫備份：<有／沒有>
- 重啟：舊 pid <> 新 pid <>；health <綠/黃/紅>
- orgUpgrade2026 無 token 回應：<前 80 字>
- log 錯誤字樣：<0 或次數>；log 含網址或金鑰：<0 或次數>
- 卡住的步驟：<編號與現象，或「無」>
```

## 回退（只有 Eason 說要退才做）
`cd ~/dzy-minikit && git log --oneline -5` 找本次同步前的 commit，`git revert --no-edit <本次同步 commit>` 後照第 3 步重啟。資料庫不用還原（新程式在 Eason 按「切換組織」之前不寫任何組織資料）。
