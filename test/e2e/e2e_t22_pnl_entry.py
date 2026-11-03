#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e T22：損益試算「填資料」（待補總覽＋食材／人事／可控／不可控／營業收入）。

後端是本機真的損益後端（pnl_backend.mjs，埠 18922）、站台埠 8832，全部假資料假金鑰。驗：
  ① 待補總覽：S01 2026-08 全數已填 →「本月資料已齊」；S02 2026-07 未建草稿 → 依類別分組、頁首待補 N 項、提示「尚未建立草稿」。
  ② 新增明細（金額、分攤月數、備註、PNG 附件）→ 草稿自動建立、待補少一項、附件存成 pnlfile:；驗證擋下（空金額、HEIC）。
  ③ 查看附件：getAttachment → Blob URL 圖片；PDF 附件走 Blob 連結。
  ④ 作廢：沒填原因擋下，填了才送。
  ⑤ 確認為 0：手動科目可；連接器科目過去月份可、當月不給。
  ⑥ 類別頁：完整資料（固定／公式唯讀、匯入科目說明、選填標示）；五類都點到。
  ⑦ 定稿月份唯讀（後端先 finalize）：寫入鈕都消失；管理者解除定稿、再從畫面定稿。
  ⑧ 權限：read 的人沒有填資料分頁、直接輸入網址也進不去；任何畫面沒有登入表單；375px 寬不橫向捲動。
