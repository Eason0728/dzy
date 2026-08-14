# 分層驗證紀錄（T1-10）

驗收的是 requirements.md §6 與 spec.md §6.1 的核心約束：

> **新增第三個模組時，平台層的程式碼一行都不用改**，只需新增一個模組資料夾＋在模組清單加一列。

這條過不了，代表分層沒做成、後面每加一支系統都要動地基——所以它擺在 Phase 1 的最後，
而不是專案最後。日期：2026-08-14。

## 做法

新增一個什麼都不做的假模組 `modules/demo/`（manifest.js ＋ index.js），
在 `platform/registry.js` 的 `MODULES` 陣列加一列，其他什麼都不動。

假模組的權限借用 `platform.users`（只有系統管理者有），
這樣不必為了測試去改正式試算表的 `roles` 分頁——**測試不該碰正式資料**。

## 證據一：平台層只動了一行

```
$ git diff --stat platform/
 platform/registry.js | 1 +
 1 file changed, 1 insertion(+)
```

```diff
 export const MODULES = [
   { load: () => import('../modules/users/manifest.js') },
+  { load: () => import('../modules/demo/manifest.js') },
```

**一個檔、一行新增。** `platform/` 底下其餘 11 個檔（shell.js／auth.js／api.js／ui.js／
fmt.js／config.js／manifest-check.js／views/login.js／css 三支）零改動。

> 註：這條驗收在 2026-08-14 稍早曾經是**無效的**——當時 `platform/` 從未被 git 追蹤過，
> `git diff --stat platform/` 天生就是空白，看起來「通過」其實什麼都沒驗到。
> 由 T1-11 的執行者指出後，先把 Phase 1 成果 commit 建立基準，這條才真的有效。

## 證據二：模組真的載得起來、跑得動

在瀏覽器裡走真實的動態載入路徑（不是測試替身）：

| 檢查項 | 結果 |
|---|---|
| `registry.js` 的模組數 | 2 |
| 載入並通過 manifest 驗證的模組 | `users(人員管理)`、`demo(示範模組)` |
| 假模組的驗證結果 | `{ok: true, errors: [], warnings: []}` |
| `manifest.entry()` 動態載入模組本體 | 成功 |
| `mount()` 畫出內容 | 成功（`<div class="card" data-role="demo-root">…`） |
| `badge()` 回傳待辦數字 | `3` |
| `unmount()` 後容器清空 | `true` |

## 證據三：既有測試沒被弄壞

九支測試共 351 項，加入假模組後全數通過。

## 收尾

驗證完成後**假模組已移除**（`modules/demo/` 刪除、`registry.js` 那一行還原），
它不該留在正式系統裡讓系統管理者看到一張假卡片。本檔即為它存在過的紀錄。

Phase 2 加入稽核兩個模組、Phase 3 加入宿舍模組時，**要再各跑一次這個檢查**：
`git diff --stat platform/` 必須只有 `registry.js` 一行。
若某次發現非改平台層不可，那不是「這次特例」，是分層破了，要停下來修架構。
