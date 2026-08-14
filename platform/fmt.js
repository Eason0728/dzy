/**
 * 全系統唯一一份格式化純函式 —— date / datetime / roc / esc / money
 *
 * 正本規格：docs/spec.md §4.7（ctx.fmt 介面）、§2（檔案結構）。
 * 每個模組一律透過 ctx.fmt 拿到這五個函式，不得自己再刻一份
 * （教訓來源：宿舍合約系統把 esc() 複製了三份、稽核系統又有自己一份）。
 *
 * 時區規則：一律以 Asia/Taipei（UTC+8，無日光節約）呈現。
 * 這裡全程用 Intl.DateTimeFormat 明確指定 timeZone，不用
 * Date.prototype.getDate()／getHours() 這類會反映「執行環境當地時區」的方法——
 * 這個專案的資料是台灣營運資料，機器（尤其 CI，常見 UTC）時區不是台北時，
 * 用本機方法算出來的日期會整個錯位、跨午夜差一天，不能省。
 *
 * 錯誤處理規則：null／undefined／空字串／非法輸入一律回傳空字串 ''，
 * 絕不回傳 'Invalid Date'，也絕不拋例外——呼叫方（各模組 view）不必自己再判一次。
 */

const TZ = 'Asia/Taipei';

/** 只接受這個格式的日期字串，其餘一律視為非法（含缺零補位、帶時間等） */
/**
 * 接受的字串格式（2026-08-14 補齊；原本只認純日期，導致後端寫出去的時間前端讀不回來）：
 *   2026-08-01                  純日期
 *   2026-08-01 09:30:00         後端 login_log／created_at 寫入試算表的格式
 *   2026-08-01T09:30:00         ISO 但沒有時區標記
 *   秒數可省略：2026-08-01 09:30
 *
 * 這幾種一律視為「台北時間的牆上時鐘」——它們本來就是台灣的營運資料，
 * 沒有帶時區資訊，當成 UTC 解析會整批偏移八小時（原本 '2026-08-01' 會變成 08:00:00）。
 * 帶 Z 或 ±hh:mm 的字串是真正的時間點，交給 Date 內建解析器處理，不走這裡。
 */
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const HAS_TZ_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** 台北是 UTC+8 且不實施日光節約，所以固定偏移是安全的 */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 把任意輸入正規化成一個代表確切時刻的 Date，或 null（代表無法解析／空值）。
 * 支援：Date 物件、'YYYY-MM-DD' 字串、Unix 毫秒數字。
 */
function toDate(input) {
  if (input === null || input === undefined || input === '') return null;

  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof input === 'string') {
    const s = input.trim();
    if (s === '') return null;
    // 帶時區標記的字串是明確的時間點，交給內建解析器（例 2026-08-01T01:30:00Z）
    if (HAS_TZ_RE.test(s)) {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    const m = LOCAL_DATETIME_RE.exec(s);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = m[4] === undefined ? 0 : Number(m[4]);
    const minute = m[5] === undefined ? 0 : Number(m[5]);
    const second = m[6] === undefined ? 0 : Number(m[6]);
    if (month < 1 || month > 12) return null;
    // 用 UTC day-0 技巧算該月天數（含閏年 2 月），避免自己刻一份月曆規則
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day < 1 || day > daysInMonth) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    // 明確用 Date.UTC 建構再扣掉台北偏移，不透過 new Date(string) 的內建解析器——
    // 那個解析器對「沒帶時區的字串」的行為在不同引擎下不一致（有的當本地、有的當 UTC）。
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - TAIPEI_OFFSET_MS);
  }

  return null;
}

/** 明確指定 Asia/Taipei，一次取出年/月/日/時/分/秒，不受 process.env.TZ 或作業系統時區影響 */
const PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

function taipeiParts(d) {
  const parts = {};
  for (const { type, value } of PARTS_FORMATTER.formatToParts(d)) {
    parts[type] = value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // 少數 ICU 版本 h23 午夜會印成 24，夾回 0
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 'YYYY-MM-DD'（台北時區） */
export function date(d) {
  const dt = toDate(d);
  if (!dt) return '';
  const p = taipeiParts(dt);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 'YYYY-MM-DD HH:mm:ss'（台北時區） */
export function datetime(d) {
  const dt = toDate(d);
  if (!dt) return '';
  const p = taipeiParts(dt);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/** '民國 YYY 年 M 月 D 日'（台北時區；民國年＝西元年-1911；月日不補零） */
export function roc(d) {
  const dt = toDate(d);
  if (!dt) return '';
  const p = taipeiParts(dt);
  return `民國 ${p.year - 1911} 年 ${p.month} 月 ${p.day} 日`;
}

const ESC_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/** HTML 轉義：& < > " ' 五個字元 */
export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}

/** 千分位金額，例 1234567 → '1,234,567'；-1234 → '-1,234' */
export function money(n) {
  if (n === null || n === undefined || n === '') return '';
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num)) return '';

  const negative = num < 0;
  const abs = Math.abs(num);
  const [intPart, fracPart] = String(abs).split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const result = fracPart ? `${withCommas}.${fracPart}` : withCommas;
  return negative ? `-${result}` : result;
}
