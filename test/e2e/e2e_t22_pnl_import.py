#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e t22：損益試算「匯入」頁（原生化 P3 / T16）。真的損益後端（pnl_backend.mjs，埠 18923）＋本機站台（埠 8833），全部假資料。

驗：選門市（沒有「全部門市」）／月份／範本、多檔選取（副檔名 .xls 實際是 xlsx）、預覽（每科目合計、略過列、未對應、涵蓋天數）、
疑似重複／店別不符檔案的勾選、不足整月的二次確認、送出 importEntries 後 getMonth 的金額對、整月取代；
範本進階設定（管理者）：新增對應規則／移除／套用不儲存（擋匯入）／存成新範本（代號直入）；代號直入：無效代號擋下、
「已有其他來源」黃卡＋連帶作廢；權限：write 可進、read 進不來；任何畫面沒有登入表單；mock.leaked == []。
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ROOT, USERS, MockBackend, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT = 8833
BACK = 18923
KEY = 'test-dzy-key-0123456789abcdef'
KEEP = '[data-keep="pnl"]'
PRE = '[data-role="pnl-import-preview"]'

XLSX_JS = r"""
const fs = require('fs'); const path = process.argv[2]; const spec = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const m = { exports: {} }; new Function('module', 'exports', fs.readFileSync(path, 'utf8'))(m, m.exports); const X = m.exports;
for (const f of spec) { const ws = X.utils.aoa_to_sheet(f.rows); const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'Sheet1');
  fs.mkdirSync(require('path').dirname(f.out), { recursive: true }); fs.writeFileSync(f.out, Buffer.from(X.write(wb, { type: 'buffer', bookType: 'xlsx' }))); }
"""


def backend_getmonth(store, month):
    body = {'action': 'dzyProxy', 'key': KEY, 'level': 'admin', 'account': 'SEED', 'operator': 'seed', 'inner': 'getMonth', 'payload': {'store_id': store, 'month': month}}
    req = urllib.request.Request('http://127.0.0.1:%d/pnl/api' % BACK, data=json.dumps(body).encode('utf-8'), headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(req, timeout=30).read().decode('utf-8'))['data']


def sums(entries, source):
    out = {}
    for e in entries:
        if e.get('void') is True or e.get('source') != source:
            continue
        out[e['acc_id']] = round(out.get(e['acc_id'], 0) + e['amount'], 6)
    return out


