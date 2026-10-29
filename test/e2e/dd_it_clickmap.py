# -*- coding: utf-8 -*-
"""按鈕與連結的覆蓋稽核（抄自 ~/Desktop/Claude/系統/績效評鑑/績效評核系統/e2e/clickmap.py，加 root 限定範圍）。

每進到一個畫面就把當下 root 範圍內的可點元素全部登記，點過的登記為已測，
最後把「登記過但沒被點過」的印出來，漏一顆就報失敗。

key 的規則（KEY_JS 與 SCAN_JS 共用同一段邏輯，不可分岔，否則會誤報漏測）：
  有 id → #id；有 data-act → tag[data-act=…]（搭配 data-perm／data-key 不帶，否則每個身分都成新 key）；
  有 data-nav → [data-nav=…]；有 data-action → [data-action=…]；有 data-role → [data-role=…]；
  下拉與輸入 → tag+class；其他 → tag「前 24 字」。
"""

_KEY_LOGIC = """
  if (e.id) return '#' + e.id;
  const ds = e.dataset || {};
  if (ds.act) return e.tagName.toLowerCase() + '[data-act=' + ds.act + ']';
  if (ds.nav) return '[data-nav=' + ds.nav + ']';
  if (ds.navDept) return '[data-nav-dept=' + ds.navDept + ']';
  if (ds.view) return '[data-view=' + ds.view + ']';
  if (ds.action) return '[data-action=' + ds.action + ']';
  if (ds.role) return e.tagName.toLowerCase() + '[data-role=' + ds.role + ']';
  const cls = (typeof e.className === 'string' && e.className.trim())
    ? '.' + e.className.trim().split(/\\s+/)[0] : '';
  if (e.tagName === 'SELECT' || e.tagName === 'INPUT') return e.tagName.toLowerCase() + cls;
  const txt = (e.textContent || e.value || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
  return e.tagName.toLowerCase() + '「' + txt + '」';
"""

KEY_JS = """
(e) => {
  if (!e) return null;
  const keyOf = (e) => {%s};
  return keyOf(e);
}
""" % _KEY_LOGIC

SCAN_JS = """
(roots) => {
  const keyOf = (e) => {%s};
  const sel = 'button, a[href], summary, input[type=checkbox], select';
  const out = [];
  for (const r of roots) {
    for (const host of document.querySelectorAll(r)) {
      for (const e of host.querySelectorAll(sel)) {
        if (e.offsetParent !== null || e.tagName === 'SUMMARY') out.push(keyOf(e));
      }
    }
  }
  return out;
}
""" % _KEY_LOGIC

# 預設掃描範圍：內容區、分頁列、側邊欄使用者區（改密碼／登出）、登入前畫面、對話框
DEFAULT_ROOTS = ['[data-role="view-content"]', '[data-role="view-nav"]', '.side-user', '[data-role="login-root"]', '.dialog-overlay', '.dialog']

# 刻意不點、附理由（會列在報告裡，不算漏測）
SKIP = {
    'a[data-role=line-reset]': '外網 liff.line.me 連結：只驗 href，不點（外網守門）',
}


class ClickMap:
    def __init__(self):
        self.seen = {}      # key -> 第一次看到它的畫面
        self.clicked = {}   # key -> 驗證了什麼

    def scan(self, page, screen, roots=None):
        for k in page.evaluate(SCAN_JS, roots or DEFAULT_ROOTS):
            if k:
                self.seen.setdefault(k, screen)

    def key(self, page, selector):
        """selector 可用 Playwright 語法（含 :has-text）：拿第一個相符元素算 key；沒有就 None"""
        loc = page.locator(selector).first
        if loc.count() == 0:
            return None
        return loc.evaluate(KEY_JS)

    def mark(self, key, verified):
        if key:
            self.clicked[key] = verified

    def click(self, page, selector, verified, **kw):
        """點 selector（第一個相符）並登記 key。回 key。"""
        k = self.key(page, selector)
        page.locator(selector).first.click(**kw)
        self.mark(k, verified)
        return k

    def report(self):
        missed = {k: v for k, v in self.seen.items() if k not in self.clicked and k not in SKIP}
        return {
            'total': len(self.seen),
            'clicked': len(self.clicked),
            'skipped': {k: SKIP[k] for k in self.seen if k in SKIP},
            'missed': missed,
        }
