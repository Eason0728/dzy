/**
 * modules/inspection/questions.js — 營運巡檢題庫（各品牌一份）
 *
 * 小辛辣（mala）：一字不差取自舊站 mala-inspection js/questions.js（原檔「MDSSL - 營運巡檢表.xlsx」；
 *   經營評鑑財務權重 0.35→0.4，Eason 2026-07-14 定案 D1）。
 * 墨竹亭（mzt）、一悟（yiwu）：Eason 2026-10-27「墨竹亭的題目先空白並開放可以自行新增題目」→ 預設空白。
 * 這裡只是「沒存過時的預設」；營運部／品牌總監在「題目設定」存檔後，一律用後端 insp_bank 的版本。
 * 每筆巡檢送出時連題目一起存（records.forms），題目改了舊報告不變。
 * 沒有評分題的表＝「未評」，不進營運總分的平均（scoring.js 只平均評過的表）。
 *
 * 題目 type：score 0–5／critical 重大缺失（正常 5、發生 0）／binary 只有 0 或 5／bonus 加分打勾／
 *   bonus_free 自由填寫加分（每項 +points，最多 max 項）／penalty 加重扣分（勾選扣 points）
 */
'use strict';

export const MALA_FORMS = [
  /* ───────── 服務 ───────── */
  {
    id: 'service', name: '服務', inOperational: true,
    heading: '門市服務評分項目',
    categories: [
      { id: 'attitude', name: '態度精神', weight: 0.2, role: 'scored', items: [
        { n: 1, type: 'score', text: '服務態度親切、熱情、有目光接觸、保持笑容' },
        { n: 2, type: 'score', text: '顧客入/離店招呼問候落實，且精神、面帶微笑' },
        { n: 3, type: 'score', text: '電話響鈴5聲內要接起，落實招呼語，口語熱情' },
        { n: 4, type: 'score', text: '遇見顧客進門或經過，微笑點頭示意' },
      ]},
      { id: 'basic', name: '基本服務', weight: 0.4, role: 'scored', items: [
        { n: 1, type: 'score', text: '同仁服裝儀容符合標準（制服、褲子、配飾等）' },
        { n: 2, type: 'score', text: '客人排隊等點餐時，會適時說明並安撫情緒' },
        { n: 3, type: 'score', text: '點餐時，對於提問的菜色專業知識，能靈活應答' },
        { n: 4, type: 'score', text: '與客人對談時，不背對客人' },
        { n: 5, type: 'score', text: '打包正確，不遺漏或放錯' },
        { n: 6, type: 'score', text: '顧客在櫃台等點餐不超過１分鐘' },
        { n: 7, type: 'score', text: '主動為客人說明用餐方式和是否需要餐具' },
        { n: 8, type: 'score', text: '顧客有特殊要求時，能迅速為其服務並靈活應答' },
      ]},
      { id: 'pro', name: '專業服務', weight: 0.15, role: 'scored', items: [
        { n: 1, type: 'score', text: '買單作業符合標準\na.主動向顧客招呼問候，並介紹近期活動內容\nb.與顧客核對消費內容及金額，並詢問是否有會員？\nC.現金：收您Ｘ元？找您Ｘ元？(雙手找零給顧客和相關單據)' },
        { n: 2, type: 'score', text: '外帶作業符合標準\na.與顧客確認單據號碼或電話後三碼，並清點所有餐點是否正確\nb.確認品項打包完整，無歪斜、無溢出、無遺漏' },
        { n: 3, type: 'score', text: '能記住客人的特殊需求並執行' },
      ]},
      { id: 'thoughtful', name: '貼心服務', weight: 0.25, role: 'scored', items: [
        { n: 1, type: 'score', text: '下雨天，主動給予衛生紙擦拭' },
        { n: 2, type: 'score', text: '雙手主動替客人盛接要結帳的品項' },
        { n: 3, type: 'score', text: '客人如有特殊口味需求能適客化調整（如微辣）' },
        { n: 4, type: 'score', text: '主動詢問客人配料（香菜和白芝麻）是否要添加' },
        { n: 5, type: 'score', text: '現場如等待時間超過二十分鐘時，主動告知現場客人' },
      ]},
      { id: 'bonus', name: '加分項目（每項＋2分）', role: 'bonus', items: [
        { n: 1, type: 'bonus', points: 2, text: '主動發現顧客隱性需求，進行關心、服務' },
        { n: 2, type: 'bonus', points: 2, text: '適時與客人互動寒喧，交換資訊，超越顧客期待的話術運用(如天冷注意保暖、下雨天注意安全…等)' },
        { n: 3, type: 'bonus', points: 2, text: '看到門口有顧客看菜單時，主動向前介紹，招呼用餐' },
        { n: 4, type: 'bonus_free', points: 2, max: 2, text: '非評分表內項目，但超乎顧客預期，每列一項具體事實，總分加2分，以2項為限。' },
      ]},
    ],
  },

  /* ───────── 環境 ───────── */
  {
    id: 'environment', name: '環境', inOperational: true,
    heading: '門市環境評分項目（一個缺失扣1分）',
    categories: [
      { id: 'facade', name: '櫃台門面', weight: 0.3, role: 'scored', items: [
        { n: 1, type: 'score', text: '天花板乾淨無蜘蛛網、積塵、油漆脫漆' },
        { n: 2, type: 'score', text: '招牌燈外觀無汙損不潔退色，並於時間內開啟\n夏季(04-09月):PM18:00、冬季(10-03月):PM17:00' },
        { n: 3, type: 'score', text: '壁面、天花板燈具、燈管、燈座無損壞髒污和色衰狀況' },
        { n: 4, type: 'score', text: '櫃台區域，以客人視角看向檯面乾淨整齊，無堆積雜物' },
        { n: 5, type: 'score', text: '門口菜單和海報文宣無破損、過期、褪色、翹角和髒汙' },
        { n: 6, type: 'score', text: '外圍騎樓一公尺內地面乾淨無落葉、和人工垃圾…等' },
      ]},
      { id: 'work', name: '作業區域', weight: 0.7, role: 'scored', items: [
        { n: 1, type: 'score', text: '油煙罩、油炸機和麵切台乾淨無污漬，且功能正常' },
        { n: 2, type: 'score', text: '不鏽鋼工作臺、水槽乾淨無污漬，且功能正常' },
        { n: 3, type: 'score', text: '生財器具擺放妥當，乾淨無污漬、無缺損、無鏽蝕' },
        { n: 4, type: 'score', text: '內用區域桌椅無損壞搖晃，相關物品乾淨無破損' },
        { n: 5, type: 'score', text: '各式冰箱、冷凍設備溫度正常(冷凍-18℃、冷藏0~7℃)' },
        { n: 6, type: 'score', text: '冰箱設備的鰭片和濾網清潔無積灰，內部空間無髒污破損' },
        { n: 7, type: 'score', text: '落實先進先出，同一品項無開封二袋以上' },
        { n: 8, type: 'score', text: '所有食材類，開封過皆有加封加蓋' },
        { n: 9, type: 'score', text: '所有布簾和品牌文宣品無髒污破損' },
        { n: 10, type: 'score', text: '櫃台區域，以客人視角看向檯面乾淨整齊，無堆積雜物' },
        { n: 11, type: 'score', text: '廚區和倉儲區層架擺放整齊，標籤向外，食材不落地' },
        { n: 12, type: 'score', text: '廚區、倉儲區和內用區地板無垃圾、無積水、無油漬' },
        { n: 13, type: 'score', text: '電風扇葉片和外觀乾淨無髒汙' },
        { n: 14, type: 'score', text: '生飲水濾芯有定期更換且出水口乾淨無髒汙' },
      ]},
    ],
  },

  /* ───────── 菜色 ───────── */
  {
    id: 'food', name: '菜色', inOperational: true,
    heading: '門市菜色品質評分項目（依色、香、味、形、器評核，一個缺失扣1分）',
    categories: [
      { id: 'sauce_taste', name: '雙醬口味', weight: 0.2, role: 'scored', items: [
        { n: 1, type: 'score', text: '炒料程序是否符合SOP標準' },
        { n: 2, type: 'score', text: '出餐的醬汁比例是否符合SOP標準' },
        { n: 3, type: 'score', text: '食材是否有焦掉或不熟狀況' },
        { n: 4, type: 'score', text: '出餐成品是否有殘餘醬汁（未收乾）' },
      ]},
      { id: 'sauce_ratio', name: '醬料比例', weight: 0.2, role: 'scored', items: [
        { n: 1, type: 'score', text: '花雕大俠醬汁製作比例和流程是否符合SOP標準' },
        { n: 2, type: 'score', text: '三杯醬製作比例和流程是否符合SOP標準' },
        { n: 3, type: 'score', text: '中辣醬油製作比例和流程是否符合SOP標準' },
        { n: 4, type: 'score', text: '鴨血醬製作比例和流程是否符合SOP標準' },
      ]},
      { id: 'ala_carte', name: '單點', weight: 0.4, role: 'scored', items: [
        { n: 1, type: 'score', text: '麻辣鴨血和豆腐煲比例及製作流程符合SOP標準' },
        { n: 2, type: 'score', text: '麻辣薯薯比例及製作流程符合SOP標準' },
        { n: 3, type: 'score', text: '開胃小菜比例及製作流程符合SOP標準' },
        { n: 4, type: 'score', text: '椒麻脆脆麵比例及製作流程符合SOP標準' },
        { n: 5, type: 'score', text: '白飯口感軟硬適中，比例及製作流程符合SOP標準' },
        { n: 6, type: 'score', text: '炸薑片、炸蒜頭色澤適中，無焦掉無變質' },
        { n: 7, type: 'score', text: '九層塔、洋蔥丁新鮮無發黃發黑無變質' },
        { n: 8, type: 'score', text: '蔬菜料、火鍋料規格及包裝成品符合SOP標準' },
      ]},
      { id: 'drinks', name: '飲品', weight: 0.2, role: 'scored', items: [
        { n: 1, type: 'score', text: '冰釀綠茶比例及製作流程符合SOP標準' },
        { n: 2, type: 'score', text: '家傳酸梅湯比例及製作流程符合SOP標準' },
        { n: 3, type: 'score', text: '出餐及保存方式符合SOP標準' },
        { n: 4, type: 'score', text: '所使用之餐具、容器是否清潔無污漬' },
      ]},
      { id: 'penalty', name: '加重扣分項目（每項扣總分10分）', role: 'penalty', items: [
        { n: 1, type: 'penalty', points: 10, text: '食材過期，如：' },
        { n: 2, type: 'penalty', points: 10, text: '未依規範使用之食材，如：' },
        { n: 3, type: 'penalty', points: 10, text: '違反食安規範，如：' },
        { n: 4, type: 'penalty', points: 10, text: '當月有發生客怨經查證屬實者（含漏餐），日期：' },
      ]},
    ],
  },

  /* ───────── 門市經營評鑑（單獨計分） ───────── */
  {
    id: 'management', name: '經營評鑑', inOperational: false, standalone: true,
    heading: '門市經營評鑑表',
    categories: [
      { id: 'finance', name: '財務作業', weight: 0.4, role: 'scored', items: [
        { n: 1, type: 'critical', text: '零找金額與實際盤點對照不符（屬重大缺失，發生即0分）' },
        { n: 2, type: 'critical', text: '作廢單據無憑證、無落實登記（屬重大缺失，發生即0分）' },
        { n: 3, type: 'critical', text: '金庫金額與實際盤點對照不符（屬重大缺失，發生即0分）' },
        { n: 4, type: 'critical', text: '存款金額與實際營業額對照不符（屬重大缺失，發生即0分）' },
        { n: 5, type: 'critical', text: '月初小費盤點無誤（屬重大缺失，發生即0分）' },
        { n: 6, type: 'critical', text: '請款費用未檢附發票或收據（屬重大缺失，發生即0分）' },
        { n: 7, type: 'score', text: '門市監視器正常作動無死角，影像保存至少為7天' },
      ]},
      { id: 'hr', name: '人資作業', weight: 0.2, role: 'scored', items: [
        { n: 1, type: 'critical', text: '同仁出勤資料有惡意塗改或造假。（屬重大缺失，發生即0分）' },
        { n: 2, type: 'critical', text: '門市雇用非法外籍員工、未滿15歲員工。（屬重大缺失，發生即0分）' },
        { n: 3, type: 'critical', text: '人事資料完整無缺件（履歷表、體檢表、銀行帳戶、身分證）未在同仁報到當日提供加保資料（屬重大缺失，發生即0分）' },
        { n: 4, type: 'binary', text: '每月25號前，將次月班表完成並公佈' },
      ]},
      { id: 'admin', name: '行政作業', weight: 0.4, role: 'scored', items: [
        { n: 1, type: 'score', text: '出勤紀錄於規定時間內回傳並計算無異常' },
        { n: 2, type: 'score', text: '月初抽查盤點表正確率100%（二十個品項）' },
        { n: 3, type: 'score', text: '特清計劃表按計劃定期保養清潔' },
        { n: 4, type: 'score', text: '公司公告確實佈達且簽名存檔' },
        { n: 5, type: 'score', text: '前次營運評分問題完成改善' },
        { n: 6, type: 'score', text: '抽問同仁目前公司政令宣達是否都清楚明白' },
        { n: 7, type: 'score', text: '設備紀錄卡有無正確填寫及正常維護' },
        { n: 8, type: 'score', text: '粉專/IG/當地社團的經營成果（每月至少一篇發文）' },
      ]},
      { id: 'bonus', name: '加分項目', role: 'bonus', items: [
        { n: 1, type: 'bonus', points: 10, text: '協助公司各項公益活動' },
        { n: 2, type: 'bonus_free', points: 2, max: 5, text: '非評分表內項目，但超乎顧客預期，每列一項具體事實，總分加2分，以5項為限。' },
      ]},
    ],
  },
];

export const GRADE_BANDS = [
  { min: 90, grade: 'A' },
  { min: 80, grade: 'B' },
  { min: 70, grade: 'C' },
  { min: 60, grade: 'D' },
  { min: 50, grade: 'E' },
];

function clone(x) { return JSON.parse(JSON.stringify(x)); }

/** 四張表的外殼（id、名稱、算不算進營運總分）固定；分類與題目由「題目設定」編輯 */
export const FORM_SHELLS = MALA_FORMS.map((f) => ({ id: f.id, name: f.name, inOperational: f.inOperational, standalone: !!f.standalone }));

/**
 * 沒存過題目時的預設（Eason 2026-10-27）：小辛辣＝舊站原題；墨竹亭、一悟＝空白（四張表沒有題目，到「題目設定」自己加）。
 * 存過之後一律用後端 insp_bank 的版本。
 */
export function defaultForms(brand) {
  if (brand === 'mala') return clone(MALA_FORMS);
  return FORM_SHELLS.map((f) => Object.assign({}, f, { heading: '', categories: [] }));
}
export const DEFAULT_VER = 'default-2026-10-27';
