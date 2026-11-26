#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ㉘：手機「待處理」審單出勤試算一行（2026-11-25 營運系統 ot-review-hint 第 7 題 A、第 4 題第 24 句）。全部假名、全程 mock 後端。

① 營運系統帶 otCheck（加班單照核定規則試算「多了」）的那張：卡片多一列 .m-card-ot「出勤試算：應有加班 0 小時，這張 1 小時（多 1 小時）」，原因那列照舊；
   一次送出兩段的組卡也只多一列。
② 沒有 otCheck 的卡片（請假、相符、營運系統開關關著）：沒有那一列；原因那列（.m-card-d）的樣式跟以前一樣（white-space normal）。
③ 有試算的那張照常核准（只提示，不擋）。390 寬無橫向捲動；截圖存 E2E_SHOTS（預設 shots/）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, SHOTS, USERS, check, finish, start_server

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

PORT = 8868
OUT = os.environ.get('E2E_SHOTS') or SHOTS
L24 = '出勤試算：應有加班 0 小時，這張 1 小時（多 1 小時）'


def req(i, **kw):
    base = {'store': 'MZGF', 'storeName': '墨竹亭光復', 'id': i, 'kind': 'ot', 'label': '加班', 'date': '2026-11-23',
            'from': '20:00', 'to': '21:00', 'hours': 1, 'reason': '收店', 'status': 'pending', 'hasAttach': False,
            'createdAt': '2026-11-23 22:14', 'decidedBy': '', 'decidedAt': '', 'rejectReason': '', 'name': '支援甲', 'group': '', 'seg': None}
    base.update(kw)
    return base


def pending():
    return [
        req('R1', otCheck={'need': 0, 'n': 1, 'over': 1}),
        req('G1', name='同仁丁', group='gX', seg=1, otCheck={'need': 0, 'n': 2, 'over': 2}, **{'from': '17:00', 'to': '18:00'}),
        req('G2', name='同仁丁', group='gX', seg=2, otCheck={'need': 0, 'n': 2, 'over': 2}, **{'from': '18:00', 'to': '19:00'}),
        req('R2', name='同仁乙', reason='盤點\n（兩行原因）', **{'from': '17:00', 'to': '19:00', 'hours': 2}),
        req('L1', kind='leave', label='事假', name='同仁戊', hours=2, reason='私事', **{'from': '15:00', 'to': '17:00'}),
    ]


def main():
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    mock.att_alerts = {'ok': True, 'data': {'items': [{'kind': 'request', 'count': 5}], 'partial': False, 'pending': False}}
    errors = []
    os.makedirs(OUT, exist_ok=True)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            mock.att_req = {'reqPending': pending(), 'reqMine': [], 'reqDecided': []}
            mock.att_decides = []
            mock.att_decide_fail = {}
            pg = None
            for attempt in range(3):
                ctx = browser.new_context(viewport={'width': 390, 'height': 844})
                pg = ctx.new_page()
                mock.install(pg)
                pg.on('pageerror', lambda e: errors.append(str(e)))
                try:
                    pg.goto(base + '/index.html')
                    pg.fill('#login-username', 'admin', timeout=15000)
                    pg.fill('#login-password', USERS['admin']['password'])
                    pg.click('[data-role="submit"]')
                    pg.wait_for_selector('[data-role="view-content"]', state='attached', timeout=15000)
                    pg.wait_for_selector('[data-m-tab="todo"]', timeout=15000)
                    pg.click('[data-m-tab="todo"]')
                    pg.wait_for_selector('[data-role="m-quick"] .m-card', timeout=25000)
                    break
                except PWTimeout:
                    ctx.close()
                    if attempt == 2:
                        raise
            r1 = pg.locator('[data-role="quick-card"][data-id="MZGF|R1"]')
            check(r1.locator('.m-card-ot').inner_text() == L24, '①多了的那張：多一列第 24 句：%r' % r1.locator('.m-card-ot').inner_text())
            check(r1.locator('.m-card-d').inner_text() == '原因：收店', '①原因那列照舊')
            g = pg.locator('[data-role="quick-group"]')
            check(g.count() == 1 and g.locator('.m-card-ot').count() == 1 and g.locator('.m-card-ot').inner_text() == '出勤試算：應有加班 0 小時，這張 2 小時（多 2 小時）', '①一次送出兩段：組卡只多一列')
            r2 = pg.locator('[data-role="quick-card"][data-id="MZGF|R2"]')
            l1 = pg.locator('[data-role="quick-card"][data-id="MZGF|L1"]')
            check(r2.locator('.m-card-ot').count() == 0 and l1.locator('.m-card-ot').count() == 0, '②沒有 otCheck 的卡片沒有那一列')
            ws = r2.locator('.m-card-d').evaluate('e => getComputedStyle(e).whiteSpace')
            check(ws == 'normal', '②原因那列樣式跟以前一樣（white-space %s；原因裡的換行照舊不換行）' % ws)
            check(pg.evaluate('document.documentElement.scrollWidth') <= 390, '③390 寬無橫向捲動')
            r1.scroll_into_view_if_needed()
            pg.screenshot(path=os.path.join(OUT, 'm390-otline.png'), full_page=True)
            r1.locator('button:has-text("核准")').click()
            pg.wait_for_selector('[data-role="quick-card"][data-id="MZGF|R1"]', state='detached')
            check([d['id'] for d in mock.att_decides] == ['R1'] and mock.att_decides[0]['decision'] == 'approve', '③有試算的那張照常核准：%s' % mock.att_decides)
            check(not errors, '頁面無 JS 錯誤：%s' % errors[:3])
            check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
            browser.close()
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
