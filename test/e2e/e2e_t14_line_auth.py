#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑭-LINE：用 LINE 重設密碼（docs/line-auth/spec.md v1.2：R3 取消 LINE 開通）。全部假名、全程 mock、零真實網路。

假 LIFF（window.__LINE_AUTH_TEST__ 注入）＋ page.route 攔 <平台主機>/platform/svc/line-auth（mini 路由）：
① ?m=claim：只顯示「第一次使用請回登入頁按『第一次使用』」＋返回按鈕，不 init LIFF、不呼叫後端。
② 重設成功：?m=reset → 新密碼兩次 → 「密碼已更新，其他裝置已登出」＋前往登入鈕。
③ not_trusted 三條（wait／need_line_punch／sync_stale）＋「改用原本的方式」真的導回忘記密碼頁。
④ nonce 失效自動重新 check。
⑤ LINE_LIFF_ID 空：line.html「功能準備中」；登入頁沒有按鈕。填了（攔 config.js）：只有「用 LINE 重設密碼」連 liff.line.me?m=reset，沒有開通連結。
⑥ 同仁名單：「LINE 重設密碼」→ 看得到最近紀錄（時間＋中文類型）→ 「停用此人的 LINE 重設密碼」→ 確認 → 打 lineRevoke。
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, ROOT, SHOTS, check, finish, login, start_server

from playwright.sync_api import sync_playwright

PORT = 8830
LIFF_ID = '1234567890-AbCdEfGh'
ID_TOKEN = 'e2e-fake-id-token'

FAKE_LIFF = """
window.__LINE_AUTH_TEST__ = { liffId: '%s', liff: {
  init: async function () {}, isLoggedIn: function () { return true; }, login: function () {},
  getIDToken: function () { return '%s'; } } };
""" % (LIFF_ID, ID_TOKEN)


class LineMock:
    """mini /platform/svc/line-auth 的假路由。check 回 self.check_resp；claim／reset 回 self.write_resp（可排隊）。"""

    def __init__(self, url):
        self.url = url
        self.calls = []        # (headers, body dict)
        self.check_resp = {}
        self.write_resp = []   # 依序消耗；空了就回 done

    def install(self, page):
        page.route(self.url, self._route)

    def _route(self, route):
        req = route.request
        body = json.loads(req.post_data or '{}')
        self.calls.append((dict(req.headers), body, req.url))
        if body.get('op') == 'check':
            resp = self.check_resp
        elif self.write_resp:
            resp = self.write_resp.pop(0)
        else:
            resp = {'ok': True, 'mode': 'done', 'op': body.get('op')}
        route.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*'}, content_type='application/json', body=json.dumps(resp))


RESET = {'ok': True, 'mode': 'reset', 'name': '王小明', 'emp_no': 'DZY023', 'nonce': 'b' * 64}


def open_line(browser, mock, line, mode, with_hook=True):
    page = browser.new_context(viewport={'width': 375, 'height': 800}).new_page()
    mock.install(page)
    line.install(page)
    if with_hook:
        page.add_init_script(FAKE_LIFF)
    page.goto(BASE[0] + '/line.html?m=' + mode)
    return page


BASE = ['']


