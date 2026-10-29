// test/dd/ops_inspection.mjs —— 資料帶入測試：營運巡檢（Inspect.gs ＋ modules/inspection/scoring.js）
//
// 每次執行全部隨機重抽：門市數（含停用店）、人數與職稱分布（營運部／執行長／總監／督導／店長／區經理／一般同仁／人資）、
// 墨竹亭與一悟的自訂題庫（分類數、權重、題型、分數）、巡檢筆數、每題分數（分層：高中低都出現）、加分、加重扣分、照片、日期。
// 預期值一律由本檔「照 docs/inspection/spec.md §2／§3 與舊站算分規則」自己算（oracle），逐筆比對：
//   誰看得到哪些店、誰能巡、誰能作廢、誰能設定哪個品牌的題目、巡檢總分／各表分數／等第／缺失數、清單排序與篩選、照片可見性、
//   題庫版本與衝突、快照不隨題目改版、重送同編號、各種格式擋下。
// scoring.js 只拿來當「受測物」（算出前端會送出的 summary），oracle 不用它；questions.js 只讀題目資料（不是算式）。
// 用法：node test/dd/ops_inspection.mjs　　重現：E2E_SEED=<種子> node test/dd/ops_inspection.mjs
'use strict';

import { buildWorld } from '../e2e/inspect_backend.mjs';
import { defaultForms, GRADE_BANDS } from '../../modules/inspection/questions.js';
import * as SUT from '../../modules/inspection/scoring.js';

// ── 種子與亂數 ──────────────────────────────────────────────
const SEED = Number(process.env.E2E_SEED) || (Math.floor(Math.random() * 1e9) + 1);
console.log('E2E_SEED=' + SEED);
let _s = SEED >>> 0;
function rnd() { _s = (_s + 0x6D2B79F5) >>> 0; let t = _s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

let passed = 0, failed = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { passed++; } else { failed++; fails.push(label); console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra).slice(0, 600) : '')); }
}
const J = (v) => JSON.stringify(v);
const eq = (a, b) => J(a) === J(b);
const sortU = (a) => a.slice().sort();

// ── oracle：算分（照 spec；不碰 scoring.js）──────────────────
function r1(x) { if (x === null || x === undefined) return null; const s = x < 0 ? -1 : 1; return s * Math.floor(Math.abs(x) * 10 + 0.5 + 1e-9) / 10; }
function gradeOf(s) { for (const b of GRADE_BANDS) if (s >= b.min) return b.grade; return '未達'; }
const key = (f, c, it) => f.id + '.' + c.id + '.' + it.n;
function oracle(forms, ans) {
  const out = {};
  let defects = 0;
  for (const f of forms) {
    const cats = [];
    let bonus = 0, pen = 0;
    for (const c of f.categories) {
      if (c.role === 'scored') {
        const vals = c.items.filter((it) => key(f, c, it) in ans.scores && ans.scores[key(f, c, it)] !== null).map((it) => Number(ans.scores[key(f, c, it)]));
        vals.forEach((v) => { if (v < 5) defects++; });
        if (vals.length) cats.push([c.weight, vals.reduce((s, v) => s + v, 0) / (5 * vals.length)]);
      } else if (c.role === 'bonus') {
        for (const it of c.items) {
          const k = key(f, c, it);
          if (it.type === 'bonus' && ans.bonuses[k]) bonus += it.points;
          if (it.type === 'bonus_free') bonus += it.points * Math.min(it.max, (ans.freeBonuses[k] || []).filter((s) => s && String(s).trim()).length);
        }
      } else if (c.role === 'penalty') {
        for (const it of c.items) { const p = ans.penalties[key(f, c, it)]; if (p && p.checked) { pen += it.points; defects++; } }
      }
    }
    let score = null;
    if (cats.length) { const w = cats.reduce((s, x) => s + x[0], 0); score = cats.reduce((s, x) => s + x[0] * x[1], 0) / w * 100 + bonus; }
    out[f.id] = { score, pen, inop: !!f.inOperational, name: f.name };
  }
  const ev = Object.values(out).filter((v) => v.inop && v.score !== null);
  const penTotal = Object.values(out).filter((v) => v.inop).reduce((s, v) => s + v.pen, 0);
  const op = ev.length ? r1(ev.reduce((s, v) => s + v.score, 0) / ev.length - penTotal) : null;
  const mg = out.management && out.management.score !== null ? r1(out.management.score) : null;
  return {
    operationalScore: op, operationalGrade: op === null ? '未評' : gradeOf(op),
    managementScore: mg, managementGrade: mg === null ? '未評' : gradeOf(mg),
    penaltyTotal: penTotal,
    forms: forms.map((f) => ({ id: f.id, name: f.name, score: r1(out[f.id].score) })),
    defects
  };
}

