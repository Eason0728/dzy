#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ㉗：手機版「待處理」一次填兩段（2026-11-18，一次填兩段第四階段）。全部假名、全程 mock 後端。

① 同一次送出的兩張待核單（同店、同 group、同人、同日）→ 併成一張卡：標題「姓名 加班兩段 共 N 小時」、兩段各一列＋各自核准／退回、底下「兩筆一起核准」；
   沒有 group 的單、只剩一張的 group 單，畫面跟以前完全一樣（一般卡片、沒有段落列）。
② 兩筆一起核准成功：依序送兩次既有的核准、兩張都核准、卡片消失、待處理數減 2。
③ 第二次失敗：第一段顯示已核准、第二段留著可以再按（再按成功後卡片消失）；第一次失敗：第二張不送、兩段都還在、仍可一起核准。
④ 各自退回一張（要寫原因）→ 另一張變回一般卡片。
⑤ 390 寬無橫向捲動；截圖存 E2E_SHOTS（預設 shots/）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, SHOTS, USERS, check, finish, start_server

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

PORT = 8867
OUT = os.environ.get('E2E_SHOTS') or SHOTS


def req(i, **kw):
    base = {'store': 'MDGF', 'storeName': '墨竹亭金山', 'id': i, 'kind': 'ot', 'label': '加班', 'date': '2026-11-15',
            'from': '11:00', 'to': '14:00', 'hours': 3, 'reason': '假日來客多，中午和晚上都留下來', 'status': 'pending', 'hasAttach': False,
            'createdAt': '2026-11-15 10:00', 'decidedBy': '', 'decidedAt': '', 'rejectReason': '', 'name': '林小美', 'group': '', 'seg': None}
    base.update(kw)
    return base


def pending():
    return [
        req('O1', group='gAB12', seg=1),
        req('O2', group='gAB12', seg=2, **{'from': '17:00', 'to': '21:00', 'hours': 4}),
        req('L1', kind='leave', label='病假', name='陳大文', storeName='小辛辣光復', date='2026-11-17', hours=8, reason='發燒去看醫生', hasAttach=True, **{'from': '', 'to': ''}),
    ]


