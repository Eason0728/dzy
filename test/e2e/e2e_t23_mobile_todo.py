#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ㉓：手機版「待處理」（docs/mobile-v2/spec.md 第二段，2026-11-06）。全部假名、全程 mock 後端。

① 首頁依「已逾期／今天／這週」分段：考勤沒核定的天＝已逾期、申請＝今天。
② 待處理 → 待我處理：「可以直接核准」卡片；核准一按就送、退回沒寫原因不送、寫了才送，卡片消失。
③ 我送出的：考勤申請列出狀態（處理中／已核准／已退回＋原因）。
④ 已處理：列出你已核准／你已退回。
⑤ 「我」頁標題列＝姓名＋職稱（小字）。
⑥ 375 寬無橫向捲動；電腦版沒有手機首頁區塊。
⑦ 首頁「常用」可以編輯：勾選、排序、重新整理還在、恢復自動。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, SHOTS, USERS, check, finish, login, start_server

from playwright.sync_api import sync_playwright

PORT = 8851


def req(i, **kw):
    base = {'store': 'MDGF', 'storeName': '測試光復', 'id': 'R%d' % i, 'kind': 'leave', 'label': '事假', 'date': '2026-11-08',
            'from': '14:00', 'to': '18:00', 'hours': 4, 'reason': '家裡有事', 'status': 'pending', 'hasAttach': False,
            'createdAt': '2026-11-05 10:00', 'decidedBy': '', 'decidedAt': '', 'rejectReason': ''}
    base.update(kw)
    return base


