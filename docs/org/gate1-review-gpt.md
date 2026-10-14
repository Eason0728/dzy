找到 8 條可觸發缺陷：A 1 條、B 7 條。

1. **高｜未知 ladder 可取得審核權** — [Staff.gs:791](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:791)、[Staff.gs:819](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:819)  
   輸入：active 單位 `x` 的 `ladder=''`，active 同仁職稱為 `sm(parent=store)`；待審者送出 `p_unit=x,p_title=pt`。→ `|| 'store'` 把空 ladder 當門市，該同仁取得 `platform.review` 並能核准，違反 [spec.md:119](/Users/guoeason/dzy-wt-org/docs/org/spec.md:119)「未知 ladder 無主管權限」。  
   修法：scope/need 僅接受 `store|office|hq`；空白或其他值直接回 `null`。

2. **高｜回退中斷後無法重跑收斂** — [Staff.gs:1645](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:1645)、[Staff.gs:1685](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:1685)  
   輸入：回退已成功蓋回 org，接著 clock 寫入在 1692 行逾時或丟錯。→ state 尚未清除；再次回退時，舊 org 不等於「升級後 hash」，1646 行直接拒絕，clock 留在新版、org 已是舊版。  
   修法：記錄 rollback phase，或讓 hash gate 辨認「org 已等於備份」並續跑剩餘步驟。

3. **高｜重跑升級會洗掉回退防護基準** — [Staff.gs:1623](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:1623)  
   輸入：成功升級後新增 `unit extra-x`，同時把 `mala-hq.name` 改壞，再重跑升級。→ 程式修回名稱後，因 `plan.cells.length>0` 將包含 `extra-x` 的現況寫成新 hash；之後回退通過檢查並整表覆蓋，`extra-x` 被刪。  
   修法：`org_hash/org_snap` 只准首次成功時建立；已有 hash 時不得更新基準。

4. **高｜缺少職稱或 clock 備份仍回報回退成功** — [Staff.gs:1666](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:1666)、[Staff.gs:1689](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:1689)、[Staff.gs:1707](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:1707)  
   輸入：升級後 `stf_bak_*` 被刪，再執行回退。→ 職稱還原被靜默略過，org 卻回到舊版；同仁仍是不存在的 `ofs/osv`，state 隨後被清除且回 `{ok:true}`。`clk_bak` 或正式 `clock_stores` 缺失也相同。  
   修法：回退寫入前完整檢查所有 state 指向的備份及正式分頁；缺任一份即零寫入失敗並保留 state。

5. **高｜必要舊列缺失時升級仍宣告成功** — [Staff.gs:1480](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:1480)、[Staff.gs:1618](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:1618)  
   輸入：org 表頭正確，但缺 `mzt-hq`、`ck` 或 `am` 列。→ `STF_UPGRADE_SET` 對找不到的列直接略過；後置檢查也使用同一邏輯，因此回成功但最終組織不完整。  
   修法：所有目標列都以 `(kind,code)` upsert 完整八欄；無法安全重建者則在建立備份前失敗。

6. **中｜同分鐘再次升級會撞備份名稱** — [Staff.gs:1457](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:1457)、[Staff.gs:1577](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:1577)  
   輸入：12:34 升級→回退→12:34 再升級。→ 回退保留同名備份；第二次先覆寫既有 org/clock 備份，再以 `insertSheet(stf_bak_同分鐘)` 建立同名分頁而失敗。現有 mock 在 [org-upgrade.mock.test.mjs:81](/Users/guoeason/dzy-wt-org/test/org-upgrade.mock.test.mjs:81) 會直接覆蓋同名 key，因而沒測出；Google Sheets 官方也明載重複 sheet title 是錯誤。[Google Sheets API](https://developers.google.com/workspace/sheets/api/guides/migration)  
   修法：名稱碰撞時加序號並把實際名稱存入 state；建立任何備份前先一次決定三個唯一名稱。

7. **中｜空白 hq 對照不會補 `yiwu-hq`** — [Staff.gs:1496](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:1496)  
   輸入：`clock_stores` 的 hq 列 `unit_code=''`。→ 1504 行直接 `break`，升級回成功但一悟辦公室沒有總部打卡對照；違反較高優先的 [spec.md:119](/Users/guoeason/dzy-wt-org/docs/org/spec.md:119)「沒有 yiwu-hq 就加」。  
   修法：把空字串視為空集合並寫成 `yiwu-hq`；找不到或有多個 hq 列則升級失敗。

8. **低｜既有 office 列的 order 永遠不校正** — [Staff.gs:1395](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:1395)、[Staff.gs:1490](/Users/guoeason/dzy-wt-org/apps-script/platform/Staff.gs:1490)  
   輸入：既有 `title,osv` 的 `order=99`。→ 升級只校正 name/parent/ladder/rank/active，最後仍為 99，卻通過後置檢查；與第 13 節四級順序不一致。  
   修法：`STF_UPGRADE_ADD_FIELDS` 加入 `order`。

驗證：

- `node test/org-upgrade.mock.test.mjs` → **170/170 通過**
- `node test/staff.mock.test.mjs` → **206/206 通過**
- `authPermsWithGate_`、Code 分派及 StaffClock 對 `extra_depts` 的兩格局部寫入，未找到其他可觸發缺陷。
