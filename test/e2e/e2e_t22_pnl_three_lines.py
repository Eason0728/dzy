#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ㉒：損益儀表板「每月三行」。真的損益後端（pnl_backend.mjs，埠 18936）＋站台埠 8836，零真實資料，不連通知匣（後端沒有通知匣密碼）。
驗：光復顯示且在儀表板最上面；文字與後端一致；草稿標示；定稿後標示消失；美村、全部門市不顯示；切店時舊三行不殘留；手機寬不破版。"""
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import USERS, MockBackend, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT, BPORT = 8836, 18936
KEEP = '[data-keep="pnl"]'
KEY = 'test-dzy-key-0123456789abcdef'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOT_DIR = os.environ.get('PNL_SHOT_DIR', '/tmp')
HOST = KEEP + ' [data-role="pnl-three-lines-host"]'
CARD = KEEP + ' [data-role="pnl-three-lines"]'
LINES = KEEP + ' [data-role="pnl-three-line"]'
DRAFT = KEEP + ' [data-role="pnl-three-draft"]'


def backend(inner, payload, level='admin'):
    body = {'action': 'dzyProxy', 'key': KEY, 'level': level, 'account': 'E2E', 'operator': 'e2e', 'inner': inner, 'payload': payload}
    req = urllib.request.Request('http://127.0.0.1:%d/pnl/api' % BPORT, data=json.dumps(body).encode(), headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode())


def main():
    proc = subprocess.Popen(['node', os.path.join(ROOT, 'test/e2e/pnl_backend.mjs'), str(BPORT)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    httpd = None
    try:
        for line in proc.stdout:
            if line.startswith('READY'):
                break
        else:
            raise SystemExit('損益後端沒有起來')
        os.environ['PNL_RUNNER'] = 'http://127.0.0.1:%d/pnl/api' % BPORT
        httpd, base = start_server(PORT)
        mock = MockBackend(base)
        USERS['pnladm'] = {'password': 'e2e-pw', 'perms': ['platform.self', 'pnl.admin'], 'user': {'id': 'u-pnladm', 'name': '損益管理者', 'role': 'staff', 'node': ''}}

        exp = backend('getMonth', {'store_id': 'S01', 'month': '2026-08'})['data']
        tl = exp.get('three_lines')
        check(bool(tl) and len(tl['lines']) == 3 and tl['draft'] is True, '後端前提：S01 2026-08 帶三行、草稿：%s' % tl)
        check('three_lines' not in backend('getMonth', {'store_id': 'S02', 'month': '2026-08'})['data'], '後端：美村沒有三行')
        check('three_lines' not in backend('getMonth', {'store_id': 'ALL', 'month': '2026-08'})['data'], '後端：全部門市沒有三行')

        with sync_playwright() as p:
            browser = p.chromium.launch()

            def new_page(w=1280, h=900):
                pg = browser.new_context(viewport={'width': w, 'height': h}).new_page()
                mock.install(pg)
                pg.goto(base + '/index.html')
                pg.fill('#login-username', 'pnladm')
                pg.fill('#login-password', USERS['pnladm']['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)
                pg.evaluate("location.hash = '#/pnl/dashboard'")
                pg.wait_for_selector(KEEP + ' [data-role="pnl-metric"]', timeout=20000)
                return pg

            def pick(pg, store=None, month=None):
                if store:
                    pg.select_option(KEEP + ' [data-role="pnl-store"]', store)
                if month:
                    pg.select_option(KEEP + ' [data-role="pnl-month"]', month)
                pg.wait_for_function("() => !document.querySelector('[data-keep=pnl] [data-role=pnl-skeleton]')", timeout=20000)
                pg.wait_for_selector(KEEP + ' [data-role="pnl-metric"]', timeout=20000)

            pg = new_page()
            pick(pg, 'S01', '2026-08')
            check(pg.locator(LINES).all_inner_texts() == tl['lines'], '光復：三行文字與後端一致：%s' % pg.locator(LINES).all_inner_texts())
            check('草稿' in pg.locator(DRAFT).inner_text(), '光復未定稿：有草稿標示（%s）' % pg.locator(DRAFT).inner_text())
            top = pg.evaluate("""() => {
              const root = document.querySelector('[data-keep=pnl]');
              const card = root.querySelector('[data-role=pnl-three-lines]').getBoundingClientRect();
              const head = root.querySelector('[data-role=pnl-dash-head]').getBoundingClientRect();
              const first = root.querySelector('[data-role=pnl-metric]').getBoundingClientRect();
              return { above: card.bottom <= head.top + 1, beforeMetrics: card.bottom <= first.top };
            }""")
            check(top['above'] and top['beforeMetrics'], '三行在儀表板最上面（篩選列與六列之上）：%s' % top)
            pg.screenshot(path=os.path.join(SHOT_DIR, 'pnl-three-lines-draft.png'))

            pick(pg, 'S02', '2026-08')
            check(pg.locator(CARD).count() == 0, '切到美村：不顯示三行、舊內容不殘留')
            pick(pg, 'ALL')
            check(pg.locator(CARD).count() == 0, '全部門市：不顯示三行')
            opts = pg.locator(KEEP + ' [data-role="pnl-month"] option').evaluate_all('e => e.map(x => x.value)')
            check('2026-08' in opts, '月份清單前提')
            pick(pg, 'S01', '2026-08')
            check(pg.locator(LINES).count() == 3, '切回光復：三行重新出現')

            r = backend('finalize', {'store_id': 'S01', 'month': '2026-08', 'zero_confirm': exp['result']['pending'], 'client_id': 'e2e-three-lines-1'})
            check(r.get('ok') is True, '定稿（假資料）：%s' % json.dumps(r, ensure_ascii=False)[:160])
            # 測試後端沒有通知匣密碼，定稿通知會立刻徹底失敗（NO_TOKEN）：等它落定，順便驗失敗提示看得到
            final = None
            for _ in range(40):
                final = backend('getMonth', {'store_id': 'S01', 'month': '2026-08'})['data']['three_lines']
                if len(final['lines']) == 4:
                    break
                time.sleep(0.25)
            check(len(final['lines']) == 4, '定稿通知失敗：後端回第四行提示：%s' % final['lines'])
            pg.reload()
            pg.wait_for_selector('[data-role="module-card"], ' + KEEP, state='attached', timeout=10000)
            pg.evaluate("location.hash = '#/pnl/dashboard'")
            pg.wait_for_selector(KEEP + ' [data-role="pnl-metric"]', timeout=20000)
            pick(pg, 'S01', '2026-08')
            check(pg.locator(LINES).all_inner_texts() == final['lines'] and pg.locator(DRAFT).count() == 0, '定稿後：畫面與後端一致（含通知失敗提示）、沒有草稿標示')
            check('定稿通知沒有送出' in pg.locator(LINES).nth(3).inner_text(), '定稿通知失敗：儀表板看得到提示')
            pg.screenshot(path=os.path.join(SHOT_DIR, 'pnl-three-lines-final.png'))
            pg.context.close()

            pg = new_page(375, 800)
            pick(pg, 'S01', '2026-08')
            sw = pg.evaluate('document.documentElement.scrollWidth')
            check(pg.locator(LINES).count() == 4 and sw <= 376, '375 寬：三行與提示都顯示、沒有橫向捲動（scrollWidth=%d）' % sw)
            pg.screenshot(path=os.path.join(SHOT_DIR, 'pnl-three-lines-375.png'))
            pg.context.close()
            browser.close()
        check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        if httpd:
            httpd.shutdown()
        proc.terminate()
    finish()


if __name__ == '__main__':
    main()
