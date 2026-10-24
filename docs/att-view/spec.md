# 督導看負責門市的考勤（只看）規格 v0.1（2026-10-25）

> 起因：區督導（品牌辦公室 osv）在「人資部門 → 考勤管理」只看得到店長的申請（可審），看不到自己負責門市一般同仁的出勤，
> 沒辦法盯店長有沒有按時核定。本檔只管「督導／總監**看**考勤」；區域本身（資料、設定畫面、審核改成只給該區）歸
> `docs/regions/spec.md`（branch `regions`），**本案不另外定義區域**。文件不寫真名。

## 0. Eason 已拍板（2026-10-25 問卷）
1. **只看**：看得到每天上下班、核定了沒、加班請假忘刷紀錄；所有寫入都不能做。核定工時照舊由店長（央廚廠長）做。
2. **分頁**：核定工時（核定狀況）、申請審核（申請紀錄）、員工名冊。**不給**：裝置（新手機核准）、公告。
3. **總監（odir）看整個品牌**的門市；區督導只看自己負責區域的門市。
4. **區域還沒劃好之前，督導什麼都看不到**（跟現在一樣只有店長申請可審）；人資在「區域」設定頁把店劃給他之後才出現。
5. **2026-10-25 晚上替 Eason 決定（他已睡，選保守、可改）**：整個「只看」功能（督導與總監）掛在區域審核開關 `REGIONS_ON === '1'` 底下；開關關著＝沒有人多看到任何東西。Eason 指示 REGIONS_ON 上線後維持關著、看過切換檢查再自己按，所以按下那一刻督導的審核縮到該區、同時開始看得到該區考勤。要讓總監先看、不等區域，改一行即可。

## 1. 名詞
- **看得到名單（view）**：新的第三份名單，只用來「讀」。和現有兩份並列：
  - 核定工時名單 `att.people`（營運系統 `attKeys`）——可讀可核定工時。
  - 申請審核名單 `att.req_people`（營運系統 `reqKeys`）——可讀可核准／退回申請。
  - **看得到名單 `att.view_people`（營運系統 `viewKeys`）**——只能讀，任何寫入一律擋。
- 一個人可以同時在兩三份名單裡（例：督導對 A 區店長＝申請審核＋看得到）。按鈕與後端放行都只看「寫入那份名單」。

## 2. 誰看得到誰（管理系統 `StoreOps.gs`）
| 看的人 | 看得到的門市 | 依據 |
|---|---|---|
| 區督導 osv | 自己負責的區域裡的門市 | `regionIndex_(…).bySupervisor[本人 emp]` → 各區 `stores`（regions spec §3；已失效的督導索引裡就是空） |
| 總監 odir | 本人品牌辦公室所屬品牌的**全部門市** | org：ladder store、parent＝該品牌、active、不含 ck |
| 其他人 | 不新增 | — |

- 「看得到的同仁」＝上面那些門市裡、`attNeedOf_(t, org, 'hours')` 需要核定工時的人（含店長、區經理），經 `storeEffectiveTarget_` 推算主店的也算；orphan（推算不出單位）不給。
- **掛在 `REGIONS_ON` 底下**（第 0 節第 5 條）：本案直接讀 Script Property，只有值恰好 `'1'` 才算開；關著 `view_people` 一律 `[]`。
- 區域索引用 regions 提供的無參數 `regionIndexLive_()`（不存在＝regions 還沒合併＝督導沒有區，回 `[]`；所以兩案合併先後都不會壞）。
- 結果同樣過 `storeAttPeople_(…, pilot)`：只列已接上營運系統出勤核定的門市（pilot）。⚠ 目前營運系統 duty 轉送只接了 6 套打卡（麻的小辛辣只有光復；墨竹亭光復／金山／六張犁；央廚；總部），沒接上的店督導照樣看不到，**這不是本案要補的**。
- 寫法：新增純函式 `attViewUnitsOf_(me, org, regionIdx)` → 門市代碼陣列；`storeAttTargets_` 不動，另寫 `storeAttViewTargets_` 篩人（避免把「看」混進「核」的判斷）。admin／人資主管本來就看全部，不必再給 view。
- ident（`storeIdentFor_` 回傳）：`att: { people, req_people, view_people }`。形狀與 `people` 完全相同。
- 不改：`units_managed`（督導不會變成「店長」，不會拿到整店功能）、`void_units`、`platform.att` 閘門（osv、odir 本來就在 `STORE_ATT_GATE_TITLES`）。

## 3. 營運系統（`~/mala-store-ops`）
**後端一定要擋，不能只藏按鈕。**
- `server/person.js`：從 `ident.att.view_people` 建 `viewKeys`（同 attKeys 的複合鍵 `打卡店別|emp_id`）；沒有這欄（舊版管理系統）＝空集合。
  `dutyEntry` 加上 `viewKeys.size > 0`；可選門市清單（第 127 行那段）加「viewKeys 在這家店非空」。
