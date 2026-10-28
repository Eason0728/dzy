# 晨報：值班主管本人的申請改由上層審（2026-10-28 09:50）

## 三行結論
1. 程式全部做完並通過審查：打卡六店、管理系統、Mac mini 同步員、門市營運系統四邊都改好，測試全綠；Fable 兩輪審查找到的 8 條都修了，複驗沒有新的中高問題。Codex 整晚撞額度（現在要到 13:05 才恢復），所以只有 Fable 單邊審。
2. **還沒上線**：自動模式擋住了「部署打卡後端」和「合併 PR」，沒有繞過。下面每一步都是你在 MacBook 貼一行指令。
3. 上線後也**不會馬上擋人**：新增的總開關預設關，要等 Mac mini 每晚同步過一次、你確認名單對了，才在 mini 打開。打開之前，所有主管的行為跟今天一樣。

## 上線順序（照順序做，每步都可以停）

### 步驟 1　六店打卡後端（MacBook 終端機，一店一行；先總部）
每行先只檢查、再加 `--go` 才真的部署。腳本會：三方比對（雲端＝服務中＝本機）→ 只換 Requests.js、SvcStaff.js → 推、建版、改部署 → 拉回逐檔比 → 複製回 ~/mala-gas → 探針確認。看到 `✓ [店] @版號 上線並確認` 才做下一店；看到 `✗` 就停下來把那行貼給我。
```
python3 ~/mala-clock-liff/deploy/deploy_upper.py hq 58172e1 50806ba --go
python3 ~/mala-clock-liff/deploy/deploy_upper.py mztlzl 58172e1 50806ba --go
python3 ~/mala-clock-liff/deploy/deploy_upper.py mztgf 58172e1 50806ba --go
python3 ~/mala-clock-liff/deploy/deploy_upper.py mztjs 58172e1 50806ba --go
python3 ~/mala-clock-liff/deploy/deploy_upper.py cf 58172e1 50806ba --go
python3 ~/mala-clock-liff/deploy/deploy_upper.py gf 58172e1 50806ba --go
```
（09:30 我已用只檢查模式跑過六店：全部三方一致。服務中版本：總部 @43、央廚 @41、金山 @29、墨竹亭光復 @23、六張犁 @20、光復 @165。若你部署前有別的對話推了打卡後端，腳本會停下來，不會蓋掉。）
開關沒開，所以部署後同仁和主管看不到任何差別。

### 步驟 2　合併 PR（GitHub 上按 Merge，或貼下面四行；照順序）
```
gh pr merge 9 -R Eason0728/mala-clock-in --merge
gh pr merge 49 -R Eason0728/dzy --merge
gh pr merge 36 -R Eason0728/dzy-minikit --merge
gh pr merge 30 -R Eason0728/mala-store-ops --merge
```
- mala-clock-in#9：值班核定頁（GitHub Pages 一分鐘內上線）。開關關著時畫面不變。
- dzy#49：管理系統。前端的新提醒在 Mac mini 還沒更新前讀不到資料，會安靜略過，不會出錯。**要排在 dzy-minikit#36 前面**（mini 的測試會比對兩邊後端程式要一樣）。
- dzy-minikit#36：Mac mini 程式，合併後還要步驟 3 在 mini 拉下來才生效。
- mala-store-ops#30：門市營運系統的「值班主管本人／送上層審核中」標示。網站要等步驟 4 開開關前再發布。

### 步驟 3　Mac mini 交辦（整段貼給 mini 的 Claude）
```
請更新兩個系統，照順序做，每步把輸出貼回來：
1. 備份：cd ~/dzy-platform-data && sqlite3 *.db ".backup /tmp/dzy-platform-before-req-upper.db"（照你平常備份的方式即可，告訴我備份檔路徑）
2. dzy-platform：cd ~/dzy-minikit && git pull --ff-only && git log --oneline -1
   應包含 PR #36（req-upper）。在 apps/dzy-platform 底下跑：shasum -a 256 -c gas/SOURCE.sha256 | grep -vc ": OK"（應為 0）
   照 ~/dzy-minikit/START.txt 重啟 dzy-platform（約 2 秒停機），確認 health green。
3. 驗新版：不帶 token 打 curl -s -XPOST http://127.0.0.1:8799/platform/api -H 'Content-Type: text/plain' -d '{"action":"attUpperGaps"}'
   應回「登入已失效，請重新登入」（平台沒帶 token 的標準回應，不會出現 unauthorized 這個字；舊版回「不支援的操作」）。
4. 門市營運系統：cd ~/dzy-store && git pull --ff-only && git log --oneline -1（應包含 mala-store-ops PR #30），照 ~/dzy-store-data/START.txt 重啟，確認 health green。
5. .env 不要加 REQ_UPPER_ON（先不開）。今晚 00:10 每日同步會第一次把「誰是值班主管」從六店帶回來。
出事退回：dzy-platform 回到 pull 前的 commit（git reset --hard <步驟 2 前的 hash>）再照 START.txt 重啟；備份檔還原照 ROLLBACK.md。
```

