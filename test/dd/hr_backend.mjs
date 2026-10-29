// test/dd/hr_backend.mjs —— 人資部門資料帶入測試的本機後端：真的 apps-script/platform .gs 載進 vm，
// 用 hr_dataset.mjs 的隨機資料（E2E_SEED 可重現）種同仁、題庫、互評、自評、KPI、新人考核、舊成績，
// 包成 http://127.0.0.1:<PORT>/platform/api；/platform/proxy 的 ns=dorm 由這裡的有狀態假宿舍後端接
//（房間、租金、設備單價都來自資料集，不寫死）。只聽 127.0.0.1、全部假名、不碰任何正式後端。
//   GET /__today?d=YYYY-MM-DD  改「今天」　GET /__seed  資料集＋編號對照（Python 拿去自己算預期值）
//   GET /__dorm  宿舍假後端狀態　GET /__sheet?name=  原始分頁（除錯）
// 環境變數：PORT（9140～9159）、E2E_SEED、TODAY（預設填寫窗 2027-01-03）、PRESEED=0 不預先送互評（全部留給 UI）
'use strict';

import http from 'node:http';
import { freshApp, activate, loginAs, post, setHireDate, seedFromEnv } from './hr_lib.mjs';
import { buildDataset, TODAY_FILL } from './hr_dataset.mjs';

