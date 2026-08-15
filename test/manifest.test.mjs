/**
 * T1-9：模組 manifest 驗證器測試
 * 跑法：node test/manifest.test.mjs
 *
 * 重點不是「合法的會過」，而是「寫錯的會被抓出來，而且錯誤訊息指得出是哪個欄位」——
 * 一個模組安靜地不出現在首頁，是這個系統最難查的 bug。
 */
import { validateManifest, ID_RE, PERM_RE } from '../platform/manifest-check.js';

let pass = 0;
const fails = [];

function ok(cond, name) {
  if (cond) { pass++; } else { fails.push(name); }
}

/** 驗證失敗，且錯誤訊息裡要提到 needle（確保訊息指得出欄位） */
function failsWith(m, needle, name) {
  const r = validateManifest(m);
  const hit = !r.ok && r.errors.some((e) => e.includes(needle));
  if (!hit) {
    fails.push(`${name}｜ok=${r.ok} errors=${JSON.stringify(r.errors)}`);
  } else {
    pass++;
  }
}

const valid = () => ({
  id: 'audit-stock',
  ns: 'audit',
  backend: 'audit',
  name: '月初盤點抽查',
  desc: '品項抽查 20 項＋金庫抽查',
  icon: 'audit-stock',
  requires: ['audit.read', 'audit.read.own'],
  views: [
    { id: 'overview', name: '總覽', requires: ['audit.read'] },
    { id: 'fill', name: '稽核填寫', requires: ['audit.write'] },
    { id: 'my', name: '我的門市', requires: ['audit.read.own'] }
  ],
  entry: () => Promise.resolve({})
});

// ---- 合法的要過 ----
{
  const r = validateManifest(valid());
  ok(r.ok && r.errors.length === 0, `合法 manifest 應通過，實際 errors=${JSON.stringify(r.errors)}`);
}

// ---- 正規式本身 ----
ok(ID_RE.test('audit-stock'), 'ID_RE 應接受 audit-stock');
ok(!ID_RE.test('Audit'), 'ID_RE 應拒絕大寫開頭');
ok(!ID_RE.test('a'), 'ID_RE 應拒絕單一字元');
ok(!ID_RE.test('audit_stock'), 'ID_RE 應拒絕底線');
ok(PERM_RE.test('audit.read'), 'PERM_RE 應接受兩段');
ok(PERM_RE.test('audit.read.own'), 'PERM_RE 應接受三段');
ok(!PERM_RE.test('audit'), 'PERM_RE 應拒絕只有一段');
ok(!PERM_RE.test('audit.read.own.extra'), 'PERM_RE 應拒絕四段');
ok(!PERM_RE.test('Audit.read'), 'PERM_RE 應拒絕大寫');

// ---- 各欄位寫錯要被指名 ----
failsWith({ ...valid(), id: 'Audit_Stock' }, 'manifest.id', 'id 格式錯要指名 manifest.id');
failsWith({ ...valid(), ns: 'A' }, 'manifest.ns', 'ns 格式錯要指名 manifest.ns');
failsWith({ ...valid(), backend: '' }, 'manifest.backend', 'backend 空字串要指名 manifest.backend');
failsWith({ ...valid(), icon: 'ICON' }, 'manifest.icon', 'icon 格式錯要指名 manifest.icon');
failsWith({ ...valid(), name: '這是一個非常非常長的模組名稱' }, 'manifest.name', 'name 過長要指名 manifest.name');
failsWith({ ...valid(), desc: '這段說明刻意寫得超過二十個字所以應該要被驗證器擋下來才對' }, 'manifest.desc', 'desc 過長要指名 manifest.desc');
failsWith({ ...valid(), entry: 'not-a-function' }, 'manifest.entry', 'entry 非函式要指名 manifest.entry');

// ---- 缺必填欄位 ----
{
  const m = valid();
  delete m.backend;
  failsWith(m, 'manifest.backend 缺少必填欄位', '缺 backend 要明講缺少必填欄位');
}

// ---- 跨命名空間偷權限：分層邊界的實際執行點 ----
failsWith(
  { ...valid(), requires: ['dorm.write'] },
  '與 manifest.ns',
  'requires 用了別的 ns 的權限碼要被擋'
);
failsWith(
  { ...valid(), views: [{ id: 'x1', name: '測試', requires: ['dorm.read'] }] },
  '與 manifest.ns',
  'views.requires 用了別的 ns 的權限碼要被擋'
);

// ---- platform. 開頭是允許的例外 ----
{
  const r = validateManifest({ ...valid(), requires: ['platform.users'] });
  ok(r.ok, `platform. 開頭的權限碼應被允許，實際 errors=${JSON.stringify(r.errors)}`);
}

// ---- views ----
failsWith({ ...valid(), views: [] }, 'manifest.views 不能是空陣列', 'views 空陣列要被擋');
failsWith({ ...valid(), requires: [] }, 'manifest.requires 不能是空陣列', 'requires 空陣列要被擋');
failsWith(
  { ...valid(), views: [{ id: 'dup', name: '甲', requires: [] }, { id: 'dup', name: '乙', requires: [] }] },
  '與前面的分頁重複',
  'views id 重複要被擋（路由會打架）'
);
{
  const r = validateManifest({ ...valid(), views: [{ id: 'solo', name: '單頁', requires: [] }] });
  ok(r.ok, `views.requires 允許空陣列，實際 errors=${JSON.stringify(r.errors)}`);
}

// ---- 不是物件 ----
failsWith(null, 'export default', 'null manifest 要提示可能忘了 export default');

// ---- backend 必須等於 ns（2026-08-15 對抗審查：原本只警告，等於允許違規上線）----
failsWith(
  { ...valid(), ns: 'audit', backend: 'dorm' },
  '必須等於',
  'backend 與 ns 不同要是「錯誤」而不是警告——只警告等於放行，而失敗長相是「模組載入正常、只有呼叫後端才失敗」'
);
{
  const r = validateManifest({ ...valid(), ns: 'audit', backend: 'audit' });
  ok(r.ok, `backend 等於 ns 時應通過，實際 errors=${JSON.stringify(r.errors)}`);
}

// ---- 未知欄位是警告不是錯誤 ----
{
  const r = validateManifest({ ...valid(), 顏色偏好: 'red' });
  ok(r.ok, '未知欄位不該讓驗證失敗');
  ok(r.warnings.some((w) => w.includes('顏色偏好')), '未知欄位應產生警告並指名該欄位');
}

// ---- 結果 ----
if (fails.length) {
  console.error(`❌ 失敗 ${fails.length} 項：`);
  fails.forEach((f) => console.error('  · ' + f));
  process.exit(1);
}
console.log(`✅ manifest 驗證器：全部測試通過（${pass} 項）`);
