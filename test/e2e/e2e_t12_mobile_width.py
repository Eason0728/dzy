#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑫：375px 手機寬度實測（2026-10-17 全面審視補驗）。全部假名、全程 mock 後端、零真實網路。

三個容易「按鈕／標籤一多就撐出橫向捲軸」的畫面，用會換行的大量資料實際量 scrollWidth ≤ 375：
  ① #/audit-ops/fill（稽核填寫：19 項檢查＋長店名＋未完成說明）
  ② #/staff/clockmap（總部打卡對照：很多筆待確認，姓名／店名很長）
  ③ #/me/clock（店長打卡對照：同上，自己單位）
另外量每個畫面裡所有元素的右緣都不超過視窗寬，抓得出是哪一顆撐出來。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import SHOTS, USERS, check, finish, start_server
from e2e_t9_staff_master import Mock9, UNIT_BRAND  # noqa: F401  （打卡對照的 mock 沿用 ⑨）

from playwright.sync_api import sync_playwright

PORT = 8803
W = 375
LONG = '測試超級無敵長姓名的同仁'


def overflow(page):
    """回 (scrollWidth, 右緣超出視窗的元素描述前 5 個)"""
    return page.evaluate("""() => {
      const w = window.innerWidth, out = [];
      const clipped = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') return true; } return false; };
      const name = (e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '') + (e.dataset && e.dataset.role ? '[' + e.dataset.role + ']' : '');
      for (const e of document.querySelectorAll('body *')) {
        const r = e.getBoundingClientRect();
        if (r.width > 0 && r.right > w + 1 && !clipped(e) && getComputedStyle(e).position !== 'fixed') out.push(name(e) + '<' + name(e.parentElement) + '@' + Math.round(r.right));
      }
      return [document.documentElement.scrollWidth, out.slice(0, 6)];
    }""")


def measure(page, label):
    sw, bad = overflow(page)
    check(sw <= W, '%s：scrollWidth %d ≤ %d（超出元素：%s）' % (label, sw, W, bad))


def main():
    httpd, base = start_server(PORT)
    mock = Mock9(base)
    os.makedirs(SHOTS, exist_ok=True)
    # 打卡對照：灌 14 筆待確認，姓名很長、按鈕／標籤會換行
    for i in range(14):
        n = 40 + i
        emp = 'DZY%03d' % n
        mock.staff.append({'emp_no': emp, 'name': LONG + str(i), 'status': 'active', 'unit': 'mzt-gf', 'brand': 'mzt', 'title': 'pt',
                           'hire_date': '2026-01-05', 'last_day': '', 'phone': '0912000%03d' % n})
        mock.maps.append({'emp_no': emp, 'store_code': 'mztgf', 'emp_id': 'E%02d' % (30 + i), 'role': 'home', 'state': 'suggested', 'roster_active': True, 'last_punch': '2026-10-12'})
    # 營運稽核：店名加長、多加幾家
    stores = mock.audit_fixture['config']['stores']
    for i in range(6):
        stores.append({'code': 'long-%d' % i, 'name': '墨竹亭超級長的分店名稱測試第%d號店面' % i, 'order': 10 + i})
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def page_for(user, pw=None):
                pg = browser.new_context(viewport={'width': W, 'height': 800}).new_page()
                mock.install(pg)
                pg.goto(base + '/index.html')
                pg.fill('#login-username', user)
                pg.fill('#login-password', pw or USERS[user]['password'])
                pg.click('[data-role="submit"]')
                # 首頁載完才換網址，不然登入完成的導頁會蓋掉要去的分頁（同 ⑨）
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)
                return pg

            # ① 會計：營運稽核填寫
            acct = page_for('acct')
            acct.goto(base + '/index.html#/audit-ops/fill')
            acct.wait_for_selector('#ops-store', timeout=10000)
            measure(acct, '① 稽核填寫（剛進來）')
            acct.select_option('#ops-store', index=acct.locator('#ops-store option').count() - 1)
            acct.wait_for_selector('.ops-item', timeout=10000)
            check(acct.locator('.ops-item').count() >= 19, '①稽核項目 ≥19：%d' % acct.locator('.ops-item').count())
            measure(acct, '① 稽核填寫（19 項展開，長店名）')
            # 全部標「未完成」＋追蹤，出現說明欄與標籤
            fails = acct.locator('.ops-item .ops-vbtn.sel-fail, .ops-item [data-v="fail"]')
            n = acct.locator('.ops-item .ops-vbtn').count()
            for i in range(0, n, 2):
                acct.locator('.ops-item .ops-vbtn').nth(i).click()
            tb = acct.locator('.ops-item .ops-tbtn')
            for i in range(tb.count()):
                tb.nth(i).click()
            measure(acct, '① 稽核填寫（多數項目已標記、追蹤）')

            # ② 管理者：總部打卡對照
            adm = page_for('admin')
            adm.goto(base + '/index.html#/staff/clockmap')
            adm.wait_for_selector('[data-role="cm-row"]', timeout=10000)
            check(adm.locator('[data-role="cm-row"]').count() >= 14, '②打卡對照筆數 ≥14：%d' % adm.locator('[data-role="cm-row"]').count())
            measure(adm, '② #/staff/clockmap')

            # ③ 店長：我的單位打卡對照
            lead = page_for('DZY010', 'e2e-lead-pw-10')
            lead.goto(base + '/index.html#/me/clock')
            lead.wait_for_selector('[data-role="cm-row"]', timeout=10000)
            check(lead.locator('[data-role="cm-row"]').count() >= 14, '③店長打卡對照筆數 ≥14：%d' % lead.locator('[data-role="cm-row"]').count())
            measure(lead, '③ #/me/clock')

            check(not mock.leaked, '沒有請求漏出 mock：%s' % mock.leaked)
            browser.close()
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