export function buildBackend(seed, opts) {
  opts = opts || {};
  const ds = buildDataset(seed);
  const app = freshApp();
  const sb = app.sb;
  const emps = {};     // key → emp_no
  const keyOf = {};    // emp_no → key
  const tokens = {};   // key → token（懶登入）
  ds.people.forEach((p) => {
    const emp = activate(app, p.name, { brand: p.brand, unit: p.unit, dept: p.dept, title: p.title });
    emps[p.key] = emp; keyOf[emp] = p.key;
    setHireDate(app, emp, p.hire);
  });
  // 未認領、待審、待確認變更、被鎖、停用各一位（同仁名單篩選要能看到每一種）
  const extra = {};
  {
    const n = (s) => s + String(seed % 1000).padStart(3, '0');
    post(sb, 'staffImport', { names: [n('假未領'), n('假待審')] }, app.admin);
    const lk = (nm) => post(sb, 'claimLookup', { name: nm }).data.emp_no;
    extra.unclaimed = lk(n('假未領'));
    const pend = lk(n('假待審'));
    post(sb, 'claimSubmit', { name: n('假待審'), emp_no: pend, password: 'fake-staff-pw-1', brand: 'mala', unit: 'mala-gf', dept: '', title: 'pt', birthday: '1995-05-05', phone: '0933000001', address: '測試市待審路 1 號' });
    extra.pending = pend;
    const lockEmp = activate(app, n('假被鎖'), { brand: 'mzt', unit: ds.stores.find((u) => u.startsWith('mzt')), title: 'pt' });
    for (let i = 0; i < 6; i++) post(sb, 'forgotReset', { emp_no: lockEmp, birthday: '1999-09-09', phone: '0900000000', new_password: 'fake-new-pw-1234' });
    extra.locked = lockEmp;
    const dis = activate(app, n('假停用'), { brand: 'mala', unit: 'mala-gf', title: 'pt' });
    post(sb, 'staffSetActive', { emp_no: dis, active: false }, app.admin);
    extra.disabled = dis;
  }
  post(sb, 'permInit', {}, app.admin);
  app.props.PERMS_ON = '1';
  let today = '2026-12-20';   // 先在窗外建題
  sb.evToday_ = () => today;
  const A = app.admin;
  const setupRes = post(sb, 'evSetup', {}, A);
  if (!setupRes.ok) throw new Error('evSetup ' + setupRes.error);
  const must = (r, what) => { if (!r || !r.ok) throw new Error(what + ' 失敗：' + JSON.stringify(r).slice(0, 200)); return r; };
  const hmTok = loginAs(app, emps[ds.hq.hm.key]);   // 人資總監＝eval-admin
  Object.keys(ds.bank).forEach((b) => {
    ['pt_att', 'pt_perf', 'ft_att'].forEach((set) => must(post(sb, 'evBankSave', { brand: b, set, items: ds.bank[b][set] }, hmTok), 'evBankSave ' + b + set));
    Object.keys(ds.tpl[b]).forEach((t) => must(post(sb, 'evTplSave', { brand: b, title: t, items: ds.tpl[b][t] }, hmTok), 'evTplSave'));
    must(post(sb, 'evGradeSave', { brand: b, rows: ds.grade[b] }, hmTok), 'evGradeSave');
    must(post(sb, 'evWageSave', { brand: b, rows: ds.wage[b] }, hmTok), 'evWageSave');
  });
  // 舊成績匯入
  must(post(sb, 'evImportCommit', { rows: ds.hist.map((h) => ({ quarter: '2026-Q3', emp: emps[h.emp], kind: h.kind, result: h.result })) }, hmTok), 'evImportCommit');

  today = opts.today || process.env.TODAY || TODAY_FILL;
  const tok = (key) => (tokens[key] = tokens[key] || loginAs(app, emps[key]));
  const applied = { peer: [], self: [], sup: [], newbie: [] };
  if (process.env.PRESEED !== '0') {
    ds.peer.forEach((r) => {
      const res = post(sb, 'evPeerSubmit', { ratings: r.ratings.map((x) => ({ ratee: emps[x.ratee], att: x.att, perf: x.perf })) }, tok(r.rater));
      applied.peer.push({ rater: r.rater, ok: res.ok, error: res.error });
    });
    ds.self.forEach((s) => {
      const res = post(sb, 'evSelfSubmit', { att: s.att, perf: s.perf, note: s.note, company: s.company, peers: s.peers.map((m) => ({ to: emps[m.to], msg: m.msg, anon: m.anon })) }, tok(s.emp));
      applied.self.push({ emp: s.emp, ok: res.ok, error: res.error });
    });
    ds.sup.forEach((s) => {
      const payload = { emp: emps[s.emp], quarter: '2026-Q4', adj_att: s.adj_att, adj_perf: s.adj_perf, adj_reason: s.adj_reason, feedback: s.feedback };
      if (s.kpi) payload.kpi = s.kpi;
      const res = post(sb, 'evSupSave', payload, tok(s.by));
      applied.sup.push({ emp: s.emp, ok: res.ok, error: res.error });
    });
    ds.newbie.forEach((n) => {
      const res = post(sb, 'evNewbieSubmit', { emp: emps[n.emp], att: n.att, perf: n.perf }, tok(n.by));
      applied.newbie.push({ emp: n.emp, ok: res.ok, error: res.error, data: res.data });
    });
  }

  // ── 宿舍假後端（有狀態；規則照 docs：租期 6 個月同日 −1 天、沒有那天取月底；租金依房型／單人房合租；賠償＝異常且未歸還的設備單價＋清潔費）──
  const dorm = { contracts: {}, signTokens: {}, handTokens: {}, seq: 0, calls: [] };
  const D = ds.dorm;
  const termEnd = (start) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start);
    if (!m) return '';
    let y = +m[1], mo = +m[2] - 1 + D.term_months, d = +m[3];
    y += Math.floor(mo / 12); mo = mo % 12;
    const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const dt = d > last ? new Date(Date.UTC(y, mo, last)) : new Date(Date.UTC(y, mo, d - 1));
    return dt.toISOString().slice(0, 10);
  };
  const rentOf = (roomName, occ) => {
    const r = D.rooms.find((x) => x.room === roomName);
    if (!r) return 0;
    if (r.type === '單人房' && occ === '合租') return D.share_single;
    return D.rent[r.type];
  };
  const dormDispatch = (action, body) => {
    dorm.calls.push(action);
    if (action === 'rooms') return { ok: true, rooms: D.rooms, equip: D.equip.map((e) => e.item) };
    if (action === 'list') return { ok: true, contracts: Object.values(dorm.contracts) };
    if (action === 'create') {
      const room = D.rooms.find((x) => x.room === body.room);
      if (!room) return { ok: false, error: '房間不存在' };
      if (room.beds.length && room.beds.indexOf(body.bed) === -1) return { ok: false, error: '請選床位' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.term_start || ''))) return { ok: false, error: '起日格式錯誤' };
      if (!String(body.name || '').trim()) return { ok: false, error: '請填姓名' };
      const dup = Object.values(dorm.contracts).some((c) => c.room === body.room && c.bed === (body.bed || '') && c.status === '在住');
      if (dup && body.force !== true) return { ok: true, data: { warn: '床位重複' }, warn: '床位重複' };
      dorm.seq++;
      const cid = 'DD-C' + String(dorm.seq).padStart(3, '0');
      const token = 'dd-sign-' + dorm.seq;
      const rent = rentOf(body.room, body.occupancy);
      const row = { contract_id: cid, name: body.name, room: body.room, bed: body.bed || '', room_bed_display: (body.room + ' ' + (body.bed || '')).trim(),
        rent, term_start: body.term_start, term_end: termEnd(body.term_start), term_no: 1, status: '待簽', terminate_flag: '', signed_at: '', md: '',
        occupancy: body.occupancy || '', fee_mgmt: body.fee_mgmt, fee_water: body.fee_water, fee_power: body.fee_power };
      dorm.contracts[cid] = row;
      dorm.signTokens[token] = cid;
      return { ok: true, contract_id: cid, token, rent, term_start: row.term_start, term_end: row.term_end, sign_url: 'http://127.0.0.1:' + PORT + '/sign.html?t=' + token };
    }
    if (action === 'sign') {
      const cid = dorm.signTokens[body.token]; if (!cid) return { ok: false, error: '連結無效' };
      const c = dorm.contracts[cid]; if (c.status === '在住') return { ok: false, error: '這份合約已完成簽署' };
      c.status = '在住'; c.signed_at = today + ' 10:00'; return { ok: true, pdf_url: '' };
    }
    if (action === 'terminate') {
      const c = dorm.contracts[body.contract_id]; if (!c) return { ok: false, error: '找不到合約' };
      c.terminate_flag = c.terminate_flag ? '' : '已標記終止'; return { ok: true };
    }
    if (action === 'handoverCreate') {
      const cid = body.contract_id; if (!dorm.contracts[cid]) return { ok: false, error: '找不到合約' };
      for (const [t, h] of Object.entries(dorm.handTokens)) if (h.contract_id === cid && !h.signed) return { ok: true, token: t, reused: true };
      const t = 'dd-hand-' + (Object.keys(dorm.handTokens).length + 1);
      dorm.handTokens[t] = { contract_id: cid, signed: false }; return { ok: true, token: t };
    }
    if (action === 'handover') {
      const h = dorm.handTokens[body.token]; if (!h) return { ok: false, error: '點交單連結無效' };
      if (h.signed) return { ok: true, state: 'signed', handover: { signed_at: h.signed_at, compensation_total: h.total } };
      return { ok: true, state: 'pending', equip: D.equip, cleaning_fee: D.cleaning_fee };
    }
    if (action === 'handoverSign') {
      const h = dorm.handTokens[body.token]; if (!h) return { ok: false, error: '點交單連結無效' };
      if (h.signed) return { ok: false, error: '已點交' };
      const items = body.items || [];
      if (items.length !== D.equip.length) return { ok: false, error: '設備項目不完整' };
      let total = 0;
      items.forEach((it) => { const e = D.equip.find((x) => x.item === it.item); if (e && it.normal === false && it.returned === false) total += e.price; });
      if (body.need_cleaning) total += D.cleaning_fee;
      h.signed = true; h.total = total; h.signed_at = today + ' 10:30'; h.items = items; h.need_cleaning = !!body.need_cleaning;
      dorm.contracts[h.contract_id].status = '已退宿';
      return { ok: true, compensation_total: total, pdf_url: '' };
    }
    if (action === 'handoverPdf') {
      const h = dorm.handTokens[body.token]; if (!h || !h.signed) return { ok: false, error: '這張點交單還沒完成，沒有 PDF' };
      return { ok: true, name: today + '_假同仁_設備點交.pdf', mime: 'application/pdf', pdf_b64: Buffer.from('%PDF-1.4 dd fake').toString('base64') };
    }
    return { ok: false, error: '未知的 dorm action：' + action };
  };
  const DORM_READ = ['rooms', 'list', 'contract', 'handover'];
  const proxy = (body) => {
    const hasSecret = (o) => o && typeof o === 'object' && ('code' in o || 'pass' in o);
    if (hasSecret(body) || hasSecret(body.payload)) { dorm.leaked = (dorm.leaked || 0) + 1; return [400, { ok: false, error: 'BAD_REQUEST' }]; }
    const ns = body.ns, action = body.action;
    const me = post(sb, 'me', {}, body.token || '');
    if (!body.token || !me.ok) return [401, { ok: false, error: '登入已失效', code: 'BAD_TOKEN' }];
    const perms = me.data.perms || [];
    const has = (p) => perms.indexOf('*') !== -1 || perms.indexOf(p) !== -1;
    if (ns !== 'dorm') return [200, { ok: false, error: 'dd-hr 測試後端只代轉 dorm' }];
    const isWrite = DORM_READ.indexOf(action) === -1;
    const allowed = isWrite ? has('dorm.write') : (has('dorm.write') || has('dorm.read'));
    if (!allowed) return [403, { ok: false, error: '沒有權限', code: 'FORBIDDEN' }];
    return [200, dormDispatch(action, Object.assign({}, body.payload || {}))];
  };

  const PORT = Number(process.env.PORT || 9140);
  const accounts = Object.fromEntries(Object.entries(emps));
  const seedDump = () => ({ seed, dataset: ds, emps, keyOf, extra, today, applied, admin: { username: 'BOSS', password: 'fake-admin-pw-01' }, dormMgr: { username: 'dormmgr', password: 'fake-mgr-pw-01' }, staffPw: 'fake-staff-pw-1' });
  return {
    app, sb, ds, emps, keyOf, extra, tok, applied, dorm, proxy, seedDump,
    get today() { return today; }, set today(v) { today = v; },
    serve() {
      return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
          const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS' };
          if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => {
            const json = (code, o) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, cors)); res.end(JSON.stringify(o)); };
            const u = new URL(req.url, 'http://x');
            if (u.pathname === '/__today') { today = u.searchParams.get('d') || today; res.writeHead(200, cors); return res.end(today); }
            if (u.pathname === '/__seed') return json(200, seedDump());
            if (u.pathname === '/__dorm') return json(200, dorm);
            if (u.pathname === '/__sheet') { const sh = app.sheets[u.searchParams.get('name')]; return json(200, sh ? sh._rows() : null); }
            if (u.pathname.startsWith('/platform/proxy')) {
              let b = {}; try { b = JSON.parse(body || '{}'); } catch (e) { return json(400, { ok: false, error: 'bad json' }); }
              const [code, out] = proxy(b); return json(code, out);
            }
            let out;
            try { out = sb.doPost({ postData: { contents: body } }).getContent(); } catch (e) { out = JSON.stringify({ ok: false, error: String(e) }); }
            res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
            res.end(out);
          });
        });
        srv.listen(PORT, '127.0.0.1', () => {
          console.log('SEED ' + seed);
          console.log('ACCOUNTS ' + JSON.stringify(accounts));
          console.log('dd-hr 測試後端 http://127.0.0.1:' + PORT + '/platform/api  今天＝' + today);
          resolve(srv);
        });
      });
    }
  };
}

if (process.argv[1] && process.argv[1].endsWith('hr_backend.mjs')) {
  const seed = seedFromEnv();
  const be = buildBackend(seed);
  const bad = [].concat(be.applied.peer, be.applied.self, be.applied.sup, be.applied.newbie).filter((x) => !x.ok);
  if (bad.length) console.log('PRESEED_ERRORS ' + JSON.stringify(bad));
  await be.serve();
}
