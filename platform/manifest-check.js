/**
 * 模組 manifest 驗證器 —— 分層契約的守門員
 *
 * 正本規格：docs/spec.md §4.1（代號格式）、§4.2（權限碼）、§4.5（manifest 欄位）。
 * 這裡的每一條規則都對應那份文件的一行；要改規則，先改 spec.md 再改這裡。
 *
 * 設計原則：**不合格就明確指名是哪個欄位錯、錯在哪**，絕不靜默略過。
 * 一個模組寫錯 manifest 卻安靜地不出現在首頁，是最難查的那種 bug。
 */

/** 模組代號／命名空間／後端代號／分頁代號共用的格式 */
export const ID_RE = /^[a-z][a-z0-9-]{1,19}$/;

/** 權限碼：兩段或三段，點分隔，例 audit.read、audit.read.own */
export const PERM_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,2}$/;

const REQUIRED_KEYS = ['id', 'ns', 'backend', 'name', 'desc', 'icon', 'requires', 'views', 'entry'];
const KNOWN_KEYS = REQUIRED_KEYS.concat(['color']);

/**
 * @param {object} m 模組 manifest
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateManifest(m) {
  const errors = [];
  const warnings = [];
  const at = (field) => `manifest.${field}`;

  if (!m || typeof m !== 'object') {
    return { ok: false, errors: ['manifest 不是物件（模組的 manifest.js 是否忘了 export default？）'], warnings };
  }

  for (const k of REQUIRED_KEYS) {
    if (m[k] === undefined) errors.push(`${at(k)} 缺少必填欄位`);
  }
  for (const k of Object.keys(m)) {
    if (!KNOWN_KEYS.includes(k)) warnings.push(`${at(k)} 不是已知欄位，會被忽略`);
  }

  checkId(m.id, 'id', errors);
  checkId(m.ns, 'ns', errors);
  checkId(m.backend, 'backend', errors);
  checkId(m.icon, 'icon', errors);

  checkText(m.name, 'name', 2, 8, errors);
  checkText(m.desc, 'desc', 1, 20, errors);

  checkPermList(m.requires, 'requires', m.ns, errors, { allowEmpty: false });
  checkViews(m.views, m.ns, errors);

  // backend 與 ns 不同會讓後端「安靜地不下發通行碼」（spec.md §4.1 的約束），
  // 這種失敗長相是「模組載入正常、呼叫後端才失敗」，很難查，所以在這裡先喊一聲。
  if (typeof m.backend === 'string' && typeof m.ns === 'string' && m.backend !== m.ns) {
    warnings.push(
      `manifest.backend「${m.backend}」與 manifest.ns「${m.ns}」不同：` +
      '通行碼下發是拿 backend 當權限前綴查的，兩者不同會導致不發碼。除非已同步改過 spec §5.2，否則請設成一樣'
    );
  }

  if (m.entry !== undefined && typeof m.entry !== 'function') {
    errors.push(`${at('entry')} 必須是函式（例 () => import('./index.js')），目前是 ${typeof m.entry}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

function checkId(v, field, errors) {
  if (v === undefined) return;
  if (typeof v !== 'string') {
    errors.push(`manifest.${field} 必須是字串，目前是 ${typeof v}`);
    return;
  }
  if (!ID_RE.test(v)) {
    errors.push(`manifest.${field}「${v}」格式不符 ${ID_RE}（小寫開頭、只能小寫英數與連字號、長度 2–20）`);
  }
}

function checkText(v, field, min, max, errors) {
  if (v === undefined) return;
  if (typeof v !== 'string') {
    errors.push(`manifest.${field} 必須是字串，目前是 ${typeof v}`);
    return;
  }
  const n = Array.from(v).length;
  if (n < min || n > max) {
    errors.push(`manifest.${field}「${v}」長度 ${n}，規定 ${min}–${max} 字`);
  }
}

/**
 * 權限碼清單。每個權限碼的第一段必須等於這個模組的 ns，或平台自身的 platform——
 * 這條擋住「A 模組偷用 B 模組權限」，是分層邊界的實際執行點。
 */
function checkPermList(v, field, ns, errors, { allowEmpty }) {
  if (v === undefined) return;
  if (!Array.isArray(v)) {
    errors.push(`manifest.${field} 必須是陣列，目前是 ${typeof v}`);
    return;
  }
  if (!allowEmpty && v.length === 0) {
    errors.push(`manifest.${field} 不能是空陣列（模組至少要宣告一個進入所需的權限碼）`);
  }
  v.forEach((p, i) => {
    if (typeof p !== 'string' || !PERM_RE.test(p)) {
      errors.push(`manifest.${field}[${i}]「${p}」不是合法權限碼（格式如 audit.read、audit.read.own）`);
      return;
    }
    const head = p.split('.')[0];
    if (ns && head !== ns && head !== 'platform') {
      errors.push(`manifest.${field}[${i}]「${p}」的命名空間是「${head}」，與 manifest.ns「${ns}」不符`);
    }
  });
}

function checkViews(views, ns, errors) {
  if (views === undefined) return;
  if (!Array.isArray(views)) {
    errors.push(`manifest.views 必須是陣列，目前是 ${typeof views}`);
    return;
  }
  if (views.length === 0) {
    errors.push('manifest.views 不能是空陣列（模組至少要有一個分頁，陣列第一個是預設分頁）');
    return;
  }

  const seen = new Set();
  views.forEach((v, i) => {
    const where = `manifest.views[${i}]`;
    if (!v || typeof v !== 'object') {
      errors.push(`${where} 必須是物件 { id, name, requires }`);
      return;
    }
    checkId(v.id, `views[${i}].id`, errors);
    checkText(v.name, `views[${i}].name`, 2, 8, errors);
    checkPermList(v.requires, `views[${i}].requires`, ns, errors, { allowEmpty: true });

    if (typeof v.id === 'string') {
      if (seen.has(v.id)) errors.push(`${where}.id「${v.id}」與前面的分頁重複（路由會打架）`);
      seen.add(v.id);
    }
  });
}

/**
 * 給 shell 開機時用：驗不過就在 console 明確報錯並回 false，讓那個模組不上架，
 * 但不影響其他模組（一個模組寫壞不該讓整個系統開不起來）。
 */
export function reportManifest(m, source) {
  const { ok, errors, warnings } = validateManifest(m);
  const label = source || (m && m.id) || '(不明模組)';
  warnings.forEach((w) => console.warn(`[manifest] ${label}：${w}`));
  if (!ok) {
    console.error(`[manifest] ${label} 驗證失敗，此模組不會上架：`);
    errors.forEach((e) => console.error(`  · ${e}`));
  }
  return ok;
}
