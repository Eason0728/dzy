# 薪酬依負責門市分權限 — 上線步驟（release）

> 依據 `spec.md` §8（部署順序）與 §9（驗收清單）。本檔是「可以貼的版本」。
> 公開 repo：這裡**沒有**真名、金鑰、主機名、試算表 ID、部署 ID。要用到的值一律寫「見 dispatch-resources.md」或「由 Eason 本人在終端機輸入」。
> 做事的人：**【MacBook】**＝Eason 在 MacBook 上貼（或請 MacBook 的 Claude 貼，推 main／clasp 會被 auto mode 擋，要 Eason 自己按）；**【mini】**＝整段貼給 Mac mini 上的 Claude。
> 指令預設 zsh（mini 與 MacBook 都是）。

## 0. 先看這張表

| # | 做什麼 | 在哪 | 做完的人看得到什麼 | 回退 |
|---|---|---|---|---|
| 0 | 盤點誰有薪酬個別例外＋推分支開 PR | mini（唯讀）＋MacBook | 一份「代號＋單位」清單 | 不需要 |
| 1 | 薪資後端 Payroll.gs（clasp） | MacBook | 探針四項過；沒人帶 scope，行為不變 | 重新 redeploy 上一版號 |
| 2 | dzy 後端 → minikit → mini 重啟 | MacBook＋mini | health 版本＝minikit HEAD；admin 照常 | mini `git reset --hard`＋重啟 |
| 3 | dzy 前端 | MacBook | 權限設定出現「薪酬：負責門市」 | revert merge |
| 4 | 薪資頁 payroll.html | MacBook | 輪詢到 `scopeLimited` | revert merge |
| 5 | Eason 在權限設定做三件事 | 瀏覽器 | 財務同仁只看到自己的門市 | 撤銷剛加的例外／規則 |
| 6 | 換管理金鑰 | MacBook＋mini | 舊 `?k=` 連結失效 | 還原舊金鑰（見該步） |

順序不能換，理由（spec §8、§10）：

- 1 在 2 之前：mini 一開始帶 scope，薪資後端就要看得懂；沒看懂的舊版會把 `scope` 當成沒用的欄位忽略（等於沒擋）。
- 2 在 3 之前、3 在 5 之前：權限設定的選項在 3 才出現；**5-① 把薪酬開給整個財務部必須在 2 完成後才做**，否則財務同仁會在沒有門市限制的情況下拿到全集團薪資。
- **從 2 完成那一刻起，Eason 以外原本已開薪酬的人會變成「尚未指派」**，直到 5-② 逐人指定門市。建議挑非發薪週、非月結日的時段，2→5 一口氣做完（約 20 分鐘）。
- 6 不能拖：在換金鑰之前，「沒有 scope 欄位＝不限制」是一個洞（持舊金鑰者仍看得到全部，spec §10）。

三個 repo 的上線內容（本機已全部測過、未 push）：

| repo | 分支 | 內容 commit（完整 sha） |
|---|---|---|
| mala-clock-in | `payroll-scope` | `3a7afa3ebda9df9cde51ed50bff60565aa03608c`（Payroll.gs 守門）、`a4b1e498a67c300b0222e50819533b008713a836`（payroll.html） |
| dzy | `payroll-scope` | `269cb42eb10d9ca1ff6c9dbdd3e9ec0313a12520`（平台後端，**第一段**）、`134a510499ee0b607b5e0dc077f969b69079549e`（前端，第二段）、其後只有文件 |
| dzy-minikit | `payroll-scope` | `8cb53b1f23d0856f8d4a0626a6224a5b04ded9fd`（代轉帶 scope＋gas 同步） |

---

## 步驟 0　事前：盤點＋推分支開 PR

### 0-A　【mini】列出目前有「薪酬管理」個別例外的人（唯讀）

用途：步驟 2 之後這些人會變「尚未指派」；步驟 5-③ 要撤掉不是財務部的人。**只印工號＋單位＋部門，不印姓名**。
正式環境權限資料只在 mini 的 `~/dzy-platform-data/app.db`（個別例外分頁 `perm_ex`、同仁分頁 `staff`；表格存在 `rows` 表，每列是 JSON 陣列）。`sqlite3 -readonly` 不會改任何東西，伺服器開著也能跑。

