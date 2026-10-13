# 任務清單：員工名單統一

每個任務 100～200 行以內；驗收寫成可打勾的句子。共用契約見 plan.md 開頭表，**逐字元照用**。
測試一律假名（例：測試甲、測試乙），不得出現真實同仁姓名。

## 階段 0：準備
| # | 任務 | 輸入 → 輸出 | 驗收 |
|---|---|---|---|
| Z1 | 打卡正本對齊部署版 | 六店 `~/mala-gas/*-clock-in/程式碼.js` → `~/mala-clock-in/apps-script/Code.gs` | 六店副本去掉 CONFIG 後彼此 diff 為空（或列出差異並說明）；正本 diff 部署版只剩佔位符差異；`grep -E '[A-Za-z0-9_-]{40,}' Code.gs` 無試算表 ID／金鑰；repo 既有測試全綠 |
| Z2 | minikit jobs 掛勾確認 | 問維護者 | 得到「可」或改採 launchd 的結論，寫進 progress.md |
| Z3 | 開審查 issue | — | dzy repo 有「員工名單統一｜階段關」issue，本文含範圍、驗收、規則，不含網址金鑰真名 |

## 階段 1：打卡端（~/mala-clock-in）
| # | 任務 | 輸入 → 輸出 | 驗收 |
|---|---|---|---|
| A1 | SvcStaff.gs 骨架＋驗證 | `{action,v,svc_key}` → 通過或錯誤 | 未設 STAFF_SVC_KEY 全回 unauthorized；錯金鑰 unauthorized；v≠1 bad_version；比對為固定時間（逐字元 XOR 累加） |
| A2 | svc_roster | — → 名冊陣列 | 只回 spec §3 欄位；不含 key／device_id／line_user_id；line_bound 為布林；last_punch 取 events 該 emp 最大日期；空名冊回 [] |
| A3 | svc_add（含 svc_ops 冪等、ensureRosterHeaders 補兩欄） | name, op_id, created_by, src_* → {emp_id,key} | 同 op_id 第二次回同結果且名冊只多一列；在職同名回 duplicate_name；與 mgr_add_employee 同一把 ScriptLock；**依實際表頭定位寫入**（測試：表頭欄序打亂仍寫對欄）；name 去頭尾空白、≤20 字 |
| A4 | svc_set_active＋svc_link | emp_id, active, op_id → 結果 | 不存在 not_found；停用寫 removed_at／removed_by；恢復時同名在職 duplicate_name；svc_link 只回該人 key；op_id 冪等 |
| A5 | Code.gs 併入 SVC_STAFF_HANDLERS | — | 三行；舊 action 全數照舊（既有測試全綠）；刪掉三行＋檔案即回到原狀 |

## 階段 2：平台後端（~/dzy/apps-script/platform/StaffClock.gs）
| # | 任務 | 輸入 → 輸出 | 驗收 |
|---|---|---|---|
| B1 | 分頁建立：clock_stores、staff_clock、clock_outbox；staff 補 hire_date、last_day | 空白或既有試算表 → 表頭逐字照 spec §2 | 只補不覆蓋；表頭不一致停下回錯；重跑不重複；clock_stores 預設六列 |
| B2 | staffCreateByUnit | {name,title,hire_date,phone} → {emp_no, job_id|null} | 店長只能建自己單位（payload 夾 unit 被忽略）；總部可指定單位；同單位在職同名擋；單位無打卡回 job_id=null；DZY 接最大號；寫 staff_log 不含個資 |
| B3 | staffLeave／staffLeaveCancel | {emp_no,last_day} | last_day 早於今天 7 天以上被擋（總部不擋）；店長只能動自己單位；撤銷只在 last_day 當天結束前；已停用的不能登記 |
| B4 | clock_outbox 狀態機：寫單、clockOutboxClaim_、clockOutboxDone_、clockOutboxRetry、clockJobStatus | — | job_id／op_id 格式照契約；claim 一次只給 pending 且 next_at≤now 的單並轉 running；running 超過 5 分鐘視為 pending；done 時 add 成功寫 staff_clock home/created/confirmed；失敗依 1/5/30 分、6 小時排 next_at；tries≥3 進 alerts |
| B5 | clockRosterApply_（每日／建對照共用） | 六店 roster 陣列 → staff_clock 更新＋異常清單 | 有 src_* 的新列直接 support/auto_support/confirmed；roster_active、last_punch 更新；唯一鍵 store_code+emp_id 不重複 |
| B6 | clockMapBuild＋clockMapList＋clockMapDecide | 名冊 → suggested 列；店長／總部決定 | 唯一同名→suggested；同名多人→需總部；DZY 沒有→建 unclaimed＋suggested；店長只能決定自己單位 suggested；總部可指定；決定寫 staff_log |
| B7 | clockDailyApply_ | today → 動作清單 | last_day<today 且在職→停用（沿用第一期 disable＋token_after）＋每個 confirmed 對照各一張 deactivate；跑兩次不重複發單 |
| B8 | clockLink（kind=link 單）＋svcDirectory＋clockAlerts | — | link 金鑰只在 CacheService、取一次即刪、不寫進任何分頁；svcDirectory 驗 BULLETIN_SVC_KEY、只回 confirmed、無手機生日地址；alerts 四類 |
| B9 | Code.gs 分派＋MUTATING_ACTIONS；內部 `_` 函式不進分派表 | — | 新 action 可分派；打 /api 呼叫 clockOutboxClaim_ 等回 unknown_action；既有測試全綠 |