def main():
    httpd, base = start_server(PORT)
    BASE[0] = base
    mock = MockBackend(base)
    line_url = mock.urls['platform'][:-len('/api')] + '/svc/line-auth'
    line = LineMock(line_url)
    os.makedirs(SHOTS, exist_ok=True)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ① ?m=claim：只導回登入頁，不碰後端
            line.calls.clear()
            page = open_line(browser, mock, line, 'claim')
            page.wait_for_selector('[data-screen="claim_off"]')
            check('第一次使用請回登入頁按「第一次使用」' in page.inner_text('[data-role="message"]'), '★?m=claim：顯示「第一次使用請回登入頁按『第一次使用』」')
            check(page.locator('form').count() == 0 and not line.calls, '?m=claim：沒有表單、不呼叫後端')
            page.screenshot(path=os.path.join(SHOTS, 'line-claim-375.png'), full_page=True)
            page.click('[data-role="to-login"]')
            page.wait_for_selector('#login-username')
            check('index.html' in page.url, '返回按鈕回登入頁')

            # ② 重設成功
            line.calls.clear()
            line.check_resp = RESET
            page = open_line(browser, mock, line, 'reset')
            page.wait_for_selector('[data-screen="reset"]')
            check(page.inner_text('[data-role="who"]') == '王小明（DZY023）', '重設畫面顯示姓名與編號')
            page.fill('#line-pw', 'new-pw-12345')
            page.fill('#line-pw2', 'new-pw-12345')
            page.click('[data-role="submit"]')
            page.wait_for_selector('[data-screen="reset_done"]')
            check('密碼已更新，其他裝置已登出' in page.inner_text('[data-role="message"]'), '★重設成功畫面：密碼已更新，其他裝置已登出')
            rb = line.calls[1][1]
            check(rb == {'op': 'reset', 'id_token': ID_TOKEN, 'nonce': 'b' * 64, 'new_password': 'new-pw-12345'}, 'reset body 形狀（密碼只在 body）')
            page.click('[data-role="to-login"]')
            page.wait_for_selector('#login-username')
            check(True, '「前往登入」回登入頁')

            # ④ nonce 失效 → 自動重新 check，再按一次成功
            line.calls.clear()
            line.check_resp = RESET
            line.write_resp = [{'ok': False, 'error': 'bad_input', 'message': '這次驗證已失效', 'reason': 'nonce'}]
            page = open_line(browser, mock, line, 'reset')
            page.wait_for_selector('[data-screen="reset"]')
            page.fill('#line-pw', 'new-pw-12345')
            page.fill('#line-pw2', 'new-pw-12345')
            page.click('[data-role="submit"]')
            page.wait_for_selector('[data-role="error"]:has-text("已重新驗證，請再按一次送出")')
            check([c[1]['op'] for c in line.calls] == ['check', 'reset', 'check'], '★nonce 失效：自動重新 check：%s' % [c[1]['op'] for c in line.calls])
            page.click('[data-role="submit"]')
            page.wait_for_selector('[data-screen="reset_done"]')
            check(True, '再按一次送出成功')

            # ③ not_trusted 三條 + 改用原本的方式
            for reason, extra, want_text, mode in [
                ('wait', {'days_left': 3}, '你的 LINE 綁定還要 3 天才能用', 'reset'),
                ('need_line_punch', {'need_line_punch': True}, '請先用 LINE 打一次卡，隔天就能用', 'reset'),
                ('sync_stale', {}, '暫時無法確認，請改用原本的方式', 'reset'),
            ]:
                line.calls.clear()
                line.check_resp = dict({'ok': True, 'mode': 'not_trusted', 'reason': reason}, **extra)
                page = open_line(browser, mock, line, mode)
                page.wait_for_selector('[data-screen="not_trusted"]')
                check(want_text in page.inner_text('[data-role="message"]'), '★not_trusted %s：%s' % (reason, want_text))
                check(page.locator('form').count() == 0, 'not_trusted %s：沒有表單' % reason)
                if reason == 'wait':
                    page.screenshot(path=os.path.join(SHOTS, 'line-not-trusted-375.png'), full_page=True)
                page.click('[data-role="fallback"]')
                page.wait_for_selector('#forgot-emp')
                check('index.html' in page.url and page.url.endswith('#/forgot'), '「改用原本的方式」→ 忘記密碼頁：%s' % page.url)

            # ⑤ LINE_LIFF_ID 空：準備中；登入頁沒有兩顆按鈕；填了才出現
            line.calls.clear()
            page = open_line(browser, mock, line, 'reset', with_hook=False)
            page.wait_for_selector('[data-screen="preparing"]')
            check('功能準備中' in page.inner_text('[data-role="line-card"]') and not line.calls, '★LINE_LIFF_ID 空：line.html 顯示「功能準備中」、不打後端')
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            lp = ctx.new_page()
            mock.install(lp)
            lp.goto(base + '/index.html')
            lp.wait_for_selector('#login-username')
            check(lp.locator('[data-role="line-links"]').count() == 0, '★LINE_LIFF_ID 空：登入頁沒有「用 LINE 重設密碼」')
            cfg = open(os.path.join(ROOT, 'platform', 'config.js'), encoding='utf-8').read()
            check("LINE_LIFF_ID = ''" in cfg, 'config.js 預設 LINE_LIFF_ID 是空字串')
            patched = cfg.replace("LINE_LIFF_ID = ''", "LINE_LIFF_ID = '%s'" % LIFF_ID)
            lp2 = browser.new_context(viewport={'width': 375, 'height': 800}).new_page()
            mock.install(lp2)
            lp2.route('**/platform/config.js', lambda r: r.fulfill(status=200, content_type='application/javascript', body=patched))
            lp2.goto(base + '/index.html')
            lp2.wait_for_selector('[data-role="line-reset"]')
            check(lp2.get_attribute('[data-role="line-reset"]', 'href') == 'https://liff.line.me/%s?m=reset' % LIFF_ID
                  and lp2.locator('[data-role="line-claim"]').count() == 0 and lp2.locator('a[href*="m=claim"]').count() == 0, '★填了 LIFF ID：只有重設連到 liff.line.me?m=reset，沒有開通連結')
            check(lp2.inner_text('[data-role="line-reset"]') == '用 LINE 重設密碼' and '用 LINE 開通' not in lp2.inner_text('[data-role="line-links"]'), '按鈕文字：只有「用 LINE 重設密碼」')
            sw = lp2.evaluate('document.documentElement.scrollWidth')
            check(sw <= 375, '375 寬登入頁沒有橫向捲軸（%d）' % sw)
            lp2.screenshot(path=os.path.join(SHOTS, 'login-line-375.png'), full_page=True)

            # ⑥ 同仁名單：LINE 紀錄與停用鈕
            calls = []
            orig = mock.platform_action

            def pa(action, body):
                if action == 'lineAuthLog':
                    calls.append((action, body.get('payload')))
                    return {'ok': True, 'data': {'emp_no': 'DZY001', 'line_revoked_at': 0, 'items': [
                        {'at': '2026-10-25 10:00:00', 'type': 'line_claim_ok'},
                        {'at': '2026-10-24 09:30:00', 'type': 'line_fail'},
                        {'at': '2026-10-20 08:00:00', 'type': 'line_reset_ok'}]}}
                if action == 'lineRevoke':
                    calls.append((action, body.get('payload')))
                    return {'ok': True, 'data': {'emp_no': 'DZY001', 'line_revoked_at': 1761357600000}}
                return orig(action, body)
            mock.platform_action = pa
            mock.staff = [{'emp_no': 'DZY001', 'name': '測試一號', 'status': 'active', 'brand': 'mzt', 'unit': 'mzt-gf', 'title': 'pt', 'phone': '0912000111'}]
            admin = browser.new_context(viewport={'width': 1280, 'height': 800}).new_page()
            mock.install(admin)
            login(admin, base, 'admin')
            admin.click('[data-role="nav-desktop"] [data-nav="staff"]')
            admin.wait_for_selector('[data-act="line"][data-emp="DZY001"]')
            admin.click('[data-act="line"][data-emp="DZY001"]')
            admin.wait_for_selector('[data-role="line-log"]')
            items = admin.locator('[data-role="line-log-item"]').all_inner_texts()
            check(len(items) == 3 and '用 LINE 送出開通' in items[0] and '2026-10-25 10:00:00' in items[0]
                  and '失敗' in items[1] and '用 LINE 重設密碼' in items[2], '★同仁名單看得到 LINE 紀錄（時間＋中文類型）：%s' % items)
            check(calls[0] == ('lineAuthLog', {'emp_no': 'DZY001'}), '讀紀錄帶 emp_no')
            check(admin.locator('.dialog .btn-danger:has-text("停用此人的 LINE 重設密碼")').count() == 1, '★有「停用此人的 LINE 重設密碼」鈕')
            admin.screenshot(path=os.path.join(SHOTS, 'staff-line-1280.png'), full_page=True)
            admin.click('.dialog .btn-danger:has-text("停用此人的 LINE 重設密碼")')
            admin.wait_for_selector('.dialog .btn-primary:has-text("確定")')
            check('停用' in admin.inner_text('.dialog'), '停用前有二次確認')
            admin.click('.dialog .btn-primary:has-text("確定")')
            admin.wait_for_selector('.toast:has-text("已停用此人的 LINE 重設密碼")')
            check(calls[-1] == ('lineRevoke', {'emp_no': 'DZY001'}), '★確認後打 lineRevoke(emp_no)：%s' % (calls[-1],))
            # 取消不打
            n = len(calls)
            admin.click('[data-act="line"][data-emp="DZY001"]')
            admin.wait_for_selector('[data-role="line-log"]')
            admin.click('.dialog .btn:has-text("關閉")')
            check(len(calls) == n + 1 and calls[-1][0] == 'lineAuthLog', '關閉對話框不會停用')

            check(mock.leaked == [], '零流出：%s' % mock.leaked)
            browser.close()
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
