#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ④：切模組不重載頁面（SPA；task.md T4-1 第 ④ 條）。

判準：在 window 上放一個記號，連續切四個模組再回首頁，記號都還在＝從頭到尾
是同一個 document，殼只做 mount/unmount，沒有整頁重載。
順帶驗：每次切換內容真的換了（不是只有網址變）、模組切走時有 unmount（畫面清空重畫）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, check, finish, login, start_server

from playwright.sync_api import sync_playwright

PORT = 8794


def main():
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_context(viewport={'width': 1280, 'height': 800}).new_page()
            mock.install(page)
            login(page, base, 'admin')
            page.wait_for_selector('[data-role="module-card"]')

            page.evaluate("() => { window.__e2eSameDocument = 'yes'; }")

            hops = [
                ('audit-stock', '總覽'),
                ('audit-ops', '總覽'),
                ('dorm', '合約清單'),
                ('users', '人員清單'),
            ]
            for module_id, tab_name in hops:
                page.click(f'[data-role="nav-desktop"] [data-nav="{module_id}"]')
                page.wait_for_selector(f'[data-role="view-nav"] .nav-item:has-text("{tab_name}")', timeout=8000)
                marker = page.evaluate("() => window.__e2eSameDocument")
                check(marker == 'yes', f'切到 {module_id} 後 window 記號還在（沒有整頁重載）')

            # 回首頁：卡片重畫、記號還在
            page.click('[data-role="nav-desktop"] [data-nav="__home__"]')
            page.wait_for_selector('[data-role="module-card"]')
            check(page.evaluate("() => window.__e2eSameDocument") == 'yes', '回首頁後記號還在')
            check(page.locator('[data-role="module-card"]').count() == 4, '回首頁四張卡片重畫完成')

            # 網址列 hash 正確跟著走（spec §4.9 路由字串）
            page.click('[data-role="nav-desktop"] [data-nav="dorm"]')
            page.wait_for_function("() => window.location.hash === '#/dorm/list'", timeout=5000)
            check(True, '點宿舍合約後網址是 #/dorm/list（預設分頁）')

            browser.close()
        check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
