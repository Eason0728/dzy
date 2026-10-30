#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""資料帶入測試：首頁殼＋表單簽核＋我的資料＋公告專區（Playwright，全程 mock、外網一律擋）。

- 資料每次全部重抽（dd_home_mock.Dataset）：同仁假名、空缺職位（總監／執行長／總經理可能缺）、核決權限級距、單據金額。
  印出種子，E2E_SEED=<種子> 重現。
- 預期的簽核人、金額由本檔照 spec 自己再算一次（expect_route／expect_amount），不拿 mock 的算式當預期。
- 每進一個畫面掃描可點元素（ClickMap），結束時漏點的報失敗。
- 角色：計時同仁、店長、品牌總監（可能缺）、總經理（可能缺）、董事長、人資、採購承辦、財務承辦、admin。
- 截圖：test/dd/artifacts/home/。
跑法：python3 test/e2e/dd_home_ui.py（埠 9220–9239 之間）
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
from common import ROOT, USERS, failures, finish, login, start_server

_TOTAL = [0]


def check(cond, label):
    _TOTAL[0] += 1
    common.check(cond, label)

from dd_home_mock import Dataset, HomeMock, ROLES, TITLE, UNITS, HOUR
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('DD_PORT') or 9221)
SEED = int(os.environ.get('E2E_SEED') or (int(time.time() * 1000) % 1000000007))
SHOT_DIR = os.path.join(ROOT, 'test', 'dd', 'artifacts', 'home')
EXTERNAL = re.compile(r'^https?://(?!127\.0\.0\.1)')
TINY_JPEG = __import__('base64').b64decode('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=')
BULLETIN = 'https://dzy-bulletin.github.io'
ROLE_LABEL = {'head': '單位主管', 'brand_dir': '品牌總監／廚藝總監', 'ceo': '執行長', 'gm': '總經理', 'chair': '董事長', 'direct': '直屬主管', 'self_sign': '本人簽名'}

print('SEED=%d（重現：E2E_SEED=%d python3 test/e2e/dd_home_ui.py）' % (SEED, SEED))
ds = Dataset(SEED)
P = ds.people
print('人員：' + '、'.join('%s=%s(%s/%s)' % (k, p['emp'], p['unit'], p['title']) for k, p in P.items()) + '；空缺：' + (','.join(ds.vacant) or '無'))
print('權限表：' + json.dumps(ds.rows, ensure_ascii=False))
blocked = []
console_errors = []


# ── 預期值（照 spec §2／§5.2 獨立算，不用 mock 的函式）────────────
def expect_route(sender_key, amount):
    """回 (row, first_role, final_role_or_None, cands_keys)"""
    s = P[sender_key]
    row = next(r for r in ds.rows if r['max'] is None or amount <= r['max'])
    hq = s['unit'] == 'dzy-hq'
    role = row['hq_role'] if hq else row['store_role']
    first = role
    srank, slad = TITLE[s['title']][1], TITLE[s['title']][0]
    while True:
        c = []
        for k, p in P.items():
            if k == sender_key:
                continue
            plad, prank = TITLE[p['title']][0], TITLE[p['title']][1]
            if role == 'head':
                hit = (not hq and p['unit'] == s['unit'] and p['title'] == 'sm') or (hq and p['unit'] == 'dzy-hq' and p['dept'] == s['dept'] and p['title'] == 'hm')
            elif role == 'brand_dir':
                hit = p['title'] == 'odir' and UNITS[p['unit']][1] == UNITS[s['unit']][1]
            else:
                hit = p['title'] == role
            if hit and not (plad == slad and prank <= srank):
                c.append(k)
        if c:
            return row, first, role, sorted(c)
        if role == 'chair':
            return row, first, None, []
        role = ROLES[ROLES.index(role) + 1]


def expect_amount(items):
    return sum(int(q * p + 0.5) for q, p in items)


def pick_amount(rng, want_signing=True, prefer=None):
    """挑一個金額：落在某一列、路線要是 signing（或 exception）；prefer＝希望的簽核人 key"""
    cands = []
    for r in ds.rows:
        lo = 1 if r['seq'] == 1 else ds.rows[r['seq'] - 2]['max'] + 1
        hi = r['max'] if r['max'] is not None else lo + 50000
        for a in (lo, hi, rng.randint(lo, hi)):
            row, first, final, c = expect_route('pt', a)
            if want_signing and final is None:
                continue
            if not want_signing and final is not None:
                continue
            if prefer and prefer not in c:
                continue
            cands.append(a)
    return rng.choice(cands) if cands else None


# ── 按鈕稽核（抄 clickmap.py 的做法，key 規則兩邊同一段）─────────────
_KEY = """
  const t = e.tagName.toLowerCase();
  if (e.dataset && e.dataset.nav) return t + '[data-nav=' + e.dataset.nav + ']';
  if (e.dataset && e.dataset.navDept) return t + '[data-nav-dept=' + e.dataset.navDept + ']';
  if (e.dataset && e.dataset.view) return t + '[data-view=' + e.dataset.view + ']';
  if (e.dataset && e.dataset.act) return t + '[data-act=' + e.dataset.act + ']';
  if (e.dataset && e.dataset.type) return t + '[data-type=' + e.dataset.type + ']';
  if (e.dataset && e.dataset.pick) return t + '[data-pick=' + e.dataset.pick + ']';
  if (e.dataset && e.dataset.role) return t + '[data-role=' + e.dataset.role + ']';
  if (e.id) return '#' + e.id.replace(/-\\d+$/, '-N');
  const cls = (typeof e.className === 'string' && e.className.trim()) ? '.' + e.className.trim().split(/\\s+/)[0] : '';
  if (t === 'select' || t === 'input') return t + cls;
  const txt = (e.textContent || e.value || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
  return t + '「' + txt + '」';
"""
SCAN_JS = "() => { const keyOf = (e) => {%s}; const sel = 'button, a[href], summary, select, input[type=radio]'; return [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null || e.tagName === 'SUMMARY').map(keyOf); }" % _KEY
KEY_JS = "(e) => { const keyOf = (e) => {%s}; return keyOf(e); }" % _KEY
SKIP = {
    'a「在新分頁開啟」': '外部連結（佈告欄站台），target=_blank，外網守門只驗 href',
    'button[data-nav=__password__]': '改密碼是平台功能，不在本組範圍',
    'button「取消」': '對話框取消鈕（各處同一顆）',
    'button「再檢查」': '送出前對話框的返回鈕',
    'button「知道了」': '預覽路線對話框關閉鈕',
    'button[data-act=clear-sign]': '簽名板清除（簽名流程由 t13 覆蓋）',
    'button[data-act=clear]': '簽名對話框清除',
    'button[data-act=del-item]': '刪除品項列（由 add-item 反向覆蓋，流程不需要）',
    'button[data-act=del]': '核決權限刪除一級（t13 已驗，本檔只驗新增與儲存）',
    '#me-brand': '個人資料改組織欄要後台確認（同仁名單組範圍），本組只驗手機／地址',
    '#me-unit': '同上', '#me-dept': '同上', '#me-title': '同上',
}


class ClickMap:
    def __init__(self):
        self.seen, self.clicked = {}, {}

    def scan(self, page, screen):
        for k in page.evaluate(SCAN_JS):
            if k:
                self.seen.setdefault(k, screen)

    def click(self, page, sel, verified, **kw):
        loc = page.locator(sel).first
        key = loc.evaluate(KEY_JS)
        loc.click(**kw)
        if key:
            self.clicked[key] = verified
        return key

    def mark(self, key, verified):
        self.clicked[key] = verified

    @staticmethod
    def skip_rule(k):
        m = re.match(r'button\[data-nav=([a-z-]+)\]$', k)
        if m and m.group(1) not in ('__home__', 'me', 'bulletin', 'approvals', '__logout__', '__password__'):
            return '其他部門模組的側邊欄入口（不在本組範圍）'
        if re.match(r'button\[data-nav-dept=', k):
            return '部門收合標題（只驗第一個）'
        return None

    def report(self):
        missed = {k: v for k, v in self.seen.items() if k not in self.clicked and k not in SKIP and not self.skip_rule(k)}
        return {'total': len(self.seen), 'clicked': len(self.clicked), 'missed': missed}


cm = ClickMap()


def shot(page, name):
    os.makedirs(SHOT_DIR, exist_ok=True)
    page.screenshot(path=os.path.join(SHOT_DIR, name + '.png'), full_page=False)


def calls(mock, action):
    return [c for c in mock.apv_state['calls'] if c[0] == action]


def dlg(page, label):
    cm.mark('button「%s」' % label, '對話框按鈕 ' + label)
    page.locator('.dialog-actions .btn', has_text=label).click()


def goto_tab(page, name):
    cm.click(page, '[data-role="view-nav"] .nav-item:has-text("%s")' % name, '分頁 ' + name)
    wait_view(page, name)
    page.wait_for_function("() => !document.querySelector('[data-role=\"view-content\"]').innerText.includes('讀取中')", timeout=8000)


def wait_view(page, name):
    """等殼真的切到該分頁（hashchange 之後 route() 才跑；只看 location.hash 會搶先）"""
    page.wait_for_function("(n) => { const a = document.querySelector('[data-role=\"view-nav\"] .nav-item.is-active'); return !!a && a.textContent.trim() === n; }", arg=name, timeout=8000)


