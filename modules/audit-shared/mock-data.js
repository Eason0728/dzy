// 種子資料：五店品項庫＋1–7 月歷史 records/details（真 sheet 摘錄，reason 一律「未分類」）
// 同時支援瀏覽器（掛 window.MockData）與 node（module.exports）

(function (root) {
  'use strict';

  // 通行碼（僅 mock 用；內部常數，不出現在 Api.getAll 回傳的 config 內）
  var PASSCODES = {
    accountant: '1234', // 會計
    viewer: '5678'      // 主管
  };

  var CONFIG = {
    reasons: ['盤點錯誤（門市盤錯）', '損耗未記', '單位混淆', '進出貨未入帳', '其他'],
    change_fund_std: 10000,
    petty_cash_std: 10000,
    stores: [
      { code: 'sxl-gf', name: '小辛辣光復', order: 1 },
      { code: 'ck', name: '央廚', order: 2 },
      { code: 'mzt-gf', name: '墨竹亭光復', order: 3 },
      { code: 'mzt-js', name: '墨竹亭金山', order: 4 },
      { code: 'mzt-lzl', name: '墨竹亭六張犁', order: 5 }
    ],
    accountant_ok: true
  };

  // ---- 品項庫：{store, name, unit, active} ----
  function buildItems(store, pairs) {
    return pairs.map(function (p) {
      return { store: store, name: p[0], unit: p[1], active: true };
    });
  }

  var SXL_GF_PAIRS = [
    ['牛肉片', '公斤'], ['鴨血', '盒'], ['煙燻豬頭皮', '包'], ['感熱貼紙', '捲'],
    ['雞豚高湯', '包'], ['902碗', '條'], ['滷牛肚', '包'], ['米血', '包'],
    ['香菜', 'kg'], ['水蓮', '包'], ['外袋602碗', '條'], ['肉燥', '包'],
    ['豬血糕', '包'], ['王子麵', '包'], ['冬粉', '把'], ['大陸妹', '斤'],
    ['高麗菜', '顆'], ['玉米筍', '包'], ['金針菇', '包'], ['豬肉片', '公斤'],
    ['雞胸肉', '公斤'], ['蝦餃', '包'], ['燕餃', '包'], ['貢丸', '包'],
    ['豆皮', '包'], ['老油條', '包'], ['凍豆腐', '包'], ['娃娃菜', '顆'],
    ['杏鮑菇', '包'], ['麻辣湯底', '包'], ['花椒粒', '包'], ['辣椒粉', '包'],
    ['打包盒', '個'], ['塑膠袋', '包'], ['餐巾紙', '包'], ['免洗筷', '包'],
    ['收據紙捲', '捲'],
    // 單位刻意留空：真實品項庫有 58 項當初從庫存 PDF 解析時沒印單位。
    // 2026-08-07 實查到後果——sxl-gf 八月異常說明印成「盤點2.8，覆盤2」少了單位。
    // 假資料保留這種項目，缺單位的驗證才測得到。
    ['台灣白芝麻粒（1斤/包）', '']
  ];

  var CK_PAIRS = [
    ['麻辣湯底', '桶'], ['白湯湯底', '桶'], ['花椒油', '瓶'], ['辣椒油', '瓶'],
    ['沙茶醬', '罐'], ['蒜蓉醬', '罐'], ['打拋醬', '包'], ['蟹黃醬', '包'],
    ['柚子醬', '罐'], ['肉燥', '包'], ['滷牛肚', '包'], ['牛肉片', '公斤'],
    ['豬肉片', '公斤'], ['雞胸肉', '公斤'], ['鴨血', '盒'], ['米血', '包'],
    ['豆皮', '包'], ['貢丸', '包'], ['燕餃', '包'], ['蝦餃', '包'],
    ['凍豆腐', '包'], ['豬頭皮', '包'], ['芽菜', '包'], ['高麗菜', '顆'],
    ['大陸妹', '斤'], ['蔥', '斤'], ['蒜仁', '斤'], ['香菜', 'kg'],
    ['打包盒', '個'], ['塑膠袋', '包'], ['感熱貼紙', '捲'], ['LOGO袋3斤', '包'],
    ['免洗筷', '包'], ['餐巾紙', '包']
  ];

  var MZT_JS_PAIRS = [
    ['打拋醬', '包'], ['LOGO袋3斤', '包'], ['貢丸', '包'], ['蟹黃醬', '包'],
    ['蔥', '斤'], ['鴨血', '盒'], ['米血', '包'], ['豆皮', '包'],
    ['燕餃', '包'], ['蝦餃', '包'], ['凍豆腐', '包'], ['豬頭皮', '包'],
    ['芽菜', '包'], ['高麗菜', '顆'], ['大陸妹', '斤'], ['中蒜仁', '斤'],
    ['香菜', 'kg'], ['水蓮', '包'], ['娃娃菜', '顆'], ['杏鮑菇', '包'],
    ['金針菇', '包'], ['玉米筍', '包'], ['牛肉片', '公斤'], ['豬肉片', '公斤'],
    ['雞胸肉', '公斤'], ['滷牛肚', '包'], ['肉燥', '包'], ['麻辣湯底', '包'],
    ['沙茶醬', '罐'], ['柚子醬', '罐'], ['打包盒', '個'], ['塑膠袋', '包'],
    ['感熱貼紙', '捲'], ['免洗筷', '包'], ['餐巾紙', '包']
  ];

  var MZT_GF_PAIRS = [
    ['豬頭皮', '包'], ['芽菜', '包'], ['花雕雞肉', '包'], ['大陸妹', '斤'],
    ['柚子醬', '罐'], ['鴨血', '盒'], ['米血', '包'], ['豆皮', '包'],
    ['燕餃', '包'], ['蝦餃', '包'], ['貢丸', '包'], ['凍豆腐', '包'],
    ['高麗菜', '顆'], ['蔥', '斤'], ['中蒜仁', '斤'], ['香菜', 'kg'],
    ['水蓮', '包'], ['娃娃菜', '顆'], ['杏鮑菇', '包'], ['金針菇', '包'],
    ['玉米筍', '包'], ['牛肉片', '公斤'], ['豬肉片', '公斤'], ['雞胸肉', '公斤'],
    ['滷牛肚', '包'], ['肉燥', '包'], ['打拋醬', '包'], ['蟹黃醬', '包'],
    ['麻辣湯底', '包'], ['沙茶醬', '罐'], ['打包盒', '個'], ['塑膠袋', '包'],
    ['感熱貼紙', '捲'], ['免洗筷', '包'], ['餐巾紙', '包']
  ];

  var MZT_LZL_PAIRS = [
    ['打拋醬', '包'], ['中蒜仁', '斤'], ['米血', '條'], ['鴨血', '盒'],
    ['雞肉絲', '包'], ['豆皮', '包'], ['燕餃', '包'], ['蝦餃', '包'],
    ['貢丸', '包'], ['凍豆腐', '包'], ['豬頭皮', '包'], ['芽菜', '包'],
    ['高麗菜', '顆'], ['大陸妹', '斤'], ['蔥', '斤'], ['香菜', 'kg'],
    ['水蓮', '包'], ['娃娃菜', '顆'], ['杏鮑菇', '包'], ['金針菇', '包'],
    ['玉米筍', '包'], ['牛肉片', '公斤'], ['豬肉片', '公斤'], ['雞胸肉', '公斤'],
    ['滷牛肚', '包'], ['肉燥', '包'], ['蟹黃醬', '包'], ['柚子醬', '罐'],
    ['麻辣湯底', '包'], ['沙茶醬', '罐'], ['打包盒', '個'], ['塑膠袋', '包'],
    ['感熱貼紙', '捲'], ['免洗筷', '包'], ['餐巾紙', '包']
  ];

  var ITEMS = [].concat(
    buildItems('sxl-gf', SXL_GF_PAIRS),
    buildItems('ck', CK_PAIRS),
    buildItems('mzt-gf', MZT_GF_PAIRS),
    buildItems('mzt-js', MZT_JS_PAIRS),
    buildItems('mzt-lzl', MZT_LZL_PAIRS)
  );

  // ---- 1–7 月歷史紀錄：records ＋ 異常 details ----

  // anomaly 清單：{item, unit, book, recount}
  function anomalyText(list) {
    return list.map(function (d, i) {
      return (i + 1) + '.' + d.item + ':盤點' + d.book + d.unit +
        '，覆盤' + d.recount + d.unit;
    }).join('\n');
  }

  function toDetails(store, month, list) {
    var key = store + '_' + month;
    return list.map(function (d) {
      return {
        record_key: key,
        store: store,
        month: month,
        item: d.item,
        unit: d.unit,
        book_qty: d.book,
        recount_qty: d.recount,
        verdict: '異常',
        reason: '未分類',
        note: ''
      };
    });
  }

  function auditedRecord(store, month, correct, total, changeFund, pettyCash, tip, tipMatch, anomalies) {
    return {
      record_key: store + '_' + month,
      store: store,
      month: month,
      status: '已稽核',
      audit_date: month + '-05',
      sample_count: total,
      correct_count: correct,
      correct_rate: Math.round((correct / total) * 100),
      change_fund: changeFund,
      petty_cash: pettyCash,
      tip_amount: tip,
      tip_match: tipMatch,
      anomaly_text: anomalyText(anomalies),
      note: '',
      submitted_at: month + '-05T10:00:00+08:00'
    };
  }

  function restRecord(store, month) {
    return {
      record_key: store + '_' + month,
      store: store,
      month: month,
      status: '輪休',
      audit_date: month + '-05',
      sample_count: '',
      correct_count: '',
      correct_rate: '',
      change_fund: '',
      petty_cash: '',
      tip_amount: '',
      tip_match: '',
      anomaly_text: '',
      note: '',
      submitted_at: month + '-05T10:00:00+08:00'
    };
  }

  var RECORDS = [];
  var DETAILS = [];

  function addAudited(store, month, correct, total, changeFund, pettyCash, tip, tipMatch, anomalies) {
    RECORDS.push(auditedRecord(store, month, correct, total, changeFund, pettyCash, tip, tipMatch, anomalies));
    DETAILS = DETAILS.concat(toDetails(store, month, anomalies));
  }

  function addRest(store, month) {
    RECORDS.push(restRecord(store, month));
  }

  // ---- sxl-gf 小辛辣光復（金庫 1–7 月零找金/零用金/小費比對皆正確/相符）----
  addAudited('sxl-gf', '2026-01', 16, 20, '正確', '正確', 457, '相符', [
    { item: '牛肉片', unit: '公斤', book: 26.5, recount: 29.4 },
    { item: '鴨血', unit: '盒', book: 27, recount: 32 },
    { item: '煙燻豬頭皮', unit: '包', book: 5.75, recount: 6.5 },
    { item: '感熱貼紙', unit: '捲', book: 5, recount: 15 }
  ]);
  addAudited('sxl-gf', '2026-02', 18, 20, '正確', '正確', 542, '相符', [
    { item: '雞豚高湯', unit: '包', book: 1.5, recount: 0.76 },
    { item: '902碗', unit: '條', book: 44.8, recount: 43.8 }
  ]);
  addAudited('sxl-gf', '2026-03', 20, 20, '正確', '正確', 542, '相符', []);
  addAudited('sxl-gf', '2026-04', 19, 20, '正確', '正確', 642, '相符', [
    { item: '滷牛肚', unit: '包', book: 8.1, recount: 9 }
  ]);
  addAudited('sxl-gf', '2026-05', 17, 20, '正確', '正確', 742, '相符', [
    { item: '米血', unit: '包', book: 9, recount: 8 },
    { item: '香菜', unit: 'kg', book: 1, recount: 0.7 },
    { item: '水蓮', unit: '包', book: 6.07, recount: 5.7 }
  ]);
  addAudited('sxl-gf', '2026-06', 19, 20, '正確', '正確', 792, '相符', [
    { item: '外袋602碗', unit: '條', book: 20, recount: 19 }
  ]);
  addAudited('sxl-gf', '2026-07', 19, 20, '正確', '正確', 1792, '相符', [
    { item: '肉燥', unit: '包', book: 10, recount: 9 }
  ]);

  // ---- ck 央廚（1–3 月已稽核 20/20；4–7 月輪休；歷史金庫欄未記錄）----
  addAudited('ck', '2026-01', 20, 20, '', '', '', '', []);
  addAudited('ck', '2026-02', 20, 20, '', '', '', '', []);
  addAudited('ck', '2026-03', 20, 20, '', '', '', '', []);
  addRest('ck', '2026-04');
  addRest('ck', '2026-05');
  addRest('ck', '2026-06');
  addRest('ck', '2026-07');

  // ---- mzt-js 金山店（歷史金庫欄未記錄）----
  addRest('mzt-js', '2026-01');
  addAudited('mzt-js', '2026-02', 18, 20, '', '', '', '', [
    { item: '打拋醬', unit: '包', book: 6.1, recount: 7.2 },
    { item: 'LOGO袋3斤', unit: '包', book: 2.8, recount: 2.3 }
  ]);
  addRest('mzt-js', '2026-03');
  addRest('mzt-js', '2026-04');
  addRest('mzt-js', '2026-05');
  addRest('mzt-js', '2026-06');
  addAudited('mzt-js', '2026-07', 17, 20, '', '', '', '', [
    { item: '貢丸', unit: '包', book: 16.8, recount: 17.8 },
    { item: '蟹黃醬', unit: '包', book: 19.4, recount: 24.5 },
    { item: '蔥', unit: '斤', book: 5, recount: 6 }
  ]);

  // ---- mzt-gf 光復店（歷史金庫欄未記錄）----
  addAudited('mzt-gf', '2026-01', 20, 20, '', '', '', '', []);
  addRest('mzt-gf', '2026-02');
  addAudited('mzt-gf', '2026-03', 16, 20, '', '', '', '', [
    { item: '豬頭皮', unit: '包', book: 4.4, recount: 2.4 },
    { item: '芽菜', unit: '包', book: 6, recount: 5 },
    { item: '花雕雞肉', unit: '包', book: 14, recount: 15 },
    { item: '大陸妹', unit: '斤', book: 2.5, recount: 25 }
  ]);
  addRest('mzt-gf', '2026-04');
  addAudited('mzt-gf', '2026-05', 19, 20, '', '', '', '', [
    { item: '柚子醬', unit: '罐', book: 5, recount: 4 }
  ]);
  addRest('mzt-gf', '2026-06');
  addRest('mzt-gf', '2026-07');

  // ---- mzt-lzl 六張犁店（歷史金庫欄未記錄；7 月未記錄＝不建 record）----
  addRest('mzt-lzl', '2026-01');
  addAudited('mzt-lzl', '2026-02', 18, 20, '', '', '', '', [
    { item: '打拋醬', unit: '包', book: 7, recount: 8 },
    { item: '中蒜仁', unit: '斤', book: 3.5, recount: 4.5 }
  ]);
  addRest('mzt-lzl', '2026-03');
  addRest('mzt-lzl', '2026-04');
  addRest('mzt-lzl', '2026-05');
  addAudited('mzt-lzl', '2026-06', 17, 20, '', '', '', '', [
    { item: '米血', unit: '條', book: 21, recount: 23 },
    { item: '鴨血', unit: '盒', book: 35, recount: 34 },
    { item: '雞肉絲', unit: '包', book: 6, recount: 7 }
  ]);
  // 2026-07：未記錄，不建 record

  var MockData = {
    passcodes: PASSCODES,
    config: CONFIG,
    items: ITEMS,
    records: RECORDS,
    details: DETAILS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MockData;
  } else {
    root.MockData = MockData;
  }
})(typeof window !== 'undefined' ? window : this);
