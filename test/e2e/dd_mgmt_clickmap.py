# -*- coding: utf-8 -*-
"""按鈕與連結的覆蓋稽核（抄 ~/Desktop/Claude/系統/績效評鑑/績效評核系統/e2e/clickmap.py，
只多一個 roots 參數：這裡只稽核模組內容區＋分頁列，側邊欄的其他模組不在本輪範圍）。

每進到一個畫面就把當下的可點元素全部登記，點過的登記為已測，最後把「登記過但沒被點過」
的印出來，漏一顆就報失敗。key 由元素本身算出（KEY_JS／SCAN_JS 共用同一段邏輯）。
"""

_KEY_LOGIC = """
  const id = e.id ? '#' + e.id : '';
  const dr = e.dataset && e.dataset.r ? ('a[data-r=' + e.dataset.r + ']') : '';
  if (id) return id;
  if (dr) return dr;
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
  const sel = 'button, a[href], a[data-r], summary, input[type=checkbox], select';
  const out = [];
  for (const r of roots) {
    for (const root of document.querySelectorAll(r)) {
      for (const e of root.querySelectorAll(sel)) {
        if (e.offsetParent !== null || e.tagName === 'SUMMARY') out.push(keyOf(e));
      }
    }
  }
  return out;
}
""" % _KEY_LOGIC

ROOTS = ['[data-role="view-nav"]', '[data-role="view-content"]', '[data-role="keep-root"]', '.dialog']

# 刻意不點、附理由（會列在報告裡，不算漏測）
SKIP = {}


class ClickMap:
    def __init__(self):
        self.seen = {}      # key -> 第一次看到它的畫面
        self.clicked = {}   # key -> 驗證了什麼

    def scan(self, page, screen):
        for k in page.evaluate(SCAN_JS, ROOTS):
            if k:
                self.seen.setdefault(k, screen)

    def key_of(self, page, selector):
        """selector 可用 Playwright 語法（含 :has-text）；key 由元素本身算。"""
        loc = page.locator(selector).first
        if loc.count() == 0:
            return None
        return loc.evaluate(KEY_JS)

    def mark(self, key, verified):
        if key:
            self.clicked[key] = verified

    def click(self, page, selector, verified, screen=None):
        """點 selector 指到的第一個元素並登記（key 用元素本身算，不手寫）。"""
        if screen:
            self.scan(page, screen)
        key = self.key_of(page, selector)
        page.locator(selector).first.click()
        self.mark(key, verified)
        return key

    def report(self):
        missed = {k: v for k, v in self.seen.items() if k not in self.clicked and k not in SKIP}
        return {
            'total': len(self.seen),
            'clicked': len(self.clicked),
            'skipped': {k: SKIP[k] for k in self.seen if k in SKIP},
            'missed': missed,
        }
