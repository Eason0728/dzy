// test/inspection.mock.test.mjs —— 營運巡檢後端（Inspect.gs）＋前端算分（modules/inspection/scoring.js）
// 誰看得到哪些店、誰能巡、照片只給看得到那筆巡檢的人、重送不變兩筆、作廢、試跑清單與 manifest。全部假資料。
'use strict';

import fs from 'node:fs';
import { buildWorld } from './e2e/inspect_backend.mjs';
import { defaultForms } from '../modules/inspection/questions.js';
import { computeAll, summaryOf, deficiencies, itemKey } from '../modules/inspection/scoring.js';
import manifest from '../modules/inspection/manifest.js';
import { validateManifest } from '../platform/manifest-check.js';
import { READ_ACTIONS } from '../platform/dryrun.js';

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

// ── 1. 算分（舊站規則）──
{
  const forms = defaultForms('mala');
  const full = { scores: {}, bonuses: {}, freeBonuses: {}, penalties: {} };
  forms.forEach((f) => f.categories.filter((c) => c.role === 'scored').forEach((c) => c.items.forEach((it) => { full.scores[itemKey(f.id, c.id, it.n)] = 5; })));
  const r = computeAll(forms, full);
  ok(r.operationalScore === 100 && r.operationalGrade === 'A' && r.managementScore === 100, '1a 全滿分 → 營運 100 A、經營 100', r);
  const pen = JSON.parse(JSON.stringify(full));
  pen.penalties['food.penalty.1'] = { checked: true, note: '過期豆干' };
  ok(computeAll(forms, pen).operationalScore === 90, '1b 加重扣分一項 → 營運 −10');
  const crit = JSON.parse(JSON.stringify(full));
  crit.scores['management.finance.1'] = 0;
  const m = computeAll(forms, crit).managementScore;
  ok(Math.abs(m - (0.4 * (30 / 35) + 0.2 + 0.4) * 100) < 0.11, '1c 重大缺失只讓該項 0 分，其餘照算', m);
  const bonus = JSON.parse(JSON.stringify(full));
  bonus.bonuses['management.bonus.1'] = true;
  ok(computeAll(forms, bonus).managementScore === 110, '1d 經營加分可超過 100（公益 +10）');
  ok(computeAll(forms, {}).operationalGrade === '未評', '1e 一題都沒評＝未評');
  const half = { scores: { 'service.attitude.1': 3 } };
  ok(computeAll(forms, half).operationalScore === 60 && deficiencies(forms, half).length === 1, '1f 只評一題 3 分 → 60 分、1 項缺失');
  const mzt = defaultForms('mzt');
  ok(mzt.length === 4 && mzt.every((f) => f.categories.length === 0), '1g 墨竹亭預設空白（四張表都沒有題目）');
  ok(defaultForms('yiwu').every((f) => f.categories.length === 0), '1h 一悟預設也空白');
  ok(JSON.stringify(defaultForms('mala')).includes('香菜') && defaultForms('mala')[2].categories.length === 5, '1i 小辛辣用舊站預設題目');
}

// ── 2. manifest、試跑清單 ──
{
  const errs = validateManifest(manifest);
  ok(!errs || (Array.isArray(errs) && errs.length === 0) || errs.ok === true, '2a manifest 驗證通過', errs);
  ok(manifest.dept === 'ops' && manifest.ns === 'platform' && manifest.backend === 'platform', '2b 掛營運部門、打平台後端');
  ok(['inspMe', 'inspList', 'inspGet', 'inspBankGet'].every((a) => READ_ACTIONS.platform.includes(a)) && !READ_ACTIONS.platform.includes('inspBankSave') && !READ_ACTIONS.platform.includes('inspSubmit') && !READ_ACTIONS.platform.includes('inspVoid') && !READ_ACTIONS.platform.includes('inspSetup'), '2c 試跑只放行三支讀取');
  const reg = fs.readFileSync(new URL('../platform/registry.js', import.meta.url), 'utf8');
  ok(reg.includes("modules/inspection/manifest.js"), '2d registry 有一列');
}

// ── 3. 後端 ──
const w = buildWorld();
const { post, people: P, sb } = w;
const A = sb.__admin;
const T = (k) => P[k].token;
const me = (k) => post('inspMe', {}, T(k));

