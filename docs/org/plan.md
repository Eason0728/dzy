# 技術方案：鼎兆元組織架構改版（plan）

- 日期：2026-10-14　依據：spec.md（已確認）
- 分支：`feature/org-2026-10`（worktree `~/dzy-wt-org`），完成後 PR 合併 main。

## Phase 1 後端（里程碑：node 測試全綠，升級跑兩次結果一樣、回退後與備份逐格相同）
T1 組織預設值與 office 門檻 → T2 兼任部門欄 → T3 審核規則 → T4 升級／回退 action
- 階段關：**上線前高風險關**＝Fable＋GPT 互盲，只審 T3（審核＝權限）與 T4（改正式資料）。紀錄在 GitHub issue。

## Phase 2 前端（里程碑：真瀏覽器點過同仁名單、我的資料、BOSS 按鈕）
T5 同仁名單（兼任部門、停用標記、需處理篩選、升級／回退按鈕）→ T6 我的資料顯示兼任
- 階段關：Fable，issue。

## Phase 3 切換（Eason：做好就切）
T7 整套：全部 node 測試＋e2e 八支＋佈告欄 staffdzy 測試 → sync-gas → 交辦 Mac mini 換後端 → 推前端 → Eason 用 BOSS 按升級 → 驗。

## 共用契約（逐字）
- `extra_depts` 存法：staff 分頁欄位 `extra_depts`，值＝部門代碼以半形逗號相連、無空白、依 org order 排序；沒有＝空字串。例：`it,training`
- API 回傳（同仁名單 list、我的資料 me 的 staff 物件）：`extra_depts: ['it','training']`、`extra_dept_names: ['資訊部','訓練部']`，沒有＝`[]`。
- `staffEdit` payload：`extra_depts: ['it']`（陣列；不給＝不改；給 `[]`＝清空）。非 platform.staff 帶這欄 → `{ok:false,error:'沒有權限修改兼任部門'}`。
- 名單每列 `flags: []`，可能值：`'unit_inactive'`（單位停用）、`'title_ladder'`（職稱不屬於單位階梯）（store_sv_bd 已取消，見 spec 第 13 節）。
- 規格第 13 節優先於第 12、11 節與本檔。
- `orgUpgrade2026` payload `{dryrun:true|false}`；回傳 `{ok:true,data:{backup:'created'|'exists', org:[{code,kind,field,from,to}], clock:'updated'|'skipped'|'custom', staffColumn:'added'|'exists', titles:[{emp_no,name,from,to}], todo:[{emp_no,name,unit_name,flag}]}}`；`orgRollback2026` 回傳 `{ok:true,data:{restored:<列數>}}`，沒有備份 → `{ok:false,error:'找不到備份 org_bak_20261014'}`。兩者只有 role admin。
- 審核者種類代號（stfReviewScope_ 回傳 `kinds` 陣列）：`'store'`（同店店長以上）、`'brand'`（品牌辦公室區經理 oam 以上，帶 brand，只審該品牌門市店長）、`'ops'`（營運部主管）、`'dept'`（部門主管，帶 dept）、`'exec'`（執行長以上）、`'ck'`（中央工廠主管）。

## 風險
- users 分頁欄數陷阱（dzy-admin skill）：本案不碰 users 分頁。
- staff 分頁尾端欄：照 clkEnsureStaffExtra_ 補在 hire_date、last_day 之後；不改 STF_HEADERS。
- minikit 會把像數字的字串轉數字：extra_depts 是英文代碼，不受影響；比對一律 String()。