// ── 隨機題庫（墨竹亭、一悟自訂）──────────────────────────────
const WORDS = ['桌面乾淨', '招呼客人', '冰箱溫度', '湯頭溫度', '出餐時間', '制服整齊', '收銀正確', '叉燒厚度', '麵條口感', '餐具清潔', '地板無油漬', '標籤向外', '先進先出', '監視器正常'];
const SHELLS = defaultForms('mzt');   // 四張表外殼（資料）
function splitWeights(n) {   // n 個 1～100 的整數，加總 100
  const cuts = new Set(); while (cuts.size < n - 1) cuts.add(ri(1, 99));
  const arr = [0, ...[...cuts].sort((a, b) => a - b), 100];
  return arr.slice(1).map((v, i) => v - arr[i]);
}
function randomBank(brand) {
  const forms = SHELLS.map((sh) => ({ id: sh.id, name: sh.name, inOperational: sh.inOperational, standalone: sh.standalone, heading: chance(0.5) ? brand + sh.name + '表' : '', categories: [] }));
  let seq = 0;
  const cid = () => 'c' + (seq++).toString(36) + brand.slice(0, 1);
  for (const f of forms) {
    if (chance(0.15)) continue;   // 這張表整張空白
    const ns = ri(0, 3);
    if (ns) {
      const ws = splitWeights(ns);
      for (let i = 0; i < ns; i++) {
        const items = [];
        const n = ri(1, 4);
        for (let j = 0; j < n; j++) items.push({ n: j + 1, type: pick(['score', 'score', 'critical', 'binary']), text: pick(WORDS) + ' ' + ri(1, 999) });
        f.categories.push({ id: cid(), name: '分類' + ri(1, 99), role: 'scored', weight: ws[i] / 100, items });
      }
    }
    if (chance(0.5)) {
      const items = [];
      for (let j = 0; j < ri(1, 3); j++) {
        const t = pick(['bonus', 'bonus_free']);
        const it = { n: j + 1, type: t, text: '加分 ' + ri(1, 999), points: ri(1, 20) };
        if (t === 'bonus_free') it.max = ri(1, 10);
        items.push(it);
      }
      f.categories.push({ id: cid(), name: '加分項', role: 'bonus', items });
    }
    if (chance(0.5)) {
      const items = [];
      for (let j = 0; j < ri(1, 3); j++) items.push({ n: j + 1, type: 'penalty', text: '扣分 ' + ri(1, 999), points: ri(1, 20) });
      f.categories.push({ id: cid(), name: '加重扣分', role: 'penalty', items });
    }
  }
  // 至少一張營運表有評分題（否則這個品牌巡不了）
  if (!forms.some((f) => f.inOperational && f.categories.some((c) => c.role === 'scored'))) {
    forms[0].categories.unshift({ id: cid(), name: '保底分類', role: 'scored', weight: 1, items: [{ n: 1, type: 'score', text: '保底題' }] });
    const sc = forms[0].categories.filter((c) => c.role === 'scored'); const ws = splitWeights(sc.length); sc.forEach((c, i) => { c.weight = ws[i] / 100; });
  }
  return forms;
}
/** 後端 inspCleanForms_ 存進去的樣子（照 spec §3 文字：n 重編、權重三位小數、heading 60 字、不帶空欄） */
function cleanedForms(forms) {
  return forms.map((f) => {
    const o = { id: f.id, name: f.name, inOperational: f.inOperational, heading: (f.heading || '').slice(0, 60), categories: f.categories.map((c) => {
      const cat = { id: c.id, name: c.name.slice(0, 30), role: c.role, items: [] };
      if (c.role === 'scored') cat.weight = Math.round(c.weight * 1000) / 1000;
      cat.items = c.items.map((it, i) => { const x = { n: i + 1, type: it.type, text: it.text.slice(0, 300) }; if (it.points !== undefined && it.type !== 'score' && it.type !== 'critical' && it.type !== 'binary') x.points = it.points; if (it.type === 'bonus_free') x.max = it.max; return x; });
      return cat;
    }) };
    if (f.standalone) o.standalone = true;
    return o;
  });
}
const countItems = (forms) => forms.reduce((s, f) => s + f.categories.reduce((t, c) => t + c.items.length, 0), 0);

// ── 隨機作答（分層：每張表抽一個水準中心）─────────────────────
function randomAnswers(forms, level) {
  const ans = { scores: {}, bonuses: {}, freeBonuses: {}, penalties: {}, reasons: {}, photos: {} };
  for (const f of forms) {
    const center = level !== undefined ? level : pick([5, 4.6, 4, 3.2, 2.5, 1.2]);
    for (const c of f.categories) for (const it of c.items) {
      const k = key(f, c, it);
      if (c.role === 'scored') {
        if (chance(0.12)) continue;   // 沒評
        let v;
        if (it.type === 'score') { v = Math.round(center + (rnd() * 2 - 1) * 1.4); v = Math.max(0, Math.min(5, v)); }
        else v = chance(center < 4 ? 0.3 : 0.06) ? 0 : 5;
        ans.scores[k] = v;
        if (v < 5 && chance(0.7)) ans.reasons[k] = pick(['桌面有油漬', '沒有招呼', '冰箱 9 度', '標籤朝內']) + ' #' + ri(1, 99);
      } else if (c.role === 'bonus') {
        if (it.type === 'bonus' && chance(0.35)) ans.bonuses[k] = true;
        if (it.type === 'bonus_free' && chance(0.4)) {
          const n = ri(1, it.max + 1);   // 可能多填一項（超過 max 的不算）
          ans.freeBonuses[k] = Array.from({ length: n }, (_, i) => (chance(0.15) ? '  ' : '事實 ' + i + '-' + ri(1, 99)));
        }
      } else if (c.role === 'penalty') {
        if (chance(0.2)) ans.penalties[k] = { checked: true, note: '說明 ' + ri(1, 99) };
        else if (chance(0.1)) ans.penalties[k] = { checked: false, note: '沒勾的說明' };
      }
    }
  }
  return ans;
}

// ============================================================
// 世界：隨機門市、隨機人
// ============================================================
const w = buildWorld();
const { post, sb, app } = w;
const A = sb.__admin;
const PW = 'fake-staff-pw-1';
let nameSeq = 0;
function mk(name, org) {
  nameSeq++;
  name = name + nameSeq;
  post('staffImport', { names: [name] }, A);
  const lk = post('claimLookup', { name });
  const prof = Object.assign({ dept: '', birthday: '1990-01-0' + (1 + (nameSeq % 8)), phone: '09' + String(30000000 + nameSeq), address: '新竹市假資料路' + nameSeq + '號' }, org);
  const sub = post('claimSubmit', Object.assign({ name, emp_no: lk.data.emp_no, password: PW }, prof));
  if (!sub.ok) throw new Error('claimSubmit 失敗 ' + J(sub));
  const cf = post('staffConfirm', { emp_no: lk.data.emp_no }, A);
  if (!cf.ok) throw new Error('staffConfirm 失敗 ' + J(cf));
  const lg = post('login', { username: lk.data.emp_no, password: PW });
  if (!lg.ok) throw new Error('登入失敗 ' + J(lg));
  return Object.assign({ emp: lk.data.emp_no, name, token: lg.data.token }, org);
}