整段貼給 mini 的 Claude：

```
請做一件唯讀的事，不要改任何檔案、不要重啟任何東西、不要印姓名或金鑰：
列出目前有效的「薪酬管理」個別例外（perm_ex 分頁 perm = payroll.write、mode = add、active = TRUE）。
指令（zsh 可直接貼）：

sqlite3 -readonly -cmd ".timeout 5000" -header -column "$HOME/dzy-platform-data/app.db" <<'SQL'
SELECT upper(json_extract(e.cells_json,'$[1]')) AS emp_no,
       coalesce(json_extract(s.cells_json,'$[5]'),'(無 staff 列)') AS unit,
       coalesce(json_extract(s.cells_json,'$[6]'),'') AS dept,
       CASE WHEN coalesce(json_extract(s.cells_json,'$[6]'),'') = 'fin' THEN '' ELSE '<-- 非財務部，Eason 決定要不要撤' END AS check_revoke,
       coalesce(json_extract(e.cells_json,'$[4]'),'') AS until
FROM rows e
LEFT JOIN rows s ON s.sheet='staff' AND s.r>1 AND upper(json_extract(s.cells_json,'$[0]'))=upper(json_extract(e.cells_json,'$[1]'))
WHERE e.sheet='perm_ex' AND e.r>1
  AND json_extract(e.cells_json,'$[2]')='payroll.write'
  AND lower(json_extract(e.cells_json,'$[3]'))='add'
  AND upper(CAST(json_extract(e.cells_json,'$[6]') AS TEXT)) IN ('TRUE','1')
ORDER BY unit, emp_no;
SQL

把輸出整段貼回來（只有工號、單位代碼、部門代碼、到期日）。若 sqlite3 報「no such table: rows」或回傳 0 列但我知道有人有權限，不要猜，直接把錯誤貼回來。
```

怎麼看結果：`dept` 不是 `fin` 的列＝候選要撤的（5-③）；`until` 有日期的是會自己到期的例外。結果只給 Eason 看，**不要貼進 repo、issue 或 PR**。
（`kit/tools/run-fn.js` 只准 setup／bootstrapAdmin／rescueAdmin 三個函式，不能拿來讀例外表，所以改用唯讀 sqlite。這支查詢的形狀已用本機 runner 的資料庫驗證過：同樣的 `rows`／`cells_json` 結構。）

### 0-B　【MacBook】推三個分支、開 PR

dzy 要拆兩段（第一段只有平台後端，第二段其餘）：

```
# --- mala-clock-in ---
cd ~/mala-clock-in-wt-scope
test "$(git rev-parse HEAD)" = a4b1e498a67c300b0222e50819533b008713a836 && git push -u origin payroll-scope
gh pr create -R Eason0728/mala-clock-in --base main --head payroll-scope --title "薪酬依負責門市分權限：薪資後端守門＋薪資頁" --body "見 dzy docs/payroll-scope/spec.md §4、§6"

# --- dzy-minikit ---
cd ~/dzy-minikit-wt-scope
test "$(git rev-parse HEAD)" = 8cb53b1f23d0856f8d4a0626a6224a5b04ded9fd && git push -u origin payroll-scope
gh pr create -R Eason0728/dzy-minikit --base main --head payroll-scope --title "薪酬代轉強制帶 scope（負責門市）" --body "見 dzy docs/payroll-scope/spec.md §3"

# --- dzy（兩段）---
cd ~/dzy-wt-payscope
git push origin 269cb42eb10d9ca1ff6c9dbdd3e9ec0313a12520:refs/heads/payroll-scope-backend
git push -u origin payroll-scope
gh pr create -R Eason0728/dzy --base main --head payroll-scope-backend --title "薪酬負責門市：平台後端（第一段）" --body "只有 apps-script/platform 與測試；見 docs/payroll-scope/spec.md §1、§2"
gh pr create -R Eason0728/dzy --base main --head payroll-scope --title "薪酬負責門市：權限設定與集團總覽分頁（第二段）" --body "前端；要等第一段合併、mini 更新之後才合併"
gh pr list -R Eason0728/dzy --head payroll-scope-backend   # 記下 PR 號 → 下面叫 <DZY1>；第二段叫 <DZY2>
```