def wait_home(page):
    page.wait_for_selector('[data-role="module-card"]', timeout=10000)
    page.wait_for_function("() => ![...document.querySelectorAll('[data-role=\"alert-list\"]')].some(e => e.innerText.includes('讀取中'))", timeout=10000)


def alert_rows(page, module):
    return page.locator('[data-role="alert-list"][data-module="%s"] [data-role="alert-row"]' % module).evaluate_all(
        "els => els.map(e => ({text: e.querySelector('.tx').textContent, target: e.dataset.target || null, level: [...e.classList].find(c => c.startsWith('lv-'))}))")


def alert_empty(page, module):
    return page.locator('[data-role="alert-list"][data-module="%s"] .todo-empty' % module).all_inner_texts()


def expected_nav(page, perms):
    """照 manifest.requires（任一符合）＋ can()（platform.login 人人有、* 全有）算這個人該看到的模組與部門群組"""
    return page.evaluate("""async (perms) => { const { MODULES } = await import('/platform/registry.js'); const { DEPARTMENTS } = await import('/platform/config.js');
        const can = (p) => p === 'platform.login' || perms.includes('*') || perms.includes(p);
        const ms = []; for (const m of MODULES) ms.push((await m.load()).default);
        const ok = ms.filter(m => (m.requires || []).some(can));
        const depts = DEPARTMENTS.map(d => d.id).filter(d => ok.some(m => m.dept === d));
        return { top: ok.filter(m => !m.dept).map(m => m.id), inDept: depts.flatMap(d => ok.filter(m => m.dept === d).map(m => m.id)), depts }; }""", perms)


def overflow(page):
    return page.evaluate('document.documentElement.scrollWidth')


def new_page(browser, mock, width=1280, height=900):
    ctx = browser.new_context(viewport={'width': width, 'height': height}, accept_downloads=True)
    page = ctx.new_page()
    page.route(EXTERNAL, lambda route: (blocked.append(route.request.url), route.abort()))   # 外網守門：先註冊，mock 後註冊優先
    page.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: console_errors.append('pageerror: %s' % e))
    mock.install(page)
    return ctx, page


def login_as(browser, mock, key, width=1280, height=900):
    ctx, page = new_page(browser, mock, width, height)
    login(page, '%s' % mock.base_url, 'admin' if key == 'admin' else P[key]['emp'])
    wait_home(page)
    return ctx, page