def main():
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    mock.att_alerts = {'ok': True, 'data': {'items': [{'kind': 'approve', 'count': 3}, {'kind': 'request', 'count': 2}], 'partial': False, 'pending': False}}
    mock.att_req = {
        'reqPending': [req(1, name='測試甲'), req(2, name='測試乙', kind='ot', label='加班', hours=2, reason='盤點')],
        'reqMine': [req(3), req(4, status='approved', label='特休', hours=8), req(5, status='rejected', rejectReason='那天人手不夠')],
        'reqDecided': [req(6, name='測試丙', decision='approve', status='approved'), req(7, name='測試丁', decision='reject', status='rejected')],
    }
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            pg = browser.new_context(viewport={'width': 375, 'height': 812}).new_page()
            mock.install(pg)
            pg.on('pageerror', lambda e: errors.append(str(e)))
            login(pg, base, 'admin')
            pg.wait_for_selector('[data-role="m-todo"] .m-grp')
            pg.wait_for_function("() => [...document.querySelectorAll('[data-role=m-todo] .m-grp')].some(g => g.textContent === '已逾期')", timeout=10000)
            grps = pg.locator('[data-role="m-todo"] .m-grp').all_inner_texts()
            check(grps[:2] == ['已逾期', '今天'], '①首頁分段順序：%s' % grps)
            overdue = pg.locator('[data-role="m-todo"] .m-grp.g-overdue + .m-list').inner_text()
            check('本月還有 3 天沒核定' in overdue, '①沒核定的天數在「已逾期」')

            # ② 可以直接核准
            pg.click('[data-m-tab="todo"]')
            pg.wait_for_selector('[data-role="quick-card"]')
            check(pg.locator('[data-role="quick-card"]').count() == 2, '②兩張可以直接核准的卡片')
            card1 = pg.locator('[data-role="quick-card"][data-id="MDGF|R1"]')
            check('測試甲 事假 4 小時' in card1.inner_text() and '原因：家裡有事' in card1.inner_text(), '②卡片寫明誰、什麼假、幾小時、原因')
            pg.screenshot(path=os.path.join(SHOTS, 'm-todo-quick-375.png'))
            card1.locator('button:has-text("核准")').click()
            pg.wait_for_selector('[data-role="quick-card"][data-id="MDGF|R1"]', state='detached')
            check(getattr(mock, 'att_decides', [])[-1:] == [{'store': 'MDGF', 'id': 'R1', 'decision': 'approve', 'reason': ''}], '②核准送出 store／id／decision：%s' % getattr(mock, 'att_decides', None))
            card2 = pg.locator('[data-role="quick-card"][data-id="MDGF|R2"]')
            card2.locator('button:has-text("退回")').click()
            pg.wait_for_selector('#m-quick-reason')
            pg.click('.dialog .btn:has-text("確定退回")')
            pg.wait_for_timeout(300)
            check(len(mock.att_decides) == 1 and card2.count() == 1, '②退回沒寫原因：不送出、卡片還在')
            card2.locator('button:has-text("退回")').click()
            pg.fill('#m-quick-reason', '那天不需要加班')
            pg.click('.dialog .btn:has-text("確定退回")')
            pg.wait_for_selector('[data-role="quick-card"][data-id="MDGF|R2"]', state='detached')
            check(mock.att_decides[-1] == {'store': 'MDGF', 'id': 'R2', 'decision': 'reject', 'reason': '那天不需要加班'}, '②退回帶原因送出')

            # ③ 我送出的
            pg.click('[data-m-seg="sent"]')
            pg.wait_for_selector('[data-role="m-sent"] .m-row')
            sent = pg.inner_text('[data-role="m-sent"]')
            check('處理中' in sent and '已核准' in sent and '已退回' in sent and '退回：那天人手不夠' in sent, '③我送出的：三種狀態與退回原因')

            # ④ 已處理
            pg.click('[data-m-seg="done"]')
            pg.wait_for_selector('[data-role="m-done"] .m-row')
            done = pg.inner_text('[data-role="m-done"]')
            check('你已核准' in done and '你已退回' in done and '測試丙' in done, '④已處理：你已核准／你已退回')
            pg.screenshot(path=os.path.join(SHOTS, 'm-todo-done-375.png'))

            # ⑤ 我
            pg.click('[data-m-tab="account"]')
            pg.wait_for_selector('.m-bar .m-title .m-nm')
            check(pg.inner_text('.m-bar .m-title .m-nm') == '管理者' and pg.inner_text('.m-bar .m-title .m-rl') == '系統管理者', '⑤「我」頁標題＝姓名＋職稱')

            # ⑦ 常用可以自己編輯（2026-11-06 Eason 選 A：存在這支手機）
            pg.click('[data-m-tab="home"]')
            pg.wait_for_selector('[data-role="m-grid"][data-kind="recent"] .m-tile')
            pg.click('[data-m-act="fav-edit"]')
            pg.wait_for_selector('[data-role="fav-list"]')
            while pg.locator('[data-role="fav-list"] input[data-fav]:checked').count():   # 每勾一下清單會重畫，逐一取最新的
                pg.locator('[data-role="fav-list"] input[data-fav]:checked').first.click()
            pg.check('[data-role="fav-list"] input[data-fav="bulletin"]')
            pg.check('[data-role="fav-list"] input[data-fav="attendance"]')
            pg.check('[data-role="fav-list"] input[data-fav="approvals"]')
            pg.click('[data-fav-up="approvals"]')
            pg.click('[data-fav-up="approvals"]')
            pg.screenshot(path=os.path.join(SHOTS, 'm-fav-edit-375.png'))
            pg.click('.dialog .btn:has-text("完成")')
            pg.wait_for_timeout(300)
            order = pg.locator('[data-role="m-grid"][data-kind="recent"] .m-tile').evaluate_all('els => els.map(e => e.dataset.module)')
            check(order == ['approvals', 'bulletin', 'attendance'], '⑦常用照自己勾的與排的順序：%s' % order)
            pg.wait_for_timeout(4500)   # 等提示訊息消失再拍
            pg.locator('[data-role="m-grid"][data-kind="recent"]').scroll_into_view_if_needed()
            pg.screenshot(path=os.path.join(SHOTS, 'm-fav-home-375.png'))
            pg.reload()
            pg.wait_for_selector('[data-role="m-grid"][data-kind="recent"] .m-tile')
            order2 = pg.locator('[data-role="m-grid"][data-kind="recent"] .m-tile').evaluate_all('els => els.map(e => e.dataset.module)')
            check(order2 == order, '⑦重新整理後還在（存在這支手機）')
            pg.click('[data-m-act="fav-edit"]')
            pg.wait_for_selector('[data-role="fav-list"]')
            check(pg.locator('[data-role="fav-list"] input[data-fav]:not(:checked):not(:disabled)').count() > 0, '⑦沒滿 6 個時其他功能可勾')
            pg.click('.dialog .btn:has-text("恢復自動")')
            pg.wait_for_timeout(300)
            check(pg.locator('[data-role="m-grid"][data-kind="recent"] .m-tile').count() == 6, '⑦恢復自動：回到 6 個最近用過的')

            # ⑥
            check(pg.evaluate('document.documentElement.scrollWidth') <= 375, '⑥375 寬無橫向捲動')
            dk = browser.new_context(viewport={'width': 1280, 'height': 800}).new_page()
            mock.install(dk)
            login(dk, base, 'admin')
            dk.wait_for_selector('[data-role="module-card"]')
            check(dk.locator('.m-home').count() == 0 and not dk.locator('.m-tabs').is_visible(), '⑥電腦版沒有手機首頁、底部四格')

            # ⑧ 一般同仁（沒有考勤管理權限；2026-11-10 挑錯問題 4）：手機「我送出的」也列出自己的考勤申請，項目不是連結；
            #    待我處理沒有核准卡片、功能頁沒有考勤管理；只向考勤後端要「我送出的」這一支
            USERS['e2e-staff'] = {'password': 'e2e-staff-pw', 'user': {'id': 'u-staff', 'name': '測試同仁', 'role': 'staff', 'node': ''}, 'perms': ['platform.self', 'platform.storeops']}
            st = browser.new_context(viewport={'width': 375, 'height': 812}).new_page()
            mock.install(st)
            st.on('pageerror', lambda e: errors.append(str(e)))
            mock.proxy_calls = []
            login(st, base, 'e2e-staff')
            st.wait_for_selector('[data-role="m-tabs"]')
            st.click('[data-m-tab="todo"]')
            st.click('[data-m-seg="sent"]')
            st.wait_for_function("() => { const b = document.querySelector('[data-role=m-sent]'); return b && !/讀取中/.test(b.textContent); }", timeout=15000)
            st.wait_for_timeout(400)
            sent2 = st.inner_text('[data-role="m-sent"]')
            check(st.locator('[data-role="m-sent"] .m-row').count() == 3 and '處理中' in sent2 and '已核准' in sent2 and '退回：那天人手不夠' in sent2, '⑧一般同仁「我送出的」列出自己的 3 張考勤申請：%r' % sent2[:60])
            check(st.locator('[data-role="m-sent"] .m-row').count() == 3 and st.locator('[data-role="m-sent"] .m-row[data-target]').count() == 0, '⑧列出來的項目不是連結（他沒有考勤管理那一頁）')
            st.click('[data-m-seg="mine"]')
            st.wait_for_timeout(1500)
            check(st.locator('[data-role="quick-card"]').count() == 0, '⑧一般同仁的「待我處理」沒有可核准的卡片')
            att_calls = [c for c in mock.proxy_calls if c[0] == 'attendance']
            check(att_calls == [('attendance', 'reqMine')], '⑧一般同仁只向考勤後端要「我送出的」，沒有要待核、已處理、首頁件數：%s' % att_calls)
            st.click('[data-m-tab="apps"]')
            st.wait_for_selector('[data-role="m-tile"]')
            check(st.locator('[data-role="m-tile"][data-module="attendance"]').count() == 0, '⑧一般同仁的功能頁沒有考勤管理')
            st.screenshot(path=os.path.join(SHOTS, 'm-todo-staff-375.png'))
            browser.close()
        check(not errors, '頁面無 JS 錯誤：%s' % errors[:3])
        check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
