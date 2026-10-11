/**
 * modules/staff-shared/org-fields.js — 品牌→單位→部門→職稱 連動下拉（docs/personnel/spec.md §6.5）
 *
 * ⚠ 這是 platform/views/org-fields.js 的**同一份程式**（模組不得 import 平台內部，只能各留一份）。
 *    test/staff-front.test.mjs 會比對兩份去掉檔頭後逐字相同，改一邊一定要改另一邊。
 *
 * 第一次使用（平台畫面）與「我的資料」「同仁名單」（模組）共用同一套連動規則：
 *   - 單位只列選到的品牌底下的
 *   - 單位是總部（ladder＝hq）且有部門清單時，才出現部門下拉
 *   - 職稱依單位的職級套用 store／hq
 * 選項資料一律來自後端 orgOptions（org 分頁），這裡不寫死任何品牌或單位。
 * 後端會再驗一次，這裡只是讓人選不到錯的組合。
 */

import { esc } from './esc.js';

export function orgFieldsHtml(prefix) {
  const f = (key, label) => `
    <div class="field" data-role="${prefix}-${key}-wrap">
      <label class="field-label" for="${prefix}-${key}">${label}</label>
      <select class="input" id="${prefix}-${key}"></select>
    </div>`;
  return `<div class="form-grid-2">${f('brand', '品牌')}${f('unit', '單位')}</div>
    <div class="form-grid-2">${f('dept', '部門')}${f('title', '職稱')}</div>`;
}

function options(list, selected, placeholder) {
  return `<option value="">${esc(placeholder)}</option>` +
    list.map((o) => `<option value="${esc(o.code)}"${o.code === selected ? ' selected' : ''}>${esc(o.name)}</option>`).join('');
}

/**
 * @param {Element} root
 * @param {string} prefix
 * @param {{brands,units,depts,titles}} org 後端 orgOptions 的 data
 * @param {{brand?,unit?,dept?,title?}} initial 預選值
 */
export function bindOrgFields(root, prefix, org, initial) {
  const $ = (k) => root.querySelector(`#${prefix}-${k}`);
  const wrap = (k) => root.querySelector(`[data-role="${prefix}-${k}-wrap"]`);
  const cur = Object.assign({ brand: '', unit: '', dept: '', title: '' }, initial || {});

  function draw() {
    $('brand').innerHTML = options(org.brands, cur.brand, '請選擇');
    const units = org.units.filter((u) => u.parent === cur.brand);
    if (!units.some((u) => u.code === cur.unit)) cur.unit = '';
    $('unit').innerHTML = options(units, cur.unit, cur.brand ? '請選擇' : '先選品牌');
    $('unit').disabled = !cur.brand;
    const unit = units.find((u) => u.code === cur.unit);
    const ladder = unit ? (unit.ladder || 'store') : '';
    const depts = unit && ladder === 'hq' ? org.depts.filter((d) => d.parent === unit.code) : [];
    if (!depts.some((d) => d.code === cur.dept)) cur.dept = '';
    $('dept').innerHTML = options(depts, cur.dept, '請選擇');
    wrap('dept').hidden = depts.length === 0;
    const titles = ladder ? org.titles.filter((t) => t.parent === ladder) : [];
    if (!titles.some((t) => t.code === cur.title)) cur.title = '';
    $('title').innerHTML = options(titles, cur.title, cur.unit ? '請選擇' : '先選單位');
    $('title').disabled = !cur.unit;
  }
  ['brand', 'unit', 'dept', 'title'].forEach((k) => {
    $(k).addEventListener('change', () => {
      cur[k] = $(k).value;
      draw();
    });
  });
  draw();
}

export function readOrgFields(root, prefix) {
  const v = (k) => {
    const el = root.querySelector(`#${prefix}-${k}`);
    const w = root.querySelector(`[data-role="${prefix}-${k}-wrap"]`);
    return el && !(w && w.hidden) ? el.value : '';
  };
  return { brand: v('brand'), unit: v('unit'), dept: v('dept'), title: v('title') };
}
