# 進度：管理系統第三期表單簽核
- 開案日：2026-10-18
- 分級：完整
- 分級依據：排程=是 發訊息=是 外部後台=否 被看到=是 寫正式資料=是
- 現在在：⑤（①｜②｜③-需求｜③-規格｜③-方案｜④｜⑤｜結案）
- 等 Eason：Mac mini 更新（照片異機備份）；初始化表單簽核＋送一張小額請款實測

## 需求確認（2026-10-18）
Eason：「金額門檻設計可以讓我輸入的欄位和新增數字的欄位。2照推薦」→ 門檻改成後台可編輯＋可新增級距（requirements §4）；照片存 Mac mini。
替他決定：請購、請款各一張門檻表；只有 admin 能改；已送出的單鎖定送出當下的門檻。

## 十題答案（2026-10-18 Eason：「照推薦」）
全部照 questions.md 推薦。替他決定的兩處：第 2 題門檻用例子的 5,000／30,000 元（需求文件標出、可改）；第 5 題照片存 Mac mini（推薦排第一的選項）。

## ② 探（2026-10-18）
探到的事實表在 questions.md；結論：打卡已有加班／請假／忘打卡／出差（不重做）；dzy 無推播、無上傳；簽名板與首頁 alerts 可重用；128 人只 1 人開通＝上線大前提。

（排程、發訊息兩項目前是「不確定當是」：逾期催簽要不要排程、送件／核准要不要推 LINE，待需求確認。）

## ① 查（2026-10-18）
- `ls ~/Desktop/Claude/專案/`、`ls ~`：無「簽核／approval」專案目錄。
- 記憶庫 MEMORY.md:70「第三期簽核未做」；dzy-personnel-accounts 記憶：第三期＝表單依職級往上簽核，只做打卡系統沒有的表單。
- 文件：`~/dzy/docs/personnel/requirements.md:21` 定案三期依序；org、permissions 文件都把第三期列為另案。
- skill：dzy-admin（平台殼、審核鏈 stfReviewScope_ 已存在）；無簽核 skill。
- 結論：已規劃、未實作；口令「建立新系統」→ 走五站，dzy-admin 載入當背景。落點預設 dzy 新模組（待需求確認）。

## 關卡紀錄
| 日期 | 關 | 對象 | 結果 | 第幾次 | 證據 |
|---|---|---|---|---|---|

## 落地清單
- [x] 1 排程上線：mini dzy-platform jobs（apv.js）04:00 照片打包、04:10 清檔、09:30 彙整、09:40 對帳；2026-10-18 10:20 重啟上線（e384dcb），log 帶時間戳（kit log）
- [x] 2 掛進監看：併入既有 dzy-platform /health（apv_digest_failed 連兩天、apv_backup_problem）→ 排程守門已監看 /platform/health（~/mala-fortune/tools/gas-watchdog/Code.js:1524，2026-10-18 核實）
- [ ] 3 納入故障追蹤：不另加——故障會反映在 dzy-platform health；累犯摘要來源本來就含 mini 系統（若沒有，下次 mala-repeat-offender 維護時補）
- [x] 4 登錄資源：~/.claude/mala-ops/dispatch-resources.md（dzy-platform 那列）
- [x] 5 建 skill 並登錄路由：不另建 skill，併入 dzy-admin「第三期：表單簽核」一節＋description 觸發詞；routing-full、dispatch-rules 第 30 列已補
- [x] 6 寫一則記憶：memory/dzy-approvals.md＋MEMORY.md
- [x] 7 進版控：dzy main 18e2d21（後端）、2fa0caf（畫面）；minikit main e384dcb；mala-notify-inbox 9acb108；~/.claude commit
- [x] 8 回報未完成與等待事項：見晨報與 2026-10-18 對話收尾

## 規格確認（2026-10-18）
Eason 給「門店支出」核決權限表圖：0–5,000 店長／5,001–10,000 營運主管／10,001–30,000 總經理／30,001 以上董事長。
追問四題答案：營運主管＝品牌辦公室總監；只給權限人簽（中間不經手）；總部店長換部門主管；請購請款共用，規格四題照推薦。
替他決定（待他看）：總部 5,001–10,000 也由部門主管簽（總部沒有品牌總監）；中央工廠沒有品牌總監→自動往上給執行長（找不到權限人的往上順序：店長→品牌總監→執行長→總經理→董事長）。請購、請款共用一張權限表。

## 設計審與開工（2026-10-18 夜）
- 設計審：GPT 29 條全部成立、全部改文件（review-design.md、spec §14、api.md）；無拿不準條目，未交 Fable。
- P0：通知匣來源清單加「表單簽核」（mala-notify-inbox 9acb108）；通用備份端只收資料表、收不了圖（kit/gas/backup/Code.js）→ spec §14.10 決策 A/B 待 Eason。
- 開工：三個 worktree 平行——後端 ~/dzy-wt-apv（apv-phase3）、前端 ~/dzy-wt-apv-fe（apv-phase3-fe）、mini jobs ~/dzy-minikit-wt-apv（apv-jobs）。

## 上線（2026-10-18）
- 夜間：後端／前端／mini 三線實作 → 合併 → 本機整合實測 99 項全對 → Fable 上線前審 6 條（中 2 低 4）全部重現後修好；Codex 上線前審額度用完，延到 11:59 自動重跑。
- 10:20 mini 更新 e384dcb（Eason；zsh 的 read 寫法踩坑一次，已改範本與 dzy-admin skill）；10:22 外網探測新 action 回 unauthorized＝已生效。
- 10:29 推畫面 2fa0caf（Pages 約 40 秒生效）；正式網址模組六檔載入正常、照片路由從瀏覽器打得到、console 無錯。
- 未做：Codex 上線前審結果比對；Eason 初始化＋小額請款實測；照片異機備份 A/B。

## 照片異機備份 A（2026-10-18 下午）
- Eason 選 A。minikit c678a20（備份端 action file＋apv.js 每日送雲端；npm test 430/428 pass、0 fail、2 skip）。
- 備份端 clasp push → Eason 授權雲端硬碟 → create-version 2 → update-deployment 同 ID @2；外網 GET 正常、file／backup 兩動作錯金鑰都回 AUTH。
- 待：mini pull＋重啟；隔天 04:00 後確認 health 沒有 apv_offsite_*、雲端硬碟出現 dzy-minikit-files-dzy-platform-apv。
- Codex 上線前審：依 Eason 指示暫停（營運系統個人帳號先審），等通知。
- 18:00 Fable 審異機備份 7 條（中 2 低 5）→ 修 5 條（146aa59、b11048f），npm test 439/437/0 fail；備份端第 3 版部署、外網驗證正常。待 mini pull＋重啟；mini 複查排程要改 04:35（異機送出改 04:20）。Codex 22:02 跑一次全面審。
- 10/19 03:21 Codex 上線前審：1 高 4 中。處置：#1 Handle/Resubmit/Void 補 rev＋step（修，3d69c66）、#4 sweep 卡 deleting（修，dzy 端；mini 端早已處理）、#2 照片被手動刪除仍可綁單（不改，靠 04:00 缺檔偵測）、#3 讀取不寫 skip、#5 added:false 視同送達（改規格對齊，spec §14.15）。
- 23:03 先推畫面 3d69c66（新畫面多送 step，舊後端忽略＝安全），minikit b72427b 待 mini pull＋重啟。