> 合併一律用 `gh pr merge <號> -R Eason0728/<repo> --merge --match-head-commit <完整 40 碼 sha>`；sha 比對失敗代表分支被動過，停下來問 Claude。dzy 第二段的 sha 取 `git -C ~/dzy-wt-payscope rev-parse payroll-scope`（本檔 commit 之後的最新一筆，**每次合併前現場取**）。
> 三個分支目前都能與 main 乾淨合併（2026-10-29 用 `git merge-tree` 驗過）；dzy 第一段合併後，dzy 的 18 個平台 .gs 與 minikit `apps/dzy-platform/gas/` 逐檔相同（已驗），所以 minikit 的測試（會比對 `~/dzy` main）不會因 gas 不一致而紅。

---

## 步驟 1　薪資後端 Payroll.gs（clasp）

目的：讓薪資後端看得懂 `body.scope`。此時沒有人帶 scope（mini 還沒更新），所以**行為完全不變**。
只有光復打卡的 Apps Script 載有薪資模組（薪資 web app＝光復打卡那個部署）。**絕不 `clasp deploy`，只准 `clasp redeploy <既有部署 ID> -V <版本>`**（`-V` 大寫）。部署 ID 見 `~/.claude/mala-ops/dispatch-resources.md`（光復打卡部署）與 mala-payroll skill「部署」節；本檔不寫。
改動只在 `Payroll.gs`（`Code.gs` 沒動），所以只換 `薪資.js`，光復的 `CONFIG`（試算表 ID、管理金鑰）原封不動。

### 1-A　【MacBook】先記下目前版本（回退要用）

```
cd ~/mala-gas/mala-clock-in
clasp deployments            # 找光復打卡那個既有部署（ID 對照 dispatch-resources.md），記下它現在掛的版號 → PREV
clasp versions | tail -3     # 看最新版號，確認 PREV 合理（注意：clasp 列出的部署版號偶爾延遲顯示舊值，以 dispatch-resources.md 記錄的為準）
```

### 1-B　【MacBook】pull、比對、套用、檢查

```
cd ~/mala-gas/mala-clock-in
clasp pull
# 雲端現況應等於 main 的 Payroll.gs（pull 之後、cp 之前）；有差異就停，先問 Claude（可能有未進 git 的雲端補丁，pull 會蓋掉本機補丁）
git -C ~/mala-clock-in-wt-scope show origin/main:apps-script/Payroll.gs | diff -q - 薪資.js && echo "雲端＝main，可以套用"
# 套用 scope 版（來源分支必須是 a4b1e49 以後的 Payroll.gs）
test "$(git -C ~/mala-clock-in-wt-scope rev-parse HEAD)" = a4b1e498a67c300b0222e50819533b008713a836 || echo "分支不是預期的 commit，停"
cp ~/mala-clock-in-wt-scope/apps-script/Payroll.gs 薪資.js
node --check 薪資.js && echo "語法 OK"
diff <(git -C ~/mala-clock-in-wt-scope show origin/main:apps-script/Payroll.gs) 薪資.js | grep -c '^<'   # 應為 0：只有新增行、沒有刪除任何舊行
```

### 1-C　【MacBook】推送、建版本、重新部署（auto mode 會擋，Eason 自己按 Run）

```
clasp push -f
clasp version "薪酬負責門市 scope 守門"        # 印出新版號 → NEW
clasp redeploy <光復打卡既有部署 ID，見 dispatch-resources.md> -V <NEW>
sleep 20    # redeploy 後幾秒內仍可能回舊版（2026-09-03 踩過），探針前先等
```

### 1-D　探針（【MacBook】，唯讀，不印薪資內容）