// 門市：種子（mzt-js、mzt-gf、mzt-lzl、mala-gf、yiwu-js、yiwu-wx）＋ buildWorld 補的 mala-mc、mala-nc ＋ 隨機新增（含停用）
const BRANDS = ['mzt', 'mala', 'yiwu'];
const orgRows = app.sheets.org._rows ? app.sheets.org._rows() : app.sheets.org.getRange(1, 1, app.sheets.org.getLastRow(), 8).getValues();
let order = 50;
for (const b of BRANDS) {
  for (let i = 0; i < ri(0, 2); i++) app.sheets.org.appendRow(['unit', b + '-dd' + i, '假店' + b + i, b, 'store', '', order++, 'TRUE']);
  if (chance(0.5)) app.sheets.org.appendRow(['unit', b + '-off', '停用店' + b, b, 'store', '', order++, 'FALSE']);
}
if (chance(0.4)) app.sheets.org.appendRow(['unit', 'ck-dd', '第二央廚', 'ck', 'store', '', order++, 'TRUE']);   // 央廚不巡
const units = (app.sheets.org._rows ? app.sheets.org._rows() : app.sheets.org.getRange(1, 1, app.sheets.org.getLastRow(), 8).getValues())
  .filter((r) => r[0] === 'unit').map((r) => ({ code: r[1], name: r[2], brand: r[3], ladder: r[4] || 'store', active: String(r[7]) === 'TRUE' }));
const STORES = units.filter((u) => u.ladder === 'store' && u.active && BRANDS.includes(u.brand));
const storesOf = (b) => STORES.filter((u) => u.brand === b).map((u) => u.code);
const unitBrand = Object.fromEntries(units.map((u) => [u.code, u.brand]));
console.log('門市 ' + STORES.length + ' 家：' + STORES.map((u) => u.code).join(','));

// 人：隨機數量與職稱分布（buildWorld 自帶 10 位也納入）
const people = [];
const add = (kind, name, org) => { const p = mk(name, org); p.kind = kind; people.push(p); return p; };
for (let i = 0; i < ri(1, 3); i++) add('ops', '假營運部', { brand: 'dzy', unit: 'dzy-hq', dept: pick(['ops', 'ops', 'ops']), title: pick(['hs', 'hs', 'hm']) });
for (let i = 0; i < ri(0, 2); i++) add('hq', '假部門同仁', { brand: 'dzy', unit: 'dzy-hq', dept: pick(['hr', 'fin', 'it', 'marketing']), title: pick(['hs', 'hm']) });
for (let i = 0; i < ri(0, 2); i++) add('exec', '假高層', { brand: 'dzy', unit: 'dzy-hq', dept: 'mgmt', title: pick(['ceo', 'gm', 'chair']) });
for (const b of BRANDS) {
  if (chance(0.7)) add('odir', '假總監', { brand: b, unit: b + '-hq', title: 'odir' });
  for (let i = 0; i < ri(0, 2); i++) add('osv', '假督導', { brand: b, unit: b + '-hq', title: 'osv' });
  if (chance(0.4)) add('ofs', '假行政', { brand: b, unit: b + '-hq', title: 'ofs' });
  for (const u of storesOf(b)) {
    if (chance(0.7)) add('sm', '假店長', { brand: b, unit: u, title: 'sm' });
    if (chance(0.4)) add('am', '假區經理', { brand: b, unit: u, title: 'am' });
    for (let i = 0; i < ri(0, 2); i++) add('staff', '假同仁', { brand: b, unit: u, title: pick(['pt', 'ft']) });
  }
}
// buildWorld 自帶的人
const fixed = { ops: ['ops', 'dzy-hq', 'ops', 'hs', 'dzy'], hr: ['hq', 'dzy-hq', 'hr', 'hs', 'dzy'], malaOdir: ['odir', 'mala-hq', '', 'odir', 'mala'], malaOsv: ['osv', 'mala-hq', '', 'osv', 'mala'], mztOsv: ['osv', 'mzt-hq', '', 'osv', 'mzt'],
  gfSm: ['sm', 'mala-gf', '', 'sm', 'mala'], mcSm: ['sm', 'mala-mc', '', 'sm', 'mala'], gfPt: ['staff', 'mala-gf', '', 'pt', 'mala'], mztAm: ['am', 'mzt-gf', '', 'am', 'mzt'], ceo: ['exec', 'dzy-hq', 'mgmt', 'ceo', 'dzy'] };
Object.entries(fixed).forEach(([k, [kind, unit, dept, title, brand]]) => people.push({ kind, emp: w.people[k].emp, token: w.people[k].token, name: '', unit, dept, title, brand }));
console.log('人員 ' + people.length + ' 位：' + Object.entries(people.reduce((m, p) => { m[p.kind] = (m[p.kind] || 0) + 1; return m; }, {})).map(([k, n]) => k + '×' + n).join(' '));

// ── oracle：範圍（spec §2 預設規則）──
function scopeOf(p) {
  const all = p.unit === 'dzy-hq' && (p.dept === 'ops' || ['ceo', 'gm', 'chair'].includes(p.title));
  const brand = p.unit.endsWith('-hq') && p.unit !== 'dzy-hq' && ['odir', 'osv'].includes(p.title);
  const own = ['sm', 'am'].includes(p.title) && STORES.some((u) => u.code === p.unit);
  let view = [];
  if (all) view = STORES.map((u) => u.code);
  else if (brand) view = storesOf(p.brand);
  else if (own) view = [p.unit];
  const canDo = (p.unit === 'dzy-hq' && p.dept === 'ops') || (brand) || (p.title === 'am' && own);
  const canVoid = all;
  let bank = [];
  if (p.unit === 'dzy-hq' && p.dept === 'ops') bank = BRANDS.slice();
  else if (brand && p.title === 'odir') bank = [p.brand];
  return { view: sortU(view), canDo: canDo && view.length > 0, canVoid, bank, doUnits: canDo ? sortU(view) : [] };
}

// ============================================================
// 1. 初始化、範圍
// ============================================================
const anyOps = people.find((p) => p.kind === 'ops');
ok(post('inspList', {}, anyOps.token).error === 'not_inited', '1a 沒初始化 → not_inited');
ok(post('inspSetup', {}, anyOps.token).error === 'forbidden', '1b 非 admin 不能初始化');
const setup = post('inspSetup', {}, A);
ok(setup.ok && setup.data.permAdded.length === 14, '1c admin 初始化補 14 條預設規則', setup);
ok(post('inspSetup', {}, A).data.permAdded.length === 0, '1d 再按一次不重複補');

