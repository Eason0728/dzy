#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dd ops ①：營運巡檢（modules/inspection）資料帶入 e2e。
後端＝test/e2e/inspect_backend.mjs（把 apps-script/platform 的 .gs 載進 node vm，假人、假資料；只聽 127.0.0.1）。
瀏覽器打正式平台網址的請求一律 route 到本機後端；本機以外任何網址（re ^https?://(?!127\\.0\\.0\\.1)）一律擋下並記為失敗。

每次全部隨機重抽：墨竹亭題庫（分類數、權重、題型、分數、上限）、額外同仁（督導／店長／區經理／一般同仁人數）、
巡檢門市、日期、每題分數（分層：每張表抽一個水準中心，高中低都出現）、原因、照片張數、加分、加重扣分、哪些筆用 API 直送。
預期分數（營運總分、等第、各表分數、缺失數、經營評鑑）由本檔照 docs/inspection/spec.md 與舊站算分規則自己算（Python，int(x+0.5) 捨入），
不 import 系統的 scoring.js；題目資料從 questions.js 讀（資料不是算式）。

角色各跑一次（營運部、品牌總監、區督導、店長、區經理、一般同仁、人資同仁、執行長）：選單有無、分頁有無、清單筆數＝oracle 可見範圍、
報告分數＝oracle、作廢鈕有無、新增巡檢有無。按鈕稽核：巡檢模組畫面出現過的每一種按鈕／連結／下拉（clickmap 做法）都要點過。
用法：python3 test/e2e/dd_ops_inspection.py　　重現：E2E_SEED=<種子>　　埠：E2E_PORT（預設 9100）、E2E_BACKEND_PORT（預設 9101）
"""
import json
import math
import os
import random
import re
import struct
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ROOT, check, finish, load_backend_urls, start_server

from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('E2E_PORT', '9100'))
BACKEND_PORT = int(os.environ.get('E2E_BACKEND_PORT', '9101'))
PW = 'fake-staff-pw-1'
ADMIN = ('BOSS', 'fake-admin-pw-01')
HERE = os.path.dirname(os.path.abspath(__file__))
SHOT_DIR = os.path.join(ROOT, 'test', 'dd', 'artifacts', 'ops')
SEED = int(os.environ.get('E2E_SEED') or random.randrange(1, 10**9))
rnd = random.Random(SEED)
print('E2E_SEED=%d' % SEED)
EXTERNAL = re.compile(r'^https?://(?!127\.0\.0\.1)')

BANK = json.loads(subprocess.check_output(['node', '-e',
    "import('./modules/inspection/questions.js').then(m=>console.log(JSON.stringify({mala:m.defaultForms('mala'),mzt:m.defaultForms('mzt'),bands:m.GRADE_BANDS})))"], cwd=ROOT, text=True))


# ───────────────────────── oracle（獨立算式）─────────────────────────
def r1(x):
    # 2026-10-30 Eason 照推薦：維持舊站算法＝JS Math.round(x*10)/10（IEEE 雙精度同 JS；68.95 在浮點裡是 689.4999…→ 68.9，不是 69）
    if x is None:
        return None
    return math.floor(x * 10 + 0.5) / 10.0


def grade(s):
    for b in BANK['bands']:
        if s >= b['min']:
            return b['grade']
    return '未達'


def key(f, c, it):
    return '%s.%s.%s' % (f['id'], c['id'], it['n'])


def fmt(n):
    return '—' if n is None else ('%.1f' % n).rstrip('0').rstrip('.')


def expect(forms, ans):
    per = {}
    for f in forms:
        cats, bonus, pen = [], 0, 0
        for c in f['categories']:
            if c['role'] == 'scored':
                vals = [ans['scores'][key(f, c, it)] for it in c['items'] if key(f, c, it) in ans['scores']]
                if vals:
                    cats.append((c['weight'], sum(vals) / (5.0 * len(vals))))
            elif c['role'] == 'bonus':
                for it in c['items']:
                    k = key(f, c, it)
                    if it['type'] == 'bonus' and ans['bonuses'].get(k):
                        bonus += it['points']
                    if it['type'] == 'bonus_free':
                        bonus += it['points'] * min(it['max'], len([s for s in ans['free'].get(k, []) if s.strip()]))
            elif c['role'] == 'penalty':
                pen += sum(it['points'] for it in c['items'] if ans['pen'].get(key(f, c, it)))
        score = None
        if cats:
            w = sum(x for x, _ in cats)
            bonus = min(bonus, 20)   # 2026-10-30 Eason 照推薦：每張表加分總額上限 +20
            score = sum(x * r for x, r in cats) / w * 100 + bonus
        per[f['id']] = {'score': score, 'pen': pen, 'bonus': bonus if cats else 0, 'inop': f['inOperational']}
    ev = [v for v in per.values() if v['inop'] and v['score'] is not None]
    pen = sum(v['pen'] for v in per.values() if v['inop'])
    op = r1(sum(v['score'] for v in ev) / len(ev) - pen) if ev else None
    mg = per['management']['score'] if 'management' in per else None
    mg = r1(mg) if mg is not None else None
    return {'op': op, 'opg': grade(op) if op is not None else '未評', 'mg': mg, 'mgg': grade(mg) if mg is not None else '未評',
            'pen': pen, 'forms': {fid: r1(v['score']) for fid, v in per.items()}, 'bonus': {fid: v['bonus'] for fid, v in per.items()}}


def defects(forms, ans):
    n = 0
    for f in forms:
        for c in f['categories']:
            for it in c['items']:
                k = key(f, c, it)
                if c['role'] == 'scored' and k in ans['scores'] and ans['scores'][k] < 5:
                    n += 1
                if c['role'] == 'penalty' and ans['pen'].get(k):
                    n += 1
    return n


# ───────────────────────── 隨機資料 ─────────────────────────
WORDS = ['桌面乾淨', '招呼客人', '冰箱溫度', '湯頭溫度', '出餐時間', '制服整齊', '收銀正確', '叉燒切片厚度', '麵條口感', '餐具清潔', '地板無油漬', '標籤向外']


def split_weights(n):
    cuts = set()
    while len(cuts) < n - 1:
        cuts.add(rnd.randint(1, 99))
    arr = [0] + sorted(cuts) + [100]
    return [arr[i + 1] - arr[i] for i in range(n)]


def random_bank():
    """墨竹亭自訂題庫：每張表隨機分類／題型；至少一張營運表有評分題"""
    forms = json.loads(json.dumps(BANK['mzt']))
    seq = [0]

    def cid():
        seq[0] += 1
        return 'q%d' % seq[0]
    for f in forms:
        f['heading'] = rnd.choice(['', '墨竹亭' + f['name'] + '表'])
        if rnd.random() < 0.15:
            continue
        ns = rnd.randint(0, 3)
        if ns:
            ws = split_weights(ns)
            for i in range(ns):
                items = [{'n': j + 1, 'type': rnd.choice(['score', 'score', 'critical', 'binary']), 'text': rnd.choice(WORDS) + ' %d' % rnd.randrange(1000)} for j in range(rnd.randint(1, 4))]
                f['categories'].append({'id': cid(), 'name': '分類%d' % rnd.randrange(100), 'role': 'scored', 'weight': ws[i] / 100.0, 'items': items})
        if rnd.random() < 0.5:
            items = []
            left = 40   # 一張表全部加分題可拿的總分不能超過 40（後端 2026-10-30 擋明顯超額；封頂 20 常被超過才測得到）
            for j in range(rnd.randint(1, 2)):
                if left < 1:
                    break
                t = rnd.choice(['bonus', 'bonus_free'])
                it = {'n': j + 1, 'type': t, 'text': '加分 %d' % rnd.randrange(1000)}
                if t == 'bonus_free':
                    it['max'] = rnd.randint(1, 4)
                    it['points'] = rnd.randint(1, max(1, min(20, left // it['max'])))
                    left -= it['points'] * it['max']
                else:
                    it['points'] = rnd.randint(1, min(20, left))
                    left -= it['points']
                items.append(it)
            f['categories'].append({'id': cid(), 'name': '加分項', 'role': 'bonus', 'items': items})
        if rnd.random() < 0.5:
            f['categories'].append({'id': cid(), 'name': '加重扣分', 'role': 'penalty', 'items': [{'n': j + 1, 'type': 'penalty', 'text': '扣分 %d' % rnd.randrange(1000), 'points': rnd.randint(1, 20)} for j in range(rnd.randint(1, 2))]})
    if not any(f['inOperational'] and any(c['role'] == 'scored' for c in f['categories']) for f in forms):
        forms[0]['categories'].insert(0, {'id': cid(), 'name': '保底', 'role': 'scored', 'weight': 1, 'items': [{'n': 1, 'type': 'score', 'text': '保底題'}]})
        sc = [c for c in forms[0]['categories'] if c['role'] == 'scored']
        for c, wgt in zip(sc, split_weights(len(sc))):
            c['weight'] = wgt / 100.0
    return forms


def make_answers(forms, force_all_types):
    ans = {'scores': {}, 'bonuses': {}, 'free': {}, 'pen': {}, 'reason': {}, 'photo': {}}
    for f in forms:
        center = rnd.choice([5, 4.6, 4, 3.2, 2.5, 1.5])
        for c in f['categories']:
            for it in c['items']:
                k = key(f, c, it)
                if c['role'] == 'scored':
                    if rnd.random() < 0.1:
                        continue
                    if it['type'] == 'score':
                        v = max(0, min(5, int(round(rnd.gauss(center, 0.9)))))
                    else:
                        v = 0 if rnd.random() < (0.25 if center < 4 else 0.05) else 5
                    ans['scores'][k] = v
                    if v < 5:
                        ans['reason'][k] = rnd.choice(['桌面有油漬', '沒有招呼客人', '冰箱溫度 9 度', '標籤朝內', '醬汁偏鹹']) + ' #' + str(rnd.randrange(100))
                        if rnd.random() < 0.25:
                            ans['photo'][k] = rnd.randint(1, 2)
                elif c['role'] == 'bonus':
                    if it['type'] == 'bonus' and rnd.random() < 0.35:
                        ans['bonuses'][k] = True
                    if it['type'] == 'bonus_free' and rnd.random() < 0.35:
                        ans['free'][k] = ['主動幫客人叫車 %d' % rnd.randrange(100) for _ in range(rnd.randint(1, it['max']))]
                elif c['role'] == 'penalty' and rnd.random() < 0.2:
                    ans['pen'][k] = '說明 %d' % rnd.randrange(100)
                    if rnd.random() < 0.3:
                        ans['photo'][k] = 1
    if force_all_types:
        items = [(f, c, it) for f in forms for c in f['categories'] for it in c['items']]

        def pick(t):
            xs = [x for x in items if x[2]['type'] == t]
            return rnd.choice(xs) if xs else None
        if not ans['free'] and pick('bonus_free'):
            f, c, it = pick('bonus_free'); ans['free'][key(f, c, it)] = ['主動幫客人叫車 %d' % rnd.randrange(100)]
        if not ans['bonuses'] and pick('bonus'):
            f, c, it = pick('bonus'); ans['bonuses'][key(f, c, it)] = True
        if not ans['pen'] and pick('penalty'):
            f, c, it = pick('penalty'); ans['pen'][key(f, c, it)] = '說明 %d' % rnd.randrange(100)
        if not ans['photo']:
            k = next(iter(ans['reason']), None) or next(iter(ans['pen']), None)
            if k:
                ans['photo'][k] = 1
    return ans


def to_backend_answers(ans):
    return {'scores': ans['scores'], 'bonuses': ans['bonuses'], 'freeBonuses': ans['free'],
            'penalties': {k: {'checked': True, 'note': v} for k, v in ans['pen'].items()}, 'reasons': ans['reason'], 'photos': {}}


def bmp(path, w, h, color):
    row = bytes(color) * w + b'\x00' * ((4 - (w * 3) % 4) % 4)
    data = row * h
    hdr = b'BM' + struct.pack('<IHHI', 54 + len(data), 0, 0, 54) + struct.pack('<IiiHHIIiiII', 40, w, h, 1, 24, 0, len(data), 2835, 2835, 0, 0)
    with open(path, 'wb') as fh:
        fh.write(hdr + data)


# ───────────────────────── 後端 ─────────────────────────
def api(action, payload=None, token=''):
    body = json.dumps({'action': action, 'token': token, 'payload': payload or {}}).encode()
    req = urllib.request.Request('http://127.0.0.1:%d/platform/api' % BACKEND_PORT, data=body, headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def start_backend():
    env = dict(os.environ, PORT=str(BACKEND_PORT))
    proc = subprocess.Popen(['node', os.path.join(HERE, 'inspect_backend.mjs')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    accounts = None
    deadline = time.time() + 30
    while time.time() < deadline:
        line = proc.stdout.readline()
        if line.startswith('ACCOUNTS '):
            accounts = json.loads(line[len('ACCOUNTS '):])
        if '測試後端 http' in line:
            return proc, accounts
    proc.kill()
    raise SystemExit('營運巡檢測試後端沒有啟動')


_seq = [100]


def mk_person(admin_tok, name, org):
    """照 inspect_backend.mjs 的 mk：匯入→認領→確認→登入；全部假資料"""
    _seq[0] += 1
    name = '%s%d' % (name, _seq[0])
    api('staffImport', {'names': [name]}, admin_tok)
    lk = api('claimLookup', {'name': name})
    prof = dict(dept='', birthday='1990-01-0%d' % (1 + _seq[0] % 8), phone='09%08d' % (40000000 + _seq[0]), address='新竹市假資料路%d號' % _seq[0])
    prof.update(org)
    sub = api('claimSubmit', dict(prof, name=name, emp_no=lk['data']['emp_no'], password=PW))
    assert sub.get('ok'), sub
    cf = api('staffConfirm', {'emp_no': lk['data']['emp_no']}, admin_tok)
    assert cf.get('ok'), cf
    return {'emp': lk['data']['emp_no'], 'name': name, **org}


ALL_LEAKS = []


def install_routes(context, urls):
    real = urls['platform']
    base = real[:-len('/api')]

    def fwd(path):
        def handle(route):
            data = route.request.post_data.encode('utf-8') if route.request.post_data else b''
            r = urllib.request.Request('http://127.0.0.1:%d/platform%s' % (BACKEND_PORT, path), data=data, headers={'Content-Type': 'text/plain'})
            body = urllib.request.urlopen(r, timeout=30).read()
            route.fulfill(status=200, headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}, body=body)
        return handle
    ok_urls = {real, base + '/proxy', base + '/svc/apv-file-put', base + '/svc/apv-file-get'}

    def guard(route):
        if route.request.url.split('?')[0] in ok_urls:
            return route.fallback()
        ALL_LEAKS.append(route.request.url)
        return route.abort()
    context.route(EXTERNAL, guard)
    context.route(base + '/proxy', fwd('/proxy'))
    context.route(real, fwd('/api'))
    context.route(base + '/svc/apv-file-put', fwd('/svc/apv-file-put'))
    context.route(base + '/svc/apv-file-get', fwd('/svc/apv-file-get'))


# ───────────────────────── 按鈕稽核（clickmap 做法）─────────────────────────
seen, clicked = {}, set()
SKIP = {'act:drop': '捨棄草稿的 confirm 與 cancel 同一支（cancel 已點）', 'act:setup': '只在沒初始化時出現（node 測試已驗）'}
SCAN_JS = """() => [...document.querySelectorAll('[data-keep=inspection] [data-act], [data-keep=inspection] [data-tab], [data-keep=inspection] [data-open], [data-keep=inspection] select[data-role], [data-keep=inspection] input[data-role=month], [data-role=view-nav] [data-view]')]
  .map(e => e.dataset.act ? 'act:' + e.dataset.act : e.dataset.tab ? 'tab:' + e.dataset.tab : e.dataset.open !== undefined ? 'open' : e.dataset.view ? 'view:' + e.dataset.view : 'sel:' + e.dataset.role)"""


def scan(page, where):
    for k in page.evaluate(SCAN_JS):
        seen.setdefault(k, where)


def mark(k):
    clicked.add(k)


def login(page, base, user, q=''):
    page.goto(base + '/index.html' + q)
    page.fill('#login-username', user)
    page.fill('#login-password', PW)
    page.click('[data-role="submit"]')
    page.wait_for_selector('[data-role="view-content"]', state='attached', timeout=15000)
    page.wait_for_function("document.querySelectorAll('[data-nav]').length > 3", timeout=15000)


def go(page, base, view, q=''):
    page.goto(base + '/index.html' + q + '#/inspection/' + view)
    page.wait_for_selector('[data-keep=inspection] .ip-wrap', timeout=15000)


def no_toast(page):
    page.wait_for_function("()=>!document.querySelector('.toast-stack .toast')", timeout=15000)


def confirm(page):
    page.locator('.dialog button', has_text='確定').click()


def no_hscroll(page):
    return page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')


def R(page):
    return page.locator('[data-keep=inspection]')


def fill_all(page, forms, ans, tmp):
    root = R(page)
    pcount = 0
    for f in forms:
        if not f['categories']:
            continue
        root.locator('[data-tab=%s].ip-tab' % f['id']).click(); mark('tab:' + f['id'])
        page.wait_for_selector('[data-keep=inspection] .ip-tab.on[data-tab=%s]' % f['id'])
        scan(page, '填寫・' + f['name'])
        for c in f['categories']:
            for it in c['items']:
                k = key(f, c, it)
                box = root.locator('[data-k="%s"]' % k)
                if k in ans['scores']:
                    box.locator('[data-act=score][data-v="%d"]' % ans['scores'][k]).click(); mark('act:score')
                    if k in ans['reason']:
                        box.locator('[data-act=reason]').fill(ans['reason'][k]); mark('act:reason')
                elif k in ans['bonuses']:
                    box.locator('[data-act=bonus]').check(); mark('act:bonus')
                elif k in ans['free']:
                    for i, s in enumerate(ans['free'][k]):
                        box.locator('[data-act=free][data-i="%d"]' % i).fill(s)
                    mark('act:free')
                elif k in ans['pen']:
                    box.locator('[data-act=pen]').check()
                    box.locator('[data-act=pennote]').fill(ans['pen'][k]); mark('act:pen'); mark('act:pennote')
                if k in ans['photo']:
                    paths = []
                    for i in range(ans['photo'][k]):
                        pcount += 1
                        p = os.path.join(tmp, 'p%d.bmp' % pcount)
                        bmp(p, rnd.randint(40, 120), rnd.randint(40, 120), (rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)))
                        paths.append(p)
                    box.locator('[data-act=photo]').set_input_files(paths)
                    page.wait_for_function("([k,n])=>document.querySelectorAll('[data-keep=inspection] [data-k=\"'+k+'\"] .ip-thumb img').length===n && !document.querySelector('[data-keep=inspection] .ip-thumb.busy')", arg=[k, len(paths)], timeout=15000)
                    mark('act:photo')
    return pcount


def score_bar_ok(page, exp, label):
    bar = R(page).locator('[data-role=score]').inner_text()
    left, right = bar.split('經營評鑑')[0], bar.split('經營評鑑')[1]
    check(fmt(exp['op']) in left and exp['opg'] in left, '%s 頁頂營運總分＝%s %s（畫面：%s）' % (label, fmt(exp['op']), exp['opg'], left.replace('\n', ' ')))
    check(fmt(exp['mg']) in right and exp['mgg'] in right, '%s 頁頂經營評鑑＝%s %s（畫面：%s）' % (label, fmt(exp['mg']), exp['mgg'], right.replace('\n', ' ')))
    if exp['pen']:
        check(('−%s' % fmt(exp['pen'])) in left, '%s 頁頂標出加重扣分 −%s' % (label, fmt(exp['pen'])))


def report_ok(page, forms, exp, ndef, nphoto, label):
    rep = R(page).inner_text()
    check('營運巡檢報告' in rep and fmt(exp['op']) in rep.split('各表分數')[0] and exp['opg'] in rep.split('各表分數')[0], '%s 報告營運總分＝%s %s' % (label, fmt(exp['op']), exp['opg']))
    check(fmt(exp['mg']) in rep.split('各表分數')[0], '%s 報告經營評鑑＝%s' % (label, fmt(exp['mg'])))
    check(('%d 項' % ndef) in rep and ('照片 %d 張' % nphoto) in rep, '%s 報告缺失 %d 項、照片 %d 張' % (label, ndef, nphoto))
    rows = R(page).locator('.ip-table tbody tr').all_inner_texts()
    for f in forms:
        want = fmt(exp['forms'][f['id']])
        row = next((r for r in rows if r.startswith(f['name'])), '')
        check(row.split('\t')[1].strip() == want if '\t' in row else want in row, '%s 各表分數 %s＝%s（列：%s）' % (label, f['name'], want, row.replace('\n', ' ')[:60]))
    if nphoto:
        page.wait_for_function("()=>{const im=[...document.querySelectorAll('[data-keep=inspection] .ip-bigphotos img')];return im.length>0&&im.every(i=>i.src.startsWith('data:image'))}", timeout=15000)
    check(R(page).locator('.ip-bigphotos img').count() == nphoto, '%s 報告照片 %d 張都讀得出來' % (label, nphoto))


def main():
    os.makedirs(SHOT_DIR, exist_ok=True)
    tmp = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'dd-insp-%d' % SEED)
    os.makedirs(tmp, exist_ok=True)
    proc, acc = start_backend()
    httpd, base = start_server(PORT)
    urls = load_backend_urls()
    try:
        admin_tok = api('login', {'username': ADMIN[0], 'password': ADMIN[1]})['data']['token']
        # 隨機額外同仁（人數、職稱隨機），都用假名；清單可見範圍的 oracle 要算到他們
        extra = []
        for _ in range(rnd.randint(0, 2)):
            extra.append(mk_person(admin_tok, '假督導', {'brand': 'mala', 'unit': 'mala-hq', 'title': 'osv'}))
        for u in ['mala-gf', 'mala-mc', 'mala-nc', 'mzt-gf', 'mzt-js']:
            if rnd.random() < 0.5:
                extra.append(mk_person(admin_tok, '假同仁', {'brand': u.split('-')[0], 'unit': u, 'title': rnd.choice(['pt', 'ft'])}))
            if rnd.random() < 0.3:
                extra.append(mk_person(admin_tok, '假區經理', {'brand': u.split('-')[0], 'unit': u, 'title': 'am'}))
        print('額外同仁 %d 位' % len(extra))

        # 人物表：帳號 → 角色、可見門市（oracle）
        MALA = ['mala-gf', 'mala-mc', 'mala-nc']; MZT = ['mzt-gf', 'mzt-js', 'mzt-lzl']; YIWU = ['yiwu-js', 'yiwu-wx']
        ALL = MALA + MZT + YIWU
        roles = {
            'ops': dict(user=acc['ops'], view=ALL, do=True, void=True, bank=['mzt', 'mala', 'yiwu'], label='營運部'),
            'malaOdir': dict(user=acc['malaOdir'], view=MALA, do=True, void=False, bank=['mala'], label='小辛辣總監'),
            'malaOsv': dict(user=acc['malaOsv'], view=MALA, do=True, void=False, bank=[], label='小辛辣督導'),
            'mztOsv': dict(user=acc['mztOsv'], view=MZT, do=True, void=False, bank=[], label='墨竹亭督導'),
            'gfSm': dict(user=acc['gfSm'], view=['mala-gf'], do=False, void=False, bank=[], label='光復店長'),
            'mcSm': dict(user=acc['mcSm'], view=['mala-mc'], do=False, void=False, bank=[], label='美村店長'),
            'mztAm': dict(user=acc['mztAm'], view=['mzt-gf'], do=True, void=False, bank=[], label='墨竹亭區經理'),
            'gfPt': dict(user=acc['gfPt'], view=[], do=False, void=False, bank=[], label='光復計時'),
            'hr': dict(user=acc['hr'], view=[], do=False, void=False, bank=[], label='人資同仁'),
            'ceo': dict(user=acc['ceo'], view=ALL, do=False, void=False, bank=[], label='執行長'),   # 2026-10-30 作廢改看 platform.insp-void（預設只給營運部）
        }
        for e in extra:
            v = ALL if False else ({'osv': MALA if e['brand'] == 'mala' else MZT, 'am': [e['unit']], 'pt': [], 'ft': []}[e['title']])
            roles[e['emp']] = dict(user=e['emp'], view=v, do=e['title'] in ('osv', 'am'), void=False, bank=[], label=e['name'])

        # 初始化＋墨竹亭隨機題庫（營運部透過 API 存；畫面上再驗版本與題數）
        check(api('inspSetup', {}, admin_tok)['ok'], '初始化營運巡檢')
        ops_tok = api('login', {'username': acc['ops'], 'password': PW})['data']['token']
        mzt_forms = random_bank()
        sv = api('inspBankSave', {'brand': 'mzt', 'forms': mzt_forms, 'expected_ver': ''}, ops_tok)
        n_mzt = sum(len(c['items']) for f in mzt_forms for c in f['categories'])
        check(sv.get('ok') and sv['data']['ver'] == 'mzt-v1' and sv['data']['total'] == n_mzt, '墨竹亭隨機題庫存檔 mzt-v1（%d 題）：%s' % (n_mzt, sv))
        mzt_saved = api('inspBankGet', {'brand': 'mzt'}, ops_tok)['data']['forms']   # 後端清洗後的版本（n 重編、權重三位小數）
        mala_forms = BANK['mala']

        records = []   # oracle：{id, unit, exp, ndef, nphoto, inspector}

        def submit_api(role_key, unit, forms, bank_ver):
            tok = api('login', {'username': roles[role_key]['user'], 'password': PW})['data']['token']
            ans = make_answers(forms, False)
            exp = expect(forms, ans)
            rid = 'INS-%s-%s' % (format(int(time.time() * 1000) + len(records), 'x').upper(), ''.join(rnd.choice('ABCDEFGHJKMNPQRSTUVWXYZ23456789') for _ in range(6)))
            date = '2026-%02d-%02d' % (rnd.randint(7, 10), rnd.randint(1, 28))
            summary = {'operationalScore': exp['op'], 'operationalGrade': exp['opg'], 'managementScore': exp['mg'], 'managementGrade': exp['mgg'],
                       'penaltyTotal': exp['pen'], 'forms': [{'id': f['id'], 'name': f['name'], 'score': exp['forms'][f['id']], 'bonus': exp['bonus'][f['id']]} for f in forms], 'defects': defects(forms, ans)}
            r = api('inspSubmit', {'id': rid, 'unit': unit, 'date': date, 'bank_ver': bank_ver, 'forms': forms, 'answers': to_backend_answers(ans), 'summary': summary, 'files': []}, tok)
            check(r.get('ok'), 'API 直送巡檢 %s %s by %s：%s' % (unit, date, roles[role_key]['label'], r))
            records.append(dict(id=rid, unit=unit, exp=exp, ndef=defects(forms, ans), nphoto=0, inspector=roles[role_key]['label'], date=date))

        # 先用 API 直送隨機幾筆（讓清單有高中低各種分數、不同門市）
        for _ in range(rnd.randint(1, 4)):
            u = rnd.choice(MALA)
            submit_api(rnd.choice(['ops', 'malaOdir', 'malaOsv']), u, mala_forms, 'default-2026-10-27')
        for _ in range(rnd.randint(0, 2)):
            submit_api(rnd.choice(['ops', 'mztOsv', 'mztAm']), 'mzt-gf', mzt_saved, 'mzt-v1')

        with sync_playwright() as pw:
            browser = pw.chromium.launch()

            def new_page(w=1280, h=900):
                ctx = browser.new_context(viewport={'width': w, 'height': h})
                install_routes(ctx, urls)
                pg = ctx.new_page()
                errs = []
                pg.on('pageerror', lambda e: errs.append(str(e)))
                pg._errs = errs
                return ctx, pg

            # ① 小辛辣：隨機一位能巡的人（督導／總監／營運部）在畫面上完整巡一次
            insp_key = rnd.choice(['malaOsv', 'malaOdir', 'ops'])
            store = rnd.choice(MALA)
            ans = make_answers(mala_forms, True)
            exp = expect(mala_forms, ans)
            ndef = defects(mala_forms, ans)
            nphoto = sum(ans['photo'].values())
            print('① %s 巡 %s：營運 %s（%s）、經營 %s（%s）、缺失 %d、照片 %d' % (roles[insp_key]['label'], store, exp['op'], exp['opg'], exp['mg'], exp['mgg'], ndef, nphoto))
            ctx, page = new_page()
            login(page, base, roles[insp_key]['user'])
            check(page.locator('[data-nav=inspection]').count() == 1, '① 選單有「營運巡檢」')
            page.locator('[data-nav=inspection]').first.click()
            page.wait_for_selector('[data-keep=inspection] [data-act=new]', timeout=15000)
            scan(page, '紀錄')
            check(page.locator('[data-role=view-nav] [data-view]').count() == (3 if roles[insp_key]['bank'] else 2), '① 分頁數＝%d（有題目設定權才有第三頁）' % (3 if roles[insp_key]['bank'] else 2))
            page.locator('[data-keep=inspection] [data-act=new]').click(); mark('act:new')
            page.wait_for_selector('[data-keep=inspection] #ip-unit')
            scan(page, '開始')
            page.locator('[data-keep=inspection] [data-act=start]').click(); mark('act:start')
            check('請先選門市' in page.locator('.toast-stack').inner_text(), '① 沒選門市不能開始')
            opts = page.eval_on_selector_all('[data-keep=inspection] #ip-unit option', 'o=>o.map(x=>x.value).filter(Boolean)')
            check(sorted(opts) == sorted(roles[insp_key]['view']), '① 可選門市＝%s 的範圍（%s）' % (roles[insp_key]['label'], sorted(opts)))
            page.select_option('[data-keep=inspection] #ip-unit', store)
            date = '2026-10-%02d' % rnd.randint(1, 27)
            page.fill('[data-keep=inspection] #ip-date', date)
            no_toast(page); page.locator('[data-keep=inspection] [data-act=start]').click()
            page.wait_for_selector('[data-keep=inspection] .ip-tab')
            scan(page, '填寫')
            # 草稿：重新整理後能繼續；再按一次＝取消
            page.locator('[data-keep=inspection] [data-k="service.attitude.1"] [data-act=score][data-v="4"]').click()
            page.reload(); page.wait_for_selector('[data-keep=inspection] [data-act=go]', timeout=15000)
            scan(page, '續填')
            page.locator('[data-keep=inspection] [data-act=go]').click(); mark('act:go')
            page.wait_for_selector('[data-keep=inspection] .ip-tab')
            check(page.locator('[data-keep=inspection] [data-k="service.attitude.1"] .ip-pt.on').inner_text() == '4', '① 重新整理後草稿還在（4 分）')
            page.locator('[data-keep=inspection] [data-k="service.attitude.1"] [data-act=score][data-v="4"]').click()
            check(page.locator('[data-keep=inspection] [data-k="service.attitude.1"] .ip-pt.on').count() == 0, '① 再按一次＝取消評分')
            fill_all(page, mala_forms, ans, tmp)
            if nphoto:
                k = next(iter(ans['photo']))
                page.locator('[data-keep=inspection] [data-tab=%s].ip-tab' % k.split('.')[0]).click()
                box = page.locator('[data-keep=inspection] [data-k="%s"]' % k)
                box.locator('[data-act=rmphoto]').first.click(); mark('act:rmphoto')
                page.wait_for_function("([k,n])=>document.querySelectorAll('[data-keep=inspection] [data-k=\"'+k+'\"] .ip-thumb img').length===n", arg=[k, ans['photo'][k] - 1])
                p = os.path.join(tmp, 'again.bmp'); bmp(p, 50, 50, (10, 200, 30))
                box.locator('[data-act=photo]').set_input_files([p])
                page.wait_for_function("([k,n])=>document.querySelectorAll('[data-keep=inspection] [data-k=\"'+k+'\"] .ip-thumb img').length===n && !document.querySelector('[data-keep=inspection] .ip-thumb.busy')", arg=[k, ans['photo'][k]], timeout=15000)
            score_bar_ok(page, exp, '①')
            # 分頁上的缺失數
            for f in mala_forms:
                n = sum(1 for c in f['categories'] for it in c['items'] if (c['role'] == 'scored' and ans['scores'].get(key(f, c, it), 5) < 5) or (c['role'] == 'penalty' and ans['pen'].get(key(f, c, it))))
                t = page.locator('[data-keep=inspection] .ip-tab[data-tab=%s] .n' % f['id'])
                check((t.count() == 0 and n == 0) or (t.count() == 1 and t.inner_text() == str(n)), '① 分頁「%s」缺失數＝%d' % (f['name'], n))
            page.locator('[data-keep=inspection] [data-tab=service].ip-tab').click()
            no_toast(page); page.locator('[data-keep=inspection] .ip-sticky [data-tab=environment]').click()
            check(page.locator('[data-keep=inspection] .ip-tab.on').get_attribute('data-tab') == 'environment', '① 「下一張」換到環境表')
            page.screenshot(path=os.path.join(SHOT_DIR, 'insp_1_fill_%d.png' % SEED))
            no_toast(page); page.locator('[data-keep=inspection] [data-act=cancel]').click(); mark('act:cancel')
            page.locator('.dialog button', has_text='取消').click()
            check(page.locator('[data-keep=inspection] .ip-tab').count() == 4, '① 捨棄草稿按取消＝沒捨棄')
            no_toast(page); page.locator('[data-keep=inspection] [data-act=submit]').click(); mark('act:submit')
            dlg = page.locator('.dialog').inner_text()
            n_un = sum(1 for f in mala_forms for c in f['categories'] if c['role'] == 'scored' for it in c['items'] if key(f, c, it) not in ans['scores'])
            check(('營運 %s（%s）' % (fmt(exp['op']), exp['opg'])) in dlg and ('缺失 %d 項' % ndef) in dlg and ((n_un == 0) or ('還有 %d 題沒評' % n_un) in dlg), '① 送出確認框：分數、缺失 %d、沒評 %d 題（%s）' % (ndef, n_un, dlg.replace('\n', ' ')[:100]))
            confirm(page)
            page.wait_for_selector('[data-keep=inspection] [data-act=back]', timeout=20000)
            scan(page, '報告')
            report_ok(page, mala_forms, exp, ndef, nphoto, '①')
            some = next(iter(ans['reason'].values()), None)
            check(some is None or ('原因：' + some) in R(page).inner_text(), '① 報告列出缺失原因')
            check(R(page).locator('[data-act=void]').count() == (1 if roles[insp_key]['void'] else 0), '① 作廢鈕有無＝%s' % roles[insp_key]['void'])
            page.screenshot(path=os.path.join(SHOT_DIR, 'insp_2_report_%d.png' % SEED), full_page=True)
            rid = page.evaluate('location.hash')
            rid = re.search(r'id=([^&]+)', rid).group(1) if 'id=' in rid else ''
            records.append(dict(id=rid, unit=store, exp=exp, ndef=ndef, nphoto=nphoto, inspector=roles[insp_key]['label'], date=date))
            page.locator('[data-keep=inspection] [data-act=back]').click(); mark('act:back')
            page.wait_for_selector('[data-keep=inspection] [data-open]')
            scan(page, '紀錄（有資料）')
            rows = R(page).locator('tbody tr').all_inner_texts()
            check(len(rows) == len([r for r in records if r['unit'] in roles[insp_key]['view']]), '① 清單筆數＝%d' % len(rows))
            top = rows[0] if rows else ''
            check(fmt(exp['op']) in top and str(ndef) in top and roles[insp_key]['label'] in top if date >= max(r['date'] for r in records) else True, '① 清單最新一列（%s）' % top.replace('\n', ' ')[:80])
            page.select_option('[data-keep=inspection] [data-role=unit]', store); mark('sel:unit')
            page.wait_for_selector('[data-keep=inspection] [data-open]')
            check(R(page).locator('tbody tr').count() == len([r for r in records if r['unit'] == store]), '① 門市篩選 %s' % store)
            page.fill('[data-keep=inspection] [data-role=month]', '2020-01'); page.dispatch_event('[data-keep=inspection] [data-role=month]', 'change'); mark('sel:month')
            page.wait_for_function("()=>document.querySelector('[data-keep=inspection]').innerText.includes('還沒有巡檢紀錄')", timeout=10000)
            check(True, '① 月份篩選 2020-01 → 沒有紀錄')
            check(not page._errs, '① 沒有 JS 錯誤 %s' % page._errs[:2])
            ctx.close()

            # ② 墨竹亭：區經理用隨機題庫巡自己店（API 存的版本；畫面上題目＝存的題目）
            mz_ans = make_answers(mzt_saved, False)
            mz_exp = expect(mzt_saved, mz_ans)
            mz_def = defects(mzt_saved, mz_ans)
            mz_photo = sum(mz_ans['photo'].values())
            ctx, page = new_page()
            login(page, base, acc['mztAm'])
            go(page, base, 'fill')
            page.wait_for_selector('[data-keep=inspection] #ip-unit')
            opts = page.eval_on_selector_all('[data-keep=inspection] #ip-unit option', 'o=>o.map(x=>x.value).filter(Boolean)')
            check(opts == ['mzt-gf'], '② 區經理只能選自己店：%s' % opts)
            page.select_option('[data-keep=inspection] #ip-unit', 'mzt-gf')
            no_toast(page); page.locator('[data-keep=inspection] [data-act=start]').click()
            page.wait_for_selector('[data-keep=inspection] .ip-tab')
            texts = page.eval_on_selector_all('[data-keep=inspection] .ip-text', 'e=>e.map(x=>x.textContent)')
            want0 = ['%d. %s' % (it['n'], it['text']) for c in mzt_saved[0]['categories'] for it in c['items']]
            check(texts == want0, '② 服務表題目＝存檔的隨機題目（%d 題）' % len(want0))
            fill_all(page, mzt_saved, mz_ans, tmp)
            score_bar_ok(page, mz_exp, '②')
            no_toast(page); page.locator('[data-keep=inspection] [data-act=submit]').click()
            if mz_exp['op'] is None and mz_exp['mg'] is None:
                check('還沒有評任何一題' in page.locator('.toast-stack').inner_text(), '② 一題都沒評不能送出')
            else:
                confirm(page)
                page.wait_for_selector('[data-keep=inspection] [data-act=back]', timeout=20000)
                report_ok(page, mzt_saved, mz_exp, mz_def, mz_photo, '②')
                page.screenshot(path=os.path.join(SHOT_DIR, 'insp_3_mzt_report_%d.png' % SEED), full_page=True)
                h = page.evaluate('location.hash')
                records.append(dict(id=re.search(r'id=([^&]+)', h).group(1), unit='mzt-gf', exp=mz_exp, ndef=mz_def, nphoto=mz_photo, inspector='測試墨竹亭區經理', date=time.strftime('%Y-%m-%d', time.gmtime(time.time() + 8 * 3600))))
            check(not page._errs, '② 沒有 JS 錯誤 %s' % page._errs[:2])
            ctx.close()

            # ③ 每個角色各跑一次：選單、分頁、清單筆數、報告、作廢鈕、新增鈕
            for rk, ro in roles.items():
                ctx, page = new_page()
                login(page, base, ro['user'])
                has_nav = page.locator('[data-nav=inspection]').count()
                visible = bool(ro['view']) or bool(ro['bank'])
                check(has_nav == (1 if visible else 0), '③ %s 選單有營運巡檢＝%s' % (ro['label'], visible))
                if not visible:
                    page.goto(base + '/index.html#/inspection/list'); time.sleep(1.2)
                    check(page.locator('[data-keep=inspection] .ip-wrap').count() == 0, '③ %s 直打網址進不去' % ro['label'])
                    ctx.close(); continue
                go(page, base, 'list')
                views = page.eval_on_selector_all('[data-role=view-nav] [data-view]', 'e=>e.map(x=>x.dataset.view)')
                want_views = ['list'] + (['fill'] if ro['do'] else []) + (['bank'] if ro['bank'] else [])
                check(views == want_views, '③ %s 分頁＝%s（實際 %s）' % (ro['label'], want_views, views))
                mine = [r for r in records if r['unit'] in ro['view']]
                if mine:
                    page.wait_for_selector('[data-keep=inspection] [data-open]', timeout=15000)
                    rows = R(page).locator('tbody tr').all_inner_texts()
                    check(len(rows) == len(mine), '③ %s 清單 %d 筆＝可見範圍 %s' % (ro['label'], len(rows), ro['view']))
                    check(all(any(r['date'] in row for r in mine) for row in rows), '③ %s 清單每列日期都在 oracle 內' % ro['label'])
                    dates = [row.split('\t')[0].strip() if '\t' in row else row[:10] for row in rows]
                    check(dates == sorted(dates, reverse=True), '③ %s 清單日期新到舊 %s' % (ro['label'], dates))
                    check(R(page).locator('[data-act=new]').count() == (1 if ro['do'] else 0), '③ %s 「新增巡檢」鈕有無＝%s' % (ro['label'], ro['do']))
                    # 開隨機一筆報告
                    i = rnd.randrange(len(rows))
                    R(page).locator('[data-open]').nth(i).click(); mark('open')
                    page.wait_for_selector('[data-keep=inspection] [data-act=back]')
                    h = page.evaluate('location.hash'); rid = re.search(r'id=([^&]+)', h).group(1)
                    rec = next((r for r in mine if r['id'] == rid), None)
                    check(rec is not None, '③ %s 開的報告在可見範圍內 %s' % (ro['label'], rid))
                    if rec:
                        rep = R(page).inner_text().split('各表分數')[0]
                        check(fmt(rec['exp']['op']) in rep and rec['exp']['opg'] in rep and ('%d 項' % rec['ndef']) in rep, '③ %s 報告分數＝oracle（%s %s、缺失 %d）' % (ro['label'], fmt(rec['exp']['op']), rec['exp']['opg'], rec['ndef']))
                    check(R(page).locator('[data-act=void]').count() == (1 if ro['void'] else 0), '③ %s 作廢鈕有無＝%s' % (ro['label'], ro['void']))
                    scan(page, '報告・' + ro['label'])
                    page.locator('[data-keep=inspection] [data-act=back]').click()
                    page.wait_for_selector('[data-keep=inspection] [data-open]')
                    # 直接查別人範圍的編號
                    other = next((r for r in records if r['unit'] not in ro['view']), None)
                    if other:
                        page.goto(base + '/index.html#/inspection/list?id=' + other['id'])
                        page.wait_for_function("()=>document.querySelector('[data-keep=inspection]') && document.querySelector('[data-keep=inspection]').innerText.includes('找不到這筆巡檢')", timeout=10000)
                        check(True, '③ %s 直打別家店的編號 → 找不到' % ro['label'])
                        page.locator('[data-keep=inspection] [data-act=back]').click()
                else:
                    page.wait_for_function("()=>document.querySelector('[data-keep=inspection]').innerText.includes('還沒有巡檢紀錄') || document.querySelector('[data-keep=inspection]').innerText.includes('沒有可以查看')", timeout=15000)
                    check(True, '③ %s 清單空' % ro['label'])
                if ro['bank']:
                    go(page, base, 'bank')
                    page.wait_for_selector('[data-keep=inspection] [data-role=brand]')
                    bs = page.eval_on_selector_all('[data-keep=inspection] [data-role=brand] option', 'o=>o.map(x=>x.value)')
                    check(sorted(bs) == sorted(ro['bank']), '③ %s 題目設定品牌＝%s' % (ro['label'], ro['bank']))
                    if 'mzt' in ro['bank']:
                        page.select_option('[data-keep=inspection] [data-role=brand]', 'mzt'); mark('sel:brand')
                        page.wait_for_function("()=>document.querySelector('[data-keep=inspection]').innerText.includes('目前版本 mzt-v1')", timeout=10000)
                        check(('共 %d 題' % n_mzt) in R(page).inner_text(), '③ %s 題目設定顯示 mzt-v1、共 %d 題' % (ro['label'], n_mzt))
                        scan(page, '題目設定')
                        # 按鈕稽核：加分類、加題、上下移、刪題、刪分類（取消／確定）、改題型、權重、存檔（衝突）、放棄
                        R(page).locator('[data-act=addcat][data-role-v=scored]').click(); mark('act:addcat')
                        cb = R(page).locator('[data-role=cats] > .ip-item').last
                        cb.locator('[data-act=catname]').fill('稽核分類'); mark('act:catname')
                        cb.locator('[data-act=additem]').click(); mark('act:additem')
                        cb = R(page).locator('[data-role=cats] > .ip-item').last
                        ta = cb.locator('[data-act=text]')
                        ta.nth(0).fill('甲'); ta.nth(1).fill('乙'); mark('act:text')
                        cb.locator('[data-act=itemdown]').first.click(); mark('act:itemdown')
                        cb = R(page).locator('[data-role=cats] > .ip-item').last
                        check(cb.locator('[data-act=text]').nth(0).input_value() == '乙', '③ 題目下移')
                        cb.locator('[data-act=itemup]').nth(1).click(); mark('act:itemup')
                        cb = R(page).locator('[data-role=cats] > .ip-item').last
                        check(cb.locator('[data-act=text]').nth(0).input_value() == '甲', '③ 題目上移')
                        cb.locator('[data-act=type]').first.select_option('binary'); mark('act:type')
                        cb = R(page).locator('[data-role=cats] > .ip-item').last
                        cb.locator('[data-act=itemdel]').last.click(); mark('act:itemdel')
                        cb = R(page).locator('[data-role=cats] > .ip-item').last
                        check(cb.locator('[data-act=text]').count() == 1, '③ 刪一題後剩 1 題')
                        cb.locator('[data-act=weight]').fill('100'); mark('act:weight')
                        # 加重扣分分類（分數欄）與加分項分類（自由填寫上限欄）各加一個，點過 points／max
                        R(page).locator('[data-act=addcat][data-role-v=penalty]').click()
                        pc = R(page).locator('[data-role=cats] > .ip-item').last
                        pc.locator('[data-act=points]').fill(str(rnd.randint(1, 20))); mark('act:points')
                        pc.locator('[data-act=text]').fill('稽核扣分')
                        R(page).locator('[data-act=addcat][data-role-v=bonus]').click()
                        R(page).locator('[data-role=cats] > .ip-item').last.locator('[data-act=type]').select_option('bonus_free')
                        bc = R(page).locator('[data-role=cats] > .ip-item').last
                        bc.locator('[data-act=max]').fill(str(rnd.randint(1, 10))); mark('act:max')
                        bc.locator('[data-act=text]').fill('稽核加分')
                        ncat = R(page).locator('[data-role=cats] > .ip-item').count()
                        if ncat > 1:
                            cb.locator('[data-act=catup]').click(); mark('act:catup')
                            R(page).locator('[data-role=cats] > .ip-item').nth(ncat - 2).locator('[data-act=catdown]').click(); mark('act:catdown')
                        else:
                            mark('act:catup'); mark('act:catdown')
                        R(page).locator('[data-role=heading]').fill('稽核表頭'); mark('act:heading')
                        no_toast(page); R(page).locator('[data-act=save]').click(); mark('act:save')
                        page.wait_for_function("()=>document.querySelector('.toast-stack').innerText.length>0", timeout=10000)
                        toast = page.locator('.toast-stack').inner_text()
                        sc_n = len([c for c in mzt_saved[0]['categories'] if c['role'] == 'scored']) + 1
                        check(('權重' in toast) if sc_n > 1 else ('題目已存檔' in toast), '③ 存檔：%s（%s）' % ('權重不是 100% 擋下' if sc_n > 1 else '存成功', toast.replace('\n', ' ')[:60]))
                        if sc_n == 1:
                            # 存成功 → 版本 v2；再把後端 mzt_saved 的 oracle 不受影響（舊報告快照）
                            check('目前版本 mzt-v2' in R(page).inner_text(), '③ 存檔後版本 mzt-v2')
                            api('inspBankSave', {'brand': 'mzt', 'forms': mzt_saved, 'expected_ver': 'mzt-v2'}, ops_tok)   # 還原（v3），讓後續角色看到原題
                        cb = R(page).locator('[data-role=cats] > .ip-item').last
                        cb.locator('[data-act=catdel]').click(); mark('act:catdel')
                        page.locator('.dialog button', has_text='取消').click()
                        check(R(page).locator('[data-role=cats] > .ip-item').count() == ncat, '③ 刪分類按取消＝沒刪')
                        R(page).locator('[data-role=cats] > .ip-item').last.locator('[data-act=catdel]').click(); confirm(page)
                        check(R(page).locator('[data-role=cats] > .ip-item').count() == ncat - 1, '③ 刪分類')
                        no_toast(page); R(page).locator('[data-act=reload]').click(); mark('act:reload')
                        if page.locator('.dialog').count():
                            confirm(page)
                        page.wait_for_selector('[data-keep=inspection] [data-role=heading]', timeout=10000)
                        page.wait_for_function("()=>document.querySelector('[data-keep=inspection]').innerText.includes('目前版本 mzt-v')", timeout=10000)
                        n_sv = len(mzt_saved[0]['categories'])   # 存成功那次（sc_n==1）已用 API 還原成原題（mzt-v3）
                        check(R(page).locator('[data-role=heading]').input_value() != '稽核表頭', '③ 放棄改動：表頭回到存檔內容')
                        check(R(page).locator('[data-role=cats] > .ip-item').count() == n_sv and '沒有未存的改動' in R(page).inner_text(), '③ 放棄改動：分類數回到存檔的 %d、沒有未存改動' % n_sv)
                        page.screenshot(path=os.path.join(SHOT_DIR, 'insp_4_bank_%d.png' % SEED), full_page=True)
                        # 寫入壞資料（points 0）由 API 擋：
                        bad = json.loads(json.dumps(mzt_saved)); it = next((it for f in bad for c in f['categories'] for it in c['items'] if 'points' in it), None)
                        if it:
                            it['points'] = 0
                            cur = api('inspBankGet', {'brand': 'mzt'}, ops_tok)['data']['ver']
                            check(api('inspBankSave', {'brand': 'mzt', 'forms': bad, 'expected_ver': cur}, ops_tok).get('error') == 'bad_request', '③ 分數 0 → 後端擋下')
                for v in views:
                    page.locator('[data-role=view-nav] [data-view=%s]' % v).click(); mark('view:' + v)
                    page.wait_for_selector('[data-keep=inspection] .ip-wrap')
                check(not page._errs, '③ %s 沒有 JS 錯誤 %s' % (ro['label'], page._errs[:2]))
                ctx.close()

            # ④ 作廢（營運部或執行長）：按取消不作廢 → 確定作廢 → 店長看不到
            voider = rnd.choice([k for k, v in roles.items() if v['void']])
            victim = rnd.choice(records)
            ctx, page = new_page()
            login(page, base, roles[voider]['user'])
            page.goto(base + '/index.html#/inspection/list?id=' + victim['id'])
            page.wait_for_selector('[data-keep=inspection] [data-act=void]')
            page.locator('[data-keep=inspection] [data-act=void]').click(); mark('act:void')
            page.locator('.dialog button', has_text='取消').click()
            check(page.locator('[data-keep=inspection] [data-act=void]').count() == 1, '④ 作廢按取消＝沒作廢')
            page.locator('[data-keep=inspection] [data-act=void]').click(); confirm(page)
            page.wait_for_selector('[data-keep=inspection] [data-role=unit]', timeout=15000)
            page.wait_for_function("()=>!document.querySelector('[data-keep=inspection]').innerText.includes('載入中')", timeout=10000)
            check(victim['id'] not in page.content(), '④ %s 作廢後清單不再列出 %s' % (roles[voider]['label'], victim['id']))
            ctx.close()
            sm_key = {'mala-gf': 'gfSm', 'mala-mc': 'mcSm', 'mzt-gf': 'mztAm'}.get(victim['unit'])
            if sm_key:
                ctx, page = new_page()
                login(page, base, roles[sm_key]['user'])
                page.goto(base + '/index.html#/inspection/list?id=' + victim['id'])
                page.wait_for_function("()=>document.querySelector('[data-keep=inspection]') && document.querySelector('[data-keep=inspection]').innerText.includes('找不到這筆巡檢')", timeout=10000)
                check(True, '④ 作廢後 %s 直打編號也找不到' % roles[sm_key]['label'])
                ctx.close()
            records = [r for r in records if r['id'] != victim['id']]

            # ⑤ 試跑模式＋375 寬
            ctx, page = new_page()
            login(page, base, acc['malaOsv'], '?dryrun=1')
            go(page, base, 'fill', '?dryrun=1')
            page.wait_for_selector('[data-keep=inspection] #ip-unit')
            check('試跑模式' in R(page).inner_text(), '⑤ 試跑模式有提示')
            page.select_option('[data-keep=inspection] #ip-unit', store)
            no_toast(page); page.locator('[data-keep=inspection] [data-act=start]').click()
            page.locator('[data-keep=inspection] [data-k="service.attitude.1"] [data-act=score][data-v="2"]').click()
            no_toast(page); page.locator('[data-keep=inspection] [data-act=submit]').click(); confirm(page)
            page.wait_for_function("()=>document.querySelector('.toast-stack')&&document.querySelector('.toast-stack').innerText.includes('試跑模式')", timeout=10000)
            check(page.locator('[data-keep=inspection] .ip-tab').count() == 4, '⑤ 試跑送出後還停在填寫頁')
            n_before = len([r for r in records if r['unit'] in MALA])
            go(page, base, 'list', '?dryrun=1')
            page.wait_for_selector('[data-keep=inspection] [data-open]', timeout=15000)
            check(R(page).locator('tbody tr').count() == n_before, '⑤ 試跑沒有多寫一筆（%d）' % n_before)
            page.set_viewport_size({'width': 375, 'height': 800})
            go(page, base, 'fill', '?dryrun=1')
            page.wait_for_selector('[data-keep=inspection] [data-act=go]', timeout=15000)
            page.locator('[data-keep=inspection] [data-act=go]').click()
            page.wait_for_selector('[data-keep=inspection] .ip-tab')
            check(no_hscroll(page), '⑤ 375 寬填寫頁沒有橫向捲軸')
            page.screenshot(path=os.path.join(SHOT_DIR, 'insp_5_fill_375_%d.png' % SEED))
            go(page, base, 'list', '?dryrun=1')
            page.locator('[data-keep=inspection] [data-open]').first.click()
            page.wait_for_selector('[data-keep=inspection] [data-act=back]')
            check(no_hscroll(page), '⑤ 375 寬報告頁沒有橫向捲軸')
            page.screenshot(path=os.path.join(SHOT_DIR, 'insp_6_report_375_%d.png' % SEED), full_page=True)
            ctx.close()
            browser.close()
    finally:
        proc.kill()
        httpd.shutdown()

    check(not ALL_LEAKS, '全程沒有打到任何本機以外的網址（擋下 %d 筆：%s）' % (len(ALL_LEAKS), ALL_LEAKS[:3]))
    missing = sorted(k for k in seen if k not in clicked and k not in SKIP)
    check(not missing, '按鈕稽核：出現過的 %d 種按鈕都點過（漏：%s）' % (len(seen), ', '.join('%s@%s' % (k, seen[k]) for k in missing)))
    print('E2E_SEED=%d' % SEED)
    finish()


if __name__ == '__main__':
    main()