```
EXEC='https://script.google.com/macros/s/<光復打卡部署 ID，見 dispatch-resources.md>/exec'
KEYF="$HOME/mala-clock-in/deploy-local/ADMIN_KEY.txt"
probe() {   # $1=good|bad  $2=action  $3=額外欄位(JSON)；金鑰從檔案讀、不進命令列、不印出
  python3 - "$1" "$2" "$3" "$KEYF" <<'PY' | curl -sL -X POST "$EXEC" -H 'Content-Type: text/plain' --data-binary @- \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print({k:d.get(k) for k in ("ok","error","detail","scope")})'
import sys, json
mode, action, extra, keyf = sys.argv[1:5]
key = open(keyf).read().strip() if mode == 'good' else 'wrong-key-probe'
b = {'action': action, 'admin_key': key}
b.update(json.loads(extra))
print(json.dumps(b))
PY
}
probe bad  payroll_master_get '{}'
probe good payroll_month      '{"store":"SSLGF","ym":"2026-10","scope":["ZZ"]}'
probe good payroll_master_get '{"store":"SSLGF"}'
probe good payroll_master_get '{"store":"SSLGF","scope":[]}'
```

過關條件（四行輸出依序）：

1. `error: 'unauthorized'`（錯金鑰照舊被擋）。
2. `error: 'scope_forbidden'`（**新版生效的證明**：舊版沒有這個錯誤，會回 ok 或別的錯誤）。
3. `ok: True` 且 `scope: '*'`（沒帶 scope＝舊路，照常；新版多回 `scope` 欄位）。
4. `ok: True` 且 `scope: []`（空名單回空殼）。

任何一項不符：先重跑一次（可能是 redeploy 延遲），仍不符就走回退。

**回退 1**：`clasp redeploy <同一個部署 ID> -V <PREV>`（1-A 記下的舊版號）；再 `sleep 20` 重跑探針 2（應不再是 scope_forbidden）。本步驟沒人帶 scope，回退不影響任何使用者。

---

## 步驟 2　dzy 後端（第一段）→ minikit → Mac mini

### 2-A　【MacBook】合併 dzy 第一段（只有平台後端）

```
gh pr merge <DZY1> -R Eason0728/dzy --merge --match-head-commit 269cb42eb10d9ca1ff6c9dbdd3e9ec0313a12520
cd ~/dzy && git pull --ff-only
```

### 2-B　【MacBook】minikit 合併（gas 與代轉都已在分支上，不必再跑 sync-gas）

分支 `payroll-scope` 已把 `Auth.gs／Perms.gs／StaffClock.gs` 同步進 `apps/dzy-platform/gas/`（`SOURCE.sha256` 已更新），並含 `proxy-hook.js`、`kit/runner/proxy.js` 的 scope 傳遞。合併前先確認 gas 與剛合併的 dzy main 一致：

```
cd ~/dzy-minikit-wt-scope
git fetch origin
for f in apps/dzy-platform/gas/*.gs; do cmp -s "$f" ~/dzy/apps-script/platform/$(basename $f) || echo "不一致：$f"; done   # 應該沒有任何輸出
bash kit/bin/render-docs.sh dzy-platform >/dev/null 2>&1; git status --short   # 應該乾淨
gh pr merge <MK> -R Eason0728/dzy-minikit --merge --match-head-commit 8cb53b1f23d0856f8d4a0626a6224a5b04ded9fd
```

（`<MK>` ＝ 0-B 開的 minikit PR 號。不一致或不乾淨就停，問 Claude。）

### 2-C　【mini】拉、備份、重啟、驗證

整段貼給 mini 的 Claude（不讀 `.env`、不印金鑰；結果不符就停，不要自己修）：