for (const p of people) {
  const r = post('inspMe', {}, p.token);
  const ex = scopeOf(p);
  const tag = `${p.kind}/${p.title}@${p.unit}${p.dept ? '/' + p.dept : ''}`;
  ok(r.ok, `1e inspMe 成功 ${tag}`, r);
  if (!r.ok) continue;
  const d = r.data;
  ok(eq(sortU(d.stores.map((s) => s.unit)), ex.view), `1f 看得到的店 ${tag}`, { got: sortU(d.stores.map((s) => s.unit)), want: ex.view });
  ok(d.can_do === ex.canDo && eq(sortU(d.do_units), ex.doUnits), `1g 可巡 ${tag}（${ex.canDo}）`, { got: [d.can_do, d.do_units], want: [ex.canDo, ex.doUnits] });
  ok(d.can_void === ex.canVoid, `1h 可作廢 ${tag}（${ex.canVoid}）`);
  ok(eq(d.bank_brands.map((b) => b.brand), ex.bank), `1i 題目設定品牌 ${tag}`, { got: d.bank_brands, want: ex.bank });
  if (!p.name) p.name = d.me.name;   // buildWorld 自帶的人：姓名以後端為準
  ok(d.can_photo === true && d.is_admin === false && d.me.emp === p.emp, `1j 可附照片、非 admin、me 正確 ${tag}`);
  ok(d.stores.every((s) => s.brand === unitBrand[s.unit] && s.name && s.brand_name), `1k 店名／品牌名齊 ${tag}`);
  p.scope = ex;
}
const adm = post('inspMe', {}, A).data;
ok(eq(sortU(adm.stores.map((s) => s.unit)), STORES.map((u) => u.code).sort()) && adm.can_do && adm.can_void && adm.is_admin && adm.can_photo === false && eq(adm.bank_brands.map((b) => b.brand), BRANDS), '1l admin：全部門市、可巡、可作廢、不能附照片、三個品牌題目', adm);
ok(!adm.stores.some((s) => unitBrand[s.unit] === 'ck') && !adm.stores.some((s) => /-off$/.test(s.unit)), '1m 央廚與停用店不在巡檢名單');

// ============================================================
// 2. 題庫：隨機題目存檔、驗證擋下、版本、權限
// ============================================================
const bg = (p, b) => post('inspBankGet', { brand: b }, p.token);
const bank = { mala: null, mzt: null, yiwu: null };   // 目前生效的題目（oracle 用）
const ver = { mala: '', mzt: '', yiwu: '' };
for (const b of BRANDS) {
  const r = bg(anyOps, b);
  ok(r.ok && r.data.forms === null && r.data.ver === '', `2a ${b} 還沒存過題目（forms:null）`, r);
}
// 誰能讀：看得到該品牌門市、或能設定的人
for (const p of people) {
  for (const b of BRANDS) {
    const sees = p.scope.view.some((u) => unitBrand[u] === b) || p.scope.bank.includes(b);
    const r = bg(p, b);
    ok(sees ? r.ok : r.error === 'forbidden', `2b inspBankGet ${b} 給 ${p.kind}/${p.title}@${p.unit} → ${sees ? '可讀' : 'forbidden'}`, r);
  }
}
ok(bg(anyOps, 'ck').error === 'bad_request' && bg(anyOps, '').error === 'bad_request', '2c 品牌錯 → bad_request');