## 階段 3：同步員（~/dzy-minikit）
| # | 任務 | 驗收 |
|---|---|---|
| C1 | kit 支援 app.json `jobs` | 沒設 jobs 的 app 行為不變（既有 kit 測試綠）；jobs 丟例外只記 log 不弄倒伺服器 |
| C2 | jobs.js 撿單迴圈 | 假打卡後端：add／deactivate／link 成功與失敗各一；逾時 20 秒算失敗；CLOCK_WRITE=0 時 add／deactivate 不送、留 pending |
| C3 | jobs.js 每日 00:10＋開機補跑 | 假時鐘測：00:10 觸發一次；當天已跑不重跑；開機時當天未跑→補跑；某店連不上不影響其他店 |

## 階段 4：前端
| # | 任務 | 驗收 |
|---|---|---|
| D1 | 同仁名單：新增（店長版／總部版） | 店長單位欄固定；送出後輪詢 clockJobStatus 最多 60 秒，三種結果畫面（成功顯示打卡編號、逾時、失敗）|
| D2 | 離職登記／撤銷＋「打卡已停 n/m」 | 日期限制提示白話；撤銷鈕只在可撤銷時出現 |
| D3 | 顯示打卡連結 | 只有該單位店長與總部看到按鈕；連結顯示後不留在畫面狀態以外的地方（不寫 localStorage） |
| D4 | 打卡對照：店長（我的資料 → 待審核）＋總部（同仁名單分頁） | 店長只看自己單位；按「不對」轉總部；總部可指定 |
| D5 | alerts 四類＋重試鈕 | 首頁每類一列、點了到對應畫面 |
| D6 | e2e 第九支（全 mock） | 新增→成功→離職→00:10（mock 時間）→打卡已停；對照確認；零真實網路；`run_all.sh` exit 0 |

## 階段 5：上線
| # | 任務 | 驗收 |
|---|---|---|
| E1 | 上線前關（Fable＋GPT 互盲） | 兩邊結果分存；雙方都挑到的全修；單邊的讀碼跑測試判斷並記錄 |
| E2 | mini 同步後端＋jobs＋.env（CLOCK_WRITE=0） | health 200；一次 svc_roster 六店都回；clock_outbox 無 add 單送出 |
| E3 | 建對照＋店長確認 | 44 位在職打卡同仁全部 confirmed 或明確排除（列清單給 Eason） |
| E4 | 前端上線＋CLOCK_WRITE=1＋值班核定按鈕改說明 | 用測試名字走一次新增→打卡出現→停用（測試後在該店把測試列停用）；正式網址點得到 |

## 階段 6：7A
| # | 任務 | 驗收 |
|---|---|---|
| F1 | lineHubAutoSupport_ | 四個不成立條件各一測試回原流程；成立時呼叫 B 店 svc_add（op_id 照契約）→綁定→打卡；B 店呼叫失敗回「不確定有沒有進去」原訊息 |
| F2 | 值班核定頁「首次支援」標記 | created_by=`LINE 自動（首次支援）` 且未有核定紀錄時顯示；核定後消失 |

## 階段 7：佈告欄
| # | 任務 | 驗收 |
|---|---|---|
| G1 | server 讀 svcDirectory、staff 加 dzy | 新人新增、離職停用、改名同步；LINE 雜湊來源不變 |
| G2 | 搬家腳本＋本機演練 | 用 spike/sample 真實名冊：每個 S-xxx 對到唯一 dzy 或列為「無對照」，零錯配；報告不印真名 |
| G3 | 拿掉打卡同步按鈕與 CLOCK_PRIMARY_ | 管理頁沒有該按鈕；程式不再讀判定表 |

## 階段 8：退場
| # | 任務 | 驗收 |
|---|---|---|
| H1 | mgr_add_employee 回 disabled | 兩週零「打卡上有、沒對照」異常的紀錄；六店部署後值班核定新增回停用訊息 |