```
請更新 dzy-platform（薪酬負責門市 scope），照順序做，每步把輸出貼回來：

0. 環境與更新前狀態
   export PATH="$HOME/.local/node/bin:$PATH"; cd "$HOME/dzy-minikit"
   git status --short | head -5            # 應該是空的；有東西就停
   BEFORE=$(git rev-parse HEAD); echo "BEFORE=$BEFORE"     # 回退用，請貼回來
   git fetch origin && git log --oneline HEAD..origin/main  # 即將進來的 commit；應包含「薪酬代轉強制帶 scope」那一筆，其餘請逐行貼回來讓我確認

1. 備份（SQLite 一致性備份，不是 cp）
   mkdir -p "$HOME/dzy-minikit-work"; chmod 700 "$HOME/dzy-minikit-work"
   B="$HOME/dzy-minikit-work/dzy-platform-before-payscope.db"
   sqlite3 "$HOME/dzy-platform-data/app.db" ".backup '$B'" && shasum -a 256 "$B" > "$B.sha256" && shasum -a 256 -c "$B.sha256"
   # 預期最後一行 OK；備份檔路徑貼回來

2. 拉新版
   git pull --ff-only && git log --oneline -1
   HEADSHORT=$(git rev-parse --short HEAD); echo "HEAD=$HEADSHORT"
   cd apps/dzy-platform && shasum -a 256 -c gas/SOURCE.sha256 | grep -vc ": OK"      # 應為 0
   grep -c "payroll.store@" gas/Perms.gs                                              # 應 ≥ 1
   grep -c "scope" proxy-hook.js                                                       # 應 ≥ 1
   cd "$HOME/dzy-minikit"

3. 重啟（約 2 秒停機；dzy-platform 是 start.sh 開的手動重啟迴圈，用 stop.sh／start.sh，不要用 kill）
   bash kit/bin/stop.sh apps/dzy-platform && bash kit/bin/start.sh apps/dzy-platform && sleep 3 && bash kit/bin/status.sh apps/dzy-platform
   # 預期：運行中

4. 驗證
   curl -s http://127.0.0.1:8799/platform/health
   # 預期：level 是 green、version 的值等於上面的 HEAD 短 hash
   grep -c NO_SUCH_FUNCTION "$HOME/dzy-platform-data/logs/server.log"     # 預期 0
   curl -s -XPOST http://127.0.0.1:8799/platform/proxy -H 'Content-Type: text/plain' -d '{"ns":"payroll","action":"payroll_month","payload":{}}'
   # 預期：{"ok":false,"error":"NO_TOKEN","code":"NO_TOKEN"}（不帶 token 的標準回應；若回的句子不一樣請原樣貼回來，不要猜）

5. 回報格式（貼回 MacBook）
   dzy-platform scope 更新完成
   - BEFORE：<完整 hash>；HEAD：<短 hash>
   - 備份檔：<路徑>；shasum -c：<OK>
   - SOURCE.sha256 非 OK 行數：<0>
   - 運行中：<是/否>；health level：<green/yellow/red>；version：<短 hash>；NO_SUCH_FUNCTION：<0 或次數>
```

### 2-D　【Eason 瀏覽器】admin 煙霧測試

登入管理系統（Eason 是 admin）→ 薪酬管理：門市下拉有全部門市、頁頂有「集團總覽」、能看到本月資料。這代表 mini 帶的是 `'*'`、薪資後端（步驟 1）認得。**打不開、或每個畫面都跳錯誤＝立刻走回退 2**。

**回退 2**（mini，貼給 mini 的 Claude）：

```
export PATH="$HOME/.local/node/bin:$PATH"; cd "$HOME/dzy-minikit"
git reset --hard <步驟 2-C 的 BEFORE 完整 hash>
bash kit/bin/stop.sh apps/dzy-platform && bash kit/bin/start.sh apps/dzy-platform && sleep 3 && bash kit/bin/status.sh apps/dzy-platform
curl -s http://127.0.0.1:8799/platform/health     # level 應為 green，version＝BEFORE 的短 hash
```
資料沒有被這次更新改動（新版只讀個別例外、不寫新欄位），一般不需要還原備份檔；若資料有疑慮，照 `~/dzy-minikit/apps/dzy-platform/ROLLBACK.md` 還原步驟 2-C 做的備份。
⚠ **若已做過步驟 5-①（把薪酬開給整個財務部）**，回退 mini 之前要**先**到權限設定把那條規則關掉——舊版 mini 不帶 scope，財務同仁會變成可看全集團。