- `server/proxy/duty.js` ACTIONS 加一個屬性 `view: true`，只標在這些**讀取**動作：
  `mgr_pending_approvals`、`mgr_day`、`mgr_req_pending`、`mgr_req_day`、`mgr_roster`、`payroll_leave_options`（核定頁顯示假別需要；store_safe 本來就依人過濾）。
  - 標了 view 的讀取：`keyOk` 多接受 `viewKeys`（與原本那份名單取聯集）。
  - **寫入動作（kind write）永遠不看 viewKeys**，連查都不查；`manager_only` 規則不變（督導不是 isManager，QR／公告／新增同仁／名冊異動照擋）。
  - 不標 view：`mgr_pending_devices`（Eason 不給裝置分頁）、`mgr_line_binds`、`mgr_qr_token`、`line_hub_attach_get`（申請附件，要讀再另議）。
  - 「全部門市」模式 `ALL_OPS` 的讀取同樣吃 view。
- `server/att-alerts.js`（管理系統首頁考勤待辦）：**只看 attKeys／reqKeys，不得把 viewKeys 算進待辦**。`dutyHours` 也只由 attKeys 決定。加一條測試釘住：只有 viewKeys 的人，approve 與 request 都是 0。
- 前端 `web/modules/duty/`：每位同仁依「在不在寫入名單」決定有沒有按鈕；只在 view 名單的列顯示「唯讀」小字、不出現核定／核准／退回／批次勾選。
  某家店對這個人只有 view（attKeys、reqKeys 都沒有這家店的人）時，該店分頁只剩 approve（核定工時，唯讀）／request（申請審核，唯讀）／roster（員工名冊，唯讀，不出現停用、新增鈕）；device、notice 不出現。
  頁頂分頁（`dzy-store-nav`）照這個規則送，管理系統殼不用改。
- 稽核紀錄：讀取不另記。

## 4. 契約（兩個 repo 同步）
- `test/fixtures/dzy-store-contract-v2.json`：ident 範例加 `att.view_people`；dzy 與 mala-store-ops 兩份**逐字相同**（既有比對測試會抓）。
- 向下相容：舊營運系統收到多的欄位會忽略；新營運系統沒收到這欄＝沒有人只看。所以部署順序任一邊先上都不會壞，**照慣例管理系統先**。

## 5. 依賴與上線順序（跟 org-regions）
| 步驟 | 內容 | 依賴 |
|---|---|---|
| R1 | regions 後端：`regions` 分頁、`regionIndex_`、`Regions.gs` 進 minikit app.json（regions spec §12 第 1 步） | — |
| V1 | 本案管理系統後端：`view_people`（osv 用 regionIndex_、odir 用 org） | 不必等 R1（沒有 `regionIndexLive_` 時督導看不到）；`attApproverOf_`／`attNeedOf_` 若 regions 也在改，後合併的 rebase |
| V2 | `sync-gas.sh dzy-platform --i-know` → minikit commit push → mini pull、重啟（可與 R1 同一次） | V1 |
| V3 | 營運系統 server＋web（viewKeys、view 標記、唯讀畫面），網站 dzy-store-pages 發布 | V2（先上也不壞，只是沒資料） |
| R2–R5 | regions 前端、人資劃區、開「依區域審核」 | 與本案無關；**人資劃區（R3）之後督導才看得到** |

- **本分支（PR #18）已 rebase 在 regions（PR #19）上，#19 先合**；合併後 `storeIdent_` 與 regions 共用 `storeAttTargets_(…, rctx)`，且 REGIONS_ON=1 時督導的 req_people 會縮到該區。
- 總監那一半不靠區域資料，但同樣要等 `REGIONS_ON` 打開。
- 本案沒有自己的開關，跟著 `REGIONS_ON`：關著時兩邊程式都上線也沒有人多看到東西。

## 6. 測試與驗收
- dzy node：`test/storeops.mock.test.mjs` 3c（另 1a2 對 fixture `ident_osv_view`，用真 regions 分頁資料）：督導 A（負責 A 區）view_people＝A 區門市全員、不含 B 區；未劃區督導＝[]；失效督導（停用／調品牌）＝[]；總監＝全品牌門市；ck、品牌辦公室、總部同仁不出現；admin／人資主管不多回 view（或回了也不影響）。
- 營運系統：
  - duty proxy：只有 viewKeys 時 `mgr_day`／`mgr_pending_approvals`／`mgr_req_pending`／`mgr_roster` 讀得到該員；`mgr_approve`、`mgr_req_decide`、`mgr_req_decide_batch`、`mgr_device_decision`、`mgr_set_active`、`mgr_line_unbind` 全部 FORBIDDEN；`mgr_pending_devices` 讀不到。
  - att-alerts：只有 viewKeys 的人待辦＝0。
  - 舊 ident（沒有 view_people）行為不變。
- 真瀏覽器（假資料）：督導帳號進考勤管理 → 看到 A 區門市、只有三個分頁、沒有任何按鈕；用開發者工具直接打 `mgr_approve` 被擋；首頁考勤待辦數字沒變。
- 契約 fixture 兩邊 `diff` 為空。

## 7. 不做／留給實作者
- 不做：督導核定工時、裝置核准、公告、申請附件、LINE 綁定紀錄；督導看央廚／總部；區域本身任何東西（歸 regions）。
- 留給實作者：「唯讀」字樣與排版、view 名單是否排除已在寫入名單的人（建議不排除，前端依寫入名單決定按鈕即可）、`payroll_leave_options` 若讀不到時核定頁唯讀模式是否乾脆不顯示假別額度。