const bankers = people.filter((p) => p.scope.bank.length);
for (const b of shuffle(['mzt', 'yiwu'])) {
  const forms = randomBank(b);
  const canSave = bankers.filter((p) => p.scope.bank.includes(b));
  const cannot = people.filter((p) => !p.scope.bank.includes(b));
  if (cannot.length) { const p = pick(cannot); ok(post('inspBankSave', { brand: b, forms, expected_ver: '' }, p.token).error === 'forbidden', `2d ${p.kind}/${p.title} 不能存 ${b} 題目`); }
  const saver = canSave.length ? pick(canSave) : null;
  const tok = saver ? saver.token : A;
  // 隨機壞資料各擋一次
  const bad = [];
  const sc = forms.flatMap((f, fi) => f.categories.map((c, ci) => [fi, ci, c])).filter((x) => x[2].role === 'scored');
  if (sc.length) { const x = JSON.parse(J(forms)); const c0 = x[sc[0][0]].categories[sc[0][1]]; c0.weight = c0.weight > 0.3 ? c0.weight - 0.3 : c0.weight + 0.3; /* 加總一定偏 30% */ bad.push(['權重加總不是 100%', x, /100%/]); }
  { const x = JSON.parse(J(forms)); const f = x.find((f) => f.categories.length && f.categories[0].items.length); if (f) { f.categories[0].items[0].text = '   '; bad.push(['空白題目', x, /沒有內容/]); } }
  { const x = JSON.parse(J(forms)); const it = x.flatMap((f) => f.categories).flatMap((c) => c.items).find((it) => it.points !== undefined); if (it) { it.points = pick([0, 21, 2.5, -3]); bad.push(['分數不在 1～20', x, /1～20/]); } }
  { const x = JSON.parse(J(forms)); const it = x.flatMap((f) => f.categories).flatMap((c) => c.items).find((it) => it.type === 'bonus_free'); if (it) { it.max = pick([0, 11]); bad.push(['最多項數不在 1～10', x, /1～10/]); } }
  { const x = JSON.parse(J(forms)); if (x[0].categories.length) { x[0].categories.push(JSON.parse(J(x[0].categories[0]))); bad.push(['分類代號重複', x, /重複/]); } }
  { const x = JSON.parse(J(forms)); x.reverse(); bad.push(['表的順序不對', x, /順序/]); }
  { const x = JSON.parse(J(forms)); x.pop(); bad.push(['少一張表', x, /四張表/]); }
  { const x = JSON.parse(J(forms)); const f = x.find((f) => f.categories.length); if (f) { f.categories[0].name = ''; bad.push(['分類沒名稱', x, /沒有名稱/]); } }
  { const x = JSON.parse(J(forms)); const f = x.find((f) => f.categories.length); if (f) { f.categories[0].id = 'Bad Id'; bad.push(['分類代號格式錯', x, /代號/]); } }
  { const x = JSON.parse(J(forms)); const c = x.flatMap((f) => f.categories).find((c) => c.role === 'bonus'); if (c) { c.items[0].type = 'score'; bad.push(['加分分類放評分題', x, /種類/]); } }
  { const x = JSON.parse(J(forms)); x[0].categories.push({ id: 'zz_big', name: '太多題', role: 'scored', weight: 1, items: Array.from({ length: 301 }, (_, i) => ({ n: i + 1, type: 'score', text: 't' + i })) }); const sc0 = x[0].categories.filter((c) => c.role === 'scored'); sc0.forEach((c) => { c.weight = 1 / sc0.length; }); bad.push(['超過 300 題', x, /太多/]); }
  for (const [label, x, re] of bad) {
    const r = post('inspBankSave', { brand: b, forms: x, expected_ver: '' }, tok);
    ok(r.error === 'bad_request' && re.test(r.message || ''), `2e ${b} 題庫 ${label} → 擋下`, r);
  }
  const sv = post('inspBankSave', { brand: b, forms, expected_ver: '' }, tok);
  ok(sv.ok && sv.data.ver === b + '-v1' && sv.data.total === countItems(forms), `2f ${b} 隨機題庫存檔（${countItems(forms)} 題，${saver ? saver.kind : 'admin'}）`, sv);
  ok(post('inspBankSave', { brand: b, forms, expected_ver: '' }, tok).error === 'conflict', `2g ${b} 拿舊版本號再存 → conflict`);
  const got = bg(anyOps, b).data;
  ok(got.ver === b + '-v1' && eq(got.forms, cleanedForms(forms)), `2h ${b} 讀回的題目＝送出的（清洗後：n 重編、權重三位小數）`, { got: got.forms, want: cleanedForms(forms) });
  bank[b] = got.forms; ver[b] = got.ver;
  ok(countItems(got.forms) === sv.data.total, `2i ${b} 題數一致`);
}
bank.mala = defaultForms('mala'); ver.mala = 'default-2026-10-27';
// 隨機：小辛辣有時也存一版（改一個權重拆法）
if (chance(0.5)) {
  const f = JSON.parse(J(bank.mala));
  const sc = f[0].categories.filter((c) => c.role === 'scored'); const ws = splitWeights(sc.length); sc.forEach((c, i) => { c.weight = ws[i] / 100; });
  const sv = post('inspBankSave', { brand: 'mala', forms: f, expected_ver: '' }, anyOps.token);
  ok(sv.ok && sv.data.ver === 'mala-v1', '2j 小辛辣改權重存檔 mala-v1', sv);
  bank.mala = bg(anyOps, 'mala').data.forms; ver.mala = 'mala-v1';
  ok(eq(bank.mala, cleanedForms(f)), '2k 小辛辣讀回＝清洗後的送出內容');
}

// ============================================================
// 3. 巡檢：隨機送出、算分、照片、可見性
// ============================================================
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');
const doers = people.filter((p) => p.scope.canDo);
ok(doers.length > 0, '3a 至少一位可巡檢的人');
let idSeq = 0;
const newId = () => 'INS-' + (Date.now() + idSeq++).toString(36).toUpperCase() + '-' + Array.from({ length: 6 }, () => pick([...'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'])).join('');
const records = [];
const N = ri(6, 14);
const LEVELS = [5, 4.6, 4, 3.2, 2.5, 1.2];
for (let i = 0; i < N; i++) {
  const by = chance(0.1) ? null : pick(doers);   // null＝admin 送（沒照片）
  const doUnits = by ? by.scope.doUnits : STORES.map((u) => u.code);
  const unit = pick(doUnits);
  const b = unitBrand[unit];
  const forms = bank[b];
  if (!countItems(forms)) { i--; continue; }
  const ans = randomAnswers(forms, LEVELS[i % LEVELS.length]);
  const exp = oracle(forms, ans);
  const sut = SUT.summaryOf(forms, ans);
  ok(eq(sut, exp), `3b 前端 scoring.js 的 summary＝oracle（${b} ${unit} 營運 ${exp.operationalScore} ${exp.operationalGrade}／經營 ${exp.managementScore} ${exp.managementGrade}／缺失 ${exp.defects}）`, { sut, exp });
  // 照片：隨機 0～3 張綁在隨機缺失題上
  const files = [];
  if (by && chance(0.6)) {
    const keys = Object.keys(ans.scores).filter((k) => ans.scores[k] < 5);
    for (let j = 0; j < ri(1, 3) && keys.length; j++) {
      const r = w.filePut({ token: by.token, kind: 'receipt', mime: 'image/jpeg', b64: JPG });
      if (r.ok) { const k = pick(keys); (ans.photos[k] = ans.photos[k] || []).push(r.data.id); files.push(r.data.id); }
    }
  }
  const date = `2026-${String(ri(7, 10)).padStart(2, '0')}-${String(ri(1, 28)).padStart(2, '0')}`;
  const id = newId();
  const r = post('inspSubmit', { id, unit, date, bank_ver: ver[b], forms, answers: ans, summary: sut, files }, by ? by.token : A);
  ok(r.ok && r.data.id === id && !r.data.dup, `3c 送出成功 ${id} ${unit} ${date} by ${by ? by.kind : 'admin'}`, r);
  records.push({ id, unit, brand: b, date, by, ans, exp, files, forms: cleanedForms(forms), bank_ver: ver[b], order: records.length });
}
console.log(`巡檢 ${records.length} 筆；營運分數 ${records.map((r) => r.exp.operationalScore).join(',')}`);