---

## 步驟 3　dzy 前端（第二段）

前提：步驟 2 已完成且 2-D 通過（前端新增的「薪酬：負責門市」選項是寫 `payroll.store@<店碼>` 例外，後端要先認得）。

```
cd ~/dzy-wt-payscope && git fetch origin
SHA=$(git rev-parse payroll-scope); echo $SHA        # 完整 40 碼
gh pr merge <DZY2> -R Eason0728/dzy --merge --match-head-commit "$SHA"
# 等 GitHub Pages 發布（約 1～2 分鐘），輪詢到新版檔案出現：
until curl -s "https://dzy.mozhuting.com/modules/perms/lib.js?t=$RANDOM$RANDOM" | grep -q payrollStoreCode; do sleep 10; done; echo "dzy 前端已上線"
```

上線後：同仁電腦／手機若載到舊 JS，重新整理（Cmd+Shift+R）或等快取過期。
**回退 3**：`git revert -m 1 <第二段 merge commit>` 開 PR 合併（只退前端；已寫入的 `payroll.store@` 例外留著無害——沒有前端選項，但後端照樣依它給 scope）。

---

## 步驟 4　薪資頁 payroll.html（mala-clock-in）

```
gh pr merge <PAY> -R Eason0728/mala-clock-in --merge --match-head-commit a4b1e498a67c300b0222e50819533b008713a836
until curl -s "https://eason0728.github.io/mala-clock-in/payroll.html?t=$RANDOM$RANDOM" | grep -q scopeLimited; do sleep 10; done; echo "薪資頁已上線"
```

（`<PAY>` ＝ 0-B 開的 mala-clock-in PR 號。）
2→4 之間薪資頁仍是舊版：財務同仁（若已被開通）看得到「集團總覽」分頁，但按下去後端回 `scope_forbidden`，不會外洩（spec §8）。
**回退 4**：`git revert -m 1 <merge commit>` 開 PR 合併。舊頁面配新後端：舊頁不認得 `scope_forbidden`，限制門市的同仁會看到一般錯誤訊息；admin 不受影響。

---

## 步驟 5　Eason 在權限設定做三件事（瀏覽器，管理系統 → 權限設定）

前提：步驟 2、3 都完成。依序：

1. **打開「總部・財務部・全部職稱 → 薪酬管理」**（對照表，`payroll.write` 是鎖碼，只有 admin 能開）。⚠ 這一步一做，整個財務部都進得了薪酬管理，所以必須在步驟 2 之後、且接著做 ②，否則這些人在 ② 之前只會看到「尚未指派」（安全，但不能用）。
2. **逐人新增「薪酬：負責門市」**（個別例外 → 新增 → 權限選「薪酬：負責門市」→ 選門市 → 儲存；一次一家，負責多家就新增多筆）。每位財務同仁要負責哪些門市，由 Eason 決定。
3. **撤銷「非財務部」同仁的薪酬個別例外**：名單用 0-A 那份（`check_revoke` 欄標出的）。在個別例外清單找到該人的「薪酬管理」那筆 → 撤銷。

驗收（spec §9，用一個財務同仁測試帳號，或 Eason 暫時對自己以個別例外試）：

- [ ] 只負責央廚的人：門市選單只有央廚；頁頂沒有「集團總覽」；參數卡「只套用到目前門市」勾起且鎖住；門市設定與紅字同步看不到。
- [ ] 同一人在瀏覽器主控台送 `store:'SSLGF'` 的 payroll_month／payroll_master_set／payroll_calc → 全部 `scope_forbidden`；送 `payroll_group`、`payroll_get`、`payroll_store_set`、`payroll_holiday_sync`、集團預設參數 → 全部擋。
- [ ] 回應裡找不到 `clock_ss_id`、找不到負責門市以外的店碼。
- [ ] 沒被指派任何門市的財務同仁 → 只看到「尚未指派負責門市」。
- [ ] 非財務部、沒有個別例外的同仁 → 左側沒有薪酬管理。
- [ ] Eason（admin）→ 與現在完全相同（所有門市、集團總覽、門市設定、紅字同步）。
- [ ] 人資主管在權限設定看不到「薪酬：負責門市」選項。

