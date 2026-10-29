#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""資料帶入測試（財務部門）：收支管理 modules/cashbook（docs/cashbook-fin/spec.md §7、§9、§10）。

與 e2e_t14_cashbook.py 的差別：資料**每次全部隨機重抽**（門市數、月份、筆數、科目、金額、發票、作廢、鎖定狀態、
假時鐘日期），預期值由本檔照規格自己算（不 import 系統的 matrix.js／util.js；Python 捨入用 int(x+0.5)），
匯出的 Excel 逐格整組比對，每顆按鈕／連結用 clickmap 稽核。失敗時印出種子，E2E_SEED=<種子> 可重現。

全程 mock（本檔自己的有狀態假現金帳＋假代轉，照 spec §4／§10 的形狀），零真實資料；
任何打到 127.0.0.1 以外的請求都必須被 route 攔下（守門 regex），前端 body 不得帶 operator／金鑰／通行碼。

用法：python3 test/e2e/dd_fin_cashbook.py        （埠 9181；E2E_SEED=123 重現）
"""
import datetime
import json
import os
import random
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import USERS, MockBackend, check, finish, start_server, failures  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

PORT = 9181
KEEP = '[data-keep="cashbook"]'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ART = os.path.join(ROOT, 'test', 'dd', 'artifacts', 'fin')
EXTERNAL = re.compile(r'^https?://(?!127\.0\.0\.1)')
PNG = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082')
SEED = int(os.environ.get('E2E_SEED') or random.randrange(1, 10 ** 9))
R = random.Random(SEED)
print('E2E_SEED=%d' % SEED)

READ = ['adminStores', 'adminList', 'adminLocks', 'adminGet']
WRITE = ['adminSave', 'adminVoid', 'adminLock', 'adminUnlock']
FORBIDDEN_FIELDS = ('operator', 'adminKey', 'admin_key', 'newStorePass', 'newAdminPass', 'code', 'pass', 'pin', 'pin_master', 'password', 'token')

STORE_POOL = [('gf', '新竹光復'), ('mc', '台中美村'), ('nc', '員林南昌'), ('ck', '中央廚房'), ('js', '新竹金山'), ('lz', '六張犁')]
EXP_POOL = ['食材', '雜支', '人事', '水電', '瓦斯', '清潔用品', '維修', '運費', '包材', '文具', '交通', '租金']
INC_POOL = ['其他收入', '廠商退款', '外送回款', '押金退回', '利息']
NAME_POOL = ['青菜', '豆干', '垃圾袋', '手套', '辣椒粉', '鴨血', '瓦斯一桶', '水費', '電費', '計程車', '洗碗精', '紙巾', '退款', '門把維修', '冰塊', '便當']
AUTHOR_POOL = ['店長', '副店', '阿明', '小芬', '阿德']


# ------------------------------------------------------------
# 獨立算式（照規格，不碰系統模組）
# ------------------------------------------------------------

def rnd(x):
    """四捨五入（.5 進位），對應 JS Math.round；Python round() 是銀行家捨入不能用"""
    return int(x + 0.5)


def split_tax(amount, has_inv):
    if not has_inv:
        return amount, 0
    net = rnd(amount / 1.05)
    return net, amount - net


def money(n):
    neg = n < 0
    s = '{:,}'.format(abs(int(n)))
    return ('-' + s) if neg else s


def ym(y, m):
    return '%04d-%02d' % (y, m)


def shift_month(y, m, k):
    m += k
    while m < 1:
        y, m = y - 1, m + 12
    while m > 12:
        y, m = y + 1, m - 12
    return y, m


def summarize(rows):
    live = [r for r in rows if r['status'] != '作廢']
    exp = sum(r['amount'] for r in live if r['kind'] == '支出')
    inc = sum(r['amount'] for r in live if r['kind'] == '收入')
    return {'expense': exp, 'income': inc, 'net': inc - exp, 'count': len(live)}


def expected_matrix(rows):
    """匯出格子：表頭、依(日期, 支出先, 收據編號)排序的未作廢列、空列、三列合計（spec §7、現金帳 export.js）"""
    live = sorted([r for r in rows if r['status'] != '作廢'], key=lambda r: (r['date'], 0 if r['kind'] == '支出' else 1, r['seq']))
    hdr = ['店別', '日期', '收支別', '科目', '項目名稱', '未稅價', '稅額', '金額', '發票', '收據編號', '收據照片', '填表人', '登記時間']
    data = [[r['store'], r['date'], r['kind'], r['subject'], r['name'], r['net'], r['tax'], r['amount'],
             '有' if r['hasInvoice'] else '無', r['seq'], r['photo'], r['author'], r['createdAt']] for r in live]
    s = summarize(rows)
    return [hdr] + data + [[], ['支出合計', '', '', '', '', '', '', s['expense']], ['收入合計', '', '', '', '', '', '', s['income']], ['淨額', '', '', '', '', '', '', s['net']]]


# ------------------------------------------------------------
# 隨機資料集（分層抽樣）
# ------------------------------------------------------------

def make_dataset():
    # 假時鐘：隨機年月；日子分兩段（1–10 走「上個月」預設與首頁提醒；11–28 走當月、無提醒）
    y = R.randint(2025, 2027)
    m = R.randint(1, 12)
    day_a = R.randint(1, 10)
    day_b = R.randint(11, 28)
    cur = ym(y, m)
    last = ym(*shift_month(y, m, -1))
    months = [ym(*shift_month(y, m, -k)) for k in range(0, 4)]   # 當月往前四個月
    stores = R.sample(STORE_POOL, R.randint(2, 4))
    exp_subjects = R.sample(EXP_POOL, R.randint(3, 7))
    inc_subjects = R.sample(INC_POOL, R.randint(1, 3))
    rows = {}
    locks = {}
    # 讓「上個月只有作廢帳」「上個月完全沒帳」「上個月有帳未會計鎖」「上個月會計鎖」四種店況都抽得到
    profiles = ['live-unlocked', 'acct-locked', 'void-only', 'empty', 'store-locked']
    R.shuffle(profiles)
    for i, (code, name) in enumerate(stores):
        prof = profiles[i % len(profiles)]
        lst = []
        locks[code] = {}
        rid = 0
        for mo in months:
            if mo == last and prof == 'empty':
                n = 0
            elif mo == last and prof == 'void-only':
                n = R.randint(1, 3)
            else:
                n = R.randint(0, 12) if mo != cur else R.randint(2, 12)
            seqs = {'支出': 0, '收入': 0}
            for j in range(n):
                rid += 1
                kind = '收入' if R.random() < 0.3 else '支出'
                seqs[kind] += 1
                tier = R.choice(['s', 'm', 'l'])
                base = {'s': R.randint(10, 500), 'm': R.randint(500, 5000), 'l': R.randint(5000, 60000)}[tier]
                if R.random() < 0.25:   # 靠近 ÷1.05 的捨入邊界：21 的倍數附近
                    base = 21 * R.randint(1, 2000) + R.choice([-1, 0, 1])
                has_inv = R.random() < 0.5
                net, tax = split_tax(base, has_inv)
                void = (mo == last and prof == 'void-only') or R.random() < 0.2
                day = R.randint(1, 28)
                r = {'id': 'R%s%04d' % (code, rid), 'store': name, 'date': '%s-%02d' % (mo, day), 'kind': kind,
                     'subject': R.choice(inc_subjects if kind == '收入' else exp_subjects), 'name': R.choice(NAME_POOL) + str(R.randint(1, 99)),
                     'amount': base, 'hasInvoice': has_inv, 'net': net, 'tax': tax, 'seq': seqs[kind],
                     'photo': ('https://example.test/p/%s.jpg' % rid) if R.random() < 0.6 else '',
                     'author': R.choice(AUTHOR_POOL), 'createdAt': '%s-%02d %02d:%02d:00' % (mo, day, R.randint(8, 22), R.randint(0, 59)),
                     'status': '作廢' if void else '正常', 'voidedAt': '', 'voidReason': '', 'voidedBy': ''}
                if void:
                    r.update({'voidedAt': '%s-%02d 18:00:00' % (mo, day), 'voidReason': R.choice(['重複登記', '登記錯店', '金額打錯']), 'voidedBy': R.choice(['店長', '會計乙（ACC）（管理系統）'])})
                lst.append(r)
            # 鎖定狀態：上個月依店況；其他月隨機（當月不鎖，測試要在當月作廢）
            if mo == last:
                via = {'acct-locked': 'acct', 'store-locked': 'store'}.get(prof)
            elif mo == cur:
                via = None
            else:
                via = R.choice([None, None, 'acct', 'store', 'old'])
            if via:
                locks[code][mo] = {'month': mo, 'status': '鎖定', 'lockedAt': mo + '-28 22:00:00',
                                   'lockedBy': {'acct': '會計乙（ACC）（管理系統）', 'store': '店長', 'old': ''}[via],
                                   'lockedVia': {'acct': 'acct', 'store': 'store', 'old': ''}[via]}
        R.shuffle(lst)   # 伺服器回傳順序隨機；匯出排序由前端負責
        rows[code] = lst
    return {'y': y, 'm': m, 'day_a': day_a, 'day_b': day_b, 'cur': cur, 'last': last, 'months': months,
            'stores': [{'code': c, 'name': n} for c, n in stores], 'rows': rows, 'locks': locks,
            'subjects': {'expenseSubjects': exp_subjects, 'incomeSubjects': inc_subjects}, 'profiles': dict(zip([c for c, _ in stores], profiles))}


# ------------------------------------------------------------
# 假代轉＋假現金帳（spec §4、§10；adminLock 把店長鎖改成會計鎖）
# ------------------------------------------------------------

class MockFin(MockBackend):
    def __init__(self, base, ds):
        super().__init__(base)
        self.ds = ds
        self.cb_calls = []     # (action, payload, who)
        self.cb_leaked = []

    def _locked(self, store, month):
        rec = self.ds['locks'][store].get(month)
        return bool(rec and rec['status'] == '鎖定')

    def proxy(self, body):
        if body.get('ns') != 'cashbook':
            return super().proxy(body)
        action = body.get('action', '')
        self.proxy_calls = getattr(self, 'proxy_calls', []) + [('cashbook', action)]
        payload = body.get('payload') or {}
        token = body.get('token') or ''
        if not token:
            return 401, {'ok': False, 'error': 'NO_TOKEN', 'code': 'NO_TOKEN'}
        who = token.replace('e2e-token-', '')
        u = USERS.get(who)
        if not u:
            return 401, {'ok': False, 'error': '登入已失效', 'code': 'BAD_TOKEN'}
        if action not in READ and action not in WRITE:
            return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
        if not ('*' in u['perms'] or 'cashbook.write' in u['perms']):
            return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
        for k in FORBIDDEN_FIELDS:
            if isinstance(payload, dict) and k in payload:
                self.cb_leaked.append('FIELD %s in %s' % (k, action))
        self.cb_calls.append((action, dict(payload), who))
        operator = '%s（%s）（管理系統）' % (u['user']['name'], who)
        ds = self.ds
        store = payload.get('store')
        if action == 'adminStores':
            return 200, {'ok': True, 'stores': ds['stores']}
        if action == 'adminGet':
            return 200, dict(ds['subjects'], ok=True)
        if action == 'adminSave':
            if 'newStorePass' in payload or 'newAdminPass' in payload:
                return 200, {'ok': False, 'error': 'BAD_INPUT'}
            for k in ('expenseSubjects', 'incomeSubjects'):
                if k in payload:
                    ds['subjects'][k] = list(payload[k])
            return 200, dict(ds['subjects'], ok=True)
        if store not in ds['rows']:
            return 200, {'ok': False, 'error': 'BAD_INPUT'}
        name = next(s['name'] for s in ds['stores'] if s['code'] == store)
        if action == 'adminList':
            month = payload.get('month') or ''
            rows = [r for r in ds['rows'][store] if r['date'].startswith(month)]
            rec = ds['locks'][store].get(month)
            return 200, {'ok': True, 'store': store, 'name': name, 'month': month, 'rows': rows, 'locked': self._locked(store, month),
                         'lockedBy': rec['lockedBy'] if rec else '', 'lockedVia': rec['lockedVia'] if rec else ''}
        if action == 'adminLocks':
            return 200, {'ok': True, 'store': store, 'locks': sorted(ds['locks'][store].values(), key=lambda x: x['month'])}
        if action == 'adminVoid':
            r = next((x for x in ds['rows'][store] if x['id'] == payload.get('id')), None)
            reason = payload.get('reason')
            if r is None or not isinstance(reason, str) or not (1 <= len(reason.strip()) <= 200) or r['status'] == '作廢':
                return 200, {'ok': False, 'error': 'BAD_INPUT'}
            if self._locked(store, r['date'][:7]):
                return 200, {'ok': False, 'error': 'LOCKED'}
            r.update({'status': '作廢', 'voidReason': reason.strip(), 'voidedBy': operator, 'voidedAt': ds['cur'] + '-28 12:00:00'})
            return 200, {'ok': True}
        if action == 'adminLock':
            month = payload.get('month') or ''
            ds['locks'][store][month] = {'month': month, 'status': '鎖定', 'lockedAt': ds['cur'] + '-28 12:00:00', 'lockedBy': operator, 'lockedVia': 'acct'}
            return 200, {'ok': True}
        if action == 'adminUnlock':
            ds['locks'][store].pop(payload.get('month') or '', None)
            return 200, {'ok': True}
        return 200, {'ok': False, 'error': 'BAD_INPUT'}


# ------------------------------------------------------------
# clickmap（抄 績效評核 e2e/clickmap.py 的規則：key 由元素本身算出）
# ------------------------------------------------------------

_KEY = """
  const id = e.id ? '#' + e.id : '';
  if (id) return id;
  const dn = e.getAttribute && (e.getAttribute('data-nav') || e.getAttribute('data-view') || e.getAttribute('data-act') || e.getAttribute('data-role'));
  const cls = (typeof e.className === 'string' && e.className.trim()) ? '.' + e.className.trim().split(/\\s+/)[0] : '';
  if (e.tagName === 'SELECT' || e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') return e.tagName.toLowerCase() + (dn ? '[' + dn + ']' : cls);
  if (dn) return e.tagName.toLowerCase() + '[' + dn + ']';
  const txt = (e.textContent || e.value || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
  return e.tagName.toLowerCase() + '「' + txt + '」';
"""
SCAN_JS = """
(root) => {
  const keyOf = (e) => {%s};
  const r = root ? document.querySelector(root) : document;
  if (!r) return [];
  return [...r.querySelectorAll('button, a[href], select, textarea, [data-role=cb-row], [data-role=alert-row], [data-role=module-card]')]
    .filter(e => e.offsetParent !== null).map(keyOf);
}
""" % _KEY
KEY_JS = "(el) => { const keyOf = (e) => {%s}; return keyOf(el); }" % _KEY
SKIP = {'button[__logout__]': '登出另驗', 'button[__password__]': '改密碼不屬財務模組'}


class ClickMap:
    def __init__(self):
        self.seen = {}
        self.clicked = {}

    def scan(self, page, screen, root=None):
        for k in page.evaluate(SCAN_JS, root):
            if k:
                self.seen.setdefault(k, screen)

    def click(self, page, locator, verified):
        el = locator.first
        key = el.evaluate(KEY_JS)
        el.click()
        self.clicked[key] = verified
        return key

    def mark(self, page, locator, verified):
        self.clicked[locator.first.evaluate(KEY_JS)] = verified

    def report(self):
        missed = {k: v for k, v in self.seen.items() if k not in self.clicked and k not in SKIP}
        return {'total': len(self.seen), 'clicked': len(self.clicked), 'missed': missed}


# ------------------------------------------------------------
# xlsx 讀格（zip＋xml，不用任何試算表函式庫）
# ------------------------------------------------------------

def read_xlsx_cells(path):
    z = zipfile.ZipFile(path)
    names = z.namelist()
    shared = z.read('xl/sharedStrings.xml').decode('utf-8') if 'xl/sharedStrings.xml' in names else ''
    strs = [''.join(re.findall(r'<t[^>]*>(.*?)</t>', s, re.S)) for s in re.findall(r'<si>(.*?)</si>', shared, re.S)]
    sheet = z.read('xl/worksheets/sheet1.xml').decode('utf-8')
    cells = {}
    for mt in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', sheet, re.S):
        col, row, attrs, inner = mt.group(1), int(mt.group(2)), mt.group(3), mt.group(4) or ''
        vm = re.search(r'<v>(.*?)</v>', inner, re.S)
        im = re.search(r'<is>.*?<t[^>]*>(.*?)</t>', inner, re.S)
        if 't="s"' in attrs and vm:
            v = strs[int(vm.group(1))]
        elif im:
            v = im.group(1)
        elif vm:
            v = vm.group(1)
        else:
            v = ''
        cells[(row, col)] = v
    wb = z.read('xl/workbook.xml').decode('utf-8')
    return cells, wb


def unesc(s):
    return s.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&apos;', "'")


def grid_from_cells(cells):
    if not cells:
        return []
    maxr = max(r for r, _ in cells)
    cols = 'ABCDEFGHIJKLM'
    grid = []
    for r in range(1, maxr + 1):
        row = [unesc(cells.get((r, c), '')) for c in cols]
        while row and row[-1] == '':
            row.pop()
        grid.append(row)
    return grid


def norm_expected(mx):
    out = []
    for row in mx:
        out.append([(str(v) if not isinstance(v, bool) else v) for v in row])
    return out


def norm_actual(grid):
    out = []
    for row in grid:
        nr = []
        for v in row:
            if re.fullmatch(r'-?\d+(\.0+)?', v):
                v = str(int(float(v)))
            nr.append(v)
        out.append(nr)
    return out


# ------------------------------------------------------------
# 主流程
# ------------------------------------------------------------

def fake_date_script(y, m, d):
    iso = '%04d-%02d-%02dT12:00:00+08:00' % (y, m, d)
    return """(() => { const R = Date; const fixed = new R('%s').getTime();
      class D extends R { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }
      window.Date = D; })();""" % iso


def main():
    os.makedirs(ART, exist_ok=True)
    ds = make_dataset()
    print('資料集：%d 家店 %s；當月 %s；假日期 A=%02d B=%02d；店況 %s' % (len(ds['stores']), [s['code'] for s in ds['stores']], ds['cur'], ds['day_a'], ds['day_b'], ds['profiles']))
    httpd, base = start_server(PORT)
    mock = MockFin(base, ds)
    mk = lambda name, perms: {'password': 'dd-pw', 'perms': perms, 'user': {'id': 'u-' + name, 'name': name, 'role': 'staff', 'node': ''}}
    USERS['fin1'] = mk('會計甲', ['platform.self', 'cashbook.write'])
    USERS['nofin'] = mk('同仁乙', ['platform.self', 'audit.read.own'])
    cm = ClickMap()
    external = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def new_page(day, query=''):
                ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True)
                pg = ctx.new_page()
                mock.install(pg)
                pg.route('https://example.test/**', lambda r: r.fulfill(status=200, content_type='image/png', body=PNG))
                pg.on('request', lambda req: external.append(req.url) if EXTERNAL.match(req.url) else None)
                pg.add_init_script(fake_date_script(ds['y'], ds['m'], day))
                pg.goto(base + '/index.html' + query)
                return pg

            def do_login(pg, user):
                pg.fill('#login-username', user)
                pg.fill('#login-password', USERS[user]['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"], ' + KEEP, state='attached', timeout=10000)

            def calls(action):
                return [c for c in mock.cb_calls if c[0] == action]

            def tab(pg, name):
                cm.scan(pg, 'tabs', '[data-role="view-nav"]')
                cm.click(pg, pg.locator('[data-role="view-nav"] .nav-item', has_text=name), '切到 ' + name)

            def wait_rows(pg, month, n):
                pg.wait_for_function("([m, n]) => { const t = document.querySelector('[data-keep=cashbook] [data-role=cb-table]'); const ttl = document.querySelector('[data-keep=cashbook] .card-title');"
                                     " return t && ttl && ttl.textContent.includes(m) && (t.querySelectorAll('[data-role=cb-row]').length === n || (n === 0 && t.querySelector('[data-role=cb-empty]'))); }", arg=[month, n], timeout=10000)

            # ====== ① 非財務同仁：看不到、沒打代轉 ======
            nf = new_page(ds['day_b'])
            do_login(nf, 'nofin')
            ids = [c.get_attribute('data-module') for c in nf.locator('[data-role="module-card"]').all()]
            check(not ({'cashbook', 'purchase', 'transfer-fin', 'pnl'} & set(ids)), '非財務同仁：首頁沒有任何財務部門卡片：%s' % ids)
            check(nf.locator('[data-nav="cashbook"]').count() == 0 and nf.locator('[data-nav-dept="fin"]').count() == 0, '非財務同仁：左側沒有財務部門群組')
            nf.goto(base + '/index.html#/cashbook/rows')
            nf.wait_for_timeout(800)
            check(nf.locator(KEEP).count() == 0, '非財務同仁硬輸入 #/cashbook/rows：模組不載入')
            check(not [c for c in getattr(mock, 'proxy_calls', []) if c[0] == 'cashbook'], '非財務同仁沒有打任何 cashbook 代轉')
            nf.context.close()

            # ====== ② admin：財務部門四模組順序 ======
            ad = new_page(ds['day_b'])
            do_login(ad, 'admin')
            navs = ad.locator('[data-role="nav-desktop"] .nav-dept[data-dept="fin"] [data-nav]').evaluate_all('els => els.map(e => e.getAttribute("data-nav"))')
            check(navs == ['purchase', 'cashbook', 'transfer-fin', 'pnl'], 'admin 財務部門選單順序＝貨單核對→收支管理→調撥管理→損益系統：%s' % navs)
            ad.click('[data-role="nav-desktop"] [data-nav="cashbook"]')
            ad.wait_for_selector(KEEP + ' [data-role="cb-table"], ' + KEEP + ' [data-role="cb-notice"]', timeout=10000)
            check(ad.locator(KEEP + ' [data-role="cb-store"] option').count() == len(ds['stores']), 'admin（*）也能進收支管理並看到 %d 家店' % len(ds['stores']))
            ad.context.close()

            # ====== ③ 財務同仁，假日期 B（11–28）：預設當月 ======
            pg = new_page(ds['day_b'])
            do_login(pg, 'fin1')
            cm.scan(pg, 'home', '[data-role="module-card"][data-module="cashbook"]')
            cm.scan(pg, 'sidebar', '[data-role="nav-desktop"] .nav-dept[data-dept="fin"]')
            grp = pg.evaluate("() => { const b = document.querySelector('[data-role=\"nav-desktop\"] [data-nav=cashbook]'); const g = b && b.closest('.nav-dept'); return g ? g.textContent : ''; }")
            check('財務部門' in grp, '選單掛在財務部門')
            # 財務部門群組頭：收合再展開
            head = pg.locator('[data-role="nav-desktop"] [data-nav-dept="fin"]')
            cm.click(pg, head, '收合財務部門')
            pg.wait_for_function("() => document.querySelector('[data-role=nav-desktop] [data-nav-dept=fin]').getAttribute('aria-expanded') === 'false'")
            check(not pg.locator('[data-role="nav-desktop"] [data-nav="cashbook"]').is_visible(), '收合財務部門後，收支管理選單藏起來')
            head.click()
            pg.wait_for_selector('[data-role="nav-desktop"] [data-nav="cashbook"]', state='visible')
            cm.click(pg, pg.locator('[data-role="nav-desktop"] [data-nav="cashbook"]'), '進收支管理')
            pg.wait_for_selector(KEEP + ' [data-role="cb-table"]', timeout=10000)
            check(pg.evaluate('location.hash') == '#/cashbook/rows', '進模組網址 #/cashbook/rows')
            names = [x.replace('\n', '') for x in pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(names == ['收支明細', '月結鎖定', '匯出 Excel', '會計科目'], '四個分頁：%s' % names)
            opts = pg.locator(KEEP + ' [data-role="cb-store"] option').all_inner_texts()
            check(opts == [s['name'] for s in ds['stores']], '店別選單＝現金帳回的店（%s）' % opts)
            check(pg.locator(KEEP + ' [data-role="cb-month"]').input_value() == ds['cur'], '假日期 %d 號（>10）：預設月份＝當月 %s' % (ds['day_b'], ds['cur']))
            mopts = pg.locator(KEEP + ' [data-role="cb-month"] option').all_inner_texts()
            exp_m = [ym(*shift_month(ds['y'], ds['m'], -k)) for k in range(24)]
            check(mopts == exp_m, '月份選單＝當月往前 24 個月')

            # 每家店 × 四個月：清單、合計、鎖定標籤逐一驗
            store_sel = KEEP + ' [data-role="cb-store"]'
            month_sel = KEEP + ' [data-role="cb-month"]'
            cm.mark(pg, pg.locator(store_sel), '選店')
            cm.mark(pg, pg.locator(month_sel), '選月')
            for s in ds['stores']:
                pg.select_option(store_sel, s['code'])
                for mo in ds['months']:
                    pg.select_option(month_sel, mo)
                    rows = [r for r in ds['rows'][s['code']] if r['date'].startswith(mo)]
                    wait_rows(pg, mo, len(rows))
                    got = pg.locator(KEEP + ' [data-role="cb-row"]').evaluate_all(
                        "els => els.map(e => ({id: e.getAttribute('data-id'), tds: [...e.querySelectorAll('td')].map(t => t.textContent.trim())}))")
                    want = [{'id': r['id'], 'tds': [r['date'], '%s・%s・%s' % (r['kind'], r['subject'], r['name']), money(r['amount']), '有' if r['hasInvoice'] else '無', '作廢' if r['status'] == '作廢' else '正常']} for r in rows]
                    check(got == want, '%s %s 清單 %d 筆逐欄一致（順序＝伺服器順序）' % (s['name'], mo, len(rows)))
                    sm = summarize(rows)
                    got_sum = pg.locator(KEEP + ' [data-role="cb-sum"] b').all_inner_texts()
                    check(got_sum == [money(sm['expense']), money(sm['income']), money(sm['net'])] and ('共 %d 筆' % sm['count']) in pg.locator(KEEP + ' [data-role="cb-sum"]').inner_text(),
                          '%s %s 合計 支出 %s／收入 %s／淨額 %s／%d 筆（不含作廢）' % (s['name'], mo, money(sm['expense']), money(sm['income']), money(sm['net']), sm['count']))
                    locked = mo in ds['locks'][s['code']]
                    check(pg.locator(KEEP + ' [data-role="cb-locked"]').inner_text() == ('本月已月結鎖定' if locked else '本月未鎖定'), '%s %s 鎖定標籤＝%s' % (s['name'], mo, '已鎖' if locked else '未鎖'))
            pg.screenshot(path=os.path.join(ART, 'cashbook-rows.png'))

            # 展開一筆：明細（未稅、稅額、照片、作廢資訊）
            target_store = next((s for s in ds['stores'] if any(r['status'] != '作廢' for r in ds['rows'][s['code']] if r['date'].startswith(ds['cur']))), None)
            check(target_store is not None, '資料集裡至少一家店當月有未作廢的帳')
            pg.select_option(store_sel, target_store['code'])
            pg.select_option(month_sel, ds['cur'])
            cur_rows = [r for r in ds['rows'][target_store['code']] if r['date'].startswith(ds['cur'])]
            wait_rows(pg, ds['cur'], len(cur_rows))
            cm.scan(pg, 'rows', KEEP)
            for r in cur_rows:
                row_loc = pg.locator(KEEP + ' [data-role="cb-row"][data-id="%s"]' % r['id'])
                cm.click(pg, row_loc, '展開 ' + r['id'])
                pg.wait_for_selector(KEEP + ' [data-role="cb-detail"][data-id="%s"]' % r['id'])
                det = pg.locator(KEEP + ' [data-role="cb-detail"]').inner_text()
                ok_det = ('收據編號 %d' % r['seq']) in det and ('未稅 %s' % money(r['net'])) in det and ('稅額 %s' % money(r['tax'])) in det and r['author'] in det and r['createdAt'] in det
                if r['status'] == '作廢':
                    ok_det = ok_det and r['voidReason'] in det and r['voidedBy'] in det and pg.locator(KEEP + ' [data-act="void"]').count() == 0
                else:
                    ok_det = ok_det and pg.locator(KEEP + ' [data-act="void"]').count() == 1
                if r['photo']:
                    a_el = pg.locator(KEEP + ' [data-role="cb-detail"] a')
                    ok_det = ok_det and pg.locator(KEEP + ' [data-role="cb-detail"] img').get_attribute('src') == r['photo'] and a_el.get_attribute('href') == r['photo'] and a_el.get_attribute('target') == '_blank' and 'noopener' in (a_el.get_attribute('rel') or '')
                    cm.scan(pg, 'rows-open', KEEP)
                    cm.mark(pg, a_el, '照片連結 href／target／rel 已驗（不真的開新分頁）')
                else:
                    ok_det = ok_det and '沒有收據照片' in det
                check(ok_det, '%s 展開明細：編號／未稅／稅額／填表人／時間／照片／作廢鈕 一致' % r['id'])
                cm.click(pg, row_loc, '收合 ' + r['id'])
                pg.wait_for_selector(KEEP + ' [data-role="cb-detail"]', state='detached')

            # 作廢：先不填原因→擋；再填→送；合計重算；payload 只有 store/id/reason
            victim = R.choice([r for r in cur_rows if r['status'] != '作廢'])
            pg.locator(KEEP + ' [data-role="cb-row"][data-id="%s"]' % victim['id']).click()
            pg.wait_for_selector(KEEP + ' [data-act="void"]')
            cm.scan(pg, 'rows-open', KEEP)
            cm.click(pg, pg.locator(KEEP + ' [data-act="void"]'), '作廢鈕開對話框')
            pg.wait_for_selector('.dialog [data-role="cb-void-reason"]')
            pg.click('.dialog .btn-danger')
            pg.wait_for_selector('.toast:has-text("請填作廢原因")')
            check(len(calls('adminVoid')) == 0, '沒填原因：不送 adminVoid')
            pg.fill('.dialog [data-role="cb-void-reason"]', 'x' * 201)
            check(len(pg.locator('.dialog [data-role="cb-void-reason"]').input_value()) == 200, '原因欄 maxlength 200')
            pg.click('.dialog .btn-secondary')
            pg.wait_for_selector('.dialog', state='detached')
            check(len(calls('adminVoid')) == 0, '取消：不送 adminVoid')
            reason = R.choice(['店長登記錯店', '金額打錯重登', '重複登記'])
            pg.click(KEEP + ' [data-act="void"]')
            pg.wait_for_selector('.dialog [data-role="cb-void-reason"]')
            pg.fill('.dialog [data-role="cb-void-reason"]', reason)
            pg.click('.dialog .btn-danger')
            pg.wait_for_function("(id) => { const r = document.querySelector('[data-keep=cashbook] [data-role=cb-row][data-id=\"' + id + '\"]'); return r && r.textContent.includes('作廢'); }", arg=victim['id'])
            v = calls('adminVoid')
            check(len(v) == 1 and v[0][1] == {'store': target_store['code'], 'id': victim['id'], 'reason': reason}, '送出 adminVoid 只帶 {store,id,reason}：%s' % (v[0][1] if v else None))
            victim_srv = next(r for r in ds['rows'][target_store['code']] if r['id'] == victim['id'])
            check(victim_srv['status'] == '作廢' and victim_srv['voidedBy'] == '會計甲（fin1）（管理系統）', '後端記下作廢人＝平台依登入身分：%s' % victim_srv['voidedBy'])
            sm = summarize(cur_rows)
            got_sum = pg.locator(KEEP + ' [data-role="cb-sum"] b').all_inner_texts()
            check(got_sum == [money(sm['expense']), money(sm['income']), money(sm['net'])], '作廢後合計重算：%s' % got_sum)

            # ====== ④ 月結鎖定 ======
            tab(pg, '月結鎖定')
            pg.wait_for_selector(KEEP + ' [data-role="cb-lock-table"]')
            cm.scan(pg, 'lock', KEEP)
            check(pg.locator(KEEP + ' [data-role="cb-store"]').input_value() == target_store['code'], '換分頁店別沿用（%s）' % target_store['code'])
            months12 = [ym(*shift_month(ds['y'], ds['m'], -k)) for k in range(12)]
            got_m = pg.locator(KEEP + ' [data-role="cb-lock-row"]').evaluate_all("els => els.map(e => e.getAttribute('data-month'))")
            check(got_m == months12, '月結鎖定列最近 12 個月（新到舊）')
            for s in ds['stores']:
                pg.select_option(KEEP + ' [data-role="cb-store"]', s['code'])
                pg.wait_for_function("(c) => document.querySelector('[data-keep=cashbook] [data-role=cb-store]').value === c && document.querySelector('[data-keep=cashbook] [data-role=cb-lock-table]')", arg=s['code'])
                rows_lock = pg.locator(KEEP + ' [data-role="cb-lock-row"]').evaluate_all(
                    "els => els.map(e => ({m: e.getAttribute('data-month'), k: e.getAttribute('data-kind'), t: e.textContent, btns: [...e.querySelectorAll('[data-act]')].map(b => b.getAttribute('data-act') + ':' + b.textContent.trim())}))")
                bad = []
                for rl in rows_lock:
                    rec = ds['locks'][s['code']].get(rl['m'])
                    kind = 'none' if not rec else ({'acct': 'acct', 'store': 'store'}.get(rec['lockedVia'], 'unknown'))
                    label = {'none': '未鎖', 'acct': '會計鎖定', 'store': '店長鎖定', 'unknown': '已鎖定'}[kind]
                    btns = {'none': ['lock:鎖定'], 'acct': ['unlock:解鎖'], 'store': ['lock:改為會計鎖定', 'unlock:解鎖'], 'unknown': ['lock:改為會計鎖定', 'unlock:解鎖']}[kind]
                    who = (rec['lockedBy'] or ('店長' if kind == 'store' else '')) if rec else ''
                    if not (rl['k'] == kind and label in rl['t'] and rl['btns'] == btns and who in rl['t'] and (not rec or rec['lockedAt'] in rl['t'])):
                        bad.append((rl['m'], rl['k'], kind, rl['btns']))
                check(not bad, '%s 十二個月狀態／標籤／誰何時／按鈕 全對' % s['name'] + ('' if not bad else '，錯：%s' % bad))

            # 對每一種狀態各操作一次：none→鎖定；store→改為會計鎖定；acct→解鎖（二次確認，第二次先取消）
            def lock_row(month):
                return KEEP + ' [data-role="cb-lock-row"][data-month="%s"]' % month

            for s in ds['stores']:
                pg.select_option(KEEP + ' [data-role="cb-store"]', s['code'])
                pg.wait_for_function("(c) => document.querySelector('[data-keep=cashbook] [data-role=cb-store]').value === c && document.querySelector('[data-keep=cashbook] [data-role=cb-lock-table]')", arg=s['code'])
                kinds = pg.locator(KEEP + ' [data-role="cb-lock-row"]').evaluate_all("els => els.map(e => [e.getAttribute('data-month'), e.getAttribute('data-kind')])")
                for want_kind in ('none', 'store', 'acct'):
                    cands = [m for m, k in kinds if k == want_kind]
                    if not cands:
                        continue
                    mo = R.choice(cands)
                    n_lock, n_unlock = len(calls('adminLock')), len(calls('adminUnlock'))
                    if want_kind in ('none', 'store'):
                        cm.click(pg, pg.locator(lock_row(mo) + ' [data-act="lock"]'), '鎖定/改為會計鎖定')
                        pg.wait_for_selector('.dialog')
                        pg.click('.dialog .btn-secondary')   # 先取消
                        pg.wait_for_timeout(200)
                        check(len(calls('adminLock')) == n_lock, '%s %s 鎖定取消：不送' % (s['name'], mo))
                        pg.click(lock_row(mo) + ' [data-act="lock"]')
                        pg.wait_for_selector('.dialog')
                        pg.click('.dialog .btn-primary')
                        pg.wait_for_selector(lock_row(mo) + '[data-kind="acct"]')
                        lk = calls('adminLock')
                        check(len(lk) == n_lock + 1 and lk[-1][1] == {'store': s['code'], 'month': mo}, '%s %s（原 %s）→ adminLock{store,month}' % (s['name'], mo, want_kind))
                        check('會計鎖定' in pg.locator(lock_row(mo)).inner_text() and '會計甲' in pg.locator(lock_row(mo)).inner_text(), '%s %s 顯示會計鎖定＋操作人' % (s['name'], mo))
                        kinds = [[m, 'acct' if m == mo else k] for m, k in kinds]
                    else:
                        cm.click(pg, pg.locator(lock_row(mo) + ' [data-act="unlock"]'), '解鎖')
                        pg.wait_for_selector('.dialog'); pg.click('.dialog .btn-primary')
                        pg.wait_for_selector('.dialog:has-text("再確認一次")'); pg.click('.dialog .btn-secondary')
                        pg.wait_for_timeout(200)
                        check(len(calls('adminUnlock')) == n_unlock and pg.locator(lock_row(mo)).get_attribute('data-kind') == 'acct', '%s %s 解鎖第二次取消：不送、仍鎖' % (s['name'], mo))
                        pg.click(lock_row(mo) + ' [data-act="unlock"]')
                        pg.wait_for_selector('.dialog'); pg.click('.dialog .btn-primary')
                        pg.wait_for_selector('.dialog:has-text("再確認一次")'); pg.click('.dialog .btn-primary')
                        pg.wait_for_selector(lock_row(mo) + '[data-kind="none"]')
                        ul = calls('adminUnlock')
                        check(len(ul) == n_unlock + 1 and ul[-1][1] == {'store': s['code'], 'month': mo}, '%s %s 兩次確定 → adminUnlock{store,month}' % (s['name'], mo))
            pg.screenshot(path=os.path.join(ART, 'cashbook-lock.png'))

            # 被會計鎖的月份：明細沒有作廢鈕
            locked_pick = next(((s, mo) for s in ds['stores'] for mo in ds['locks'][s['code']] if mo in ds['months'] and any(r['status'] != '作廢' and r['date'].startswith(mo) for r in ds['rows'][s['code']])), None)
            if locked_pick:
                s, mo = locked_pick
                tab(pg, '收支明細')
                pg.wait_for_selector(KEEP + ' [data-role="cb-table"]')
                pg.select_option(store_sel, s['code'])
                pg.select_option(month_sel, mo)
                rws = [r for r in ds['rows'][s['code']] if r['date'].startswith(mo)]
                wait_rows(pg, mo, len(rws))
                live = next(r for r in rws if r['status'] != '作廢')
                pg.locator(KEEP + ' [data-role="cb-row"][data-id="%s"]' % live['id']).click()
                pg.wait_for_selector(KEEP + ' [data-role="cb-detail"]')
                check(pg.locator(KEEP + ' [data-act="void"]').count() == 0 and pg.locator(KEEP + ' [data-role="cb-locked"]').inner_text() == '本月已月結鎖定', '%s %s 已鎖：正常的一筆也沒有作廢鈕' % (s['name'], mo))

            # ====== ⑤ 匯出 Excel：每家店每個月整組逐格比對 ======
            tab(pg, '匯出 Excel')
            pg.wait_for_selector(KEEP + ' [data-role="cb-export-btn"]')
            cm.scan(pg, 'export', KEEP)
            n_export = 0
            main_pg = pg
            for si, s in enumerate(ds['stores']):
                # Chromium 同一分頁連續下載每第 11 次會被擋（test 自己實測：第 11、22 次沒有 download 事件；與資料無關），
                # 所以每家店換一個分頁匯出，避免把瀏覽器的下載節流誤判成系統問題。
                if si > 0:
                    pg = new_page(ds['day_b'], '#/cashbook/export')
                    do_login(pg, 'fin1')
                    pg.wait_for_selector(KEEP + ' [data-role="cb-export-btn"]', timeout=10000)
                for mo in ds['months']:
                    pg.select_option(KEEP + ' [data-role="cb-store"]', s['code'])
                    pg.select_option(KEEP + ' [data-role="cb-month"]', mo)
                    rows_m = [r for r in ds['rows'][s['code']] if r['date'].startswith(mo)]
                    try:
                        with pg.expect_download(timeout=15000) as dl:
                            cm.click(pg, pg.locator(KEEP + ' [data-role="cb-export-btn"]'), '匯出 Excel')
                        d = dl.value
                    except Exception as e:
                        check(False, '%s %s 匯出沒有產生下載（畫面訊息：%s；%d 筆）' % (s['name'], mo, pg.locator(KEEP + ' [data-role="cb-msg"]').inner_text(), len(rows_m)))
                        continue
                    path = os.path.join(ART, 'export-%s-%s.xlsx' % (s['code'], mo))
                    d.save_as(path)
                    want = norm_expected(expected_matrix(rows_m))
                    try:
                        cells, wb = read_xlsx_cells(path)
                        got = norm_actual(grid_from_cells(cells))
                    except Exception as e:
                        cells, wb, got = {}, '', ['無法解開：%r' % e]
                    # 空列（第 N+2 列）在 xlsx 裡沒有格子；比對時補成空陣列
                    while len(got) < len(want):
                        got.append([])
                    # 預期裡的 '' 尾端去掉（xlsx 不存空字串格）
                    want_t = [[c for c in row] for row in want]
                    for row in want_t:
                        while row and row[-1] == '':
                            row.pop()
                    check(d.suggested_filename == '現金收支_%s_%s.xlsx' % (s['name'], mo), '檔名 現金收支_%s_%s.xlsx：%s' % (s['name'], mo, d.suggested_filename))
                    check('name="明細"' in wb, '%s %s 工作表名「明細」' % (s['name'], mo))
                    diff = [(i + 1, want_t[i], got[i]) for i in range(len(want_t)) if want_t[i] != got[i]]
                    check(len(got) == len(want_t) and not diff, '%s %s 匯出 %d 格逐格一致（%d 筆未作廢＋三列合計）' % (s['name'], mo, sum(len(r) for r in want_t), len(want_t) - 5)
                          + ('' if not diff else '；首個差異列 %s：預期 %s 實際 %s' % diff[0]))
                    sm = summarize(rows_m)
                    msg = pg.locator(KEEP + ' [data-role="cb-msg"]').inner_text()
                    check(('已匯出' in msg) and ('%d 筆' % sm['count']) in msg and money(sm['expense']) in msg and money(sm['net']) in msg, '%s %s 畫面訊息含筆數與合計：%s' % (s['name'], mo, msg))
                    n_export += 1
            pg.screenshot(path=os.path.join(ART, 'cashbook-export.png'))
            if pg is not main_pg:
                pg.context.close()
                pg = main_pg

            # ====== ⑥ 會計科目 ======
            tab(pg, '會計科目')
            pg.wait_for_selector(KEEP + ' [data-role="cb-sub-exp"]')
            cm.scan(pg, 'subjects', KEEP)
            exp0, inc0 = ds['subjects']['expenseSubjects'], ds['subjects']['incomeSubjects']
            check(pg.locator(KEEP + ' [data-role="cb-sub-exp"]').input_value() == '\n'.join(exp0) and pg.locator(KEEP + ' [data-role="cb-sub-inc"]').input_value() == '\n'.join(inc0), '兩個清單載入伺服器科目')
            cm.mark(pg, pg.locator(KEEP + ' [data-role="cb-sub-exp"]'), '編輯支出科目')
            cm.mark(pg, pg.locator(KEEP + ' [data-role="cb-sub-inc"]'), '編輯收入科目')
            # 沒改 → 沒有改動
            cm.click(pg, pg.locator(KEEP + ' [data-role="cb-sub-save"]'), '儲存')
            pg.wait_for_selector('.toast:has-text("沒有改動")')
            check(len(calls('adminSave')) == 0, '沒改動：不送 adminSave')
            # 改：刪一個、加一個、重複與空行要被清掉
            new_item = R.choice([x for x in EXP_POOL if x not in exp0] or ['新科目'])
            dropped = R.choice(exp0)
            new_exp = [x for x in exp0 if x != dropped] + [new_item]
            text = '\n'.join(new_exp) + '\n\n' + new_item + '\n  ' + new_exp[0] + '  \n'
            pg.fill(KEEP + ' [data-role="cb-sub-exp"]', text)
            pg.click(KEEP + ' [data-role="cb-sub-save"]')
            pg.wait_for_selector('.dialog [data-role="cb-sub-diff"]')
            dtxt = pg.locator('.dialog [data-role="cb-sub-diff"]').inner_text()
            check(('支出新增：' + new_item) in dtxt and ('支出刪除：' + dropped) in dtxt and '收入' not in dtxt, '儲存前差異：新增 %s、刪除 %s：%s' % (new_item, dropped, dtxt))
            pg.click('.dialog .btn-secondary')
            pg.wait_for_selector('.dialog', state='detached')
            check(len(calls('adminSave')) == 0, '差異對話框取消：不送')
            pg.click(KEEP + ' [data-role="cb-sub-save"]')
            pg.wait_for_selector('.dialog [data-role="cb-sub-diff"]')
            pg.click('.dialog .btn-primary')
            pg.wait_for_selector('.toast:has-text("已儲存")')
            sv = calls('adminSave')
            check(len(sv) == 1 and sv[0][1] == {'expenseSubjects': new_exp, 'incomeSubjects': inc0}, 'adminSave 只送兩欄、去重去空白後順序保留：%s' % (sv[0][1] if sv else None))
            pg.wait_for_function("(t) => document.querySelector('[data-keep=cashbook] [data-role=cb-sub-exp]').value === t", arg='\n'.join(new_exp))
            # 驗證：空、>100、>30 字
            pg.fill(KEEP + ' [data-role="cb-sub-exp"]', '')
            pg.click(KEEP + ' [data-role="cb-sub-save"]')
            pg.wait_for_selector('.toast:has-text("至少要有 1 個科目")')
            pg.fill(KEEP + ' [data-role="cb-sub-exp"]', '\n'.join('科目%d' % i for i in range(101)))
            pg.click(KEEP + ' [data-role="cb-sub-save"]')
            pg.wait_for_selector('.toast:has-text("最多 100 個科目")')
            pg.fill(KEEP + ' [data-role="cb-sub-inc"]', '甲' * 31)
            pg.fill(KEEP + ' [data-role="cb-sub-exp"]', '食材')
            pg.click(KEEP + ' [data-role="cb-sub-save"]')
            pg.wait_for_selector('.toast:has-text("超過 30 字")')
            check(len(calls('adminSave')) == 1, '空／101 個／31 字 三種都被擋、沒再送')
            cm.click(pg, pg.locator(KEEP + ' [data-act="reset"]'), '還原')
            pg.wait_for_function("(t) => document.querySelector('[data-keep=cashbook] [data-role=cb-sub-exp]').value === t", arg='\n'.join(new_exp))
            check(pg.locator(KEEP + ' [data-role="cb-sub-inc"]').input_value() == '\n'.join(inc0), '還原＝伺服器版本')
            pg.screenshot(path=os.path.join(ART, 'cashbook-subjects.png'))

            # 首頁卡片／分頁按鈕都點一次
            pg.click('[data-role="nav-desktop"] [data-nav="__home__"]') if pg.locator('[data-role="nav-desktop"] [data-nav="__home__"]').count() else pg.goto(base + '/index.html#/home')
            pg.wait_for_selector('[data-role="module-card"][data-module="cashbook"]', timeout=10000)
            cm.click(pg, pg.locator('[data-role="module-card"][data-module="cashbook"]'), '首頁卡片進模組')
            pg.wait_for_selector(KEEP + ':not([hidden]) [data-role="cb-table"], ' + KEEP + ':not([hidden]) [data-role="cb-sub-exp"]', timeout=10000)
            check(pg.evaluate('location.hash').startswith('#/cashbook/'), '首頁卡片 → #/cashbook/…：%s' % pg.evaluate('location.hash'))
            pg.context.close()

            # ====== ⑦ 假日期 A（1–10）：預設上個月、首頁提醒 ======
            al = new_page(ds['day_a'])
            do_login(al, 'fin1')
            al.wait_for_function("() => { const b = document.querySelector('[data-role=alert-list][data-module=cashbook]'); return b && !b.textContent.includes('讀取中'); }", timeout=10000)
            txt = al.locator('[data-role="alert-list"][data-module="cashbook"]').inner_text()
            exp_alert = []
            for s in ds['stores']:
                rec = ds['locks'][s['code']].get(ds['last'])
                acct = bool(rec and rec['lockedVia'] == 'acct')
                live = any(r['status'] != '作廢' for r in ds['rows'][s['code']] if r['date'].startswith(ds['last']))
                if not acct and live:
                    exp_alert.append(s)
            want_lines = ['%s %d 月還沒月結' % (s['name'], int(ds['last'][5:])) for s in exp_alert]
            got_lines = [t.strip().rstrip('›').strip() for t in al.locator('[data-role="alert-list"][data-module="cashbook"] [data-role="alert-row"]').all_inner_texts()]
            if not exp_alert:
                check('沒有待辦' in txt, '首頁提醒：所有店都已會計鎖或沒帳 → 沒有待辦：%s' % txt)
            else:
                check(got_lines == want_lines, '首頁提醒（%d 號）＝上月有帳且未會計鎖的店：預期 %s 實際 %s' % (ds['day_a'], want_lines, got_lines))
            al.screenshot(path=os.path.join(ART, 'cashbook-home-alerts.png'))
            if exp_alert:
                tgt = exp_alert[0]
                cm.scan(al, 'home-alerts', '[data-role="alert-list"][data-module="cashbook"]')
                cm.click(al, al.locator('[data-role="alert-list"][data-module="cashbook"] [data-role="alert-row"]'), '提醒列 → 月結鎖定')
                al.wait_for_selector(KEEP + ' [data-role="cb-lock-table"]')
                check(al.evaluate('location.hash').startswith('#/cashbook/lock') and al.locator(KEEP + ' [data-role="cb-store"]').input_value() == tgt['code'], '點提醒 → 月結鎖定、店別＝%s：%s' % (tgt['code'], al.evaluate('location.hash')))
                al.locator('[data-role="view-nav"] .nav-item', has_text='收支明細').click()
                al.wait_for_selector(KEEP + ' [data-role="cb-table"]')
                check(al.locator(KEEP + ' [data-role="cb-month"]').input_value() == ds['last'], '提醒帶入月份：收支明細月份＝%s' % ds['last'])
            else:
                al.click('[data-role="nav-desktop"] [data-nav="cashbook"]')
                al.wait_for_selector(KEEP + ' [data-role="cb-table"]')
                check(al.locator(KEEP + ' [data-role="cb-month"]').input_value() == ds['last'], '假日期 %d 號（≤10）：預設月份＝上個月 %s' % (ds['day_a'], ds['last']))
            al.context.close()

            # ====== ⑧ 試跑模式：四個寫入全攔、讀取與匯出照常 ======
            dr = new_page(ds['day_b'], '?dryrun=1')
            do_login(dr, 'fin1')
            dr.click('[data-role="nav-desktop"] [data-nav="cashbook"]')
            dr.wait_for_selector(KEEP + ' [data-role="cb-table"]')
            n_w = {a: len(calls(a)) for a in WRITE}
            s_dr = next(s for s in ds['stores'] if any(r['status'] != '作廢' and r['date'].startswith(ds['cur']) for r in ds['rows'][s['code']]))
            dr.select_option(store_sel, s_dr['code'])
            dr.select_option(month_sel, ds['cur'])
            rws = [r for r in ds['rows'][s_dr['code']] if r['date'].startswith(ds['cur'])]
            wait_rows(dr, ds['cur'], len(rws))
            live = next(r for r in rws if r['status'] != '作廢')
            dr.locator(KEEP + ' [data-role="cb-row"][data-id="%s"]' % live['id']).click()
            dr.wait_for_selector(KEEP + ' [data-act="void"]')
            dr.click(KEEP + ' [data-act="void"]')
            dr.fill('.dialog [data-role="cb-void-reason"]', '試跑')
            dr.click('.dialog .btn-danger')
            dr.wait_for_selector('.toast:has-text("試跑模式")')
            dr.locator('[data-role="view-nav"] .nav-item', has_text='月結鎖定').click()
            dr.wait_for_selector(KEEP + ' [data-role="cb-lock-table"]')
            dr.click(KEEP + ' [data-role="cb-lock-row"][data-kind="none"] [data-act="lock"]')
            dr.wait_for_selector('.dialog'); dr.click('.dialog .btn-primary')
            dr.wait_for_selector('.toast:has-text("試跑模式")')
            dr.locator('[data-role="view-nav"] .nav-item', has_text='會計科目').click()
            dr.wait_for_selector(KEEP + ' [data-role="cb-sub-exp"]')
            dr.fill(KEEP + ' [data-role="cb-sub-exp"]', '試跑科目')
            dr.click(KEEP + ' [data-role="cb-sub-save"]')
            dr.wait_for_selector('.dialog [data-role="cb-sub-diff"]'); dr.click('.dialog .btn-primary')
            dr.wait_for_selector('.toast:has-text("試跑模式")')
            check({a: len(calls(a)) for a in WRITE} == n_w, '試跑模式：adminVoid／adminLock／adminSave 都沒送到後端')
            dr.locator('[data-role="view-nav"] .nav-item', has_text='匯出 Excel').click()
            dr.wait_for_selector(KEEP + ' [data-role="cb-export-btn"]')
            dr.select_option(KEEP + ' [data-role="cb-month"]', ds['cur'])
            with dr.expect_download(timeout=15000) as dl:
                dr.click(KEEP + ' [data-role="cb-export-btn"]')
            check(dl.value.suggested_filename.endswith('.xlsx'), '試跑模式：匯出（讀取）照常下載')
            dr.screenshot(path=os.path.join(ART, 'cashbook-dryrun.png'))
            dr.context.close()

            browser.close()

        # ====== 守門 ======
        check(mock.cb_leaked == [], '前端 payload 沒有 operator／金鑰／通行碼欄位：%s' % mock.cb_leaked)
        check(mock.leaked == [], '沒有未被 mock 涵蓋的外部請求：%s' % mock.leaked)
        allowed_hosts = {re.match(r'^https?://([^/]+)', u).group(1) for u in mock.urls.values()} | {'example.test'}
        bad_ext = [u for u in external if re.match(r'^https?://([^/]+)', u).group(1) not in allowed_hosts]
        check(not bad_ext, '所有非 127.0.0.1 請求都在 mock 主機清單內（regex 守門）：%s' % bad_ext[:5])
        rep = cm.report()
        check(not rep['missed'], 'clickmap：掃到 %d 個可點元素、點過 %d 個，漏：%s' % (rep['total'], rep['clicked'], rep['missed']))
        print('截圖：%s（%d 份匯出）' % (ART, n_export))
    finally:
        httpd.shutdown()
    print('E2E_SEED=%d' % SEED)
    finish()


if __name__ == '__main__':
    main()