// 重送、衝突、格式
{
  const rec = pick(records.filter((r) => r.by)) || records[0];
  const again = post('inspSubmit', { id: rec.id, unit: rec.unit, date: rec.date, bank_ver: rec.bank_ver, forms: bank[rec.brand], answers: rec.ans, summary: rec.exp, files: rec.files }, rec.by ? rec.by.token : A);
  ok(again.ok && again.data.dup === true, '3d 同編號同人重送 → 回原筆（dup）', again);
  const viewer = people.find((p) => p.scope.canDo && p !== rec.by && p.scope.doUnits.includes(rec.unit));
  if (viewer) ok(post('inspSubmit', { id: rec.id, unit: rec.unit, date: rec.date, bank_ver: rec.bank_ver, forms: bank[rec.brand], answers: rec.ans, summary: rec.exp, files: [] }, viewer.token).error === 'conflict', '3e 同編號別人重送 → conflict');
  const d = pick(doers);
  const outside = STORES.map((u) => u.code).filter((u) => !d.scope.doUnits.includes(u));
  if (outside.length) ok(post('inspSubmit', { id: newId(), unit: pick(outside), date: '2026-10-01', bank_ver: '', forms: bank.mala, answers: { scores: {} }, summary: {}, files: [] }, d.token).error === 'forbidden', `3f ${d.kind} 巡不是自己範圍的店 → forbidden`);
  const nd = people.find((p) => !p.scope.canDo);
  ok(post('inspSubmit', { id: newId(), unit: STORES[0].code, date: '2026-10-01', bank_ver: '', forms: bank.mala, answers: { scores: {} }, summary: {}, files: [] }, nd.token).error === 'forbidden', `3g 不能巡的人（${nd.kind}）送出 → forbidden`);
  const u0 = d.scope.doUnits[0];
  const F = bank[unitBrand[u0]];
  const base = { unit: u0, bank_ver: '', forms: F, answers: { scores: {} }, summary: {}, files: [] };
  ok(post('inspSubmit', Object.assign({}, base, { id: newId(), date: '2026/10/01' }), d.token).error === 'bad_request', '3h 日期格式錯 → bad_request');
  ok(post('inspSubmit', Object.assign({}, base, { id: 'INS-x', date: '2026-10-01' }), d.token).error === 'bad_request', '3i 編號格式錯 → bad_request');
  ok(post('inspSubmit', Object.assign({}, base, { id: newId(), date: '2026-10-01', answers: [] }), d.token).error === 'bad_request', '3j 作答不是物件 → bad_request');
  ok(post('inspSubmit', Object.assign({}, base, { id: newId(), date: '2026-10-01', forms: [] }), d.token).error === 'bad_request', '3k 沒帶題目快照 → bad_request');
  const ph = w.filePut({ token: d.token, kind: 'receipt', mime: 'image/jpeg', b64: JPG });
  ok(post('inspSubmit', Object.assign({}, base, { id: newId(), date: '2026-10-01', files: [ph.data.id] }), A).error === 'forbidden', '3l admin 附照片 → forbidden');
  const other = doers.find((p) => p !== d);
  if (other) ok(post('inspSubmit', { id: newId(), unit: other.scope.doUnits[0], date: '2026-10-01', bank_ver: '', forms: bank[unitBrand[other.scope.doUnits[0]]], answers: { scores: {} }, summary: {}, files: [ph.data.id] }, other.token).ok === false, '3m 綁別人上傳的照片 → 擋下');
  ok(post('inspSubmit', Object.assign({}, base, { id: newId(), date: '2026-10-01', files: Array.from({ length: 61 }, (_, i) => 'F' + i) }), d.token).error === 'bad_request', '3n 照片超過 60 張 → bad_request');
}

// 可見性矩陣：每個人 × 每筆
const lst = (p, payload) => post('inspList', payload || {}, p ? p.token : A);
for (const p of people) {
  const r = lst(p);
  ok(r.ok, `3o inspList ${p.kind}/${p.title}`, r);
  const ids = sortU(r.data.items.map((x) => x.id));
  const want = sortU(records.filter((rec) => p.scope.view.includes(rec.unit)).map((rec) => rec.id));
  ok(eq(ids, want), `3p 清單只列看得到的店 ${p.kind}/${p.title}@${p.unit}（${want.length} 筆）`, { got: ids, want });
  for (const rec of records) {
    const can = p.scope.view.includes(rec.unit);
    const g = post('inspGet', { id: rec.id }, p.token);
    ok(can ? g.ok : g.error === 'not_found', `3q inspGet ${rec.id} 給 ${p.kind}@${p.unit} → ${can ? '看得到' : 'not_found'}`);
    for (const fid of rec.files) {
      const fg = w.fileGet({ token: p.token, id: fid });
      ok(can ? fg.ok : !fg.ok, `3r 照片 ${fid} 給 ${p.kind}@${p.unit} → ${can ? '看得到' : '看不到'}`, fg);
    }
  }
}
// 清單欄位與存進去的摘要、排序
{
  const r = lst(null);
  ok(r.data.items.length === records.length && r.data.more === false, '3s admin 清單筆數＝送出筆數');
  const byId = Object.fromEntries(r.data.items.map((x) => [x.id, x]));
  for (const rec of records) {
    const it = byId[rec.id];
    ok(!!it && eq(it.summary, rec.exp), `3t 清單摘要＝oracle ${rec.id}`, { got: it && it.summary, want: rec.exp });
    ok(it && it.photo_count === rec.files.length && it.unit === rec.unit && it.brand === rec.brand && it.date === rec.date && it.state === 'active' && it.inspector_name === (rec.by ? rec.by.name : '系統管理者') && it.inspector === (rec.by ? rec.by.emp : 'U:u001') && it.bank_ver === rec.bank_ver, `3u 清單欄位 ${rec.id}`, it);
  }
  const dates = r.data.items.map((x) => x.date);
  ok(eq(dates, dates.slice().sort().reverse()), '3v 清單依日期新到舊', dates);
  // 同日期：依送出時間新到舊
  const groups = {};
  r.data.items.forEach((x) => { (groups[x.date] = groups[x.date] || []).push(x.submitted_at); });
  ok(Object.values(groups).every((g) => eq(g, g.slice().sort().reverse())), '3w 同日期依送出時間新到舊');
  // 單筆：答案、題目快照
  for (const rec of records) {
    const g = post('inspGet', { id: rec.id }, A).data;
    ok(eq(g.answers, rec.ans), `3x inspGet 作答原樣 ${rec.id}`);
    ok(eq(g.forms, rec.forms), `3y inspGet 題目快照＝送出當下清洗後 ${rec.id}`, { got: g.forms && g.forms[0], want: rec.forms[0] });
    ok(eq(sortU(g.files), sortU(rec.files)), `3z inspGet 照片檔號 ${rec.id}`);
  }
  // 篩選：隨機一個人、隨機門市與月份
  const vp = pick(people.filter((p) => p.scope.view.length));
  const fu = pick(vp.scope.view);
  const ru = lst(vp, { unit: fu });
  ok(eq(sortU(ru.data.items.map((x) => x.id)), sortU(records.filter((x) => x.unit === fu).map((x) => x.id))), `3A 門市篩選 ${fu} by ${vp.kind}`);
  const months = [...new Set(records.map((x) => x.date.slice(0, 7)))];
  const fm = pick(months);
  const rm = lst(vp, { month: fm });
  ok(eq(sortU(rm.data.items.map((x) => x.id)), sortU(records.filter((x) => x.date.startsWith(fm) && vp.scope.view.includes(x.unit)).map((x) => x.id))), `3B 月份篩選 ${fm} by ${vp.kind}`);
  ok(lst(vp, { month: '2026-1' }).error === 'bad_request' && lst(vp, { month: '2020-01' }).data.items.length === 0, '3C 月份格式錯擋下、沒資料的月份空');
  const notMine = STORES.map((u) => u.code).find((u) => !vp.scope.view.includes(u));
  if (notMine) ok(lst(vp, { unit: notMine }).data.items.length === 0, `3D 篩不是自己範圍的店 → 空（${vp.kind} ${notMine}）`);
}

