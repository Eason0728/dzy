"""e2e 第十七支（2026-10-26）：宿舍點交「下載給同仁（PDF）」
電腦（滑鼠）→ 直接下載；手機（觸控）→ 分享選單（注入假 navigator.share 驗證），分享失敗改按「直接下載」；
已簽摘要重新進來也能下載且不畫空白姓名／0 元；試跑模式鎖鈕不送出；只讀帳號拿不到。全程 mock、零真實網路。
原型：2026-10-26 Fable 審查的 e2e_mobile_share.py。
"""
import os
import sys
import time

E2E_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, E2E_DIR)
import common  # noqa: E402
from common import MockBackend, check, finish, login, start_server  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shots')
PORT = 8833

# 只讀權限的假帳號（只存在本程序記憶體裡）
common.USERS['ro'] = {'password': 'e2e-ro', 'user': {'id': 'u-ro', 'name': '只讀者', 'role': 'manager', 'node': ''},
                      'perms': ['dorm.read']}

SHARE_STUB = """
(() => {
  const mode = %r;   // 'ok' | 'reject' | 'abort'
  window.__shareCalls = [];
  navigator.canShare = (d) => !!(d && d.files && d.files.length);
  navigator.share = (d) => {
    const f = d && d.files && d.files[0];
    window.__shareCalls.push({ name: f && f.name, type: f && f.type, size: f && f.size,
      isFile: f instanceof File, title: d && d.title, activation: navigator.userActivation ? navigator.userActivation.isActive : null });
    if (mode === 'ok') return Promise.resolve();
    const e = new Error('stub');
    e.name = mode === 'abort' ? 'AbortError' : 'NotAllowedError';
    return Promise.reject(e);
  };
})();
"""


def draw_signature(page, sel):
    loc = page.locator(sel)
    loc.scroll_into_view_if_needed()
    box = loc.bounding_box()
    x, y = box['x'] + box['width'] / 3, box['y'] + box['height'] / 2
    page.mouse.move(x, y); page.mouse.down()
    for i in range(1, 6):
        page.mouse.move(x + i * 18, y + (8 if i % 2 else -8))
    page.mouse.up()


def run_handover(page, base, mock):
    """建單→(mock 設已簽)→開點交單→全部點選→簽名→送出；回傳點交 token。"""
    page.wait_for_selector('[data-role="module-card"][data-module="dorm"] .todo-head', timeout=8000)
    time.sleep(0.8)
    page.click('[data-role="module-card"][data-module="dorm"] .todo-head')
    page.wait_for_selector('[data-role="view-nav"] .nav-item:has-text("建立合約")', timeout=8000)
    page.click('[data-role="view-nav"] .nav-item:has-text("建立合約")')
    page.wait_for_selector('#dorm-create-name', timeout=8000)
    page.fill('#dorm-create-name', 'QA假人甲')
    page.select_option('#dorm-create-room', '二樓四人房')
    page.wait_for_selector('#dorm-create-bed-field:not([hidden])')
    page.select_option('#dorm-create-bed', '3號床位')
    page.fill('#dorm-create-start', '2026-10-01')
    page.click('text=建立並產生簽署連結')
    page.wait_for_selector('#dorm-create-result:not([hidden])', timeout=8000)
    c0 = list(mock.contracts.values())[-1]
    c0['status'] = '在住'; c0['signed_at'] = '2026-10-01 10:00'
    page.goto(base + '/index.html#/dorm/list')
    page.wait_for_selector('[data-role="contract-row"]', timeout=8000)
    page.locator('[data-action="open-handover"]').last.click()
    page.wait_for_selector('#dorm-handover-create', timeout=8000)
    page.click('#dorm-handover-create')
    page.wait_for_selector('.dialog .btn-primary', timeout=5000)
    page.click('.dialog .btn-primary')
    page.wait_for_selector('#dorm-handover-items li', timeout=8000)
    n = page.locator('#dorm-handover-items > li').count()
    page.locator('#dorm-handover-items > li').nth(0).locator('button:has-text("異常")').click()
    page.locator('#dorm-handover-items > li').nth(0).locator('button:has-text("未歸還")').click()
    for i in range(1, n):
        page.locator('#dorm-handover-items > li').nth(i).locator('button:has-text("正常")').first.click()
        page.locator('#dorm-handover-items > li').nth(i).locator('button:has-text("已歸還")').click()
    draw_signature(page, '#dorm-handover-pad')
    page.click('#dorm-handover-submit')
    page.wait_for_selector('text=點交完成', timeout=8000)
    page.wait_for_function(
        "() => { const b = document.querySelector('[data-act=handover-give]'); return b && !b.disabled; }", timeout=8000)
    return list(mock.handover_tokens.keys())[-1]