**回退 5**：把 ①的規則關掉、撤銷 ② 新增的例外（權限設定都有異動紀錄）。

---

## 步驟 6　換管理金鑰（Q1 A）

目的：讓「沒有 scope 欄位＝不限制」這條舊路只剩 mini 持有金鑰（mini 一定帶 scope）。換完，舊 `payroll.html?k=` 連結失效。
範圍：薪資 web app 是光復打卡部署，**必須換的是光復那一把**（`deploy-local/ADMIN_KEY.txt`＝光復 `程式碼.js` 的 `CONFIG.ADMIN_KEY`）。央廚、總部後端各有自己的金鑰與部署，本案不必動它們（已知取捨：它們不經 mini 代轉、本來就只含該店資料）。**換之前請先與 Claude 確認 CF／HQ 是否也載有 Payroll.gs 並被別的路徑使用；不確定就先不動它們。**
⚠ 連動：mala-fortune 的 GitHub secret `CLOCK_ADMIN_KEY_GF`（指揮台「今天新增了誰」）——最容易漏，漏了會靜靜失效、不報錯。
⚠ auto mode 會把「換金鑰部署」判成 Production Deploy，clasp 那幾行由 Eason 自己按 Run。
⚠ 從 6-D 部署完成到 6-E mini 換好之間，管理系統的薪酬管理會回「通行碼錯誤」（代轉帶舊金鑰）；挑非營業尖峰，兩段連著做（約 5 分鐘）。

### 6-A　【MacBook】產新金鑰（不印出來），備份舊的

```
cd ~/mala-clock-in/deploy-local
umask 077
cp ADMIN_KEY.txt "ADMIN_KEY.txt.old-$(date +%Y%m%d)"        # 回退用，勿進 git（deploy-local 已 gitignore）
openssl rand -hex 24 | tr -d '\n' > ADMIN_KEY.txt.new
wc -c ADMIN_KEY.txt.new                                       # 應為 48
```

### 6-B　【MacBook】列出舊金鑰還有哪些地方在用（五處清單，不印金鑰）

```
OLD="$(cat ADMIN_KEY.txt)"
grep -rlF -- "$OLD" ~/mala-gas ~/mala-clock-in/deploy-local ~/Desktop/claude 2>/dev/null | grep -v '\.old-'
```
預期至少：`deploy-local/ADMIN_KEY.txt`、光復 `程式碼.js`（`CONFIG.ADMIN_KEY`）、重產過的部署檔（`Code-部署用-*.gs`、`月結對帳` 腳本讀 txt 不用改）。**這份清單就是要改的地方**；mala-playbook 的 skill 說「換一把要同步改五個地方」，逐項對：①deploy-local 的 txt（含 CF／HQ 只有在要換它們時才動）②重產部署檔（`grep -c PASTE_` 必須 0，貼佔位版＝全站打卡回 server_error）③光復 clasp push→version→redeploy ④mala-fortune 的 `CLOCK_ADMIN_KEY_GF` ⑤Eason 與會計手上的 `payroll.html?k=` 連結（換完會失效，改走管理系統）。

### 6-C　【MacBook】把新金鑰寫進光復 `程式碼.js`（只改 CONFIG.ADMIN_KEY 那一行）

```
cd ~/mala-gas/mala-clock-in && clasp pull
cp 程式碼.js /tmp/程式碼.js.before-key
python3 - <<'PY'
import re, pathlib
p = pathlib.Path('程式碼.js'); s = p.read_text(encoding='utf-8')
old = open(pathlib.Path.home()/'mala-clock-in/deploy-local/ADMIN_KEY.txt').read().strip()
new = open(pathlib.Path.home()/'mala-clock-in/deploy-local/ADMIN_KEY.txt.new').read().strip()
assert s.count(old) == 1, '舊金鑰在 程式碼.js 出現次數不是 1：' + str(s.count(old))
p.write_text(s.replace(old, new), encoding='utf-8')
PY
diff /tmp/程式碼.js.before-key 程式碼.js | sed -E "s/(ADMIN_KEY[:=] *['\"])[^'\"]+/\1«遮蔽»/" ; node --check 程式碼.js && echo "語法 OK"
# diff 應該恰好一行被換（左右各一行、都只有 ADMIN_KEY）；不是就停
rm /tmp/程式碼.js.before-key
```

