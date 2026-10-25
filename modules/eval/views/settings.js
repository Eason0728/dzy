/**
 * 設定（platform.eval-admin，預設人資總監）：四個品牌各自的題目、正職 KPI 範本、時薪級距、等第獎金表，加上匯入舊成績。
 * 系統還沒初始化時，role admin 會看到「初始化績效評核」按鈕（evSetup，只補不覆蓋）。
 */
'use strict';

import { btnWaiting, errText } from '../lib.js';
import { MALA_SEED } from '../seed-mala.js';

const BRANDS = [['mala', '麻的小辛辣'], ['mzt', '墨竹亭燃麵本家'], ['yiwu', '一悟燒肉'], ['ck', '中央工廠（研發部）']];
const SETS = [['pt_att', '計時同仁｜態度'], ['pt_perf', '計時同仁｜工作表現'], ['ft_att', '正職同仁｜態度']];
const TITLE_HINT = 'sm＝店長、am＝區經理、fm＝廠長、rdd＝廚藝總監、ft＝其他正職（沒有自己範本的正職都用 ft）';

export function mountSettings(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let brand = ctx.params.brand || 'mala';

  async function load() {
    el.innerHTML = '<p class="ev-note">載入中…</p>';
    const r = await ctx.api.call('eval', 'evBankGet', { brand });
    if (!alive) return;
    if (r && r.error === 'not_inited') {
      el.innerHTML = '<div class="card"><div class="card-title">績效評核還沒初始化</div><p>系統管理者按下面的按鈕，會建立評核用的資料表、四個品牌的預設時薪與等第表，並把預設權限規則補進權限設定。重按不會蓋掉資料。</p><div class="btn-row"><button type="button" class="btn btn-primary" data-role="init">初始化績效評核</button></div><p class="field-hint" data-role="msg"></p></div>';
      const b = el.querySelector('[data-role="init"]');
      b.addEventListener('click', async () => {
        const stop = btnWaiting(b, '初始化中');
        const x = await ctx.api.call('eval', 'evSetup', {});
        stop(true);
        if (!x || !x.ok) { el.querySelector('[data-role="msg"]').textContent = errText(x); return; }
        ctx.ui.toast(`已初始化；權限規則補了 ${x.data.permAdded.length} 條`, 'ok');
        load();
      });
      return;
    }
    if (!r || !r.ok) { el.innerHTML = `<div class="card"><p>${esc(errText(r))}</p></div>`; return; }
    const d = r.data;
    el.innerHTML = `<div class="card"><div class="field"><label class="field-label" for="ev-brand">品牌</label>
      <select class="input" id="ev-brand">${BRANDS.map(([k, n]) => `<option value="${k}" ${k === brand ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <p class="ev-note">每個品牌的題目、範本、時薪、等第各自獨立。改題目不會影響已送出的分數（每筆送出都存了當時的題目）。</p></div>
      ${brand === 'mala' ? '<div class="card"><div class="card-title">從舊網站搬題目</div><p class="ev-note">一鍵載入新竹光復舊評核網站現在用的三組題目、時薪級距，以及店長（sm）、正職（ft，原「儲備幹部」）兩張 KPI 範本初版。會取代小辛辣目前在這裡的題目與表；KPI 範本載入後請對照舊網站管理區核對。</p><div class="btn-row"><button type="button" class="btn btn-secondary" data-act="seed">載入小辛辣現行題目</button></div><p class="field-hint" data-role="seed-msg"></p></div>' : ''}
      ${SETS.map(([k, n]) => `<div class="card" data-role="bank" data-set="${k}"></div>`).join('')}
      <div class="card" data-role="tpl"></div>
      <div class="card" data-role="wage"></div>
      <div class="card" data-role="grade"></div>
      <div class="card" data-role="import"></div>`;
    el.querySelector('#ev-brand').addEventListener('change', (e) => { brand = e.target.value; load(); });
    const seedBtn = el.querySelector('[data-act="seed"]');
    if (seedBtn) seedBtn.addEventListener('click', async () => {
      if (!(await ctx.ui.confirm('載入舊網站的小辛辣題目、時薪級距與 KPI 範本？會取代這裡目前的小辛辣設定。'))) return;
      const stop = btnWaiting(seedBtn, '載入中');
      const calls = SETS.map(([k]) => ['evBankSave', { brand: 'mala', set: k, items: MALA_SEED[k] }])
        .concat(Object.keys(MALA_SEED.tpl).map((t) => ['evTplSave', { brand: 'mala', title: t, items: MALA_SEED.tpl[t] }]))
        .concat([['evWageSave', { brand: 'mala', rows: MALA_SEED.wage }]]);
      for (const [a2, p2] of calls) {
        const x = await ctx.api.call('eval', a2, p2);
        if (!x || !x.ok) { stop(true); el.querySelector('[data-role="seed-msg"]').textContent = '載入失敗：' + errText(x); return; }
      }
      stop(true);
      ctx.ui.toast('已載入小辛辣現行題目、時薪與 KPI 範本', 'ok');
      load();
    });
    SETS.forEach(([k, n]) => bankEditor(el.querySelector(`[data-role="bank"][data-set="${k}"]`), k, n, d.bank[k]));
    tplEditor(el.querySelector('[data-role="tpl"]'), d.tpls);
    wageEditor(el.querySelector('[data-role="wage"]'), d.wage);
    gradeEditor(el.querySelector('[data-role="grade"]'), d.grade);
    importer(el.querySelector('[data-role="import"]'));
  }

  // ── 題目 ──
  function bankEditor(box, set, title, items) {
    let list = items.map((it) => ({ key: it.key, label: it.label, levels: (it.levels || []).slice() }));
    function draw() {
      box.innerHTML = `<div class="card-title">${title}（${list.length} 題）</div>` + list.map((it, i) => `
        <details class="ev-person" data-i="${i}"><summary><span>${i + 1}. ${esc(it.label || '（新題目）')}</span><span class="ev-state">${esc(it.key)}</span></summary><div class="ev-body">
          <div class="field"><label class="field-label">題目</label><input class="input" data-f="label" maxlength="100" value="${esc(it.label)}"></div>
          ${[0, 1, 2, 3, 4].map((j) => `<div class="field"><label class="field-label">${5 - j}★ 說明</label><input class="input" data-f="lv${j}" maxlength="300" value="${esc(it.levels[j] || '')}"></div>`).join('')}
          <div class="ev-row-act"><button type="button" class="btn btn-secondary" data-act="up">上移</button><button type="button" class="btn btn-secondary" data-act="down">下移</button><button type="button" class="btn btn-danger" data-act="del">刪除這題</button></div>
        </div></details>`).join('') +
        `<div class="ev-row-act" style="margin-top:10px"><button type="button" class="btn btn-secondary" data-act="add">＋ 新增一題</button><button type="button" class="btn btn-primary" data-act="save">儲存${title}</button></div><p class="field-hint" data-role="msg"></p>`;
      box.querySelectorAll('details[data-i]').forEach((det) => {
        const i = Number(det.dataset.i);
        det.querySelector('[data-f="label"]').addEventListener('input', (e) => { list[i].label = e.target.value; });
        [0, 1, 2, 3, 4].forEach((j) => det.querySelector(`[data-f="lv${j}"]`).addEventListener('input', (e) => { list[i].levels[j] = e.target.value; }));
        det.querySelector('[data-act="up"]').addEventListener('click', () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); } });
        det.querySelector('[data-act="down"]').addEventListener('click', () => { if (i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; draw(); } });
        det.querySelector('[data-act="del"]').addEventListener('click', () => { list.splice(i, 1); draw(); });
      });
      box.querySelector('[data-act="add"]').addEventListener('click', () => {
        let n = list.length + 1; while (list.some((x) => x.key === `q${n}`)) n++;
        list.push({ key: `q${n}`, label: '', levels: ['', '', '', '', ''] }); draw();
        const last = box.querySelectorAll('details[data-i]'); last[last.length - 1].open = true;
      });
      const sb = box.querySelector('[data-act="save"]');
      sb.addEventListener('click', async () => {
        const msg = box.querySelector('[data-role="msg"]');
        if (list.some((x) => !x.label.trim() || x.levels.some((l) => !String(l || '').trim()))) { msg.textContent = '每一題都要有題目和 5 級說明。'; return; }
        if (!(await ctx.ui.confirm(`儲存 ${title}？之後送出的評分會用新題目。`))) return;
        const stop = btnWaiting(sb, '儲存中');
        const x = await ctx.api.call('eval', 'evBankSave', { brand, set, items: list.map((it) => ({ key: it.key, label: it.label.trim(), levels: it.levels.map((l) => String(l).trim()) })) });
        stop(true);
        msg.textContent = x && x.ok ? `✅ 已儲存 ${x.data.count} 題` : '儲存失敗：' + errText(x);
      });
    }
    draw();
  }

  // ── KPI 範本 ──
  function tplEditor(box, tpls) {
    const titles = Object.keys(tpls);
    let cur = titles[0] || 'sm';
    let items = (tpls[cur] || []).map((x) => Object.assign({}, x));
    function draw() {
      const total = items.reduce((s, x) => s + (Number(x.weight) || 0), 0);
      box.innerHTML = `<div class="card-title">正職 KPI 範本</div><p class="ev-note">${TITLE_HINT}。技能項依 A／B／C／D 拿比重的 100／80／60／40%；執行力項完成拿全部、未完成 0。合計要 70。</p>
        <div class="ev-grid2"><div class="field"><label class="field-label" for="ev-tpl-title">範本（職稱代碼）</label><select class="input" id="ev-tpl-title">${titles.concat(titles.indexOf(cur) === -1 ? [cur] : []).map((t) => `<option ${t === cur ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
        <div class="field"><label class="field-label" for="ev-tpl-new">新增範本</label><div class="ev-row-act"><input class="input" id="ev-tpl-new" placeholder="例如 sm" maxlength="10" style="max-width:120px"><button type="button" class="btn btn-secondary" data-act="newtpl">建立</button></div></div></div>
        <div class="table-wrap"><table class="table ev-table"><thead><tr><th>類型</th><th>項目</th><th>目標值</th><th>A／B／C／D 標準（技能項）</th><th class="num">比重</th><th></th></tr></thead><tbody>
        ${items.map((it, i) => `<tr data-i="${i}"><td><select class="input" data-f="type"><option ${it.type === '技能' ? 'selected' : ''}>技能</option><option ${it.type === '執行力' ? 'selected' : ''}>執行力</option></select></td>
          <td><input class="input" data-f="label" value="${esc(it.label)}" maxlength="200"></td><td><input class="input" data-f="target" value="${esc(it.target || '')}" maxlength="200"></td>
          <td>${['a', 'b', 'c', 'd'].map((k) => `<input class="input" data-f="${k}" placeholder="${k.toUpperCase()}" value="${esc(it[k] || '')}" maxlength="200">`).join('')}</td>
          <td><input class="input" data-f="weight" type="number" min="0" max="70" value="${Number(it.weight) || 0}" style="max-width:80px"></td><td><button type="button" class="btn btn-danger" data-act="del">刪</button></td></tr>`).join('')}
        <tr class="grand"><td colspan="4">合計</td><td class="num" data-role="total">${total}</td><td></td></tr></tbody></table></div>
        <div class="ev-row-act"><button type="button" class="btn btn-secondary" data-act="add">＋ 新增項目</button><button type="button" class="btn btn-primary" data-act="save">儲存範本 ${esc(cur)}</button></div><p class="field-hint" data-role="msg"></p>`;
      box.querySelector('#ev-tpl-title').addEventListener('change', (e) => { cur = e.target.value; items = (tpls[cur] || []).map((x) => Object.assign({}, x)); draw(); });
      box.querySelector('[data-act="newtpl"]').addEventListener('click', () => {
        const t = box.querySelector('#ev-tpl-new').value.trim().toLowerCase();
        if (!/^[a-z]{1,10}$/.test(t)) { box.querySelector('[data-role="msg"]').textContent = '職稱代碼只能用英文小寫，例如 sm、ft'; return; }
        cur = t; items = (tpls[t] || []).map((x) => Object.assign({}, x)); draw();
      });
      box.querySelectorAll('tr[data-i]').forEach((tr) => {
        const i = Number(tr.dataset.i);
        ['type', 'label', 'target', 'a', 'b', 'c', 'd', 'weight'].forEach((f) => tr.querySelector(`[data-f="${f}"]`).addEventListener('input', (e) => {
          items[i][f] = f === 'weight' ? Number(e.target.value) : e.target.value;
          if (f === 'weight') box.querySelector('[data-role="total"]').textContent = items.reduce((s, x) => s + (Number(x.weight) || 0), 0);
        }));
        tr.querySelector('[data-f="type"]').addEventListener('change', (e) => { items[i].type = e.target.value; });
        tr.querySelector('[data-act="del"]').addEventListener('click', () => { items.splice(i, 1); draw(); });
      });
      box.querySelector('[data-act="add"]').addEventListener('click', () => {
        let n = items.length + 1; while (items.some((x) => x.key === `k${n}`)) n++;
        items.push({ key: `k${n}`, type: '技能', label: '', target: '', a: '', b: '', c: '', d: '', weight: 5 }); draw();
      });
      const sb = box.querySelector('[data-act="save"]');
      sb.addEventListener('click', async () => {
        const msg = box.querySelector('[data-role="msg"]');
        const tot = items.reduce((s, x) => s + (Number(x.weight) || 0), 0);
        if (items.length && tot !== 70 && !(await ctx.ui.confirm(`比重合計是 ${tot}，不是 70。還是要儲存？`))) return;
        const stop = btnWaiting(sb, '儲存中');
        const x = await ctx.api.call('eval', 'evTplSave', { brand, title: cur, items });
        stop(true);
        if (x && x.ok) { tpls[cur] = items.map((y) => Object.assign({}, y)); if (titles.indexOf(cur) === -1) titles.push(cur); }
        msg.textContent = x && x.ok ? `✅ 已儲存（合計 ${x.data.total} 分）` : '儲存失敗：' + errText(x);
      });
    }
    draw();
  }

  // ── 時薪 ──
  function wageEditor(box, rows) {
    let list = rows.map((r) => r.slice());
    function draw() {
      box.innerHTML = `<div class="card-title">時薪級距（計時同仁看自己的分數落在哪一格）</div><p class="ev-note">分數區間寫法例：「96 分以上」「81～85 分」「65 分以下」。時薪可以寫數字或「法定時薪」。</p>
        ${list.map((r, i) => `<div class="ev-row-act" data-i="${i}" style="margin-bottom:6px"><input class="input" data-f="0" value="${esc(r[0])}" maxlength="40" aria-label="分數區間" style="max-width:200px"><input class="input" data-f="1" value="${esc(r[1])}" maxlength="20" aria-label="時薪" style="max-width:140px"><button type="button" class="btn btn-danger" data-act="del">刪</button></div>`).join('')}
        <div class="ev-row-act"><button type="button" class="btn btn-secondary" data-act="add">＋ 新增一列</button><button type="button" class="btn btn-primary" data-act="save">儲存時薪級距</button></div><p class="field-hint" data-role="msg"></p>`;
      box.querySelectorAll('[data-i]').forEach((row) => {
        const i = Number(row.dataset.i);
        row.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('input', (e) => { list[i][Number(inp.dataset.f)] = e.target.value; }));
        row.querySelector('[data-act="del"]').addEventListener('click', () => { list.splice(i, 1); draw(); });
      });
      box.querySelector('[data-act="add"]').addEventListener('click', () => { list.push(['', '']); draw(); });
      const sb = box.querySelector('[data-act="save"]');
      sb.addEventListener('click', async () => {
        const stop = btnWaiting(sb, '儲存中');
        const x = await ctx.api.call('eval', 'evWageSave', { brand, rows: list });
        stop(true);
        box.querySelector('[data-role="msg"]').textContent = x && x.ok ? '✅ 已儲存' : '儲存失敗：' + errText(x);
      });
    }
    draw();
  }

  // ── 等第 ──
  function gradeEditor(box, rows) {
    let list = rows.map((r) => ({ grade: r.grade, min: r.min, base: r.base }));
    function draw() {
      box.innerHTML = `<div class="card-title">考核等第 × 獎金發放基數（正職）</div><p class="ev-note">依實際分數（含主管加減分）判等第；最低那一列的分數要是 0。</p>
        <div class="table-wrap"><table class="table ev-table"><thead><tr><th>等第</th><th>最低分</th><th>獎金基數</th><th></th></tr></thead><tbody>
        ${list.map((r, i) => `<tr data-i="${i}"><td><input class="input" data-f="grade" value="${esc(r.grade)}" maxlength="4" style="max-width:70px"></td><td><input class="input" data-f="min" type="number" value="${r.min}" style="max-width:90px"></td><td><input class="input" data-f="base" type="number" step="0.1" value="${r.base}" style="max-width:90px"></td><td><button type="button" class="btn btn-danger" data-act="del">刪</button></td></tr>`).join('')}
        </tbody></table></div>
        <div class="ev-row-act"><button type="button" class="btn btn-secondary" data-act="add">＋ 新增一列</button><button type="button" class="btn btn-primary" data-act="save">儲存等第表</button></div><p class="field-hint" data-role="msg"></p>`;
      box.querySelectorAll('tr[data-i]').forEach((tr) => {
        const i = Number(tr.dataset.i);
        ['grade', 'min', 'base'].forEach((f) => tr.querySelector(`[data-f="${f}"]`).addEventListener('input', (e) => { list[i][f] = f === 'grade' ? e.target.value : Number(e.target.value); }));
        tr.querySelector('[data-act="del"]').addEventListener('click', () => { list.splice(i, 1); draw(); });
      });
      box.querySelector('[data-act="add"]').addEventListener('click', () => { list.push({ grade: '', min: 0, base: 0 }); draw(); });
      const sb = box.querySelector('[data-act="save"]');
      sb.addEventListener('click', async () => {
        const stop = btnWaiting(sb, '儲存中');
        const x = await ctx.api.call('eval', 'evGradeSave', { brand, rows: list });
        stop(true);
        box.querySelector('[data-role="msg"]').textContent = x && x.ok ? '✅ 已儲存' : '儲存失敗：' + errText(x);
      });
    }
    draw();
  }

  // ── 匯入舊成績（Q9 A；姓名只在瀏覽器與 Mac mini，不進程式碼）──
  function importer(box) {
    box.innerHTML = `<div class="card-title">匯入舊成績（舊評核網站）</div>
      <p class="ev-note">從舊試算表複製，每列一人一季，欄位用 Tab 分隔（直接從試算表貼上就是）：<br>季度（例 2026-Q3）｜姓名｜角色（計時／正職）｜態度｜表現（沒有就空白）｜態度調整｜表現調整｜實際分數</p>
      <textarea class="input" id="ev-imp" rows="6" aria-label="貼上舊成績"></textarea>
      <div class="btn-row"><button type="button" class="btn btn-secondary" data-act="preview">比對姓名</button></div>
      <div data-role="pv"></div>`;
    const pb = box.querySelector('[data-act="preview"]');
    pb.addEventListener('click', async () => {
      const lines = box.querySelector('#ev-imp').value.split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim())).filter((c) => c.length >= 8 && /^\d{4}-Q[1-4]$/.test(c[0]));
      const pv = box.querySelector('[data-role="pv"]');
      if (!lines.length) { pv.innerHTML = '<p class="field-hint">沒有讀到合格的列（第一欄要是 2026-Q3 這種格式，共 8 欄）。</p>'; return; }
      const names = Array.from(new Set(lines.map((c) => c[1])));
      const stop = btnWaiting(pb, '比對中');
      const x = await ctx.api.call('eval', 'evImportPreview', { unit: '', names });
      stop(true);
      if (!x || !x.ok) { pv.innerHTML = `<p class="field-hint">${esc(errText(x))}</p>`; return; }
      const hit = {};
      x.data.matches.forEach((m) => { hit[m.name] = m.hits; });
      pv.innerHTML = `<div class="table-wrap"><table class="table ev-table"><thead><tr><th>季度</th><th>姓名</th><th>對到的同仁</th><th class="num">實際分數</th></tr></thead><tbody>
        ${lines.map((c, i) => {
          const h = hit[c[1]] || [];
          const cell = !h.length ? '<span class="ev-down">找不到，這列不匯入</span>'
            : `<select class="input" data-i="${i}">${h.length > 1 ? '<option value="">同名多人，請選</option>' : ''}${h.map((p) => `<option value="${esc(p.emp)}">${esc(p.emp)}（${esc(p.unitName)}）</option>`).join('')}</select>`;
          return `<tr class="${!h.length || h.length > 1 ? 'ev-hl' : ''}"><td>${esc(c[0])}</td><td>${esc(c[1])}</td><td>${cell}</td><td class="num">${esc(c[7])}</td></tr>`;
        }).join('')}</tbody></table></div>
        <div class="btn-row"><button type="button" class="btn btn-primary" data-act="commit">確認匯入</button></div><p class="field-hint" data-role="imsg"></p>`;
      const cb = pv.querySelector('[data-act="commit"]');
      cb.addEventListener('click', async () => {
        const num = (v) => (v === '' ? null : Number(v));
        const rows = [];
        let bad = false;
        lines.forEach((c, i) => {
          const sel = pv.querySelector(`select[data-i="${i}"]`);
          if (!sel) return;
          if (!sel.value) { bad = true; return; }
          rows.push({ quarter: c[0], emp: sel.value, kind: c[2] === '正職' ? 'ft' : 'pt',
            result: { attitude: num(c[3]), performance: num(c[4]), adjAtt: num(c[5]) || 0, adjPerf: num(c[6]) || 0, total: num(c[7]) } });
        });
        const msg = pv.querySelector('[data-role="imsg"]');
        if (bad) { msg.textContent = '還有同名多人的列沒選對象。'; return; }
        if (!rows.length) { msg.textContent = '沒有可以匯入的列。'; return; }
        if (!(await ctx.ui.confirm(`匯入 ${rows.length} 筆？同一季同一人已有的舊成績會被取代。`))) return;
        const stop2 = btnWaiting(cb, '匯入中');
        const y = await ctx.api.call('eval', 'evImportCommit', { rows });
        stop2(true);
        msg.textContent = y && y.ok ? `✅ 已匯入 ${y.data.count} 筆` : '匯入失敗：' + errText(y);
      });
    });
  }

  load();
  return () => { alive = false; };
}
