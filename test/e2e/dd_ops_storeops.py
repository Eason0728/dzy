#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dd ops ②：門市營運（modules/storeops，iframe 嵌營運系統＋平台 tabs.js 動態頁頂分頁）資料帶入 e2e。

全程 mock：營運系統網址（https://dzy-bulletin.github.io/**）由假頁面取代，平台後端用 common.MockBackend（ssoTicket 回假券）。
本機以外任何網址（re ^https?://(?!127\\.0\\.0\\.1)）除了上面兩個被 route 接住的以外，一律擋下並記為失敗。

每次全部隨機重抽：
  - 角色（營運部／總監／督導／店長／區經理／一般同仁／admin）各一位，衍生權限 platform.storeops／att／sched 隨角色規則抽
    → 首頁卡片、左側選單、分頁的有無由本檔照 manifest requires 自己算。
  - 營運系統送來的選單：1～26 個項目，id 合格／不合格（大寫、太長、數字開頭、重複）、label 隨機長度（超過 12 字要截）、
    badge 隨機（0、負數、小數、>999、字串）、err 旗標、cur 指到合格／不合格的 id → 頁頂分頁＝本檔照 platform/tabs.js 規則算的結果；
    每顆分頁都點過，收到的 dzy-store-go id 逐一比對；超過 20 項整份丟掉。
  - return 導回：隨機生成合格／不合格網址（別的主機、同名前綴主機、帳密夾帶、javascript:、反斜線、本機不同埠）→ 導回／不導回＝oracle。
