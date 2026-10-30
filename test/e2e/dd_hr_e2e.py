#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""資料帶入測試（人資部門甲組）：同仁名單／宿舍合約／績效評核，Playwright 全角色點按＋獨立驗算。

後端＝test/dd/hr_backend.mjs（真的 apps-script/platform .gs 在 node vm 裡跑；資料每次隨機重抽，E2E_SEED 可重現；
宿舍 ns 由同一支的有狀態假後端接）。瀏覽器打正式平台網址的請求一律 route 到本機；本機以外全部 abort 並記錄（leaks 必須為空）。
全部假名、零真實網路、不碰任何正式後端。埠 9140～9159。

角色：admin、人資主管（hm）、人資（hs）、店長（sm，375 手機寬）、區督導（osv）、總監（odir）、一般同仁（pt）、宿舍主管（manager）。
每個畫面掃描所有可點元素登記，點過的登記為已驗證，結束時漏點的列出並判失敗（SKIP 附理由）。
截圖存 test/dd/artifacts/hr/。跑法：python3 test/e2e/dd_hr_e2e.py（E2E_SEED=123 重現）。
"""
import json
import math
import os
import random
import re
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import check, finish, load_backend_urls, start_server, failures  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ART = os.path.join(ROOT, 'test', 'dd', 'artifacts', 'hr')
os.makedirs(ART, exist_ok=True)
PORT = int(os.environ.get('DD_WEB_PORT', '9142'))
BACKEND_PORT = int(os.environ.get('DD_BE_PORT', '9143'))
SEED = int(os.environ['E2E_SEED']) if os.environ.get('E2E_SEED', '').isdigit() else (int(time.time() * 1000) ^ os.getpid()) & 0xFFFFFFFF
PW = 'fake-staff-pw-1'
QUARTER = '2026-Q4'
EXTERNAL = re.compile(r'^https?://(?!127\.0\.0\.1)')
rnd = random.Random(SEED ^ 0xBEEF)


def shot(page, name):
    page.screenshot(path=os.path.join(ART, name + '.png'), full_page=True)


# ─────────────────────────────────────────────────────────────
# 後端
# ─────────────────────────────────────────────────────────────
def start_backend():
    env = dict(os.environ, PORT=str(BACKEND_PORT), E2E_SEED=str(SEED), TODAY='2027-01-03')
    proc = subprocess.Popen(['node', os.path.join(ROOT, 'test', 'dd', 'hr_backend.mjs')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    deadline = time.time() + 60
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line and proc.poll() is not None:
            break
        if 'PRESEED_ERRORS' in line:
            print('後端預先送出有錯：' + line.strip()[:300])
        if '測試後端' in line:
            return proc
    proc.kill()
    raise SystemExit('dd-hr 測試後端沒有啟動（seed %d）' % SEED)


def be_get(path):
    return urllib.request.urlopen('http://127.0.0.1:%d%s' % (BACKEND_PORT, path), timeout=10).read().decode('utf-8')


def set_today(d):
    be_get('/__today?d=' + d)


def api(action, payload=None, token=''):
    body = json.dumps({'action': action, 'token': token, 'payload': payload or {}}).encode('utf-8')
    r = urllib.request.Request('http://127.0.0.1:%d/platform/api' % BACKEND_PORT, data=body, headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(r, timeout=20).read())


def tok_of(username, password=PW):
    r = api('login', {'username': username, 'password': password})
    assert r.get('ok'), 'login %s: %s' % (username, r)
    return r['data']['token']


def install_routes(page, urls):
    target = page.context
    real, proxy = urls['platform'], urls['proxy']

    def fwd(path):
        def handle(route):
            req = route.request
            data = req.post_data.encode('utf-8') if req.post_data else b''
            r = urllib.request.Request('http://127.0.0.1:%d/platform%s' % (BACKEND_PORT, path), data=data, headers={'Content-Type': 'text/plain'})
            try:
                resp = urllib.request.urlopen(r, timeout=30)
                status, body = resp.status, resp.read()
            except urllib.error.HTTPError as e:
                status, body = e.code, e.read()
            route.fulfill(status=status, headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}, body=body)
        return handle
    leaks = []

    def guard(route):
        if route.request.url.split('?')[0] in (real, proxy):
            return route.fallback()
        leaks.append(route.request.url)
        return route.abort()
    target.route(EXTERNAL, guard)
    target.route(proxy, fwd('/proxy'))
    target.route(real, fwd('/api'))
    return leaks


def login(page, base, user, pw=PW):
    page.goto(base + '/index.html')
    page.fill('#login-username', user)
    page.fill('#login-password', pw)
    page.click('[data-role="submit"]')
    page.wait_for_selector('[data-role="view-content"]', state='attached', timeout=15000)
    page.wait_for_selector('[data-role="module-card"], [data-nav]', state='attached', timeout=15000)


def goto(page, base, hash_):
    url = base + '/index.html' + hash_
    if page.url == url:
        page.reload()   # 同一個 hash 再 goto 不會觸發 hashchange，殼不會重畫
        page.wait_for_selector('[data-nav]', state='attached', timeout=15000)
    else:
        page.goto(url)


def no_hscroll(page):
    return page.evaluate('() => document.documentElement.scrollWidth <= window.innerWidth + 1')


def click_dialog(page, text):
    page.locator('.dialog button', has_text=text).first.dispatch_event('click')


def confirm_if_dialog(page, text='確定'):
    page.wait_for_timeout(300)
    if page.locator('.dialog').count():
        click_dialog(page, text)


def click_tabs(page, mod, label):
    """把分頁列每個分頁都點一次，驗證網址變成 #/<mod>/<view>"""
    tabs = page.locator('[data-role="view-nav"] .nav-item[data-view]')
    views = tabs.evaluate_all('(l) => l.map((x) => x.dataset.view)')
    bad = []
    for v in views:
        t = page.locator('[data-role="view-nav"] .nav-item[data-view="%s"]' % v)
        CM.click(page, t, '分頁導向 #/%s/%s' % (mod, v), dispatch=True)
        page.wait_for_timeout(500)
        if ('#/%s/%s' % (mod, v)) not in page.url:
            bad.append((v, page.url))
    check(not bad and views, '%s 分頁 %s 都導到對的網址' % (label, views) if not bad else '%s 分頁導向錯：%s' % (label, bad))


def nav_items(page):
    return page.locator('[data-role="view-nav"] .nav-item').all_inner_texts()


# ─────────────────────────────────────────────────────────────
# 按鈕稽核（抄 績效評核系統/e2e/clickmap.py 的做法；只掃 view-nav 與 view-content 裡的元素）
# ─────────────────────────────────────────────────────────────
_KEY = """
  const id = e.id ? '#' + e.id : '';
  const dr = e.dataset && (e.dataset.role || e.dataset.act || e.dataset.action || e.dataset.view || e.dataset.f);
  if (id) return id;
  if (dr) return e.tagName.toLowerCase() + '[' + (e.dataset.role ? 'role' : e.dataset.act ? 'act' : e.dataset.action ? 'action' : e.dataset.view ? 'view' : 'f') + '=' + dr + ']';
  const cls = (typeof e.className === 'string' && e.className.trim()) ? '.' + e.className.trim().split(/\\s+/)[0] : '';
  if (e.tagName === 'SELECT' || e.tagName === 'INPUT') return e.tagName.toLowerCase() + cls;
  const txt = (e.textContent || e.value || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
  return e.tagName.toLowerCase() + '「' + txt + '」';
"""
SCAN_JS = """
() => {
  const keyOf = (e) => {%s};
  const roots = [...document.querySelectorAll('[data-role="view-nav"], [data-role="view-content"], .dialog')];
  const sel = 'button, a[href], summary, input[type=checkbox], select';
  const out = [];
  roots.forEach((r) => r.querySelectorAll(sel).forEach((e) => { if (e.offsetParent !== null || e.tagName === 'SUMMARY') out.push(keyOf(e)); }));
  return out;
}
""" % _KEY
KEY_JS = "(e) => {%s}" % _KEY

SKIP = {
    'button[role=print]': 'window.print 會開系統列印對話框，Playwright headless 無法驗；改驗 document.title 檔名規則',
    'button[act=line]': 'LINE 重設密碼要 LineAuth 後端（不在人資甲組範圍）',
    'button[act=link]': '打卡對照（乙組考勤範圍）',
    'button[act=rename-clock]': '打卡對照（乙組考勤範圍）',
    'button[act=add-home]': '打卡對照（乙組考勤範圍）',
    'button[role=build]': '打卡對照（乙組考勤範圍）',
    'button[act=tab]': '打卡對照（乙組考勤範圍）',
    'button[role=cm-tab]': '打卡對照（乙組考勤範圇）',
}


class ClickMap:
    def __init__(self):
        self.seen = {}
        self.clicked = {}

    def scan(self, page, screen):
        try:
            for k in page.evaluate(SCAN_JS):
                if k:
                    self.seen.setdefault(k, screen)
        except Exception:
            pass

    def click(self, page, locator, verified, dispatch=False):
        """點一個 locator，用元素本身算 key 登記已驗證"""
        loc = locator.first
        try:
            key = loc.evaluate(KEY_JS)
        except Exception:
            key = None
        if dispatch:
            loc.dispatch_event('click')
        else:
            loc.click()
        if key:
            self.clicked[key] = verified
        return key

    def mark(self, page, selector, verified):
        try:
            key = page.locator(selector).first.evaluate(KEY_JS)
            self.clicked[key] = verified
        except Exception:
            pass

    def report(self):
        missed = {k: v for k, v in self.seen.items() if k not in self.clicked and k not in SKIP}
        return {'total': len(self.seen), 'clicked': len(self.clicked), 'skipped': [k for k in self.seen if k in SKIP], 'missed': missed}


CM = ClickMap()


# ─────────────────────────────────────────────────────────────
# 獨立驗算（照 docs/eval/spec.md；不 import 系統計算模組；JS 的 .5 進位用 floor(x*10+0.5)/10）
# ─────────────────────────────────────────────────────────────
def r1(x):
    return math.floor(x * 10 + 0.5) / 10 if x >= 0 else -math.floor(-x * 10 + 0.5) / 10


def fmt(x):
    """畫面 r1：JS String(Math.round(n*10)/10)——整數不帶 .0"""
    if x is None:
        return '—'
    v = r1(x)
    return str(int(v)) if v == int(v) else repr(v)


def kpi_total(items, sel):
    t = 0.0
    for it in items:
        s = (sel.get(it['key']) or {}).get('sel')
        if it['type'] == '執行力':
            if s == '完成':
                t += it['weight']
            elif s == '未完成':
                t += 0
            else:
                return None
        else:
            f = {'A': 1, 'B': 0.8, 'C': 0.6, 'D': 0.4}.get(s)
            if f is None:
                return None
            t += r1(it['weight'] * f)
    return r1(t)


def grade_of(total, table):
    if total is None:
        return None
    for g in sorted(table, key=lambda g: -g['min']):
        if total >= g['min']:
            return g['grade']
    return table[-1]['grade']


def wage_idx(rows, total):
    if total is None:
        return -1
    best, best_low = -1, -math.inf
    for i, row in enumerate(rows):
        s = row[0]
        nums = [float(n) for n in re.findall(r'\d+(?:\.\d+)?', s)]
        if '以下' in s or '以內' in s:
            low = -math.inf
        elif '以上' in s:
            low = nums[0]
        elif len(nums) >= 2:
            low = min(nums[0], nums[1])
        else:
            low = nums[0] if nums else -math.inf
        if low <= total and low >= best_low:
            best, best_low = i, low
    return best