def main():
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    mock.att_alerts = {'ok': True, 'data': {'items': [{'kind': 'request', 'count': 3}], 'partial': False, 'pending': False}}
    errors = []
    os.makedirs(OUT, exist_ok=True)

    cur = []

    def fresh(browser, items=None, fail=None):
        mock.att_req = {'reqPending': items if items is not None else pending(), 'reqMine': [], 'reqDecided': []}
        mock.att_decides = []
        mock.att_decide_fail = fail or {}
        while cur:
            cur.pop().close()      # 前一個情境的頁面先關（同時開著，這台機器偶爾載不出登入頁）
        for attempt in range(3):   # 這台機器上載頁偶爾卡住（既有的不穩，t23 也會）：整段（開頁、登入、切到待處理、等到卡片）逾時就重開一次，三次都不行才算失敗
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
        cur.append(ctx)
        return pg

    def head(pg):
        return pg.locator('[data-role="m-quick"] .m-grp.g-today').inner_text()

    def ids(pg):
        return [d['id'] for d in mock.att_decides]

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ① 併卡
            pg = fresh(browser)
            check(pg.locator('[data-role="quick-group"]').count() == 1, '①兩張同一次送出的單 → 一張組卡')
            check(pg.locator('[data-role="quick-card"]').count() == 1 and pg.locator('[data-role="quick-card"][data-id="MDGF|L1"]').count() == 1, '①沒有 group 的那張照舊是一般卡片')
            check(head(pg) == '可以直接核准（3）', '①標頭件數＝3 張單：%s' % head(pg))
            g = pg.locator('[data-role="quick-group"]')
            gt = g.inner_text()
            check('林小美 加班兩段 共 7 小時' in gt and '2026-11-15・墨竹亭金山' in gt and '原因：假日來客多' in gt, '①組卡標題、日期店名、原因：%r' % gt[:70])
            segs = g.locator('[data-role="quick-seg"]')
            check(segs.count() == 2 and '第 1 段' in segs.nth(0).inner_text() and '11:00–14:00' in segs.nth(0).inner_text() and '3 小時' in segs.nth(0).inner_text(), '①第 1 段一列：%r' % segs.nth(0).inner_text())
            check('第 2 段' in segs.nth(1).inner_text() and '17:00–21:00' in segs.nth(1).inner_text() and '4 小時' in segs.nth(1).inner_text(), '①第 2 段一列：%r' % segs.nth(1).inner_text())
            check(all(segs.nth(i).locator('button:has-text("核准")').count() == 1 and segs.nth(i).locator('button:has-text("退回")').count() == 1 for i in (0, 1)), '①每段各自有核准、退回')
            check(g.locator('[data-role="quick-group-ok"]').inner_text() == '兩筆一起核准', '①底下一顆「兩筆一起核准」')
            plain = pg.locator('[data-role="quick-card"][data-id="MDGF|L1"]')
            check(plain.locator('.g-seg').count() == 0 and plain.locator('button').count() == 2 and '陳大文 病假 8 小時' in plain.inner_text(), '①一般卡片沒有段落列、只有核准／退回兩顆')
            check(pg.evaluate('document.documentElement.scrollWidth') <= 390, '⑤390 寬無橫向捲動（併卡）')
            pg.screenshot(path=os.path.join(OUT, 'm390-1-group.png'))

            # ② 一起核准成功
            pg.locator('[data-role="quick-group-ok"]').click()
            pg.wait_for_selector('[data-role="quick-group"]', state='detached')
            check(ids(pg) == ['O1', 'O2'] and all(d['decision'] == 'approve' and d['store'] == 'MDGF' for d in mock.att_decides), '②依序送兩次既有核准（O1、O2）：%s' % mock.att_decides)
            check(pg.locator('[data-role="quick-card"]').count() == 1 and head(pg) == '可以直接核准（1）', '②待處理數減 2（3 → 1）：%s' % head(pg))
            pg.screenshot(path=os.path.join(OUT, 'm390-2-ok.png'))

            # ③ 第二次失敗：第一段已核准、第二段留著可再按
            pg = fresh(browser, fail={'O2': '系統忙碌，請再按一次'})
            pg.locator('[data-role="quick-group-ok"]').click()
            pg.wait_for_selector('[data-role="quick-group-note"]')
            notes = pg.locator('[data-role="quick-group-note"]').all_inner_texts()
            check(notes == ['✓ 第 1 段 11:00–14:00 已核准', '✕ 第 2 段沒有成功：系統忙碌，請再按一次'], '③照實顯示哪段成功、哪段失敗：%s' % notes)
            g = pg.locator('[data-role="quick-group"]')
            check(ids(pg) == ['O1'], '③只有第 1 張送進去：%s' % ids(pg))
            check(g.locator('[data-role="quick-seg"]').count() == 1 and g.locator('[data-role="quick-seg"][data-id="MDGF|O2"]').count() == 1, '③第 2 段留著')
            check(g.locator('[data-role="quick-group-ok"]').count() == 0, '③只剩一段：沒有「兩筆一起核准」')
            check(head(pg) == '可以直接核准（2）', '③待處理數 3 → 2：%s' % head(pg))
            check('林小美 加班兩段 共 7 小時' in g.inner_text(), '③標題仍是兩段合計')
            check(pg.evaluate('document.documentElement.scrollWidth') <= 390, '⑤390 寬無橫向捲動（只成功一張）')
            pg.screenshot(path=os.path.join(OUT, 'm390-3-partial.png'))
            mock.att_decide_fail = {}
            g.locator('[data-role="quick-seg"][data-id="MDGF|O2"] button:has-text("核准")').click()
            pg.wait_for_selector('[data-role="quick-group"]', state='detached')
            check(ids(pg) == ['O1', 'O2'], '③第 2 段再按成功：兩張都核准、卡片消失：%s' % ids(pg))

            # ③b 第一次失敗：第二張不送、兩段都還在
            pg = fresh(browser, fail={'O1': '連線逾時'})
            pg.locator('[data-role="quick-group-ok"]').click()
            pg.wait_for_selector('[data-role="quick-group-note"]')
            notes = pg.locator('[data-role="quick-group-note"]').all_inner_texts()
            check(notes == ['✕ 第 1 段沒有成功：連線逾時', '第 2 段沒有送出'], '③b第一次失敗：第 2 張沒有送：%s' % notes)
            check(ids(pg) == [] and pg.locator('[data-role="quick-seg"]').count() == 2 and pg.locator('[data-role="quick-group-ok"]').count() == 1, '③b兩段都還在、還能再按一起核准')
            mock.att_decide_fail = {}
            pg.locator('[data-role="quick-group-ok"]').click()
            pg.wait_for_selector('[data-role="quick-group"]', state='detached')
            check(ids(pg) == ['O1', 'O2'], '③b再按一起核准：成功')

            # ④ 各自退回一張 → 另一張變回一般卡片
            pg = fresh(browser)
            pg.locator('[data-role="quick-seg"][data-id="MDGF|O1"] button:has-text("退回")').click()
            pg.wait_for_selector('#m-quick-reason')
            pg.click('.dialog .btn:has-text("確定退回")')
            pg.wait_for_timeout(300)
            check(mock.att_decides == [] and pg.locator('[data-role="quick-group"]').count() == 1, '④退回沒寫原因：不送出、組卡還在')
            pg.locator('[data-role="quick-seg"][data-id="MDGF|O1"] button:has-text("退回")').click()
            pg.fill('#m-quick-reason', '那天不需要加班')
            pg.click('.dialog .btn:has-text("確定退回")')
            pg.wait_for_selector('[data-role="quick-group"]', state='detached')
            check(mock.att_decides == [{'store': 'MDGF', 'id': 'O1', 'decision': 'reject', 'reason': '那天不需要加班'}], '④退回帶原因送出：%s' % mock.att_decides)
            left = pg.locator('[data-role="quick-card"][data-id="MDGF|O2"]')
            check(left.count() == 1 and left.locator('.g-seg').count() == 0 and '林小美 加班 4 小時' in left.inner_text() and left.locator('button').count() == 2, '④另一張變回一般卡片：%r' % left.inner_text()[:40])
            check(head(pg) == '可以直接核准（2）', '④待處理數 3 → 2：%s' % head(pg))
            left.locator('button:has-text("核准")').click()
            pg.wait_for_selector('[data-role="quick-card"][data-id="MDGF|O2"]', state='detached')
            check(ids(pg) == ['O1', 'O2'] and mock.att_decides[1]['decision'] == 'approve', '④變回一般卡片後核准照舊')

            # ④b 各自核准一張 → 另一張一樣變回一般卡片
            pg = fresh(browser)
            pg.locator('[data-role="quick-seg"][data-id="MDGF|O2"] button:has-text("核准")').click()
            pg.wait_for_selector('[data-role="quick-group"]', state='detached')
            check(ids(pg) == ['O2'] and pg.locator('[data-role="quick-card"][data-id="MDGF|O1"]').count() == 1, '④b各自核准第 2 段：第 1 段變回一般卡片')

            # ⑥ 沒有 group／只剩一張還有 group／不同人同 group 鍵：都不併
            items = [req('A1'), req('A2', **{'from': '17:00', 'to': '21:00', 'hours': 4}),                                     # 沒有 group
                     req('B1', group='gSolo', seg=1),                                                                      # 另一張被取消後只剩一張
                     req('C1', group='gX', seg=1), req('C2', group='gX', seg=2, name='王大明', **{'from': '17:00', 'to': '21:00'})]   # 同 group 但不同人
            pg = fresh(browser, items=items)
            check(pg.locator('[data-role="quick-group"]').count() == 0 and pg.locator('[data-role="quick-card"]').count() == 5 and pg.locator('.g-seg').count() == 0, '⑥沒有 group、只剩一張、不同人：都是一般卡片（5 張）')
            check(head(pg) == '可以直接核准（5）', '⑥標頭件數：%s' % head(pg))
            pg.locator('[data-role="quick-card"][data-id="MDGF|A1"] button:has-text("核准")').click()
            pg.wait_for_selector('[data-role="quick-card"][data-id="MDGF|A1"]', state='detached')
            check(ids(pg) == ['A1'], '⑥一般卡片核准只送一次')

            check(not errors, '頁面無 JS 錯誤：%s' % errors[:3])
            check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
            browser.close()
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
