// test/dd/hr_dataset.mjs —— 人資部門資料帶入測試的隨機資料集（純資料，不碰 vm）。
// 每次執行全部重抽：人數、假名、單位、職稱分布、誰是主管、到職日、互評／自評星等、KPI 評等、± 調整、宿舍房間／租期／設備單價。
// 分層抽樣：每人先抽「水準中心」（低 2／中 3～4／高 5），星等在中心附近浮動，讓等第、時薪級距、低分都出現。
'use strict';

import { makeRng, makeNamer, starsAround } from './hr_lib.mjs';

export const TODAY_FILL = '2027-01-03';      // 填寫窗內（每季第一個月 1～5 號）→ 評 2026-Q4
export const TODAY_CLOSED = '2027-01-07';    // 窗外、公布前（10 號前）
export const TODAY_PUBLISH = '2027-01-12';   // 公布後
export const QUARTER = '2026-Q4';
export const NEWBIE_SINCE = '2026-11-20';

const STORES = {
  mala: ['mala-gf'],
  mzt: ['mzt-gf', 'mzt-js', 'mzt-lzl'],
  yiwu: ['yiwu-js', 'yiwu-wx']
};
const OFFICE = { mala: 'mala-hq', mzt: 'mzt-hq', yiwu: 'yiwu-hq' };

