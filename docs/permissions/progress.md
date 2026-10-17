# 進度：個人帳號第二期｜依職級給系統權限
- 開案日：2026-10-17
- 分級：完整
- 分級依據：排程=否 發訊息=否 外部後台=否 被看到=是 寫正式資料=是
- 現在在：結案（①｜②｜③-需求｜③-規格｜③-方案｜④｜⑤｜結案）
- 等 Eason：無（2026-10-18 01:52 PERMS_ON 已開；之後推同仁認領）

## ① 查（2026-10-17）
- `grep -rn 第二期 ~/dzy/docs`：personnel/requirements.md:20、personnel/spec.md:48-49、org/requirements.md:41 都只寫「第二期：依職稱決定能用哪些系統（另案）」，沒有任何設計內容 → 不是已存在的東西，是既有系統排好的下一期。
- 記憶庫 MEMORY.md:70「第二期職稱權限、第三期簽核未做」。
- 既有 skill：dzy-admin（背景知識已載入）。資源清單無第二期條目。

## ② 探（2026-10-17，讀碼，未碰正式資料）
- 身分與權限：權限＝users.role → roles 分頁 perms（Auth.gs hasPerm_ 精確比對）；同仁帳號 role 一律 staff（perms＝platform.self），另由後端依 staff 列衍生 platform.review（審核者）、platform.bulletin（公告管理 gate）。第二期可沿用「登入／me 時依職稱衍生權限」這條既有路。
- 資料真面目：組織表職稱 12 個啟用（Staff.gs:1369-1383、1481-1484）；品牌辦公室 oam 區經理 rank2、osv 區督導 rank3、odir 總監 rank4。正式人數在 mini，**未確認**。
- 店別代號對不上：稽核／人員管理用舊節點 `sxl-gf`、`ck`、`mzt-gf`、`mzt-js`、`mzt-lzl`（Users.gs:24），組織表單位是 `mala-gf`、`mzt-gf`…（Staff.gs:1340-1368）；小辛辣光復兩邊代號不同 → 依單位給「只看自己店」要一張對照。
- 稽核代轉只支援「單一店」裁切（Auth.gs:330 filterNode），區經理看整個品牌要擴充代轉裁切（前端 filterOwnNode_＋mini proxy-hook 兩邊）。
- 改職級＝改 org 表：10/16 切換後任何 org 改動會讓「退回組織」永久拒絕（雜湊比對）。
- 執行環境／額度／下游：不適用（不新增排程、不花錢；下游＝稽核、宿舍代轉，已有）。

## 關卡紀錄
| 日期 | 關 | 對象 | 結果 | 第幾次 | 證據 |
|---|---|---|---|---|---|
| 2026-10-18 | 上線 | PERMS_ON | mini 01:52 打開；health green 827 列；B 檢查：128 位同仁帳號中 127 位未認領（無密碼、從未登入），1 位已開通 | 1 | mini 回報（對話） |
| 2026-10-17～18 | 整套關 | 全面審視 | Fable 14 條＋Codex 15 條（Codex 實跑的是舊 gas）＋複驗 3 條；成立項全修（#11 #14 不改）；PR #10 #12 #13 | 1 | e2e 十二支 exit 0 |
| 2026-10-17 | 階段關 | 上線前（issue #8） | Fable 8＋GPT 8；同抓 5 直接修、單邊 6 交叉驗證（GPT 額度用完改新 Fable）→ 9 條修；第 2 輪 Fable 複驗再找 N1–N4（先寫失敗測試重現）→ 修；全部測試＋e2e 十一支 exit 0、mini 58 | 2 | dzy 00ae3de／0dc475d、minikit 662502d／f837bbb |
| 2026-10-17 | 任務關 | P2a＋P2b | 通過：perms-actions 204、perms 117、staff 221、org-upgrade 260、proxy-authorize 92、全部測試 done；變異測試兩個紅→綠（Claude 重跑確認） | 1 | commit acf1deb、d06fbcc |
| 2026-10-17 | 任務關 | P1 Perms.gs | 通過：perms.mock 117/117、既有測試全綠、變異測試紅→綠（Claude 重跑確認） | 1 | commit caebf03 |
| 2026-10-17 | 設計審 | spec v1 | GPT 14 條（高 8）；Fable 複核 A 成立、B 現行設計、C 現況無外洩；全部併入 spec §13 | 1 | spec.md §13（GPT 原文在 scratchpad，不進公開 repo） |
| 2026-10-17 | 規格確認 | spec v1 | Eason「規格 OK，二題照推薦」 | 1 | 對話紀錄 |
| 2026-10-17 | 需求確認 | requirements v1 | Eason「需求 OK」 | 1 | 對話紀錄 |
| 2026-10-17 | 問題清單 | 8 題 | Eason：全照推薦，7→B、8→B | 1 | 對話紀錄；requirements.md 第 3 節 |