### 6-D　【MacBook】部署（Eason 自己按 Run）

```
clasp push -f
clasp version "換管理金鑰"                                    # → NEW2
clasp redeploy <光復打卡既有部署 ID，見 dispatch-resources.md> -V <NEW2>
```

### 6-E　【mini】換 mini 的金鑰（Eason 在 mini 自己開終端機操作，Claude 不經手金鑰）

dzy-platform 必須先停（工具會檢查；只印指紋＝SHA-256 前 8 碼）。新金鑰從 MacBook 取：`cat ~/mala-clock-in/deploy-local/ADMIN_KEY.txt.new`（在自己的終端機看，別貼進對話），到 mini 的終端機貼上。

```
export PATH="$HOME/.local/node/bin:$PATH"; cd "$HOME/dzy-minikit"
bash kit/bin/stop.sh apps/dzy-platform
node apps/dzy-platform/set-payroll-secret.js          # 依提示貼新金鑰兩次（不回顯）；記下印出的指紋
bash kit/bin/start.sh apps/dzy-platform && sleep 3 && bash kit/bin/status.sh apps/dzy-platform
curl -s http://127.0.0.1:8799/platform/health          # level green
```

MacBook 上對一下指紋：`printf %s "$(cat ~/mala-clock-in/deploy-local/ADMIN_KEY.txt.new)" | shasum -a 256 | cut -c1-8`，要與 mini 印的相同。

### 6-F　【MacBook】更新 GitHub secret、定案檔案、驗證

```
gh secret set CLOCK_ADMIN_KEY_GF -R Eason0728/mala-fortune < ~/mala-clock-in/deploy-local/ADMIN_KEY.txt.new     # 從檔案讀入，不出現在命令列
cd ~/mala-clock-in/deploy-local && mv ADMIN_KEY.txt.new ADMIN_KEY.txt
# 若 6-B 清單有「重產部署檔」：用新金鑰重產（照 mala-clock-in skill 的產法），grep -c PASTE_ 必須 0
```

驗證（改用 1-D 的 `probe` 函式；KEYF 現在指向新金鑰）：

```
probe bad  payroll_master_get '{"store":"SSLGF"}'     # 預期 unauthorized
probe good payroll_master_get '{"store":"SSLGF"}'     # 預期 ok: True（新金鑰有效）
```
再看：管理系統薪酬管理能開（代轉帶新金鑰）；舊 `?k=<舊金鑰>` 連結顯示「已搬進管理系統」或驗證失敗；指揮台隔天早上的「今天新增了誰」照常（或手動觸發 mala-fortune 指揮台 workflow 看）。
最後確認沒有殘留：`grep -rlF -- "$OLD" ~/mala-gas ~/mala-clock-in/deploy-local 2>/dev/null | grep -v '\.old-'` 應該沒有輸出；舊金鑰備份檔 `ADMIN_KEY.txt.old-*` 在確認一週沒事後刪除。

**回退 6**：`cd ~/mala-clock-in/deploy-local && cp ADMIN_KEY.txt.old-<日期> ADMIN_KEY.txt`；光復 `程式碼.js` 的 ADMIN_KEY 換回舊值（同 6-C，方向相反）→ clasp push／version／redeploy；mini 再跑一次 `set-payroll-secret.js` 貼回舊值；`gh secret set CLOCK_ADMIN_KEY_GF` 也換回。不要只回退其中一邊。

---

## 附：本機三層實測做了什麼、沒做什麼

見 `progress.md` 的「本機整合實測」一節，以及 `.superpowers/sdd/plan/task-6-report.md`（逐項證據）。