"""
import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import USERS, MockBackend, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT = 8832
BPORT = 18922
KEY = 'test-dzy-key-0123456789abcdef'
KEEP = '[data-keep="pnl"]'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
PDF = b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'


def backend(action, payload, level='admin'):
    body = {'action': 'dzyProxy', 'key': KEY, 'level': level, 'account': 'E2EPREP', 'operator': 'prep', 'inner': action, 'payload': payload}
    req = urllib.request.Request('http://127.0.0.1:%d/pnl/api' % BPORT, data=json.dumps(body).encode(), headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode())


def main():
    proc = subprocess.Popen(['node', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pnl_backend.mjs'), str(BPORT)],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for line in proc.stdout:
            if line.startswith('READY'):
                break
        else:
            raise SystemExit('損益後端沒有起來')
        os.environ['PNL_RUNNER'] = 'http://127.0.0.1:%d/pnl/api' % BPORT
        run()
    finally:
        proc.terminate()
    finish()


def run():
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    mk = lambda name, perms: {'password': 'e2e-pw', 'perms': perms, 'user': {'id': 'u-' + name, 'name': name, 'role': 'staff', 'node': ''}}
    USERS['pnladm'] = mk('損益管理', ['platform.self', 'pnl.admin'])
    USERS['pnlwr'] = mk('損益填寫', ['platform.self', 'pnl.write'])
    USERS['pnlrd'] = mk('損益檢視', ['platform.self', 'pnl.read'])
    out_dir = tempfile.mkdtemp(prefix='pnl-entry-e2e-')

    def tmpfile(name, data):
        p = pathlib.Path(out_dir) / name
        p.write_bytes(data)
        return str(p)

    png_path, pdf_path = tmpfile('a.png', PNG), tmpfile('a.pdf', PDF)
    heic_path = tmpfile('a.heic', b'\x00\x00\x00\x18ftypheic')
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def new_page(w=1280):
                ctx = browser.new_context(viewport={'width': w, 'height': 900})
                pg = ctx.new_page()
                mock.install(pg)
                pg.goto(base + '/index.html')
                return pg

            def login(pg, user):
                pg.fill('#login-username', user)
                pg.fill('#login-password', USERS[user]['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)

            def go(pg, view, store, month):
                pg.evaluate("(h) => { location.hash = h; }", '#/pnl/%s?store=%s&month=%s' % (view, store, month))
                pg.wait_for_function(
                    "(a) => { const s = document.querySelector('[data-keep=pnl] [data-role=pnl-store]'); const m = document.querySelector('[data-keep=pnl] [data-role=pnl-month]');"
                    " return s && m && s.value === a[0] && m.value === a[1] && document.querySelector('[data-keep=pnl] [data-role=pnl-month-status]') !== null"
                    " && document.querySelector('[data-keep=pnl] [data-role=pnl-entry-body] [data-role=pnl-loading]') === null; }",
                    arg=[store, month], timeout=15000)
                pg.wait_for_timeout(150)

            def count(pg, sel):
                return pg.locator(KEEP + ' ' + sel).count()

            def total_text(pg):
                return pg.locator(KEEP + ' [data-role="pnl-pending-total"]').inner_text()

            def acc(acc_id):
                return KEEP + ' [data-role="pnl-acc"][data-acc="%s"]' % acc_id

            def calls_of(action):
                return [c for c in getattr(mock, 'pnl_calls', []) if c[0] == action]

            def month_data(store, month):
                return backend('getMonth', {'store_id': store, 'month': month})['data']

            def live(store, month, acc_id):
                return [e for e in month_data(store, month)['entries'] if e['acc_id'] == acc_id and not e['void']]

            def no_login_form(pg, label):
                check(pg.locator('input[type=password]').count() == 0, label + '：畫面沒有登入表單（沒有 password 欄位）')

            check(month_data('S02', '2026-07')['status'] == '無', '準備：S02 2026-07 沒有草稿')
            check(month_data('S01', '2026-08')['status'] == '草稿', '準備：S01 2026-08 是草稿')

            # ====== ⑧ read 的人 ======
            rd = new_page()
            login(rd, 'pnlrd')
            rd.click('[data-nav="pnl"]')
            rd.wait_for_selector(KEEP, state='attached', timeout=10000)
            names = [x.replace('\n', '') for x in rd.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(names == ['儀表板'], 'read：頁頂只有儀表板：%s' % names)
            rd.evaluate("() => { location.hash = '#/pnl/pending'; }")
            rd.wait_for_timeout(1200)
            check(count(rd, '[data-role="pnl-acc"]') == 0 and count(rd, '[data-act="add-toggle"]') == 0, 'read：直接輸入 #/pnl/pending 也沒有填資料畫面')
            rd.context.close()

            # ====== ① 管理者：待補總覽 ======
            pg = new_page()
            login(pg, 'pnladm')
            pg.click('[data-nav="pnl"]')
            pg.wait_for_selector(KEEP, state='attached', timeout=10000)
            names = [x.replace('\n', '') for x in pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(names == ['儀表板', '待補', '食材', '人事', '可控', '不可控', '營業收入', '匯入', '設定'], 'admin：九個分頁：%s' % names)
            go(pg, 'pending', 'S01', '2026-08')
            check(total_text(pg) == '本月資料已齊' and count(pg, '[data-role="pnl-acc"]') == 0, 'S01 2026-08 全數已填：「本月資料已齊」、不列任何卡片（%s）' % total_text(pg))
            opts = pg.locator(KEEP + ' [data-role="pnl-store"] option').all_inner_texts()
            check(opts == ['新竹光復', '測試S02'], '門市選單不含 ALL：%s' % opts)
            no_login_form(pg, 'S01 待補')

            go(pg, 'pending', 'S02', '2026-07')
            t0 = total_text(pg)
            n0 = int(t0.replace('本月待補 ', '').replace(' 項', ''))
            check(t0.startswith('本月待補 ') and n0 > 20, '待補總覽頁首：%s' % t0)
            check(count(pg, '[data-role="pnl-nodraft"]') == 1 and '尚未建立草稿' in pg.locator(KEEP + ' [data-role="pnl-nodraft"]').inner_text(), '狀態「無」：提示新增第一筆會自動建立草稿')
            cats = pg.locator(KEEP + ' [data-role="pnl-group"]').evaluate_all("els => els.map(e => e.getAttribute('data-cat'))")
            check(cats[:2] == ['food', 'labor'] and 'uncontrollable' in cats, '依類別分組（食材、人事…）：%s' % cats)
            check(count(pg, '[data-role="pnl-acc"][data-pending="0"]') == 0, '總覽只列待補，不列已填／選填')
            check(count(pg, '[data-act="finalize"]') == 0, '狀態「無」：不顯示定稿鈕')

            # ====== ② 新增明細（含 PNG 附件）======
            a8 = acc('A008')
            pg.click(a8 + ' [data-act="add-toggle"]')
            pg.wait_for_selector(a8 + ' [data-role="pnl-add-form"]')
            check('手續費 NT$15' in pg.locator(a8 + ' [data-role="pnl-add-form"]').inner_text(), '有手續費的科目：金額欄下提示')
            pg.click(a8 + ' [data-act="add-submit"]')
            check('金額必須是' in pg.locator(a8 + ' [data-role="pnl-add-error"]').inner_text() and not calls_of('addEntry'), '空金額：擋下、不送')
            pg.fill(a8 + ' [data-role="pnl-amount"]', '1200')
            pg.fill(a8 + ' [data-role="pnl-split"]', '3')
            hint = pg.locator(a8 + ' [data-role="pnl-split-hint"]').inner_text()
            check('NT$ 400' in hint, '分攤提示：本月認列 400：%s' % hint)
            pg.fill(a8 + ' [data-role="pnl-note"]', 'e2e 備註')
            pg.set_input_files(a8 + ' [data-role="pnl-file"]', heic_path)
            pg.click(a8 + ' [data-act="add-submit"]')
            pg.wait_for_function("(s) => document.querySelector(s).textContent.includes('HEIC')", arg=a8 + ' [data-role="pnl-add-error"]')
            check(not calls_of('uploadAttachment') and not calls_of('addEntry'), 'HEIC：擋下，沒有上傳也沒有新增')
            pg.set_input_files(a8 + ' [data-role="pnl-file"]', png_path)
            pg.click(a8 + ' [data-act="add-submit"]')
            pg.wait_for_function("(t) => document.querySelector('[data-keep=pnl] [data-role=pnl-pending-total]').textContent === t", arg='本月待補 %d 項' % (n0 - 1), timeout=15000)
            check(count(pg, '[data-role="pnl-acc"][data-acc="A008"]') == 0, '待補總覽：填好的科目從清單消失')
            check(len(calls_of('uploadAttachment')) == 1 and len(calls_of('addEntry')) == 1, '附件先上傳、再新增（各一次）')
            ent = live('S02', '2026-07', 'A008')
            check(month_data('S02', '2026-07')['status'] == '草稿', '第一筆新增後自動建立草稿')
            check(len(ent) == 1 and ent[0]['amount'] == 1200 and ent[0]['split_months'] == 3 and ent[0]['note'] == 'e2e 備註' and ent[0]['attach_url'].startswith('pnlfile:'),
                  '後端記下：金額 1200、分攤 3、備註、附件 pnlfile:：%s' % [{k: e.get(k) for k in ('amount', 'split_months', 'note', 'attach_url')} for e in ent])
            check(total_text(pg) == '本月待補 %d 項' % (n0 - 1), '新增後待補少一項：%s' % total_text(pg))
            check(count(pg, '[data-role="pnl-nodraft"]') == 0 and count(pg, '[data-act="finalize"]') == 1, '草稿建立後：提示消失、管理者看得到「定稿」')

            # PDF 附件（A009）
            a9 = acc('A009')
            pg.click(a9 + ' [data-act="add-toggle"]')
            pg.fill(a9 + ' [data-role="pnl-amount"]', '500')
            pg.set_input_files(a9 + ' [data-role="pnl-file"]', pdf_path)
            pg.click(a9 + ' [data-act="add-submit"]')
            pg.wait_for_function("(t) => document.querySelector('[data-keep=pnl] [data-role=pnl-pending-total]').textContent === t", arg='本月待補 %d 項' % (n0 - 2), timeout=15000)
            ent9 = live('S02', '2026-07', 'A009')
            check(len(ent9) == 1 and ent9[0]['attach_url'].startswith('pnlfile:'), 'PDF 照傳：附件存成 pnlfile:')
            a10 = acc('A010')
            pg.click(a10 + ' [data-act="add-toggle"]')
            pg.wait_for_selector(a10 + ' [data-role="pnl-add-form"]')
            pg.click(a10 + ' [data-act="add-cancel"]')
            check(pg.locator(a10 + ' [data-role="pnl-add-form"]').count() == 0, '新增表單「取消」會收起')

            # ====== ③ 查看附件（到食材頁，已填的科目也列）======
            go(pg, 'food', 'S02', '2026-07')
            pg.click(a8 + ' [data-act="view-attach"]')
            pg.wait_for_selector(a8 + ' [data-role="pnl-photo"]')
            pg.wait_for_function("(s) => { const i = document.querySelector(s); return i && i.complete && i.naturalWidth > 0; }", arg=a8 + ' [data-role="pnl-photo"]')
            src = pg.locator(a8 + ' [data-role="pnl-photo"]').get_attribute('src')
            href = pg.locator(a8 + ' [data-role="pnl-attach-link"]').get_attribute('href')
            check(src.startswith('blob:') and href.startswith('blob:'), '附件用 Blob URL 開（不是附件網址）：%s' % src[:30])
            check(len(calls_of('getAttachment')) == 1, '查看附件打了 getAttachment')
            check('pnlfile' not in pg.inner_html(KEEP), '畫面上沒有 pnlfile: 網址')
            pg.click(a9 + ' [data-act="view-attach"]')
            pg.wait_for_selector(a9 + ' [data-role="pnl-attach-link"]')
            check(pg.locator(a9 + ' [data-role="pnl-attach-link"]').get_attribute('href').startswith('blob:')
                  and 'PDF' in pg.locator(a9 + ' [data-role="pnl-attach-link"]').inner_text()
                  and pg.locator(a9 + ' [data-role="pnl-photo"]').count() == 0, 'PDF：Blob 連結、不當圖片')
            pg.click(a8 + ' [data-act="view-attach"]')
            check(pg.locator(a8 + ' [data-role="pnl-photo"]').count() == 0, '再按一次「查看附件」收起')

            # ====== ④ 作廢 ======
            pg.click(a8 + ' [data-act="void"]')
            pg.wait_for_selector('.dialog [data-role="pnl-reason"]')
            pg.click('.dialog .btn-danger')
            pg.wait_for_selector('.toast:has-text("請填原因")')
            check(not calls_of('voidEntry'), '沒填原因：不送作廢')
            pg.fill('.dialog [data-role="pnl-reason"]', 'e2e 填錯')
            pg.click('.dialog .btn-danger')
            pg.wait_for_function("(s) => document.querySelector(s + ' [data-role=pnl-entry]') === null", arg=a8, timeout=15000)
            check(len(calls_of('voidEntry')) == 1, '作廢送出一次')
            check('A008' in month_data('S02', '2026-07')['result']['pending'] and live('S02', '2026-07', 'A008') == [] and count(pg, '[data-role="pnl-acc"][data-acc="A008"][data-pending="1"]') == 1, '後端該筆已作廢；A008 回到待補')
            pg.click(a9 + ' [data-act="void"]')
            pg.wait_for_selector('.dialog')
            pg.click('.dialog .btn-secondary')
            pg.wait_for_timeout(300)
            check(len(calls_of('voidEntry')) == 1, '作廢對話框「取消」不送')

            # ====== ⑤ 確認為 0 ======
            go(pg, 'pending', 'S02', '2026-07')
            check(total_text(pg) == '本月待補 %d 項' % (n0 - 1), '作廢後待補總數：%s' % total_text(pg))
            a11 = acc('A011')
            pg.click(a11 + ' [data-act="confirm-zero"]')
            pg.wait_for_selector('.dialog')
            pg.click('.dialog .btn-secondary')
            pg.wait_for_timeout(300)
            check(not calls_of('confirmZero'), '確認為 0：對話框取消不送')
            pg.click(a11 + ' [data-act="confirm-zero"]')
            pg.wait_for_selector('.dialog')
            pg.click('.dialog .btn-primary')
            pg.wait_for_function("(s) => document.querySelector(s) === null", arg=a11, timeout=15000)
            ent = live('S02', '2026-07', 'A011')
            check(len(calls_of('confirmZero')) == 1 and len(ent) == 1 and ent[0]['amount'] == 0 and '確認為0' in ent[0]['source'],
                  '確認為 0：寫入一筆 0、來源「確認為0」：%s' % [(e['amount'], e['source']) for e in ent])
            check(count(pg, '[data-act="confirm-zero"][data-acc="A016"]') == 1, '連接器科目（過去月份）有「確認為 0」')

            cur = pg.evaluate("() => document.querySelector('[data-keep=pnl] [data-role=pnl-month] option').value")
            go(pg, 'pending', 'S02', cur)
            a8c = acc('A008')
            pg.click(a8c + ' [data-act="add-toggle"]')
            pg.fill(a8c + ' [data-role="pnl-amount"]', '10')
            pg.click(a8c + ' [data-act="add-submit"]')
            pg.wait_for_function("() => document.querySelector('[data-keep=pnl] [data-role=pnl-acc][data-acc=A008]') === null", timeout=15000)
            check(month_data('S02', cur)['status'] == '草稿', '當月第一筆新增也會自動建立草稿')
            check(count(pg, '[data-act="confirm-zero"][data-acc="A011"]') == 1 and count(pg, '[data-act="confirm-zero"][data-acc="A016"]') == 0
                  and count(pg, '[data-role="pnl-acc"][data-acc="A016"]') == 1, '當月（%s）：手動科目有確認為 0、連接器科目沒有' % cur)

            # ====== ⑥ 類別頁 ======
            go(pg, 'food', 'S02', '2026-07')
            blocks = pg.locator(KEEP + ' [data-role="pnl-block"]').evaluate_all("els => els.map(e => e.getAttribute('data-block'))")
            check(blocks == ['食材', '包材'], '食材頁：食材＋包材區塊：%s' % blocks)
            check(count(pg, '[data-role="pnl-acc"][data-pending="0"]') >= 3, '類別頁也列已填的科目')
            go(pg, 'labor', 'S02', '2026-07')
            check(count(pg, '[data-role="pnl-block"][data-block="人事"]') == 1, '人事頁')
            go(pg, 'controllable', 'S02', '2026-07')
            txt = pg.locator(KEEP).inner_text()
            check('固定科目，金額由門市設定值決定' in txt and '公式科目' in txt and '此科目由「匯入」功能寫入整月彙總' in txt and '選填' in txt,
                  '可控頁：固定／公式唯讀、匯入科目說明、選填標示')
            check(count(pg, '[data-role="pnl-acc"] [data-act="add-toggle"]') > 0, '可控頁：手動科目有新增鈕')
            go(pg, 'uncontrollable', 'S02', '2026-07')
            blocks = pg.locator(KEEP + ' [data-role="pnl-block"]').evaluate_all("els => els.map(e => e.getAttribute('data-block'))")
            check(blocks == ['不可控', '營業稅', '營業外收入'], '不可控頁：含營業稅、營業外：%s' % blocks)
            go(pg, 'revenue', 'S02', '2026-07')
            check(count(pg, '[data-role="pnl-block"][data-block="營收"]') == 1, '營業收入頁')
            pg.screenshot(path=os.path.join(out_dir, 'revenue-1280.png'))

            # ====== ⑦ 定稿月份唯讀 ======
            r = backend('finalize', {'store_id': 'S01', 'month': '2026-08', 'zero_confirm': [], 'client_id': 'e2e-fin-1'})
            check(r.get('ok') is True, '準備：後端定稿 S01 2026-08：%s' % str(r)[:80])
            wr = new_page()
            login(wr, 'pnlwr')
            wr.click('[data-nav="pnl"]')
            wr.wait_for_selector(KEEP, state='attached', timeout=10000)
            names = [x.replace('\n', '') for x in wr.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check('待補' in names and '設定' not in names, 'write：看得到填資料分頁、沒有設定：%s' % names)
            go(wr, 'food', 'S01', '2026-08')
            check('已定稿' in wr.locator(KEEP + ' [data-role="pnl-locked"]').inner_text(), '定稿月份：顯示已定稿')
            check(all(count(wr, '[data-act="%s"]' % a) == 0 for a in ('add-toggle', 'void', 'confirm-zero', 'finalize', 'unlock')),
                  '定稿月份對 write：沒有新增／作廢／確認為 0／定稿／解除鈕')
            check(count(wr, '[data-role="pnl-entry"]') > 0, '定稿月份仍看得到明細')
            go(wr, 'food', 'S02', '2026-07')
            check(count(wr, '[data-act="add-toggle"]') > 0 and count(wr, '[data-act="void"]') > 0 and count(wr, '[data-act="finalize"]') == 0, 'write 在草稿月份：能新增／作廢、沒有定稿鈕')
            n_before = len(calls_of('addEntry'))
            a12 = acc('A012')
            wr.click(a12 + ' [data-act="add-toggle"]')
            wr.fill(a12 + ' [data-role="pnl-amount"]', '77')
            wr.click(a12 + ' [data-act="add-submit"]')
            wr.wait_for_selector(a12 + ' [data-role="pnl-entry"]', timeout=15000)
            check(len(calls_of('addEntry')) == n_before + 1, 'write 能新增明細')
            wr.set_viewport_size({'width': 375, 'height': 800})
            go(wr, 'food', 'S02', '2026-07')
            wr.screenshot(path=os.path.join(out_dir, 'food-375.png'))
            sw = wr.evaluate("() => document.documentElement.scrollWidth")
            check(sw <= 376, '375px 寬：沒有橫向捲動（scrollWidth=%s）' % sw)
            wr.context.close()

            # 管理者：解除定稿、再定稿
            go(pg, 'food', 'S01', '2026-08')
            check(count(pg, '[data-act="unlock"]') == 1 and count(pg, '[data-act="add-toggle"]') == 0, 'admin 在定稿月份：只有「解除定稿」，沒有新增鈕')
            pg.click(KEEP + ' [data-act="unlock"]')
            pg.wait_for_selector('.dialog [data-role="pnl-reason"]')
            pg.click('.dialog .btn-danger')
            pg.wait_for_selector('.toast:has-text("請填原因")')
            check(not calls_of('unlock'), '解除定稿沒填原因：不送')
            pg.fill('.dialog [data-role="pnl-reason"]', 'e2e 解除')
            pg.click('.dialog .btn-danger')
            pg.wait_for_selector(KEEP + ' [data-act="finalize"]', timeout=15000)
            check(month_data('S01', '2026-08')['status'] == '草稿' and count(pg, '[data-act="add-toggle"]') > 0, '解除後：後端回草稿、可新增')
            pg.click(KEEP + ' [data-act="finalize"]')
            pg.wait_for_selector('.dialog')
            pg.click('.dialog .btn-danger')
            pg.wait_for_selector(KEEP + ' [data-act="unlock"]', timeout=15000)
            check(month_data('S01', '2026-08')['status'] == '定稿', '從畫面定稿：後端回定稿')

            # 定稿面板：有待補科目要逐項勾選
            n_fin = len(calls_of('finalize'))
            go(pg, 'food', 'S02', '2026-07')
            pg.click(KEEP + ' [data-act="finalize"]')
            pg.wait_for_selector('.dialog [data-role="pnl-zero-cb"]')
            pg.click('.dialog .btn-danger')
            pg.wait_for_selector('.toast:has-text("尚未勾選確認")')
            check(len(calls_of('finalize')) == n_fin, '待補科目沒勾完：不送定稿')
            pg.keyboard.press('Escape')
            no_login_form(pg, '填資料各頁')
            pg.context.close()
            browser.close()
        check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        httpd.shutdown()


if __name__ == '__main__':
    main()
