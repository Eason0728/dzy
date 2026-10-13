# 進度：員工名單統一（人員資料當正本）
- 開案日：2026-10-13
- 分級：完整
- 分級依據：排程=是 發訊息=否 外部後台=是 被看到=是 寫正式資料=是
- 現在在：⑤
- 等 Eason：第 2 段在 mini 終端機設鑰匙＋六店貼 STAFF_SVC_KEY

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
- 2026-10-14：總部有三個單位（鼎兆元總部 dzy-hq、墨竹亭總部 mzt-hq、小辛辣總部 mala-hq）。管理系統維持三個獨立單位，打卡三單位共用同一套總部打卡（hq）。修正中：clock_stores 的 hq 對三個單位；**總部按「建立打卡對照」要等此修正同步到 mini 後**。
- 2026-10-14：上線網頁 3 題照推薦（現在就做第 1 段、同意 minikit 加定時功能、mini 登入後自動啟動）。
- 2026-10-14：dzy 平台後端先推 main（43e144e，前端不變），前端等 mini 第 3 段完成後再推（先 mini 後前端）。
- 2026-10-14：同步員不需每分鐘撿單 → 改成「按下當下立即送＋失敗的每 15 分鐘補撿」；每日 00:10 對帳不變。確認：DZY 編號全集團連號、打卡編號各店照舊；自動檢查跑在 Mac mini 本機，不用 AI、不耗 token。

## 關卡紀錄
| 日期 | 關 | 對象 | 結果 | 第幾次 | 證據 |
|---|---|---|---|---|---|
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
