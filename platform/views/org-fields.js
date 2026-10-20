/**
 * platform/views/org-fields.js — 品牌→單位→部門→職稱 連動下拉（docs/personnel/spec.md §6.5）
 *
 * 第一次使用（平台畫面）與「我的資料」「同仁名單」（模組）共用同一套連動規則：
 *   - 單位只列選到的品牌底下的
 *   - 單位是總部（ladder＝hq）且有部門清單時，才出現部門下拉
 *   - 職稱依單位的職級套用 store／hq，再套「單位限定職稱」（後端 orgOptions 的 unit_titles／title_units；
 *     例：中央工廠只能選計時／正職／廠長／研發總監，廠長、研發總監也只在中央工廠出現。docs/org/spec.md 第 15 節）
 * 選項資料一律來自後端 orgOptions（org 分頁），這裡不寫死任何品牌或單位。
 * 後端會再驗一次，這裡只是讓人選不到錯的組合。
 */

import { esc } from '../fmt.js';

export function orgFieldsHtml(prefix) {
  const f = (key, label) => `
    <div class="field" data-role="${prefix}-${key}-wrap">
      <label class="field-label" for="${prefix}-${key}">${label}</label>
      <select class="input" id="${prefix}-${key}"></select>
    </div>`;
  return `<div class="form-grid-2">${f('brand', '品牌')}${f('unit', '單位')}</div>
    <div class="form-grid-2">${f('dept', '部門')}${f('title', '職稱')}</div>`;
}

/**
 * 這個單位可選的職稱（純函式，clock-ui.js 也用）：階梯相同，且符合單位限定。
 * 舊後端沒有 unit_titles／title_units 時＝不限定（與改版前相同）。
 */
export function titlesForUnit(org, unit) {
  if (!unit) return [];
  const ladder = unit.ladder || 'store';
  const only = (org.unit_titles || {})[unit.code];
  const tu = org.title_units || {};
  return (org.titles || []).filter((t) => t.parent === ladder
    && (!only || only.indexOf(t.code) !== -1)
    && (!tu[t.code] || tu[t.code].indexOf(unit.code) !== -1));
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
    const titles = ladder ? titlesForUnit(org, unit) : [];
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
