#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ②：會計看不到宿舍（requirements §10 第 2 條前半）。

- 首頁只有兩張稽核卡片，沒有宿舍合約、沒有人員管理
- 導覽列同樣沒有那兩項
- 手動改網址 #/dorm/list → 彈「沒有權限」回首頁（第二道保險）
- 會計的稽核是可寫的：總覽之外看得到「稽核填寫」分頁
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, check, finish, login, start_server

from playwright.sync_api import sync_playwright

PORT = 8792


def main():
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_context(viewport={'width': 1280, 'height': 800}).new_page()
            mock.install(page)
            login(page, base, 'acct')

            page.wait_for_selector('[data-role="module-card"]')
            ids = [c.get_attribute('data-module') for c in page.locator('[data-role="module-card"]').all()]
            check(ids == ['audit-stock', 'audit-ops'],
                  '會計首頁只有兩張稽核卡片（無宿舍、無人員管理），實際：%s' % ids)

            nav_text = page.locator('[data-role="nav-desktop"]').inner_text()
            check('宿舍合約' not in nav_text and '人員管理' not in nav_text,
                  '導覽列沒有宿舍合約／人員管理，實際：%r' % nav_text)

            # 手動改網址闖宿舍 → 彈回首頁
            page.evaluate("() => { window.location.hash = '#/dorm/list'; }")
            page.wait_for_function("() => window.location.hash === '#/home'", timeout=5000)
            check(True, '手動改網址 #/dorm/list 被彈回 #/home')
            check(page.locator('.toast', has_text='沒有權限').count() > 0
                  or page.locator('text=沒有權限').count() > 0, '有跳「沒有權限」提示')
            check(page.locator('#dorm-list-table, .dorm-list-table').count() == 0, '宿舍畫面完全沒有被畫出來')

            # 會計進盤點模組：預設分頁總覽，且分頁列有「稽核填寫」（audit.write）
            page.click('[data-role="module-card"][data-module="audit-stock"]')
            page.wait_for_selector('[data-role="view-nav"] .nav-item')
            tabs = page.locator('[data-role="view-nav"] .nav-item').all_inner_texts()
            check('稽核填寫' in tabs and '總覽' in tabs,
                  '會計看得到「總覽」與「稽核填寫」分頁，實際：%s' % tabs)
            check('我的門市' not in tabs, '會計沒有「我的門市」分頁（那是店長專用），實際：%s' % tabs)

            # 總覽是全節點視角：五家店都在
            page.wait_for_selector('text=墨竹亭金山', timeout=8000)
            check(True, '總覽看得到其他店（墨竹亭金山）＝會計是全節點視角')

            browser.close()
        check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
