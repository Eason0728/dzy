# 任務清單：個人帳號第二期

每個任務 100–200 行以內；驗收要附「實際跑的指令＋輸出」。狀態：☐ 未做 ☑ 完成。

## P1 後端計算
- ☐ **T1-1 Perms.gs 常數與建表**：`PERM_GRANTABLE`、`PERM_LOCKED`、三張表表頭、`setupPerms_()`（只補不覆蓋、表頭不一致回錯、perm_map 空表才寫預設規則、perm_store_map 寫 5 筆預設）。
  驗收：mock 測試——空資料庫建出三表＋預設規則 19 條＋對照 5 筆；再跑一次不重複；表頭被改過回錯。
- ☐ **T1-2 permCompute_ 純函式**：輸入 `(staffRow, org, rules, exs, storeMap, todayStr)`，輸出 `{perms, scope, sources}`（sources 給 myPerms 用）。
  驗收：表格測試 ≥ 25 例——店長／正職／區經理／區督導／總監／行政同仁／人資同仁／人資主管／財務／管理／營運／執行長；兼任部門；例外 add、remove、remove 優先、當天到期仍有效、隔天失效；白名單外的碼被丟掉；非 active 回空；店別缺對照回 `[]`。
- ☐ **T1-3 規則與例外驗證**：`permValidateRule_`、`permValidateEx_`（ladder／title／dept 合法、dept 只限 hq、鎖碼、白名單、until 不早於今天、note 1–50 字）。
  驗收：每個錯誤碼各一正一反案例。

## P2 後端接線
- ☐ **T2-1 authPermsWithGate_ 接 permCompute_**（只 role staff），回傳加 `scope`；login／me 形狀向下相容（多欄不刪欄）。
  驗收：`test/staff.mock.test.mjs`、`users.mock.test.mjs` 全綠＋新案例「店長 me 有 audit.read.own」。
- ☐ **T2-2 proxyAuthorize_ 陣列裁切**：canRead 納入 audit.read.brand；同仁 scope → filterNode；none → 403；系統帳號行為不變。
  驗收：`test/proxy-authorize.test.mjs` 舊案例全過＋brand 陣列、空陣列、同仁無權限、audit.write 拿 null。
- ☐ **T2-3 新 action ×7**＋Code.gs 白名單／分派＋LockService＋staff_log。
  驗收：每個 action 權限正反各一；非 admin 改鎖碼回 perm_locked；`proxyAuthorize_` 不在分派表（測試斷言）。
- ☐ **T2-4 org 初始值修正**：osv rank 2、odir rank 3（預設 org＋STF_UPGRADE_ADD）；`org-upgrade.mock.test.mjs` T1 改。
  驗收：org-upgrade 測試全綠。

## P3 mini 裁切
- ☐ **T3-1 proxy-hook.js filterResponse 支援陣列**＋共用案例檔 `test/fixtures/filter-cases.json`（前端與 minikit 都讀）。
  驗收：minikit `test/runner/dzy-platform.test.js` 全綠＋新案例。
- ☐ **T3-2 sync-gas.sh dzy-platform**，minikit commit push；寫 mini 交辦（貼對話）。
  驗收：sync 成功、SOURCE.sha256 更新。

## P4 前端
- ☐ **T4-1 api.js filterOwnNode_ 支援陣列**（讀同一份案例檔測試）；dryrun.js 平台讀清單加 permMapGet／permExList／permStoreGet／myPerms。
- ☐ **T4-2 modules/perms：對照表分頁**（列＝功能、chip＝對象、新增對象三段選、鎖碼灰掉）。
- ☐ **T4-3 modules/perms：個別例外分頁＋店別對照分頁＋alerts()**。
- ☐ **T4-4 我的資料「我能用的功能」**。
- ☐ **T4-5 稽核兩模組 manifest requires**；e2e t1–t8 卡片數若變動跟著改。
- ☐ **T4-6 e2e_t11_perms.py**（mock 後端）：店長、區督導、人資、鎖碼、例外到期。
  驗收（P4 整體）：`for f in test/*.test.js test/*.test.mjs` 全綠；`./test/e2e/run_all.sh` exit 0 且最後一行為全部通過；真瀏覽器點過權限設定三分頁。

## P5 階段關
- ☐ **T5-1** 開 GitHub issue；Fable（新 Agent、model fable）＋GPT（codex-gpt.sh 背景、結果不給 Fable 看）互盲審提權／裁切／部署相容。修完再一輪。

## P6 上線
- ☐ **T6-1** spec §10 第 1–4 步。
- ☐ **T6-2** Eason 實測＋落地清單八項。