def main():
    import random
    rng = random.Random(SEED + 7)
    httpd, base = start_server(PORT)
    mock = HomeMock(base, ds)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()

            # ════════════ ① 計時同仁：首頁殼、公告專區、送單、我的單 ════════════
            ctx, pt = login_as(browser, mock, 'pt')
            cm.scan(pt, 'pt 首頁')
            ids = pt.locator('[data-role="module-card"]').evaluate_all('els => els.map(e => e.dataset.module)')
            exp_nav = expected_nav(pt, P['pt']['perms'])
            exp_cards = pt.evaluate("""async (perms) => { const { MODULES } = await import('/platform/registry.js'); const can = (p) => p === 'platform.login' || perms.includes(p);
                const out = []; for (const m of MODULES) { const d = (await m.load()).default; if ((d.requires || []).some(can)) out.push(d.id); } return out; }""", P['pt']['perms'])
            check(ids == exp_cards and ids[:3] == ['me', 'bulletin', 'approvals'], '★計時同仁（platform.self）首頁只有有權限的模組、依 registry 順序（我的資料／公告專區／表單簽核排最前）：%s' % ids)
            depts = pt.locator('[data-role="nav-desktop"] [data-dept]').evaluate_all('els => els.map(e => e.dataset.dept)')
            check(depts == exp_nav['depts'] and pt.locator('[data-role="nav-desktop"] .nav-label').count() == (1 if depts else 0), '★計時同仁側邊欄只有「有功能的部門」群組（沒有就連標籤也不畫）：%s' % depts)
            nav = pt.locator('[data-role="nav-desktop"] [data-nav]').evaluate_all('els => els.map(e => e.dataset.nav)')
            check(nav == ['__home__'] + exp_nav['top'] + exp_nav['inDept'] + ['__password__', '__logout__'], '側邊欄項目＝首頁、無部門模組、部門內模組、改密碼、登出：%s' % nav)
            # 兩張種子單：卡關請款（簽核中）、承辦中請購 → 計時同仁不是簽核人，也不是承辦 → 沒有待辦
            check(alert_empty(pt, 'approvals') == ['沒有待辦'] and alert_rows(pt, 'approvals') == [], '表單簽核組：計時同仁沒有待辦 → 「沒有待辦」')
            check(alert_empty(pt, 'me') == ['沒有待辦'], '我的資料組：資料已確認、不是主管 → 「沒有待辦」')
            br = alert_rows(pt, 'bulletin')
            check(br == [{'text': '集團公告與簽名回條', 'target': '#/bulletin/board', 'level': 'lv-note'}], '★公告專區沒有 alerts()／badge → 顯示模組說明、導向 #/bulletin/board：%s' % br)
            shot(pt, 'pt-home-1280')

            # 公告專區：alert 列點進去
            cm.click(pt, '[data-role="alert-list"][data-module="bulletin"] [data-role="alert-row"]', '導向 #/bulletin/board')
            pt.wait_for_selector('[data-role="bulletin-frame"]')
            check(pt.evaluate('location.hash') == '#/bulletin/board', '★點公告專區提醒列 → #/bulletin/board')
            cm.scan(pt, '公告專區')
            tabs = [t.strip() for t in pt.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(tabs == ['公告', '歷史區'], '★計時同仁只看到公告／歷史區兩個分頁（沒有 platform.bulletin）：%s' % tabs)
            src = pt.get_attribute('[data-role="bulletin-frame"]', 'src')
            check(src == BULLETIN + '/?embed=dzy', '★iframe 來源＝BACKENDS.bulletin + /?embed=dzy：%s' % src)
            href = pt.get_attribute('.bulletin-bar a.btn', 'href')
            check(href == BULLETIN + '/' and pt.get_attribute('.bulletin-bar a.btn', 'target') == '_blank' and 'noopener' in (pt.get_attribute('.bulletin-bar a.btn', 'rel') or ''), '「在新分頁開啟」連到佈告欄首頁、新分頁、noopener')
            pt.evaluate("document.querySelector('[data-role=\"bulletin-frame\"]').__dd = 'kept'")
            # 假冒訊息：來源 origin 是本機站台（不是佈告欄）→ 必須被忽略，不能換入場券
            pt.evaluate("window.postMessage({type: 'dzyb-sso-ready'}, '*')")
            pt.wait_for_timeout(400)
            check(mock.sso == [], '★非佈告欄 origin 送來的 dzyb-sso-ready 被忽略，沒有去換入場券（sso 呼叫 %s）' % mock.sso)
            cm.click(pt, '[data-role="view-nav"] .nav-item:has-text("歷史區")', '切歷史區不重載 iframe')
            wait_view(pt, '歷史區')
            check(pt.get_attribute('[data-role="bulletin-frame"]', 'src') == src and pt.evaluate("document.querySelector('[data-role=\"bulletin-frame\"]').__dd") == 'kept', '★公告 ↔ 歷史區同一頁：iframe 沒換 src、沒重建')
            tip = pt.locator('.bulletin-bar span').inner_text()
            check('已下架' in tip, '歷史區提示文字：%s' % tip)
            cm.click(pt, '[data-role="view-nav"] .nav-item:has-text("公告")', '切回公告')
            wait_view(pt, '公告')
            # keepAlive：切走再回來，iframe 還是同一個；從左側選單點回來停在上次離開的分頁
            cm.click(pt, '[data-role="view-nav"] .nav-item:has-text("歷史區")', '再切歷史區')
            wait_view(pt, '歷史區')
            cm.click(pt, '[data-role="nav-desktop"] [data-nav="__home__"]', '回首頁')
            wait_home(pt)
            check(pt.evaluate("(() => { const h = document.querySelector('[data-keep=\"bulletin\"]'); return h && h.hidden === true && !!h.querySelector('[data-role=\"bulletin-frame\"]'); })()"), '★切走後公告專區容器只是藏起來（hidden），iframe 還在')
            cm.click(pt, '[data-role="nav-desktop"] [data-nav="approvals"]', '進表單簽核')
            pt.wait_for_selector('[data-type="purchase"]')
            cm.click(pt, '[data-role="nav-desktop"] [data-nav="bulletin"]', '從選單回公告專區')
            pt.wait_for_selector('[data-role="bulletin-frame"]:visible')
            check(pt.evaluate('location.hash') == '#/bulletin/hist' and pt.evaluate("document.querySelector('[data-role=\"bulletin-frame\"]').__dd") == 'kept', '★從左側選單點回公告專區 → 停在上次離開的「歷史區」、iframe 仍是原本那個（沒重新登入）')
            active = [t.strip() for t in pt.locator('[data-role="view-nav"] .nav-item.is-active').all_inner_texts()]
            check(active == ['歷史區'], '分頁列也標在歷史區：%s' % active)

            # ── 送單：請款（照片必填、路線預覽、送出）──
            cm.click(pt, '[data-role="nav-desktop"] [data-nav="approvals"]', '進表單簽核')
            pt.wait_for_selector('[data-type="purchase"]')
            cm.scan(pt, '送單（請購）')
            tabs = [t.strip() for t in pt.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(tabs == ['送單', '我的單', '待我簽', '待我辦', '全部單據'], '★計時同仁看不到「核決權限」分頁：%s' % tabs)
            amt1 = pick_amount(rng, True)
            amt2 = pick_amount(rng, True)
            row1, first1, role1, c1 = expect_route('pt', amt1)
            row2, first2, role2, c2 = expect_route('pt', amt2)
            print('請款 1：%d → 第 %d 級 %s%s → %s' % (amt1, row1['seq'], first1, '' if first1 == role1 else '（空缺往上→%s）' % role1, c1))
            print('請款 2：%d → 第 %d 級 %s%s → %s' % (amt2, row2['seq'], first2, '' if first2 == role2 else '（空缺往上→%s）' % role2, c2))
            cm.click(pt, '[data-type="expense"]', '切到請款表單')
            cm.scan(pt, '送單（請款）')
            cats = ['repair', 'food', 'misc', 'transport', 'supplies', 'other']
            cat = rng.choice(cats)
            pt.select_option('#f-cat', cat)
            cm.mark('#f-cat', '類別下拉')
            pt.fill('#f-amount', str(amt1))
            pt.fill('#f-desc', '隨機請款 %d' % amt1)
            cm.click(pt, '#f-payee-vendor', '付款對象改廠商 → 廠商名稱欄出現')
            check(pt.locator('[data-role="vendor-name"]').is_visible(), '選「直接付給廠商」→ 廠商名稱欄出現')
            pt.fill('#f-vname', '測試廠商行')
            cm.click(pt, '#f-payee-self', '付款對象改回自己 → 廠商欄藏起')
            check(not pt.locator('[data-role="vendor-name"]').is_visible(), '選「我先代墊」→ 廠商名稱欄藏起')
            cm.click(pt, '[data-act="send"]', '送出（沒附收據要被擋）')
            check(pt.locator('.toast-warn:has-text("收據")').count() >= 1 and len(calls(mock, 'apvSubmit')) == 0, '請款沒附收據 → 擋下、沒打後端')
            pt.set_input_files('[data-role="photo-file"]', {'name': 'r.jpg', 'mimeType': 'image/jpeg', 'buffer': TINY_JPEG})
            pt.wait_for_selector('[data-role="photo-picker"] img[alt="照片 1"]', timeout=8000)
            shot(pt, 'pt-submit-expense')
            cm.click(pt, '[data-act="preview"]', '預覽簽核路線（請款）')
            pt.wait_for_selector('.dialog-body')
            body = pt.inner_text('.dialog-body')
            names1 = [P[k]['name'] for k in c1]
            check(all(n in body for n in names1) and ('財務部' in body) and (('目前沒人可簽' in body) == (first1 != role1)), '★預覽路線：第 %d 級 %s → 簽核人 %s、交財務部承辦%s：%s' % (row1['seq'], first1, '、'.join(names1), '（含空缺往上）' if first1 != role1 else '', body.replace('\n', ' / ')))
            dlg(pt, '知道了')
            cm.click(pt, '[data-act="send"]', '送出請款')
            pt.wait_for_selector('.dialog-actions')
            body = pt.inner_text('.dialog-body')
            check(('NT$ {:,}'.format(amt1)) in body and all(n in body for n in names1), '★送出前對話框：金額 NT$ %s、簽核人 %s' % ('{:,}'.format(amt1), '、'.join(names1)))
            dlg(pt, '確定送出')
            pt.wait_for_selector('[data-role="apv-card"]', timeout=8000)
            sub = calls(mock, 'apvSubmit')[-1][1]
            check(sub['type'] == 'expense' and sub['body']['amount'] == amt1 and isinstance(sub['body']['amount'], int) and sub['body']['category'] == cat and sub['body']['payee'] == 'self' and len(sub['files']) == 1 and 'sender' not in sub and 'amount' not in sub, '★送出 payload：金額整數 %d、類別 %s、1 張收據、不帶 sender：%s' % (amt1, cat, json.dumps(sub, ensure_ascii=False)))
            fid1 = [f for f in mock.forms if f['sender']['emp'] == P['pt']['emp'] and f['amount'] == amt1 and f['type'] == 'expense'][-1]['id']
            card = pt.locator('[data-role="apv-card"][data-id="%s"]' % fid1)
            where = card.locator('p', has_text='卡在').inner_text() if card.locator('p', has_text='卡在').count() else ''
            check(ROLE_LABEL[role1] in where and all(n in where for n in names1), '★我的單：卡在 %s（%s）：%s' % (ROLE_LABEL[role1], '、'.join(names1), where))
            check('NT$ {:,}'.format(amt1) in card.inner_text(), '卡片顯示金額 NT$ %s' % '{:,}'.format(amt1))

            # 第二張請款（之後給簽核人退回）
            cm.click(pt, '[data-role="view-nav"] .nav-item:has-text("送單")', '回送單')
            pt.wait_for_selector('[data-type="expense"]')
            pt.click('[data-type="expense"]')
            pt.fill('#f-amount', str(amt2))
            pt.fill('#f-desc', '要被退回的請款')
            pt.set_input_files('[data-role="photo-file"]', {'name': 'r2.jpg', 'mimeType': 'image/jpeg', 'buffer': TINY_JPEG})
            pt.wait_for_selector('[data-role="photo-picker"] img[alt="照片 1"]', timeout=8000)
            pt.click('[data-act="send"]')
            pt.wait_for_selector('.dialog-actions')
            dlg(pt, '確定送出')
            pt.wait_for_selector('[data-role="apv-card"]', timeout=8000)
            fid2 = [f for f in mock.forms if f['sender']['emp'] == P['pt']['emp'] and f['amount'] == amt2 and f['type'] == 'expense' and f['id'] != fid1][-1]['id']

            # ── 送單：請購（.5 捨入、小計、合計、新增品項）──
            pt.evaluate("location.hash = '#/approvals/submit'")
            pt.wait_for_selector('[data-type="purchase"]')
            cm.click(pt, '[data-type="purchase"]', '切到請購表單')
            items = []
            for i in range(rng.randint(2, 4)):
                edge = rng.random() < 0.6
                q = rng.randint(1, 20) + 0.5 if edge else rng.randint(1, 30)
                p = rng.randint(1, 400) * 2 + 1 if edge else rng.randint(1, 2000)
                items.append((q, p))
            exp_amt = expect_amount(items)
            print('請購品項 %s → 合計 %d' % (items, exp_amt))
            for i, (q, p) in enumerate(items):
                if i > 0:
                    cm.click(pt, '[data-act="add-item"]', '新增品項列')
                pt.wait_for_selector('[data-role="item-row"][data-i="%d"]' % i)
                row = pt.locator('[data-role="item-row"][data-i="%d"]' % i)
                row.locator('[data-f="name"]').fill('品項%d' % i)
                row.locator('[data-f="qty"]').fill(str(q))
                row.locator('[data-f="unit"]').fill('包')
                row.locator('[data-f="price"]').fill(str(p))
                st = row.locator('[data-role="subtotal"]').inner_text()
                check(st.replace(',', '').strip() == str(int(q * p + 0.5)), '品項 %d：%s×%d 小計 %d（四捨五入；畫面 %s）' % (i, q, p, int(q * p + 0.5), st))
            check(pt.locator('[data-role="item-row"]').count() == len(items), '品項列數 %d' % len(items))
            total = pt.inner_text('[data-role="total"]')
            check(total.strip() == 'NT$ {:,}'.format(exp_amt), '★請購合計 NT$ %s（畫面 %s）' % ('{:,}'.format(exp_amt), total))
            pt.fill('#f-purpose', '隨機請購')
            pt.fill('#f-need', '2026-12-01')
            prow, pfirst, prole, pc = expect_route('pt', exp_amt)
            cm.click(pt, '[data-act="send"]', '送出請購')
            pt.wait_for_selector('.dialog-actions')
            body = pt.inner_text('.dialog-body')
            if prole:
                check(all(P[k]['name'] in body for k in pc) and '採購部' in body, '★請購送出前：第 %d 級 → %s、交採購部：%s' % (prow['seq'], [P[k]['name'] for k in pc], body.replace('\n', ' / ')))
            dlg(pt, '確定送出')
            pt.wait_for_selector('[data-role="apv-card"]', timeout=8000)
            sub = calls(mock, 'apvSubmit')[-1][1]
            check(sub['type'] == 'purchase' and [(it['qty'], it['price']) for it in sub['body']['items']] == [(q, p) for q, p in items] and 'amount' not in sub['body'], '★請購 payload：品項數量單價原樣、前端不送金額（伺服器算）')
            fidp = [f for f in mock.forms if f['type'] == 'purchase' and f['sender']['emp'] == P['pt']['emp'] and f['id'] != mock.forms[1]['id']][-1]['id']
            check(mock.forms[-1]['amount'] == exp_amt, '後端算出的請購金額 %d' % exp_amt)
            # 草稿：請購填一半 → 重新整理 → 還原；人事單不存
            pt.evaluate("location.hash = '#/approvals/submit'")
            pt.wait_for_selector('[data-type="purchase"]')
            pt.click('[data-type="purchase"]')
            pt.fill('#f-purpose', '草稿測試')
            pt.wait_for_timeout(700)
            keys = pt.evaluate("Object.keys(localStorage).filter(k => k.indexOf('apv_draft') !== -1)")
            check(keys == ['dzy.u.u-%s.apv_draft_purchase' % P['pt']['emp']], '★草稿 key＝dzy.u.<user id>.apv_draft_purchase：%s' % keys)
            cm.click(pt, '[data-act="clear-draft"]', '清除草稿')
            pt.wait_for_selector('.toast-ok:has-text("草稿已清除")', timeout=5000)
            check(pt.evaluate("Object.keys(localStorage).filter(k => k.indexOf('apv_draft') !== -1)") == [] and pt.input_value('#f-purpose') == '', '清除草稿 → key 移除、欄位清空')

            # ── 我的單：種子卡關、撤回請購 ──
            goto_tab(pt, '我的單')
            pt.wait_for_selector('[data-role="apv-card"]')
            cm.scan(pt, '我的單')
            mine_ids = pt.locator('[data-role="apv-card"]').evaluate_all('els => els.map(e => e.dataset.id)')
            exp_mine = [f['id'] for f in sorted(mock.forms, key=lambda f: -f['created_at']) if f['sender']['emp'] == P['pt']['emp']]
            check(mine_ids == exp_mine, '★我的單 %d 張、新到舊：%s' % (len(exp_mine), mine_ids))
            seed_stuck = mock.forms[0]['id']
            check(pt.locator('[data-role="apv-card"][data-id="%s"] .tag-danger:has-text("卡關")' % seed_stuck).count() == 1, '種子單超過 72 小時 → 卡關標記')
            pt.select_option('#apv-mine-status', 'signing')
            pt.wait_for_function("() => { const c = [...document.querySelectorAll('[data-role=\"apv-card\"]')]; return c.length > 0 && c.every(e => e.dataset.status === 'signing'); }")
            cm.mark('#apv-mine-status', '狀態篩選')
            check(calls(mock, 'apvMine')[-1][1] == {'status': 'signing'}, '狀態篩選帶進 apvMine')
            pt.select_option('#apv-mine-status', '')
            pt.wait_for_selector('[data-role="apv-card"][data-id="%s"]' % fidp)
            cm.click(pt, '[data-role="apv-card"][data-id="%s"] [data-act="view"]' % fidp, '展開明細')
            pt.wait_for_selector('[data-id="%s"] [data-role="detail-body"]' % fidp)
            det = pt.inner_text('[data-id="%s"] [data-role="detail-body"]' % fidp)
            check(all('品項%d' % i in det for i in range(len(items))) and 'NT$ {:,}'.format(exp_amt) in det and '送出' in det, '明細：品項、合計、處理紀錄')
            pstep = mock.forms[-1]['step']
            cm.click(pt, '[data-role="apv-card"][data-id="%s"] [data-act="withdraw"]' % fidp, '撤回請購')
            dlg(pt, '確定')
            pt.wait_for_selector('[data-role="apv-card"][data-id="%s"][data-status="withdrawn"]' % fidp, timeout=8000)
            w = calls(mock, 'apvWithdraw')[-1][1]
            check(w == {'id': fidp, 'rev': 1, 'step': pstep}, '★撤回 payload 帶 rev＋step：%s' % w)
            check(pt.locator('[data-role="apv-card"][data-id="%s"] [data-act="withdraw"]' % fidp).count() == 0, '撤回後沒有撤回鈕')
            for tab in ('待我簽', '待我辦', '全部單據'):
                goto_tab(pt, tab)
                cm.scan(pt, tab + '（計時）')
            check('沒有' in pt.inner_text('[data-role="view-content"]') or '權限' in pt.inner_text('[data-role="view-content"]'), '計時同仁看全部單據 → 沒權限／沒有單：%s' % pt.inner_text('[data-role="view-content"]')[:60].replace('\n', ' '))
            shot(pt, 'pt-mine')
            ctx.close()

            # ════════════ ② 簽核人：首頁提醒 → 待我簽 → 核准／退回 ════════════
            signer = c1[0]
            sig_ctx, sg = login_as(browser, mock, signer)
            cm.scan(sg, '簽核人首頁')
            exp_sign = [f['id'] for f in mock.forms if f['status'] == 'signing' and P[signer]['emp'] in [e for e in f['route']['steps'][f['step']]['cands']]]
            stuck_any = any(f['stuck'] for f in mock.forms if f['id'] in exp_sign)
            rows_ = alert_rows(sg, 'approvals')
            check(any(r['text'] == '待我簽 %d 張' % len(exp_sign) and r['target'] == '#/approvals/sign' and r['level'] == ('lv-error' if stuck_any else 'lv-warn') for r in rows_), '★%s(%s) 首頁：待我簽 %d 張、%s、導向 #/approvals/sign：%s' % (signer, P[signer]['title'], len(exp_sign), '紅色（有卡關）' if stuck_any else '黃色', rows_))
            badge = sg.inner_text('[data-role="badge"][data-module="approvals"]')
            check(badge == str(len(exp_sign)), '首頁卡片數字＝%d（%s）' % (len(exp_sign), badge))
            cm.click(sg, '[data-role="alert-list"][data-module="approvals"] [data-role="alert-row"]', '導向待我簽')
            sg.wait_for_function("() => location.hash === '#/approvals/sign'")
            sg.wait_for_selector('[data-role="apv-card"]')
            cm.scan(sg, '待我簽')
            got = sorted(sg.locator('[data-role="apv-card"]').evaluate_all('els => els.map(e => e.dataset.id)'))
            check(got == sorted(exp_sign), '★待我簽卡片＝%s' % got)
            card1 = sg.locator('[data-role="apv-card"][data-id="%s"]' % fid1)
            check(card1.locator('[data-act="approve"]').count() == 1 and card1.locator('[data-act="reject"]').count() == 1 and card1.locator('[data-act="done"]').count() == 0 and card1.locator('[data-act="withdraw"]').count() == 0, '簽核人卡片只有核准／退回')
            check(card1.locator('[data-role="thumbs"] img').count() == 1, '卡片有 1 張收據縮圖')
            shot(sg, 'signer-sign')
            cm.click(sg, '[data-role="apv-card"][data-id="%s"] [data-act="approve"]' % fid1, '核准請款 1')
            dlg(sg, '確定')
            sg.wait_for_selector('[data-role="apv-card"][data-id="%s"]' % fid1, state='detached', timeout=8000)
            d = calls(mock, 'apvDecide')[-1][1]
            f1 = next(f for f in mock.forms if f['id'] == fid1)
            check(d == {'id': fid1, 'rev': 1, 'step': d['step'], 'decision': 'approve'} and f1['status'] == 'handling', '★核准 payload 帶 rev＋step、後端狀態 handling：%s' % d)
            if fid2 in exp_sign:
                cm.click(sg, '[data-role="apv-card"][data-id="%s"] [data-act="reject"]' % fid2, '退回請款 2（先不寫原因）')
                dlg(sg, '退回')
                check(sg.locator('.toast-warn:has-text("請填寫原因")').count() >= 1, '退回沒寫原因 → 擋')
                sg.locator('[data-role="apv-card"][data-id="%s"] [data-act="reject"]' % fid2).click()
                sg.fill('#apv-reason', '金額與收據不符')
                dlg(sg, '退回')
                sg.wait_for_selector('[data-role="apv-card"][data-id="%s"]' % fid2, state='detached', timeout=8000)
                d = calls(mock, 'apvDecide')[-1][1]
                check(d['decision'] == 'reject' and d['note'] == '金額與收據不符' and d['id'] == fid2, '退回 payload：%s' % d)
            sig_ctx.close()
            if fid2 not in exp_sign:
                # 請款 2 的簽核人不同：另外登入退回
                s2 = c2[0]
                c2ctx, s2p = login_as(browser, mock, s2)
                s2p.evaluate("location.hash = '#/approvals/sign'")
                s2p.wait_for_selector('[data-role="apv-card"][data-id="%s"]' % fid2)
                s2p.locator('[data-role="apv-card"][data-id="%s"] [data-act="reject"]' % fid2).click()
                s2p.fill('#apv-reason', '金額與收據不符')
                dlg(s2p, '退回')
                s2p.wait_for_selector('[data-role="apv-card"][data-id="%s"]' % fid2, state='detached', timeout=8000)
                check(calls(mock, 'apvDecide')[-1][1]['decision'] == 'reject', '%s 退回請款 2' % s2)
                c2ctx.close()
            rejecter = P[signer if fid2 in exp_sign else c2[0]]['name']

            # ════════════ ③ 計時同仁：退回原因 → 改完再送 → 撤回鈕規則 ════════════
            ctx, pt = login_as(browser, mock, 'pt')
            pt.evaluate("location.hash = '#/approvals/mine'")
            pt.wait_for_selector('[data-role="apv-card"][data-id="%s"]' % fid2)
            rej = pt.locator('[data-role="apv-card"][data-id="%s"]' % fid2)
            rej.locator('[data-role="reject-note"]').wait_for(timeout=8000)
            note = rej.locator('[data-role="reject-note"]').inner_text()
            check('金額與收據不符' in note and rejecter in note and rej.locator('[data-act="resubmit"]').count() == 1 and rej.locator('[data-act="withdraw"]').count() == 0, '★我的單：退回原因＋退回人（%s）、「改完再送」：%s' % (rejecter, note))
            cm.click(pt, '[data-role="apv-card"][data-id="%s"] [data-act="resubmit"]' % fid2, '改完再送')
            pt.wait_for_selector('#f-amount', timeout=8000)
            check(pt.input_value('#f-amount') == str(amt2) and pt.input_value('#f-desc') == '要被退回的請款', '改完再送帶入原內容')
            pt.fill('#f-desc', '已補正')
            pt.click('[data-act="send"]')
            pt.wait_for_selector('.dialog-actions')
            dlg(pt, '確定送出')
            pt.wait_for_selector('[data-role="apv-card"]', timeout=8000)
            r = calls(mock, 'apvResubmit')[-1][1]
            f2 = next(f for f in mock.forms if f['id'] == fid2)
            check(r['id'] == fid2 and r['rev'] == 1 and r['step'] is None and r['body']['desc'] == '已補正' and len(r['files']) == 1 and f2['rev'] == 2 and f2['status'] == 'signing', '★再送 payload（rev 1、step null、原照片）→ 後端 rev 2 簽核中：%s' % json.dumps(r, ensure_ascii=False))
            # 登出 → 草稿清掉、mock 收到 logout、回登入頁
            pt.evaluate("localStorage.setItem('dzy.u.u-%s.apv_draft_purchase', '{\"purpose\":\"x\"}')" % P['pt']['emp'])
            cm.click(pt, '[data-role="nav-desktop"] [data-nav="__logout__"]', '登出')
            pt.wait_for_selector('#login-username', timeout=10000)
            left = pt.evaluate("Object.keys(localStorage).filter(k => k.indexOf('apv_draft') !== -1)")
            check(left == [], '★登出後 apv_draft 草稿清掉（spec §14.7）：%s' % left)
            check(len(getattr(mock, 'logouts', [])) >= 1 and pt.evaluate('location.hash') in ('', '#'), '登出有打後端 logout、hash 清空')
            ctx.close()

            # ════════════ ④ 承辦：財務（請款 1）、採購（種子請購） ════════════
            for key, dept_fid, label in (('fin', fid1, '財務'), ('pur', mock.forms[1]['id'], '採購')):
                hctx, hp = login_as(browser, mock, key)
                cm.scan(hp, label + '首頁')
                exp_h = [f['id'] for f in mock.forms if f['status'] == 'handling' and f['handler_dept'] == P[key]['dept']]
                rows_ = alert_rows(hp, 'approvals')
                check(any(r['text'] == '待我辦 %d 張' % len(exp_h) and r['target'] == '#/approvals/handle' for r in rows_), '★%s首頁：待我辦 %d 張 → #/approvals/handle：%s' % (label, len(exp_h), rows_))
                cm.click(hp, '[data-role="alert-list"][data-module="approvals"] [data-role="alert-row"]', '導向待我辦')
                hp.wait_for_function("() => location.hash === '#/approvals/handle'")
                hp.wait_for_selector('[data-role="apv-card"]')
                cm.scan(hp, '待我辦')
                got = sorted(hp.locator('[data-role="apv-card"]').evaluate_all('els => els.map(e => e.dataset.id)'))
                check(got == sorted(exp_h), '%s待我辦卡片＝%s' % (label, got))
                c = hp.locator('[data-role="apv-card"][data-id="%s"]' % dept_fid)
                check(c.locator('[data-act="done"]').count() == 1 and c.locator('[data-act="return"]').count() == 1 and c.locator('[data-act="reassign"]').count() == 0, '承辦卡片：已處理／退回送件人，沒有改派（不是人資）')
                if key == 'pur':
                    cm.click(hp, '[data-role="apv-card"][data-id="%s"] [data-act="return"]' % dept_fid, '承辦退回（沒原因）')
                    dlg(hp, '退回')
                    check(hp.locator('.toast-warn:has-text("請填寫原因")').count() >= 1 and len(calls(mock, 'apvHandle')) == 1, '承辦退回沒原因 → 擋、沒打後端')
                    hp.locator('[data-role="apv-card"][data-id="%s"] [data-act="return"]' % dept_fid).click()
                    hp.fill('#apv-reason', '廠商已停售')
                    dlg(hp, '退回')
                    hp.wait_for_selector('[data-role="apv-card"][data-id="%s"]' % dept_fid, state='detached', timeout=8000)
                    h = calls(mock, 'apvHandle')[-1][1]
                    check(h == {'id': dept_fid, 'rev': 1, 'step': None, 'result': 'return', 'note': '廠商已停售'}, '★承辦退回 payload（step null）：%s' % h)
                else:
                    cm.click(hp, '[data-role="apv-card"][data-id="%s"] [data-act="done"]' % dept_fid, '已處理')
                    hp.fill('#apv-reason', '已匯款')
                    dlg(hp, '已處理')
                    hp.wait_for_selector('[data-role="apv-card"][data-id="%s"]' % dept_fid, state='detached', timeout=8000)
                    h = calls(mock, 'apvHandle')[-1][1]
                    check(h == {'id': dept_fid, 'rev': 1, 'step': None, 'result': 'done', 'note': '已匯款'}, '★已處理 payload（step null）：%s' % h)
                    # 全部單據：承辦部門只看自己部門 handling／done；匯出 CSV（財務）
                    goto_tab(hp, '全部單據')
                    cm.scan(hp, '全部單據（財務）')
                    hp.wait_for_function("() => !document.querySelector('[data-role=\"view-content\"]').innerText.includes('讀取中')")
                    lst = hp.locator('[data-role="apv-card"]').evaluate_all('els => els.map(e => [e.dataset.id, e.dataset.status])')
                    check(all(st in ('handling', 'done') for _, st in lst) and any(i == fid1 for i, _ in lst), '財務全部單據只有自己部門的 handling／done：%s' % lst)
                    month = time.strftime('%Y-%m', time.gmtime(time.time() + 8 * 3600))
                    hp.fill('#apv-all-month', month)
                    with hp.expect_download() as dl:
                        cm.click(hp, '[data-role="apv-export"]', '匯出 CSV')
                    raw = open(dl.value.path(), 'rb').read()
                    text = raw.decode('utf-8-sig')
                    lines = text.split('\r\n')
                    check(raw[:3] == b'\xef\xbb\xbf' and lines[0].startswith('單號,版次,種類,單位,送件人,金額') and any(l.startswith(fid1 + ',1,請款,新竹光復,%s,%d,' % (P['pt']['name'], amt1)) and '已匯款' in l for l in lines[1:]), '★CSV：BOM、表頭、請款 1 一列（單號、版次、種類中文、單位、送件人、金額、備註）：%s' % text.replace('\r\n', ' ⏎ '))
                    cm.click(hp, '[data-role="apv-query"]', '查詢')
                    hp.wait_for_timeout(300)
                    shot(hp, 'fin-all')
                hctx.close()
            # 採購退回 → 送件人看到「[承辦退回]」原因
            f_seed2 = mock.forms[1]
            check(f_seed2['status'] == 'rejected', '種子請購被承辦退回 → rejected')

            # ════════════ ⑤ 董事長送單 → exception；人資首頁提醒、全部單據改派／作廢 ════════════
            cctx, ch = login_as(browser, mock, 'chair')
            cm.scan(ch, '董事長首頁')
            ch.click('[data-role="nav-desktop"] [data-nav="approvals"]')
            ch.wait_for_selector('[data-type="purchase"]')
            ch.click('[data-type="expense"]')
            amt_c = rng.randint(1, 60000)
            ch.fill('#f-amount', str(amt_c))
            ch.fill('#f-desc', '董事長支出')
            ch.set_input_files('[data-role="photo-file"]', {'name': 'c.jpg', 'mimeType': 'image/jpeg', 'buffer': TINY_JPEG})
            ch.wait_for_selector('[data-role="photo-picker"] img[alt="照片 1"]', timeout=8000)
            ch.click('[data-act="send"]')
            ch.wait_for_selector('.dialog-actions')
            body = ch.inner_text('.dialog-body')
            check('目前沒人可簽' in body, '董事長送單預覽：每一關都「目前沒人可簽，會自動往上」：%s' % body.replace('\n', ' / '))
            dlg(ch, '確定送出')
            ch.wait_for_selector('[data-role="apv-card"]', timeout=8000)
            fidc = mock.forms[-1]['id']
            cc = ch.locator('[data-role="apv-card"][data-id="%s"]' % fidc)
            check(mock.forms[-1]['status'] == 'exception' and cc.locator('.tag-danger:has-text("找不到簽核人")').count() == 1 and '等人資指派' in cc.inner_text(), '★董事長送單 → 找不到簽核人（exception）、提示等人資指派')
            shot(ch, 'chair-exception')
            cctx.close()

            hrctx, hr = login_as(browser, mock, 'hr')
            cm.scan(hr, '人資首頁')
            rows_ = alert_rows(hr, 'approvals')
            check(any(r['text'] == '1 張單找不到合格簽核人，要指派' and r['level'] == 'lv-error' and r['target'] == '#/approvals/handle' for r in rows_), '★人資首頁：1 張單找不到合格簽核人（紅）→ #/approvals/handle：%s' % rows_)
            exp_nav = expected_nav(hr, P['hr']['perms'])
            got_nav = hr.locator('[data-role="nav-desktop"] [data-nav]').evaluate_all('els => els.map(e => e.dataset.nav)')
            depts = hr.locator('[data-role="nav-desktop"] [data-dept]').evaluate_all('els => els.map(e => e.dataset.dept)')
            check(got_nav == ['__home__'] + exp_nav['top'] + exp_nav['inDept'] + ['__password__', '__logout__'] and depts == exp_nav['depts'] and hr.locator('[data-role="nav-desktop"] .nav-label').count() == (1 if depts else 0), '★人資側邊欄＝依權限過濾的模組與部門群組（%s／%s）' % (got_nav, depts))
            # 公告專區：人資有 platform.bulletin → 四個分頁；公告管理 iframe 換頁 view=posts
            hr.click('[data-role="nav-desktop"] [data-nav="bulletin"]')
            hr.wait_for_selector('[data-role="bulletin-frame"]')
            tabs = [t.strip() for t in hr.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(tabs == ['公告', '歷史區', '公告管理', '新增公告'], '★有 platform.bulletin → 四個分頁：%s' % tabs)
            cm.click(hr, '[data-role="view-nav"] .nav-item:has-text("公告管理")', '公告管理')
            hr.wait_for_function("() => document.querySelector('[data-role=\"bulletin-frame\"]').src.includes('view=posts')")
            check(hr.get_attribute('[data-role="bulletin-frame"]', 'src') == BULLETIN + '/?embed=dzy&view=posts', '公告管理 → iframe ?embed=dzy&view=posts')
            cm.click(hr, '[data-role="view-nav"] .nav-item:has-text("新增公告")', '新增公告')
            hr.wait_for_function("() => document.querySelector('[data-role=\"bulletin-frame\"]').src.includes('view=new')")
            check(hr.get_attribute('[data-role="bulletin-frame"]', 'src') == BULLETIN + '/?embed=dzy&view=new', '新增公告 → iframe ?embed=dzy&view=new')
            # 全部單據：人資看全部；改派（不合格→擋；合格→成功）；作廢
            hr.evaluate("location.hash = '#/approvals/all'")
            hr.wait_for_selector('[data-role="apv-card"]')
            cm.scan(hr, '全部單據（人資）')
            all_ids = hr.locator('[data-role="apv-card"]').evaluate_all('els => els.map(e => e.dataset.id)')
            check(sorted(all_ids) == sorted(f['id'] for f in mock.forms), '★人資全部單據＝全部 %d 張' % len(mock.forms))
            hr.select_option('#apv-all-status', 'exception')
            cm.mark('#apv-all-status', '狀態篩選')
            cm.click(hr, '[data-role="apv-query"]', '查詢 exception')
            hr.wait_for_function("() => document.querySelectorAll('[data-role=\"apv-card\"]').length === 1")
            check(calls(mock, 'apvList')[-1][1].get('status') == 'exception' and hr.locator('[data-role="apv-card"]').first.get_attribute('data-id') == fidc, '篩 exception → 只剩董事長那張')
            cx = hr.locator('[data-role="apv-card"][data-id="%s"]' % fidc)
            check(cx.locator('[data-act="reassign"]').count() == 1 and cx.locator('[data-act="void"]').count() == 1, '人資卡片有改派／作廢')
            cm.click(hr, '[data-role="apv-card"][data-id="%s"] [data-act="reassign"]' % fidc, '改派（錯編號）')
            hr.fill('#apv-to', 'abc')
            hr.fill('#apv-reason', 'x')
            dlg(hr, '改派')
            check(hr.locator('.toast-warn:has-text("DZY 編號")').count() >= 1 and len(calls(mock, 'apvReassign')) == 0, '改派對象格式錯 → 前端擋')
            hr.locator('[data-role="apv-card"][data-id="%s"] [data-act="reassign"]' % fidc).click()
            hr.fill('#apv-to', P['pt']['emp'])
            hr.fill('#apv-reason', '測試不合格')
            dlg(hr, '改派')
            hr.wait_for_selector('.toast-danger', timeout=8000)
            check(calls(mock, 'apvReassign')[-1][1]['to'] == P['pt']['emp'] and hr.locator('.toast-danger:has-text("合格")').count() >= 1, '★改派給計時同仁 → 後端 bad_request、畫面顯示後端訊息')
            target = 'gm' if 'gm' in P else None   # exception 時只有總經理／董事長可接；董事長是送件人
            if target:
                hr.locator('[data-role="apv-card"][data-id="%s"] [data-act="reassign"]' % fidc).click()
                hr.fill('#apv-to', P[target]['emp'].lower())
                hr.fill('#apv-reason', '董事長本人送單，請總經理代簽')
                dlg(hr, '改派')
                hr.wait_for_selector('.toast-ok:has-text("已改派")', timeout=8000)
                ra = calls(mock, 'apvReassign')[-1][1]
                fc = next(f for f in mock.forms if f['id'] == fidc)
                check(ra['to'] == P[target]['emp'] and ra['rev'] == 1 and fc['status'] == 'signing' and fc['route']['steps'][fc['step']]['override']['to'] == P[target]['emp'], '★改派給 %s → 編號轉大寫、帶 rev／step、後端回 signing＋override：%s' % (target, ra))
            else:
                print('（本次總經理空缺，exception 改派只驗不合格對象）')
            hr.select_option('#apv-all-status', '')
            hr.click('[data-role="apv-query"]')
            hr.wait_for_selector('[data-role="apv-card"][data-id="%s"]' % fidp)
            cm.click(hr, '[data-role="apv-card"][data-id="%s"] [data-act="void"]' % fidp, '作廢（沒原因）')
            dlg(hr, '作廢')
            check(hr.locator('.toast-warn:has-text("請填寫原因")').count() >= 1, '作廢沒原因 → 擋')
            hr.locator('[data-role="apv-card"][data-id="%s"] [data-act="void"]' % fidp).click()
            hr.fill('#apv-reason', '重複送單')
            dlg(hr, '作廢')
            hr.wait_for_selector('[data-role="apv-card"][data-id="%s"][data-status="voided"]' % fidp, timeout=8000)
            v = calls(mock, 'apvVoid')[-1][1]
            check(v['id'] == fidp and v['reason'] == '重複送單' and v['rev'] == 1 and 'step' in v, '★作廢 payload：%s' % v)
            check(hr.locator('[data-role="apv-card"][data-id="%s"] [data-act="void"]' % fidp).count() == 0, '作廢後沒有作廢鈕')
            hr.select_option('#apv-all-type', 'personnel')
            cm.mark('#apv-all-type', '種類篩選')
            hr.click('[data-role="apv-query"]')
            hr.wait_for_timeout(400)
            check(calls(mock, 'apvList')[-1][1].get('type') == 'personnel', '種類篩選帶進 apvList')
            shot(hr, 'hr-all')
            hrctx.close()

            # ════════════ ⑥ 店長：我的資料（待審核提醒、審核、單位通訊錄生日地址）＋人事單 ════════════
            sctx, sm = login_as(browser, mock, 'sm')
            cm.scan(sm, '店長首頁')
            rows_ = alert_rows(sm, 'me')
            check(any(r['text'] == '有 1 位同仁等你審核' and r['target'] == '#/me/review' and r['level'] == 'lv-warn' for r in rows_), '★店長首頁：有 1 位同仁等你審核（黃）→ #/me/review：%s' % rows_)
            cm.click(sm, '[data-role="alert-list"][data-module="me"] [data-role="alert-row"]', '導向待審核')
            sm.wait_for_function("() => location.hash === '#/me/review'")
            sm.wait_for_selector('[data-role="review-row"]')
            cm.scan(sm, '待審核')
            tabs = [t.strip() for t in sm.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(tabs == ['個人資料', '單位通訊錄', '待審核', '我的單位', '打卡對照'], '店長（platform.review）五個分頁：%s' % tabs)
            nb = ds.newbie
            rv = sm.locator('[data-role="review-row"][data-emp="%s"]' % nb['emp'])
            txt = rv.inner_text()
            check(nb['name'] in txt and nb['birthday'] in txt and nb['phone'] in txt and nb['address'] in txt and '新竹光復' in txt and '計時同仁' in txt, '★待審核卡片：姓名、生日、手機、地址、填的單位職稱都在（主管要核對本人）')
            check('新竹光復' in sm.inner_text('[data-role="view-content"] .card-title'), '待審核標題帶單位範圍')
            cm.click(sm, '[data-role="review-row"] [data-act="reject"]', '退回（沒原因）')
            dlg(sm, '退回')
            check(sm.locator('.toast-warn:has-text("請填寫退回原因")').count() >= 1 and not any(a == 'unitReject' for a, _ in mock.me_calls), '退回沒原因 → 擋、沒打後端')
            cm.click(sm, '[data-role="review-row"] [data-act="approve"]', '通過')
            sm.wait_for_selector('.dialog-body')
            check(nb['phone'] in sm.inner_text('.dialog-body'), '通過前對話框提醒打手機核對本人')
            dlg(sm, '已核對，通過')
            sm.wait_for_selector('[data-role="review-empty"]', timeout=8000)
            check(mock.newbie_status == 'active' and sm.locator('.toast-ok').count() >= 1, '★通過 → 後端 active、畫面「目前沒有等你審核的同仁」')
            shot(sm, 'sm-review')
            for extra_tab in ('我的單位', '打卡對照', '待審核'):
                cm.click(sm, '[data-role="view-nav"] .nav-item:has-text("%s")' % extra_tab, '分頁 ' + extra_tab)
                wait_view(sm, extra_tab)
                sm.wait_for_timeout(300)
            cm.click(sm, '[data-role="nav-desktop"] [data-nav="__home__"]', '回首頁')
            wait_home(sm)
            cm.click(sm, '[data-role="nav-desktop"] [data-nav="me"]', '從選單回我的資料')
            wait_view(sm, '待審核')
            check(sm.evaluate('location.hash') == '#/me/review', '★從選單回我的資料 → 停在上次離開的「待審核」（keepAlive）')
            # 單位通訊錄：門市店長 → 生日、地址逐欄
            goto_tab(sm, '單位通訊錄')
            cm.scan(sm, '單位通訊錄（店長）')
            exp_people = [p for p in P.values() if p['unit'] == 'mala-gf'] + [nb]
            rows_u = sm.locator('[data-role="unit-row"]').evaluate_all("els => els.map(e => ({emp: e.dataset.emp, phone: e.querySelector('[data-field=phone]')?.textContent, birthday: e.querySelector('[data-field=birthday]')?.textContent, address: e.querySelector('[data-field=address]')?.textContent}))")
            by = {r['emp']: r for r in rows_u}
            check(sorted(by) == sorted(p['emp'] for p in exp_people), '★店長通訊錄 %d 位（含剛通過的新人）：%s' % (len(exp_people), sorted(by)))
            for p in exp_people:
                r = by.get(p['emp']) or {}
                check(r.get('birthday') and p['birthday'] in r['birthday'] and r.get('address') and p['address'] in r['address'] and p['phone'] in (r.get('phone') or ''), '  %s：生日 %s、地址、手機正確' % (p['emp'], p['birthday']))
            check('共 %d 位' % len(exp_people) in sm.inner_text('[data-role="view-content"]'), '人數文字')
            shot(sm, 'sm-unit')
            # 個人資料
            goto_tab(sm, '個人資料')
            cm.scan(sm, '個人資料')
            prof = sm.inner_text('[data-role="view-content"]')
            check(P['sm']['name'] in prof and P['sm']['emp'] in prof and '已確認' in prof and P['sm']['birthday'] in prof and '新竹光復／店長' in prof.replace('麻的小辛辣／', ''), '個人資料：姓名、編號、已確認、生日、單位職稱')
            sm.fill('#me-address', '測試市新路 1 號')
            cm.click(sm, '[data-role="form"] [data-role="submit"]', '儲存地址')
            sm.wait_for_selector('.toast-ok:has-text("已儲存")', timeout=8000)
            check(P['sm']['address'] == '測試市新路 1 號', '改地址 → 後端收到')
            sm.fill('#me-phone', '0911222333')
            check(not sm.locator('[data-role="curpw-wrap"]').is_hidden(), '改手機 → 出現「目前的密碼」欄')
            sm.click('[data-role="form"] [data-role="submit"]')
            check('目前的密碼' in sm.inner_text('[data-role="error"]'), '改手機沒輸入密碼 → 前端擋')
            # 人事單：店長替計時同仁送調職（直屬主管＝自己 → 改成店長的直屬主管）
            sm.click('[data-role="nav-desktop"] [data-nav="approvals"]')
            sm.wait_for_selector('[data-type="purchase"]')
            cm.click(sm, '[data-type="personnel"]', '人事異動表單')
            cm.scan(sm, '送單（人事）')
            cm.click(sm, '#f-mode-other', '離職：替同仁送')
            sm.wait_for_selector('#f-sm-online')
            cm.click(sm, '#f-sm-paper', '紙本簽名照')
            sm.wait_for_selector('[data-role="photo-slot"] [data-role="photo-picker"]')
            cm.click(sm, '#f-sm-online', '線上簽名')
            cm.click(sm, '#f-mode-self', '離職：我自己')
            sm.wait_for_selector('[data-role="sign-pad"]')
            cm.scan(sm, '送單（人事—離職本人）')
            sm.select_option('#f-kind', 'transfer')
            sm.wait_for_selector('#f-subject')
            sm.fill('#f-subject', P['pt']['emp'])
            sm.fill('#f-eff', '2026-12-01')
            sm.fill('#f-tu', 'mala-hq')
            sm.fill('#f-reason', '調任辦公室')
            cm.click(sm, '[data-act="preview"]', '預覽人事路線')
            sm.wait_for_selector('.dialog-body')
            body = sm.inner_text('.dialog-body')
            # 預期：直屬主管＝店長本人 → 改成店長的直屬主管（品牌辦公室總監 odir），沒有 → 往上 brand_dir→ceo→gm→chair
            exp_names = [P['odir']['name']] if 'odir' in P else [P[k]['name'] for k in ('ceo', 'gm', 'chair') if k in P][:1]
            check('直屬主管' in body and all(n in body for n in exp_names) and '人資部' in body, '★店長替送調職：直屬主管關 → %s、交人資部：%s' % (exp_names, body.replace('\n', ' / ')))
            dlg(sm, '知道了')
            cm.click(sm, '[data-act="send"]', '送出調職')
            sm.wait_for_selector('.dialog-actions')
            dlg(sm, '確定送出')
            sm.wait_for_selector('[data-role="apv-card"]', timeout=8000)
            sub = calls(mock, 'apvSubmit')[-1][1]
            check(sub['type'] == 'personnel' and sub['subject'] == P['pt']['emp'] and sub['body']['kind'] == 'transfer' and sub['body']['to']['unit'] == 'mala-hq' and 'mode' not in sub['body'], '★調職 payload：subject、kind、to.unit，不帶畫面用的 mode：%s' % json.dumps(sub, ensure_ascii=False))
            check(sm.locator('[data-role="apv-card"]').first.inner_text().find('對象：%s' % P['pt']['name']) != -1, '我的單卡片顯示對象同仁')
            sm.evaluate("location.hash = '#/approvals/submit'")
            sm.wait_for_selector('[data-type="personnel"]')
            sm.click('[data-type="personnel"]')
            sm.select_option('#f-kind', 'raise')
            cm.mark('#f-kind', '人事種類下拉')
            sm.wait_for_selector('#f-tp')
            sm.fill('#f-subject', P['pt']['emp'])
            sm.fill('#f-eff', '2026-12-01')
            sm.fill('#f-reason', '調薪')
            sm.click('[data-act="send"]')
            check(sm.locator('.toast-warn').count() >= 1 and calls(mock, 'apvSubmit')[-1][1]['body']['kind'] != 'raise', '調薪沒填新薪資 → 前端擋')
            sm.fill('#f-tp', '35000')
            sm.click('[data-act="send"]')
            sm.wait_for_selector('.dialog-actions')
            body = sm.inner_text('.dialog-body')
            gm_name = P['gm']['name'] if 'gm' in P else (P['chair']['name'])
            check('總經理' in body and gm_name in body, '★調薪路線一律總經理（空缺往上→董事長）：%s' % body.replace('\n', ' / '))
            dlg(sm, '確定送出')
            sm.wait_for_selector('[data-role="apv-card"]', timeout=8000)
            check(calls(mock, 'apvSubmit')[-1][1]['body']['to']['pay'] == 35000, '調薪 payload to.pay 數字')
            ls = sm.evaluate("Object.keys(localStorage).filter(k => k.indexOf('apv_draft_personnel') !== -1)")
            check(ls == [], '人事單不存草稿')
            sctx.close()

            # ════════════ ⑦ 其他角色通訊錄：總監／資訊總監（不給生日地址）、人資同仁（不是主管） ════════════
            for key in [k for k in ('odir', 'ithm', 'hr', 'gm') if k in P]:
                octx, op = login_as(browser, mock, key)
                op.evaluate("location.hash = '#/me/unit'")
                op.wait_for_function("() => !document.querySelector('[data-role=\"view-content\"]').innerText.includes('讀取中')")
                p = P[key]
                lad, rank = TITLE[p['title']][0], TITLE[p['title']][1]
                is_mgr = (lad == 'office' and rank >= 2) or (lad == 'hq' and rank >= 2 and p['dept'])
                if is_mgr:
                    rows_u = op.locator('[data-role="unit-row"]').evaluate_all("els => els.map(e => ({emp: e.dataset.emp, has_b: !!e.querySelector('[data-field=birthday]'), has_a: !!e.querySelector('[data-field=address]'), phone: e.querySelector('[data-field=phone]').textContent}))")
                    exp = sorted(q['emp'] for q in P.values() if q['unit'] == p['unit'] and (lad != 'hq' or q['dept'] == p['dept']))
                    check(sorted(r['emp'] for r in rows_u) == exp and all(not r['has_b'] and not r['has_a'] for r in rows_u) and all(P[k2]['phone'] in r['phone'] for r in rows_u for k2 in P if P[k2]['emp'] == r['emp']), '★%s(%s/%s) 通訊錄：%d 位、沒有生日／地址欄、有手機' % (key, p['unit'], p['title'], len(exp)))
                else:
                    check(op.locator('[data-role="unit-row"]').count() == 0 and '店長' in op.inner_text('[data-role="view-content"]'), '%s(%s) 不是主管 → 看不到通訊錄、顯示後端說明' % (key, p['title']))
                octx.close()

            # ════════════ ⑧ admin：19 組卡片、部門群組、核決權限（隨機表）、keepAlive 30 分鐘到期 ════════════
            actx, ad = login_as(browser, mock, 'admin')
            ad.clock.install()
            cm.scan(ad, 'admin 首頁')
            check(ad.locator('[data-role="module-card"]').count() == 19, 'admin 首頁 19 組')
            depts = ad.locator('[data-role="nav-desktop"] [data-dept]').evaluate_all('els => els.map(e => e.dataset.dept)')
            exp_depts = ad.evaluate("""async () => { const { MODULES } = await import('/platform/registry.js'); const { DEPARTMENTS } = await import('/platform/config.js');
                const ms = []; for (const m of MODULES) ms.push((await m.load()).default); const s = new Set(ms.map(m => m.dept).filter(Boolean)); return DEPARTMENTS.map(d => d.id).filter(d => s.has(d)); }""")
            check(depts == exp_depts, '★admin 側邊欄部門群組＝有模組掛著的部門、依 config 順序：%s' % depts)
            counts = ad.locator('[data-role="nav-desktop"] .nav-dept-head .cnt').all_inner_texts()
            exp_counts = ad.evaluate("""async () => { const { MODULES } = await import('/platform/registry.js'); const ms = []; for (const m of MODULES) ms.push((await m.load()).default);
                const c = {}; ms.forEach(m => { if (m.dept) c[m.dept] = (c[m.dept] || 0) + 1; }); return c; }""")
            check(counts == [str(exp_counts[d]) for d in depts], '部門標題件數＝該部門模組數：%s' % counts)
            cm.click(ad, '[data-role="nav-desktop"] [data-nav-dept="%s"]' % depts[0], '收合部門')
            check(ad.get_attribute('[data-role="nav-desktop"] [data-nav-dept="%s"]' % depts[0], 'aria-expanded') == 'false', '點部門標題 → 收合')
            ad.click('[data-role="nav-desktop"] [data-nav-dept="%s"]' % depts[0])
            exc_rows = alert_rows(ad, 'approvals')
            check(any('找不到合格簽核人' in r['text'] for r in exc_rows) == any(f['status'] == 'exception' for f in mock.forms), 'admin 首頁 exception 提醒與後端一致：%s' % exc_rows)
            ad.click('[data-role="nav-desktop"] [data-nav="approvals"]')
            ad.wait_for_selector('[data-role="view-nav"] .nav-item')
            goto_tab(ad, '核決權限')
            ad.wait_for_selector('[data-role="thr-row"]')
            cm.scan(ad, '核決權限')
            n = len(ds.rows)
            check(ad.locator('[data-role="thr-row"]').count() == n, '★核決權限 %d 級（本次隨機表）' % n)
            for i, r in enumerate(ds.rows):
                mx = ad.input_value('#thr-max-%d' % i)
                sr = ad.locator('[data-role="thr-row"][data-i="%d"] [data-pick="store"][aria-pressed="true"], [data-role="thr-row"][data-i="%d"] [data-pick="store"].btn-primary' % (i, i)).first.get_attribute('data-val')
                hq = ad.locator('[data-role="thr-row"][data-i="%d"] [data-pick="hq"][aria-pressed="true"], [data-role="thr-row"][data-i="%d"] [data-pick="hq"].btn-primary' % (i, i)).first.get_attribute('data-val')
                check(mx == ('以上全部' if r['max'] is None else str(r['max'])) and sr == r['store_role'] and hq == r['hq_role'], '  第 %d 級：%s／門市 %s／總部 %s（畫面 %s／%s／%s）' % (i + 1, r['max'], r['store_role'], r['hq_role'], mx, sr, hq))
            cm.click(ad, '[data-act="add"]', '新增一級')
            check(ad.locator('[data-role="thr-row"]').count() == n + 1, '新增一級 → %d 級' % (n + 1))
            last_max = (ds.rows[-2]['max'] if n >= 2 else 0) + rng.randint(1, 5000)
            ad.fill('#thr-max-%d' % (n - 1), str(last_max))
            cm.click(ad, '[data-role="thr-row"][data-i="%d"] [data-pick="store"][data-val="ceo"]' % (n - 1), '改門市權限人')
            cm.mark('button[data-pick=hq]', '總部權限人（同一套按鈕）')
            cm.click(ad, '[data-act="save"]', '儲存（顯示 diff）')
            ad.wait_for_selector('[data-role="thr-diff"]')
            diff = ad.inner_text('[data-role="thr-diff"]')
            check(('第 %d 級' % n) in diff and '{:,}'.format(last_max) in diff and ('新增第 %d 級' % (n + 1)) in diff, '★儲存前 diff：%s' % diff.replace('\n', ' / '))
            dlg(ad, '確定儲存')
            ad.wait_for_selector('.toast-ok:has-text("已儲存")', timeout=8000)
            s = calls(mock, 'apvThresholdSave')[-1][1]
            check(s['expected_ver'] == 1 and len(s['rows']) == n + 1 and s['rows'][-1]['max'] is None and s['rows'][n - 1]['max'] == last_max and s['rows'][n - 1]['store_role'] == 'ceo' and mock.ver == 2, '★儲存 payload expected_ver=1、%d 列、最後一列 null：%s' % (n + 1, json.dumps(s)))
            ad.wait_for_selector('[data-role="thr-row"]')
            ad.click('[data-act="add"]')
            check(ad.locator('[data-role="thr-row"]').count() == n + 2, '再新增一級（未儲存）→ %d 級' % (n + 2))
            cm.click(ad, '[data-act="reset"]', '還原（丟掉未儲存的修改）')
            ad.wait_for_function("(k) => document.querrySelectorAll ? false : document.querySelectorAll('[data-role=\"thr-row\"]').length === k", arg=n + 1, timeout=8000)
            check(ad.locator('[data-role="thr-row"]').count() == n + 1 and len(calls(mock, 'apvThresholdSave')) == 1, '★還原 → 回到已儲存的 %d 級、沒再打儲存' % (n + 1))
            shot(ad, 'admin-thr')
            # keepAlive 到期：公告專區保留 30 分鐘，時間到真的卸載
            ad.click('[data-role="nav-desktop"] [data-nav="bulletin"]')
            ad.wait_for_selector('[data-role="bulletin-frame"]')
            ad.click('[data-role="nav-desktop"] [data-nav="__home__"]')
            wait_home(ad)
            check(ad.locator('[data-keep="bulletin"]').count() == 1 and ad.locator('[data-keep="approvals"]').count() == 1, '切走後公告專區與表單簽核都保留（keepAlive）')
            ad.clock.fast_forward(29 * 60 * 1000)
            check(ad.locator('[data-keep="bulletin"]').count() == 1, '29 分鐘：還保留')
            ad.clock.fast_forward(2 * 60 * 1000)
            ad.wait_for_selector('[data-keep="bulletin"]', state='detached', timeout=5000)
            check(ad.locator('[data-keep="bulletin"]').count() == 0, '★31 分鐘：保留到期、公告專區容器卸載')
            ad.click('[data-role="nav-desktop"] [data-nav="bulletin"]')
            ad.wait_for_selector('[data-role="bulletin-frame"]')
            check(ad.evaluate('location.hash') == '#/bulletin/board', '到期後再進 → 重新掛載在第一個分頁')
            actx.close()

            # ════════════ ⑨ 手機 375：首頁／送單／通訊錄不撐出橫向捲軸 ════════════
            mctx, mp = login_as(browser, mock, 'sm', 375, 800)
            check(overflow(mp) <= 375, '375 首頁無橫向捲軸：%d' % overflow(mp))
            shot(mp, 'sm-home-375')
            mp.evaluate("location.hash = '#/me/unit'")
            mp.wait_for_selector('[data-role="unit-row"]')
            check(overflow(mp) <= 375, '375 單位通訊錄：%d' % overflow(mp))
            shot(mp, 'sm-unit-375')
            mp.evaluate("location.hash = '#/approvals/sign'")
            mp.wait_for_function("() => { const v = document.querySelector('[data-role=\"view-content\"]'); return !!v && v.innerText.includes('待我簽') && !v.innerText.includes('讀取中'); }", timeout=8000)
            mp.wait_for_timeout(400)
            check(overflow(mp) <= 375, '375 待我簽：%d' % overflow(mp))
            shot(mp, 'sm-sign-375')
            mctx.close()

            browser.close()
        rep = cm.report()
        check(not rep['missed'], '★按鈕稽核：登記 %d 顆、點過 %d 顆、漏點 %s' % (rep['total'], rep['clicked'], json.dumps(rep['missed'], ensure_ascii=False)))
        check(mock.leaked == [], '沒有請求漏出 mock：%s' % mock.leaked)
        bad_ext = [u for u in blocked if not u.startswith(BULLETIN)]
        check(bad_ext == [], '★外網守門：除佈告欄 iframe（已擋）外沒有任何外網請求：%s' % bad_ext)
        check(any(u.startswith(BULLETIN) for u in blocked), '佈告欄 iframe 請求有被攔下（%d 次），沒有真的連出去' % len(blocked))
        real_errs = [e for e in console_errors if not e.startswith('Failed to load resource')]   # 資源層錯誤＝mock 回 404／iframe 被擋，不是前端 JS 錯
        check(real_errs == [], '★瀏覽器 console 沒有 JS 錯誤（佈告欄 iframe 被擋的除外）：%s' % real_errs[:5])
    finally:
        httpd.shutdown()
    print('\nSEED=%d｜共 %d 項檢查，通過 %d，失敗 %d' % (SEED, _TOTAL[0], _TOTAL[0] - len(failures), len(failures)))
    finish()


if __name__ == '__main__':
    main()