ok(post('inspList', {}, T('ops')).error === 'not_inited', '3a 沒初始化 → not_inited');
ok(post('inspSetup', {}, T('ops')).error === 'forbidden', '3b 非 admin 不能初始化');
const setup = post('inspSetup', {}, A);
ok(setup.ok && setup.data.permAdded.length === 14, '3c admin 初始化：補 14 條預設規則（含題目設定 2 條）', setup);
ok(post('inspSetup', {}, A).data.permAdded.length === 0, '3d 再按一次不重複補');

const units = (k) => (me(k).data.stores || []).map((s) => s.unit).sort().join(',');
ok(units('ops') === 'mala-gf,mala-mc,mala-nc,mzt-gf,mzt-js,mzt-lzl,yiwu-js,yiwu-wx' && me('ops').data.can_do, '3e 營運部：全集團 8 家門市（不含停用店與央廚）、可巡', units('ops'));
ok(units('malaOsv') === 'mala-gf,mala-mc,mala-nc' && me('malaOsv').data.can_do, '3f 小辛辣督導：只有小辛辣三店、可巡', units('malaOsv'));
ok(units('malaOdir') === 'mala-gf,mala-mc,mala-nc', '3g 小辛辣總監：小辛辣三店');
ok(units('mztOsv') === 'mzt-gf,mzt-js,mzt-lzl', '3h 墨竹亭督導：墨竹亭三家啟用門市');
ok(units('mztAm') === 'mzt-gf' && me('mztAm').data.can_do, '3i 區經理：只有自己店、可巡');
ok(units('gfSm') === 'mala-gf' && !me('gfSm').data.can_do, '3j 店長：只看自己店、不能巡');
ok(units('gfPt') === '' && !me('gfPt').data.can_do, '3k 計時同仁：什麼都看不到');
ok(units('hr') === '', '3l 人資部同仁（非營運）：看不到');
ok(units('ceo').split(',').length === 8 && !me('ceo').data.can_do, '3m 執行長：看全部、預設不巡');

// 照片
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');
const ph1 = w.filePut({ token: T('malaOsv'), kind: 'receipt', mime: 'image/jpeg', b64: JPG });
const ph2 = w.filePut({ token: T('malaOsv'), kind: 'receipt', mime: 'image/jpeg', b64: JPG });
ok(ph1.ok && ph2.ok, '3n 督導上傳兩張照片', ph1);
ok(!w.fileGet({ token: T('gfSm'), id: ph1.data.id }).ok, '3o 還沒綁到巡檢前，店長看不到照片');

const forms = defaultForms('mala');
const answers = { scores: { 'service.attitude.1': 3, 'environment.facade.1': 5, 'management.finance.1': 5 }, bonuses: {}, freeBonuses: {}, penalties: {}, reasons: { 'service.attitude.1': '沒有招呼客人' }, photos: { 'service.attitude.1': [ph1.data.id, ph2.data.id] } };
const ID = 'INS-MH8ABCDE-K7Q2';
const subBody = { id: ID, unit: 'mala-gf', date: '2026-10-27', bank_ver: 'default', forms, answers, summary: summaryOf(forms, answers), files: [ph1.data.id, ph2.data.id] };

ok(post('inspSubmit', Object.assign({}, subBody, { unit: 'mzt-gf' }), T('malaOsv')).error === 'forbidden', '3p 小辛辣督導不能巡墨竹亭');
ok(post('inspSubmit', subBody, T('gfSm')).error === 'forbidden', '3q 店長不能送巡檢');
ok(post('inspSubmit', Object.assign({}, subBody, { id: 'bad' }), T('malaOsv')).error === 'bad_request', '3r 巡檢編號格式錯 → 擋');
ok(post('inspSubmit', Object.assign({}, subBody, { files: [ph1.data.id] }), T('mztAm')).error === 'forbidden', '3s 區經理不能巡別人的店');
const otherPh = w.filePut({ token: T('mztAm'), kind: 'receipt', mime: 'image/jpeg', b64: JPG });
ok(post('inspSubmit', Object.assign({}, subBody, { files: [otherPh.data.id] }), T('malaOsv')).error === 'file_invalid', '3t 不能綁別人上傳的照片');

