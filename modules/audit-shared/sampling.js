// 抽樣純函式：drawSample / redrawOne（spec.md §3 畫面3、task.md 共用介面契約）
// 同時支援瀏覽器（掛 window.Sampling）與 node（module.exports）
//
// 純隨機、不排除抽過的品項——記憶只參考、系統不干涉（Eason 明確要求，見 requirements §4.1）。
//
// drawSample(storeItems, storeDetails, n)
//   storeItems   = 該店品項庫（呼叫端已篩選僅 active 的項目；本檔仍會保守過濾 active!==false）
//   storeDetails = 該店歷史抽查明細列陣列（{item, month, ...}，跨年份全量）
//   n            = 欲抽數量；不足 n（品項庫 <= n）→ 全給
//   回傳         = [{name, unit, lastDrawn}]，lastDrawn = 該品項在 storeDetails 出現過的最近月份
//                  ('YYYY-MM'，字典序即可比較大小)，沒抽過 = null；同一次抽出不重複。
//
// redrawOne(currentNames, storeItems, storeDetails)
//   currentNames = 目前清單中的品項名稱陣列（換掉的那項也算在內，避免換成自己）
//   回傳一個不在 currentNames 裡的 {name, unit, lastDrawn}；沒得換回 null。
//
// lastDrawnOf(name, storeDetails)
//   單獨查某品項的歷史標記，給「手動加入品項」用（自訂品項不在品項庫、抽不出來）。

(function (root) {
  'use strict';

  // 找品項名稱在 storeDetails 裡最近一次出現的月份；沒出現過回 null
  function findLastDrawn(name, storeDetails) {
    var last = null;
    (storeDetails || []).forEach(function (d) {
      if (d && d.item === name && d.month) {
        if (last === null || d.month > last) {
          last = d.month;
        }
      }
    });
    return last;
  }

  // Fisher-Yates 洗牌，回傳新陣列（不改動原陣列）
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  function activeOnly(storeItems) {
    return (storeItems || []).filter(function (it) {
      return it && it.active !== false;
    });
  }

  function toSampleItem(item, storeDetails) {
    return {
      name: item.name,
      unit: item.unit,
      lastDrawn: findLastDrawn(item.name, storeDetails)
    };
  }

  function drawSample(storeItems, storeDetails, n) {
    var pool = activeOnly(storeItems);
    var count = Math.max(0, n || 0);
    var picked = shuffle(pool).slice(0, count);
    return picked.map(function (it) {
      return toSampleItem(it, storeDetails);
    });
  }

  function redrawOne(currentNames, storeItems, storeDetails) {
    var used = {};
    (currentNames || []).forEach(function (name) {
      used[name] = true;
    });
    var pool = activeOnly(storeItems).filter(function (it) {
      return !used[it.name];
    });
    if (pool.length === 0) return null;
    var idx = Math.floor(Math.random() * pool.length);
    return toSampleItem(pool[idx], storeDetails);
  }

  var Sampling = {
    drawSample: drawSample,
    redrawOne: redrawOne,
    // 手動加入品項時要單獨查歷史標記——加入的品項可能不在品項庫（自訂品項），
    // 沒有候選池可抽，只能直接查明細。
    lastDrawnOf: findLastDrawn
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Sampling;
  } else {
    root.Sampling = Sampling;
  }
})(typeof window !== 'undefined' ? window : this);