def main():
    tmp = tempfile.mkdtemp(prefix='pnl-import-e2e-')
    # ---- 假 POS 檔（全部假資料）----
    H = ['店別', '銷售單號', '桌位', '淨額', '結帳時間']
    S = '小辛辣-新竹光復店'
    exp = {}

    def add(rows, acc, amt):
        exp[acc] = exp.get(acc, 0) + amt

    def pos(days, store=S):
        rows = [H]
        for d in days:
            ds = '2026-08-%02d' % d
            for tbl, amt, acc in (('UE', 100 + d, 'A002'), ('UberEats', 10, 'A002'), ('內用1', 200, 'A001'), ('-聯發科-', 50, 'A004'), ('Panda', 30, 'A003'), ('ND', 20, 'A005')):
                rows.append([store, d * 10, tbl, amt, ds + ' 12:00'])
        return rows
    a_rows = pos(range(1, 16)) + [[], [S, 1, 'UE', 'abc', '2026-08-02 10:00'], [S, 1, 'UE', 5, 'zzz']]
    b_rows = pos(range(16, 32))
    c_rows = pos([20], store='小辛辣-台中美村店')
    bad_rows = [['店別', '桌位', '金額', '時間'], [S, 'UE', 5, '2026-08-01 10:00']]
    full = {'A001': 0, 'A002': 0, 'A003': 0, 'A004': 0, 'A005': 0}
    for d in range(1, 32):
        full['A002'] += 100 + d + 10; full['A001'] += 200; full['A004'] += 50; full['A003'] += 30; full['A005'] += 20
    half = {'A001': 200 * 15, 'A002': sum(100 + d + 10 for d in range(1, 16)), 'A004': 50 * 15, 'A003': 30 * 15, 'A005': 20 * 15}
    codes_bad = [['代號', '金額'], ['a001', 1000], ['ZZ9', 5], ['A001', 'x']]
    codes_ok = [['代號', '金額'], [' a001 ', 1000], ['A001', 234.5], ['A002', 77]]
    d1, d2 = os.path.join(tmp, 'd1'), os.path.join(tmp, 'd2')
    spec = [{'out': os.path.join(d1, 'POS-0801-0815.xls'), 'rows': a_rows},
            {'out': os.path.join(d1, 'POS-0816-0831.xls'), 'rows': b_rows},
            {'out': os.path.join(d1, 'POS-美村.xls'), 'rows': c_rows},
            {'out': os.path.join(d2, 'POS-0801-0815.xls'), 'rows': a_rows},
            {'out': os.path.join(d1, 'bad-header.xls'), 'rows': bad_rows},
            {'out': os.path.join(d1, 'codes-bad.xlsx'), 'rows': codes_bad},
            {'out': os.path.join(d1, 'codes-ok.xlsx'), 'rows': codes_ok}]
    spec_p = os.path.join(tmp, 'spec.json'); js_p = os.path.join(tmp, 'mk.js')
    json.dump(spec, open(spec_p, 'w')); open(js_p, 'w').write(XLSX_JS)
    subprocess.check_call(['node', js_p, os.path.join(ROOT, 'modules/pnl/vendor/xlsx.full.min.js'), spec_p])
    F = lambda sub, name: os.path.join(tmp, sub, name)

    # ---- 起後端 ----
    proc = subprocess.Popen(['node', os.path.join(ROOT, 'test/e2e/pnl_backend.mjs'), str(BACK)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        line = ''
        while 'READY' not in line:
            line = proc.stdout.readline()
            if not line:
                raise SystemExit('pnl_backend 沒有 READY')
        os.environ['PNL_RUNNER'] = 'http://127.0.0.1:%d/pnl/api' % BACK
        run(tmp, F, exp, full, half)
    finally:
        proc.terminate()


def run(tmp, F, exp, full, half):
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    mk = lambda name, perms: {'password': 'e2e-pw', 'perms': perms, 'user': {'id': 'u-' + name, 'name': name, 'role': 'staff', 'node': ''}}
    USERS['pnladm'] = mk('損益管理', ['platform.self', 'pnl.admin'])
    USERS['pnlw'] = mk('損益填寫', ['platform.self', 'pnl.write'])
    USERS['pnlr'] = mk('損益檢視', ['platform.self', 'pnl.read'])
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def new_page(w=1280):
                ctx = browser.new_context(viewport={'width': w, 'height': 900})
                pg = ctx.new_page()
                mock.install(pg)
                pg._errs = []
                pg.on('console', lambda m: pg._errs.append(m.text) if m.type == 'error' else None)
                pg.on('pageerror', lambda e: pg._errs.append(str(e)))
                pg.goto(base + '/index.html')
                return pg

            def login(pg, user):
                pg.fill('#login-username', user)
                pg.fill('#login-password', USERS[user]['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)

            def n_calls(action):
                return len([c for c in getattr(mock, 'pnl_calls', []) if c[0] == action])

            def no_login_form(pg, label):
                check(pg.locator('input[type=password]').count() == 0, label + '：畫面沒有登入表單')

            def open_import(pg, month='2026-08'):
                pg.goto(base + '/index.html#/pnl/import')
                pg.wait_for_selector(KEEP + ' [data-role="pnl-import"]', timeout=15000)
                pg.select_option(KEEP + ' [data-role="pnl-month"]', month)

            def pick(pg, paths):
                pg.evaluate("() => { document.querySelector('[data-keep=pnl] [data-role=pnl-import-preview]').innerHTML = ''; }")   # 清掉舊預覽，等新的解析結果
                pg.set_input_files(KEEP + ' [data-role="pnl-import-file"]', paths)
                pg.wait_for_selector(KEEP + ' ' + PRE + ' [data-role="pnl-import-table"]', timeout=15000)

            def row_amounts(pg):
                out = {}
                for r in pg.locator(KEEP + ' [data-role="pnl-import-row"]').all():
                    txt = r.inner_text().replace(',', '').replace('−', '-')
                    acc = r.get_attribute('data-acc')
                    out[acc] = float(txt.split('NT$')[1].strip())
                return out

            def wait_toast(pg, text):
                try:
                    pg.wait_for_selector(".toast:has-text(\"%s\")" % text, timeout=30000)
                except Exception:
                    raise SystemExit('等不到提示「%s」；畫面上的提示：%s；後端呼叫：%s；console：%s' % (text, pg.locator('.toast').all_inner_texts(), getattr(mock, 'pnl_calls', [])[-4:], getattr(pg, '_errs', [])))

            def import_done(pg, before):
                # 等這一次 importEntries 真的送出且讀取遮罩消失，再看提示（避免吃到上一個提示）
                for _ in range(200):
                    if n_calls('importEntries') > before and pg.locator('.loading-overlay').count() == 0:
                        break
                    pg.wait_for_timeout(100)
                wait_toast(pg, '匯入完成')

            # ====== ① write 使用者：選項、範本、沒有進階設定 ======
            pg = new_page()
            login(pg, 'pnlw')
            check(pg.locator('[data-nav="pnl"]').count() == 1, '有 pnl.write：選單有損益試算')
            pg.click('[data-nav="pnl"]')
            pg.wait_for_selector(KEEP + ' [data-role="view-nav"], [data-role="view-nav"]', timeout=15000)
            tabs = [x.replace('\n', '') for x in pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check('匯入' in tabs and '設定' not in tabs, 'write 的頁頂分頁有「匯入」、沒有「設定」：%s' % tabs)
            pg.locator('[data-role="view-nav"] .nav-item', has_text='匯入').click()
            pg.wait_for_selector(KEEP + ' [data-role="pnl-import"]', timeout=15000)
            stores = pg.locator(KEEP + ' [data-role="pnl-store"] option').all_inner_texts()
            vals = pg.locator(KEEP + ' [data-role="pnl-store"] option').evaluate_all('(o) => o.map((x) => x.value)')
            check('ALL' not in vals and 'S01' in vals, '門市選單不含「全部門市」、有光復 S01：%s %s' % (vals, stores))
            tpls = pg.locator(KEEP + ' [data-role="pnl-import-tpl"] option').all_inner_texts()
            check(any('T01' in t for t in tpls), '匯入範本下拉有 T01：%s' % tpls)
            summ = pg.locator(KEEP + ' [data-role="pnl-import-tpl-summary"]').inner_text()
            check('淨額' in summ and '結帳時間' in summ and '桌位' in summ, '範本摘要顯示金額欄／日期欄／分組欄：%s' % summ)
            check(pg.locator(KEEP + ' [data-act="tpl-toggle"]').count() == 0, '填寫者看不到範本進階設定（只有管理者）')
            no_login_form(pg, '匯入頁')
            check(pg.locator(KEEP + ' [data-act="import-confirm"]').count() == 0, '還沒選檔：沒有確認匯入鈕')
            pg.select_option(KEEP + ' [data-role="pnl-month"]', '2026-08')
            pg.select_option(KEEP + ' [data-role="pnl-store"]', 'S01')

            # ====== ② 兩個半月檔 → 整月；預覽；送出 ======
            pick(pg, [F('d1', 'POS-0801-0815.xls'), F('d1', 'POS-0816-0831.xls')])
            amts = row_amounts(pg)
            check(all(abs(amts.get(k, -1) - v) < 0.01 for k, v in full.items()), '預覽每科目合計＝整月（兩個 .xls 其實是 xlsx）：%s 預期 %s' % (amts, full))
            tot = pg.locator(KEEP + ' [data-role="pnl-import-total"]').inner_text().replace(',', '')
            check(str(sum(full.values())) in tot, '預覽合計＝%s：%s' % (sum(full.values()), tot))
            st = pg.locator(KEEP + ' [data-role="pnl-import-stats"]').inner_text()
            check('略過（金額格式錯）2 列' in st and '略過（日期不在月份）1 列' in st and '未對應 0 列' in st, '略過統計（金額錯 2＝abc 一列＋試算表空列、日期不在月份 1）：%s' % st)
            cov = pg.locator(KEEP + ' [data-role="pnl-import-coverage"]').inner_text()
            check('31/31' in cov and '整月取代' not in cov, '涵蓋 31/31 天、沒有不足整月警告：%s' % cov)
            check(pg.locator(KEEP + ' [data-act="import-confirm"]').is_enabled(), '確認匯入鈕可按')
            pg.screenshot(path=os.path.join(tmp, 'preview-1280.png'))
            b0 = n_calls('importEntries')
            pg.click(KEEP + ' [data-act="import-confirm"]')
            pg.wait_for_selector('.dialog', timeout=5000)
            dtxt = pg.locator('.dialog').inner_text()
            check('有略過的列' in dtxt and '不足整月' not in dtxt, '整月但有略過列：只跳「有略過的列」確認：%s' % dtxt[:50])
            pg.locator('.dialog button', has_text='確定').click()
            import_done(pg, b0)
            check(n_calls('importEntries') == b0 + 1 and ('importEntries', 'write') in mock.pnl_calls, 'write 等級送出 importEntries 一次：%s' % mock.pnl_calls[-3:])
            m = backend_getmonth('S01', '2026-08')
            got = sums(m['entries'], '匯入:T01')
            check(all(abs(got.get(k, -1) - v) < 0.01 for k, v in full.items()), 'getMonth：匯入:T01 各科目金額＝整月預期：%s 預期 %s' % (got, full))
            notes = [e.get('note') for e in m['entries'] if e.get('source') == '匯入:T01' and not e.get('void')]
            check(notes and all(n.startswith('2 檔 ') and '2026-08-01~2026-08-31' in n for n in notes), '明細 note＝「2 檔 N 列 起~迄」：%s' % notes[:1])

            # ====== ③ 疑似問題檔：店別不符預設排除、重複檔名；不足整月二次確認 ======
            pick(pg, [F('d1', 'POS-0801-0815.xls'), F('d1', 'POS-美村.xls'), F('d2', 'POS-0801-0815.xls')])
            fl = pg.locator(KEEP + ' [data-role="pnl-import-flagged"]')
            ft = fl.inner_text()
            check('POS-美村.xls' in ft and '店別' in ft and '檔名重複' in ft, '黃卡列出店別不符與檔名重複的檔案：%s' % ft)
            cbs = fl.locator('[data-act="include-file"]')
            check(cbs.count() == 2 and not cbs.nth(0).is_checked() and not cbs.nth(1).is_checked(), '店別不符、檔名重複預設不計入')
            amts = row_amounts(pg)
            check(all(abs(amts.get(k, -1) - v) < 0.01 for k, v in half.items()), '只計入半月檔：%s 預期 %s' % (amts, half))
            cov = pg.locator(KEEP + ' [data-role="pnl-import-coverage"]').inner_text()
            check('15/31' in cov and '整月取代' in cov, '涵蓋 15/31 天、顯示不足整月警告：%s' % cov)
            cbs.nth(0).check()   # 勾進美村檔
            amts2 = row_amounts(pg)
            check(amts2['A002'] == half['A002'] + 130 and amts2['A001'] == half['A001'] + 200, '勾選美村檔後合計增加（互動式覆蓋）：%s' % amts2)
            pg.locator(KEEP + ' [data-role="pnl-import-flagged"] [data-act="include-file"]').nth(0).uncheck()
            b0 = n_calls('importEntries')
            pg.click(KEEP + ' [data-act="import-confirm"]')
            pg.wait_for_selector('.dialog', timeout=5000)
            dtxt = pg.locator('.dialog').inner_text()
            check('不足整月' in dtxt and '略過的列' in dtxt, '不足整月＋有略過列：跳二次確認：%s' % dtxt[:60])
            pg.locator('.dialog button', has_text='取消').click()
            pg.wait_for_timeout(500)
            check(n_calls('importEntries') == b0, '二次確認按取消：沒有送出')
            pg.click(KEEP + ' [data-act="import-confirm"]')
            pg.wait_for_selector('.dialog')
            pg.locator('.dialog button', has_text='確定').click()
            import_done(pg, b0)
            m = backend_getmonth('S01', '2026-08')
            got = sums(m['entries'], '匯入:T01')
            check(all(abs(got.get(k, -1) - v) < 0.01 for k, v in half.items()), '整月取代：先前整月資料被作廢，只剩半月金額：%s 預期 %s' % (got, half))

            # ====== ④ 表頭對不起來／月份不符 ======
            pick(pg, [F('d1', 'bad-header.xls')])
            et = pg.locator(KEEP + ' [data-role="pnl-import-errors"]').inner_text()
            check('bad-header.xls' in et and '金額欄「淨額」' in et, '缺欄錯誤卡寫明缺哪一欄：%s' % et)
            if not pg.locator(KEEP + ' [data-act="import-confirm"]').is_disabled():
                print('DBG', pg.locator(KEEP + ' ' + PRE).inner_html()[-400:], pg.locator(KEEP + ' [data-act="import-confirm"]').count())
            check(pg.locator(KEEP + ' [data-act="import-confirm"]').is_disabled(), '表頭不符：確認匯入停用')
            pick(pg, [F('d1', 'POS-0801-0815.xls')])
            pg.select_option(KEEP + ' [data-role="pnl-month"]', '2026-07')
            pg.wait_for_function("() => { const e = document.querySelector('[data-keep=pnl] [data-role=pnl-import-coverage]'); return e && e.textContent.includes('0/31'); }", timeout=10000)
            check(pg.locator(KEEP + ' [data-act="import-confirm"]').is_disabled(), '換成 2026-07：沒有任何列落在該月（0/31 天），確認匯入停用')
            pg.select_option(KEEP + ' [data-role="pnl-month"]', '2026-08')
            pg.wait_for_function("() => { const e = document.querySelector('[data-keep=pnl] [data-role=pnl-import-coverage]'); return e && e.textContent.includes('15/31'); }", timeout=10000)
            check(True, '換回 2026-08：預覽重算（15/31 天）')
            no_login_form(pg, '預覽後')
            pg.context.close()

            # ====== ⑤ 管理者：範本進階設定、代號直入、其他來源黃卡 ======
            ad = new_page(375)
            login(ad, 'pnladm')
            open_import(ad)
            ad.wait_for_selector(KEEP + ' [data-act="tpl-toggle"]')
            check(ad.evaluate('() => document.documentElement.scrollWidth <= window.innerWidth + 1'), '手機寬 375：匯入頁沒有橫向捲動')
            ad.click(KEEP + ' [data-act="tpl-toggle"]')
            check(ad.locator(KEEP + ' [data-role="pnl-tpl-body"]').is_visible(), '展開進階設定')
            n_rows = ad.locator(KEEP + ' [data-role="pnl-tpl-maprow"]').count()
            ad.click(KEEP + ' [data-act="tpl-add-map"]')
            check(ad.locator(KEEP + ' [data-role="pnl-tpl-maprow"]').count() == n_rows + 1, '新增一條對應規則')
            ad.locator(KEEP + ' [data-act="tpl-del-map"]').last.click()
            check(ad.locator(KEEP + ' [data-role="pnl-tpl-maprow"]').count() == n_rows, '移除一條對應規則')
            # 套用不儲存
            ad.fill(KEEP + ' [data-role="pnl-tpl-amount"]', '淨額')
            ad.click(KEEP + ' [data-act="tpl-apply"]')
            pick(ad, [F('d1', 'POS-0801-0815.xls'), F('d1', 'POS-0816-0831.xls')])
            check(ad.locator(KEEP + ' [data-role="pnl-import-unsaved"]').count() == 1 and ad.locator(KEEP + ' [data-act="import-confirm"]').is_disabled(), '套用但未儲存的範本：顯示警告、不能匯入')
            ad.click(KEEP + ' [data-act="tpl-toggle"]') if not ad.locator(KEEP + ' [data-role="pnl-tpl-body"]').is_visible() else None
            # 存成新範本（代號直入）
            ad.fill(KEEP + ' [data-role="pnl-tpl-name"]', 'e2e 代號直入')
            ad.fill(KEEP + ' [data-role="pnl-tpl-date"]', '')
            ad.fill(KEEP + ' [data-role="pnl-tpl-amount"]', '金額')
            ad.fill(KEEP + ' [data-role="pnl-tpl-group"]', '代號')
            ad.check(KEEP + ' [data-role="pnl-tpl-direct"]')
            check(not ad.locator(KEEP + ' [data-role="pnl-tpl-mapping"]').is_visible(), '勾「分組欄的值就是科目代號」：對應規則區隱藏')
            ad.click(KEEP + ' [data-act="tpl-save"]')
            wait_toast(ad, '已存成新範本')
            tpl_vals = ad.locator(KEEP + ' [data-role="pnl-import-tpl"] option').evaluate_all('(o) => o.map((x) => x.value)')
            check(len(tpl_vals) == 2 and ad.locator(KEEP + ' [data-role="pnl-import-tpl"]').input_value() == tpl_vals[1], '新範本加進下拉並選取：%s' % tpl_vals)
            check('直接當科目代號' in ad.locator(KEEP + ' [data-role="pnl-import-tpl-summary"]').inner_text(), '摘要顯示代號直入規則')
            new_id = tpl_vals[1]
            # 無效代號
            pick(ad, [F('d1', 'codes-bad.xlsx')])
            iv = ad.locator(KEEP + ' [data-role="pnl-import-invalid"]').inner_text()
            check('ZZ9' in iv and '科目代號不存在' in iv and '第 4 列' in iv and ad.locator(KEEP + ' [data-act="import-confirm"]').is_disabled(), '無效代號／被略過的列：列出並停用確認匯入：%s' % iv[:80])
            # 有效 → 其他來源黃卡（T01 在 A001/A002 已有匯入明細）
            pick(ad, [F('d1', 'codes-ok.xlsx')])
            ad.wait_for_selector(KEEP + ' [data-role="pnl-import-other"]')
            ot = ad.locator(KEEP + ' [data-role="pnl-import-other"]').inner_text()
            check('A001' in ot and 'A002' in ot and '匯入:T01' in ot, '「已有其他來源」黃卡列出 A001／A002：%s' % ot[:90])
            vo = ad.locator(KEEP + ' [data-act="void-other"]')
            check(vo.count() == 2 and vo.nth(0).is_checked() and vo.nth(1).is_checked(), '連帶作廢預設勾選')
            amts = row_amounts(ad)
            check(amts == {'A001': 1234.5, 'A002': 77.0}, '代號直入預覽：A001 合計 1234.5、A002 77：%s' % amts)
            # 取消勾 A002 → 送出後 A002 的 T01 明細保留，A001 的被作廢
            ad.locator(KEEP + ' [data-act="void-other"][data-acc="A002"]').uncheck()
            b0 = n_calls('importEntries')
            ad.click(KEEP + ' [data-act="import-confirm"]')
            import_done(ad, b0)
            m = backend_getmonth('S01', '2026-08')
            t1 = sums(m['entries'], '匯入:T01')
            tn = sums(m['entries'], '匯入:' + new_id)
            check('A001' not in t1 and t1.get('A002') == half['A002'], 'void_other_sources：A001 的舊來源被作廢、取消勾選的 A002 保留：%s' % t1)
            check(tn == {'A001': 1234.5, 'A002': 77.0}, '新範本匯入的金額進去了：%s' % tn)
            ad.wait_for_selector(KEEP + ' [data-role="pnl-import-other"]')   # 匯入後預覽重算：A002 仍有其他來源
            ot2 = ad.locator(KEEP + ' [data-role="pnl-import-other"]').inner_text()
            check('A002' in ot2 and 'A001' not in ot2, '匯入後重算預覽：只剩 A002 有其他來源：%s' % ot2[:60])
            no_login_form(ad, '管理者匯入頁')
            ad.context.close()

            # ====== ⑥ read 使用者：進不來 ======
            rd = new_page()
            login(rd, 'pnlr')
            rd.click('[data-nav="pnl"]')
            rd.wait_for_selector('[data-role="view-nav"]', timeout=15000)
            tabs = [x.replace('\n', '') for x in rd.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check('匯入' not in tabs and tabs == ['儀表板'], 'read 只有儀表板分頁：%s' % tabs)
            before = n_calls('importEntries')
            rd.goto(base + '/index.html#/pnl/import')
            rd.wait_for_timeout(1500)
            check(rd.locator(KEEP + ' [data-role="pnl-import"]').count() == 0 and rd.locator(KEEP + ' [data-act="import-confirm"]').count() == 0, 'read 直接輸入 #/pnl/import：沒有匯入畫面')
            check(n_calls('importEntries') == before, 'read 沒有送出任何 importEntries')
            check(not [c for c in getattr(mock, 'pnl_calls', []) if c[0] in ('importEntries', 'saveSettings') and c[1] == 'read'], '後端沒有收到 read 等級的寫入動作')
            no_login_form(rd, 'read 使用者')
            rd.context.close()

            browser.close()
        check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