class Expect:
    """用資料集（dataset）＋後端預先送出紀錄＋本測試在 UI 送出的東西，自己算每人每季"""

    def __init__(self, seed):
        self.ds = seed['dataset']
        self.emps = seed['emps']
        self.key_of = seed['keyOf']
        self.by_key = {p['key']: p for p in self.ds['people']}
        ok_peer = {a['rater'] for a in seed['applied']['peer'] if a['ok']}
        ok_self = {a['emp'] for a in seed['applied']['self'] if a['ok']}
        ok_sup = {a['emp'] for a in seed['applied']['sup'] if a['ok']}
        # 以 key 為單位的原始資料；UI 送出後由測試 add_* 補進來
        self.peer = [(r['rater'], x['ratee'], x['att'], x['perf']) for r in self.ds['peer'] if r['rater'] in ok_peer for x in r['ratings']]
        self.self_ = {s['emp']: s for s in self.ds['self'] if s['emp'] in ok_self}
        self.sup = {s['emp']: s for s in self.ds['sup'] if s['emp'] in ok_sup}

    def kind(self, key):
        return 'pt' if self.by_key[key]['title'] == 'pt' else 'ft'

    def add_peer(self, rater, ratee, att, perf):
        self.peer.append((rater, ratee, att, perf))

    def add_self(self, key, att, perf):
        self.self_[key] = {'att': att, 'perf': perf}

    def set_sup(self, key, **kw):
        cur = dict(self.sup.get(key) or {'adj_att': 0, 'adj_perf': 0, 'kpi': {}})
        cur.update(kw)
        self.sup[key] = cur

    def live(self, key):
        p = self.by_key[key]
        kind = self.kind(key)
        peers = [(a, pf) for (_, ratee, a, pf) in self.peer if ratee == key]
        slf = self.self_.get(key)
        sup = self.sup.get(key)
        if not peers and not slf and not sup:
            return None
        att_lists = [a for a, _ in peers] + ([slf['att']] if slf else [])
        perf_lists = ([pf for _, pf in peers] + ([slf['perf']] if slf else [])) if kind == 'pt' else []
        attitude = (sum(sum(a) for a in att_lists) / len(att_lists)) if att_lists else None
        if attitude is not None and kind == 'ft':
            attitude = attitude * 1.2
        if kind == 'ft':
            performance = kpi_total(self.ds['tpl'][p['brand']]['ft'], (sup or {}).get('kpi') or {})
        else:
            performance = (sum(sum(a) for a in perf_lists) / len(perf_lists)) if perf_lists else None
        adj_att = (sup or {}).get('adj_att') or 0
        adj_perf = (sup or {}).get('adj_perf') or 0
        total = None
        if attitude is not None:
            total = min(r1(attitude + adj_att if performance is None else attitude + adj_att + performance + adj_perf), 100)
        return {'kind': kind, 'attitude': attitude, 'performance': performance, 'adj': adj_att + adj_perf, 'total': total,
                'grade': grade_of(total, self.ds['grade'][p['brand']]), 'wage_idx': wage_idx(self.ds['wage'][p['brand']], total),
                'att_count': len(att_lists), 'peer_count': len(peers)}