// ============================================================
// 4. 作廢
// ============================================================
{
  const rec = pick(records);
  const nonVoid = people.filter((p) => !p.scope.canVoid && p.scope.view.includes(rec.unit));
  if (nonVoid.length) { const p = pick(nonVoid); ok(post('inspVoid', { id: rec.id }, p.token).error === 'forbidden', `4a ${p.kind}/${p.title} 看得到但不能作廢`); }
  const voiders = people.filter((p) => p.scope.canVoid);
  const v = voiders.length && chance(0.8) ? pick(voiders) : null;
  ok(post('inspVoid', { id: rec.id }, v ? v.token : A).ok, `4b ${v ? v.kind : 'admin'} 作廢 ${rec.id}`);
  ok(post('inspVoid', { id: rec.id }, v ? v.token : A).ok, '4c 再作廢一次仍 ok（冪等）');
  ok(post('inspVoid', { id: 'INS-NOPE00-ZZZZ' }, A).error === 'not_found', '4d 作廢不存在的編號 → not_found');
  for (const p of people) {
    const sees = p.scope.view.includes(rec.unit);
    const inList = lst(p).data.items.some((x) => x.id === rec.id);
    ok(!inList, `4e 作廢後清單不列 ${p.kind}@${p.unit}`);
    const g = post('inspGet', { id: rec.id }, p.token);
    ok(sees && p.scope.canVoid ? g.ok && g.data.state === 'void' : g.error === 'not_found', `4f 作廢後 inspGet ${p.kind}@${p.unit} → ${sees && p.scope.canVoid ? '營運部仍可查（void）' : 'not_found'}`);
    const withVoid = lst(p, { include_void: true }).data.items.some((x) => x.id === rec.id);
    ok(withVoid === (sees && p.scope.canVoid), `4g include_void ${p.kind}@${p.unit} → ${sees && p.scope.canVoid}`);
    const canPhoto = sees && p.scope.canVoid;
    for (const fid of rec.files) ok(w.fileGet({ token: p.token, id: fid }).ok === canPhoto, `4h 作廢後照片 ${p.kind}@${p.unit} → ${canPhoto ? '能看作廢報告的人仍看得到' : '看不到'}`);
  }
  for (const fid of rec.files) ok(w.fileGet({ token: A, id: fid }).ok, `4h2 作廢後 admin 仍看得到照片 ${fid}`);
  const vrow = post('inspGet', { id: rec.id }, A).data;
  ok(vrow.state === 'void' && (post('inspList', { include_void: true }, A).data.items.find((x) => x.id === rec.id) || {}).state === 'void', '4i admin 看到 state=void');
  rec.void = true;
}

// ============================================================
// 5. 題目改版：舊報告快照不變、新巡檢用新題目
// ============================================================
{
  const b = pick(['mzt', 'yiwu']);
  const saver = bankers.find((p) => p.scope.bank.includes(b));
  const tok = saver ? saver.token : A;
  const f2 = JSON.parse(J(bank[b]));
  const it = f2.flatMap((f) => f.categories).flatMap((c) => c.items)[0];
  if (it) it.text = '改過的題目 ' + ri(1, 999);
  const stale = post('inspBankSave', { brand: b, forms: f2, expected_ver: 'nope' }, tok);
  ok(stale.error === 'conflict', `5a ${b} 版本號不符 → conflict`);
  const sv = post('inspBankSave', { brand: b, forms: f2, expected_ver: ver[b] }, tok);
  ok(sv.ok && sv.data.ver === b + '-v2', `5b ${b} 改版 → ${b}-v2`, sv);
  const olds = records.filter((r) => r.brand === b);
  for (const rec of olds) {
    const g = post('inspGet', { id: rec.id }, A).data;
    ok(eq(g.forms, rec.forms) && g.bank_ver === rec.bank_ver, `5c 舊報告 ${rec.id} 快照與版本不變（${rec.bank_ver}）`);
  }
  const got = bg(anyOps, b).data;
  ok(got.ver === b + '-v2' && eq(got.forms, cleanedForms(f2)), `5d ${b} 新版讀回正確`);
  bank[b] = got.forms; ver[b] = got.ver;
  const d = doers.find((p) => p.scope.doUnits.some((u) => unitBrand[u] === b));
  if (d && countItems(bank[b])) {
    const unit = d.scope.doUnits.find((u) => unitBrand[u] === b);
    const ans = randomAnswers(bank[b]);
    const exp = oracle(bank[b], ans);
    const id = newId();
    const r = post('inspSubmit', { id, unit, date: '2026-10-28', bank_ver: ver[b], forms: bank[b], answers: ans, summary: SUT.summaryOf(bank[b], ans), files: [] }, d.token);
    ok(r.ok, `5e 新版題目巡檢送出 ${unit}`);
    const g = post('inspGet', { id }, A).data;
    ok(g.bank_ver === b + '-v2' && eq(g.summary, exp) && eq(g.forms, bank[b]), `5f 新巡檢記 ${b}-v2、摘要＝oracle`, { got: g.summary, exp });
  }
}