用法：python3 test/e2e/dd_ops_storeops.py　　重現：E2E_SEED=<種子>　　埠：E2E_PORT（預設 9102）
"""
import json
import os
import random
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ROOT, USERS, MockBackend, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('E2E_PORT', '9102'))
STORE = 'https://dzy-bulletin.github.io'
SEED = int(os.environ.get('E2E_SEED') or random.randrange(1, 10**9))
rnd = random.Random(SEED)
print('E2E_SEED=%d' % SEED)
SHOT_DIR = os.path.join(ROOT, 'test', 'dd', 'artifacts', 'ops')
EXTERNAL = re.compile(r'^https?://(?!127\.0\.0\.1)')
TICKET = ''.join(rnd.choice('0123456789abcdef') for _ in range(64))

FAKE_STORE = """<!doctype html><meta charset="utf-8"><title>fake store</title>
<script>
window.__got = [];
window.addEventListener('message', function (e) { window.__got.push({ origin: e.origin, data: e.data }); });
if (window.parent !== window) window.parent.postMessage({ type: 'dzy-store-ready', v: 1 }, '*');
</script><body>fake store</body>"""


# ───────────────────────── oracle：tabs.js 規則 ─────────────────────────
ID_RE = re.compile(r'^[a-z][a-z0-9-]{0,30}$')


def sanitize_tabs(items):
    if not isinstance(items, list) or len(items) > 20:
        return None
    out, seen = [], set()
    for t in items:
        if not isinstance(t, dict):
            continue
        tid = t.get('id')
        if not isinstance(tid, str) or not ID_RE.match(tid) or tid in seen:
            continue
        label = t.get('label')
        if not isinstance(label, str):
            continue   # embed.js navTabs：label 不是字串就丟
        name = re.sub(r'\s+', ' ', label).strip()[:12]
        if not name:
            continue
        b = t.get('badge')
        # embed.js badgeNum（2026-10-29）：只收 number（布林 true 不再變 1、字串 '33' 不算）、有限且 >0，小數無條件捨去；tabs.js：整數 >0 才算，上限 999
        n = int(b) if isinstance(b, (int, float)) and not isinstance(b, bool) and b == b and b not in (float('inf'), float('-inf')) and b > 0 else 0
        badge = min(n, 999)
        seen.add(tid)
        out.append({'id': tid, 'name': name, 'badge': badge, 'err': t.get('err') is True})
    return out


def random_nav():
    n = rnd.choice([1, 2, 3, 5, 8, 12, 19, 20, 21, 26])
    items = []
    for i in range(n):
        kind = rnd.random()
        if kind < 0.7:
            tid = rnd.choice(['home', 'duty', 'inventory', 'staffperm', 'cash', 'transfer', 'schedule', 'purchase']) + ('' if rnd.random() < 0.5 else '-%d' % i)
        elif kind < 0.8:
            tid = rnd.choice(['BAD', '9lives', 'x' * 32, 'has space', 'ünï'])
        elif kind < 0.9:
            tid = items[rnd.randrange(len(items))]['id'] if items else 'dup'
        else:
            tid = rnd.choice([None, 7, ''])
        label = rnd.choice(['首頁', '出勤核定', '庫存盤點', '本店同仁權限', '  空白前後  ', '很長很長的分頁名稱超過十二個字了喔', '', '多個   空白   合併', 12])
        badge = rnd.choice([0, 1, 3, 33, 999, 1000, 5000, -2, 1.5, 'abc', None, True])
        it = {'id': tid, 'label': label, 'badge': badge}
        if rnd.random() < 0.2:
            it['err'] = rnd.choice([True, 'yes', 1])
        items.append(it)
    good = [t['id'] for t in (sanitize_tabs(items) or [])]
    cur = rnd.choice(good + ['nope', '']) if good else rnd.choice(['nope', ''])
    return items, cur


def tab_text(t):
    return t['name'] + (str(t['badge']) if t['badge'] else '')


# ───────────────────────── oracle：embed.js safeReturnUrl（管理系統跑在 127.0.0.1）─────────────────────────
def safe_return(raw):
    if not isinstance(raw, str) or raw == '' or len(raw) > 2000:
        return None
    if re.search(r'[\x00- \\]', raw):
        return None
    if not (raw.startswith(STORE + '/dzy-store/') or raw.startswith('http://localhost:') or raw.startswith('http://127.0.0.1:')):
        return None
    try:
        u = urllib.parse.urlsplit(raw)
    except ValueError:
        return None
    if u.username or u.password:
        return None
    host = u.hostname or ''
    port = u.port
    is_store = u.scheme == 'https' and host == 'dzy-bulletin.github.io' and (port is None) and u.path.startswith('/dzy-store/')
    is_local = u.scheme == 'http' and host in ('localhost', '127.0.0.1') and port is not None
    if not (is_store or is_local):
        return None
    return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, u.query, ''))


def random_returns(base):
    goods = [STORE + '/dzy-store/?from=login', STORE + '/dzy-store/?s=gf&x=%d' % rnd.randrange(100), STORE + '/dzy-store/sub/page.html#frag', base + '/index.html?back=1']
    bads = ['https://evil.example/dzy-store/', STORE + '.evil.example/dzy-store/', 'https://dzy-bulletin.github.io@evil.example/dzy-store/',
            'javascript:alert(1)', 'http://localhost:80@evil.example/', STORE + '/other/', 'http://dzy-bulletin.github.io/dzy-store/',
            STORE + '/dzy-store/?a=1 b', STORE + '\\dzy-store/', 'http://localhost/', 'https://localhost:9999/dzy-store/', '']
    picks = rnd.sample(goods, rnd.randint(1, 2)) + rnd.sample(bads, rnd.randint(3, 6))
    rnd.shuffle(picks)
    return picks


class DDMock(MockBackend):
    def __init__(self, base):
        super().__init__(base)
        self.sso_calls = []
        self.att_alerts = {'ok': True, 'data': {'items': [], 'partial': False, 'asOf': '2026-10-29T00:00:00Z', 'pending': False}}
        self.sched_alerts = {'ok': True, 'data': {'items': [], 'asOf': '2026-10-29T00:00:00Z'}}

    def platform_action(self, action, body):
        if action == 'ssoTicket':
            payload = body.get('payload') or {}
            if payload.get('aud') == 'store':
                self.sso_calls.append(payload)
            if payload.get('aud') != 'store':
                return {'ok': False, 'error': '不支援的系統'}
            return {'ok': True, 'data': {'ticket': TICKET, 'expires_in': 60}}
        return super().platform_action(action, body)


def main():
    os.makedirs(SHOT_DIR, exist_ok=True)
    httpd, base = start_server(PORT)
    mock = DDMock(base)
    leaks = []
    store_hits = []

    # 角色 → 衍生權限（照 StoreOps.gs 閘門規則抽：門市人員在試點就有 storeops；店長同等職有 att＋sched；督導／總監有 att 沒 sched；
    # 總部一般同仁什麼都沒有；admin 是 *）。這裡的 perms 是「平台後端算好的結果」，前端只看它。
    cast = {}

    def add(key, name, perms):
        cast[key] = {'name': name, 'perms': perms}
        USERS[key] = {'password': 'e2e-pw', 'perms': perms, 'user': {'id': 'u-' + key, 'name': name, 'role': 'staff', 'node': ''}}
    in_pilot = rnd.random() < 0.85
    add('sm', '假店長', ['platform.self'] + (['platform.storeops', 'platform.att', 'platform.sched'] if in_pilot else []))
    add('am', '假區經理', ['platform.self'] + (['platform.storeops', 'platform.att', 'platform.sched'] if in_pilot else []))
    add('osv', '假督導', ['platform.self'] + (['platform.att'] if in_pilot else []) + (['platform.storeops'] if rnd.random() < 0.3 else []))
    add('odir', '假總監', ['platform.self'] + (['platform.storeops', 'platform.att'] if in_pilot else []))
    add('pt', '假計時', ['platform.self'] + (['platform.storeops'] if in_pilot and rnd.random() < 0.8 else []))
    add('ops', '假營運部', ['platform.self'] + (['platform.storeops'] if rnd.random() < 0.3 else []))
    add('hr', '假人資同仁', ['platform.self', 'platform.staff'])
    print('試點 %s；角色權限：%s' % (in_pilot, {k: [p for p in v['perms'] if p.startswith('platform.') and p != 'platform.self'] for k, v in cast.items()}))

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def new_page(w=1280, h=800):
                ctx = browser.new_context(viewport={'width': w, 'height': h})
                pg = ctx.new_page()

                def guard(route):
                    u = route.request.url
                    if u.startswith(STORE + '/dzy-store/'):
                        store_hits.append(u)
                        return route.fulfill(status=200, content_type='text/html; charset=utf-8', body=FAKE_STORE)
                    if any(u.startswith(x) for x in mock.urls.values()):
                        return route.fallback()
                    leaks.append(u)
                    return route.abort()
                pg.route(EXTERNAL, guard)
                mock.install(pg)
                return pg

            def do_login(pg, user):
                pg.goto(base + '/index.html')
                pg.fill('#login-username', user)
                pg.fill('#login-password', USERS[user]['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)

            def store_frame(pg):
                for f in pg.frames:
                    if f.url.startswith(STORE + '/dzy-store/'):
                        return f
                return None

            def wait_frame(pg):
                fr = None
                for _ in range(60):
                    fr = store_frame(pg)
                    if fr:
                        try:
                            if fr.evaluate('() => window.__got.length') >= 1:
                                return fr
                        except Exception:
                            pass
                    pg.wait_for_timeout(100)
                return fr

            # ① 每個角色：首頁卡片／左側選單／門市營運模組有無 ＝ oracle（manifest requires）
            for key, c in cast.items():
                pg = new_page()
                do_login(pg, key)
                ids = [x.get_attribute('data-module') for x in pg.locator('[data-role="module-card"]').all()]
                nav = lambda m: pg.locator('[data-role="nav-desktop"] [data-nav="%s"]' % m).count()
                want = {'storeops': 'platform.storeops' in c['perms'], 'attendance': 'platform.att' in c['perms'], 'schedule': 'platform.sched' in c['perms']}
                for m, w in want.items():
                    check((m in ids) == w and nav(m) == (1 if w else 0), '① %s：%s 卡片與選單＝%s（卡片 %s）' % (c['name'], m, w, ids))
                if not want['storeops']:
                    pg.goto(base + '/index.html#/storeops/main')
                    pg.wait_for_timeout(800)
                    check(pg.locator('iframe[data-role="store-frame"]').count() == 0, '① %s：沒權限直打 #/storeops 不會嵌 iframe' % c['name'])
                pg.context.close()

            # ② 有門市營運的人：握手、隨機選單 → 頁頂分頁＝oracle、每顆都點、go id 對、重新整理停在原分頁
            who = rnd.choice([k for k, c in cast.items() if 'platform.storeops' in c['perms']] or ['admin'])
            pg = new_page()
            do_login(pg, who)
            pg.click('[data-role="nav-desktop"] [data-nav="storeops"]')
            pg.wait_for_selector('iframe[data-role="store-frame"]')
            fr = wait_frame(pg)
            check(fr is not None and fr.url == STORE + '/dzy-store/?embed=dzy', '② %s：iframe 載入 ?embed=dzy（%s）' % (who, fr.url if fr else None))
            got = fr.evaluate('() => window.__got')
            check(len(got) == 1 and got[0]['data'] == {'type': 'dzy-store-sso', 'v': 1, 'ticket': TICKET}, '② 收到 dzy-store-sso 帶假券：%s' % got)
            check(mock.sso_calls and mock.sso_calls[-1] == {'aud': 'store'}, '② 換券 payload 只有 aud=store')
            n0 = len(mock.sso_calls)
            pg.evaluate("() => window.postMessage({ type: 'dzy-store-ready', v: 1 }, '*')")
            pg.wait_for_timeout(500)
            check(len(mock.sso_calls) == n0, '② 偽造 ready（來源不是 iframe）不換券')
            tabs_txt = lambda: [x.replace('\n', '') for x in pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            NAV = "(d) => parent.postMessage({ type: 'dzy-store-nav', v: 1, cur: d.cur, items: d.items }, '*')"
            rounds = rnd.randint(3, 6)
            for r in range(rounds):
                items, cur = random_nav()
                want = sanitize_tabs(items)
                before = tabs_txt()
                gos_before = len([m for m in fr.evaluate('() => window.__got.map(m => m.data)') if m.get('type') == 'dzy-store-go'])
                fr.evaluate(NAV, {'items': items, 'cur': cur})
                pg.wait_for_timeout(400)
                if want is None:
                    check(tabs_txt() == before, '② 第 %d 輪：%d 項（>20）整份丟掉、頁頂不變' % (r + 1, len(items)))
                    continue
                check(tabs_txt() == [tab_text(t) for t in want], '② 第 %d 輪：頁頂分頁＝oracle（送 %d 項→留 %d：%s；oracle %s）' % (r + 1, len(items), len(want), tabs_txt(), [tab_text(t) for t in want]))
                errs = pg.eval_on_selector_all('[data-role="view-nav"] .nav-item .badge.err', 'e=>e.length')
                check(errs == len([t for t in want if t['err'] and t['badge']]), '② 第 %d 輪：err 旗標只認 true（%d 顆紅色徽章）' % (r + 1, errs))
                got_all = fr.evaluate('() => window.__got.map(m => m.data)')
                check({'type': 'dzy-store-tabs', 'v': 1} in got_all, '② 第 %d 輪：回 dzy-store-tabs' % (r + 1))
                ids = [t['id'] for t in want]
                if cur in ids:
                    pg.wait_for_function("(c) => location.hash === '#/storeops/' + c", arg=cur, timeout=5000)
                    check(pg.locator('[data-role="view-nav"] .nav-item.is-active').count() == 1 and pg.locator('[data-role="view-nav"] .nav-item.is-active').inner_text().replace('\n', '') == tab_text(want[ids.index(cur)]), '② 第 %d 輪：cur=%s 亮起、網址 %s' % (r + 1, cur, pg.evaluate('location.hash')))
                else:
                    check(len([m for m in fr.evaluate('() => window.__got.map(m => m.data)') if m.get('type') == 'dzy-store-go']) in (gos_before, gos_before + 1), '② 第 %d 輪：cur=%r 不合格 → 不改網址、不打轉' % (r + 1, cur))
                # 每顆分頁都點：送 go id、網址跟著
                for i, t in enumerate(want):
                    n_go = len([m for m in fr.evaluate('() => window.__got.map(m => m.data)') if m.get('type') == 'dzy-store-go'])
                    pg.locator('[data-role="view-nav"] .nav-item').nth(i).click()
                    pg.wait_for_timeout(150)
                    gos = [m for m in fr.evaluate('() => window.__got.map(m => m.data)') if m.get('type') == 'dzy-store-go']
                    cur_hash = pg.evaluate('location.hash')
                    same = cur_hash == '#/storeops/' + t['id'] and len(gos) == n_go
                    check(cur_hash == '#/storeops/' + t['id'] and (same or gos[-1] == {'type': 'dzy-store-go', 'v': 1, 'id': t['id']}), '② 第 %d 輪：點「%s」→ go %s、網址 %s' % (r + 1, tab_text(t), t['id'], cur_hash))
                    fr.evaluate(NAV, {'items': items, 'cur': t['id']})   # 營運系統回報已切過去
                    pg.wait_for_timeout(120)
            pg.screenshot(path=os.path.join(SHOT_DIR, 'storeops_1_tabs_%d.png' % SEED))
            # 重新整理：停在最後一顆分頁；營運系統先回報第一顆 → 管理系統叫它切回
            items, _ = random_nav()
            want = sanitize_tabs(items) or []
            if len(want) >= 2:
                fr.evaluate(NAV, {'items': items, 'cur': want[0]['id']})
                pg.wait_for_timeout(300)
                last = want[-1]
                pg.locator('[data-role="view-nav"] .nav-item').nth(len(want) - 1).click()
                pg.wait_for_function("(c) => location.hash === '#/storeops/' + c", arg=last['id'])
                pg.reload()
                pg.wait_for_selector('iframe[data-role="store-frame"]')
                fr = wait_frame(pg)
                fr.evaluate(NAV, {'items': items, 'cur': want[0]['id']})
                pg.wait_for_timeout(500)
                gos = [m for m in fr.evaluate('() => window.__got.map(m => m.data)') if m.get('type') == 'dzy-store-go']
                check(gos == [{'type': 'dzy-store-go', 'v': 1, 'id': last['id']}] and pg.evaluate('location.hash') == '#/storeops/' + last['id'], '② 重新整理停在「%s」：營運系統回報第一顆時被叫回去（%s）' % (tab_text(last), gos))
            # 手機寬：分頁不橫向捲動
            pg.set_viewport_size({'width': 390, 'height': 844})
            pg.wait_for_timeout(300)
            check(pg.evaluate('() => document.documentElement.scrollWidth <= innerWidth + 1'), '② 390 寬沒有橫向捲動')
            pg.screenshot(path=os.path.join(SHOT_DIR, 'storeops_2_tabs_390_%d.png' % SEED))
            pg.set_viewport_size({'width': 1280, 'height': 800})
            # 切走保留、登出卸載
            pg.click('[data-role="nav-desktop"] [data-nav="__home__"]')
            pg.wait_for_selector('[data-role="module-card"]')
            check(pg.locator('[data-keep="storeops"] iframe[data-role="store-frame"]').count() == 1 and not pg.locator('[data-keep="storeops"]').is_visible(), '② 切回首頁：iframe 保留、藏起來')
            pg.wait_for_timeout(600)   # 讓前面的換券都落地，再量
            n_sso = len(mock.sso_calls)
            pg.click('[data-role="nav-desktop"] [data-nav="storeops"]')
            pg.wait_for_selector('[data-keep="storeops"]:not([hidden])')
            pg.wait_for_timeout(300)
            check(len(mock.sso_calls) == n_sso, '② 點回來不重新換券')
            fr2 = store_frame(pg)
            fr2.evaluate("() => { window.__logout = 0; window.addEventListener('message', e => { if (e.data && e.data.type === 'dzy-store-logout') window.__logout++; }); }")
            pg.click('[data-nav="__logout__"]')
            pg.wait_for_selector('#login-username', timeout=15000)
            check(True, '② 登出回到登入頁')
            pg.context.close()

            # ③ 試跑模式：iframe 上方有警語
            pg = new_page()
            pg.goto(base + '/index.html?dryrun=1')
            pg.fill('#login-username', who); pg.fill('#login-password', USERS[who]['password']); pg.click('[data-role="submit"]')
            pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)
            pg.goto(base + '/index.html?dryrun=1#/storeops/main')
            pg.wait_for_selector('iframe[data-role="store-frame"]', timeout=10000)
            check(pg.locator('[data-role="dryrun-embed-warn"]').count() == 1 and '請勿送出' in pg.locator('[data-role="dryrun-embed-warn"]').inner_text(), '③ 試跑模式：嵌入子系統上方有「會真的寫入」警語')
            check(pg.locator('a.btn[target=_blank]', has_text='在新分頁開啟').get_attribute('href') == STORE + '/dzy-store/', '③ 「在新分頁開啟」連到營運系統（不帶 embed）')
            pg.context.close()

            # ④ return 導回：隨機合格／不合格網址
            urls = random_returns(base)
            for raw in urls:
                want = safe_return(raw)
                pg = new_page()
                do_login(pg, who)
                n = len(mock.sso_calls)
                pg.goto(base + '/index.html#/storeops?return=' + urllib.parse.quote(raw, safe=''))
                if want:
                    try:
                        pg.wait_for_url(want + '#sso=' + TICKET, timeout=10000)
                        check(pg.url == want + '#sso=' + TICKET, '④ 合格 return 導回並帶 #sso=：%s' % raw)
                    except Exception:
                        check(False, '④ 合格 return 沒導回：%s → %s' % (raw, pg.url))
                else:
                    pg.wait_for_selector('iframe[data-role="store-frame"]', timeout=8000)
                    pg.wait_for_timeout(300)
                    check(pg.url.startswith(base + '/index.html#/storeops') and pg.locator('iframe[data-role="store-frame"]').count() == 1, '④ 不合格 return 不導走、顯示正常模組：%r → %s' % (raw, pg.url))
                    check(len(mock.sso_calls) - n <= 1, '④ 不合格 return 不走導回換券：%r' % raw)
                pg.context.close()
            check(not any('evil' in h for h in store_hits), '④ 沒有請求送到 evil 主機')

            # ⑤ 未登入帶 return：先登入再導回
            good = STORE + '/dzy-store/?s=%s' % rnd.choice(['gf', 'mc', 'nc'])
            pg = new_page()
            pg.goto(base + '/index.html#/storeops?return=' + urllib.parse.quote(good, safe=''))
            pg.wait_for_selector('#login-username')
            check(store_frame(pg) is None, '⑤ 未登入只看到登入頁')
            pg.fill('#login-username', who); pg.fill('#login-password', USERS[who]['password']); pg.click('[data-role="submit"]')
            pg.wait_for_url(good + '#sso=' + TICKET, timeout=10000)
            check(True, '⑤ 登入後導回營運系統並帶 #sso=')
            pg.context.close()
            browser.close()
    finally:
        httpd.shutdown()
    check(mock.leaked == [] and leaks == [], '真實網路零流出：%s %s' % (mock.leaked[:3], leaks[:3]))
    print('E2E_SEED=%d' % SEED)
    finish()


if __name__ == '__main__':
    main()