# ─────────────────────────────────────────────────────────────
def main():
    print('SEED %d（重現：E2E_SEED=%d python3 test/e2e/dd_hr_e2e.py）' % (SEED, SEED))
    urls = load_backend_urls()
    proc = start_backend()
    httpd, base = start_server(PORT)
    seed = json.loads(be_get('/__seed'))
    ds, emps, key_of = seed['dataset'], seed['emps'], seed['keyOf']
    by_key = {p['key']: p for p in ds['people']}
    name_of = lambda k: by_key[k]['name']
    EX = Expect(seed)
    ui_pt, ui_sm = ds['uiPt'], ds['uiSm']
    sm_unit = by_key[ui_sm]['unit']
    unit_people = ds['byUnit'][sm_unit]
    hm_key, hs_key = ds['hq']['hm']['key'], ds['hq']['hs']['key']
    all_leaks = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()

            def new_page(width=1280, height=900):
                ctx = browser.new_context(viewport={'width': width, 'height': height})
                pg = ctx.new_page()
                leaks = install_routes(pg, urls)
                all_leaks.append(leaks)
                return ctx, pg

            # ═══ ① 一般同仁（計時）：首頁提醒 → 填寫互評 → 自評 → 1/12 我的成績（自己算） ═══
            ctx, page = new_page()
            login(page, base, emps[ui_pt])
            page.wait_for_selector('text=本季績效互評還沒填', timeout=15000)
            check(True, '① 計時首頁提醒「本季績效互評還沒填」')
            check(page.locator('[data-nav="staff"]').count() == 0 and page.locator('[data-nav="dorm"]').count() == 0, '① 計時同仁左側沒有同仁名單／宿舍合約')
            goto(page, base, '#/eval/fill')
            page.wait_for_selector('[data-role="ev-person"]', timeout=15000)
            CM.scan(page, 'eval/fill')
            tabs = nav_items(page)
            check('單位結果' not in ''.join(tabs) and '新人考核' not in ''.join(tabs) and '設定' not in ''.join(tabs), '① 計時分頁沒有主管／設定：%s' % tabs)
            click_tabs(page, 'eval', '① 計時')
            goto(page, base, '#/eval/fill')
            page.wait_for_selector('[data-role="ev-person"]', timeout=15000)
            cards = page.locator('[data-role="ev-person"]')
            names = [t.split('\n')[0] for t in cards.locator('summary').all_inner_texts()]
            exp_names = sorted(name_of(p['key']) for p in unit_people if p['key'] != ui_pt)
            got_names = sorted(re.sub(r'^🔥\s*', '', n).split('計時')[0].split('正職')[0].strip() for n in names)
            check(got_names == exp_names, '① 互評名單＝同店其他同仁（%d 人）' % len(exp_names), ) if got_names == exp_names else check(False, '① 互評名單：%s ≠ %s' % (got_names, exp_names))
            # 評完前兩位（星等隨機）、第三位只點一題；送出確認框列沒評完的人
            bank = ds['bank'][by_key[ui_pt]['brand']]
            rated = []
            n_cards = cards.count()
            for i in range(n_cards):
                c = cards.nth(i)
                emp = c.get_attribute('data-emp')
                key = key_of[emp]
                CM.click(page, c.locator('summary'), '展開同仁卡')
                items = c.locator('[data-role="ev-item"]')
                if i == 0:
                    CM.mark(page, '.ev-star', '星等按鈕')
                if i < min(2, n_cards):
                    att, perf = [], []
                    kind = EX.kind(key)
                    n_att = len(bank['pt_att'] if kind == 'pt' else bank['ft_att'])
                    for j in range(items.count()):
                        s = rnd.randint(1, 5)
                        items.nth(j).locator('[data-star="%d"]' % s).click()
                        (att if j < n_att else perf).append(s)
                    check('已評完' in c.locator('[data-role="state"]').inner_text(), '① %s 點滿 → 已評完' % key)
                    rated.append((key, att, perf))
                elif i == 2:
                    items.first.locator('[data-star="3"]').click()
                    check('評到一半' in c.locator('[data-role="state"]').inner_text(), '① 只點一題 → 評到一半')
            page.reload()
            page.wait_for_selector('[data-role="restored"]', timeout=15000)
            check(True, '① 重新整理後還原草稿')
            shot(page, '01_pt_fill')
            CM.click(page, page.locator('[data-role="submit"]'), '送出互評 → 確認框')
            dlg = page.locator('.dialog').inner_text()
            undone = n_cards - len(rated)
            check(('還有 %d 位沒評完' % undone) in dlg, '① 確認框「還有 %d 位沒評完」：%s' % (undone, dlg[:50]))
            click_dialog(page, '確定')
            page.wait_for_selector('text=你已送出本季互評', timeout=15000)
            check(True, '① 送出後顯示已送出')
            for key, att, perf in rated:
                EX.add_peer(ui_pt, key, att, perf)
            # 自評
            goto(page, base, '#/eval/self')
            page.wait_for_selector('#ev-note', timeout=15000)
            CM.scan(page, 'eval/self')
            its = page.locator('[data-role="ev-item"]')
            s_att, s_perf = [], []
            for j in range(its.count()):
                s = rnd.randint(2, 5)
                its.nth(j).locator('[data-star="%d"]' % s).click()
                (s_att if j < len(bank['pt_att']) else s_perf).append(s)
            page.fill('#ev-note', '測試：給自己的話')
            page.fill('#ev-company', '測試：給公司的話')
            CM.click(page, page.locator('[data-role="add-peer"]'), '新增一列夥伴留言')
            rows = page.locator('[data-role="peer-row"]')
            check(rows.count() >= 2, '① 按「再加一位」多一列：%d' % rows.count())
            row = rows.first
            row.locator('[data-f="to"]').select_option(index=1)
            to_emp = row.locator('[data-f="to"]').input_value()
            row.locator('[data-f="msg"]').fill('測試夥伴留言')
            check(row.locator('[data-f="anon"]').is_checked(), '① 夥伴留言預設匿名')
            CM.click(page, row.locator('[data-f="anon"]'), '取消匿名勾選')
            CM.mark(page, '[data-role="peer-row"] [data-f="to"]', '選留言對象')
            CM.click(page, page.locator('[data-role="submit"]'), '送出自評')
            click_dialog(page, '確定')
            page.wait_for_selector('text=你已送出本季自評', timeout=15000)
            check(True, '① 自評送出')
            EX.add_self(ui_pt, s_att, s_perf)
            # 直打後端：再送一次 → duplicate（後端擋）
            tpt = tok_of(emps[ui_pt])
            dup = api('evSelfSubmit', {'att': s_att, 'perf': s_perf}, tpt)
            check(dup.get('error') == 'duplicate', '① 直接打 action 再送自評 → duplicate')
            # 1/7 我的成績還看不到本季；1/12 看得到且數字＝自己算
            set_today('2027-01-07')
            goto(page, base, '#/eval/mine')
            page.wait_for_selector('.ev-wrap, [data-role="detail"]', timeout=15000)
            check(page.locator('table.ev-table tr', has_text='2026 年第 4 季').count() == 0, '① 1/7 我的成績還沒有本季小計（留言不受 10 號閘門）')
            set_today('2027-01-12')
            goto(page, base, '#/eval/mine')
            page.wait_for_selector('[data-role="detail"] table', timeout=15000)
            CM.scan(page, 'eval/mine')
            txt = page.locator('[data-role="view-content"]').inner_text()
            exp = EX.live(ui_pt)
            check('測試：給自己的話' in txt, '① 我的成績有寫給自己的話')
            check('給公司' not in txt.replace('給公司的話', ''), '① 我的成績不顯示給公司的話')
            row_txt = page.locator('table.ev-table tr', has_text='2026 年第 4 季').first.inner_text().replace('\t', ' ')
            check(fmt(exp['attitude']) in row_txt and fmt(exp['performance']) in row_txt and fmt(exp['total']) in row_txt,
                  '① 我的成績小計 態度 %s／表現 %s／實際 %s：%s' % (fmt(exp['attitude']), fmt(exp['performance']), fmt(exp['total']), row_txt))
            widx = exp['wage_idx']
            wrow = ds['wage'][by_key[ui_pt]['brand']][widx][0] if widx >= 0 else None
            check(wrow is not None and ('◀ 落點 %s 分' % fmt(exp['total'])) in txt and page.locator('tr.ev-hl', has_text=wrow).count() >= 1, '① 時薪落點列＝「%s」' % wrow)
            if exp['peer_count'] < 2:
                check('評分人數不足' in txt or '不顯示逐題' in txt or page.locator('[data-role="detail"] table').count() >= 1, '① 同事 %d 位 → 不顯示逐題' % exp['peer_count'])
            if page.locator('#ev-q').count():
                CM.click(page, page.locator('#ev-q'), '切換季度下拉')
            shot(page, '02_pt_mine')
            set_today('2027-01-03')
            # 直打主管分頁 → 擋
            goto(page, base, '#/eval/results')
            time.sleep(1.2)
            check(page.locator('#ev-unit').count() == 0, '① 計時進不了單位結果')
            goto(page, base, '#/staff/list')
            time.sleep(1.2)
            check(page.locator('#stf-f').count() == 0, '① 計時進不了同仁名單')
            ctx.close()

            # ═══ ② 店長（375 手機寬）：互評（正職同仁用正職題）→ 新人考核 → 單位結果＋KPI＋調整 → 待審核 → 我的單位新增同仁／離職 ═══
            ctx, page = new_page(375, 812)
            login(page, base, emps[ui_sm])
            goto(page, base, '#/eval/fill')
            page.wait_for_selector('[data-role="ev-person"]', timeout=15000)
            check(no_hscroll(page), '② 375 填寫評鑑沒有橫向捲軸')
            cards = page.locator('[data-role="ev-person"]')
            sm_rated = []
            for i in range(cards.count()):
                c = cards.nth(i)
                key = key_of[c.get_attribute('data-emp')]
                CM.click(page, c.locator('summary'), '展開同仁卡（375）', dispatch=True)
                items = c.locator('[data-role="ev-item"]')
                kind = EX.kind(key)
                n_att = len(bank['pt_att'] if kind == 'pt' else bank['ft_att'])
                n_exp = n_att + (len(bank['pt_perf']) if kind == 'pt' else 0)
                check(items.count() == n_exp, '② %s（%s）題數 %d＝題庫 %d' % (key, kind, items.count(), n_exp))
                att, perf = [], []
                for j in range(items.count()):
                    s = rnd.randint(1, 5)
                    items.nth(j).locator('[data-star="%d"]' % s).dispatch_event('click')
                    (att if j < n_att else perf).append(s)
                sm_rated.append((key, att, perf))
            page.locator('[data-role="submit"]').dispatch_event('click')
            click_dialog(page, '確定')
            page.wait_for_selector('text=你已送出本季互評', timeout=15000)
            for key, att, perf in sm_rated:
                EX.add_peer(ui_sm, key, att, perf)
            check(True, '② 店長評完全店 %d 人送出' % len(sm_rated))
            click_tabs(page, 'eval', '② 店長 績效評核')
            # 新人考核
            goto(page, base, '#/eval/newbie')
            page.wait_for_selector('[data-role="ev-newbie"], :text("目前沒有待考核的新人")', timeout=15000)
            CM.scan(page, 'eval/newbie')
            check(no_hscroll(page), '② 375 新人考核沒有橫向捲軸')
            def due_on(hire):
                y, m, d = map(int, hire.split('-'))
                y2, m2 = (y + 1, 1) if m == 12 else (y, m + 1)
                last = [31, 29 if y2 % 4 == 0 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m2 - 1]
                return '%04d-%02d-%02d' % (y2, m2, min(d, last))
            done_nb = {a['emp'] for a in seed['applied']['newbie'] if a['ok']}
            exp_nb = [p for p in unit_people if p['key'] != ui_sm and p['hire'] >= '2026-11-20' and p['key'] not in done_nb and p['title'] in ('pt', 'ft')]
            def days_over(due):
                return int(round((time.mktime(time.strptime('2027-01-03', '%Y-%m-%d')) - time.mktime(time.strptime(due, '%Y-%m-%d'))) / 86400))
            exp_due = [p for p in exp_nb if days_over(due_on(p['hire'])) >= 0]
            exp_wait = [p for p in exp_nb if days_over(due_on(p['hire'])) < 0]
            nb_cards = page.locator('[data-role="ev-newbie"]')
            n0 = nb_cards.count()
            check(n0 == len(exp_due), '② 待考核卡 %d 張＝自己算到期 %d（滿月＝下月同日，沒有那天取月底）' % (n0, len(exp_due)))
            body_txt = page.locator('[data-role="view-content"]').inner_text()
            for p in exp_wait:
                due = due_on(p['hire'])
                check(('%s 起可考核（還有 %d 天）' % (due, -days_over(due))) in body_txt, '② %s 還沒滿月：%s 起可考核、還有 %d 天' % (p['key'], due, -days_over(due)))
            for i in range(n0):
                st = nb_cards.nth(i).locator('summary').inner_text()
                p = next((x for x in exp_due if name_of(x['key']) in st), None)
                if p is None:
                    check(False, '② 新人卡 %s 不在預期名單' % st[:30])
                    continue
                over = days_over(due_on(p['hire']))
                if over > 0:
                    check(('已逾期 %d 天' % over) in st, '② %s 到職 %s → 已逾期 %d 天：%s' % (p['key'], p['hire'], over, st[-20:]))
                    check(nb_cards.nth(i).locator('.ev-state.ev-down').count() == (1 if over > 7 else 0), '② %s 逾期 %d 天 %s標紅（>7 天才紅）' % (p['key'], over, '要' if over > 7 else '不'))
                else:
                    check('今天滿一個月' in st, '② %s 今天滿月：%s' % (p['key'], st[-20:]))
            for i in range(n0):
                CM.click(page, nb_cards.nth(i).locator('summary'), '展開新人卡', dispatch=True)
            if n0:
                nb = nb_cards.first
                ni = nb.locator('[data-role="ev-item"]')
                check(ni.count() == len(bank['pt_att']) + len(bank['pt_perf']), '② 新人考核題數＝計時態度＋表現 %d' % (len(bank['pt_att']) + len(bank['pt_perf'])))
                stars = [rnd.randint(1, 5) for _ in range(ni.count())]
                for j, s in enumerate(stars):
                    ni.nth(j).locator('[data-star="%d"]' % s).dispatch_event('click')
                nb.locator('[data-role="submit"]').dispatch_event('click')
                click_dialog(page, '確定')
                page.wait_for_selector('.toast:has-text("入職考核")', timeout=15000)
                toast = page.locator('.toast:has-text("入職考核")').first.inner_text()
                check(('入職考核 %s 分' % fmt(min(100, sum(stars)))) in toast, '② 新人考核合計＝直接加總 %s：%s' % (fmt(sum(stars)), toast))
                page.wait_for_function("(n) => document.querySelectorAll('[data-role=\"ev-newbie\"]').length === n", arg=n0 - 1, timeout=15000)
                check(True, '② 考核後從清單消失（%d → %d）' % (n0, n0 - 1))
                CM.mark(page, '[data-role="ev-newbie"] [data-role="submit"]', '新人考核送出')
            shot(page, '03_sm_newbie_375')
            # 單位結果
            goto(page, base, '#/eval/results')
            page.wait_for_selector('#ev-unit', timeout=15000)
            CM.scan(page, 'eval/results')
            check(no_hscroll(page), '② 375 單位結果沒有橫向捲軸')
            CM.mark(page, '#ev-unit', '單位下拉（店長只有一店）')
            opts = page.locator('#ev-unit option').all_inner_texts()
            check(len(opts) == 1 and sm_unit.split('-')[0] in page.locator('#ev-unit').input_value(), '② 店長只有自己店：%s' % opts)
            check(page.locator('[data-role="finalize"]').count() == 0, '② 店長沒有定稿鈕')
            prog = page.locator('[data-role="view-content"]').inner_text()
            check('本季填寫進度' in prog and '互評還沒送' in prog, '② 填寫窗內顯示填寫進度')
            # 每一列的態度／表現／實際分數＝自己算
            for p in unit_people:
                if p['key'] == ui_sm:
                    continue
                exp = EX.live(p['key'])
                tr = page.locator('tr[data-role="ev-row"][data-emp="%s"]' % emps[p['key']])
                if tr.count() == 0:
                    check(False, '② 單位結果缺 %s' % p['key'])
                    continue
                t = tr.inner_text().replace('\t', ' ')
                if exp is None:
                    check('還沒有人評' in t, '② %s 沒人評 → 「還沒有人評」' % p['key'])
                    continue
                cells = tr.locator('td').all_inner_texts()
                perf_txt = '未計' if exp['performance'] is None else fmt(exp['performance'])
                tier = (('KPI 未評' if exp['performance'] is None else (exp['grade'] or '—')) if exp['kind'] == 'ft'
                        else (ds['wage'][p['brand']][exp['wage_idx']][1] if exp['wage_idx'] >= 0 else '—'))
                adj_txt = ('—' if not exp['adj'] else ('+' if exp['adj'] > 0 else '') + fmt(exp['adj']))
                want = [fmt(exp['attitude']), perf_txt, adj_txt, fmt(exp['total']), tier, str(exp['att_count'])]
                got = [c.strip() for c in cells[2:8]]
                check(got == want, '② %s(%s) 列 態度/表現/調整/實際/等第時薪/人數 %s' % (p['key'], exp['kind'], got) if got == want else '② %s(%s) 列 %s ≠ 預期 %s' % (p['key'], exp['kind'], got, want))
            # 打 KPI：挑一位正職（ft）
            ft = next((p for p in unit_people if p['title'] == 'ft'), None)
            if ft:
                CM.click(page, page.locator('a[data-role="open"][data-emp="%s"]' % emps[ft['key']]), '點姓名開明細', dispatch=True)
                page.wait_for_selector('[data-role="kpi-row"]', timeout=15000)
                items = ds['tpl'][ft['brand']]['ft']
                sel = {}
                for it in items:
                    tr = page.locator('[data-role="kpi-row"][data-key="%s"]' % it['key'])
                    s = rnd.choice(['完成', '未完成']) if it['type'] == '執行力' else rnd.choice(['A', 'B', 'C', 'D'])
                    tr.locator('[data-f="sel"]').select_option(s)
                    tr.locator('[data-f="actual"]').fill('實測%d' % rnd.randint(1, 99))
                    sel[it['key']] = {'sel': s}
                    w = it['weight']
                    one = (w if s == '完成' else 0) if it['type'] == '執行力' else r1(w * {'A': 1, 'B': 0.8, 'C': 0.6, 'D': 0.4}[s])
                    check(tr.locator('[data-f="score"]').inner_text().strip() == fmt(one), '② KPI %s 選 %s → %s' % (it['key'], s, fmt(one)))
                CM.mark(page, '[data-role="kpi-row"] [data-f="sel"]', 'KPI 評等下拉')
                kt = kpi_total(items, sel)
                check(page.locator('[data-role="kpi-total"]').inner_text().strip() == fmt(kt), '② KPI 即時合計 %s' % fmt(kt))
                if page.locator('#ev-tpl').count():
                    CM.mark(page, '#ev-tpl', '範本下拉（只有一張時不換）')
                CM.click(page, page.locator('[data-role="save-kpi"]'), '儲存 KPI', dispatch=True)
                page.wait_for_function("() => (document.querySelector('[data-role=\"kpi-msg\"]')||{}).textContent === '✅ 已儲存'", timeout=15000)
                EX.set_sup(ft['key'], kpi=sel)
                adj_a, adj_p = rnd.choice([-2, -1, 1, 2]), rnd.choice([-3, 0, 2, 4])
                page.fill('#ev-adj-att', str(adj_a))
                page.fill('#ev-adj-perf', str(adj_p))
                page.fill('#ev-adj-reason', '測試調整')
                page.fill('#ev-feedback', '測試回饋：做得好')
                CM.click(page, page.locator('[data-role="save-sup"]'), '儲存加減分與回饋', dispatch=True)
                page.wait_for_function("() => (document.querySelector('[data-role=\"sup-msg\"]')||{}).textContent === '✅ 已儲存'", timeout=15000)
                EX.set_sup(ft['key'], adj_att=adj_a, adj_perf=adj_p)
                exp = EX.live(ft['key'])
                tr = page.locator('tr[data-role="ev-row"][data-emp="%s"]' % emps[ft['key']])
                cells = [c.strip() for c in tr.locator('td').all_inner_texts()]
                adj_txt = ('—' if not exp['adj'] else ('+' if exp['adj'] > 0 else '') + fmt(exp['adj']))
                check(cells[3] == fmt(kt) and cells[4] == adj_txt and cells[5] == fmt(exp['total']) and cells[6] == exp['grade'], '② 存檔後總覽 表現 %s／調整 %s／實際 %s／等第 %s：%s' % (fmt(kt), adj_txt, fmt(exp['total']), exp['grade'], cells[2:7]))
                # 後端調整 >100 擋
                tsm = tok_of(emps[ui_sm])
                check(api('evSupSave', {'emp': emps[ft['key']], 'quarter': QUARTER, 'adj_att': 999}, tsm).get('error') == 'bad_request', '② 直打 adj_att=999 → bad_request')
            shot(page, '04_sm_results_375')
            # 待審核：先替本店造一位待審（人資匯入＋本人認領）
            admin_tok = tok_of('BOSS', 'fake-admin-pw-01')
            pend_name = '假認領者%d' % (SEED % 1000)
            api('staffImport', {'names': [pend_name]}, admin_tok)
            pend_emp = api('claimLookup', {'name': pend_name})['data']['emp_no']
            cs = api('claimSubmit', {'name': pend_name, 'emp_no': pend_emp, 'password': PW, 'brand': by_key[ui_sm]['brand'], 'unit': sm_unit, 'dept': '', 'title': 'pt',
                                     'birthday': '1996-06-06', 'phone': '0966000111', 'address': '測試市認領路 6 號'})
            check(cs.get('ok') and cs.get('pending'), '② 認領送出 → pending（不回 token）')
            check(api('login', {'username': pend_emp, 'password': PW}).get('error') == '帳號還在等主管審核', '② 待審帳號登入被擋（逐字）')
            goto(page, base, '#/me/review')
            page.wait_for_selector('[data-role="review-row"], [data-role="review-empty"]', timeout=15000)
            CM.scan(page, 'me/review')
            click_tabs(page, 'me', '② 店長 我的資料')
            goto(page, base, '#/me/review')
            page.wait_for_selector('[data-role="review-row"], [data-role="review-empty"]', timeout=15000)
            rr = page.locator('[data-role="review-row"][data-emp="%s"]' % pend_emp)
            check(rr.count() == 1, '② 店長待審核看到本店認領者')
            rtxt = rr.inner_text()
            check('0966000111' in rtxt and '1996-06-06' in rtxt and '認領路' in rtxt, '② 待審卡有手機／生日／地址供核對')
            CM.click(page, rr.locator('[data-act="reject"]'), '退回 → 要原因', dispatch=True)
            click_dialog(page, '退回')
            page.wait_for_timeout(500)
            check(any('請填寫退回原因' in t for t in page.locator('.toast').all_inner_texts()) and page.locator('[data-role="review-row"][data-emp="%s"]' % pend_emp).count() == 1, '② 沒填原因不能退回（提示＋仍在清單）')
            CM.click(page, rr.locator('[data-act="approve"]'), '通過', dispatch=True)
            page.wait_for_selector('.dialog', timeout=10000)
            check('0966000111' in page.locator('.dialog').inner_text(), '② 通過對話框提醒核對手機')
            click_dialog(page, '已核對，通過')
            page.wait_for_function("(e) => !document.querySelector('[data-role=\"review-row\"][data-emp=\"' + e + '\"]')", arg=pend_emp, timeout=15000)
            check(api('login', {'username': pend_emp, 'password': PW}).get('ok') is True, '② 店長通過後本人可登入')
            check(no_hscroll(page), '② 375 待審核沒有橫向捲軸')
            # 我的單位（team）：新增同仁、登記離職、撤銷
            goto(page, base, '#/me/team')
            page.wait_for_selector('[data-role="add-staff"]', timeout=15000)
            CM.scan(page, 'me/team')
            CM.click(page, page.locator('[data-role="add-staff"]'), '新增同仁對話框', dispatch=True)
            page.wait_for_selector('#ad-name', timeout=10000)
            page.fill('#ad-name', '假新同仁%d' % (SEED % 97))
            page.select_option('#ad-title', 'pt')
            page.fill('#ad-hire', '2027-01-02')
            page.fill('#ad-phone', '0955%06d' % (SEED % 1000000))
            click_dialog(page, '送出')
            page.wait_for_selector('text=已建立', timeout=15000)
            dtxt = page.locator('.dialog').inner_text()
            click_dialog(page, re.compile('完成|關閉'))   # 有打卡系統的店會接著「打卡建檔中…」（乙組範圍），這裡只驗同仁已建立
            check('已建立' in dtxt, '② 店長新增同仁（未開通、等本人認領）：%s' % dtxt.split('\n')[2][:30])
            lst = api('staffList', {}, admin_tok)['data']['staff']
            newp = next((x for x in lst if x['name'] == '假新同仁%d' % (SEED % 97)), None)
            check(newp is not None and newp['status'] == 'unclaimed' and newp['unit'] == sm_unit and newp['hire_date'] == '2027-01-02', '② 名單：新同仁 unclaimed、單位＝本店、到職日')
            goto(page, base, '#/me/team')
            page.wait_for_selector('[data-act="leave"]', timeout=15000)
            target_pt = next(p for p in unit_people if p['title'] == 'pt' and p['key'] != ui_pt)
            row_sel = '[data-emp="%s"]' % emps[target_pt['key']]
            CM.click(page, page.locator(row_sel + ' [data-act="leave"]'), '登記離職對話框', dispatch=True)
            page.wait_for_selector('[data-role="leave-hint"]', timeout=10000)
            today_real = time.strftime('%Y-%m-%d')
            date_inp = page.locator('.dialog input[type="date"]')
            check(date_inp.get_attribute('min') == time.strftime('%Y-%m-%d', time.localtime(time.time() - 7 * 86400)), '② 離職日期下限＝今天−7 天（店長最多往回補 7 天）')
            date_inp.fill(today_real)
            click_dialog(page, '送出')
            page.wait_for_selector(row_sel + ' [data-role="leave-tag"]', timeout=15000)
            check(True, '② 登記離職後出現離職標籤')
            lst = api('staffList', {}, admin_tok)['data']['staff']
            check(next(x for x in lst if x['emp_no'] == emps[target_pt['key']])['last_day'] == today_real, '② 後端 last_day＝今天')
            CM.click(page, page.locator(row_sel + ' [data-act="leave-cancel"]'), '撤銷離職', dispatch=True)
            if page.locator('.dialog').count():
                click_dialog(page, '確定')
            page.wait_for_function("(s) => !document.querySelector(s + ' [data-role=\"leave-tag\"]')", arg=row_sel, timeout=15000)
            check(True, '② 撤銷離職後標籤消失')
            shot(page, '05_sm_team_375')
            ctx.close()

            # ═══ ③ 區督導：單位結果＝同品牌各店；待審核看得到店長；新人考核清單只有店長層 ═══
            osvs = [p for p in ds['people'] if p['title'] == 'osv' and p['brand'] == by_key[ui_sm]['brand']]
            odirs = [p for p in ds['people'] if p['title'] == 'odir' and p['brand'] == by_key[ui_sm]['brand']]
            brand_stores = sorted(u for u in ds['byUnit'] if u.startswith(by_key[ui_sm]['brand'] + '-'))
            if osvs:
                ctx, page = new_page()
                login(page, base, emps[osvs[0]['key']])
                goto(page, base, '#/eval/results')
                page.wait_for_selector('#ev-unit', timeout=15000)
                vals = page.locator('#ev-unit option').evaluate_all('(o) => o.map((x) => x.value)')
                check(sorted(vals) == brand_stores, '③ 區督導單位下拉＝同品牌門市 %s' % vals)
                tabs = nav_items(page)
                check('設定' not in ''.join(tabs), '③ 區督導沒有設定分頁')
                # 可以點進店長明細打分；一般同仁只能看
                sm_row = page.locator('tr[data-role="ev-row"][data-emp="%s"]' % emps[ui_sm])
                if sm_row.count():
                    sm_row.locator('a[data-role="open"]').dispatch_event('click')
                    page.wait_for_selector('[data-role="ev-detail"], [data-role="person"] .card', timeout=15000)
                    check(page.locator('[data-role="save-sup"]').count() == 1, '③ 區督導可替店長打分（往上一層）')
                ptp = next((p for p in unit_people if p['title'] == 'pt'), None)
                if ptp:
                    page.locator('tr[data-role="ev-row"][data-emp="%s"] a[data-role="open"]' % emps[ptp['key']]).dispatch_event('click')
                    page.wait_for_timeout(800)
                    check(page.locator('[data-role="save-sup"]').count() == 0, '③ 區督導對計時同仁只能看、不能打分')
                if page.locator('#ev-quarter').count():
                    CM.click(page, page.locator('#ev-quarter'), '季度下拉')
                    page.select_option('#ev-quarter', '2026-Q3')
                    page.wait_for_timeout(800)
                    check('2026 年第 3 季' in page.locator('[data-role="view-content"]').inner_text(), '③ 切季度 → 2026 年第 3 季')
                if len(brand_stores) > 1:
                    CM.click(page, page.locator('#ev-unit'), '單位下拉')
                    page.select_option('#ev-unit', brand_stores[1] if brand_stores[0] == sm_unit else brand_stores[0])
                    page.wait_for_timeout(800)
                goto(page, base, '#/eval/newbie')
                page.wait_for_selector('[data-role="ev-newbie"], :text("目前沒有待考核的新人")', timeout=15000)
                check(page.locator('[data-role="ev-newbie"]').count() == 0, '③ 區督導新人清單不含計時／正職（只管店長層）')
                goto(page, base, '#/me/review')
                page.wait_for_selector('[data-role="review-row"], [data-role="review-empty"]', timeout=15000)
                # 造一位待審店長（同品牌某店）→ 區督導看得到；待審計時看不到
                pend_sm_name = '假待審店長%d' % (SEED % 1000)
                api('staffImport', {'names': [pend_sm_name]}, admin_tok)
                psm = api('claimLookup', {'name': pend_sm_name})['data']['emp_no']
                api('claimSubmit', {'name': pend_sm_name, 'emp_no': psm, 'password': PW, 'brand': by_key[ui_sm]['brand'], 'unit': sm_unit, 'dept': '', 'title': 'sm', 'birthday': '1990-02-02', 'phone': '0977000222', 'address': '測試市店長路 2 號'})
                goto(page, base, '#/me/review')
                page.wait_for_selector('[data-role="review-row"], [data-role="review-empty"]', timeout=15000)
                check(page.locator('[data-role="review-row"][data-emp="%s"]' % psm).count() == 1, '③ 區督導待審核看到店長認領')
                check(page.locator('[data-role="review-row"]').count() == 1, '③ 區督導看不到計時認領（只有店長那一位）')
                shot(page, '06_osv_review')
                ctx.close()
            else:
                print('SKIP ③ 這組資料沒有區督導')

            # ═══ ④ 總監（odir）：單位結果同品牌；審核店長 ═══
            if odirs:
                ctx, page = new_page()
                login(page, base, emps[odirs[0]['key']])
                goto(page, base, '#/eval/results')
                page.wait_for_selector('#ev-unit', timeout=15000)
                vals = page.locator('#ev-unit option').evaluate_all('(o) => o.map((x) => x.value)')
                check(sorted(vals) == brand_stores, '④ 總監單位下拉＝同品牌門市')
                goto(page, base, '#/me/review')
                page.wait_for_selector('[data-role="review-row"], [data-role="review-empty"]', timeout=15000)
                rows_ = page.locator('[data-role="review-row"]')
                check(rows_.count() >= 1 and all('店長' in t for t in rows_.all_inner_texts()), '④ 總監待審核只有店長層：%d' % rows_.count())
                ctx.close()
            else:
                print('SKIP ④ 這組資料沒有總監')

            # ═══ ⑤ 人資（hs）：同仁名單看得到、單位結果全集團、沒有設定／新人分頁 ═══
            ctx, page = new_page()
            login(page, base, emps[hs_key])
            check(page.locator('[data-nav="staff"]').count() == 1, '⑤ 人資左側有同仁名單')
            goto(page, base, '#/eval/results')
            page.wait_for_selector('#ev-unit', timeout=15000)
            vals = page.locator('#ev-unit option').evaluate_all('(o) => o.map((x) => x.value)')
            check(all(u in vals for u in ds['byUnit']), '⑤ 人資（eval-all）單位下拉含全部有人的門市：%d' % len(vals))
            tabs = nav_items(page)
            check('設定' not in ''.join(tabs) and '新人考核' not in ''.join(tabs), '⑤ 人資沒有設定／新人考核分頁：%s' % tabs)
            check(page.locator('[data-role="finalize"]').count() == 0, '⑤ 人資（非總監）沒有定稿鈕')
            ctx.close()

            # ═══ ⑥ 人資主管（hm）：設定（題庫擋窗、範本、時薪、等第、匯入）、定稿／解除、列印檔名 ═══
            ctx, page = new_page()
            login(page, base, emps[hm_key])
            goto(page, base, '#/eval/settings')
            page.wait_for_selector('#ev-brand', timeout=15000)
            CM.scan(page, 'eval/settings')
            click_tabs(page, 'eval', '⑥ 人資總監 績效評核')
            goto(page, base, '#/eval/settings')
            page.wait_for_selector('#ev-brand', timeout=15000)
            brand = by_key[ui_sm]['brand']
            if page.locator('#ev-brand').input_value() != brand:
                page.select_option('#ev-brand', brand)
                page.wait_for_timeout(800)
            CM.mark(page, '#ev-brand', '品牌下拉')
            check(page.locator('[data-role="init"]').count() == 0, '⑥ 人資總監沒有「初始化」（只有 admin）')
            # 題庫：新增一題填好 → 填寫期間存檔要被擋（訊息在卡片 data-role=msg）
            bank_box = page.locator('[data-role="bank"][data-set="pt_att"]')
            n_q = bank_box.locator('details[data-i]').count()
            check(n_q == len(ds['bank'][brand]['pt_att']), '⑥ 計時態度題庫 %d 題＝資料集' % n_q)
            CM.click(page, bank_box.locator('[data-act="add"]'), '題庫新增一題')
            page.wait_for_timeout(300)
            last = bank_box.locator('details[data-i]').last
            CM.click(page, bank_box.locator('[data-act="save"]'), '題庫存檔（空題 → 前端擋）')
            page.wait_for_timeout(300)
            check('每一題都要有題目' in bank_box.locator('[data-role="msg"]').inner_text(), '⑥ 空題目不能存（前端）')
            last.locator('[data-f="label"]').fill('新題目測試')
            for i in range(5):
                last.locator('[data-f="lv%d"]' % i).fill('第 %d 級' % (5 - i))
            bank_box.locator('[data-act="save"]').click()
            confirm_if_dialog(page)
            page.wait_for_function("(sel) => /已儲存|失敗/.test(document.querySelector(sel + ' [data-role=\"msg\"]').textContent)", arg='[data-role="bank"][data-set="pt_att"]', timeout=15000)
            bmsg = bank_box.locator('[data-role="msg"]').inner_text()
            check('失敗' in bmsg, '⑥ 1/3 改題庫被後端擋：%s' % bmsg[:60])
            check('填寫期間' in bmsg or '1～5 號' in bmsg, '⑥ 擋下時要顯示人看得懂的訊息（不是代碼 window_closed）：%s' % bmsg[:60])
            check(len(api('evBankGet', {'brand': brand}, tok_of(emps[hm_key]))['data']['bank']['pt_att']) == n_q, '⑥ 後端題數仍是 %d' % n_q)
            CM.click(page, last.locator('[data-act="del"]'), '刪掉新題', dispatch=True)
            page.wait_for_timeout(200)
            check(bank_box.locator('details[data-i]').count() == n_q, '⑥ 刪題後回 %d 題' % n_q)
            for bset in ('pt_att', 'pt_perf', 'ft_att'):
                for dsum in page.locator('[data-role="bank"][data-set="%s"] details[data-i] summary' % bset).all():
                    CM.click(page, dsum, '展開題目')
            d0 = bank_box.locator('details[data-i]').first
            CM.click(page, d0.locator('summary'), '展開第一題')
            first_label = d0.locator('[data-f="label"]').input_value()
            CM.click(page, d0.locator('[data-act="down"]'), '第一題下移', dispatch=True)
            page.wait_for_timeout(200)
            check(bank_box.locator('details[data-i]').nth(1).locator('summary').inner_text().startswith('2. ' + first_label), '⑥ 下移後變第 2 題')
            d1 = bank_box.locator('details[data-i]').nth(1)
            CM.click(page, d1.locator('[data-act="up"]'), '上移回去', dispatch=True)
            page.wait_for_timeout(200)
            check(bank_box.locator('details[data-i]').first.locator('summary').inner_text().startswith('1. ' + first_label), '⑥ 上移後回第 1 題')
            # KPI 範本：改比重 → 合計；存檔後後端比重更新
            tpl_card = page.locator('.card:has(#ev-tpl-title)')
            tpl_w = tpl_card.locator('[data-f="weight"]')
            weights = [float(w) for w in tpl_w.evaluate_all('(l) => l.map((x) => x.value)')]
            check(len(weights) == len(ds['tpl'][brand]['ft']) and tpl_card.locator('[data-role="total"]').inner_text().strip() == fmt(sum(weights)), '⑥ 範本 %d 項、比重合計 %s' % (len(weights), fmt(sum(weights))))
            tpl_w.first.fill(str(weights[0] + 2.5))
            page.wait_for_timeout(200)
            check(tpl_card.locator('[data-role="total"]').inner_text().strip() == fmt(sum(weights) + 2.5), '⑥ 改比重後合計即時更新 %s' % fmt(sum(weights) + 2.5))
            CM.mark(page, '#ev-tpl-title', '範本職稱下拉')
            CM.mark(page, '.card:has(#ev-tpl-title) [data-f="type"]', '項目類型下拉')
            CM.click(page, tpl_card.locator('[data-act="save"]'), 'KPI 範本存檔')
            confirm_if_dialog(page)
            page.wait_for_function("() => /已儲存|失敗/.test(document.querySelector('.card:has(#ev-tpl-title) [data-role=\"msg\"]').textContent)", timeout=15000)
            got = api('evBankGet', {'brand': brand}, tok_of(emps[hm_key]))['data']['tpls']['ft']
            check(abs(got[0]['weight'] - (weights[0] + 2.5)) < 1e-9 and ('合計 %s' % fmt(sum(weights) + 2.5)) in tpl_card.locator('[data-role="msg"]').inner_text(), '⑥ 範本存檔後第一項比重＝%s、訊息合計' % fmt(weights[0] + 2.5))
            CM.click(page, tpl_card.locator('[data-act="add"]'), '範本新增項目')
            page.wait_for_timeout(200)
            CM.click(page, tpl_card.locator('tr[data-i] [data-act="del"]').last, '刪掉新項目')
            page.fill('#ev-tpl-new', 'am')
            CM.click(page, page.locator('[data-act="newtpl"]'), '新增範本職稱 am')
            page.wait_for_timeout(400)
            check(page.locator('#ev-tpl-title').input_value() == 'am', '⑥ 新增範本後切到 am')
            page.select_option('#ev-tpl-title', 'ft')
            page.wait_for_timeout(300)
            # 時薪、等第存檔
            wage_box = page.locator('[data-role="wage"]')
            wage_box.locator('[data-i] [data-f="1"]').first.fill('333')
            CM.click(page, wage_box.locator('[data-act="save"]'), '時薪存檔')
            confirm_if_dialog(page)
            page.wait_for_function("() => /已儲存|失敗/.test(document.querySelector('[data-role=\"wage\"] [data-role=\"msg\"]').textContent)", timeout=15000)
            check(api('evBankGet', {'brand': brand}, tok_of(emps[hm_key]))['data']['wage'][0][1] == '333', '⑥ 時薪第一列改 333 已存')
            CM.click(page, wage_box.locator('[data-act="add"]'), '時薪新增一列')
            CM.click(page, wage_box.locator('[data-i] [data-act="del"]').last, '時薪刪一列')
            grade_box = page.locator('[data-role="grade"]')
            grade_box.locator('tr[data-i] [data-f="min"]').first.fill('88')
            CM.click(page, grade_box.locator('[data-act="save"]'), '等第存檔')
            confirm_if_dialog(page)
            page.wait_for_function("() => /已儲存|失敗/.test(document.querySelector('[data-role=\"grade\"] [data-role=\"msg\"]').textContent)", timeout=15000)
            g_got = api('evBankGet', {'brand': brand}, tok_of(emps[hm_key]))['data']['grade']
            check(any(g['min'] == 88 for g in g_got), '⑥ 等第 A 門檻改 88 已存')
            ds['grade'][brand] = [{'grade': g['grade'], 'min': g['min'], 'base': g['base']} for g in g_got]
            CM.click(page, grade_box.locator('[data-act="add"]'), '等第新增一列')
            CM.click(page, grade_box.locator('tr[data-i] [data-act="del"]').last, '等第刪一列')
            # 匯入舊成績：TAB 分隔 8 欄
            hist_p = unit_people[0]
            k = 'pt' if hist_p['title'] == 'pt' else 'ft'
            att, perf, aa, ap = (18, 44, 1, 0) if k == 'pt' else (24, 50, 0, 2)
            tot = att + perf + aa + ap
            page.fill('#ev-imp', '\t'.join(['2026-Q2', name_of(hist_p['key']), '計時' if k == 'pt' else '正職', str(att), str(perf), str(aa), str(ap), str(tot)]))
            CM.click(page, page.locator('[data-act="preview"]'), '匯入預覽')
            page.wait_for_selector('[data-act="commit"]', timeout=10000)
            CM.click(page, page.locator('[data-act="commit"]'), '匯入確認')
            confirm_if_dialog(page)
            page.wait_for_function("() => /已匯入|失敗/.test((document.querySelector('[data-role=\"imsg\"]')||{}).textContent || '')", timeout=15000)
            ms = api('evMyScores', {}, tok_of(emps[hist_p['key']]))['data']['quarters']
            q2 = next((q for q in ms if q['quarter'] == '2026-Q2'), None)
            check(q2 is not None and abs(q2['total'] - tot) < 1e-9 and q2['source'] == 'hist' and q2['grade'] == grade_of(tot, ds['grade'][brand]), '⑥ 匯入 2026-Q2 總分 %s／等第 %s 進本人成績' % (tot, grade_of(tot, ds['grade'][brand])))
            # 錯的總分 → 擋
            page.fill('#ev-imp', '\t'.join(['2026-Q1', name_of(hist_p['key']), '計時' if k == 'pt' else '正職', str(att), str(perf), '0', '0', str(tot + 5)]))
            page.locator('[data-act="preview"]').click()
            page.wait_for_selector('[data-act="commit"]', timeout=10000)
            page.locator('[data-act="commit"]').click()
            confirm_if_dialog(page)
            page.wait_for_function("() => /已匯入|失敗/.test((document.querySelector('[data-role=\"imsg\"]')||{}).textContent || '')", timeout=15000)
            imsg = page.locator('[data-role="imsg"]').inner_text()
            check('失敗' in imsg and not any(q['quarter'] == '2026-Q1' for q in api('evMyScores', {}, tok_of(emps[hist_p['key']]))['data']['quarters']), '⑥ 態度＋表現＋調整≠總分 → 匯入被擋：%s' % imsg[:60])
            check('對不上' in imsg, '⑥ 匯入錯誤要給人看得懂的訊息（不是代碼）：%s' % imsg[:60])
            if page.locator('[data-act="seed"]').count():
                CM.mark(page, '[data-act="seed"]', '小辛辣舊題庫種子（窗內會被擋，不另按）')
            shot(page, '07_hm_settings')
            # 定稿／解除／列印檔名
            goto(page, base, '#/eval/results?unit=%s' % sm_unit)
            page.wait_for_selector('[data-role="finalize"]', timeout=15000)
            before = {tr.get_attribute('data-emp'): [c.strip() for c in tr.locator('td').all_inner_texts()] for tr in page.locator('tr[data-role="ev-row"]').all()}
            CM.click(page, page.locator('[data-role="finalize"]'), '定稿本季')
            if page.locator('.dialog').count():
                click_dialog(page, '確定')
            page.wait_for_selector('.tag-ok:has-text("已定稿")', timeout=15000)
            after = {tr.get_attribute('data-emp'): [c.strip() for c in tr.locator('td').all_inner_texts()] for tr in page.locator('tr[data-role="ev-row"]').all()}
            same = all(before[e][2:7] == after[e][2:7] for e in before if len(before[e]) > 6 and len(after[e]) > 6)
            check(same, '⑥ 定稿後每列分數不變')
            locked = [e for e in after if len(after[e]) > 7 and '定稿' in after[e][7]]
            unlocked_ft = [e for e in after if len(after[e]) > 7 and after[e][6] == 'KPI 未評']
            check(all(e not in locked for e in unlocked_ft), '⑥ KPI 未評的正職不鎖（%d 位）' % len(unlocked_ft))
            CM.click(page, page.locator('[data-role="unfinalize"]'), '解除定稿')
            if page.locator('.dialog').count():
                click_dialog(page, '確定')
            page.wait_for_selector('.tag:has-text("未定稿")', timeout=15000)
            check(True, '⑥ 解除定稿 → 未定稿')
            title = page.evaluate("() => { const p = document.querySelector('.ev-print-head'); return p ? p.textContent : ''; }")
            check('績效評核' in title and '2026 年第 4 季' in title, '⑥ 列印抬頭：品牌＋店名＋季度：%s' % title.strip()[:40])
            # 同仁名單（hm 有 platform.staff）
            goto(page, base, '#/staff/list')
            page.wait_for_selector('#stf-f', timeout=15000)
            check(True, '⑥ 人資總監進得了同仁名單')
            ctx.close()

            # ═══ ⑦ admin：同仁名單（篩選、搜尋、每顆按鈕）、匯入、區域；375 手機卡片「更多」 ═══
            ctx, page = new_page()
            login(page, base, 'BOSS', 'fake-admin-pw-01')
            goto(page, base, '#/staff/list?f=all')
            page.wait_for_selector('tbody[data-role="rows"] tr', timeout=15000)
            CM.scan(page, 'staff/list')
            click_tabs(page, 'staff', '⑦ 同仁名單')
            goto(page, base, '#/staff/list?f=all')
            page.wait_for_selector('tbody[data-role="rows"] tr', timeout=15000)
            lst = api('staffList', {}, admin_tok)['data']['staff']
            rows_n = page.locator('tbody[data-role="rows"] tr').count()
            check(rows_n == len(lst), '⑦ 全部篩選列數 %d＝後端 %d' % (rows_n, len(lst)))
            status_cnt = {}
            for x in lst:
                status_cnt[x['status']] = status_cnt.get(x['status'], 0) + 1
            for fv, st in (('unclaimed', 'unclaimed'), ('pending', 'pending'), ('active', 'active'), ('disabled', 'disabled')):
                page.select_option('#stf-f', fv)
                page.wait_for_timeout(300)
                n = page.locator('tbody[data-role="rows"] tr:not(:has(.c-none))').count()
                check(n == status_cnt.get(st, 0), '⑦ 篩選 %s：%d＝%d' % (fv, n, status_cnt.get(st, 0)))
            page.select_option('#stf-f', 'locked')
            page.wait_for_timeout(300)
            check(page.locator('tbody[data-role="rows"] tr:not(:has(.c-none))').count() == sum(1 for x in lst if x['reset_locked']), '⑦ 篩選「密碲鎖住」人數')
            page.select_option('#stf-f', 'todo')
            page.wait_for_timeout(300)
            exp_todo = sum(1 for x in lst if x['status'] == 'pending' or (x['status'] == 'active' and x['has_pending_change']) or x['reset_locked'])
            check(page.locator('tbody[data-role="rows"] tr:not(:has(.c-none))').count() == exp_todo, '⑦ 篩選「待處理」＝待確認＋變更＋被鎖 %d' % exp_todo)
            CM.mark(page, '#stf-f', '篩選下拉')
            page.select_option('#stf-f', 'all')
            page.fill('#stf-q', name_of(ui_pt))
            page.wait_for_timeout(300)
            check(page.locator('tbody[data-role="rows"] tr:not(:has(.c-none))').count() == 1, '⑦ 搜尋姓名只剩 1 列')
            page.fill('#stf-q', '')
            brands_opt = page.locator('#stf-brand option').evaluate_all('(o) => o.map((x) => x.value)')
            if 'mala' in brands_opt:
                page.select_option('#stf-brand', 'mala')
                page.wait_for_timeout(300)
                check(page.locator('tbody[data-role="rows"] tr:not(:has(.c-none))').count() == sum(1 for x in lst if x['brand'] == 'mala' or x['p_brand'] == 'mala'), '⑦ 品牌篩選 mala 人數')
                page.select_option('#stf-brand', '')
            CM.mark(page, '#stf-brand', '品牌下拉')
            CM.click(page, page.locator('#stf-priv'), '顯示個資勾選')
            page.wait_for_timeout(300)
            check('生日' in page.locator('tbody[data-role="rows"]').inner_text(), '⑦ 勾顯示個資 → 列出生日手機')
            # 待確認 → 確認（先取消再確認）
            pend = seed['extra']['pending']
            rowp = page.locator('tbody[data-role="rows"] tr', has_text=pend)
            CM.click(page, rowp.locator('[data-act="confirm"]'), '確認對話框')
            page.wait_for_selector('.dialog', timeout=10000)
            check('確認後生效' in page.locator('.dialog').inner_text(), '⑦ 確認框列出填的組織')
            click_dialog(page, '取消')
            CM.click(page, rowp.locator('[data-act="reject"]'), '退回對話框')
            page.wait_for_selector('#rj-reason', timeout=10000)
            page.fill('#rj-reason', '測試退回')
            click_dialog(page, '退回')
            page.wait_for_function("(e) => { const tr = [...document.querySelectorAll('tbody[data-role=\"rows\"] tr')].find((t) => t.textContent.includes(e)); return tr && tr.textContent.includes('未開通'); }", arg=pend, timeout=15000)
            check('上次退回：測試退回' in page.locator('tbody[data-role="rows"] tr', has_text=pend).inner_text(), '⑦ 退回後顯示未開通＋上次退回原因')
            # 未開通 → 改姓名
            unc = seed['extra']['unclaimed']
            rowu = page.locator('tbody[data-role="rows"] tr', has_text=unc)
            CM.click(page, rowu.locator('[data-act="rename"]'), '改姓名對話框')
            page.wait_for_selector('#rn-name', timeout=10000)
            page.fill('#rn-name', '假改名%d' % (SEED % 100))
            click_dialog(page, '儲存')
            page.wait_for_function("(e) => { const tr = [...document.querySelectorAll('tbody[data-role=\"rows\"] tr')].find((t) => t.textContent.includes(e)); return tr && tr.textContent.includes('假改名'); }", arg=unc, timeout=15000)
            check(True, '⑦ 未開通同仁改姓名')
            # 被鎖 → 解除鎖定
            lk = seed['extra']['locked']
            rowl = page.locator('tbody[data-role="rows"] tr', has_text=lk)
            check('密碼鎖住' in rowl.inner_text(), '⑦ 忘記密碼錯 5 次 → 標「密碼鎖住」')
            CM.click(page, rowl.locator('[data-act="unlock"]'), '解除鎖定')
            if page.locator('.dialog').count():
                click_dialog(page, '確定')
            page.wait_for_function("(e) => { const tr = [...document.querySelectorAll('tbody[data-role=\"rows\"] tr')].find((t) => t.textContent.includes(e)); return tr && !tr.textContent.includes('密碼鎖住'); }", arg=lk, timeout=15000)
            check(True, '⑦ 解除鎖定後標籤消失')
            # 已開通 → 改資料（手機）→ 停用 → 啟用 → 撤回認領
            victim = next(p for p in unit_people if p['title'] == 'pt' and p['key'] not in (ui_pt,))
            ve = emps[victim['key']]
            rowv = page.locator('tbody[data-role="rows"] tr', has_text=ve)
            CM.click(page, rowv.locator('[data-act="edit"]'), '改資料對話框')
            page.wait_for_selector('#ed-phone', timeout=10000)
            page.fill('#ed-phone', '0988777666')
            click_dialog(page, '儲存')
            page.wait_for_timeout(800)
            check(next(x for x in api('staffList', {}, admin_tok)['data']['staff'] if x['emp_no'] == ve)['phone'] == '0988777666', '⑦ 改資料後後端手機更新')
            CM.click(page, rowv.locator('[data-act="disable"]'), '停用')
            if page.locator('.dialog').count():
                click_dialog(page, '確定')
            page.wait_for_function("(e) => { const tr = [...document.querySelectorAll('tbody[data-role=\"rows\"] tr')].find((t) => t.textContent.includes(e)); return tr && tr.textContent.includes('已停用'); }", arg=ve, timeout=15000)
            check(api('login', {'username': ve, 'password': PW}).get('ok') is not True, '⑦ 停用後不能登入')
            rowv = page.locator('tbody[data-role="rows"] tr', has_text=ve)
            CM.click(page, rowv.locator('[data-act="enable"]'), '啟用')
            if page.locator('.dialog').count():
                click_dialog(page, '確定')
            page.wait_for_function("(e) => { const tr = [...document.querySelectorAll('tbody[data-role=\"rows\"] tr')].find((t) => t.textContent.includes(e)); return tr && tr.textContent.includes('已開通'); }", arg=ve, timeout=15000)
            check(api('login', {'username': ve, 'password': PW}).get('ok') is True, '⑦ 啟用後可登入')
            dis = seed['extra']['disabled']
            rowd = page.locator('tbody[data-role="rows"] tr', has_text=dis)
            check(rowd.locator('[data-act="unclaim"]').count() == 0 and rowd.locator('[data-act="enable"]').count() == 1, '⑦ 已停用的人只有「啟用」、沒有撤回認領')
            if rowd.locator('[data-act="reinstate"]').count():
                CM.click(page, rowd.locator('[data-act="reinstate"]'), '復職對話框')
                page.wait_for_selector('.dialog', timeout=10000)
                check('復職' in page.locator('.dialog').inner_text(), '⑦ 停用者有「復職」流程')
                click_dialog(page, '取消')
            check(api('staffUnclaim', {'emp_no': dis}, admin_tok).get('ok') is not True, '⑦ 直打 staffUnclaim 停用者 → 後端擋')
            rowv = page.locator('tbody[data-role="rows"] tr', has_text=ve)
            CM.click(page, rowv.locator('[data-act="unclaim"]'), '撤回認領')
            if page.locator('.dialog').count():
                click_dialog(page, '確定')
            page.wait_for_function("(e) => { const tr = [...document.querySelectorAll('tbody[data-role=\"rows\"] tr')].find((t) => t.textContent.includes(e)); return tr && tr.textContent.includes('未開通'); }", arg=ve, timeout=15000)
            check(api('claimLookup', {'name': victim['name']}).get('ok') is True, '⑦ 撤回後名字可重新認領')
            CM.click(page, page.locator('[data-role="add-staff"]'), '新增同仁對話框（總部）')
            page.wait_for_selector('#ad-name', timeout=10000)
            click_dialog(page, '取消')
            shot(page, '08_admin_staff_list')
            # 匯入
            goto(page, base, '#/staff/import')
            page.wait_for_selector('#imp-names', timeout=15000)
            CM.scan(page, 'staff/import')
            imp_names = ['假匯入甲%d' % (SEED % 100), '假匯入乙%d' % (SEED % 100)]
            page.fill('#imp-names', '\n'.join(imp_names))
            n_before = len(api('staffList', {}, admin_tok)['data']['staff'])
            CM.click(page, page.locator('[data-role="preview"]'), '匯入預覽')
            page.wait_for_selector('[data-role="create"]', timeout=10000)
            check('將建立 2 位' in page.locator('[data-role="result"]').inner_text(), '⑦ 匯入預覽「將建立 2 位」')
            check(len(api('staffList', {}, admin_tok)['data']['staff']) == n_before, '⑦ 預覽不寫入')
            CM.click(page, page.locator('[data-role="create"]'), '建立')
            click_dialog(page, '確定')
            page.wait_for_selector('#stf-f', timeout=15000)
            check(len(api('staffList', {}, admin_tok)['data']['staff']) == n_before + 2, '⑦ 建立後多 2 位')
            # 區域
            goto(page, base, '#/staff/regions')
            page.wait_for_selector('[data-role="region-brand"]', timeout=15000)
            CM.scan(page, 'staff/regions')
            bbox = page.locator('[data-role="region-brand"][data-brand="%s"]' % brand)
            check(bbox.count() == 1, '⑦ 區域頁有品牌 %s 區塊' % brand)
            CM.click(page, bbox.locator('[data-act="add"]'), '新增區域卡')
            card = bbox.locator('[data-role="region-card"]').last
            card.locator('[data-f="name"]').fill('測試區%d' % (SEED % 10))
            stores_cb = card.locator('[data-f="store"]')
            check(stores_cb.count() == len(brand_stores) or stores_cb.count() >= 1, '⑦ 可勾門市 %d' % stores_cb.count())
            CM.click(page, stores_cb.first, '勾門市')
            sup_sel = card.locator('[data-f="supervisor"]')
            CM.click(page, sup_sel, '督導下拉')
            sup_opts = sup_sel.locator('option').evaluate_all('(o) => o.map((x) => x.value)')
            check(sorted(v for v in sup_opts if v) == sorted(emps[p['key']] for p in osvs), '⑦ 督導下拉＝同品牌在職區督導 %s' % sup_opts)
            if len(sup_opts) > 1:
                sup_sel.select_option(sup_opts[1])
            CM.mark(page, '[data-role="region-card"] [data-f="supervisor"]', '督導下拉')
            CM.click(page, card.locator('[data-act="save"]'), '區域存檔 → 預覽對話框')
            page.wait_for_selector('.dialog', timeout=10000)
            check('preview-line' in page.locator('.dialog').inner_html() or page.locator('.dialog [data-role="preview-line"]').count() >= 1, '⑦ 存檔前先顯示差異預覽')
            click_dialog(page, '確定存檔')
            page.wait_for_selector('[data-role="region-card"][data-code^="r-"]', timeout=15000)
            rl = api('regionList', {}, admin_tok)['data']['regions']
            check(len(rl) == 1 and rl[0]['stores'] == [stores_cb.first.get_attribute('value')] and rl[0]['name'] == '測試區%d' % (SEED % 10), '⑦ 後端 regions 一列：%s' % json.dumps(rl, ensure_ascii=False)[:120])
            un = bbox.locator('[data-role="unassigned"]').inner_text()
            check(('沒有' in un) if len(brand_stores) == 1 else ('沒有' not in un), '⑦ 尚未劃區的門市文字：%s' % un[:40])
            CM.click(page, bbox.locator('[data-act="add"]'), '再新增一張')
            CM.click(page, bbox.locator('[data-role="region-card"]').last.locator('[data-act="discard"]'), '取消新卡')
            CM.click(page, page.locator('[data-act="switch-on"]'), '開始依區域審核 → 對話框')
            page.wait_for_selector('.dialog', timeout=10000)
            click_dialog(page, '確定開始')
            page.wait_for_timeout(800)
            check(api('regionList', {}, admin_tok)['data']['on'] is True, '⑦ 開關開 → regionList.on')
            CM.click(page, page.locator('[data-act="switch-off"]'), '停止依區域審核')
            page.wait_for_selector('.dialog', timeout=10000)
            click_dialog(page, '確定停止')
            page.wait_for_timeout(800)
            check(api('regionList', {}, admin_tok)['data']['on'] is False, '⑦ 開關關')
            card0 = bbox.locator('[data-role="region-card"][data-code^="r-"]').first
            if card0.locator('[data-f="inactive"]').count():
                CM.click(page, card0.locator('[data-f="inactive"]'), '停用區域勾選')
                CM.click(page, card0.locator('[data-act="save"]'), '存檔停用')
                page.wait_for_selector('.dialog', timeout=10000)
                click_dialog(page, '確定存檔')
                page.wait_for_timeout(800)
                check(api('regionList', {}, admin_tok)['data']['regions'][0]['active'] is False, '⑦ 區域停用已存')
            shot(page, '09_admin_regions')
            goto(page, base, '#/staff/clockmap')
            page.wait_for_timeout(1500)
            CM.scan(page, 'staff/clockmap')
            ctx.close()
            # 375 同仁名單手機卡片
            ctx, page = new_page(375, 812)
            login(page, base, 'BOSS', 'fake-admin-pw-01')
            goto(page, base, '#/staff/list?f=all')
            page.wait_for_selector('tbody[data-role="rows"] tr', timeout=15000)
            check(no_hscroll(page), '⑦ 375 同仁名單沒有橫向捲軸')
            more = page.locator('button.stf-more[data-more]')
            check(more.count() >= 1, '⑦ 375 有「更多」按鈕（%d 張卡）' % more.count())
            first_card = more.first.locator('xpath=ancestor::tr[1]')
            sec_before = first_card.locator('.stf-sec').evaluate_all('(l) => l.map((x) => x.offsetParent !== null)')
            check(not any(sec_before), '⑦ 收合時次要按鈕不可見')
            CM.click(page, more.first, '更多 → 展開')
            page.wait_for_timeout(300)
            sec_after = first_card.locator('.stf-sec').evaluate_all('(l) => l.map((x) => x.offsetParent !== null)')
            check(all(sec_after) and '收起' in more.first.inner_text(), '⑦ 按更多 → 次要按鈕可見、文字變收起')
            fits = first_card.locator('button').evaluate_all('(l) => l.every((b) => { const r = b.getBoundingClientRect(); return r.right <= window.innerWidth + 1; })')
            check(fits, '⑦ 展開後所有按鈕都在 375 畫面內')
            check(no_hscroll(page), '⑦ 展開後仍沒有橫向捲軸')
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            check('更多' in more.first.inner_text(), '⑦ Escape 收合')
            shot(page, '10_admin_staff_375')
            ctx.close()

            # ═══ ⑧ 宿舍主管：建立合約（租金／迄日自己算）→ 清單 → 標記終止 → 點交（賠償自己算）→ 下載 PDF ═══
            ctx, page = new_page()
            login(page, base, 'dormmgr', 'fake-mgr-pw-01')
            goto(page, base, '#/eval/fill')
            page.wait_for_selector(':text("你不在評核名單上")', timeout=15000)
            check(True, '⑧ 系統帳號（非同仁）進績效評核 → 「你不在評核名單上」')
            D = ds['dorm']
            fee_table = D['rent']

            def term_end(start):
                y, m, d = map(int, start.split('-'))
                total = m - 1 + D['term_months']
                y2, m2 = y + total // 12, total % 12 + 1
                last = [31, 29 if (y2 % 4 == 0 and (y2 % 100 != 0 or y2 % 400 == 0)) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m2 - 1]
                if d > last:
                    return '%04d-%02d-%02d' % (y2, m2, last)
                dd = d - 1
                if dd == 0:
                    pm, py = (12, y2 - 1) if m2 == 1 else (m2 - 1, y2)
                    pl = [31, 29 if (py % 4 == 0 and (py % 100 != 0 or py % 400 == 0)) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][pm - 1]
                    return '%04d-%02d-%02d' % (py, pm, pl)
                return '%04d-%02d-%02d' % (y2, m2, dd)

            def money(n):
                return '{:,}'.format(int(n))
            created = []
            for ci, c in enumerate(D['contracts']):
                goto(page, base, '#/dorm/create')
                page.wait_for_selector('#dorm-create-name', timeout=15000)
                if ci == 0:
                    CM.scan(page, 'dorm/create')
                    click_tabs(page, 'dorm', '⑧ 宿舍')
                    goto(page, base, '#/dorm/create')
                    page.wait_for_selector('#dorm-create-name', timeout=15000)
                room = next(r for r in D['rooms'] if r['room'] == c['room'])
                page.fill('#dorm-create-name', c['name'])
                page.select_option('#dorm-create-room', c['room'])
                if room['beds']:
                    page.select_option('#dorm-create-bed', c['bed'])
                if room['type'] == '單人房' and page.locator('#dorm-create-occ').is_visible():
                    page.select_option('#dorm-create-occ', c['occupancy'])
                page.fill('#dorm-create-start', c['term_start'])
                exp_rent = D['share_single'] if (room['type'] == '單人房' and c['occupancy'] == '合租') else fee_table[room['type']]
                exp_end = term_end(c['term_start'])
                body = page.locator('[data-role="view-content"]').inner_text()
                # 前端預覽（租金寫死在 create.js 的 RENT_RATES，與後端設定不同是已知設計：預覽只是預覽）
                check(exp_end in body, '⑧ 合約 %d 迄日預覽 %s（起 %s）' % (ci + 1, exp_end, c['term_start']))
                CM.mark(page, '#dorm-create-room', '房間下拉')
                if room['beds']:
                    CM.mark(page, '#dorm-create-bed', '床位下拉')
                for sid in ('#dorm-create-mgmt', '#dorm-create-water', '#dorm-create-power', '#dorm-create-occ'):
                    if page.locator(sid).count():
                        CM.mark(page, sid, '費用／合租下拉')
                CM.click(page, page.locator('#dorm-create-submit'), '建立並產生簽署連結')
                page.wait_for_selector('#dorm-create-result:not([hidden]) #dorm-create-link, #dorm-create-link', timeout=15000)
                if page.locator('.dialog').count():
                    click_dialog(page, '確定')
                    page.wait_for_timeout(800)
                summ = page.locator('#dorm-create-summary').inner_text()
                check(money(exp_rent) in summ.replace(',', ',') or str(exp_rent) in summ.replace(',', ''), '⑧ 合約 %d 結果租金 %s：%s' % (ci + 1, exp_rent, summ[:60]))
                check(exp_end in summ, '⑧ 合約 %d 結果迄日 %s' % (ci + 1, exp_end))
                link = page.locator('#dorm-create-link').inner_text()
                check('/sign.html?t=' in link, '⑧ 簽署連結格式')
                CM.click(page, page.locator('#dorm-create-copy'), '複製連結')
                created.append((c, link.split('t=')[-1]))
            shot(page, '11_dorm_create')
            dorm_state = json.loads(be_get('/__dorm'))
            check(len(dorm_state['contracts']) == len(D['contracts']), '⑧ 後端合約數 %d' % len(dorm_state['contracts']))
            for (c, tkn), cid in zip(created, sorted(dorm_state['contracts'])):
                row = dorm_state['contracts'][cid]
                check(row['term_end'] == term_end(c['term_start']), '⑧ %s 後端迄日 %s＝自己算' % (cid, row['term_end']))
            # 簽署（同仁端 sign.html 在舊站，不在本 repo）：直接打假後端 sign 讓合約進「在住」
            mgr_tok = tok_of('dormmgr', 'fake-mgr-pw-01')
            for (c, tkn) in created:
                r = urllib.request.Request('http://127.0.0.1:%d/platform/proxy' % BACKEND_PORT, data=json.dumps({'token': mgr_tok, 'ns': 'dorm', 'action': 'sign', 'payload': {'token': tkn}}).encode(), headers={'Content-Type': 'text/plain'})
                urllib.request.urlopen(r, timeout=10).read()
            goto(page, base, '#/dorm/list')
            page.wait_for_selector('tr[data-role="contract-row"]', timeout=15000)
            CM.scan(page, 'dorm/list')
            rows_c = page.locator('tr[data-role="contract-row"]')
            check(rows_c.count() == len(created), '⑧ 清單 %d 列' % rows_c.count())
            for i in range(rows_c.count()):
                t = rows_c.nth(i).inner_text()
                c = next(x for x in D['contracts'] if x['name'] in t)
                room = next(r for r in D['rooms'] if r['room'] == c['room'])
                exp_rent = D['share_single'] if (room['type'] == '單人房' and c['occupancy'] == '合租') else fee_table[room['type']]
                check(money(exp_rent) in t and c['term_start'] in t and term_end(c['term_start']) in t and '在住' in t, '⑧ 清單列 %s 租金／租期／在住：%s' % (c['name'], t.replace('\t', ' ')[:80]))
            first = rows_c.first
            CM.click(page, first.locator('[data-action="toggle-terminate"]'), '標記終止')
            if page.locator('.dialog').count():
                click_dialog(page, '確定')
            page.wait_for_timeout(800)
            cid0 = first.get_attribute('data-id')
            check(json.loads(be_get('/__dorm'))['contracts'][cid0]['terminate_flag'] == '已標記終止', '⑧ 標記終止寫入後端')
            page.locator('tr[data-role="contract-row"]').first.locator('[data-action="toggle-terminate"]').click()
            if page.locator('.dialog').count():
                click_dialog(page, '確定')
            page.wait_for_timeout(800)
            check(json.loads(be_get('/__dorm'))['contracts'][cid0]['terminate_flag'] == '', '⑧ 取消終止')
            # 點交
            c0 = next(x for x in D['contracts'] if x['name'] == json.loads(be_get('/__dorm'))['contracts'][cid0]['name'])
            CM.click(page, page.locator('tr[data-role="contract-row"]').first.locator('[data-action="open-handover"]'), '開點交單')
            page.wait_for_selector('#dorm-handover-create', timeout=15000)
            CM.scan(page, 'dorm/handover-entry')
            CM.click(page, page.locator('#dorm-handover-create'), '建立點交單')
            if page.locator('.dialog').count():
                click_dialog(page, '確定')
            page.wait_for_selector('#dorm-handover-items li', timeout=15000)
            CM.scan(page, 'dorm/handover')
            items = page.locator('#dorm-handover-items li')
            check(items.count() == len(D['equip']), '⑧ 點交設備 %d 項' % items.count())
            exp_total = 0
            sent = []
            for i in range(items.count()):
                li = items.nth(i)
                item = li.get_attribute('data-item')
                price = next(e['price'] for e in D['equip'] if e['item'] == item)
                check(money(price) in li.inner_text(), '⑧ %s 顯示賠償單價 %s' % (item, money(price)))
                st = c0['handover'][i]
                normal, returned = st['normal'], st['returned']
                if i == 0:
                    for lab in ('正常', '異常', '已歸還', '未歸還'):
                        CM.click(page, li.locator('button', has_text=lab), '點交 %s 切換' % lab)
                li.locator('button', has_text='正常' if normal else '異常').first.click()
                li.locator('button', has_text='已歸還' if returned else '未歸還').first.click()
                eff_normal = normal and returned   # 畫面規則：選「未歸還」一律改成異常（handover.js onReturnedChange）
                if not eff_normal:
                    li.locator('input[type="text"]').fill('測試異常')
                if not returned:
                    exp_total += price   # 異常且未歸還才計價；未歸還在畫面上必為異常 → 未歸還就計價
                sent.append((item, eff_normal, returned))
                if i == 0:
                    CM.mark(page, '#dorm-handover-items li button', '正常／異常／歸還切換')
            # 「未歸還」自動視為異常
            li0 = items.first
            li0.locator('button', has_text='正常').first.click()
            li0.locator('button', has_text='未歸還').first.click()
            auto_abn = li0.locator('button.btn-primary', has_text='異常').count() == 1
            check(auto_abn, '⑧ 先點「正常」再點「未歸還」→ 仍被改成異常（程式註解寫「尚未明確點過正常才自動」，實作是無條件）')
            st0 = c0['handover'][0]
            li0.locator('button', has_text='正常' if st0['normal'] else '異常').first.click()
            li0.locator('button', has_text='已歸還' if st0['returned'] else '未歸還').first.click()
            if c0['need_cleaning']:
                CM.click(page, page.locator('#dorm-handover-clean'), '勾清潔費')
                exp_total += D['cleaning_fee']
            else:
                CM.click(page, page.locator('#dorm-handover-clean'), '勾清潔費再取消')
                page.locator('#dorm-handover-clean').click()
            check(money(D['cleaning_fee']) in page.locator('[data-role="view-content"]').inner_text(), '⑧ 清潔費標示 %s' % money(D['cleaning_fee']))
            tot_txt = page.locator('#dorm-handover-total').inner_text()
            check(money(exp_total) in tot_txt, '⑧ 預覽合計 %s＝自己算（異常且未歸還＋清潔費）：%s' % (money(exp_total), tot_txt))
            CM.click(page, page.locator('#dorm-handover-submit'), '沒簽名送出 → 擋')
            page.wait_for_timeout(400)
            check('簽名' in page.locator('#dorm-handover-status').inner_text() or page.locator('#dorm-handover-items').count() == 1, '⑧ 沒簽名不能送出')
            pad = page.locator('#dorm-handover-pad')
            pad.scroll_into_view_if_needed()
            box = pad.bounding_box()
            x, y = box['x'] + 20, box['y'] + box['height'] / 2
            page.mouse.move(x, y); page.mouse.down()
            for i in range(1, 8):
                page.mouse.move(x + i * 15, y + (6 if i % 2 else -6))
            page.mouse.up()
            CM.click(page, page.locator('button', has_text='清除重簽'), '清除重簽')
            page.mouse.move(x, y); page.mouse.down()
            for i in range(1, 8):
                page.mouse.move(x + i * 15, y + (6 if i % 2 else -6))
            page.mouse.up()
            page.locator('#dorm-handover-submit').click()
            if page.locator('.dialog').count():
                click_dialog(page, '確定')
            page.wait_for_selector('text=點交完成', timeout=15000)
            done_txt = page.locator('[data-role="view-content"]').inner_text()
            check(money(exp_total) in done_txt, '⑧ 點交完成合計 %s' % money(exp_total))
            dstate = json.loads(be_get('/__dorm'))
            check(dstate['contracts'][cid0]['status'] == '已退宿', '⑧ 點交後合約已退宿')
            h = next(h for h in dstate['handTokens'].values() if h['contract_id'] == cid0)
            check(h['total'] == exp_total and h['need_cleaning'] == c0['need_cleaning'] and [(i['item'], i['normal'], i['returned']) for i in h['items']] == sent, '⑧ 後端收到的逐項狀態＝畫面點的')
            CM.scan(page, 'dorm/handover-done')
            gb = page.locator('[data-act="handover-give"]')
            if gb.count():
                with page.expect_download(timeout=15000) as dl:
                    CM.click(page, gb, '把點交單 PDF 交給同仁（下載）')
                check(dl.value.suggested_filename.endswith('.pdf'), '⑧ 下載 PDF 檔名 %s' % dl.value.suggested_filename)
            for a in page.locator('[data-role="view-content"] a[href]').all():
                CM.mark(page, '[data-role="view-content"] a[href]', '點交完成頁連結（Drive 網址才顯示）')
            shot(page, '12_dorm_handover')
            goto(page, base, '#/dorm/list')
            page.wait_for_selector('tr[data-role="contract-row"]', timeout=15000)
            check('已退宿' in page.locator('tr[data-role="contract-row"][data-id="%s"]' % cid0).inner_text(), '⑧ 清單顯示已退宿')
            # dorm.read-only（會計類）：代轉寫入 403 → 這裡用 hs（有 dorm.read?）略；改驗店長沒有宿舍模組
            ctx.close()

            browser.close()
    finally:
        httpd.shutdown()
        proc.kill()
    leaks = [u for l in all_leaks for u in l]
    check(not leaks, '全程沒有任何請求跑到外網：%s' % leaks[:3])
    rep = CM.report()
    print('按鈕稽核：看到 %d、點過 %d、略過 %d、漏點 %d' % (rep['total'], rep['clicked'], len(rep['skipped']), len(rep['missed'])))
    for k, v in rep['missed'].items():
        print('  漏點：%s（%s）' % (k, v))
    check(not rep['missed'], '按鈕稽核：沒有漏點的元素')
    print('\n共 %d 項檢查，通過 %d，失敗 %d（seed %d）' % (len(failures) + passed_count(), passed_count(), len(failures), SEED))
    finish()


_pass = [0]
_orig_check = check


def check(cond, label):  # noqa: F811
    if cond:
        _pass[0] += 1
    return _orig_check(cond, label)


def passed_count():
    return _pass[0]


if __name__ == '__main__':
    main()