// ============================================================
// 6. 邊界：全滿分／全零／只評一題／只勾扣分／只填加分
// ============================================================
{
  const forms = bank.mala;
  const scoredKeys = forms.flatMap((f) => f.categories.filter((c) => c.role === 'scored').flatMap((c) => c.items.map((it) => key(f, c, it))));
  const full = { scores: Object.fromEntries(scoredKeys.map((k) => [k, 5])), bonuses: {}, freeBonuses: {}, penalties: {}, reasons: {}, photos: {} };
  const o1 = oracle(forms, full), s1 = SUT.summaryOf(forms, full);
  ok(o1.operationalScore === 100 && o1.operationalGrade === 'A' && o1.managementScore === 100 && eq(s1, o1), '6a 全滿分 → 100 A（oracle＝SUT）', { o1, s1 });
  const zero = JSON.parse(J(full)); scoredKeys.forEach((k) => { zero.scores[k] = 0; });
  forms[2].categories.filter((c) => c.role === 'penalty').forEach((c) => c.items.forEach((it) => { zero.penalties[key(forms[2], c, it)] = { checked: true, note: 'x' }; }));
  const o2 = oracle(forms, zero), s2 = SUT.summaryOf(forms, zero);
  ok(o2.operationalScore === -40 && o2.operationalGrade === '未達' && o2.defects === scoredKeys.length + 4 && eq(s2, o2), '6b 全零＋四項加重扣分 → −40 未達、缺失數對（oracle＝SUT）', { o2, s2 });
  const one = { scores: { [scoredKeys[0]]: 3 }, bonuses: {}, freeBonuses: {}, penalties: {}, reasons: {}, photos: {} };
  const o3 = oracle(forms, one), s3 = SUT.summaryOf(forms, one);
  ok(o3.operationalScore === 60 && o3.operationalGrade === 'D' && o3.managementScore === null && o3.managementGrade === '未評' && eq(s3, o3), '6c 只評一題 3 分 → 60 D、經營未評（oracle＝SUT）', { o3, s3 });
  const penOnly = { scores: {}, bonuses: {}, freeBonuses: {}, penalties: { 'food.penalty.1': { checked: true, note: 'x' } }, reasons: {}, photos: {} };
  const o4 = oracle(forms, penOnly), s4 = SUT.summaryOf(forms, penOnly);
  ok(o4.operationalScore === null && o4.operationalGrade === '未評' && o4.penaltyTotal === 10 && o4.defects === 1 && eq(s4, o4), '6d 只勾加重扣分、沒評分 → 未評但扣分與缺失記下（oracle＝SUT）', { o4, s4 });
  const bonusOnly = { scores: {}, bonuses: { 'management.bonus.1': true }, freeBonuses: { 'service.bonus.4': ['a', 'b', 'c'] }, penalties: {}, reasons: {}, photos: {} };
  const o5 = oracle(forms, bonusOnly), s5 = SUT.summaryOf(forms, bonusOnly);
  ok(o5.operationalScore === null && o5.managementScore === null && eq(s5, o5), '6e 只有加分沒評分 → 兩邊都未評（加分不單獨成分）', { o5, s5 });
  const free = JSON.parse(J(full)); free.freeBonuses['service.bonus.4'] = ['a', ' ', 'b', 'c'];
  const o6 = oracle(forms, free), s6 = SUT.summaryOf(forms, free);
  const svcFull = (() => { const svc = forms[0]; let n = 0; svc.categories.filter((c) => c.role === 'scored').forEach(() => n++); return n; })();
  ok(o6.forms[0].score === 100 + 2 * 2 && eq(s6, o6) && svcFull > 0, '6f 自由填寫加分：空白不算、超過上限不算（服務 104）', { o6: o6.forms[0], s6: s6.forms[0] });
  // 每個等第都算得到：逐一構造平均分
  const want = { A: 5, B: 4.2, C: 3.6, D: 3.1, E: 2.6 };
  for (const [g, v] of Object.entries(want)) {
    const a = { scores: {}, bonuses: {}, freeBonuses: {}, penalties: {}, reasons: {}, photos: {} };
    // 只評服務表態度分類 4 題：平均 v → 分數 v/5*100
    const svc = forms[0]; const cat = svc.categories.find((c) => c.role === 'scored');
    const vals = g === 'A' ? [5, 5, 5, 5] : g === 'B' ? [5, 4, 4, 4] : g === 'C' ? [4, 4, 3, 4] : g === 'D' ? [3, 3, 3, 3] : [3, 2, 3, 2];
    cat.items.slice(0, 4).forEach((it, i) => { a.scores[key(svc, cat, it)] = vals[i]; });
    const o = oracle(forms, a), s = SUT.summaryOf(forms, a);
    ok(o.operationalGrade === g && eq(s, o), `6g 等第 ${g}（${o.operationalScore}）oracle＝SUT`, { o, s });
  }
}

// ============================================================
// 7. 沒登入／壞 token
// ============================================================
ok(post('inspMe', {}, '').error === 'unauthorized' && post('inspList', {}, 'bad-token').error === 'unauthorized' && post('inspSubmit', {}, '').error === 'unauthorized', '7a 沒登入 → unauthorized');

console.log(`\n營運巡檢資料帶入（seed ${SEED}）：${passed} 通過，${failed} 失敗；門市 ${STORES.length}、人員 ${people.length}、巡檢 ${records.length} 筆`);
if (failed) { console.error('失敗項目：\n  ' + fails.join('\n  ')); process.exit(1); }
