結論：目前不應上線。前 7 項都是可造成帳號接管或無法即時止血的阻擋問題。

1. **高｜「可信綁定」實際只需姓名、定位、一次打卡及等待 7 天。**  
   情境：同事在店內輸入受害者全名，用自己的 LINE 完成綁定，當天成功代打一張卡，之後只需等待；受害者若繼續用舊連結打卡，不一定會發現。7 天後攻擊者即可開通或重設受害者帳號，並非文件所稱需連續代打一週。出處：[requirements.md:27–29](docs/requirements.md:27)、spec.md:33、src/clock/LineHub.js:93–123。修法：LINE 綁定若要成為帳號恢復憑證，必須再驗證受害者原有資料，例如人資預存手機 OTP、一次性邀請碼或主管核准；時間與打卡紀錄不能取代身分驗證。

2. **高｜冒領者能自行設定日後的傳統重設憑證。**  
   情境：LINE 開通讓申請人自行填生日與手機；冒領成功後，這些值會成為既有「生日＋手機」重設所比對的正式資料。即使日後主管解除 LINE 綁定，攻擊者仍可用自己填的生日、手機再次奪回密碼。出處：[requirements.md:24–32](docs/requirements.md:24)、spec.md:41、src/platform/Staff.gs:657–672、720–754。修法：同一身分因素不可同時建立新的恢復因素；自填資料應標記未驗證且不得用於忘記密碼，直到 OTP 或人資核實。解除可疑綁定時須同步撤銷 token、強制改密碼及清除未驗證恢復資料。

3. **高｜跨店「任一店可信即可」使單店解綁無法撤銷身分。**  
   情境：現有流程能把同一 LINE 自動綁至支援店；規格又允許多店中任一店可信即授權。主管只在主店解綁時，另一店的綁定仍可永久用來重設密碼。出處：[spec.md:25、34](docs/spec.md:25)、src/clock/LineHub.js:225–305、src/clock/Liff.js:227–241。修法：建立集團層級的 LINE 身分登錄與版本號；區分「解除單店打卡」及「全公司撤銷 LINE 身分」，後者必須讓所有店的舊綁定立即失效。

4. **高｜解綁或停用後，舊 LINE 最少仍可用到隔夜同步；故障時可無限延長。**  
   情境：00:10 後解除綁定，平台仍保存舊 `line_h` 至下一次成功同步；單店抓取或套用失敗時，既有程式只保留舊資料並每 30 分鐘重試，沒有授權資料的有效期限。此外 `roster_active≠FALSE` 會把空白／未知狀態視為可用。出處：[requirements.md:52](docs/requirements.md:52)、spec.md:19、32–34、src/mini/jobs.js:266–303。修法：解綁、停用要即時推送撤銷事件；reset/claim 必須要求 `roster_active === TRUE` 且來源同步時間在短期限內，任一相關店同步失敗即拒絕授權，或在寫入前即時回查來源。

5. **高｜ID token 可重放，且沒有綁定這次操作或新 LIFF。**  
   情境：reset／claim 直接接受可重複使用的 `id_token`，只檢查 `aud`、`exp`；同一 channel 又供既有多個 LIFF 使用。從任一頁面、log 或裝置竊得有效 token 後，在到期前第一次重放便足以改密碼，5 次限流無法阻止。出處：[spec.md:45–49](docs/spec.md:45)、requirements.md:38、44。修法：敏感操作改用伺服器產生的短效單次交易，綁定員工、操作、表單摘要及 nonce 並原子消耗；最好採專用 audience／授權碼＋PKCE。若仍只有 bearer token，重設密碼應再要求獨立因素。

6. **高｜內部寫入函式沒有規定鎖、冪等或失敗補償。**  
   情境：`lineAuth*` 刻意繞過 Code.gs 分派表，但既有程式明示內部寫入函式必須自行取得 ScriptLock。兩個平行 claim/reset 可同時通過重查；也可能在 HR 停用後用舊快照覆寫回 active。claim 又先啟用 staff／執行副作用、再寫密碼，中途失敗會留下半開通帳號且無法安全重試。出處：[spec.md:36–41](docs/spec.md:36)、src/platform/StaffClock.gs:1229–1239、src/platform/Staff.gs:655–676。修法：以同一把 ScriptLock 包住最後重查、全部寫入與狀態提交；加入交易 ID、冪等回應及可恢復的 staged 狀態，並對每個寫入點做故障注入測試。

7. **高｜沒有服務端停止開關及資料回退方案。**  
   情境：發現冒領漏洞後，即使移除按鈕、關閉 LINE 關鍵字，已知 `/platform/svc/line-auth` 的人仍可直接 POST；文件也沒有處理已被開通或重設帳號的回復程序。出處：[spec.md:45–64](docs/spec.md:45)、task.md:43–46。修法：Node 與 GAS 都檢查預設關閉的 `LINE_AUTH_ENABLED`。回退順序應為先關 GAS 授權、再停 route、撤入口，最後依 `line_claim_ok`／`line_reset_ok` 清單撤銷 token、停用可疑帳號或強制重新驗證。

