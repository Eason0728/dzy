/**
 * modules/me/views/settings.js — 我的資料 → 設定：每個功能的提醒開關（2026-11-17 Eason；docs/alert-prefs/spec.md）
 * 清單、存檔都走殼給的 ctx.alertPrefs（manifest alertSettings）：list() 只列這個人看得到、會跳提醒的功能。
 * 一按就存（跟著帳號走，手機電腦一樣）；存失敗開關退回原狀並說明。試跑模式不存。
 */
'use strict';

/** 每個功能底下那行小字：只講會跳什麼（沒列到的用 manifest.desc） */
export const ALERT_SUBS = {
  me: '有人等你審核、打卡對照；資料被退回或待確認固定開啟',
  staff: '待確認開通、變更待確認、忘記密碼鎖定',
  users: '帳號相關待辦',
  perms: '權限異動通知',
  approvals: '待你簽核、待你承辦',
  'audit-stock': '本月還沒盤點、追蹤未完成',
  'audit-ops': '營運稽核追蹤清單未完成',
  dorm: '合約快到期',
  eval: '本季要填的評核、新人考核',
  attendance: '工時沒核定、申請待審、新手機待核准',
  schedule: '班表沒排、沒送出',
  cashbook: '上個月還沒月結',
  purchase: '貨單待核對',
  pnl: '本月損益待補',
  'ai-help': '同仁問了答不出來的題目'
};

const STYLE = `
.ap-wrap{display:grid;gap:12px}
.ap-grp{padding:0;overflow:hidden}
.ap-grp h3{margin:0;padding:10px 16px 4px;font-size:var(--fs-sm);color:var(--muted);font-weight:var(--fw-medium);letter-spacing:.04em}
.ap-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-top:1px solid var(--line);cursor:pointer}
.ap-grp h3 + .ap-row{border-top:0}
.ap-tx{min-width:0;display:grid;gap:2px}
.ap-tx b{font-weight:var(--fw-medium)}
.ap-tx small{color:var(--muted);font-size:var(--fs-sm);line-height:1.45}
.ap-sw{position:relative;flex:0 0 auto;width:48px;height:28px}
.ap-sw input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.ap-sw span{position:absolute;inset:0;border-radius:14px;background:var(--muted);transition:background .15s}
.ap-sw span::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s}
.ap-sw input:checked + span{background:var(--brand)}
.ap-sw input:checked + span::after{transform:translateX(20px)}
.ap-sw input:focus-visible + span{outline:2px solid var(--brand);outline-offset:2px}
.ap-sw input:disabled{cursor:wait}
.ap-st{font-size:var(--fs-sm);color:var(--muted);min-height:1.4em}
.ap-st.err{color:var(--danger)}
@media (prefers-reduced-motion:reduce){.ap-sw span,.ap-sw span::after{transition:none}}
`;

function hhmm(s) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(s || ''));
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function mountSettings(el, ctx) {
  const esc = ctx.fmt.esc;
  let alive = true;
  const ap = ctx.alertPrefs;
  if (!ap) {
    el.innerHTML = '<div class="card"><p class="text-muted">這個版本還不支援提醒設定，請重新整理頁面。</p></div>';
    return () => { alive = false; };
  }
  el.innerHTML = '<div class="card"><p class="text-muted">讀取中…</p></div>';
  ap.list().then((items) => {
    if (!alive) return;
    if (!items.length) {
      el.innerHTML = '<div class="card"><p class="text-muted">你目前用得到的功能都不會跳提醒，沒有要設定的。</p></div>';
      return;
    }
    const groups = [];
    for (const it of items) {
      let g = groups.find((x) => x.name === it.group);
      if (!g) { g = { name: it.group, items: [] }; groups.push(g); }
      g.items.push(it);
    }
    const row = (it) => {
      const sub = ALERT_SUBS[it.id] || it.desc;
      const id = `ap-${it.id}`;
      return `<label class="ap-row" for="${id}" data-role="alert-pref" data-module="${esc(it.id)}">
        <span class="ap-tx"><b>${esc(it.name)}</b><small>${esc(sub)}</small></span>
        <span class="ap-sw"><input type="checkbox" role="switch" id="${id}" data-mod="${esc(it.id)}"${it.off ? '' : ' checked'} aria-label="${esc(it.name)}提醒"><span aria-hidden="true"></span></span>
      </label>`;
    };
    el.innerHTML = `<style>${STYLE}</style><div class="ap-wrap">
      <div class="card"><div class="card-title">提醒設定</div>
        <p class="text-muted">關掉的功能不會在首頁、待處理和側邊欄跳提醒，功能本身照常可以用。設定跟著帳號走，手機、電腦一樣。</p>
        <div class="ap-st" data-role="ap-status" aria-live="polite"></div></div>
      ${groups.map((g) => `<div class="card ap-grp"><h3>${esc(g.name)}</h3>${g.items.map(row).join('')}</div>`).join('')}
    </div>`;
    const status = el.querySelector('[data-role=ap-status]');
    const boxes = [...el.querySelectorAll('input[data-mod]')];
    let saving = Promise.resolve();
    boxes.forEach((box) => box.addEventListener('change', () => {
      saving = saving.then(async () => {
        if (!alive) return;
        const want = boxes.filter((b) => !b.checked).map((b) => b.getAttribute('data-mod'));
        box.disabled = true;
        status.className = 'ap-st';
        status.textContent = '存檔中…';
        const r = await ap.save(want);
        if (!alive) return;
        box.disabled = false;
        if (r && r.ok) {
          status.textContent = `已存檔（${hhmm(r.data && r.data.updated_at)}）`;
        } else {
          box.checked = !box.checked;   // 退回原狀
          status.className = 'ap-st err';
          status.textContent = (r && r.error) || '存檔失敗，請稍後再試';
        }
      });
    }));
  }).catch(() => {
    if (alive) el.innerHTML = '<div class="card"><p class="text-muted">讀不到功能清單，請重新整理頁面。</p></div>';
  });
  return () => { alive = false; };
}
