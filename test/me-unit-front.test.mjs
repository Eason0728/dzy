// node test/me-unit-front.test.mjs —— 我的資料 → 單位通訊錄（生日、地址欄，Eason 2026-10-25）
// 全部假資料。後端只對門市／央廚主管回 private:true＋birthday／address；前端照 private 決定要不要畫兩欄。
'use strict';
const { esc } = await import('../platform/fmt.js');
const { mountUnit } = await import('../modules/me/views/unit.js');

let passed = 0, failed = 0;
const ok = (c, label, extra) => { if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); } };
const flush = () => new Promise((r) => setImmediate(r));
const render = async (data) => {
  const el = { innerHTML: '' };
  mountUnit(el, { fmt: { esc }, api: { call: async () => ({ ok: true, data }) } });
  await flush(); await flush();
  return el.innerHTML;
};
const cardsOf = (h) => [...h.matchAll(/<div class="card stack" data-role="unit-row" data-emp="([^"]*)">([\s\S]*?)<\/div>\s*<\/div>/g)]
  .map((m) => ({ emp: m[1], html: m[2], f: Object.fromEntries([...m[2].matchAll(/data-field="(\w+)"><span class="text-muted">[^<]*<\/span>　([^<]*)/g)].map((x) => [x[1], x[2]])) }));

const P = { emp_no: 'DZY901', name: '測試甲', title: 'pt', title_name: '計時同仁', phone: '0911000111' };
// 門市主管：每張卡有手機、生日、地址；空值顯示「—」
let h = await render({ unit_name: '測試店', private: true, people: [Object.assign({}, P, { birthday: '1995-05-05', address: '測試市<b>路</b>1號' }), Object.assign({}, P, { emp_no: 'DZY902', phone: '', birthday: '', address: '' })] });
let c = cardsOf(h);
ok(c.length === 2 && c[0].emp === 'DZY901' && c[0].html.indexOf('<b>測試甲</b>') >= 0 && c[0].html.indexOf('計時同仁・DZY901') >= 0, '門市主管：一人一張卡，姓名、職稱、編號', c);
ok(c[0].f.phone === '0911000111' && c[0].f.birthday === '1995-05-05' && c[0].f.address === '測試市&lt;b&gt;路&lt;/b&gt;1號', '手機、生日完整日期、地址（有跳脫）', c[0].f);
ok(c[1].f.phone === '—' && c[1].f.birthday === '—' && c[1].f.address === '—', '手機、生日、地址空的顯示「—」', c[1].f);
ok(h.indexOf('共 2 位已確認的同仁') >= 0 && h.indexOf('style=') === -1, '有人數、沒有內嵌樣式（spec §4.10）');
// 品牌辦公室／總部主管：沒有生日、地址兩行
h = await render({ unit_name: '測試總部', private: false, people: [P] });
c = cardsOf(h);
ok(c.length === 1 && Object.keys(c[0].f).join() === 'phone' && h.indexOf('生日') === -1 && h.indexOf('地址') === -1, '品牌辦公室／總部：只有手機', c);
// 舊後端（沒有 private 欄）→ 同上
h = await render({ unit_name: '測試店', people: [P] });
ok(cardsOf(h).length === 1 && h.indexOf('生日') === -1, '舊後端沒回 private：不顯示生日地址');
// 沒人
h = await render({ unit_name: '測試店', private: true, people: [] });
ok(cardsOf(h).length === 0 && h.indexOf('目前沒有已確認的同仁') >= 0, '沒人時顯示提示');

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
