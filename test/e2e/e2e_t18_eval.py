#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑱：績效評核（modules/eval）。後端＝本機 Node 把 apps-script/platform 的 .gs 載進 vm（eval_backend.mjs），
瀏覽器打正式平台網址的請求一律 route 到它；全部假名、零真實網路。

① 計時同仁（1280）：首頁提醒 → 填寫評鑑（評完一位＋評一半一位 → 確認框列出沒評完的人 → 送出）→ 自評＋夥伴留言 → 改日期到 1/12 看我的成績。
② 墨竹亭計時：填寫名單只有墨竹亭同店的人（兩家店互相看不到）。
③ 店長（375）：新人考核（逾期標紅、送出）→ 單位結果只看得到自己店 → 打正職 KPI（即時合計）→ 存加減分與回饋；每頁不撐出橫向捲軸。
④ 計時直打主管分頁網址 → 被擋。
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import check, finish, load_backend_urls, start_server

from playwright.sync_api import sync_playwright

PORT = 8775
BACKEND_PORT = 8771
PW = 'fake-staff-pw-1'
HERE = os.path.dirname(os.path.abspath(__file__))


def start_backend():
    env = dict(os.environ, PORT=str(BACKEND_PORT), TODAY='2027-01-03')
    proc = subprocess.Popen(['node', os.path.join(HERE, 'eval_backend.mjs')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    accounts = None
    deadline = time.time() + 20
    while time.time() < deadline:
        line = proc.stdout.readline()
        if line.startswith('ACCOUNTS '):
            accounts = json.loads(line[len('ACCOUNTS '):])
        if '測試後端' in line:
            return proc, accounts
    proc.kill()
    raise SystemExit('eval 測試後端沒有啟動')


def set_today(d):
    urllib.request.urlopen('http://127.0.0.1:%d/__today?d=%s' % (BACKEND_PORT, d), timeout=5).read()


def install_routes(page, urls):
    # 用 context.route：page.route('https://**') 攔不到殼裡其他模組打的代轉請求，會真的打到 Mac mini（審查 #14）
    # 2026-10-28 審查 #10：'https://**' 這個 glob 實測攔不到 → 改用 regex（同 e2e_t19_inspection.py），本機以外一律先過 guard
    target = page.context
    real = urls['platform']
    proxy = urls['proxy']   # <平台主機>/platform/proxy：殼的其他模組（稽核提醒等）打代轉，也導回本機假後端

    def fwd(path):
        def handle(route):
            req = route.request
            data = req.post_data.encode('utf-8') if req.post_data else b''
            r = urllib.request.Request('http://127.0.0.1:%d/platform%s' % (BACKEND_PORT, path), data=data, headers={'Content-Type': 'text/plain'})
            body = urllib.request.urlopen(r, timeout=20).read()
            route.fulfill(status=200, headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}, body=body)
        return handle
    leaks = []
    def guard(route):
        if route.request.url.split('?')[0] in (real, proxy):
            return route.fallback()   # 交給下面的本機後端轉送
        leaks.append(route.request.url)
        return route.abort()
    target.route(re.compile(r'^https?://(?!127\.0\.0\.1)'), guard)   # 先註冊＝最後才跑；Playwright 後註冊的先處理
    target.route(proxy, fwd('/proxy'))
    target.route(real, fwd('/api'))
    return leaks


def login(page, base, user):
    page.goto(base + '/index.html')
    page.fill('#login-username', user)
    page.fill('#login-password', PW)
    page.click('[data-role="submit"]')
    page.wait_for_selector('[data-role="view-content"]', state='attached', timeout=10000)
    # 等選單（模組清單）載完再直接打網址，不然殼會先把人導回首頁
    page.wait_for_selector('[data-nav="eval"]', state='attached', timeout=10000)


def no_hscroll(page):
    return page.evaluate('() => document.documentElement.scrollWidth <= window.innerWidth + 1')


def click_confirm(page):
    page.locator('.dialog button', has_text='確定').dispatch_event('click')


def main():
    urls = load_backend_urls()
    proc, acc = start_backend()
    httpd, base = start_server(PORT)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            # ── ① 計時同仁 ──
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            page = ctx.new_page()
            leaks = install_routes(page, urls)
            login(page, base, acc['pt1'])
            page.wait_for_selector('text=本季績效互評還沒填', timeout=10000)
            check(True, '① 首頁提醒「本季績效互評還沒填」')
            page.goto(base + '/index.html#/eval/fill')
            page.wait_for_selector('[data-role="ev-person"]', timeout=10000)
            names = page.locator('[data-role="ev-person"] summary').all_inner_texts()
            check(len(names) == 4 and not any('墨竹亭' in n for n in names), '① 名單是同店 4 人、沒有墨竹亭：%s' % names)
            persons = page.locator('[data-role="ev-person"]')
            p0 = persons.nth(1)
            p0.locator('summary').click()
            items = p0.locator('[data-role="ev-item"]')
            for i in range(items.count()):
                items.nth(i).locator('[data-star="%d"]' % ((i % 5) + 1)).click()
            check('已評完' in p0.locator('[data-role="state"]').inner_text(), '① 點滿一位 → 顯示已評完')
            p1 = persons.nth(2)
            p1.locator('summary').click()
            p1.locator('[data-role="ev-item"] [data-star="3"]').first.click()
            check('評到一半' in p1.locator('[data-role="state"]').inner_text(), '① 只點一題 → 評到一半')
            page.reload()
            page.wait_for_selector('[data-role="restored"]', timeout=10000)
            check(True, '① 重新整理 → 還原草稿')
            page.click('[data-role="submit"]')
            dlg = page.locator('.dialog').inner_text()
            check('還有 3 位沒評完' in dlg, '① 確認框列出沒評完的人：%s' % dlg[:60])
            click_confirm(page)
            page.wait_for_selector('text=你已送出本季互評', timeout=10000)
            check(True, '① 送出後顯示已送出、不能再填')

            page.goto(base + '/index.html#/eval/self')
            page.wait_for_selector('#ev-note', timeout=10000)
            its = page.locator('[data-role="ev-item"]')
            for i in range(its.count()):
                its.nth(i).locator('[data-star="4"]').click()
            page.fill('#ev-note', '下一季要更快')
            row = page.locator('[data-role="peer-row"]').first
            row.locator('[data-f="to"]').select_option(index=1)
            row.locator('[data-f="msg"]').fill('謝謝你常幫我補料')
            check(row.locator('[data-f="anon"]').is_checked(), '① 夥伴留言預設匿名')
            page.click('[data-role="submit"]')
            click_confirm(page)
            page.wait_for_selector('text=你已送出本季自評', timeout=10000)
            check(True, '① 自評送出')

            set_today('2027-01-12')
            page.goto(base + '/index.html#/eval/mine')
            page.wait_for_selector('[data-role="detail"] table', timeout=10000)
            txt = page.locator('[data-role="ev-wrap"], .ev-wrap').first.inner_text()
            check('2026 年第 4 季' in txt and '下一季要更快' in txt and '落點' in txt, '① 1/12 我的成績有本季、寫給自己的話、時薪落點')
            set_today('2027-01-03')
            check(not leaks, '① 沒有任何請求跑到外網：%s' % leaks)
            ctx.close()

            # ── ② 墨竹亭計時 ──
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            page = ctx.new_page()
            install_routes(page, urls)
            login(page, base, acc['mpt'])
            page.goto(base + '/index.html#/eval/fill')
            page.wait_for_selector('[data-role="ev-person"]', timeout=10000)
            names = page.locator('[data-role="ev-person"] summary').all_inner_texts()
            check(len(names) == 1 and '墨竹亭店長' in names[0], '② 墨竹亭計時只看到墨竹亭店長：%s' % names)
            ctx.close()

            # ── ③ 店長（手機寬）──
            ctx = browser.new_context(viewport={'width': 375, 'height': 812})
            page = ctx.new_page()
            install_routes(page, urls)
            login(page, base, acc['sm'])
            page.goto(base + '/index.html#/eval/newbie')
            page.wait_for_selector('[data-role="ev-newbie"]', timeout=10000)
            check('已逾期' in page.locator('[data-role="ev-newbie"] summary').inner_text(), '③ 新人考核：滿月未考標逾期')
            check(no_hscroll(page), '③ 新人考核 375px 沒有橫向捲軸')
            nb = page.locator('[data-role="ev-newbie"]').first
            nb.locator('summary').dispatch_event('click')
            ni = nb.locator('[data-role="ev-item"]')
            # 375px 時直接送 click 事件：座標點擊會把星星捲到黏在頂端的手機選單底下，點到選單按鈕（測試手法問題，不是畫面問題）
            for i in range(ni.count()):
                ni.nth(i).locator('[data-star="4"]').dispatch_event('click')
            nb.locator('[data-role="submit"]').dispatch_event('click')
            click_confirm(page)
            page.wait_for_selector('text=目前沒有待考核的新人', timeout=10000)
            check(True, '③ 新人考核送出後從清單消失')

            page.goto(base + '/index.html#/eval/results')
            page.wait_for_selector('#ev-unit', timeout=10000)
            opts = page.locator('#ev-unit option').all_inner_texts()
            check(len(opts) == 1 and '新竹光復' in opts[0], '③ 店長的單位只有自己店：%s' % opts)
            check(no_hscroll(page), '③ 單位結果 375px 沒有橫向捲軸（表格自己捲）')
            page.locator('[data-role="open"]', has_text='正職丁').dispatch_event('click')
            page.wait_for_selector('[data-role="kpi-row"]', timeout=10000)
            rows = page.locator('[data-role="kpi-row"]')
            for i in range(rows.count()):
                sel = rows.nth(i).locator('[data-f="sel"]')
                opts2 = sel.locator('option').all_inner_texts()
                sel.select_option('完成' if '完成' in opts2 else 'A')
            check(page.locator('[data-role="kpi-total"]').inner_text().strip() == '70', '③ KPI 全 A／完成 → 即時合計 70')
            page.locator('[data-role="save-kpi"]').dispatch_event('click')
            page.wait_for_selector('text=✅ 已儲存', timeout=10000)
            row = page.locator('[data-role="ev-row"]', has_text='正職丁').inner_text()
            check('70' in row, '③ 存檔後總覽表現欄變 70：%s' % row.replace('\t', ' '))
            page.fill('#ev-feedback', '這季帶新人很用心')
            page.locator('[data-role="save-sup"]').dispatch_event('click')
            page.wait_for_function("() => (document.querySelector('[data-role=\"sup-msg\"]')||{}).textContent === '✅ 已儲存'", timeout=10000)
            check(True, '③ 回饋存檔')
            ctx.close()

            # ── ④ 計時直打主管分頁 ──
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            page = ctx.new_page()
            install_routes(page, urls)
            login(page, base, acc['pt2'])
            page.goto(base + '/index.html#/eval/results')
            time.sleep(1.5)
            check('#/eval/results' not in page.url or page.locator('#ev-unit').count() == 0, '④ 計時同仁進不了單位結果')
            check(page.locator('[data-role="view-nav"] .nav-item', has_text='單位結果').count() == 0, '④ 計時看不到「單位結果」分頁')
            ctx.close()
            browser.close()
    finally:
        httpd.shutdown()
        proc.kill()
    finish()


if __name__ == '__main__':
    main()
