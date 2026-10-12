#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑧：個人帳號管理（docs/personnel/task.md B7）。全部假名、全程 mock 後端。

① 後台匯入：預覽 → 建立，編號 DZY001 起。
② 同仁第一次使用：#/claim 輸入全名 → 看到編號 → 填資料送出 → 直接登入，首頁「我的資料」顯示等確認；
   重新整理後仍登入、網址不會停在 #/claim 也不跳「沒有權限」。
③ 後台首頁看到「1 位同仁待確認開通」→ 點進名單 → 確認（核對提醒對話框）→ 狀態變已開通。
④ 忘記密碼：錯 5 次後，對的也被擋（顯示時間鎖訊息）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, SHOTS, check, finish, login, start_server

from playwright.sync_api import sync_playwright

PORT = 8789
NAMES = ['測試一號', '測試二號']


def main():
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ① 後台匯入
            admin = browser.new_context(viewport={'width': 1280, 'height': 800}).new_page()
            mock.install(admin)
            login(admin, base, 'admin')
            admin.click('[data-role="nav-desktop"] [data-nav="staff"]')
            admin.click('[data-role="view-nav"] .nav-item:has-text("匯入")')
            admin.fill('#imp-names', '\n'.join(NAMES))
            admin.click('[data-role="preview"]')
            admin.wait_for_selector('[data-role="create"]')
            check('DZY001' in admin.inner_text('[data-role="result"]'), '預覽顯示 DZY001')
            check(not getattr(mock, 'staff', []), '預覽沒有寫入')
            admin.click('[data-role="create"]')
            admin.click('.dialog .btn-primary:has-text("確定")')
            admin.wait_for_selector('[data-role="rows"] tr:has-text("DZY002")')
            check(len(mock.staff) == 2, '建立兩位，狀態未開通')

            # ② 第一次使用
            staff = browser.new_context(viewport={'width': 375, 'height': 800}).new_page()
            mock.install(staff)
            staff.goto(base + '/index.html#/claim')
            staff.fill('#claim-name', NAMES[0])
            staff.click('[data-role="submit"]')
            staff.wait_for_selector('.emp-no')
            check(staff.inner_text('.emp-no') == 'DZY001', '輸入全名後看到自己的編號')
            staff.fill('#claim-pw', 'e2e-staff-pw-1')
            staff.fill('#claim-pw2', 'e2e-staff-pw-1')
            staff.select_option('#claim-brand', 'mzt')
            staff.select_option('#claim-unit', 'mzt-gf')
            check(staff.is_hidden('[data-role="claim-dept-wrap"]'), '門市單位不出現部門欄')
            titles = staff.locator('#claim-title option').all_inner_texts()
            check('部門同仁' not in titles and '計時同仁' in titles, '門市單位只列門市職級：%s' % titles)
            staff.select_option('#claim-title', 'pt')
            staff.fill('#claim-birthday', '1996-06-06')
            staff.fill('#claim-phone', '0912-000-111')
            staff.fill('#claim-address', '新竹市測試路二段2號')
            staff.click('[data-role="submit"]')
            staff.wait_for_selector('[data-role="alert-list"][data-module="me"] .todo-row')
            check('等後台確認' in staff.inner_text('[data-role="alert-list"][data-module="me"]'), '首頁「我的資料」顯示等後台確認')
            check(staff.evaluate('location.hash') in ('', '#/home'), '登入後網址不停在 #/claim')
            check(mock.staff[0]['phone'] == '0912000111', '手機去掉連字號再送出')
            check(staff.locator('[data-role="module-card"]').count() == 1, '同仁只看得到「我的資料」一個模組')
            staff.goto(base + '/index.html#/claim')
            staff.wait_for_selector('[data-role="module-card"]')
            check(staff.locator('.toast-warn:has-text("沒有權限")').count() == 0, '已登入打開 #/claim 不跳「沒有權限」')
            os.makedirs(SHOTS, exist_ok=True)
            staff.screenshot(path=os.path.join(SHOTS, 'staff-home-375.png'), full_page=True)

            # ③ 後台確認
            admin.click('[data-role="nav-desktop"] [data-nav="__home__"]')
            admin.wait_for_selector('[data-role="alert-row"]:has-text("1 位同仁待確認開通")')
            admin.click('[data-role="alert-row"]:has-text("1 位同仁待確認開通")')
            admin.wait_for_selector('[data-act="confirm"][data-emp="DZY001"]')
            admin.click('[data-act="confirm"][data-emp="DZY001"]')
            check('打電話給本人核對' in admin.inner_text('.dialog'), '確認前提醒打電話核對')
            admin.click('.dialog .btn-primary:has-text("已核對，確認")')
            admin.wait_for_function("() => document.querySelector('#stf-f') && true")
            admin.select_option('#stf-f', 'all')
            admin.wait_for_selector('[data-role="rows"] tr:has-text("DZY001") .tag-ok')
            check(mock.staff[0]['status'] == 'active' and mock.staff[0]['unit'] == 'mzt-gf', '確認後狀態已開通、單位生效')
            admin.screenshot(path=os.path.join(SHOTS, 'staff-list-1280.png'), full_page=True)

            # ④ 忘記密碼
            fp = browser.new_context(viewport={'width': 375, 'height': 800}).new_page()
            mock.install(fp)
            fp.goto(base + '/index.html#/forgot')
            fp.fill('#forgot-emp', 'dzy001')
            fp.fill('#forgot-phone', '0912000111')
            fp.fill('#forgot-pw', 'e2e-new-pw-12')
            fp.fill('#forgot-pw2', 'e2e-new-pw-12')
            for _ in range(5):
                fp.fill('#forgot-birthday', '1990-01-01')
                fp.click('[data-role="submit"]')
                fp.wait_for_selector('[data-role="error"]:has-text("資料不符")')
            fp.fill('#forgot-birthday', '1996-06-06')
            fp.click('[data-role="submit"]')
            fp.wait_for_selector('[data-role="error"]:has-text("錯太多次")')
            check(True, '錯 5 次後，對的也被時間鎖擋下')

            browser.close()
        check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