const sub = post('inspSubmit', subBody, T('malaOsv'));
ok(sub.ok && sub.data.id === ID, '3u 督導送出一筆光復巡檢', sub);
const again = post('inspSubmit', subBody, T('malaOsv'));
ok(again.ok && again.data.dup === true, '3v 重送同一編號＝回原本那筆（不變兩筆）');
ok(post('inspSubmit', subBody, T('ops')).error === 'conflict', '3w 別人用同一編號 → conflict');

const lst = (k, p) => post('inspList', p || {}, T(k));
ok(lst('gfSm').data.items.length === 1 && lst('gfSm').data.items[0].inspector_name === '測試小辛辣督導', '3x 光復店長看得到自己店那筆（巡檢人自動帶入）');
ok(lst('mcSm').data.items.length === 0, '3y 美村店長看不到光復的巡檢');
ok(lst('mztOsv').data.items.length === 0, '3z 墨竹亭督導看不到小辛辣');
ok(lst('ops', { unit: 'mala-gf', month: '2026-10' }).data.items.length === 1 && lst('ops', { month: '2026-09' }).data.items.length === 0, '3A 營運部可篩店、篩月');
const it = lst('ops').data.items[0];
ok(it.summary.operationalScore === 80 && it.summary.defects === 1 && it.photo_count === 2 && it.unit_name === '新竹光復' && it.brand_name === '麻的小辛辣', '3B 清單帶分數、缺失數、照片數、店名', it);
const g = post('inspGet', { id: ID }, T('gfSm'));
ok(g.ok && g.data.answers.reasons['service.attitude.1'] === '沒有招呼客人' && g.data.files.length === 2, '3C 店長看得到報告細節');
ok(post('inspGet', { id: ID }, T('mcSm')).error === 'not_found', '3D 美村店長拿編號直接查也查不到');
ok(w.fileGet({ token: T('gfSm'), id: ph1.data.id }).ok, '3E 綁定後光復店長看得到照片');
ok(!w.fileGet({ token: T('mcSm'), id: ph1.data.id }).ok && !w.fileGet({ token: T('gfPt'), id: ph1.data.id }).ok, '3F 美村店長、光復計時看不到照片');
ok(w.fileGet({ token: T('ops'), id: ph2.data.id }).ok, '3G 營運部看得到照片');

// 作廢
ok(post('inspVoid', { id: ID }, T('malaOsv')).error === 'forbidden', '3H 督導不能作廢');
ok(post('inspVoid', { id: ID }, T('ops')).ok, '3I 營運部作廢');
ok(lst('gfSm').data.items.length === 0 && post('inspGet', { id: ID }, T('gfSm')).error === 'not_found', '3J 作廢後店長看不到');
ok(!w.fileGet({ token: T('gfSm'), id: ph1.data.id }).ok, '3K 作廢後店長也看不到照片');
ok(lst('ops', { include_void: true }).data.items.length === 1 && lst('ops').data.items.length === 0, '3L 營運部可另外列出已作廢');

