# 進度：員工名單統一（人員資料當正本）
- 開案日：2026-10-13
- 分級：完整
- 分級依據：排程=是 發訊息=否 外部後台=是 被看到=是 寫正式資料=是
- 現在在：⑤
- 等 Eason：無（2026-10-14 總部已按完 13 位「設為主店」）。下一步：開新對話「員工名單統一第 4 段」／「第 5 段」

## ① 查（2026-10-13）
- 規劃稿 ~/dzy/docs/personnel/master-data-plan.md（v1，方向與六題已定）；記憶 staff-master-direction.md 已記方向
- 上一期 ~/dzy/docs/personnel/progress.md（個人帳號管理第一期，⑤ 落地中；等 Eason 匯入 113 人）
- 記憶庫 grep 人員／名冊／薪資：dzy-personnel-accounts、mala-payroll-project、payroll-clockin-red-zone、staff-master-direction；無既有「名單統一」系統
- skill：dzy-admin（落點）、mala-clock-in、mala-payroll、dzy-bulletin、mala-schedule-app／dzy-store-ops（下游）；無既有名單同步 skill
- 結論：不存在，屬既有 dzy 上的新一期；口令「建立新系統」→ 走五站，docs 放本目錄

## ② 探（2026-10-13）
- 結果寫在 requirements.md 第 7 節；Eason 准後唯讀抓六店名冊：在職 44 人、13 人跨店、六張犁空；樣本在 spike/sample（gitignore）
- 2026-10-13 Eason：六題照推薦，第 4 題改依實際打卡
- 發現：打卡 repo 正本 Code.gs 缺新增同仁的鎖（六個部署副本都有）＝正本落後部署

## ④ 開發位置
- 打卡端：worktree ~/mala-clock-in-svcstaff（分支 feature/svc-staff，從 origin/main）
- 平台後端與前端：worktree ~/dzy-wt-staffmaster（分支 feature/staff-master）
- 同步員：worktree ~/dzy-minikit-wt-jobs（分支 feature/staff-master-jobs）
- 佈告欄：worktree ~/dzy-bulletin-wt-staffmaster（分支 feature/staff-master）
- 7A 打卡端與值班核定改動：同打卡端分支 feature/svc-staff（以指令碼屬性 STAFF_HUB_URL／STAFF_HUB_KEY、STAFF_MASTER_ADD_REDIRECT 控制，未設＝今天行為）
- ⚠ 光復部署前：另一個 session 的 autoschedule-line 有兩個 commit（sched_day_roster，光復 @154）已上線但未併 main，部署前要先併進本分支，否則會洗掉
- 階段關審查紀錄：dzy repo issue #1（https://github.com/Eason0728/dzy/issues/1）

## Eason 決定紀錄
- 2026-10-14：Eason 親自指定 13 位跨店同仁的主店（名單與對照只在對話與 mini 資料內，不進 repo）。做法：新增總部「設為主店」釘選（clockSetHome，優先順序：DZY 單位 > 釘選 > 打卡推斷），併入 mini「更新 1」一次上線；上線後由總部在打卡對照逐一按。
- 2026-10-14 正式環境發現：113 人匯入時無單位（認領才填），未認領者主店判斷全變「支援」、店長清單看不到。修法（Claude 決定）：單位空時依打卡資料推主店（單店＝那家；多店＝60 天打卡最多）、每日重算 role（不改 state 不發單）、店長清單改依打卡帳號所在店。修好前總部仍可照常按「對」，role 會自動更正。
- 2026-10-14：總部有三個單位（鼎兆元總部 dzy-hq、墨竹亭總部 mzt-hq、小辛辣總部 mala-hq），各自有不同主管 → Eason 確認**維持三個獨立單位**，打卡三單位共用同一套總部打卡（hq）。已修正（dzy main 98898f3、minikit main 9c5af36）：clock_stores 的 hq 對三個單位、舊分頁自動升級。mini 第 3 段 pull 後即生效。
- 2026-10-14：上線網頁 3 題照推薦（現在就做第 1 段、同意 minikit 加定時功能、mini 登入後自動啟動）。
- 2026-10-14：dzy 平台後端先推 main（43e144e，前端不變），前端等 mini 第 3 段完成後再推（先 mini 後前端）。
- 2026-10-14：同步員不需每分鐘撿單 → 改成「按下當下立即送＋失敗的每 15 分鐘補撿」；每日 00:10 對帳不變。確認：DZY 編號全集團連號、打卡編號各店照舊；自動檢查跑在 Mac mini 本機，不用 AI、不耗 token。

