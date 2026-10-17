#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑧：個人帳號管理（docs/personnel/task.md B7；2026-10-12 改成認領後主管審核）。全部假名、全程 mock 後端。

① 後台匯入：預覽 → 建立，編號 DZY001 起（第三位假店長直接設成已開通的光復店長）。
② 同仁第一次使用：#/claim 輸入全名 → 看到編號 → 填資料送出 → **不登入**，顯示「已送出，等你的單位主管審核」；
   回登入頁帶入編號，用剛設的密碼登入 → 被擋「帳號還在等主管審核」。
③ 同單位店長登入 → 首頁「有 1 位同仁等你審核」→ 點進「我的資料 → 待審核」→ 核對對話框 → 通過。
④ 同仁再登入 → 進首頁、只看得到「我的資料」；網址不停在 #/claim；按登出 → 前端有送 logout、回登入頁。
⑤ 人資路徑：第二位認領 → 後台首頁「1 位同仁待確認開通」→ 名單確認（核對提醒）→ 已開通。
⑥ 忘記密碼：錯 5 次後，對的也被擋（顯示時間鎖訊息）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, SHOTS, check, finish, login, start_server

from playwright.sync_api import sync_playwright

PORT = 8789
NAMES = ['測試一號', '測試二號', '測試店長']


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
            check(len(mock.staff) == 3, '建立三位，狀態未開通')
            # 第三位當光復店長（已開通、店長職級）——mock 直接設好，不走認領
            from common import USERS
            mock.staff[2].update({'status': 'active', 'brand': 'mzt', 'unit': 'mzt-gf', 'title': 'sm', 'phone': '0912000333'})
            USERS['DZY003'] = {'password': 'e2e-lead-pw-3', 'perms': ['platform.self', 'platform.review'],
                               'user': {'id': 'u-DZY003', 'name': NAMES[2], 'role': 'staff', 'node': ''}}

            # ② 第一次使用：送出後不登入
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
            staff.wait_for_selector('[data-role="claim-sent"]')
            check('等你的單位主管審核通過後就能登入' in staff.inner_text('[data-role="claim-sent"]'), '★送出後顯示「已送出，等你的單位主管審核」')
            check(staff.locator('[data-role="module-card"]').count() == 0 and staff.evaluate("localStorage.getItem('dzy.token')") is None,
                  '★送出後沒有登入、沒存 token')
            check(mock.staff[0]['status'] == 'pending' and mock.staff[0]['phone'] == '0912000111', '狀態待審、手機去掉連字號再送出')
            os.makedirs(SHOTS, exist_ok=True)
            staff.screenshot(path=os.path.join(SHOTS, 'claim-sent-375.png'), full_page=True)
            staff.click('[data-role="back"]')
            staff.wait_for_selector('#login-username')
            staff.wait_for_function("() => document.querySelector('#login-username').value === 'DZY001'")
            check(True, '回登入頁帶入編號')
            staff.fill('#login-password', 'e2e-staff-pw-1')
            staff.click('[data-role="submit"]')
            staff.wait_for_selector('[data-role="error"]:has-text("帳號還在等主管審核")')
            check(True, '★待審核用對的密碼也登不進去，顯示「帳號還在等主管審核」')

            # ③ 同單位店長審核
            lead = browser.new_context(viewport={'width': 1280, 'height': 800}).new_page()
            mock.install(lead)
            lead.goto(base + '/index.html')
            lead.fill('#login-username', 'DZY003')
            lead.fill('#login-password', 'e2e-lead-pw-3')
            lead.click('[data-role="submit"]')
            lead.wait_for_selector('[data-role="alert-row"]:has-text("有 1 位同仁等你審核")')
            check(True, '★店長首頁出現「有 1 位同仁等你審核」')
            lead.click('[data-role="alert-row"]:has-text("有 1 位同仁等你審核")')
            lead.wait_for_selector('[data-role="review-row"][data-emp="DZY001"]')
            row_text = lead.inner_text('[data-role="review-row"][data-emp="DZY001"]')
            check('1996-06-06' in row_text and '0912000111' in row_text and '新竹市測試路二段2號' in row_text, '待審卡片有生日、手機、地址可核對')
            check(lead.locator('[data-role="view-nav"] .nav-item:has-text("待審核")').count() >= 1, '店長看得到「待審核」分頁')
            lead.screenshot(path=os.path.join(SHOTS, 'review-1280.png'), full_page=True)
            lead.click('[data-act="approve"][data-emp="DZY001"]')
            check('請先確認是他本人' in lead.inner_text('.dialog'), '通過前提醒核對本人')
            lead.click('.dialog .btn-primary:has-text("已核對，通過")')
            lead.wait_for_selector('[data-role="review-empty"]')
            check(mock.staff[0]['status'] == 'active' and mock.staff[0]['unit'] == 'mzt-gf', '★通過後狀態已開通、單位生效')

            # ④ 同仁登入成功、登出會打後端
            staff.fill('#login-password', 'e2e-staff-pw-1')
            staff.click('[data-role="submit"]')
            staff.wait_for_selector('[data-role="module-card"]')
            check(staff.locator('[data-role="module-card"]').count() == 3, '★通過後可登入，同仁只看得到「我的資料」「公告專區」「表單簽核」三個模組')
            check(staff.evaluate('location.hash') in ('', '#/home'), '登入後網址不停在 #/claim')
            staff.goto(base + '/index.html#/claim')
            staff.wait_for_selector('[data-role="module-card"]')
            check(staff.locator('.toast-warn:has-text("沒有權限")').count() == 0, '已登入打開 #/claim 不跳「沒有權限」')
            staff.screenshot(path=os.path.join(SHOTS, 'staff-home-375.png'), full_page=True)
            staff.goto(base + '/index.html#/me/profile')
            staff.wait_for_selector('#me-phone')
            tabs = staff.locator('[data-role="view-nav"] .nav-item').all_inner_texts()
            check(any('個人資料' in t for t in tabs) and not any('待審核' in t for t in tabs), '一般同仁在「我的資料」看不到「待審核」分頁：%s' % tabs)
            staff.fill('#me-phone', '0912000999')
            check(staff.is_visible('#me-curpw'), '改手機時出現「目前的密碼」欄')
            staff.fill('#me-phone', '0912000111')
            staff.locator('[data-nav="__logout__"]:visible').first.click()
            staff.wait_for_selector('#login-username')
            check(getattr(mock, 'logouts', []) == ['e2e-token-DZY001'], '★按登出前端有送 logout（帶自己的 token）：%s' % getattr(mock, 'logouts', None))
            check(staff.evaluate("localStorage.getItem('dzy.token')") is None, '登出後本機 token 清掉')

            # ⑤ 人資路徑：後台確認
            claim2 = browser.new_context(viewport={'width': 375, 'height': 800}).new_page()
            mock.install(claim2)
            claim2.goto(base + '/index.html#/claim')
            claim2.fill('#claim-name', NAMES[1])
            claim2.click('[data-role="submit"]')
            claim2.wait_for_selector('.emp-no')
            claim2.fill('#claim-pw', 'e2e-staff-pw-2')
            claim2.fill('#claim-pw2', 'e2e-staff-pw-2')
            claim2.select_option('#claim-brand', 'dzy')
            claim2.select_option('#claim-unit', 'dzy-hq')
            claim2.select_option('#claim-title', 'hs')
            claim2.fill('#claim-birthday', '1997-07-07')
            claim2.fill('#claim-phone', '0912000222')
            claim2.fill('#claim-address', '新竹市測試路三段3號')
            claim2.click('[data-role="submit"]')
            claim2.wait_for_selector('[data-role="claim-sent"]')
            admin.click('[data-role="nav-desktop"] [data-nav="__home__"]')
            admin.wait_for_selector('[data-role="alert-row"]:has-text("1 位同仁待確認開通")')
            admin.click('[data-role="alert-row"]:has-text("1 位同仁待確認開通")')
            admin.wait_for_selector('[data-act="confirm"][data-emp="DZY002"]')
            admin.click('[data-act="confirm"][data-emp="DZY002"]')
            check('打電話給本人核對' in admin.inner_text('.dialog'), '確認前提醒打電話核對')
            admin.click('.dialog .btn-primary:has-text("已核對，確認")')
            admin.wait_for_function("() => document.querySelector('#stf-f') && true")
            admin.select_option('#stf-f', 'all')
            admin.wait_for_selector('[data-role="rows"] tr:has-text("DZY002") .tag-ok')
            check(mock.staff[1]['status'] == 'active' and mock.staff[1]['unit'] == 'dzy-hq', '人資確認後狀態已開通、單位生效')
            admin.screenshot(path=os.path.join(SHOTS, 'staff-list-1280.png'), full_page=True)

            # ⑥ 忘記密碼
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