// 題目設定：墨竹亭預設空白 → 營運部新增題目 → 區經理用新題目巡檢 → 改題目後舊報告照舊
const bg = (k, b) => post('inspBankGet', { brand: b }, T(k));
ok(bg('mztAm', 'mzt').ok && bg('mztAm', 'mzt').data.forms === null, '3M 墨竹亭還沒存過題目（前端用空白預設）');
ok(bg('gfSm', 'mzt').error === 'forbidden', '3N 小辛辣店長讀不到墨竹亭題目');
ok(me('ops').data.bank_brands.map((b) => b.brand).join() === 'mzt,mala,yiwu' && me('malaOdir').data.bank_brands.map((b) => b.brand).join() === 'mala', '3O 題目設定：營運部三個品牌、小辛辣總監只有小辛辣');
ok(me('malaOsv').data.bank_brands.length === 0 && me('mztAm').data.bank_brands.length === 0, '3P 督導、區經理不能設定題目');
const mztBank = JSON.parse(JSON.stringify(defaultForms('mzt')));
mztBank[0].categories.push({ id: 'cattitude', name: '服務態度', role: 'scored', weight: 1, items: [{ n: 1, type: 'score', text: '客人進門有招呼' }, { n: 2, type: 'critical', text: '收銀短少' }] });
mztBank[2].categories.push({ id: 'cpen', name: '加重扣分', role: 'penalty', items: [{ n: 1, type: 'penalty', points: 10, text: '叉燒過期' }] });
ok(post('inspBankSave', { brand: 'mzt', forms: mztBank, expected_ver: '' }, T('malaOdir')).error === 'forbidden', '3Q 小辛辣總監不能改墨竹亭題目');
const bad = JSON.parse(JSON.stringify(mztBank)); bad[0].categories[0].weight = 0.6;
ok(/100%/.test(post('inspBankSave', { brand: 'mzt', forms: bad, expected_ver: '' }, T('ops')).message), '3R 權重加總不是 100% → 擋');
const bad2 = JSON.parse(JSON.stringify(mztBank)); bad2[0].categories[0].items[0].text = ' ';
ok(post('inspBankSave', { brand: 'mzt', forms: bad2, expected_ver: '' }, T('ops')).error === 'bad_request', '3S 空白題目 → 擋');
const sv = post('inspBankSave', { brand: 'mzt', forms: mztBank, expected_ver: '' }, T('ops'));
ok(sv.ok && sv.data.ver === 'mzt-v1' && sv.data.total === 3, '3T 營運部存墨竹亭題目（3 題，版本 mzt-v1）', sv);
ok(post('inspBankSave', { brand: 'mzt', forms: mztBank, expected_ver: '' }, T('ops')).error === 'conflict', '3U 拿舊版本號再存 → 別人剛改過，擋下');
const got = bg('mztAm', 'mzt').data;
ok(got.ver === 'mzt-v1' && got.forms[0].categories[0].items.length === 2, '3V 區經理讀到新題目');
const mAns = { scores: { 'service.cattitude.1': 5, 'service.cattitude.2': 5 }, penalties: { 'food.cpen.1': { checked: true, note: '叉燒過期' } }, reasons: {}, photos: {}, bonuses: {}, freeBonuses: {} };
const mSub = post('inspSubmit', { id: 'INS-MH8ABCDF-M1Z9', unit: 'mzt-gf', date: '2026-10-26', bank_ver: got.ver, forms: got.forms, answers: mAns, summary: summaryOf(got.forms, mAns), files: [] }, T('mztAm'));
ok(mSub.ok, '3W 墨竹亭區經理用新題目巡自己店', mSub);
ok(lst('mztOsv').data.items[0].summary.operationalScore === 90, '3X 墨竹亭督導看得到、分數 100−10＝90');
const v2 = JSON.parse(JSON.stringify(got.forms)); v2[0].categories[0].items[0].text = '改過的題目';
ok(post('inspBankSave', { brand: 'mzt', forms: v2, expected_ver: 'mzt-v1' }, T('ops')).data.ver === 'mzt-v2', '3Y 再改一次 → mzt-v2');
const old = post('inspGet', { id: 'INS-MH8ABCDF-M1Z9' }, T('mztAm')).data;
ok(old.forms[0].categories[0].items[0].text === '客人進門有招呼' && old.bank_ver === 'mzt-v1', '3Z 舊報告存的是當時的題目（不跟著改）');
ok(post('inspSubmit', { id: 'INS-MH8ABCDF-M1ZA', unit: 'mzt-gf', date: '2026-10-26', forms: [], answers: mAns, summary: {}, files: [] }, T('mztAm')).error === 'bad_request', '3a1 送出沒帶題目 → 擋');
ok(post('inspSubmit', { id: 'INS-MH8ABCDG-A1A1', unit: 'mala-nc', date: '2026-10-26', forms, answers: mAns, summary: {}, files: [ph1.data.id] }, A).error === 'forbidden', '3O 系統管理者帳號不能附照片');
ok(post('inspSubmit', { id: 'INS-MH8ABCDG-A1A2', unit: 'mala-nc', date: '2026-10-26', forms, answers: mAns, summary: {}, files: [] }, A).ok, '3P 系統管理者可以送沒照片的巡檢');
ok(post('inspSubmit', { id: 'INS-MH8ABCDG-A1A3', unit: 'mala-nc', date: '10/26', forms, answers: mAns, summary: {}, files: [] }, A).error === 'bad_request', '3Q 日期格式錯 → 擋');
ok(post('inspList', {}, '').error === 'unauthorized', '3R 沒登入 → unauthorized');

console.log(`\n營運巡檢：${passed} 通過，${failed} 失敗`);
if (failed) process.exit(1);