## 關卡紀錄
| 日期 | 關 | 對象 | 結果 | 第幾次 | 證據 |
|---|---|---|---|---|---|
| 2026-10-14 | ⑤ mini 更新 1 | 無單位推主店＋店長依打卡店可見＋總部指定主店 clockSetHome | mini 回報 health green、jobs 啟動、NO_SUCH_FUNCTION 0；外網探針 clockSetHome 回「登入已失效」；前端 7b8481b 上線（node 0 fail、e2e 九支） | 1 | minikit 0cb80b6、dzy 7b8481b |
| 2026-10-14 | ⑤ 上線第 2、3 段 | 六店 STAFF_SVC_KEY＋mini 只讀上線＋管理系統新畫面 | mini 回報 health green、六店每日同步 ok（六張犁名冊空屬正常）、jobs 啟動、log 無網址金鑰；外網探針新 action 回「登入已失效」（已認得）；前端 5adc6ee 上線（node 0 fail、e2e 九支通過、正式登入頁無錯誤） | 1 | mini 回報（minikit d11b9f3）、dzy 5adc6ee |
| 2026-10-14 | ⑤ 上線第 1 段 | 六店打卡 SvcStaff＋光復 LineHub 7A（開關關閉） | 三方比對一致→補丁式部署（只套本案修改）→拉回逐檔比對一致；探針 svc_roster 錯金鑰全回 unauthorized、whoami／mgr_day 照常；光復 @155、金山 @22、墨竹亭光復 @16、六張犁 @11、總部 @36、央廚 @34；值班核定頁新版上線（開關未開，行為不變） | 1 | mala-gas 168ab59、mala-clock-in 1fa6c73 |
| 2026-10-13 | ④ 階段關 第 5 輪＋上線前關第 2 場＋結關 | 7A 打卡端＋佈告欄＋全部跨 repo 契約 | Fable 8 條＋GPT 12 條（G4 可接受）全修、四組跨 repo 契約逐欄一致；**M4 階段關通過** | 5 | dzy issue #1、prelaunch-review.md |
| 2026-10-13 | ④ 上線前關 | 寫外部系統／金鑰／7A | Fable 11（無高）＋GPT 15（高 13）互盲；兩邊同挑 3 條必修、單邊 14 條判斷後修、6 條判定可接受並記理由；三邊修正中 | 1 | prelaunch-review.md |
| 2026-10-13 | ④ 階段關 第 4 輪 | 同上 | 25 條全部已驗證；**M1 階段關通過**（打卡 64 檔、平台 33 檔、同步員 282 項全綠；e2e 九支 exit 0） | 4 | dzy issue #1 |
| 2026-10-13 | ④ 階段關 第 3 輪 | 同上 | 9 條中 8 條已驗證；新 3 條（低） | 3 | dzy issue #1 |
| 2026-10-13 | ④ 階段關 第 2 輪 | 打卡＋平台＋同步員＋前端 | 第 1 輪 13 條已驗證、#12 文件未齊；新 8 條（中 2、低 6），無高；分派修正中 | 2 | dzy issue #1 |
| 2026-10-13 | ④ 階段關 第 1 輪 | 打卡 SvcStaff＋平台 StaffClock | Fable 14 條（高 2、中 5、低 7），測試全綠、6 個變異全被抓到；分派修正中 | 1 | dzy issue #1 |
| 2026-10-13 | ③→④ 設計審 | requirements＋spec v1＋plan＋task | GPT 21 條（高 19、中 2）：20 條直接改進 spec v2／plan／task（spec §11 對照表）；第 13 條（薪資姓名對人）Fable 複核＝部分成立（特休／年度額度／補休／核定頁額度四處用薪資主檔姓名比請假姓名），處理方式待 Eason | 1 | spec.md §11；GPT 原文存 scratchpad，不進 repo |

## 落地清單
- [ ] 1 排程上線：
- [ ] 2 掛進監看：
- [ ] 3 納入故障追蹤：
- [ ] 4 登錄資源：
- [ ] 5 建 skill 並登錄路由：
- [ ] 6 寫一則記憶：
- [ ] 7 進版控：
- [ ] 8 回報未完成與等待事項：

## 接手說明（下一個對話從這裡開始；2026-10-14 02:00 寫）
**現況**：第 1–3 段完成。六店打卡有服務端點且鑰匙已設；mini 以只讀模式（CLOCK_WRITE=0）每天 00:10 同步六店名冊；管理系統新畫面已上線（打卡對照、我的單位、首頁提醒）。寫入（新增／離職連動）、LINE 自動加新店、值班核定改說明都還**關著**。
**開發位置**：程式都已併進各 repo main（dzy 5adc6ee、mala-clock-in 1fa6c73、minikit d11b9f3）；佈告欄仍在 ~/dzy-bulletin-wt-staffmaster（feature/staff-master，未上線）。可清掉的 worktree：~/dzy-wt-staffmaster、~/mala-clock-in-svcstaff、~/dzy-minikit-wt-jobs（佈告欄那個留到第 5 段）。
**交辦檔小誤差**：mini-handoff-segment3.md 第 6 步「POST {} 期望 unauthorized」已過時，實際回 bad_input（上線前關 F7 改成先驗格式）；格式正確無金鑰才回 unauthorized。

