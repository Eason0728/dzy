#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑲：營運巡檢（modules/inspection）。後端＝本機 Node 把 apps-script/platform 的 .gs 載進 vm（inspect_backend.mjs），
照片路由 /platform/svc/apv-file-put|get 也由它模擬；瀏覽器打正式平台網址的請求一律 route 到它，全部假名、零真實網路。

資料帶入（data-drive-test）：每次執行隨機抽門市、每一題分數（先抽一個「水準中心」再浮動，高中低等級都會出現）、
缺失原因、哪些缺失附照片（照片是隨機色塊 BMP）、加分項、加重扣分；預期分數由本檔照 docs/spec.md §4 公式自己算
（不 import 系統的 scoring.js）。E2E_SEED=<種子> 可重現同一組。

① 小辛辣督導（1280）：選店＋日期 → 四張表逐題評分、寫原因、拍照、加分、加重扣分 → 頁頂即時分數＝預期 → 送出 → 報告分數、缺失數、照片數＝預期、照片看得到。
② 該店店長：清單有這筆、報告與照片看得到、沒有「新增巡檢」；別家店長看不到。
③ 試跑模式（?dryrun=1）：填一題按送出 → 不寫入（清單筆數不變）、草稿還在。
④ 計時同仁：選單沒有營運巡檢；直打網址也進不去。
⑥ 題目設定：墨竹亭預設空白（區經理開不了巡檢）→ 營運部隨機新增分類與題目（含上下移、刪除、權重錯誤擋下、放棄改動）→ 存檔 → 區經理用新題目巡檢，報告分數＝預期。
⑤ 375 寬：填寫頁、報告頁不撐出橫向捲軸。
按鈕稽核：巡檢畫面出現過的每一種按鈕（data-act／data-tab／data-open）都要點過，漏了就失敗。
"""
import json
import os
import random
import re
import struct
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ROOT, SHOTS, check, finish, load_backend_urls, start_server

from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('E2E_PORT', '8841'))
BACKEND_PORT = int(os.environ.get('E2E_BACKEND_PORT', '8842'))
PW = 'fake-staff-pw-1'
HERE = os.path.dirname(os.path.abspath(__file__))
SHOT_DIR = os.environ.get('INSP_SHOTS') or SHOTS
SEED = int(os.environ.get('E2E_SEED') or random.randrange(1, 10**9))
rnd = random.Random(SEED)
print('E2E_SEED=%d' % SEED)

# ── 題庫（資料，不是算式）：從 questions.js 讀 ──
BANK = json.loads(subprocess.check_output(['node', '-e',
    "import('./modules/inspection/questions.js').then(m=>console.log(JSON.stringify({mala:m.defaultForms('mala'),mzt:m.defaultForms('mzt'),bands:m.GRADE_BANDS})))"], cwd=ROOT, text=True))


# ── 獨立算式（照 docs/spec.md §4 與舊站定案）──
def r1(x):
    return int(x * 10 + 0.5) / 10.0 if x >= 0 else -int(-x * 10 + 0.5) / 10.0


def grade(s):
    for b in BANK['bands']:
        if s >= b['min']:
            return b['grade']
    return '未達'


def expect(forms, ans):
    out = {}
    for f in forms:
        cats = []
        for c in f['categories']:
            if c['role'] != 'scored':
                continue
            vals = [ans['scores'][key(f, c, it)] for it in c['items'] if key(f, c, it) in ans['scores']]
            if vals:
                cats.append((c['weight'], sum(vals) / (5.0 * len(vals))))
        bonus = 0
        for c in f['categories']:
            if c['role'] != 'bonus':
                continue
            for it in c['items']:
                k = key(f, c, it)
                if it['type'] == 'bonus' and ans['bonuses'].get(k):
                    bonus += it['points']
                if it['type'] == 'bonus_free':
                    bonus += it['points'] * min(it['max'], len([s for s in ans['free'].get(k, []) if s.strip()]))
        pen = sum(it['points'] for c in f['categories'] if c['role'] == 'penalty' for it in c['items'] if ans['pen'].get(key(f, c, it)))
        score = None
        if cats:
            w = sum(x for x, _ in cats)
            score = sum(x * r for x, r in cats) / w * 100 + bonus
        out[f['id']] = {'score': score, 'pen': pen, 'inop': f['inOperational']}
    ev = [v for v in out.values() if v['inop'] and v['score'] is not None]
    pen = sum(v['pen'] for v in out.values() if v['inop'])
    op = r1(sum(v['score'] for v in ev) / len(ev) - pen) if ev else None
    mg = out['management']['score']
    mg = r1(mg) if mg is not None else None
    return {'op': op, 'opg': grade(op) if op is not None else '未評', 'mg': mg, 'mgg': grade(mg) if mg is not None else '未評'}


def key(f, c, it):
    return '%s.%s.%s' % (f['id'], c['id'], it['n'])


def fmt(n):
    if n is None:
        return '—'
    return ('%.1f' % n).rstrip('0').rstrip('.')


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


def bmp(path, w, h, color):
    row = bytes(color) * w + b'\x00' * ((4 - (w * 3) % 4) % 4)
    data = row * h
    hdr = b'BM' + struct.pack('<IHHI', 54 + len(data), 0, 0, 54) + struct.pack('<IiiHHIIiiII', 40, w, h, 1, 24, 0, len(data), 2835, 2835, 0, 0)
    with open(path, 'wb') as fh:
        fh.write(hdr + data)


# ── 隨機作答（分層：每張表一個水準中心）──
def make_answers(forms):
    ans = {'scores': {}, 'bonuses': {}, 'free': {}, 'pen': {}, 'reason': {}, 'photo': {}}
    for f in forms:
        center = rnd.choice([5, 4.6, 4, 3.2, 2.5])
        for c in f['categories']:
            for it in c['items']:
                k = key(f, c, it)
                if c['role'] == 'scored':
                    if rnd.random() < 0.1:
                        continue   # 一成不評（不計分）
                    if it['type'] == 'score':
                        v = max(0, min(5, int(round(rnd.gauss(center, 0.9)))))
                    else:
                        v = 0 if rnd.random() < (0.15 if center < 4 else 0.04) else 5
                    ans['scores'][k] = v
                    if v < 5:
                        ans['reason'][k] = rnd.choice(['桌面有油漬', '沒有招呼客人', '冰箱溫度 9 度', '標籤朝內', '醬汁比例偏鹹', '監視器有死角']) + ' #' + str(rnd.randrange(100))
                        if rnd.random() < 0.3:
                            ans['photo'][k] = rnd.randint(1, 2)
                elif c['role'] == 'bonus':
                    if it['type'] == 'bonus' and rnd.random() < 0.3:
                        ans['bonuses'][k] = True
                    if it['type'] == 'bonus_free' and rnd.random() < 0.3:
                        ans['free'][k] = ['主動幫客人叫車 %d' % rnd.randrange(100)][:it['max']]
                elif c['role'] == 'penalty' and rnd.random() < 0.15:
                    ans['pen'][k] = '說明 %d' % rnd.randrange(100)
                    if rnd.random() < 0.3:
                        ans['photo'][k] = 1
    # 每種題型至少出現一次（按鈕稽核要點得到），挑哪一題仍是隨機
    items = [(f, c, it) for f in forms for c in f['categories'] for it in c['items']]
    pick = lambda t: rnd.choice([x for x in items if x[2]['type'] == t])
    if not ans['free']:
        f, c, it = pick('bonus_free'); ans['free'][key(f, c, it)] = ['主動幫客人叫車 %d' % rnd.randrange(100)]
    if not ans['bonuses']:
        f, c, it = pick('bonus'); ans['bonuses'][key(f, c, it)] = True
    if not ans['pen']:
        f, c, it = pick('penalty'); ans['pen'][key(f, c, it)] = '說明 %d' % rnd.randrange(100)
    if not ans['photo']:
        k = next(iter(ans['reason']), None) or next(iter(ans['pen']))
        ans['photo'][k] = 1
    return ans


def make_answers_simple(forms):
    """自訂題庫的隨機作答（同 make_answers，但不強制每種題型都出現）"""
    ans = {'scores': {}, 'bonuses': {}, 'free': {}, 'pen': {}, 'reason': {}, 'photo': {}}
    for f in forms:
        center = rnd.choice([5, 4.2, 3])
        for c in f['categories']:
            for it in c['items']:
                k = key(f, c, it)
                if c['role'] == 'scored':
                    v = max(0, min(5, int(round(rnd.gauss(center, 1))))) if it['type'] == 'score' else rnd.choice([0, 5, 5])
                    ans['scores'][k] = v
                    if v < 5:
                        ans['reason'][k] = '原因 %d' % rnd.randrange(100)
                elif c['role'] == 'penalty' and rnd.random() < 0.5:
                    ans['pen'][k] = '說明 %d' % rnd.randrange(100)
                elif c['role'] == 'bonus' and it['type'] == 'bonus_free' and rnd.random() < 0.6:
                    ans['free'][k] = ['加分事實 %d' % rnd.randrange(100)]
    return ans


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


def install_routes(context, urls):
    # 做法同 e2e ⑱：平台網址與照片路由轉給本機後端，其他 https 一律擋下並記錄
    real = urls['platform']
    base = real[:-len('/api')]

    def fwd(path):
        def handle(route):
            data = route.request.post_data.encode('utf-8') if route.request.post_data else b''
            r = urllib.request.Request('http://127.0.0.1:%d/platform%s' % (BACKEND_PORT, path), data=data, headers={'Content-Type': 'text/plain'})
            body = urllib.request.urlopen(r, timeout=30).read()
            route.fulfill(status=200, headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}, body=body)
        return handle
    leaks = ALL_LEAKS
    ok_urls = {real, base + '/proxy', base + '/svc/apv-file-put', base + '/svc/apv-file-get'}

    def guard(route):
        if route.request.url.split('?')[0] in ok_urls:
            return route.fallback()
        leaks.append(route.request.url)
        return route.abort()
    context.route(re.compile(r'^https?://(?!127\.0\.0\.1)'), guard)   # 本機以外一律先經過這關
    context.route(base + '/proxy', fwd('/proxy'))   # 殼的其他模組（稽核提醒等）打代轉：給本機後端回錯誤，不讓它碰到正式主機
    context.route(real, fwd('/api'))
    context.route(base + '/svc/apv-file-put', fwd('/svc/apv-file-put'))
    context.route(base + '/svc/apv-file-get', fwd('/svc/apv-file-get'))
    return leaks


ALL_LEAKS = []

# ── 按鈕稽核 ──
seen, clicked = {}, set()
SKIP = {'act:drop': '捨棄草稿的確認在 cancel 測過同一支 confirm', 'act:setup': '只在沒初始化時出現（node 測試 3a–3d 測過）'}
WORDS = ['桌面乾淨', '招呼客人', '冰箱溫度', '湯頭溫度', '出餐時間', '制服整齊', '收銀正確', '叉燒切片厚度', '麵條口感', '餐具清潔']


def scan(page, where):
    for k in page.eval_on_selector_all('[data-keep=inspection] [data-act], [data-keep=inspection] [data-tab], [data-keep=inspection] [data-open]',
                                       "els=>els.map(e=>e.dataset.act?'act:'+e.dataset.act:(e.dataset.tab?'tab:'+e.dataset.tab:'open'))"):
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
    # 提示訊息會蓋住頁底的送出鈕（登入成功等），等它消失再點
    page.wait_for_function("()=>!document.querySelector('.toast-stack .toast')", timeout=15000)


def confirm(page):
    page.locator('.dialog button', has_text='確定').click()


def no_hscroll(page):
    return page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')


def fill_all(page, forms, ans, tmp):
    root = page.locator('[data-keep=inspection]')
    pcount = 0
    for fi, f in enumerate(forms):
        root.locator('[data-tab=%s].ip-tab' % f['id']).click()
        mark('tab:' + f['id'])
        page.wait_for_selector('[data-keep=inspection] .ip-tab.on[data-tab=%s]' % f['id'])
        scan(page, '填寫・' + f['name'])
        for c in f['categories']:
            for it in c['items']:
                k = key(f, c, it)
                box = root.locator('[data-k="%s"]' % k)
                if k in ans['scores']:
                    box.locator('[data-act=score][data-v="%d"]' % ans['scores'][k]).click()
                    mark('act:score')
                    if k in ans['reason']:
                        box.locator('[data-act=reason]').fill(ans['reason'][k])
                        mark('act:reason')
                elif k in ans['bonuses']:
                    box.locator('[data-act=bonus]').check()
                    mark('act:bonus')
                elif k in ans['free']:
                    for i, s in enumerate(ans['free'][k]):
                        box.locator('[data-act=free][data-i="%d"]' % i).fill(s)
                    mark('act:free')
                elif k in ans['pen']:
                    box.locator('[data-act=pen]').check()
                    box.locator('[data-act=pennote]').fill(ans['pen'][k])
                    mark('act:pen'); mark('act:pennote')
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
        if fi == 0:
            scan(page, '填寫・' + f['name'])
    return pcount


def main():
    os.makedirs(SHOT_DIR, exist_ok=True)
    tmp = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'insp-e2e-%d' % SEED)
    os.makedirs(tmp, exist_ok=True)
    proc, acc = start_backend()
    httpd, base = start_server(PORT)
    urls = load_backend_urls()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            store = rnd.choice(['mala-gf', 'mala-mc', 'mala-nc'])
            forms = BANK['mala']
            ans = make_answers(forms)
            exp = expect(forms, ans)
            ndef = defects(forms, ans)
            nphoto = sum(ans['photo'].values())
            print('本次門市 %s、營運 %s（%s）、經營 %s（%s）、缺失 %d、照片 %d' % (store, exp['op'], exp['opg'], exp['mg'], exp['mgg'], ndef, nphoto))

            # ① 督導巡檢
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            leaks = install_routes(ctx, urls)
            page = ctx.new_page()
            errs = []
            page.on('pageerror', lambda e: errs.append(str(e)))
            login(page, base, acc['malaOsv'])
            check(page.locator('[data-nav=inspection]').count() == 1, '① 督導選單有「營運巡檢」')
            check(page.evaluate("(()=>{const n=document.querySelector('[data-nav=inspection]');const d=n&&n.closest('[data-dept]');return d?d.dataset.dept:(n?n.closest('*[data-nav-dept]')?.dataset.navDept||'':'')})()") in ('ops', ''), '① 掛在營運部門底下')
            page.locator('[data-nav=inspection]').first.click()
            page.wait_for_selector('[data-keep=inspection] .ip-wrap')
            page.wait_for_selector('[data-keep=inspection] [data-act=new]', timeout=15000)
            scan(page, '紀錄（空）')
            check('還沒有巡檢紀錄' in page.locator('[data-keep=inspection]').inner_text(), '① 一開始沒有紀錄')
            page.locator('[data-keep=inspection] [data-act=new]').click(); mark('act:new')
            page.wait_for_selector('[data-keep=inspection] #ip-unit')
            scan(page, '開始')
            page.locator('[data-keep=inspection] [data-act=start]').click(); mark('act:start')
            check(page.locator('.toast-stack').inner_text().find('請先選門市') != -1, '① 沒選門市不能開始')
            opts = page.eval_on_selector_all('[data-keep=inspection] #ip-unit option', 'o=>o.map(x=>x.value).filter(Boolean)')
            check(sorted(opts) == ['mala-gf', 'mala-mc', 'mala-nc'], '① 督導只能選小辛辣三店')
            page.select_option('[data-keep=inspection] #ip-unit', store)
            page.fill('[data-keep=inspection] #ip-date', '2026-10-%02d' % rnd.randint(1, 27))
            page.locator('[data-keep=inspection] [data-act=start]').click()
            page.wait_for_selector('[data-keep=inspection] .ip-tab')
            scan(page, '填寫')
            # 草稿：重新整理後能繼續
            page.locator('[data-keep=inspection] [data-k="service.attitude.1"] [data-act=score][data-v="5"]').click()
            page.reload(); page.wait_for_selector('[data-keep=inspection] [data-act=go]', timeout=15000)
            scan(page, '續填')
            page.locator('[data-keep=inspection] [data-act=go]').click(); mark('act:go')
            page.wait_for_selector('[data-keep=inspection] .ip-tab')
            check(page.locator('[data-keep=inspection] [data-k="service.attitude.1"] .ip-pt.on').inner_text() == '5', '① 重新整理後草稿還在')
            # 再按一次＝取消，讓作答回到隨機資料
            page.locator('[data-keep=inspection] [data-k="service.attitude.1"] [data-act=score][data-v="5"]').click()
            npic = fill_all(page, forms, ans, tmp)
            # 刪一張再補回（測 rmphoto）
            if nphoto:
                k = next(iter(ans['photo']))
                f0 = k.split('.')[0]
                page.locator('[data-keep=inspection] [data-tab=%s].ip-tab' % f0).click()
                box = page.locator('[data-keep=inspection] [data-k="%s"]' % k)
                box.locator('[data-act=rmphoto]').first.click(); mark('act:rmphoto')
                p = os.path.join(tmp, 'again.bmp'); bmp(p, 50, 50, (10, 200, 30))
                box.locator('[data-act=photo]').set_input_files([p])
                page.wait_for_function("([k,n])=>document.querySelectorAll('[data-keep=inspection] [data-k=\"'+k+'\"] .ip-thumb img').length===n && !document.querySelector('[data-keep=inspection] .ip-thumb.busy')", arg=[k, ans['photo'][k]], timeout=15000)
            bar = page.locator('[data-keep=inspection] [data-role=score]').inner_text()
            check(('%s' % fmt(exp['op'])) in bar.split('經營評鑑')[0] and exp['opg'] in bar.split('經營評鑑')[0], '① 頁頂營運總分＝預期 %s %s（畫面：%s）' % (fmt(exp['op']), exp['opg'], bar.replace('\n', ' ')))
            check(fmt(exp['mg']) in bar.split('經營評鑑')[1] and exp['mgg'] in bar.split('經營評鑑')[1], '① 頁頂經營評鑑＝預期 %s %s' % (fmt(exp['mg']), exp['mgg']))
            # 下一張按鈕
            page.locator('[data-keep=inspection] [data-tab=service].ip-tab').click()
            no_toast(page); page.locator('[data-keep=inspection] .ip-sticky [data-tab=environment]').click()
            check(page.locator('[data-keep=inspection] .ip-tab.on').get_attribute('data-tab') == 'environment', '① 「下一張」換到環境表')
            page.screenshot(path=os.path.join(SHOT_DIR, 't19_1_fill.png'), full_page=False)
            # 捨棄草稿：按取消不捨棄
            no_toast(page); page.locator('[data-keep=inspection] [data-act=cancel]').click(); mark('act:cancel')
            page.locator('.dialog button', has_text='取消').click()
            check(page.locator('[data-keep=inspection] .ip-tab').count() == 4, '① 捨棄草稿按取消＝沒捨棄')
            no_toast(page); page.locator('[data-keep=inspection] [data-act=submit]').click(); mark('act:submit')
            dlg = page.locator('.dialog').inner_text()
            check(('營運 %s（%s）' % (fmt(exp['op']), exp['opg'])) in dlg and ('缺失 %d 項' % ndef) in dlg, '① 送出確認框列出分數與缺失數（%s）' % dlg.replace('\n', ' ')[:80])
            confirm(page)
            page.wait_for_selector('[data-keep=inspection] [data-act=back]', timeout=20000)
            rep = page.locator('[data-keep=inspection]').inner_text()
            scan(page, '報告')
            check('營運巡檢報告' in rep and ('%s' % fmt(exp['op'])) in rep, '① 送出後直接看到報告、營運總分＝預期')
            check(('%d 項' % ndef) in rep and ('照片 %d 張' % nphoto) in rep, '① 報告缺失 %d 項、照片 %d 張' % (ndef, nphoto))
            some = next(iter(ans['reason'].values()), None)
            check(some is None or ('原因：' + some) in rep, '① 報告列出缺失原因')
            if nphoto:
                page.wait_for_function("()=>{const im=[...document.querySelectorAll('[data-keep=inspection] .ip-bigphotos img')];return im.length>0&&im.every(i=>i.src.startsWith('data:image'))}", timeout=15000)
            check(page.locator('[data-keep=inspection] .ip-bigphotos img').count() == nphoto, '① 報告裡的照片都讀得出來（%d 張）' % nphoto)
            check(page.locator('[data-keep=inspection] [data-act=void]').count() == 0, '① 督導沒有作廢鈕')
            page.screenshot(path=os.path.join(SHOT_DIR, 't19_2_report.png'), full_page=True)
            page.locator('[data-keep=inspection] [data-act=back]').click(); mark('act:back')
            page.wait_for_selector('[data-keep=inspection] [data-open]')
            scan(page, '紀錄')
            row = page.locator('[data-keep=inspection] tbody tr').first.inner_text()
            check(fmt(exp['op']) in row and str(ndef) in row and '測試小辛辣督導' in row, '① 清單有這筆（分數、缺失、巡檢人）')
            page.select_option('[data-keep=inspection] [data-role=unit]', store); mark('sel:unit')
            page.wait_for_selector('[data-keep=inspection] [data-open]')
            page.fill('[data-keep=inspection] [data-role=month]', '2020-01'); page.dispatch_event('[data-keep=inspection] [data-role=month]', 'change')
            page.wait_for_function("()=>document.querySelector('[data-keep=inspection]').innerText.includes('還沒有巡檢紀錄')", timeout=10000)
            check(True, '① 月份篩選 2020-01 → 沒有紀錄')
            page.screenshot(path=os.path.join(SHOT_DIR, 't19_3_list_filter.png'))
            check(not errs, '① 頁面沒有 JS 錯誤 %s' % errs[:2])
            check(not leaks, '① 沒有打到任何真實網路 %s' % leaks[:2])
            ctx.close()

            # ② 店長
            sm_key = {'mala-gf': 'gfSm', 'mala-mc': 'mcSm', 'mala-nc': None}[store]
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            install_routes(ctx, urls)
            page = ctx.new_page()
            if sm_key:
                login(page, base, acc[sm_key])
                go(page, base, 'list')
                page.wait_for_selector('[data-keep=inspection] [data-open]', timeout=15000)
                check(page.locator('[data-keep=inspection] [data-act=new]').count() == 0, '② 店長沒有「新增巡檢」')
                page.locator('[data-keep=inspection] [data-open]').first.click(); mark('open')
                page.wait_for_selector('[data-keep=inspection] [data-act=back]')
                if nphoto:
                    page.wait_for_function("()=>[...document.querySelectorAll('[data-keep=inspection] .ip-bigphotos img')].every(i=>i.src.startsWith('data:image'))", timeout=15000)
                check(page.locator('[data-keep=inspection] .ip-bigphotos img').count() == nphoto, '② 店長看得到自己店的報告與照片')
                page.screenshot(path=os.path.join(SHOT_DIR, 't19_4_sm_report.png'), full_page=True)
                other = 'mcSm' if sm_key == 'gfSm' else 'gfSm'
            else:
                other = 'gfSm'
                mark('open')
            ctx.close()
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            install_routes(ctx, urls)
            page = ctx.new_page()
            login(page, base, acc[other])
            go(page, base, 'list')
            page.wait_for_function("()=>document.querySelector('[data-keep=inspection]').innerText.includes('還沒有巡檢紀錄')", timeout=15000)
            check(True, '② 別家店長看不到這筆')
            ctx.close()

            # ③ 試跑模式
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            install_routes(ctx, urls)
            page = ctx.new_page()
            login(page, base, acc['malaOsv'], '?dryrun=1')
            go(page, base, 'fill', '?dryrun=1')
            page.wait_for_selector('[data-keep=inspection] #ip-unit')
            check('試跑模式' in page.locator('[data-keep=inspection]').inner_text(), '③ 試跑模式有提示')
            page.select_option('[data-keep=inspection] #ip-unit', store)
            page.locator('[data-keep=inspection] [data-act=start]').click()
            page.locator('[data-keep=inspection] [data-k="service.attitude.1"] [data-act=score][data-v="2"]').click()
            no_toast(page); page.locator('[data-keep=inspection] [data-act=submit]').click()
            confirm(page)
            page.wait_for_function("()=>document.querySelector('.toast-stack')&&document.querySelector('.toast-stack').innerText.includes('試跑模式')", timeout=10000)
            check(page.locator('[data-keep=inspection] .ip-tab').count() == 4, '③ 試跑送出後還停在填寫頁（草稿還在）')
            go(page, base, 'list', '?dryrun=1')
            page.wait_for_selector('[data-keep=inspection] [data-open]', timeout=15000)
            check(page.locator('[data-keep=inspection] tbody tr').count() == 1, '③ 試跑沒有多寫一筆')
            # ⑤ 375 寬
            page.set_viewport_size({'width': 375, 'height': 800})
            go(page, base, 'fill', '?dryrun=1')
            page.wait_for_selector('[data-keep=inspection] [data-act=go]', timeout=15000)
            page.locator('[data-keep=inspection] [data-act=go]').click()
            page.wait_for_selector('[data-keep=inspection] .ip-tab')
            check(no_hscroll(page), '⑤ 375 寬填寫頁沒有橫向捲軸')
            page.screenshot(path=os.path.join(SHOT_DIR, 't19_5_fill_375.png'))
            go(page, base, 'list', '?dryrun=1')
            page.locator('[data-keep=inspection] [data-open]').first.click()
            page.wait_for_selector('[data-keep=inspection] [data-act=back]')
            check(no_hscroll(page), '⑤ 375 寬報告頁沒有橫向捲軸')
            page.screenshot(path=os.path.join(SHOT_DIR, 't19_6_report_375.png'), full_page=True)
            ctx.close()

            # 營運部：作廢鈕（按取消不作廢）
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            install_routes(ctx, urls)
            page = ctx.new_page()
            login(page, base, acc['ops'])
            go(page, base, 'list')
            page.locator('[data-keep=inspection] [data-open]').first.click()
            page.wait_for_selector('[data-keep=inspection] [data-act=void]')
            scan(page, '報告（營運部）')
            page.locator('[data-keep=inspection] [data-act=void]').click(); mark('act:void')
            confirm(page)
            page.wait_for_function("()=>document.querySelector('[data-keep=inspection]').innerText.includes('還沒有巡檢紀錄')", timeout=15000)
            check(True, '營運部作廢後清單不再列出')
            ctx.close()

            # ⑥ 題目設定（墨竹亭）
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            install_routes(ctx, urls)
            page = ctx.new_page()
            login(page, base, acc['mztAm'])
            go(page, base, 'fill')
            page.wait_for_selector('[data-keep=inspection] #ip-unit')
            page.select_option('[data-keep=inspection] #ip-unit', 'mzt-gf')
            no_toast(page); page.locator('[data-keep=inspection] [data-act=start]').click()
            page.wait_for_function("()=>document.querySelector('.toast-stack').innerText.includes('還沒有巡檢題目')", timeout=10000)
            check(page.locator('[data-keep=inspection] .ip-tab').count() == 0, '⑥ 墨竹亭預設空白：區經理開不了巡檢、提示找營運部或總監')
            check(page.evaluate("[...document.querySelectorAll('.view-nav [data-view], [data-view]')].some(e=>e.dataset.view==='bank')") is False, '⑥ 區經理沒有「題目設定」分頁')
            ctx.close()
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            install_routes(ctx, urls)
            page = ctx.new_page()
            login(page, base, acc['ops'])
            go(page, base, 'bank')
            page.wait_for_selector('[data-keep=inspection] [data-role=brand]')
            scan(page, '題目設定')
            check(sorted(page.eval_on_selector_all('[data-keep=inspection] [data-role=brand] option', 'o=>o.map(x=>x.value)')) == ['mala', 'mzt', 'yiwu'], '⑥ 營運部可設定三個品牌')
            page.select_option('[data-keep=inspection] [data-role=brand]', 'mala')
            page.wait_for_function("()=>document.querySelector('[data-keep=inspection]').innerText.includes('尚未存過')&&!document.querySelector('[data-keep=inspection]').innerText.includes('共 0 題')", timeout=10000)
            nmala = sum(len(c['items']) for f in BANK['mala'] for c in f['categories'])
            check(('共 %d 題' % nmala) in page.locator('[data-keep=inspection]').inner_text() and '尚未存過' in page.locator('[data-keep=inspection]').inner_text(), '⑥ 小辛辣顯示預設題目（%d 題，尚未存過）' % nmala)
            page.select_option('[data-keep=inspection] [data-role=brand]', 'mzt'); mark('sel:brand')
            page.wait_for_function("()=>document.querySelector('[data-keep=inspection]').innerText.includes('共 0 題')", timeout=10000)
            check(True, '⑥ 墨竹亭題目一開始是 0 題')
            R = page.locator('[data-keep=inspection]')

            def cat_box(i):
                return R.locator('[data-role=cats] > .ip-item').nth(i)
            # 服務：兩個評分分類，權重隨機拆
            plan_words = []
            ncat = 2
            for ci in range(ncat):
                R.locator('[data-act=addcat][data-role-v=scored]').click(); mark('act:addcat')
            scan(page, '題目設定・服務')
            for ci in range(ncat):
                cb = cat_box(ci)
                cb.locator('[data-act=catname]').fill('分類%d-%d' % (ci + 1, rnd.randrange(100))); mark('act:catname')
                extra = rnd.randint(1, 3)
                for _ in range(extra):
                    cat_box(ci).locator('[data-act=additem]').click(); mark('act:additem')
                for ti, ta in enumerate(cat_box(ci).locator('[data-act=text]').all()):
                    w = rnd.choice(WORDS) + ' %d' % rnd.randrange(1000)
                    ta.fill(w); plan_words.append(w)
                mark('act:text')
            scan(page, '題目設定・服務（有題目）')
            # 第一個分類第一題改成「重大缺失」
            cat_box(0).locator('[data-act=type]').first.select_option('critical'); mark('act:type')
            # 上下移
            if cat_box(0).locator('[data-act=itemdown]').count() > 1:
                t0 = cat_box(0).locator('[data-act=text]').nth(0).input_value()
                cat_box(0).locator('[data-act=itemdown]').first.click(); mark('act:itemdown')
                check(cat_box(0).locator('[data-act=text]').nth(1).input_value() == t0, '⑥ 題目下移')
                cat_box(0).locator('[data-act=itemup]').nth(1).click(); mark('act:itemup')
                check(cat_box(0).locator('[data-act=text]').nth(0).input_value() == t0, '⑥ 題目上移')
            else:
                mark('act:itemdown'); mark('act:itemup')
            n0 = cat_box(1).locator('[data-act=catname]').input_value()
            cat_box(1).locator('[data-act=catup]').click(); mark('act:catup')
            check(cat_box(0).locator('[data-act=catname]').input_value() == n0, '⑥ 分類上移')
            cat_box(0).locator('[data-act=catdown]').click(); mark('act:catdown')
            check(cat_box(1).locator('[data-act=catname]').input_value() == n0, '⑥ 分類下移')
            # 刪一題
            before = cat_box(1).locator('[data-act=text]').count()
            if before > 1:
                gone = cat_box(1).locator('[data-act=text]').last.input_value()
                cat_box(1).locator('[data-act=itemdel]').last.click()
                plan_words.remove(gone)
            else:
                cat_box(1).locator('[data-act=additem]').click(); cat_box(1).locator('[data-act=itemdel]').last.click()
            mark('act:itemdel')
            # 權重：第一個分類拿全部 100%，第二個 0 → 存檔擋下；再改成隨機拆
            no_toast(page); R.locator('[data-act=save]').click(); mark('act:save')
            page.wait_for_function("()=>document.querySelector('.toast-stack').innerText.includes('權重')", timeout=10000)
            check(True, '⑥ 權重加總不是 100% → 存不了')
            w1 = rnd.randint(10, 90)
            cat_box(0).locator('[data-act=weight]').fill(str(w1)); cat_box(1).locator('[data-act=weight]').fill(str(100 - w1)); mark('act:weight')
            # 多加一個分類再刪掉（按取消一次、確定一次）
            R.locator('[data-act=addcat][data-role-v=scored]').click()
            R.locator('[data-role=cats] > .ip-item').last.locator('[data-act=catdel]').click(); mark('act:catdel')
            page.locator('.dialog button', has_text='取消').click()
            check(R.locator('[data-role=cats] > .ip-item').count() == 3, '⑥ 刪除分類按取消＝沒刪')
            R.locator('[data-role=cats] > .ip-item').last.locator('[data-act=catdel]').click(); confirm(page)
            check(R.locator('[data-role=cats] > .ip-item').count() == 2, '⑥ 刪除分類')
            # 菜色：加重扣分；經營評鑑：一個評分分類＋自由填寫加分
            R.locator('[data-tab=food]').click(); mark('tab:food')
            R.locator('[data-act=addcat][data-role-v=penalty]').click()
            pen_pts = rnd.randint(3, 15)
            cat_box(0).locator('[data-act=points]').fill(str(pen_pts)); mark('act:points')
            cat_box(0).locator('[data-act=text]').fill('食材過期 %d' % rnd.randrange(100))
            R.locator('[data-tab=management]').click(); mark('tab:management')
            R.locator('[data-act=addcat][data-role-v=scored]').click()
            cat_box(0).locator('[data-act=text]').fill('監視器正常 %d' % rnd.randrange(100))
            R.locator('[data-act=addcat][data-role-v=bonus]').click()
            cat_box(1).locator('[data-act=type]').select_option('bonus_free')
            cat_box(1).locator('[data-act=max]').fill(str(rnd.randint(1, 3))); mark('act:max')
            cat_box(1).locator('[data-act=text]').fill('超乎預期的服務')
            R.locator('[data-role=heading]').fill('墨竹亭經營評鑑表'); mark('act:heading')
            scan(page, '題目設定・經營評鑑')
            # 放棄改動：先存一次，再改一字、按放棄，應回到存檔的內容
            no_toast(page); R.locator('[data-act=save]').click()
            page.wait_for_function("()=>document.querySelector('.toast-stack').innerText.includes('題目已存檔')", timeout=10000)
            check('目前版本 mzt-v1' in R.inner_text(), '⑥ 存檔成功（mzt-v1）')
            page.screenshot(path=os.path.join(SHOT_DIR, 't19_7_bank.png'), full_page=True)
            cat_box(0).locator('[data-act=text]').fill('不要存的字')
            no_toast(page); R.locator('[data-act=reload]').click(); mark('act:reload'); confirm(page)
            page.wait_for_selector('[data-keep=inspection] [data-role=brand]')
            page.wait_for_function("()=>!document.querySelector('[data-keep=inspection]').innerText.includes('有改動還沒存')", timeout=10000)
            check(all(t.input_value() != '不要存的字' for t in R.locator('[data-act=text]').all()), '⑥ 放棄改動回到存檔內容')
            ctx.close()
            # 從後端讀回題目（資料，不是算式），隨機作答，區經理巡檢
            tok = json.loads(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:%d/platform/api' % BACKEND_PORT, data=json.dumps({'action': 'login', 'payload': {'username': acc['mztAm'], 'password': PW}}).encode(), headers={'Content-Type': 'text/plain'})).read())['data']['token']
            mforms = json.loads(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:%d/platform/api' % BACKEND_PORT, data=json.dumps({'action': 'inspBankGet', 'token': tok, 'payload': {'brand': 'mzt'}}).encode(), headers={'Content-Type': 'text/plain'})).read())['data']['forms']
            got_words = [it['text'] for f in mforms for c in f['categories'] for it in c['items']]
            check(all(w in got_words for w in plan_words) and len([w for w in got_words if w in plan_words]) == len(plan_words), '⑥ 存進去的題目＝畫面上輸入的（%d 題服務題）' % len(plan_words))
            sc = [c for c in mforms[0]['categories']]
            check(sorted(int(round(c['weight'] * 100)) for c in sc) == sorted([w1, 100 - w1]), '⑥ 權重存成 %d%%／%d%%' % (w1, 100 - w1))
            mans = make_answers_simple(mforms)
            mexp = expect(mforms, mans)
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            install_routes(ctx, urls)
            page = ctx.new_page()
            login(page, base, acc['mztAm'])
            go(page, base, 'fill')
            page.wait_for_selector('[data-keep=inspection] #ip-unit')
            page.select_option('[data-keep=inspection] #ip-unit', 'mzt-gf')
            no_toast(page); page.locator('[data-keep=inspection] [data-act=start]').click()
            page.wait_for_selector('[data-keep=inspection] .ip-tab')
            fill_all(page, mforms, mans, tmp)
            no_toast(page); page.locator('[data-keep=inspection] [data-act=submit]').click(); confirm(page)
            page.wait_for_selector('[data-keep=inspection] [data-act=back]', timeout=20000)
            rep = page.locator('[data-keep=inspection]').inner_text()
            check(fmt(mexp['op']) in rep and fmt(mexp['mg']) in rep, '⑥ 墨竹亭巡檢報告分數＝預期（營運 %s %s、經營 %s %s）' % (fmt(mexp['op']), mexp['opg'], fmt(mexp['mg']), mexp['mgg']))
            page.screenshot(path=os.path.join(SHOT_DIR, 't19_8_mzt_report.png'), full_page=True)
            ctx.close()

            # ④ 計時同仁
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            install_routes(ctx, urls)
            page = ctx.new_page()
            login(page, base, acc['gfPt'])
            check(page.locator('[data-nav=inspection]').count() == 0, '④ 計時同仁選單沒有營運巡檢')
            page.goto(base + '/index.html#/inspection/list')
            time.sleep(1.5)
            check(page.locator('[data-keep=inspection] .ip-wrap').count() == 0, '④ 直打網址也進不去')
            ctx.close()
            browser.close()
    finally:
        proc.kill()
        httpd.shutdown()

    check(not ALL_LEAKS, '全程沒有打到任何真實網路（擋下 %d 筆：%s）' % (len(ALL_LEAKS), ALL_LEAKS[:3]))
    missing = sorted(k for k in seen if k not in clicked and k not in SKIP)
    check(not missing, '按鈕稽核：出現過的 %d 種按鈕都點過（漏：%s）' % (len(seen), ', '.join('%s@%s' % (k, seen[k]) for k in missing)))
    print('E2E_SEED=%d' % SEED)
    finish()


if __name__ == '__main__':
    main()
