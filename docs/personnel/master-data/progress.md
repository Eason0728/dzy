# 進度：員工名單統一（人員資料當正本）
- 開案日：2026-10-13
- 分級：完整
- 分級依據：排程=是 發訊息=否 外部後台=是 被看到=是 寫正式資料=是
- 現在在：③-規格
- 等 Eason：規格確認（2 題：離職可往回補幾天、7A 離職過不自動加回）

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

## 關卡紀錄
| 日期 | 關 | 對象 | 結果 | 第幾次 | 證據 |
|---|---|---|---|---|---|

## 落地清單
- [ ] 1 排程上線：
- [ ] 2 掛進監看：
- [ ] 3 納入故障追蹤：
- [ ] 4 登錄資源：
- [ ] 5 建 skill 並登錄路由：
- [ ] 6 寫一則記憶：
- [ ] 7 進版控：
- [ ] 8 回報未完成與等待事項：