### 第 4 段（開放寫入）——建議新對話，口令「員工名單統一第 4 段」，先讀本檔與 spec §4、prelaunch-review.md
前置（缺一不開，plan 5d）：
1. ✅ 打卡對照全部確認（2026-10-14 總部完成，需總部處理與候選新人皆空）。⚠ 未認領者的 home／support 標籤要等「無單位推主店」修正上線後每日重算才正確——開寫入前確認已上線並跑過一次 00:10。
2. mini「登入後自動啟動」（Eason 2026-10-14 同意）：minikit DEPLOY.md 規則 9 寫「不裝開機自動啟動」，要改規則＋做 LaunchAgent（FileVault 開著，停電仍需到場解鎖）。
3. 雲端排程守門（~/mala-fortune/tools/gas-watchdog/Code.js → ~/mala-gas/schedule-watchdog）加監看 dzy-platform /platform/health 的 reasons `clock_sync_stale`、`clock_daily_apply_failed`。
4. 確認 mini `.env` 已刪 `GAS_PROP_LEGACY_SECRETS`（第一期過渡旗標，dzy-admin skill 部署第 5 步）。
5. 墨竹亭光復 MZTGF 薪資門市表未建 → 該店不做姓名一致檢查（已知，可接受）。
開關步驟：mini `.env` 改 `CLOCK_WRITE=1`、加 `HUB_SVC_KEY`（16 字以上）→ 重啟；光復打卡指令碼屬性 `STAFF_HUB_URL`（mini Funnel 的 /platform/svc/auto-support 完整網址）＋`STAFF_HUB_KEY`（同 HUB_SVC_KEY）；六店指令碼屬性 `STAFF_MASTER_ADD_REDIRECT=1`。
開關後的個案（2026-10-14 Eason 指定）：
- 個案 A（DZY058，姓名只在 mini 資料內）：單位＝墨竹亭總部（mzt-hq），實際在總部辦公室打卡；目前只有墨竹亭光復 MZTGF03（從未打卡）、總部打卡沒有帳號。現行規則「單位從空設成有值、該店無對照 → 不開 add 單，只進 no_home_map 異常」，所以第 4 段要先加小功能：總部在 no_home_map 異常列按「在主店建打卡帳號」→ 開 add 單（kind add、role home、需 CLOCK_WRITE=1）；建好後停用 MZTGF03。她的單位要等她認領時選墨竹亭總部，或開通後由總部「改資料」設定。
驗收（task E4）：用測試名字在一家店走「店長新增→打卡名冊出現→登記離職→隔天 00:10 停用」，測完把測試列停用；7A 用一位已綁 LINE 的同仁實測一次（先問 Eason）。
通知店長的 LINE 文字要先給 Eason 看（發訊息到群組＝要先問）。
落地清單 1–8 在第 4 段結束時逐項完成（skill：dzy-admin 加一節＋mala-clock-in 加一節、dispatch-resources 登錄版號與 .env 變數名、守門、累犯摘要來源、記憶更新）。

### 第 5 段（佈告欄）——可另開一個對話並行，口令「員工名單統一第 5 段」
**2026-10-14 進度**：附錄 D 第 1 步（管理系統 svcDirectory）早已在 dzy main；第 2 步完成——佈告欄 PR #38 合併（main b25e42d，前端 v0.7.5 上線）、GAS clasp deploy @34 回 v0.7.5（build 全綠、judge 44/44、run.py 三輪全過）。下一步：Mac mini 設鑰匙＋附錄 B 更新＋`migrate` 報告（只報告不寫）→ 拿回報告判斷 `--map`／`--allow-name-diff` → `migrate --apply` → 雙跑 7 天（最早 2026-10-21 可切）。
照 ~/dzy-bulletin-wt-staffmaster/server/DEPLOY.md 附錄 D：mini 平台 `.env` 加 `GAS_PROP_BULLETIN_SVC_KEY`、佈告欄 server `.env` 加 `DZY_PLATFORM_URL`（127.0.0.1:8799）與 `BULLETIN_SVC_KEY`（同值）→ 合併分支、GAS v0.7.5 clasp 部署 → mini 佈告欄更新 → `migrate` 檢查（本機演練：S-045 手動新增者需 `--map` 人工指定）→ `migrate --apply` → 雙跑 7 天 → `dual-status` 可拆舊才切 `STAFF_SOURCE=dzy`。
⚠ 與第 4 段都會重啟 mini 平台，兩個對話不要同時動 mini。

### 第 6 段：第 4 段開放後兩週，若「打卡上有、沒對照」異常為零 → 六店 mgr_add_employee 回 disabled（task H1）。
