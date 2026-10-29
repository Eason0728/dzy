# 上線步驟：財務部改人資核＋兼任店長（2026-10-29）

規格：同資料夾 spec.md（v1.0，Eason 1A 2A 3B 4B）。公開 repo，不寫同仁真名。

## 相依與順序
- 前端（權限設定「兼任店長」選項）只有在後端回 `acting_units` 時才出現 → **前端先上也不會壞**（選項不顯示而已）；後端先上也不會壞（舊前端不認得新欄位）。
- dzy-minikit 的測試會比對 minikit gas 與 dzy main 的 .gs 要一樣 → **dzy PR 先合、minikit PR 後合**。
- 財務部的新規則在 Mac mini 更新、重啟後立刻生效（財務總監的考勤名單變空、選單消失）；沒有開關。

## 步驟 1　合併兩個 PR（Eason 在 MacBook；auto mode 不讓 Claude 合 main）
照順序貼（先取完整 sha 防止合到別人後來推的東西）：
```
gh pr merge <dzy PR 號> -R Eason0728/dzy --merge --match-head-commit "$(gh pr view <dzy PR 號> -R Eason0728/dzy --json headRefOid -q .headRefOid)"
gh pr merge <minikit PR 號> -R Eason0728/dzy-minikit --merge --match-head-commit "$(gh pr view <minikit PR 號> -R Eason0728/dzy-minikit --json headRefOid -q .headRefOid)"
```

## 步驟 2　Mac mini（整段貼給 mini 的 Claude）
```
請更新 Mac mini，照順序做，每步把輸出貼回來：
1. ~/dzy-minikit/kit/bin/update-all.sh --dry-run
   計畫裡 dzy-platform 應該要更新（含 dzy-minikit「財務部改人資核＋兼任店長」那個 PR）。若計畫裡還有其他系統一起更新，先把清單貼回來給我看，不要直接跑。
2. ~/dzy-minikit/kit/bin/update-all.sh
   結束碼要是 0。把最後的結果段落貼回來（~/dzy-update/last-run.txt）。
3. 確認新版程式真的在：
   cd ~/dzy-minikit/apps/dzy-platform && grep -c "store.sm@" gas/Perms.gs && shasum -a 256 -c gas/SOURCE.sha256 | grep -vc ": OK"
   第一個數字應為 3，第二個應為 0。
出事：update-all.sh 失敗會自動退回（結束碼 2）；要手動退回就把 dzy-minikit 回到更新前的 commit 再跑一次 update-all.sh。
```

## 步驟 3　人資設定「兼任店長」（人資主管或 Eason 在管理系統操作）
1. 打開 https://dzy.mozhuting.com/ ，按 Cmd+Shift+R 強制重新整理，用人資主管（或 admin）帳號登入。
2. 左側選單「資訊部門」→「權限設定」→ 上方分頁「個別例外」。
3. 「新增個別例外」表單：
   - 同仁（編號或姓名）：輸入兼任者的姓名或 DZY 編號，從下拉選他。
   - 功能：選最下面的「兼任店長」。
   - 「兼任哪一家店的店長」：選「墨竹亭 台北六張犁」。
   - 多給或拿掉：會自動鎖在「多給」。
   - 到期日：建議填（例如一個月後）；空白＝不到期。
   - 原因：例如「兼任六張犁店長」。
   - 按「新增例外」，下方清單會多一筆「多給 兼任店長（墨竹亭 台北六張犁）」。
4. 請兼任者登出再登入管理系統（或按 Cmd+Shift+R）。左側會多「考勤管理」「排班管理」「門市營運」。「我的資料」裡也會多「待審核」。
5. 兼任結束：同一頁清單找到那筆 → 按「撤銷」。下一次操作就失效；門市營運系統最多 5 分鐘內跟上。

## 步驟 4　上線後檢查（Eason 或人資，5 分鐘）
- 兼任者 →「考勤管理」→ 換店選「六張犁」：「核定工時」看得到六張犁同仁，但看不到他自己。「申請審核」看得到計時、正職送的單。
- 財務總監登入：左側沒有「考勤管理」，其他選單照舊。
- 人資主管 →「考勤管理」：看得到財務部同仁的工時和申請。
- 人資主管首頁：「值班主管的申請找不到上層」提醒的人數，跟上線前一樣（這次改動不會讓它變多或變少）。

## 退回
- 只撤兼任：步驟 3 第 5 點，按撤銷。
- 整包退回：GitHub 上 revert 兩個 PR（先 minikit、再 dzy），mini 再跑一次 update-all.sh。
