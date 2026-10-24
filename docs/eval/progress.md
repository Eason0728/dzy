# 進度：績效評核（管理系統模組，三品牌共用）
- 開案日：2026-10-24
- 分級：完整
- 分級依據：排程=否 發訊息=否 外部後台=是 被看到=是 寫正式資料=是
- 現在在：③-方案
- 等 Eason：過目 plan.md 時程後開工

- 審查規則：2026-10-24 Eason 指示本系列搬家工作不做 Codex（GPT）審查；驗收照做（測試＋真瀏覽器點一輪）。

## 關卡紀錄
| 日期 | 關 | 對象 | 結果 | 第幾次 | 證據 |
|---|---|---|---|---|---|
| 2026-10-24 | 需求確認 | requirements.md | Eason 答十題 | 1 | requirements 0.1 |
| 2026-10-24 | 規格確認 | spec.md | Eason 答 S1 A、S2 B、S3 A | 1 | spec v2 |

## ② 探：舊系統盤點證據（mala-eval repo，路徑相對於專案根目錄）
- 店名寫死：index.html:6、:17-21；admin-page.js:683-686（PDF 檔名）；daylight.js:5-6（新竹座標）
- 職稱寫死：Code.gs:251-253（店長判定）、:404-421（店長／儲備幹部 KPI 範本種子）
- 門市專屬題目：data/banks-2026Q1.json:61-178（計時表現 14 題）
- 一店一套：eval-page.js:255、:362、:1100、admin-page.js:126、:141（名單＝全部帳號）；Code.gs:179（單一通行碼）
- 計分正本：js/scoring.js（finalScore、capScore、ftAttitudeScale、kpiItemScore／kpiTotal、gradeFor、wageTierIndex）；js/newbie.js
- 後端 action：doGet config／adminData；doPost 14 種（Code.gs:657-687）。無 Mac mini 程式。

## 落地清單
- [ ] 1 排程上線：
- [ ] 2 掛進監看：
- [ ] 3 納入故障追蹤：
- [ ] 4 登錄資源：
- [ ] 5 建 skill 並登錄路由：
- [ ] 6 寫一則記憶：
- [ ] 7 進版控：
- [ ] 8 回報未完成與等待事項：
