# 進度：管理系統 LINE 認身分（重設密碼＋一鍵認領）
- 開案日：2026-10-25
- 分級：完整
- 分級依據：排程=否 發訊息=否 外部後台=是 被看到=是 寫正式資料=是
- 現在在：結案（①｜②｜③-需求｜③-規格｜③-方案｜④｜⑤｜結案）
- 等 Eason：無（守門已 clasp push，2026-10-25 20:18 雲端確認）

## ① 查（2026-10-25）
- `ls ~`：有 mala-clock-liff（LINE 打卡）、mala-store-ops-linebinds，沒有管理系統 LINE 登入／重設的專案。
- 記憶庫索引 grep「LINE 登入／重設／認領／liff」：無命中。
- skill：dzy-admin（本案所在系統）、mala-clock-in（LINE 打卡綁定來源）、dzy-bulletin（已有 LINE 自動登入先例）。
- 資源清單：LIFF channel「鼎兆元打卡登入」2011292256，官方帳號 @424fyjha；佈告欄 LIFF `2011292256-iTZEbOWG`；打卡 LIFF `2011292256-QFXEwFh4`。
- 結論：功能不存在；是既有系統（dzy）加新功能，Eason 指定「核心＋B＋C 一次做」。

## 數據（2026-10-25 mini 唯讀統計）
同仁 134、已開通 7、未認領 123；六店在職綁 LINE 帳號 56；對到 DZY 且綁 LINE 46；已開通且綁 LINE 2。

## 關卡紀錄
| 日期 | 關 | 對象 | 結果 | 第幾次 | 證據 |
|---|---|---|---|---|---|
| 2026-10-25 | 上線前關（Fable＋GPT 互盲） | 三 repo 分支 | Fable 8 條（無高）、GPT 9 條；兩邊都挑：解綁時差→即時回查；單邊判斷修 11 條；不修：token 重放、開通自填憑證（開通取消後不適用） | 1 | Eason0728/dzy#21 |
| 2026-10-25 | 上線前關第二輪（Fable 驗證） | 修正後 | 全部已驗證；新 1 落後 main→已合併重驗、#2 HMAC→加 line_probe 自我檢查、新 2/3 已修、新 4 不修 | 2 | Eason0728/dzy#21 |
| 2026-10-25 | 範圍變更 | — | Eason：只做 LINE 重設，取消 LINE 開通（R3）；維持不推播（A） | — | 對話 |
| 2026-10-25 | 設計審查（GPT） | 四份文件＋相關程式 | 14 條（高 7）；我查證：#9 屬實、#3 屬實、#6 屬實、#10「函式不存在」不成立（在 StoreOps.gs）；未另開 Fable（高嚴重度幾條都是設計推理、已自行查證） | 1 | docs/line-auth/design-review-gpt.md |
| 2026-10-25 | 規格確認 | spec.md v1.0 | Eason 確認 S1–S3 皆推薦 | 1 | 對話紀錄；網頁 GeVeeLSFS4pc9jofEbKN95 |
| 2026-10-25 | 需求確認 | requirements.md v1.0 | Eason 確認（7 題＋追問 A） | 1 | 對話紀錄；網頁 C6mQJfaiNLWUMDjUP2KS9P |

## 落地清單
- [x] 1 排程上線：不適用（無新排程；沿用每晚 00:10 打卡同步）；一次性檢查 2026-10-26 09:00（~/.claude/scheduled-tasks/dzy-line-reset-sync-check）
- [x] 2 掛進監看：mini health reason line_kid_mismatch／line_key_mismatch → 守門 dzy-platform 黃燈彙整（mala-fortune d5890b6，待 Eason clasp push）＋指揮台「管理系統」格
- [x] 3 納入故障追蹤：~/mala-loops/repeat-offender/LOOP.md 來源表加 dzy-platform 一列（88cdffa）
- [x] 4 登錄資源：~/.claude/mala-ops/dispatch-resources.md「管理系統 LINE 重設密碼」列
- [x] 5 建 skill 並登錄路由：沿用 dzy-admin（新增「LINE 重設密碼」節）、mala-clock-in（打卡端節）
- [x] 6 寫一則記憶：~/.claude/projects/-Users-guoeason/memory/project_dzy_line_reset.md
- [x] 7 進版控：dzy#22、dzy-minikit#17、mala-clock-in#3 已合併；部署腳本 mala-clock-liff 5c8c440；~/.claude 13bbe45、a2c1e12
- [x] 8 回報未完成與等待事項：見對話；mini 備份檔留一週；過幾天跑可信人數統計

## 上線紀錄（2026-10-25）
六店打卡：總部 @40、六張犁 @15、金山 @26、墨竹亭光復 @20、央廚 @38、光復 @159；mini 拉到 4448964＋.env 五鍵＋重跑同步（六店 ok、無警告）；dzy#22 合併 fe606d4（17:13）。外部驗證：health green、假 token 401、錯 Origin 403、claim 400、登入頁有「用 LINE 重設密碼」。

## 後續（2026-10-25）
- Eason：登入頁拿掉「忘記密碼」連結，只留「第一次使用」與「用 LINE 重設密碼」（選 A：後端生日手機重設保留，LINE 頁「改用原本的方式」仍可進 #/forgot）。