### 步驟 4　明天（10/29）早上檢查，沒問題再開開關
請 mini 的 Claude 貼：
```
在 dzy-platform 的同步員記錄裡找今晚 00:10 那次每日同步中含 mgr_warn、req_upper、svc_set_upper 的行，貼最後 30 行（記錄檔位置照 ~/dzy-minikit/START.txt；不確定就先問我）
（看 health reasons 有沒有 req_upper_unmapped、clock_mgr_warn、req_upper_push_failed）
```
- `no_match`／`same_name`：某店主管名單裡的姓名對不到名冊或同名 → 到那家店打卡試算表 `managers` 分頁，在最右邊新增一欄 `emp_id`，填他的工號。
- `no_acting_row`：那家店沒有「營運系統專用」那列主管鑰匙 → 上層在營運系統核不了 → 開開關前要先補（找我）。
- `req_upper_unmapped`：有值班主管在管理系統沒有打卡對照 → 到「同仁名單」補對照；沒補的話，他的單在開開關後沒人核得到。
- 管理系統首頁（人資主管登入）若出現「N 位值班主管的申請找不到上層」，同上處理。

都乾淨之後開開關：
1. 發布營運系統網站（只發這次的兩個檔）：請我做，或照 dzy-store-ops skill 的 rsync 步驟。
2. mini `.env` 加一行 `REQ_UPPER_ON=1`，重啟 dzy-platform。**下一次 00:10 同步**時六店才會開始擋。
3. 建議開之前跟各店值班主管講一聲：「自己的加班、請假、忘打卡單，以後由區督導（或總監）在管理系統考勤管理審。」

緊急關閉：mini `.env` 改 `REQ_UPPER_ON=0` 等下次同步；要立刻關，就到那家店的 Apps Script →「專案設定」→「指令碼屬性」刪掉 `REQ_UPPER_ON`。

## 審查找到並修掉的問題（Fable 兩輪；Codex 額度沒恢復）
1. 營運系統「門市帳號（舊路）」登入時不帶核定人姓名，主管可以用店帳號核自己的單 → 改成一定要帶核定人姓名才放行。
2. 值班主管在管理系統沒有打卡對照時，開開關後沒人核得到 → 首頁提醒＋mini 健康檢查會報。
3. 「個別例外」給的考勤權限，會讓同店值班主管互核 → 排除。
4. 值班核定頁「作廢」鈕沒停用（只靠後端擋）→ 停用並寫「送上層處理」。
5. mini 沒記錄「主管姓名對不到名冊／同名」→ 進記錄與健康檢查，不寫姓名。
6. 打卡先上、開關先開會讓正職兼值班仍給同店店長核 → 開關改由 mini 在管理系統同步成功後才推。
7. 支援帳號：值班主管到別店支援時，那家店的店長仍能核 → 改成往上給。
8. 對照表加欄時，舊表要先跑設定才會補表頭 → 改成自動補，表頭不對就不寫。
另外我自己加的：某店沒有「營運系統專用」鑰匙列時 mini 會報 `no_acting_row`。

沒修（低）：DZY 已停用但打卡還在職的值班主管，不會被列進「找不到上層」（由既有的「離職但打卡在職」提醒處理）。

我替你決定的事：
- 加了總開關、預設關（理由：mini 那段沒上之前，打卡端單獨擋會讓正職兼值班的單只能給店長核，而且沒有營運系統專用鑰匙列的店會整店卡住）。要直接開跟我說。
- Codex 等到 09:19 仍撞額度，改由新的 Fable 做第二輪複驗代替交叉驗證。

## 收尾三段
- 還沒做：步驟 1–4 都等你；Codex 13:05 後可以補審（要的話說一聲）；mala-clock-in、dzy-admin 兩支 skill 已更新並 commit ~/.claude。
- 等你動手：步驟 1（MacBook 六行）→ 步驟 2（四個合併）→ 步驟 3（貼給 mini）→ 10/29 步驟 4。
- 什麼時候看得到：步驟 1–3 做完畫面都不變；開關要到你在 mini 設 `REQ_UPPER_ON=1` 後的下一次 00:10 同步才生效，之後值班核定頁會看到「送上層審核中」（手機要 Cmd+Shift+R 或等 10 分鐘快取）。申請資料正本仍在各店打卡試算表 requests 分頁。