## 落地清單
- [x] 1 排程上線：不適用（不新增排程；例外到期在每次算權限時比對日期）
- [x] 2 掛進監看：不適用（沒有定時任務；dzy-platform 本身已在 miniAppsCore_ 守門與 health）
- [x] 3 納入故障追蹤：不適用（同上，無新排程）
- [x] 4 登錄資源：mini .env `GAS_PROP_PERMS_ON=1`（第 31 行，2026-10-18 01:52）；minikit app.json props 含 PERMS_ON、readActions 含 perm 讀取類與 permWho；救援工具 `kit/tools/run-fn.js`（setup／bootstrapAdmin／rescueAdmin）——寫進 dzy-admin skill
- [x] 5 建 skill 並登錄路由：沿用 dzy-admin（加「第二期依職稱給權限」一節），不另建 skill
- [x] 6 寫一則記憶：~/.claude/projects/-Users-guoeason/memory/dzy-personnel-accounts.md 更新第二期上線
- [x] 7 進版控：dzy main d680e56（PR #9 #10 #11 #12 #13）、minikit main 544ed88、mala-dorm 72859d8
- [x] 8 回報未完成與等待事項：見下方「上線後」

## 待辦備忘
- 程式初始值 Staff.gs STF_UPGRADE_ADD／預設 org：osv rank 3→2、odir 4→3，連同 test/org-upgrade.mock.test.mjs T1 一起改（目前工作樹有別的 session 未提交的 SSO 修改，sync-gas 要求乾淨，所以先不動程式，只請 mini 改資料）。
- 2026-10-17 01:21 mini 已改正式 org：osv rank 3→2、odir 4→3（備份 ~/dzy-platform-data/app.db.bak-rank-202610170121；停機 7 秒；orgOptions 驗過 ofs1／oam2／osv2／odir3）。org_upg_* 快照仍是舊值 → 不可再按「切換組織」，直到 spec 第 9 節修好初始值。
- 2026-10-17 決定：audit.write 存在時 perms 也補 audit.read（否則進不了稽核模組）；壞日期的 add 例外視為無效（fail closed）；多一個錯誤碼 bad_mode。
- 部署卡點：minikit app.json 的 gasSource 指向 ~/dzy/apps-script/platform（sync-gas 要求那邊在 main、乾淨、等於 origin/main）；~/dzy 現在停在別的對話的 bulletin-admin 分支 → 要等 perm-phase2 合進 main、~/dzy 回到 main 才能同步。新檔 Perms.gs、PermActions.gs 要加進 app.json gas／gasSource。
- backlog：請求內快取（每個請求重讀 perm／org 表；mini 在記憶體，毫秒級，不急）；N5 usrActorIsAdmin_ 只認 role admin。

## 上線後（2026-10-18）
- 同仁加入尚未開始：128 位只 1 位開通。推行順序：先店長／主管認領（Eason 或人資審），再一般同仁（店長審）。說明圖 ~/Desktop/Claude/同仁加入說明/。
- 交辦教訓：打開前檢查「status 不是 active」會把 unclaimed 算進去而誤擋；正確條件＝「status 為 pending／rejected／disabled 且能登入（有密碼、users.active）」。
- backlog：請求內快取（每請求重讀 perm／org 表；mini 在記憶體，毫秒級）；usrActorIsAdmin_ 只認 role admin。
