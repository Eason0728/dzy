/**
 * modules/pnl/lib/import-logic.js — 匯入頁的純邏輯層（照搬 ~/mala-pnl-auto/gas/importLogic.html 的 script 內容，規則一字不改；
 * 只把外層 IIFE 的掛載對象從 window 換成模組內的 root，再 export）。對照測試：test/pnl-import.test.mjs（vm 跑舊檔 vs 這支，輸出逐列比對）。
 * 檔案 bytes → 2D 陣列的部分（readWorkbook）在檔尾，吃已載入的 SheetJS，邏輯照 gas/import.html 的 readWorkbook／sheetToRows2D。
 */
'use strict';

const root = {};
(function (root) {
  'use strict';

  // ---- 日期容錯（C5：字串／Date 物件／Excel 序號三種都要吃）------------

  // Excel 序號→Date；用 SheetJS 自己也用的演算法（1900 日期系統，epoch
  // 1899-12-30，用 UTC 建構避免瀏覽器當地時區把日期算歪）。
  function excelSerialToDate(serial) {
    var utcDays = Math.floor(serial - 25569); // 1970-01-01 相對 1899-12-30 的天數
    var utcMs = utcDays * 86400 * 1000;
    var fractionalDay = serial - Math.floor(serial);
    var ms = Math.round(fractionalDay * 86400 * 1000);
    return new Date(utcMs + ms);
  }

  // Date 物件的年月日要用哪一種 getter，SheetJS 跟自己手算的 Excel 序號
  // 這裡不一樣，兩條路徑分開處理（Fable 對 PR #30 的審查必修 #2）：
  //
  //   · SheetJS（cellDates:true）：實測（不是查文件猜的）用一份真的 xlsx、
  //     一顆「2026-08-01 00:09」的日期儲存格餵給 XLSX.read 後印
  //     d.toISOString()，結果是 "2026-07-31T16:08:59.999Z"——代表 SheetJS
  //     是用「瀏覽器當地時區」把年月日時分秒組成一個真正的時間點（等同
  //     `new Date(y, m-1, d, H, M, S)`），不是 Date.UTC(...)。所以要用
  //     getFullYear()/getMonth()/getDate()（當地時間）才能讀回儲存格原本
  //     的日期；原本這裡用 getUTC*，在 Asia/Taipei（UTC+8）這種正時區下，
  //     00:00~07:59 這段時間的儲存格會被讀成「前一天」，這正是 00:30
  //     這種凌晨時段容易踩到的邊界（見 test/ui/import-logic.test.js 的
  //     00:30 邊界測試）。
  //   · 自己手算的 Excel 序號（excelSerialToDate）：那是我們自己用
  //     Date.UTC(...) 組出來的 Date，跟 SheetJS 的物件不是同一種構造方式，
  //     維持用 getUTC* 讀回去（跟組的時候用的是同一套時區基準，本來就要
  //     配對，序號路徑本身沒有問題，不用跟著改）。
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function ymdFromUtcDate(d) {
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function ymdFromLocalDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // 回傳 'YYYY-MM-DD' 或 null（三種都對不上／格式不合法）。
  // ⚠ 用 Object.prototype.toString 判斷而不是 `instanceof Date`：本檔在
  // Node 測試裡是用 vm context 執行的（見 test/ui/import-logic.test.js），
  // 那裡建的 Date 物件跟外部呼叫端組 fixture 用的 Date 不是同一個 realm，
  // instanceof 會誤判成 false——跟 gas/api.js 的 convertCell_ 踩過的坑一樣
  // （那裡也是這樣寫的），瀏覽器單一 realm 不會有這個問題，但寫法要一致。
  function cellToDayStr(val) {
    if (Object.prototype.toString.call(val) === '[object Date]') {
      if (isNaN(val.getTime())) return null;
      return ymdFromLocalDate(val); // SheetJS 的 Date：當地時間讀（見上方大註解）
    }
    if (typeof val === 'number' && isFinite(val)) {
      return ymdFromUtcDate(excelSerialToDate(val)); // 自己組的 Date：UTC 讀，維持不變
    }
    if (typeof val === 'string') {
      var s = val.trim();
      // C5：字串「取前 7 碼」當月份，但寫入明細的 note 需要完整日期，這裡
      // 進一步抓 YYYY-MM-DD——Fable 審查建議 #8：日期允許 `/` 當分隔符
      // （例如「2026/08/01」），不是只認 `-`，抓到後統一正規化成 `-`。
      var m = /^(\d{4})[-\/](\d{2})[-\/](\d{2})/.exec(s);
      return m ? (m[1] + '-' + m[2] + '-' + m[3]) : null;
    }
    return null;
  }

  function monthOfDayStr(dayStr) {
    return dayStr ? dayStr.slice(0, 7) : null;
  }

  function daysInMonth(monthStr) {
    var y = parseInt(monthStr.slice(0, 4), 10);
    var m = parseInt(monthStr.slice(5, 7), 10);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  // ---- 分組欄比對（C5：完全相符 → 最長前綴 `xx*` → `"*"` → 未對應）------

  // ---- import-accid（2026-09-28）：「分組欄的值就是科目代號」模式 ----------
  // 範本 mapping 存保留值 { "@ACC_ID": "@ACC_ID" }（唯一一組）代表這個模式：
  // 分組欄每列的值 trim＋大寫化後直接當 acc_id，不用逐列設對應。選這個存法
  // 而不是在「匯入範本」分頁加新欄位，是為了不動分頁欄位（SHEET_SCHEMAS／
  // setup 表頭檢查／光復正式表都不用遷移），舊範本完全不受影響；後端
  // saveTemplatesTable_ 認得這個保留鍵（見 gas/apiWrite.js）。
  var ACC_ID_DIRECT_KEY = '@ACC_ID';
  var IMPORT_ALLOWED_MODES_ = { 匯入: true, 手動: true, 連接器: true }; // 跟 apiImportEntries_ 同一組

  // Fable 審查 PR #54 輕 5：跟後端 saveTemplatesTable_ 一致——mapping 唯一
  // 一組鍵、且值＝@ACC_ID 才算代號直入。
  function isAccIdDirect(template) {
    var m = template && template.mapping;
    if (!m || typeof m !== 'object') return false;
    var keys = Object.keys(m);
    return keys.length === 1 && keys[0] === ACC_ID_DIRECT_KEY && m[ACC_ID_DIRECT_KEY] === ACC_ID_DIRECT_KEY;
  }

  // 輕 7：NFKC（全形英數「Ａ０１２」→「A012」）＋去掉所有空白（含內部、
  // 全形空白、Tab）＋大寫化。
  function normalizeAccIdCell(v) {
    if (v === undefined || v === null) return '';
    var str = String(v);
    if (typeof str.normalize === 'function') str = str.normalize('NFKC');
    return str.replace(/\s+/g, '').toUpperCase();
  }

  function isBlankRow(row) {
    for (var i = 0; i < row.length; i++) {
      var c = row[i];
      if (c !== undefined && c !== null && String(c).trim() !== '') return false;
    }
    return true;
  }

  function matchAccId(groupValue, template) {
    if (isAccIdDirect(template)) {
      var code = normalizeAccIdCell(groupValue);
      return code || null; // 空白＝沒有代號，走「未對應」計數，預覽再列成無法對應
    }
    var mapping = template.mapping || {};
    // group_col 空白＝全部列歸 "*"（模板本身沒有分組欄，不看儲存格內容）。
    if (!template.group_col) {
      return Object.prototype.hasOwnProperty.call(mapping, '*') ? mapping['*'] : null;
    }
    var v = (groupValue === undefined || groupValue === null) ? '' : String(groupValue).trim();
    if (Object.prototype.hasOwnProperty.call(mapping, v)) return mapping[v];

    var bestKey = null;
    var bestPrefixLen = -1;
    Object.keys(mapping).forEach(function (key) {
      if (key === '*' || key.slice(-1) !== '*') return;
      var prefix = key.slice(0, -1);
      if (v.indexOf(prefix) === 0 && prefix.length > bestPrefixLen) {
        bestKey = key;
        bestPrefixLen = prefix.length;
      }
    });
    if (bestKey !== null) return mapping[bestKey];

    if (Object.prototype.hasOwnProperty.call(mapping, '*')) return mapping['*'];
    return null;
  }

  // ---- 表頭欄位定位 -------------------------------------------------------
  // Fable 審查必修 #4：表頭儲存格 trim 後再比對（使用者複製貼上、匯出工具
  // 常常會夾帶前後空白，逐字比對會找不到欄位卻不知道為什麼）。

  function normalizeHeaderCell(v) {
    return (v === undefined || v === null) ? '' : String(v).trim();
  }

  function colIndexOf(header, colName) {
    if (!colName) return -1;
    var target = String(colName).trim();
    for (var i = 0; i < header.length; i++) {
      if (normalizeHeaderCell(header[i]) === target) return i;
    }
    return -1;
  }

  // Fable 審查必修 #4：日期／金額／分組三個必要欄，範本裡有指定值但表頭
  // 找不到，要能明確指出「這個檔缺哪一欄」，不能只是默默把所有列都判成
  // 略過／未對應（使用者看到 0 筆完全不知道問題出在表頭對不起來，還是
  // 這個月真的沒資料）。amount_col 是真正必填（C5：沒有金額欄沒辦法算
  // 彙總）；date_col／group_col 依 C5 本來就可以留空（留空各自有定義好的
  // 行為，不是「缺欄」），只有「範本裡有填值、但表頭真的找不到那個名字」
  // 才算缺欄。
  var REQUIRED_COL_LABELS_ = { date_col: '日期欄', amount_col: '金額欄', group_col: '分組欄' };
  function findMissingColumns(header, template) {
    var missing = [];
    if (!template.amount_col || colIndexOf(header, template.amount_col) === -1) {
      missing.push(REQUIRED_COL_LABELS_.amount_col + '「' + (template.amount_col || '（範本未設定）') + '」');
    }
    ['date_col', 'group_col'].forEach(function (key) {
      if (template[key] && colIndexOf(header, template[key]) === -1) {
        missing.push(REQUIRED_COL_LABELS_[key] + '「' + template[key] + '」');
      }
    });
    return missing;
  }

  // Fable 審查建議 #8：金額欄常見「1,234」「 1200 」這種帶千分位逗號／
  // 前後空白的字串，直接 Number() 會是 NaN（Number("1,234") === NaN），
  // 要先去掉逗號跟空白再轉數字。
  function parseAmountCell(raw) {
    if (typeof raw === 'number') return raw;
    if (typeof raw !== 'string') return NaN;
    var cleaned = raw.replace(/,/g, '').trim();
    if (cleaned === '') return NaN;
    return Number(cleaned);
  }

  // ---- 單一檔案彙總（rows2D：sheet_to_json({header:1}) 的輸出，含表頭列）--

  function aggregateFile(rows2D, template, monthStr) {
    var result = {
      sums: {}, // acc_id -> 加總金額
      unmappedCount: 0,
      unmappedAmount: 0,
      skippedBadAmount: 0,
      skippedBadDate: 0,
      matchedRowCount: 0,
      rowCounts: {}, // acc_id -> 對到的列數（代號直入模式的預覽要顯示）
      skippedRows: [], // 代號直入模式：被略過的列 {row, code, reason}（中 3，預覽列出並擋送出）
      dayStrs: {}, // Set 用物件模擬（IE/舊環境保險，反正只是 key 存在判斷）
      missingColumns: [] // Fable 審查必修 #4
    };
    var headerIdx = (template.header_row || 1) - 1;
    if (!rows2D || rows2D.length <= headerIdx) {
      result.missingColumns = ['整份檔案讀不到表頭列（第 ' + (template.header_row || 1) + ' 列）'];
      return result;
    }
    var header = rows2D[headerIdx];
    var missing = findMissingColumns(header, template);
    if (missing.length > 0) {
      result.missingColumns = missing;
      return result; // 表頭都對不起來，這份檔不彙總任何列，交給呼叫端顯示成錯誤卡片
    }
    var dateIdx = colIndexOf(header, template.date_col);
    var amountIdx = colIndexOf(header, template.amount_col);
    var groupIdx = colIndexOf(header, template.group_col);
    var direct = isAccIdDirect(template);
    function skipRow(r, row, reason) {
      if (!direct) return;
      result.skippedRows.push({ row: r + 1, code: normalizeAccIdCell(groupIdx === -1 ? undefined : row[groupIdx]), reason: reason });
    }

    for (var r = headerIdx + 1; r < rows2D.length; r++) {
      var row = rows2D[r];
      if (!row || row.length === 0) continue;
      if (direct && isBlankRow(row)) continue; // 整列空白（SheetJS 讀出的空列）不算被略過

      var rawAmount = amountIdx === -1 ? undefined : row[amountIdx];
      var amount = parseAmountCell(rawAmount);
      if (typeof amount !== 'number' || !isFinite(amount)) {
        result.skippedBadAmount++;
        skipRow(r, row, '金額格式錯（' + (rawAmount === undefined || rawAmount === null || rawAmount === '' ? '空白' : String(rawAmount)) + '）');
        continue;
      }

      var dayStr = null;
      if (template.date_col) {
        var rawDate = dateIdx === -1 ? undefined : row[dateIdx];
        dayStr = cellToDayStr(rawDate);
        if (!dayStr || monthOfDayStr(dayStr) !== monthStr) {
          result.skippedBadDate++;
          skipRow(r, row, !dayStr
            ? '日期格式錯（' + (rawDate === undefined || rawDate === null || rawDate === '' ? '空白' : String(rawDate)) + '）'
            : '日期不在 ' + monthStr + '（' + dayStr + '）');
          continue;
        }
      }

      var groupValue = groupIdx === -1 ? undefined : row[groupIdx];
      var accId = matchAccId(groupValue, template);
      if (!accId) {
        result.unmappedCount++;
        result.unmappedAmount += amount;
        skipRow(r, row, '科目代號空白');
        continue;
      }

      result.sums[accId] = (result.sums[accId] || 0) + amount;
      result.rowCounts[accId] = (result.rowCounts[accId] || 0) + 1;
      result.matchedRowCount++;
      if (dayStr) result.dayStrs[dayStr] = true;
    }
    return result;
  }

  // ---- 多檔合併 ------------------------------------------------------------

  function aggregateFiles(fileList, template, monthStr) {
    // fileList: [{name, rows2D}]
    var merged = {
      sums: {}, unmappedCount: 0, unmappedAmount: 0,
      skippedBadAmount: 0, skippedBadDate: 0, matchedRowCount: 0,
      rowCounts: {}, dayStrs: {}, fileCount: fileList.length,
      skippedRows: [], // [{file, row, code, reason}]（代號直入模式）
      fileResults: [], // [{name, dayStrs, missingColumns}]——供呼叫端做重複偵測／缺欄錯誤卡片用
      filesWithErrors: [] // [{name, missingColumns}]，missingColumns 非空的檔案
    };
    fileList.forEach(function (f) {
      var one = aggregateFile(f.rows2D, template, monthStr);
      merged.fileResults.push({ name: f.name, dayStrs: one.dayStrs, missingColumns: one.missingColumns });
      if (one.missingColumns && one.missingColumns.length > 0) {
        merged.filesWithErrors.push({ name: f.name, missingColumns: one.missingColumns });
        return; // 表頭都對不起來，這份檔完全不計入彙總（見 aggregateFile 的說明）
      }
      Object.keys(one.sums).forEach(function (accId) {
        merged.sums[accId] = (merged.sums[accId] || 0) + one.sums[accId];
        merged.rowCounts[accId] = (merged.rowCounts[accId] || 0) + (one.rowCounts[accId] || 0);
      });
      merged.unmappedCount += one.unmappedCount;
      merged.unmappedAmount += one.unmappedAmount;
      one.skippedRows.forEach(function (sr) {
        merged.skippedRows.push({ file: f.name, row: sr.row, code: sr.code, reason: sr.reason });
      });
      merged.skippedBadAmount += one.skippedBadAmount;
      merged.skippedBadDate += one.skippedBadDate;
      merged.matchedRowCount += one.matchedRowCount;
      Object.keys(one.dayStrs).forEach(function (d) { merged.dayStrs[d] = true; });
    });
    return merged;
  }

  // ---- 重複偵測（Fable 審查建議 #7；第二輪審查建議 #3 分級）：同檔名重複
  // 選取、或同一天被兩個以上檔案涵蓋，都當成「有問題、要警告」，但嚴重
  // 程度不同——回傳每個檔案的判定結果，呼叫端用 nameConflict 決定 checkbox
  // 的預設勾選狀態：
  //   · nameConflict（同檔名重複選取，幾乎一定是使用者手滑多選了同一個
  //     檔案）：預設排除（checkbox 預設不勾）。
  //   · dayOverlap（只是日期跟別的檔案重疊，檔名不同）：預設仍然計入
  //     彙總（checkbox 預設勾），只顯示警告文字讓使用者自己判斷要不要
  //     排除——這種情況也可能是「這個月故意用兩個範本涵蓋同一天的不同
  //     資料來源」，不該預設幫使用者丟資料。
  // 判定順序照使用者選取的順序（fileList 的順序）：同檔名時，只有第一個
  // 出現的視為正常，後面同名的都判重複；同一天的覆蓋範圍也是先出現的正常，
  // 之後任何檔案只要涵蓋到「已經被別的檔案涵蓋過的那一天」就算重疊（即使
  // 它也涵蓋其他還沒出現過的天，還是整份標記，讓使用者自己看是否要排除
  // ——這是資料完整性優先於便利性的取捨）。 ----------------------------
  function detectDuplicateFiles(fileResults) {
    var seenNames = {};
    var seenDays = {};
    return fileResults.map(function (f) {
      var nameConflict = Object.prototype.hasOwnProperty.call(seenNames, f.name);
      if (!nameConflict) seenNames[f.name] = true;

      var overlapDays = Object.keys(f.dayStrs || {}).filter(function (d) { return seenDays[d]; });
      var dayOverlap = overlapDays.length > 0;
      Object.keys(f.dayStrs || {}).forEach(function (d) { seenDays[d] = true; });

      var reasons = [];
      if (nameConflict) reasons.push('檔名重複（跟「' + f.name + '」已選過的另一個檔案同名）');
      if (dayOverlap) reasons.push('日期跟別的檔案重疊（' + overlapDays.sort().join('、') + '）');

      return {
        name: f.name,
        duplicate: reasons.length > 0, // 保留舊欄位：只要有任一種情況都算「有問題、要顯示警告」
        nameConflict: nameConflict,
        dayOverlap: dayOverlap,
        reasons: reasons
      };
    });
  }

  // ---- note：「N 檔 M 列 YYYY-MM-DD~YYYY-MM-DD」（先定義，buildEntries 會用）--

  function dateRangeOf(dayStrs) {
    var keys = Object.keys(dayStrs).sort();
    if (keys.length === 0) return null;
    return { from: keys[0], to: keys[keys.length - 1], count: keys.length };
  }

  function buildNote(agg) {
    var range = dateRangeOf(agg.dayStrs);
    var rangeText = range ? (range.from + '~' + range.to) : '無日期資料';
    return agg.fileCount + ' 檔 ' + agg.matchedRowCount + ' 列 ' + rangeText;
  }

  // ---- 產生 importEntries 要送的 entries（mapping 出現過的每個 acc_id 都要
  // 有一筆，即使這個月沒有任何列對到它，金額寫 0）。Fable 審查必修 #1：
  // 每筆都要帶 note＝buildNote(agg)（「N 檔 M 列 YYYY-MM-DD~YYYY-MM-DD」），
  // 原本漏了，寫進明細的匯入批次完全看不出這筆是哪次匯入、涵蓋哪些天，
  // 之後要追查資料來源或重匯時沒有線索。----------------------------------

  // 去掉浮點加總雜訊（0.1+0.2＝0.30000000000000004），只取到小數 6 位，
  // 不影響一般金額（C4：engine 不四捨五入，這裡只是把加法誤差抹掉）。
  function cleanSum(x) { return Math.round(x * 1e6) / 1e6; }

  function buildEntries(agg, template) {
    var note = buildNote(agg);
    if (isAccIdDirect(template)) {
      // 代號直入：只寫檔案裡真的出現過的代號（含金額 0 的列，0 也要寫成
      // 明細，科目才會離開 pending）；沒有「mapping 每個 acc_id 都補 0」
      // 這條（mapping 只有保留鍵）。無效代號由 validateDirectCodes 在預覽
      // 擋下送出，這裡不過濾，免得「默默略過」。
      return Object.keys(agg.sums).sort().map(function (accId) {
        return { acc_id: accId, amount: cleanSum(agg.sums[accId]), note: note };
      });
    }
    var accIds = {};
    Object.keys(template.mapping || {}).forEach(function (k) { accIds[template.mapping[k]] = true; });
    return Object.keys(accIds).sort().map(function (accId) {
      return { acc_id: accId, amount: agg.sums[accId] || 0, note: note };
    });
  }

  // ---- 店別欄檢查（Fable 審查建議 #7）：如果表頭裡剛好有一欄叫「店別」
  // （光復 POS 檔實測就有這欄，值像「小辛辣-新竹光復店」），檢查它跟目前
  // 選定的門市名稱是否對得上——用「互相包含子字串」比對（不要求完全相
  // 等，因為 POS 的店別字串通常會多品牌／「店」字這種綴詞），第一列有值
  // 的資料列對不上就整份標記，不逐列比對（同一個檔案理論上只會有一個
  // 店別，逐列比對只是浪費、真的混雜多店資料是更嚴重的問題，這裡先抓
  // 最常見的「選錯檔」情境）。表頭沒有「店別」欄就不檢查（不是每個範本
  // 都有這欄，C5 沒有規定這是必要欄）。----------------------------------
  var STORE_COLUMN_NAME_ = '店別';
  function findStoreMismatch(rows2D, template, expectedStoreName) {
    if (!expectedStoreName) return null;
    var headerIdx = (template.header_row || 1) - 1;
    if (!rows2D || rows2D.length <= headerIdx) return null;
    var header = rows2D[headerIdx];
    var storeIdx = colIndexOf(header, STORE_COLUMN_NAME_);
    if (storeIdx === -1) return null;
    for (var r = headerIdx + 1; r < rows2D.length; r++) {
      var row = rows2D[r];
      if (!row) continue;
      var cell = row[storeIdx];
      if (cell === undefined || cell === null || String(cell).trim() === '') continue;
      var cellStr = String(cell).trim();
      var match = cellStr.indexOf(expectedStoreName) !== -1 || expectedStoreName.indexOf(cellStr) !== -1;
      return match ? null : cellStr; // 回傳實際讀到的店別字串（null＝沒問題）
    }
    return null; // 整份檔案店別欄都是空的，不擋
  }

  // ---- 位元組簽章判斷「內容本來就是文字」（Fable 對 PR #30 第二輪審查
  // 必修 #1：讀檔要不要走文字解碼路徑，只能靠跟範本設定無關的判準，不能
  // 靠「表頭跟範本對不對得起來」——後者對「檔案正常、範本設定錯」的情境
  // 會誤觸發昂貴的文字解碼，見 gas/import.html 的 readWorkbook 大註解）。
  // zip（PK）跟 OLE 複合文件（D0CF11E0，老式 .xls 的真正二進位格式）開頭
  // 簽章都很固定；不是這兩種簽章、或即使簽章對了但內容前幾 KB 找得到
  // <table/<html，才算「看起來是文字」。
  function looksLikeTextContent(buf) {
    var bytes = new Uint8Array(buf);
    var isZip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4B; // PK
    var isOle = bytes.length >= 4 && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0;
    if (!isZip && !isOle) return true;
    var n = Math.min(bytes.length, 4096);
    var head = '';
    for (var i = 0; i < n; i++) head += String.fromCharCode(bytes[i]);
    return /<table|<html/i.test(head);
  }

  // ---- 代號直入模式：檢查每個代號是否能匯入（跟 apiImportEntries_ 同一組
  // 規則：存在、啟用、取值方式屬於 匯入/手動/連接器）；分組欄空白的列也
  // 列進來。回傳非空＝預覽列成「無法對應」並擋下送出。--------------------
  function validateDirectCodes(agg, accounts) {
    var byId = {};
    (accounts || []).forEach(function (a) { byId[a.acc_id] = a; });
    var invalid = [];
    Object.keys(agg.sums || {}).sort().forEach(function (code) {
      var a = byId[code];
      var reason = null;
      if (!a) reason = '科目代號不存在';
      else if (a.active !== true) reason = '科目未啟用';
      else if (!IMPORT_ALLOWED_MODES_[a.mode]) reason = '取值方式是「' + a.mode + '」，只能匯入到 匯入／手動／連接器 科目';
      if (reason) {
        invalid.push({ code: code, name: a ? a.name : '', reason: reason, rows: (agg.rowCounts || {})[code] || 0, amount: agg.sums[code] });
      }
    });
    return invalid; // 代號空白的列在 agg.skippedRows（中 3）
  }

  // 嚴重 1：本店本月、同科目「非本範本來源」的有效明細（existingEntries＝
  // getMonth 回的 entries），依科目彙總。預覽列成黃卡＋「連帶作廢」勾選框。
  function findOtherSources(existingEntries, entries, tplId) {
    var want = {};
    (entries || []).forEach(function (en) { want[en.acc_id] = true; });
    var sourceTag = '匯入:' + tplId;
    var byAcc = {};
    var order = [];
    (existingEntries || []).forEach(function (e) {
      if (!e || e.void === true || !want[e.acc_id] || e.source === sourceTag) return;
      if (!byAcc[e.acc_id]) { byAcc[e.acc_id] = { acc_id: e.acc_id, amount: 0, count: 0, sources: [] }; order.push(e.acc_id); }
      var b = byAcc[e.acc_id];
      var amt = typeof e.amount === 'number' && isFinite(e.amount) ? e.amount : Number(e.amount);
      if (isFinite(amt)) b.amount += amt;
      b.count++;
      if (b.sources.indexOf(e.source) === -1) b.sources.push(e.source);
    });
    return order.sort().map(function (k) { byAcc[k].amount = cleanSum(byAcc[k].amount); return byAcc[k]; });
  }

  // 金額顯示：整數照舊不帶小數；有小數時固定兩位（C4 第 9 條：顯示層取小數 2 位）。
  function formatAmount(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    var neg = n < 0;
    var abs = Math.round(Math.abs(n) * 100) / 100;
    var isInt = abs === Math.floor(abs);
    var parts = (isInt ? String(abs) : abs.toFixed(2)).split('.');
    var intStr = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var out = intStr + (parts[1] ? '.' + parts[1] : '');
    return (neg && abs !== 0 ? '−' : '') + out;
  }

  root.ImportLogic = {
    ACC_ID_DIRECT_KEY: ACC_ID_DIRECT_KEY,
    isAccIdDirect: isAccIdDirect,
    validateDirectCodes: validateDirectCodes,
    findOtherSources: findOtherSources,
    normalizeAccIdCell: normalizeAccIdCell,
    formatAmount: formatAmount,
    looksLikeTextContent: looksLikeTextContent,
    excelSerialToDate: excelSerialToDate,
    cellToDayStr: cellToDayStr,
    monthOfDayStr: monthOfDayStr,
    daysInMonth: daysInMonth,
    matchAccId: matchAccId,
    colIndexOf: colIndexOf,
    findMissingColumns: findMissingColumns,
    parseAmountCell: parseAmountCell,
    aggregateFile: aggregateFile,
    aggregateFiles: aggregateFiles,
    detectDuplicateFiles: detectDuplicateFiles,
    findStoreMismatch: findStoreMismatch,
    buildEntries: buildEntries,
    dateRangeOf: dateRangeOf,
    buildNote: buildNote
  };
})(root);

export const ImportLogic = root.ImportLogic;
export const {
  ACC_ID_DIRECT_KEY, isAccIdDirect, validateDirectCodes, findOtherSources, normalizeAccIdCell, formatAmount,
  looksLikeTextContent, excelSerialToDate, cellToDayStr, monthOfDayStr, daysInMonth, matchAccId, colIndexOf,
  findMissingColumns, parseAmountCell, aggregateFile, aggregateFiles, detectDuplicateFiles, findStoreMismatch,
  buildEntries, dateRangeOf, buildNote
} = ImportLogic;

/** 整數千分位（照 gas/import.html fmtInt） */
export function fmtInt(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const r = Math.round(n);
  const neg = r < 0;
  const s = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '−' : '') + s;
}

/** workbook 第一張表 → 2D 陣列（照 gas/import.html sheetToRows2D） */
export function sheetToRows2D(XLSX, wb) {
  if (!wb || !wb.SheetNames || wb.SheetNames.length === 0) return [];
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
}

function headerLooksRight(XLSX, wb, template) {
  if (!template || !template.amount_col) return !!(wb && wb.SheetNames && wb.SheetNames.length > 0);
  const rows = sheetToRows2D(XLSX, wb);
  const headerIdx = (template.header_row || 1) - 1;
  if (rows.length <= headerIdx) return false;
  return colIndexOf(rows[headerIdx], template.amount_col) !== -1;
}

/**
 * 依內容（不是副檔名）讀檔：POS 的 .xls 實際是 xlsx；薪資匯出的 .xls 其實是 HTML 表格（常為 Big5）。
 * 照 gas/import.html readWorkbook：array 讀成功且內容不是文字 → 直接回；否則 utf-8／big5 兩種文字解碼挑表頭對得起來的。
 * buf＝ArrayBuffer；回 workbook（讀不出來回空 workbook）。
 */
export function readWorkbookBuf(XLSX, buf, template) {
  let wbArray = null;
  let arrayThrew = false;
  try { wbArray = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true }); } catch (e) { arrayThrew = true; wbArray = null; }
  const arraySucceeded = !arrayThrew && !!(wbArray && wbArray.SheetNames && wbArray.SheetNames.length > 0);
  const shouldTryText = !arraySucceeded || looksLikeTextContent(buf);
  if (!shouldTryText) return wbArray;

  function tryDecode(encoding) {
    let text;
    try { text = new TextDecoder(encoding).decode(buf); } catch (e) { return null; }
    try { return XLSX.read(text, { type: 'string', cellDates: true }); } catch (e) { return null; }
  }
  let utf8Text = null;
  try { utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(buf); } catch (e) { /* ignore */ }
  const declaredBig5 = !!(utf8Text && /charset\s*=\s*["']?(big5|950|x-x-big5)/i.test(utf8Text));
  const wbUtf8 = declaredBig5 ? null : tryDecode('utf-8');
  if (headerLooksRight(XLSX, wbUtf8, template)) return wbUtf8;
  const wbBig5 = tryDecode('big5');
  if (headerLooksRight(XLSX, wbBig5, template)) return wbBig5;
  return wbUtf8 || wbBig5 || wbArray || { SheetNames: [], Sheets: {} };
}
