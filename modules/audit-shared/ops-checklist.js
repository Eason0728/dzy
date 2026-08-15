// 營運稽核表檢查項目（來源：2026 營運稽核表，Eason 2026-08-11 指定參照
// https://clever-gelato-bff2d9.netlify.app/ 的「營運管理」＋「品牌形象」兩大類）
//
// ⚠ 項目 id 是「大類序×群組序×項目序」算出來的（c0g0i0），**位置就是身分**。
// 在中間插入或刪除項目會讓其後所有項目的 id 位移，歷史明細對不回原本的項目。
// 要加項目一律**加在該群組最後面**；真的要刪就把它留著改文字，或另開 SCHEMA_VERSION。
// 明細列同時存了大類／群組／項目全文，所以就算 id 位移，試算表本身仍看得懂。
//
// 同時支援瀏覽器（掛 window.OpsChecklist）與 node（module.exports）

(function (root) {
  'use strict';

  var SCHEMA_VERSION = '2026-08';

  var CATEGORIES = [
    {
      cat: '營運管理',
      groups: [
        {
          name: '消防安全',
          items: [
            '一家店至少兩支滅火器',
            '廚區〈爐火旁〉一支、客席區一支是否設置滅火器',
            '滅火器壓力、有效期限是否正常',
            '有後門之門市，出入是否暢通',
            '瓦斯桶是否固定（不傾斜）',
            '瓦斯桶是否張貼警語',
            '新進同仁是否進行新進同仁教育訓練、一般安全教育訓練，簽名留檔'
          ]
        },
        {
          name: '營運',
          items: [
            '營運表單填寫是否正確〈日報表〉',
            '文宣露出是否依規範執行'
          ]
        }
      ]
    },
    {
      cat: '品牌形象',
      groups: [
        {
          name: '環境清潔',
          items: [
            '是否保持各項對外文宣張貼應乾淨無髒污',
            '無張貼自製文宣品',
            '保持餐廳外圍環境清潔〈招牌、LOGO、DM 架〉，清潔包含天、地、壁',
            '保持餐廳內「客席區」環境清潔，包含天、地、壁',
            '保持餐廳內「化妝室」環境清潔，包含天、地、壁',
            '保持餐廳內「廚區」環境清潔，包含天、地、壁'
          ]
        },
        {
          name: '食安',
          items: [
            '任一商品保存是否在有效日期內（架上或庫存）※退貨商品已明確標示且區隔者不受此限',
            '洗滌區清潔用品標示是否明確，放置區域依規範執行',
            '洗手區域是否設置酒精瓶、酒精、擦手紙、洗手步驟',
            '濾心日期是否定期更換'
          ]
        }
      ]
    }
  ];

  // 攤平成 [{id, cat, group, text, order}]，順序＝畫面順序＝明細列順序
  var FLAT = [];
  CATEGORIES.forEach(function (c, ci) {
    c.groups.forEach(function (g, gi) {
      g.items.forEach(function (text, ii) {
        FLAT.push({
          id: 'c' + ci + 'g' + gi + 'i' + ii,
          cat: c.cat,
          group: g.name,
          text: text,
          order: FLAT.length + 1
        });
      });
    });
  });

  var BY_ID = {};
  FLAT.forEach(function (it) { BY_ID[it.id] = it; });

  var OpsChecklist = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    categories: CATEGORIES,
    flat: FLAT,
    byId: function (id) { return BY_ID[id] || null; },
    total: FLAT.length
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OpsChecklist;
  } else {
    root.OpsChecklist = OpsChecklist;
  }
})(typeof window !== 'undefined' ? window : this);