export function buildDataset(seed) {
  const rng = makeRng(seed);
  const name = makeNamer(rng);
  const people = [];   // {key, name, brand, unit, dept, title, level, hire, ladder}
  const add = (o) => { const p = Object.assign({ dept: '', key: 'p' + (people.length + 1), name: name(), level: rng.pick([2, 3, 4, 4, 5]) }, o); people.push(p); return p; };
  const hireOld = () => '202' + rng.int(3, 5) + '-' + String(rng.int(1, 12)).padStart(2, '0') + '-' + String(rng.int(1, 28)).padStart(2, '0');
  // 新人：到職日落在 2026-11-20～2026-12-31 之間（滿月日相對 2027-01-03 有「已逾期」「剛到期」「還沒到」三種）
  const hireNew = () => rng.pick(['2026-11-2' + rng.int(0, 5), '2026-12-0' + rng.int(1, 3), '2026-12-' + rng.int(10, 31)]);

  // 門市：小辛辣光復一定有（舊站來源），墨竹亭抽 1～2 家，一悟 50% 抽 1 家；央廚 70% 有
  const stores = ['mala-gf'];
  rng.shuffle(STORES.mzt).slice(0, rng.int(1, 2)).forEach((u) => stores.push(u));
  if (rng.chance(0.5)) stores.push(rng.pick(STORES.yiwu));
  const hasCk = rng.chance(0.7);
  const brandOf = (u) => u.split('-')[0];

  const byUnit = {};
  stores.forEach((u) => {
    const b = brandOf(u);
    const list = [];
    list.push(add({ brand: b, unit: u, title: 'sm', hire: hireOld() }));
    if (rng.chance(0.4)) list.push(add({ brand: b, unit: u, title: 'am', hire: hireOld() }));
    for (let i = 0; i < rng.int(1, 3); i++) list.push(add({ brand: b, unit: u, title: 'ft', hire: rng.chance(0.25) ? hireNew() : hireOld() }));
    for (let i = 0; i < rng.int(2, 5); i++) list.push(add({ brand: b, unit: u, title: 'pt', hire: rng.chance(0.3) ? hireNew() : hireOld() }));
    byUnit[u] = list;
  });
  if (hasCk) {
    const list = [];
    list.push(add({ brand: 'ck', unit: 'ck', title: 'fm', hire: hireOld() }));
    if (rng.chance(0.6)) list.push(add({ brand: 'ck', unit: 'ck', title: 'rdd', hire: hireOld() }));
    for (let i = 0; i < rng.int(1, 2); i++) list.push(add({ brand: 'ck', unit: 'ck', title: 'ft', hire: hireOld() }));
    for (let i = 0; i < rng.int(1, 3); i++) list.push(add({ brand: 'ck', unit: 'ck', title: 'pt', hire: rng.chance(0.4) ? hireNew() : hireOld() }));
    byUnit.ck = list;
  }
  // 品牌辦公室：每個用到的品牌 1～2 位區督導、80% 有總監
  const brands = Array.from(new Set(stores.map(brandOf)));
  const offices = {};
  brands.forEach((b) => {
    const list = [];
    for (let i = 0; i < rng.int(1, 2); i++) list.push(add({ brand: b, unit: OFFICE[b], title: 'osv', hire: hireOld() }));
    if (rng.chance(0.8)) list.push(add({ brand: b, unit: OFFICE[b], title: 'odir', hire: hireOld() }));
    if (rng.chance(0.4)) list.push(add({ brand: b, unit: OFFICE[b], title: 'ofs', hire: hireOld() }));
    offices[b] = list;
  });
  // 總部：人資總監（eval-admin）、人資同仁、執行長、其他部門同仁（一般同仁，非評核對象）
  const hq = {
    hm: add({ brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hm', hire: hireOld() }),
    hs: add({ brand: 'dzy', unit: 'dzy-hq', dept: 'hr', title: 'hs', hire: hireOld() }),
    ceo: add({ brand: 'dzy', unit: 'dzy-hq', dept: 'mgmt', title: 'ceo', hire: hireOld() }),
    it: add({ brand: 'dzy', unit: 'dzy-hq', dept: rng.pick(['it', 'fin', 'marketing']), title: 'hs', hire: hireOld() })
  };
  if (rng.chance(0.5)) hq.mgmt = add({ brand: 'dzy', unit: 'dzy-hq', dept: 'mgmt', title: 'hs', hire: hireOld() });

  // 題庫：題數隨機（計時態度 4～8、計時表現 4～10、正職態度 4～8），題目文字假的
  const mkBank = (prefix, n) => Array.from({ length: n }, (_, i) => ({
    key: prefix + (i + 1), label: `${prefix.toUpperCase()}題${i + 1}：測試題目${rng.int(100, 999)}`,
    levels: ['非常好', '好', '一般', '待加強', '差'].map((s) => s + rng.int(1, 9))
  }));
  const bank = {};
  const brandsAll = brands.concat(hasCk ? ['ck'] : []);
  brandsAll.forEach((b) => {
    bank[b] = { pt_att: mkBank('a', rng.int(4, 8)), pt_perf: mkBank('p', rng.int(4, 10)), ft_att: mkBank('f', rng.int(4, 8)) };
  });
  // KPI 範本（每品牌 ft 一張；sm 另一張 60%）：技能 3～5 項＋執行力 2～4 項，比重隨機、總和不一定 70
  const mkTpl = () => {
    const items = [];
    const ns = rng.int(3, 5), ne = rng.int(2, 4);
    for (let i = 0; i < ns; i++) items.push({ key: 'k' + (i + 1), type: '技能', label: '技能項' + (i + 1), target: '目標' + rng.int(1, 99), a: 'A級', b: 'B級', c: 'C級', d: 'D級', weight: rng.pick([5, 7.5, 10, 12.5, 15]) });
    for (let i = 0; i < ne; i++) items.push({ key: 'e' + (i + 1), type: '執行力', label: '交辦' + (i + 1), target: '', a: '', b: '', c: '', d: '', weight: rng.pick([2.5, 5, 7.5, 10]) });
    return items;
  };
  const tpl = {};
  brandsAll.forEach((b) => { tpl[b] = { ft: mkTpl() }; if (rng.chance(0.6)) tpl[b].sm = mkTpl(); });
  // 等第表（每品牌亂抽門檻）＋時薪級距（8 列，門檻遞減）
  const grade = {};
  const wage = {};
  brandsAll.forEach((b) => {
    const a = rng.int(82, 90), c = rng.int(60, 68), bb = rng.int(c + 5, a - 5);
    grade[b] = [{ grade: 'A', min: a, base: 1 }, { grade: 'B', min: bb, base: rng.pick([0.6, 0.7, 0.8]) }, { grade: 'C', min: c, base: 0.5 }, { grade: 'D', min: 0, base: 0 }];
    let top = rng.int(93, 97);
    const rows = [[`${top} 分以上`, String(rng.int(300, 360))]];
    for (let i = 0; i < 6; i++) { const lo = top - 5; rows.push([`${lo}～${top - 1} 分`, String(rng.int(200, 300))]); top = lo; }
    rows.push([`${top - 1} 分以下`, '法定時薪']);
    wage[b] = rows;
  });

  // 互評：每店每位 evaluable 同仁有 70% 機率送出（有人沒送＝填寫進度看得到誰沒填）；
  //   留兩位「UI 填寫」的人（一位計時、一位店長）不預先送，由 Playwright 自己填。
  const evaluable = people.filter((p) => byUnit[p.unit]);
  const uiPt = byUnit['mala-gf'].find((p) => p.title === 'pt');
  const uiSm = byUnit['mala-gf'].find((p) => p.title === 'sm');
  const kindOf = (p) => (p.title === 'pt' ? 'pt' : 'ft');
  const peer = [];   // {rater, ratee, att[], perf[]}
  const self = [];   // {emp, att, perf, note, company, peers:[{to,msg,anon}]}
  // 強迫出現「只有一位同事評」與「沒人評」：每店挑一位 pt 當 fewTarget（只有一位評）、一位當 noneTarget（沒人評）
  const special = {};
  Object.keys(byUnit).forEach((u) => {
    const pts = rng.shuffle(byUnit[u].filter((p) => p.title === 'pt' && p !== uiPt));
    if (pts[0]) special[pts[0].key] = 'few';
    if (pts[1]) special[pts[1].key] = 'none';
  });
  Object.keys(byUnit).forEach((u) => {
    const list = byUnit[u];
    const raters = list.filter((p) => p !== uiPt && p !== uiSm && rng.chance(0.7));
    const fewGiven = {};
    raters.forEach((r) => {
      const ratings = [];
      list.filter((p) => p !== r).forEach((p) => {
        if (special[p.key] === 'none') return;
        if (special[p.key] === 'few') { if (fewGiven[p.key]) return; fewGiven[p.key] = true; }
        const k = kindOf(p);
        const bk = bank[p.brand];
        ratings.push({ ratee: p.key, att: starsAround(rng, p.level, (k === 'pt' ? bk.pt_att : bk.ft_att).length), perf: k === 'pt' ? starsAround(rng, p.level, bk.pt_perf.length) : [] });
      });
      if (ratings.length) peer.push({ rater: r.key, ratings });
    });
    list.filter((p) => p !== uiPt && p !== uiSm && rng.chance(0.6)).forEach((p) => {
      const k = kindOf(p), bk = bank[p.brand];
      const peersInUnit = list.filter((x) => x !== p);
      self.push({ emp: p.key, att: starsAround(rng, p.level, (k === 'pt' ? bk.pt_att : bk.ft_att).length), perf: k === 'pt' ? starsAround(rng, p.level, bk.pt_perf.length) : [],
        note: rng.chance(0.7) ? '給自己：測試留言' + rng.int(1, 99) : '', company: rng.chance(0.4) ? '給公司：測試建議' + rng.int(1, 99) : '',
        peers: rng.chance(0.5) && peersInUnit.length ? [{ to: rng.pick(peersInUnit).key, msg: '夥伴留言' + rng.int(1, 99), anon: rng.chance(0.6) }] : [] });
    });
  });
  // 主管 KPI／調整：每店店長對本店正職（ft、am 不含自己）；央廚廠長對 ft。60% 評完、20% 評一半、20% 不評；調整 ±
  const sup = [];   // {by, emp, kpi:{key:{sel,actual}}, adj_att, adj_perf, adj_reason, feedback, tpl_title?}
  Object.keys(byUnit).forEach((u) => {
    const list = byUnit[u];
    const head = list.find((p) => p.title === 'sm' || p.title === 'fm');
    if (!head || head === uiSm) return;
    list.filter((p) => p !== head && kindOf(p) === 'ft' && (p.title === 'ft')).forEach((p) => {
      const items = tpl[p.brand].ft;
      const mode = rng.pick(['full', 'full', 'full', 'half', 'none']);
      const kpi = {};
      items.forEach((it, i) => {
        if (mode === 'none' || (mode === 'half' && i % 2 === 1)) return;
        const sel = it.type === '執行力' ? rng.pick(['完成', '未完成']) : rng.pick(['A', 'B', 'C', 'D']);
        kpi[it.key] = { sel, actual: '實際' + rng.int(1, 99) };
      });
      const o = { by: head.key, emp: p.key, kpi, adj_att: rng.chance(0.4) ? rng.pick([-2, -1, 1, 2, 3]) : 0, adj_perf: rng.chance(0.4) ? rng.pick([-5, -3, 2, 5]) : 0, adj_reason: '調整原因' + rng.int(1, 9), feedback: rng.chance(0.6) ? '主管回饋' + rng.int(1, 99) : '' };
      sup.push(o);
    });
    // 計時：店長只給調整與回饋（不打 KPI）
    list.filter((p) => p !== head && p.title === 'pt' && rng.chance(0.3)).forEach((p) => {
      sup.push({ by: head.key, emp: p.key, adj_att: rng.pick([-1, 1, 2]), adj_perf: rng.pick([-3, 0, 3]), adj_reason: '計時調整', feedback: rng.chance(0.5) ? '計時回饋' + rng.int(1, 9) : '' });
    });
  });
  // 新人考核：已到期的新人裡 40% 預先考核（其餘留給 UI／清單）
  const newbie = [];
  // 到職滿一個月＝下個月同一日（沒有那天取月底）；只有已到期（dueOn ≤ 今天）的人才能預先考核
  const dueOn = (hire) => { const [y, m, d] = hire.split('-').map(Number); const y2 = m === 12 ? y + 1 : y, m2 = m === 12 ? 1 : m + 1; const last = new Date(Date.UTC(y2, m2, 0)).getUTCDate(); return `${y2}-${String(m2).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`; };
  evaluable.filter((p) => p.hire >= NEWBIE_SINCE && dueOn(p.hire) <= TODAY_FILL).forEach((p) => {
    const head = byUnit[p.unit].find((x) => (x.title === 'sm' || x.title === 'fm') && x !== p);
    if (!head || head === uiSm) return;
    if (rng.chance(0.4)) newbie.push({ by: head.key, emp: p.key, att: starsAround(rng, p.level, bank[p.brand].pt_att.length), perf: starsAround(rng, p.level, bank[p.brand].pt_perf.length) });
  });
  // 舊成績匯入（2026-Q3，小辛辣光復）：抽 1～3 人
  const hist = rng.shuffle(byUnit['mala-gf']).slice(0, rng.int(1, 3)).map((p) => {
    const k = kindOf(p);
    const att = k === 'pt' ? rng.int(14, 30) : Math.round(rng.int(14, 30) * 1.2 * 10) / 10;
    const perf = rng.int(30, 70);
    const adjAtt = rng.pick([0, 0, 1, -1]), adjPerf = rng.pick([0, 0, 2, -2]);
    const total = Math.min(100, Math.round((att + perf + adjAtt + adjPerf) * 10) / 10);
    return { emp: p.key, kind: k, result: { attitude: att, performance: perf, adjAtt, adjPerf, total } };
  });

  // 宿舍：房間 3～5 間（型別隨機）、設備 5～8 項（單價隨機）、清潔費隨機、租金表隨機；合約 2～4 份
  const roomTypes = ['單人房', '雙人房', '四人房'];
  const bedsOf = { '單人房': [], '雙人房': ['A床', 'B床'], '四人房': ['1號床位', '2號床位', '3號床位', '4號床位'] };
  const rooms = [];
  for (let i = 0; i < rng.int(3, 5); i++) { const t = rng.pick(roomTypes); rooms.push({ room: `${rng.int(2, 5)}樓${i + 1}號房`, type: t, beds: bedsOf[t] }); }
  const equip = ['書桌', '椅子', '床架', '床墊', '衣櫃', '房間鑰匙', '大門遙控器', '檯燈'].slice(0, rng.int(5, 8)).map((it) => ({ item: it, price: rng.pick([300, 500, 800, 1200, 1500, 2500]) }));
  const dorm = {
    rooms, equip, cleaning_fee: rng.pick([600, 800, 1000, 1200]),
    rent: { '單人房': rng.pick([3200, 3500, 3800]), '雙人房': rng.pick([1800, 2000, 2200]), '四人房': rng.pick([1300, 1500, 1600]) },
    share_single: rng.pick([1600, 1750, 1900]), term_months: 6,
    contracts: []
  };
  const dormNames = rng.shuffle(evaluable).slice(0, rng.int(2, 4));
  dormNames.forEach((p, i) => {
    const r = rng.pick(rooms);
    const mo = rng.int(1, 12);
    const lastDay = new Date(Date.UTC(2026, mo, 0)).getUTCDate();
    const dayPick = rng.pick([1, 15, 28, 29, 30, 31, lastDay]);
    const start = `2026-${String(mo).padStart(2, '0')}-${String(Math.min(dayPick, lastDay)).padStart(2, '0')}`;
    dorm.contracts.push({ name: p.name, room: r.room, bed: r.beds.length ? rng.pick(r.beds) : '', occupancy: r.type === '單人房' ? rng.pick(['自住', '合租']) : '', term_start: start,
      handover: equip.map((e) => ({ item: e.item, normal: rng.chance(0.7), returned: rng.chance(0.8) })), need_cleaning: rng.chance(0.5) });
  });

  return { seed, people, byUnit, offices, hq, stores, hasCk, bank, tpl, grade, wage, peer, self, sup, newbie, hist, dorm, uiPt: uiPt.key, uiSm: uiSm.key, special, kindOf: undefined };
}
