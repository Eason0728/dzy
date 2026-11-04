#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ㉒：損益試算原生化 — 儀表板（T14）。真的損益後端（pnl_backend.mjs，埠 18921）＋站台埠 8831，零真實資料。
驗：三種權限（admin／write／read）都能開；read 看不到其他分頁；沒有登入框；六列的數字與後端 getMonth 一致；
12 個月走勢（實線／斷線／空心）；門市／月份切換；全部門市（品牌篩選、圖例隱藏、超過 6 條先畫 6 條）；
本月待補連結；手機寬 375；每顆按鈕都點過。"""
import json
import os
import subprocess
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import USERS, MockBackend, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT, BPORT = 8831, 18921
KEEP = '[data-keep="pnl"]'
KEY = 'test-dzy-key-0123456789abcdef'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def backend(inner, payload, level='admin'):
    body = {'action': 'dzyProxy', 'key': KEY, 'level': level, 'account': 'E2E', 'operator': 'e2e', 'inner': inner, 'payload': payload}
    req = urllib.request.Request('http://127.0.0.1:%d/pnl/api' % BPORT, data=json.dumps(body).encode(), headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode())


def money(n):
    r = int(abs(n) + 0.5)
    s = '{:,}'.format(r)
    return ('−' + s) if n < 0 and r else s


def main():
    proc = subprocess.Popen(['node', os.path.join(ROOT, 'test/e2e/pnl_backend.mjs'), str(BPORT)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    httpd = None
    try:
        for line in proc.stdout:
            if line.startswith('READY'):
                break
        else:
            raise SystemExit('損益後端沒有起來')
        os.environ['PNL_RUNNER'] = 'http://127.0.0.1:%d/pnl/api' % BPORT
        httpd, base = start_server(PORT)
        mock = MockBackend(base)
        mk = lambda name, perms: {'password': 'e2e-pw', 'perms': perms, 'user': {'id': 'u-' + name, 'name': name, 'role': 'staff', 'node': ''}}
        USERS['pnladm'] = mk('損益管理者', ['platform.self', 'pnl.admin'])
        USERS['pnlwr'] = mk('損益填寫者', ['platform.self', 'pnl.write'])
        USERS['pnlrd'] = mk('損益檢視者', ['platform.self', 'pnl.read'])

        orig_proxy = mock.proxy
        mock.many = False       # True：getSettings 補到 8 家店、getTrendMulti 補齊各店資料（測圖例與品牌篩選）
        mock.fake_est = False   # True：S01 getMonth 帶人事估算、getTrend 前面幾個月也有資料（測連線與空心點）
        mock.fail = False       # True：getMonth 回錯誤（測重新整理鈕）
        mock.fake_pending = 0   # >0：getMonth 單店 S01 的待補清單塞這麼多項（測「前往填資料」）

        def hooked(body):
            act = body.get('action')
            want_ids = []
            if mock.many and act == 'getTrendMulti':   # 後端只認真的店；多出來的假店由下面補資料
                want_ids = list(body['payload']['store_ids'])
                body['payload']['store_ids'] = [x for x in want_ids if x in ('S01', 'S02')]
            status, resp = orig_proxy(body)
            if mock.fail and act == 'getMonth':
                return 200, {'ok': False, 'error': 'BUSY', 'data': {'message': '假的忙碌'}}
            inner = resp.get('data') if isinstance(resp, dict) else None
            if not isinstance(inner, dict) and not isinstance(inner, list):
                return status, resp
            payload = body.get('payload') or {}
            if mock.many and act == 'getSettings':
                st = inner['stores']
                for i in range(3, 9):
                    st.append({'store_id': 'S%02d' % i, 'name': '測試店%d' % i, 'brand': '墨竹亭' if i % 2 else '小辛辣'})
                for x in st[:2]:
                    x['brand'] = '小辛辣'
                inner['can_see_all'] = True
            elif mock.many and act == 'getTrendMulti':
                rows = inner['stores'].get('S01', [])
                for sid in want_ids:
                    if sid not in inner['stores']:
                        inner['stores'][sid] = [dict(r, blocks={k: v * (1 + 0.1 * len(sid)) for k, v in r['blocks'].items()}) for r in rows]
            elif mock.fake_est and act == 'getTrend' and payload.get('store_id') == 'S01' and isinstance(inner, list):
                aug = [r for r in inner if r['month'] == '2026-08'][0]
                for r in inner:
                    if r['month'] in ('2026-05', '2026-06', '2026-07'):
                        r.update(status='定稿', has_entries=True, blocks={k: v * 0.8 for k, v in aug['blocks'].items()}, net_profit=aug['net_profit'] * 0.8)
            elif mock.fake_est and act == 'getMonth' and payload.get('store_id') == 'S01' and isinstance(inner.get('result'), dict):
                inner['result']['estimates'] = {'A1': 100}
                inner['result']['estimate_basis'] = {'label': '近三月平均'}
            elif mock.fake_pending and act == 'getMonth' and payload.get('store_id') == 'S01' and isinstance(inner.get('result'), dict):
                inner['result']['pending'] = [{'acc_id': 'X%d' % i} for i in range(mock.fake_pending)]
            return status, resp
        mock.proxy = hooked

        exp = backend('getMonth', {'store_id': 'S01', 'month': '2026-08'})['data']
        res = exp['result']
        rev = res['blocks']['營收']
        food = res['blocks'].get('食材', 0) + res['blocks'].get('包材', 0)
        n_pending = len(res['pending'])
        trend = backend('getTrend', {'store_id': 'S01', 'month': '2026-08', 'n': 12})['data']
        has_months = [r['month'] for r in trend if r.get('has_entries')]
        check(rev > 0 and has_months == ['2026-08'], '後端資料前提：S01 只有 2026-08 有明細、營收 %s、待補 %d 項（%s）' % (rev, n_pending, has_months))

        with sync_playwright() as p:
            browser = p.chromium.launch()

            def new_page(w=1280, h=900):
                c = browser.new_context(viewport={'width': w, 'height': h})
                pg = c.new_page()
                mock.install(pg)
                pg.goto(base + '/index.html')
                return pg

            def do_login(pg, user):
                pg.fill('#login-username', user)
                pg.fill('#login-password', USERS[user]['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)

            def open_dash(pg, user):
                do_login(pg, user)
                pg.click('[data-nav="pnl"]')
                pg.wait_for_selector(KEEP + ' [data-role="pnl-metric"]', timeout=20000)

            def no_login_form(pg, label):
                check(pg.locator('input[type=password]').count() == 0 or not pg.locator('input[type=password]').first.is_visible(), '%s：畫面沒有登入表單' % label)

            def pick(pg, store=None, month=None):
                if store:
                    pg.select_option(KEEP + ' [data-role="pnl-store"]', store)
                if month:
                    pg.select_option(KEEP + ' [data-role="pnl-month"]', month)
                pg.wait_for_selector(KEEP + ' [data-role="pnl-metric"]', timeout=20000)
                pg.wait_for_function("() => !document.querySelector('[data-keep=pnl] [data-role=pnl-skeleton]')", timeout=20000)

            def vals(pg):
                return {m: pg.locator(KEEP + ' [data-metric="%s"][data-role="pnl-metric"] [data-role="pnl-metric-value"]' % m).inner_text() for m in ['revenue', 'net', 'food', 'labor', 'controllable', 'uncontrollable']}

            # ====== ① admin：讀取骨架、六列、數字 ======
            pg = new_page()
            do_login(pg, 'pnladm')
            pg.click('[data-nav="pnl"]')
            pg.wait_for_selector(KEEP + ' [data-role="pnl-skeleton"], ' + KEEP + ' [data-role="pnl-loading"], ' + KEEP + ' [data-role="pnl-metric"]', timeout=20000)
            pg.wait_for_selector(KEEP + ' [data-role="pnl-metric"]', timeout=20000)
            names = [x.replace('\n', '') for x in pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(names == ['儀表板', '待補', '食材', '人事', '可控', '不可控', '營業收入', '匯入', '設定'], 'admin 頁頂九個分頁：%s' % names)
            no_login_form(pg, 'admin 儀表板')
            opts = pg.locator(KEEP + ' [data-role="pnl-store"] option').all_inner_texts()
            check(opts[0] == '全部門市' and len(opts) == 3, '門市選單：全部門市＋兩家店（%s）' % opts)
            check(pg.locator(KEEP + ' [data-role="pnl-month"]').input_value() == pg.evaluate("() => { const d = new Date(Date.now() + 8*3600*1000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0'); }"), '月份預設本月')
            pg.screenshot(path='/tmp/pnl-dash-admin-all.png')

            # 切到光復＋2026-08
            sid_s01 = [o for o in pg.locator(KEEP + ' [data-role="pnl-store"] option').all() if o.inner_text() != '全部門市'][0].get_attribute('value')
            check(sid_s01 == 'S01', '第一家店是 S01：%s' % sid_s01)
            pick(pg, 'S01', '2026-08')
            keys = [m.get_attribute('data-metric') for m in pg.locator(KEEP + ' [data-role="pnl-metric"]').all()]
            check(keys == ['revenue', 'net', 'food', 'labor', 'controllable', 'uncontrollable'], '六列順序：%s' % keys)
            v = vals(pg)
            check(v['revenue'] == 'NT$ ' + money(rev), '營業額 = 後端 %s：%s' % (money(rev), v['revenue']))
            check(v['food'] == 'NT$ ' + money(food), '食材費用（含包材）= 後端 %s：%s' % (money(food), v['food']))
            check(v['net'] == 'NT$ ' + money(res['net_profit']), '稅後淨利 = 後端 %s：%s' % (money(res['net_profit']), v['net']))
            check(v['labor'] == 'NT$ ' + money(res['blocks'].get('人事', 0)) and v['controllable'] == 'NT$ ' + money(res['blocks'].get('可控', 0)) and v['uncontrollable'] == 'NT$ ' + money(res['blocks'].get('不可控', 0)), '人事／可控／不可控數字與後端一致：%s' % v)
            pct = pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-metric-pct"]').inner_text()
            check(pct == '佔營收 100.0%', '營業額佔營收 100.0%%：%s' % pct)
            fp = pg.locator(KEEP + ' [data-metric="food"][data-role="pnl-metric"] [data-role="pnl-metric-pct"]').inner_text()
            check(fp == '佔營收 %.1f%%' % (round(food / rev * 1000) / 10), '食材佔營收 %% 對得上：%s' % fp)
            status = pg.locator(KEEP + ' [data-role="pnl-month-status"]').inner_text()
            check(status.startswith('狀態：%s' % exp['status']), '狀態列：%s' % status)
            sub = pg.locator(KEEP + ' [data-metric="food"][data-role="pnl-metric"] .pnl-metric-sub').inner_text()
            check('食材' in sub and '包材' in sub, '食材卡有食材／包材小計：%s' % sub.replace('\n', ' '))
            check('營業淨利' in pg.locator(KEEP + ' [data-metric="net"][data-role="pnl-metric"] .pnl-metric-sub').inner_text(), '稅後淨利卡附營業淨利')
            check(pg.locator(KEEP + ' [data-role="pnl-metric"] svg[data-role="pnl-chart-svg"]').count() == 6, '六列都有走勢圖（SVG）')
            # 走勢：只有 2026-08 有資料 → 單點、沒有線（不畫成 0）
            check(pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-dot"]').count() == 1, '營業額走勢：只有 8 月一個點（其他月份斷線，不畫 0）')
            check(pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-line"]').count() == 0, '單點沒有線')
            check(pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-chart-svg"] text').count() >= 6, '走勢圖有軸標與月份')
            check(pg.locator(KEEP + ' [data-role="pnl-footnote"]').count() == 1, '有圖例說明（空心點＋虛線）')
            # 圖上滑過 → 提示框
            box = pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-hit"]').bounding_box()
            pg.mouse.move(box['x'] + box['width'] - 8, box['y'] + 40)
            pg.wait_for_selector(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-tip"]:not([hidden])', timeout=3000)
            tip = pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-tip"]').inner_text()
            check('2026-08' in tip and 'NT$ ' + money(rev) in tip, '滑過圖顯示 8 月數字：%s' % tip.replace('\n', ' '))
            pg.mouse.move(5, 5)
            check(pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-tip"]').is_hidden(), '移開後提示框收起')
            check(pg.locator(KEEP + ' [data-role="pnl-estimate-note"]').count() == 0 and '（估）' not in pg.locator(KEEP).inner_text(), '已定稿／過去月份沒有估算標示')
            # 下載 CSV（光復 2026-08）
            def dl(act):
                with pg.expect_download(timeout=15000) as d:
                    pg.click(KEEP + ' [data-act="%s"]' % act)
                f = d.value
                path = f.path()
                return f.suggested_filename, open(path, 'rb').read()
            fn, raw = dl('pnl-csv-pnl')
            txt = raw.decode('utf-8')
            lines = txt.split('\r\n')
            check(fn == '損益_新竹光復_2026-08.csv', '損益表 CSV 檔名：%s' % fn)
            check(raw[:3] == b'\xef\xbb\xbf' and lines[0].lstrip('\ufeff') == '區塊,acc_id,科目,取值方式,金額,佔營收%,是否估算', '損益表 CSV：UTF-8 BOM、表頭含「是否估算」：%s' % lines[0].lstrip('\ufeff'))
            check(lines[-1].startswith(',,稅後淨利,,' + ('%.2f' % res['net_profit'])), '損益表 CSV：最後一列稅後淨利 = 後端：%s' % lines[-1])
            check(sum(1 for l in lines if ',小計,' in l) == 8, '損益表 CSV：8 個區塊小計')
            fn, raw = dl('pnl-csv-entries')
            txt = raw.decode('utf-8'); lines = [l for l in txt.split('\r\n') if l]
            ex = backend('exportEntries', {'store_id': 'S01', 'month': '2026-08'})['data']['entries']
            check(fn == '明細_新竹光復_2026-08.csv' and raw[:3] == b'\xef\xbb\xbf', '明細 CSV 檔名與 BOM：%s' % fn)
            check(lines[0].lstrip('\ufeff') == '門市,月份,acc_id,科目,金額,分攤月數,認列金額,來源,備註,建立者,建立時間,作廢,狀態,品牌', '明細 CSV 表頭：%s' % lines[0].lstrip('\ufeff'))
            check(len(lines) - 1 == len(ex) and len(ex) > 0, '明細 CSV 列數 = 後端 exportEntries（%d 筆）：%d' % (len(ex), len(lines) - 1))
            check(any(c[0] == 'exportEntries' for c in mock.pnl_calls), '明細 CSV 走 exportEntries')

            # 待補連結（後端這份資料 S01 沒有待補，換成塞 3 項的版本再看）
            mock.fake_pending = 3
            n_pending = 3
            pick(pg, 'S02', '2026-08')
            pick(pg, 'S01', '2026-08')
            if n_pending:
                hint = pg.locator(KEEP + ' [data-role="pnl-pending-hint"]').inner_text()
                check(hint == '本月待補 %d 項 → 前往填資料' % n_pending, '待補提示：%s' % hint)
                pg.click(KEEP + ' [data-act="pnl-goto-pending"]')
                pg.wait_for_function("() => location.hash.startsWith('#/pnl/pending')", timeout=5000)
                check('store=S01' in pg.evaluate('location.hash') and 'month=2026-08' in pg.evaluate('location.hash'), '點「前往填資料」：到待補分頁並帶店別與月份：%s' % pg.evaluate('location.hash'))
                pg.click('[data-role="view-nav"] .nav-item:has-text("儀表板")')
                pg.wait_for_selector(KEEP + ' [data-role="pnl-metric"]', timeout=20000)
            else:
                check(pg.locator(KEEP + ' [data-role="pnl-pending-hint"]').is_hidden(), '沒有待補：不顯示提示')
            check(pg.locator(KEEP + ' [data-role="pnl-pending-hint"]').count() == 1, '待補提示區塊存在')

            # 估算＋多月走勢＋錯誤重試
            mock.fake_est = True
            pick(pg, 'S02', '2026-08')
            pick(pg, 'S01', '2026-08')
            check(pg.locator(KEEP + ' [data-metric="labor"][data-role="pnl-metric"] [data-role="pnl-metric-title"]').inner_text() == '人事費用（估）', '人事卡「（估）」')
            check(pg.locator(KEEP + ' [data-metric="net"][data-role="pnl-metric"] [data-role="pnl-metric-title"]').inner_text() == '稅後淨利（含估算）', '稅後淨利「（含估算）」')
            check(pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-metric-title"]').inner_text() == '營業額', '營業額沒有估算字樣')
            check('人事估算：近三月平均' in pg.locator(KEEP).inner_text(), '顯示人事估算依據')
            rv = '[data-metric="labor"][data-role="pnl-metric"] '
            check(pg.locator(KEEP + ' ' + rv + '[data-role="pnl-line"][data-dashed="0"]').count() == 1, '5～7 月三個月連成一條實線')
            check(pg.locator(KEEP + ' ' + rv + '[data-role="pnl-line"][data-dashed="1"]').count() == 1, '8 月是估算：虛線接到前一點')
            check(pg.locator(KEEP + ' ' + rv + '[data-role="pnl-dot"][data-hollow="1"]').count() == 1, '估算點是空心點')
            check(pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-dot"][data-hollow="1"]').count() == 0, '營業額 8 月不是估算：沒有空心點')
            check(pg.locator(KEEP + ' ' + rv + '[data-role="pnl-chart-svg"]').evaluate('e => e.querySelectorAll("[data-role=pnl-dot]").length') == 1, '沒資料的月份沒有點；實線中間不畫點，只有尾端 8 月空心點')
            mock.fake_est = False
            mock.fail = True
            pg.select_option(KEEP + ' [data-role="pnl-month"]', '2026-07')
            pg.wait_for_selector(KEEP + ' [data-role="pnl-error"]', timeout=10000)
            check('系統忙碌中' in pg.locator(KEEP + ' [data-role="pnl-error"]').inner_text() and pg.locator('input[type=password]').count() == 0, '後端失敗：顯示錯誤卡，不是登入框')
            mock.fail = False
            pg.click(KEEP + ' [data-act="pnl-retry"]')
            pg.wait_for_selector(KEEP + ' [data-role="pnl-metric"] [data-role="pnl-metric-value"]', timeout=10000)
            check(pg.locator(KEEP + ' [data-role="pnl-error"]').count() == 0, '按「重新整理」重讀成功')
            mock.fake_est = False

            check(pg.locator(KEEP + ' [data-act="pnl-csv-pnl"]').is_enabled(), '載入完成：下載鈕可按')
            # 其他店、其他月（沒草稿）
            pick(pg, 'S02', '2026-07')
            check(pg.locator(KEEP + ' [data-role="pnl-empty-month"]').count() == 1, '沒草稿的月份：顯示「本月尚未建立草稿」')
            check(pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-metric-value"]').inner_text() == 'NT$ —', '沒草稿：金額顯示 —，不是 0')
            check(pg.locator(KEEP + ' [data-role="pnl-chart-empty"]').count() == 6, '店 S02 近 12 個月都沒資料：六列都顯示「資料累積中」')
            check(pg.locator(KEEP + ' [data-role="pnl-pending-hint"]').is_hidden(), '空月份不顯示待補')
            pick(pg, 'S01', '2026-09')   # 8 月有、9 月沒草稿：走勢仍有 8 月點
            check(pg.locator(KEEP + ' [data-role="pnl-empty-month"]').count() == 1 and pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-dot"]').count() == 1, '9 月沒草稿：空狀態，但走勢仍畫歷史（8 月點）')

            # 全部門市
            pick(pg, 'ALL', '2026-08')
            allv = vals(pg)
            all_exp = backend('getMonth', {'store_id': 'ALL', 'month': '2026-08'})['data']['result']
            check(allv['revenue'] == 'NT$ ' + money(all_exp['blocks']['營收']), '全部門市營業額 = 後端合計：%s' % allv['revenue'])
            ht = pg.locator(KEEP + ' [data-role="pnl-pending-hint"]').inner_text()
            ap = sum(len(v) for v in all_exp['pending'].values())
            check(ap > 0, '後端全部門市有待補合計（%d）' % ap)
            if ap:
                check(ht == '本月各店合計待補 %d 項' % ap and pg.locator(KEEP + ' [data-act="pnl-goto-pending"]').count() == 0, '全部門市：只顯示各店合計、不附連結：%s' % ht)
            check('光復' in pg.locator(KEEP + ' [data-role="pnl-month-status"]').inner_text() or ':' in pg.locator(KEEP + ' [data-role="pnl-month-status"]').inner_text() or '：' in pg.locator(KEEP + ' [data-role="pnl-month-status"]').inner_text(), '全部門市：狀態列逐店')
            check(pg.locator(KEEP + ' [data-role="pnl-metric"] svg').count() >= 1, '全部門市：走勢圖（多店）')
            with pg.expect_download(timeout=15000) as d:
                pg.click(KEEP + ' [data-act="pnl-csv-entries"]')
            check(d.value.suggested_filename == '明細_全部_2026-08.csv', '全部門市明細 CSV 檔名：%s' % d.value.suggested_filename)
            ex_all = backend('exportEntries', {'store_id': 'ALL', 'month': '2026-08'})['data']['entries']
            check(len([l for l in open(d.value.path(), encoding='utf-8', newline='').read().split('\r\n') if l]) - 1 == len(ex_all), '全部門市明細 CSV 列數 = 後端（%d）：%d' % (len(ex_all), len([l for l in open(d.value.path(), encoding='utf-8', newline='').read().split('\r\n') if l]) - 1))
            with pg.expect_download(timeout=15000) as d:
                pg.click(KEEP + ' [data-act="pnl-csv-pnl"]')
            check(d.value.suggested_filename == '損益_全部_2026-08.csv', '全部門市損益表 CSV 檔名：%s' % d.value.suggested_filename)
            pg.context.close()

            # ====== ② 品牌篩選、圖例、超過 6 條：把後端的店補到 9 家（7 家有資料）（用 saveSettings 不會；改用攔截 getSettings／getTrendMulti 擴充）======
            pg = new_page()
            mock.many = True
            do_login(pg, 'pnladm')
            pg.click('[data-nav="pnl"]')
            pg.wait_for_selector(KEEP + ' [data-role="pnl-metric"]', timeout=20000)
            pick(pg, 'ALL', '2026-08')
            leg = pg.locator(KEEP + ' [data-act="pnl-legend"]')
            check(leg.count() == 7, '全部門市：圖例 7 家（S02 近 12 月沒資料不入圖）：%d' % leg.count())
            lines_before = pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-dot"]').count()
            check(lines_before == 6, '超過 6 條：先畫 6 條（%d 個點）' % lines_before)
            check(leg.nth(6).get_attribute('aria-pressed') == 'false' and leg.nth(0).get_attribute('aria-pressed') == 'true', '第 7 家起預設隱藏')
            pg.click(KEEP + ' [data-act="pnl-legend-all"]')
            check(pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-dot"]').count() == 7, '按「顯示全部 7 家」：7 條')
            pg.click(KEEP + ' [data-act="pnl-legend"][data-sid="S01"]')
            check(pg.locator(KEEP + ' [data-act="pnl-legend"][data-sid="S01"]').get_attribute('aria-pressed') == 'false' and pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-dot"]').count() == 6, '點圖例隱藏 S01：剩 6 條')
            pg.click(KEEP + ' [data-act="pnl-legend"][data-sid="S01"]')
            check(pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-dot"]').count() == 7, '再點一次顯示回來')
            pg.click(KEEP + ' [data-act="pnl-legend-all"]')
            check(pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] [data-role="pnl-dot"]').count() == 6, '按「只顯示前 6 家」：回到 6 條')
            brands = [b.inner_text() for b in pg.locator(KEEP + ' [data-act="pnl-brand"]').all()]
            check(brands == ['全部', '墨竹亭', '小辛辣'], '品牌篩選鈕：%s' % brands)
            pg.click(KEEP + ' [data-act="pnl-brand"][data-brand="墨竹亭"]')
            check(pg.locator(KEEP + ' [data-act="pnl-legend"]').count() == 3 and '只含「墨竹亭」' in pg.locator(KEEP).inner_text(), '品牌篩選墨竹亭：圖例剩該品牌 3 家，並註明六列只含該品牌')
            check(pg.locator(KEEP + ' [data-act="pnl-brand"][data-brand="墨竹亭"]').get_attribute('aria-pressed') == 'true', '品牌鈕按下狀態')
            for sid in ['S03', 'S05', 'S07']:
                pg.click(KEEP + ' [data-act="pnl-legend"][data-sid="%s"]' % sid)
            check(pg.locator(KEEP + ' [data-role="pnl-chart-empty"]').count() == 6 and '所有門市都已隱藏' in pg.locator(KEEP + ' [data-role="pnl-chart-empty"]').first.inner_text(), '全部隱藏：提示重新顯示')
            pg.click(KEEP + ' [data-act="pnl-brand"][data-brand="全部"]')
            check(pg.locator(KEEP + ' [data-act="pnl-legend"]').count() == 7, '回到全部品牌')
            pg.context.close()

            # ====== ③ write（填寫者）======
            pg = new_page()
            open_dash(pg, 'pnlwr')
            no_login_form(pg, 'write 儀表板')
            names = [x.replace('\n', '') for x in pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(names == ['儀表板', '待補', '食材', '人事', '可控', '不可控', '營業收入', '匯入'], 'write 看得到填資料各頁但沒有設定：%s' % names)
            pick(pg, 'S01', '2026-08')
            check(vals(pg)['revenue'] == 'NT$ ' + money(rev), 'write：營業額與後端一致')
            if n_pending:
                check(pg.locator(KEEP + ' [data-act="pnl-goto-pending"]').count() == 1, 'write：有「前往填資料」連結')
            pg.context.close()

            # ====== ④ read（檢視者）======
            pg = new_page()
            open_dash(pg, 'pnlrd')
            no_login_form(pg, 'read 儀表板')
            names = [x.replace('\n', '') for x in pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(names == ['儀表板'], 'read 只看得到儀表板：%s' % names)
            pick(pg, 'S01', '2026-08')
            check(vals(pg)['revenue'] == 'NT$ ' + money(rev), 'read：營業額與後端一致')
            check(pg.locator(KEEP + ' [data-act="pnl-goto-pending"]').count() == 0, 'read：待補只有數字、沒有前往填資料連結')
            if n_pending:
                check(pg.locator(KEEP + ' [data-role="pnl-pending-hint"]').inner_text() == '本月待補 %d 項' % n_pending, 'read：只顯示待補數字')
            pg.goto(base + '/index.html#/pnl/settings')
            pg.wait_for_timeout(1200)
            check(pg.locator(KEEP + ' .pnl-metric').count() == 0 or '#/pnl/settings' not in pg.evaluate('location.hash'), 'read 直接輸入 #/pnl/settings：進不了設定頁（hash=%s）' % pg.evaluate('location.hash'))
            pg.context.close()

            # ====== ⑤ 手機寬 375 ======
            pg = new_page(375, 800)
            do_login(pg, 'pnladm')
            pg.evaluate("location.hash = '#/pnl/dashboard'")
            pg.wait_for_selector(KEEP + ' [data-role="pnl-metric"]', timeout=20000)
            pick(pg, 'S01', '2026-08')
            sw = pg.evaluate('document.documentElement.scrollWidth')
            check(sw <= 376, '375 寬：沒有橫向捲動（scrollWidth=%d）' % sw)
            wd = pg.locator(KEEP + ' [data-metric="revenue"][data-role="pnl-metric"] svg').evaluate('e => e.getBoundingClientRect().width')
            check(wd <= 360 and wd >= 240, '375 寬：走勢圖寬度適中（%d）' % wd)
            pg.screenshot(path='/tmp/pnl-dash-375.png')
            pg.context.close()

            browser.close()
        check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        if httpd:
            httpd.shutdown()
        proc.terminate()
    finish()


if __name__ == '__main__':
    main()
