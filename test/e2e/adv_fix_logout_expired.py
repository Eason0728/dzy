"""對抗驗證 ⑭：登出清 dzy.u.<id>.apv_draft_*（docs/approvals/spec.md §14.7「登出時清掉」）

攻擊路徑：被踢登出（代轉回 401 → shell setSessionExpiredHandler → doLogout({expired:true})）。
shell.js 只在「主動登出」那支分支呼叫 purgeLogoutDrafts，expired 分支走 auth.expireLocal() 不清草稿。
→ 共用電腦上 token 過期／別台裝置按了「全部裝置登出」，這台回到登入頁，本人的請購／請款草稿還留在 localStorage。

另一路（同根因）：兩個分頁同一帳號，分頁 A 主動登出清掉草稿；分頁 B 的請購表單還開著、再打一個字就把草稿寫回去，
之後分頁 B 收到 401 走 expired 路徑 → 草稿永遠留著。這裡只重現第一路。

跑法：python3 test/e2e/adv_fix_logout_expired.py（埠 9260）
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
from common import MockBackend, check, finish, login, start_server
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('ADV_PORT') or 9260)
DRAFT_KEY = 'dzy.u.u-acct.apv_draft_purchase'

httpd, base = start_server(PORT)
with sync_playwright() as pw:
    mock = MockBackend(base)
    browser, page = common.new_page(pw, mock)
    page.goto(base + '/index.html')
    page.evaluate("localStorage.setItem(%r, JSON.stringify({purpose: '機密採購', items: [{name: 'x', qty: 1, price: 999}]}))" % DRAFT_KEY)
    login(page, base, 'acct')   # acct 有 audit.read／audit.write → 盤點抽查會走代轉
    page.wait_for_timeout(800)
    check(page.evaluate("localStorage.getItem(%r)" % DRAFT_KEY) is not None, '前置：登入後草稿還在（登入不清是對的）')

    # 模擬「token 已在別台裝置登出／過期」：代轉從此一律 401
    mock.proxy = lambda body: (401, {'ok': False, 'error': '登入已失效', 'code': 'BAD_TOKEN'})
    # 稽核 getAll 有快取，直接換 hash 不一定再打代轉 → 重載頁面：restore() 走平台 me（照常 ok），首頁 badge 打代轉 getAll → 401
    page.reload()
    page.wait_for_selector('#login-username', timeout=15000)
    check(page.evaluate("!localStorage.getItem('dzy.token')") , '被踢登出：token 已清、回到登入頁')
    left = page.evaluate("Object.keys(localStorage).filter(k => k.indexOf('apv_draft') !== -1)")
    check(left == [], '★被踢登出後 apv_draft 草稿也要清掉（spec §14.7 登出時清掉）：留下 %s' % left)

    # 對照：同一台再「主動」登出一次確實會清（證明只有 expired 路徑漏）
    page.evaluate("localStorage.setItem(%r, '{\"purpose\":\"x\"}')" % DRAFT_KEY)
    mock.proxy = MockBackend.proxy.__get__(mock, MockBackend)
    login(page, base, 'acct')
    page.wait_for_timeout(500)
    common.cm.click(page, '[data-role="nav-desktop"] [data-nav="__logout__"]', '登出') if hasattr(common, 'cm') else page.click('[data-role="nav-desktop"] [data-nav="__logout__"]')
    page.wait_for_selector('#login-username', timeout=15000)
    left2 = page.evaluate("Object.keys(localStorage).filter(k => k.indexOf('apv_draft') !== -1)")
    check(left2 == [], '對照：主動登出有清：%s' % left2)
    check(mock.leaked == [], '沒有請求流出 mock：%s' % mock.leaked)
    browser.close()
httpd.shutdown()
finish()