def main():
    httpd, base = start_server(PORT)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ---- A. 375 寬、無 navigator.share（headless chromium 預設）→ 直接下載 ----
            mock = MockBackend(base)
            ctx = browser.new_context(viewport={'width': 375, 'height': 812}, device_scale_factor=2, accept_downloads=True)
            page = ctx.new_page(); mock.install(page)
            login(page, base, 'mgr')
            tok = run_handover(page, base, mock)
            check(page.locator('[data-act="handover-give"]').is_enabled(), '截圖當下按鈕可按')
            time.sleep(0.6)  # 按鈕剛從「準備中」變可按，等底色漸變（.15s）結束再截圖
            page.screenshot(path=os.path.join(OUT, 'handover-done-375.png'), full_page=True)
            give = page.locator('[data-act="handover-give"]')
            box = give.bounding_box()
            check(box and box['x'] >= 0 and box['x'] + box['width'] <= 375, '375 寬：下載按鈕在視口內（bbox=%r）' % box)
            check(page.evaluate("document.documentElement.scrollWidth") <= 375, '375 寬：完成畫面沒有水平捲軸')
            check(give.inner_text() == '下載給同仁（PDF）', '按鈕文字＝下載給同仁（PDF）')
            has_share = page.evaluate("typeof navigator.share === 'function'")
            check(not has_share, 'headless chromium 沒有 navigator.share（所以走下載）')
            before = getattr(mock, 'pdf_downloads', 0)
            with page.expect_download(timeout=8000) as dl:
                give.click()
            d = dl.value
            check(d.suggested_filename.endswith('.pdf') and open(d.path(), 'rb').read(5) == b'%PDF-', 'A: 直接下載 PDF：%r' % d.suggested_filename)
            check(getattr(mock, 'pdf_downloads', 0) == before, 'A: 點擊不再重抓（預抓一次就夠）')
            check(('dorm', 'handoverPdf') in mock.proxy_calls, 'A: handoverPdf 走代轉 /platform/proxy')
            # 已簽摘要重新進來（帶 token）→ 也要有按鈕、也會預抓（＝後端多記一筆稽核）
            n0 = getattr(mock, 'pdf_downloads', 0)
            page.goto(base + '/index.html#/dorm/handover?token=' + tok)
            page.wait_for_selector('text=這張點交單已完成', timeout=8000)
            page.wait_for_function(
                "() => { const b = document.querySelector('[data-act=handover-give]'); return b && !b.disabled; }", timeout=8000)
            check(getattr(mock, 'pdf_downloads', 0) == n0 + 1, '已簽摘要重新進來：按鈕可用（預抓一次 PDF）')
            summ = page.locator('#dorm-handover-container').inner_text()
            check('0 元' not in summ and '賠償合計' not in summ, '已簽摘要：正式後端不回賠償，就不畫「賠償合計 0 元」：%r' % summ[:120])
            page.screenshot(path=os.path.join(OUT, 'handover-summary-375.png'), full_page=True)
            ctx.close()

            # ---- B/C/D. 觸控手機＋注入假 navigator.share ----
            for mode, label in (('ok', '分享成功'), ('reject', '分享失敗(NotAllowedError)→提示改按直接下載'), ('abort', '使用者取消(AbortError)→不下載')):
                mock = MockBackend(base)
                ctx = browser.new_context(viewport={'width': 375, 'height': 812}, has_touch=True, is_mobile=True, accept_downloads=True)
                ctx.add_init_script(SHARE_STUB % mode)
                page = ctx.new_page(); mock.install(page)
                login(page, base, 'mgr')
                run_handover(page, base, mock)
                check(page.evaluate("matchMedia('(pointer: coarse)').matches"), '%s：觸控 context 的 pointer 是 coarse' % label)
                give = page.locator('[data-act="handover-give"]')
                check(give.inner_text() == '傳給同仁（PDF）', '%s：手機主按鈕＝傳給同仁（PDF）：%r' % (label, give.inner_text()))
                check(page.locator('[data-act="handover-download"]').is_visible(), '%s：手機另有「直接下載」' % label)
                got_download = False
                try:
                    with page.expect_download(timeout=2500) as dl:
                        give.click()
                    got_download = dl.value is not None
                except Exception:
                    got_download = False
                calls = page.evaluate('window.__shareCalls')
                check(len(calls) == 1, '%s：navigator.share 被呼叫 1 次（實際 %d）' % (label, len(calls)))
                if calls:
                    c = calls[0]
                    check(c['isFile'] and c['type'] == 'application/pdf' and c['name'].endswith('.pdf') and c['size'] > 0,
                          '%s：share 帶的是 PDF File（%r）' % (label, c))
                    check(c['activation'] in (True, None), '%s：呼叫 share 當下 userActivation.isActive=%r' % (label, c['activation']))
                check(not got_download, '%s：按分享不會自己下載' % label)
                if mode == 'reject':
                    time.sleep(0.3)
                    hint = page.locator('[data-role="handover-give"] .field-hint').inner_text()
                    check('直接下載' in hint, '分享失敗：提示改按「直接下載」：%r' % hint)
                    with page.expect_download(timeout=8000) as dl2:
                        page.click('[data-act="handover-download"]')
                    check(open(dl2.value.path(), 'rb').read(5) == b'%PDF-', '分享失敗後按「直接下載」拿到 PDF')
                ctx.close()

            # ---- B2. 電腦（滑鼠）但瀏覽器支援分享（macOS Safari、Windows Chrome）→ 仍然直接下載 ----
            mock = MockBackend(base)
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True)
            ctx.add_init_script(SHARE_STUB % 'ok')
            page = ctx.new_page(); mock.install(page)
            login(page, base, 'mgr')
            run_handover(page, base, mock)
            give = page.locator('[data-act="handover-give"]')
            check(give.inner_text() == '下載給同仁（PDF）', '電腦：按鈕＝下載給同仁（PDF）')
            check(page.locator('[data-act="handover-download"]').count() == 0, '電腦：沒有多一顆直接下載')
            with page.expect_download(timeout=8000) as dl3:
                give.click()
            check(open(dl3.value.path(), 'rb').read(5) == b'%PDF-', '電腦＋支援分享：直接下載 PDF')
            check(page.evaluate('window.__shareCalls.length') == 0, '電腦：沒有呼叫分享')
            ctx.close()

            # ---- E. 試跑模式 ?dryrun=1 ----
            mock = MockBackend(base)
            ctx = browser.new_context(viewport={'width': 375, 'height': 812})
            page = ctx.new_page(); mock.install(page)
            login(page, base, 'mgr')
            tok = run_handover(page, base, mock)
            n_pdf_before = [c for c in mock.proxy_calls if c == ('dorm', 'handoverPdf')]
            page.goto(base + '/index.html?dryrun=1#/dorm/handover?token=' + tok)
            page.wait_for_selector('[data-act="handover-give"]', timeout=8000)
            time.sleep(0.8)
            txt = page.locator('[data-act="handover-give"]').inner_text()
            dis = page.locator('[data-act="handover-give"]').is_disabled()
            check(txt == '試跑模式不能下載點交單' and dis, 'E: dryrun 下按鈕鎖住並提示（%r, disabled=%r）' % (txt, dis))
            n_pdf_after = [c for c in mock.proxy_calls if c == ('dorm', 'handoverPdf')]
            check(len(n_pdf_after) == len(n_pdf_before), 'E: dryrun 下 handoverPdf 沒送出（前 %d 後 %d）' % (len(n_pdf_before), len(n_pdf_after)))
            ctx.close()

            # ---- F. 只讀帳號（dorm.read）拿不到 ----
            mock = MockBackend(base)
            ctx = browser.new_context(viewport={'width': 375, 'height': 812})
            page = ctx.new_page(); mock.install(page)
            login(page, base, 'mgr')
            tok = run_handover(page, base, mock)
            ctx.close()
            ctx = browser.new_context(viewport={'width': 375, 'height': 812})
            page = ctx.new_page(); mock.install(page)
            login(page, base, 'ro')
            time.sleep(1.5)
            page.goto(base + '/index.html#/dorm/handover?token=' + tok)
            time.sleep(1.5)
            body = page.locator('body').inner_text()
            nav = page.locator('[data-role="view-nav"] .nav-item').all_inner_texts()
            check('沒有權限' in body or '沒有退宿點交的權限' in body, 'F: 只讀者深連結點交分頁被擋（網址 %s；分頁列 %r；畫面含「沒有權限」=%r）' % (page.url.split('#')[-1], nav, '沒有權限' in body))
            check(page.locator('[data-act="handover-give"]').count() == 0, 'F: 只讀者畫面沒有下載按鈕')
            proxy_url = common.load_backend_urls()['proxy']
            status = page.evaluate("""async ([u, t]) => { const r = await fetch(u, {method:'POST', headers:{'Content-Type':'text/plain'},
                body: JSON.stringify({token:'e2e-token-ro', ns:'dorm', action:'handoverPdf', payload:{token:t}})}); return r.status; }""", [proxy_url, tok])
            check(status == 403, 'F: 只讀者直接打代轉 handoverPdf → 403（實際 %s）' % status)
            status2 = page.evaluate("""async ([u, t]) => { const r = await fetch(u, {method:'POST', headers:{'Content-Type':'text/plain'},
                body: JSON.stringify({token:'e2e-token-mgr', ns:'dorm', action:'handoverPdf', payload:{token:'not-signed-token'}})}); const j = await r.json(); return [r.status, j.ok, j.error]; }""", [proxy_url, tok])
            check(status2[0] == 200 and status2[1] is False, 'F: 有 dorm.write 但 token 不是已簽點交單 → ok:false（%r）' % (status2,))
            ctx.close()

            browser.close()
            check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
