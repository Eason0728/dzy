/**
 * modules/staff/views/import.js — 匯入名單（docs/personnel/spec.md §6.3 staffImport／§8）
 * 貼上姓名（一行一個，照順序）→ 預覽（後端不寫入）→ 確認才建立。
 * ⚠ 名單只經這個畫面進試算表，絕不放進 repo。
 */
'use strict';

export function mountImport(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  let previewNames = null;
  el.innerHTML = `
    <div class="card stack">
      <div class="card-title">匯入同仁名單</div>
      <p class="text-muted">一行一個全名，照編號順序貼上。系統會從目前最後一號的下一號開始編。先按「預覽」核對，預覽不會寫入任何資料。</p>
      <div class="field"><label class="field-label" for="imp-names">姓名（一行一個）</label>
        <textarea class="input" id="imp-names" rows="10"></textarea></div>
      <div class="toast toast-danger" data-role="error" hidden></div>
      <div><button class="btn btn-secondary" type="button" data-role="preview">預覽</button></div>
      <div data-role="result"></div>
    </div>`;
  const ta = el.querySelector('#imp-names');
  const box = el.querySelector('[data-role="error"]');
  const out = el.querySelector('[data-role="result"]');
  const names = () => ta.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const err = (m) => { box.textContent = m || ''; box.hidden = !m; };
  ta.addEventListener('input', () => { previewNames = null; out.innerHTML = ''; });

  el.querySelector('[data-role="preview"]').addEventListener('click', async () => {
    err('');
    const list = names();
    if (!list.length) return err('請貼上至少一個姓名');
    ctx.ui.loading(true);
    let r;
    try { r = await ctx.api.call('staff', 'staffImport', { names: list, preview: true }); } finally { ctx.ui.loading(false); }
    if (!alive) return;
    if (!r.ok) return err(r.error);
    previewNames = list;
    const c = r.data.created;
    const rows = c.map((x) => `<tr><td>${esc(x.emp_no)}</td><td>${esc(x.name)}</td></tr>`).join('');
    out.innerHTML = `
      <div class="toast toast-ok">將建立 ${c.length} 位：${esc(c[0].emp_no)}＝${esc(c[0].name)}，最後 ${esc(c[c.length - 1].emp_no)}＝${esc(c[c.length - 1].name)}。核對無誤再按建立。</div>
      <div class="table-wrap"><table class="table"><thead><tr><th>編號</th><th>姓名</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div><button class="btn btn-primary" type="button" data-role="create">建立這 ${c.length} 位</button></div>`;
    out.querySelector('[data-role="create"]').addEventListener('click', async () => {
      if (!previewNames) return;
      const okGo = await ctx.ui.confirm(`確定建立 ${previewNames.length} 位同仁的編號？建立後編號不會再變。`);
      if (!okGo) return;
      ctx.ui.loading(true);
      let r2;
      try { r2 = await ctx.api.call('staff', 'staffImport', { names: previewNames }); } finally { ctx.ui.loading(false); }
      if (!alive) return;
      if (!r2.ok) return err(r2.error);
      ctx.ui.toast(`已建立 ${r2.data.created.length} 位`, 'ok');
      ta.value = '';
      previewNames = null;
      out.innerHTML = '';
      ctx.nav('list');
    });
  });
  return () => { alive = false; };
}
