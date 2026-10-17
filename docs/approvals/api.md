# API 契約：表單簽核（正本；spec §14.13）

共通：`POST /platform/api`，body `{action, token, payload}`，回 `{ok:true, data}` 或 `{ok:false, error, message?}`（平台既有形狀）。
錯誤碼（error 字串）：`unauthorized`（token 失效）、`forbidden`、`bad_request`（欄位錯，message 說哪一欄）、`bad_amount`、`not_found`、`conflict`（rev／step／ver 不符）、`no_files`（請款沒收據）、`file_invalid`、`busy`（寫入鎖逾時，既有）。
時間一律毫秒數字；金額整數元；DZY 編號大寫字串。

## 型別
```
Form = {
  id, type, status, rev, step, sender:{emp,name,unit_name}, subject?:{emp,name},
  amount, body, files:[FileRef], route: Route, handler_dept, created_at, updated_at,
  stuck: boolean,            // signing/handling/exception 且超過 72h（exception 當天即 true）
  can: { decide, sign, resubmit, withdraw, handle, reassign, void }   // 伺服器算好，前端只拿來顯示按鈕
}
Route = { v:1, thr_ver, row:{seq,max,role}|null, steps:[Step], handler }
Step = { role:'head'|'brand_dir'|'ceo'|'gm'|'chair'|'direct'|'self_sign', scope, status:'pending'|'done'|'skipped',
         by?:emp, at?, candidates?:[{emp,name}], override?:{to,by,reason,rev,at} }
FileRef = { id, kind:'receipt'|'sign', bytes }
Event = { at, rev, actor:{emp,name}, action, note }
ThrRow = { seq, max:number|null, store_role, hq_role }
```
`candidates` 只在 apvGet、apvRoutePreview 回；其他列表不回。

## 讀取
| action | payload | data |
|---|---|---|
| apvThresholdGet | `{}` | `{ver, rows:[ThrRow]}` |
| apvRoutePreview | `{type, amount?, subject?, kind?}` | `{steps:[Step 含 candidates], handler}` |
| apvMine | `{status?}` | `{forms:[Form 不含 body]}`（新到舊，最多 200） |
| apvTodo | `{}` | `{sign:[Form 不含 body], handle:[Form 不含 body], exception:[...] (只給 platform.staff/admin)}` |
| apvGet | `{id}` | `{form:Form, events:[Event], revisions:[{rev,at,sha256}]}` |
| apvList | `{month?:'YYYY-MM', type?, status?}` | `{forms:[Form 不含 body]}` |
| apvExport | `{month:'YYYY-MM'}` | `{rows:[{id,rev,type,unit_name,sender_name,amount,category?,vendor?,desc,created_at,approved_at,done_at,handle_note}]}` |
| apvFileMeta | `{id}` | `{id,kind,bytes,form_id}`（權限同 apvGet） |

## 寫入（全部進 MUTATING_ACTIONS）
| action | payload | data |
|---|---|---|
| apvSubmit | `{client_id, type, body, files:[id], subject?}` | `{id, status, route}`（同 client_id 重送回原單） |
| apvResubmit | `{id, rev, body, files:[id]}` | `{id, rev, status, route}` |
| apvWithdraw | `{id, rev, step}` | `{status:'withdrawn'}` |
| apvDecide | `{id, rev, step, decision:'approve'|'reject', note?}` | `{status, step}` |
| apvSign | `{id, rev, step, sign_file}` | `{status, step}` |
| apvHandle | `{id, rev, result:'done'|'return', note?}` | `{status}` |
| apvReassign | `{id, rev, step, to, reason}` | `{status, step}` |
| apvVoid | `{id, reason}` | `{status:'voided'}` |
| apvThresholdSave | `{expected_ver, rows:[ThrRow]}` | `{ver, diff:[{seq, before, after}]}` |

## body 形狀（伺服器驗；spec §4＋§14.6、§14.9）
```
purchase:  {items:[{name,qty,unit,price}], vendor?, purpose, need_date:'YYYY-MM-DD'}
expense:   {spend_date, category:'repair'|'food'|'misc'|'transport'|'supplies'|'other', amount, desc,
            payee:'self'|'vendor', vendor_name?, purchase_id?}
personnel: {kind:'leave'|'transfer'|'raise', effective, from:{unit,title,pay?}, to:{unit?,title?,pay?}, reason,
            sign_file?, paper_files?:[id]}
```
category 中文：repair 設備維修、food 食材臨時採購、misc 雜支、transport 交通、supplies 文具耗材、other 其他。

## 照片路由（jobs.js；body ≤256 KB）
| 路徑 | body | 回 |
|---|---|---|
| `POST /platform/svc/apv-file-put` | `{token, kind:'receipt'|'sign', mime, b64}` | `{ok:true, data:{id, bytes}}`；錯 `file_invalid`／`file_too_large`／`quota`（每人每天 60） |
| `POST /platform/svc/apv-file-get` | `{token, id}` | `{ok:true, data:{mime, b64}}`；看不到 → `forbidden` |

## jobs 專用全域函式（不進 Code.gs 分派表）
`apvFileAuthorize_(token)→{emp}`、`apvFileRegister_(emp, meta)→{id}`、`apvFileCanRead_(token, id)→{ok,path,mime}`、
`apvFileSweepList_()／apvFileSweepDone_(ids)`、`apvBackupList_(afterSeq)→[{seq,id,path,sha256,form_id,rev}]`、
`apvDigest_()→{count, title, text}`、`apvReconcile_()→{skipped}`。