8. **中｜職稱仍由本人自選，且漏列既有權限變更前置檢查。**  
   情境：申請人可把自己選成 `ft`；現有資料中 `pt` rank 1、`ft` rank 2，登入權限又會按職稱與 `perm_map` 動態計算。新規格列出核准副作用時只有事後 audit，漏掉既有 `permStaffChangeCheck_` 的寫入前阻擋；目前或日後若 `ft` 配到敏感權限，即形成提升。出處：[spec.md:39–42](docs/spec.md:39)、src/platform/Staff.gs:1304–1311、1535–1538、src/platform/Auth.gs:891–900。修法：職稱沿用人資既有值；沒有權威職稱即 `need_review`，不能自選。抽出的共用核准函式必須包含 `permStaffChangeCheck_`，並測試前後權限集合而非只比 staff 列。

9. **中｜實際 LINE 打卡路徑不會寫 `line_ok_at`。**  
   情境：規格與任務只在 `liff_punch` 成功後更新，但目前中央 LINE 入口走 `line_quick_clock → liff_clock`。員工明明用 LINE 成功打卡，仍會永久顯示不可信。出處：[spec.md:23–25](docs/spec.md:23)、task.md:5–8、src/clock/LineHub.js:48、190–192、364–369、src/clock/Liff.js:473–486。修法：由共用 helper 在 `liff_punch` 與已驗 token 的 `liff_clock` 成功後更新；兩條路徑都要有成功、被擋、寫入失敗測試。

10. **中｜「唯一主店」規則與既有實作不一致。**  
    情境：規格引用的 `storeHomeFn_` 不存在；實際 `clkHomeStoreFor_` 會從非 rejected、甚至 suggested 的多店資料中依最近打卡強制選出一家，而非確認「唯一主店」。支援店剛好較晚打卡時，免審開通可能把正式單位寫成支援店並觸發調店副作用。出處：[spec.md:4–7](docs/spec.md:4)、task.md:23–24、src/platform/StaffClock.gs:368–403。修法：另訂開通專用判定，只接受恰好一筆 `confirmed + roster_active=TRUE + role=home + 同步新鮮`；其餘一律 `need_review`。

11. **中｜歷史停用綁定會讓重綁或復職永久 ambiguous。**  
    情境：找人規則先把所有相同 `line_h` 的 emp_no 去重，沒有先排除失效列；既有停用流程不清 `line_user_id`，svc_roster 也會回全部名冊列。復職換編號、跨店誤綁或惡意綁第二人後，兩個帳號都可能永久不能使用。出處：[spec.md:33–34](docs/spec.md:33)、src/clock/SvcStaff.js:82–99、144–184。修法：建立含 active、revoked_at、binding_version 的中央綁定紀錄；身分移轉必須由 HR 明確結案，不能只靠全歷史 hash 去重或靜默忽略舊列。

12. **中｜`line_h` 的去識別邊界不成立，且共用金鑰爆炸半徑過大。**  
    情境：同一把 `LINE_MAP_KEY` 人工複製到六個 GAS 專案及 mini，沒有 key ID、輪替或錯配偵測；任一店 Script Property 洩漏即影響全公司。文件又稱原始 userId 不落盤，但現行 roster 與 `liff_bind_log` 都永久保存原文，解綁時也把原文寫入 log。出處：[spec.md:21、26–27、50](docs/spec.md:21)、src/clock/Liff.js:117–149、227–240。修法：重新畫完整資料盤點；使用隨機 256-bit 金鑰、`kid`、雙金鑰輪替及部署一致性檢查，最好把跨店 HMAC 集中在 mini/KMS。稽核表改存獨立假名值並設定保存期限與最小讀取權限。

13. **中｜限流規則可誤傷整店，也不足以擋分散式洪水。**  
    情境：同一門市 Wi‑Fi／NAT 下，15 人各做 check＋submit 就可能吃完「同 IP 30 次／10 分鐘」；規格未定義可信代理 IP、原子計數、重啟後保存或驗 token 前的全域上限，攻擊者可換 IP 或利用重啟持續燒 LINE verify。出處：[spec.md:45–49](docs/spec.md:45)、task.md:30–35。修法：只信受控代理覆寫的來源 IP，使用持久且原子的 TTL 計數；分開設全站、錯 token、帳號及成功操作額度，並測試共享 NAT、偽造 X-Forwarded-For、重啟和併發。

14. **中｜CORS 仍是未定案的上線必要條件。**  
    情境：目前規格仍標「未確認」；未允許正確 origin 時頁面完全不能用，若為求能用而開 `*`，則任何持有 token 的網站都可呼叫敏感 route。備援 `/platform/api` 也未定義精確 origin/action 邊界。出處：[spec.md:45–51](docs/spec.md:45)、plan.md:33、task.md:30–33。修法：優先以同源反向代理消除 CORS；否則後端只允許 `https://dzy.mozhuting.com`，同時拒絕錯誤 Origin，加入正反向瀏覽器測試後才可部署。

驗收：`rg --files docs src | sort` 找到 11 個受審檔；`wc -l docs/*.md src/platform/*.gs src/clock/*.js src/mini/jobs.js` 共 8,722 行。以上共 14 條、未超過 15 條，並經兩份 fresh-context 唯讀對抗審查交叉核對；本輪未修改任何檔案。
