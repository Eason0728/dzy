#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ㉒：損益試算原生化 — 設定頁（T17＋T18）。真的損益後端（pnl_backend.mjs，埠 18924）＋站台埠 8834，零真實資料。
驗：write／read 看不到設定分頁；admin 十一個區塊每顆按鈕都點過（門市、科目、門市科目、連接器、匯入範本、系統設定、使用者、
月份作業含排隊進度、異動紀錄、匯出 CSV、維護區預覽→確認）；金鑰欄不是 password；沒有登入框；mock.leaked == []。"""
import csv
import io
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import USERS, MockBackend, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT, BPORT = 8834, 18924
KEY = 'test-dzy-key-0123456789abcdef'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SET = '[data-role="pnl-settings"]'


def backend(inner, payload, level='admin', account='E2EX'):
    body = {'action': 'dzyProxy', 'key': KEY, 'level': level, 'account': account, 'operator': 'e2e', 'inner': inner, 'payload': payload}
    req = urllib.request.Request('http://127.0.0.1:%d/pnl/api' % BPORT, data=json.dumps(body).encode(), headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode())


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
        out_dir = tempfile.mkdtemp(prefix='pnl-settings-e2e-')

        with sync_playwright() as p:
            browser = p.chromium.launch()

            def new_page(user, w=1280, h=900):
                ctx = browser.new_context(viewport={'width': w, 'height': h}, accept_downloads=True)
                pg = ctx.new_page()
                mock.install(pg)
                pg.goto(base + '/index.html')
                pg.fill('#login-username', user)
                pg.fill('#login-password', USERS[user]['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)
                return pg

            def tabs(pg):
                return [x.replace('\n', '') for x in pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]

            def open_pnl(pg):
                pg.click('[data-nav="pnl"]')
                pg.wait_for_selector('[data-keep="pnl"] [data-role]', timeout=15000)

            def open_settings(pg):
                open_pnl(pg)
                pg.locator('[data-role="view-nav"] .nav-item', has_text='設定').click()
                pg.wait_for_selector(SET + ' [data-role="pnl-set-nav"]')
                pg.wait_for_selector(SET + ' [data-role="pnl-set-stores"]', timeout=15000)

            def tab(pg, label):
                pg.locator(SET + ' [data-role="pnl-set-tab"]', has_text=label).first.click()

            def dlg(pg, label):
                pg.locator('.dialog button', has_text=label).click()
                pg.wait_for_selector('.dialog', state='detached')

            def toast_has(pg, text):
                pg.wait_for_selector('.toast:has-text("%s")' % text, timeout=15000)

            def no_login_form(pg, where):
                check(pg.locator('input[type=password]').count() == 0, '%s：畫面沒有登入表單／密碼欄' % where)

            def settings_after_reload(pg):
                pg.reload()
                open_settings(pg)

            # ====== ① write／read 看不到設定 ======
            for who, expect in (('pnlwr', False), ('pnlrd', False)):
                pg = new_page(who)
                open_pnl(pg)
                names = tabs(pg)
                check('設定' not in names, '%s 看不到設定分頁：%s' % (who, names))
                no_login_form(pg, who)
                pg.wait_for_timeout(1200)   # 讓影子帳號建起來（getSettings 已打）
                pg.context.close()

            # ====== ② admin 進設定 ======
            pg = new_page('pnladm')
            open_pnl(pg)
            names = tabs(pg)
            check(names == ['儀表板', '待補', '食材', '人事', '可控', '不可控', '營業收入', '匯入', '設定'], 'admin 九個分頁：%s' % names)
            open_settings(pg)
            no_login_form(pg, 'admin 設定頁')
            sec_tabs = pg.locator(SET + ' [data-role="pnl-set-tab"]').all_inner_texts()
            check(sec_tabs == ['門市', '科目', '門市科目', '連接器', '匯入範本', '系統設定', '使用者', '月份作業', '異動紀錄', '匯出 CSV', '維護'], '設定十一個區塊：%s' % sec_tabs)

            # ====== ③ 門市 ======
            rows = pg.locator(SET + ' [data-role="pnl-set-stores"] [data-role="pnl-set-row"]')
            check(rows.count() >= 2, '門市列表有光復與測試店：%d 列' % rows.count())
            brand_opts = pg.locator(SET + ' select[data-f="brand"]').first.locator('option').all_inner_texts()
            check(brand_opts == ['（未設）', '鼎兆元', '墨竹亭', '小辛辣'], '品牌下拉三選一：%s' % brand_opts)
            type_opts = pg.locator(SET + ' select[data-f="unit_type"]').first.locator('option').all_inner_texts()
            check(type_opts == ['（未設）', '總部', '門市', '央廚'], '類型下拉：%s' % type_opts)
            s02 = pg.locator(SET + ' [data-role="pnl-set-row"][data-id="S02"]')
            s02.locator('[data-f="name"]').fill('測試二店')
            s02.locator('[data-f="brand"]').select_option('墨竹亭')
            s02.locator('[data-f="unit_type"]').select_option('門市')
            s02.locator('[data-f="active"]').uncheck()
            s02.locator('[data-f="active"]').check()
            pg.click(SET + ' [data-act="store-add"]')
            check(pg.locator(SET + ' [data-role="pnl-set-row"][data-id="S03"]').count() == 1, '新增門市出現 S03')
            pg.click(SET + ' [data-role="pnl-set-row"][data-id="S03"] [data-act="store-del"]')
            check(pg.locator(SET + ' [data-role="pnl-set-row"][data-id="S03"]').count() == 0, '移除新增的 S03')
            pg.click(SET + ' [data-act="store-add"]')
            pg.click(SET + ' [data-act="store-save"]')   # S03 沒填名稱
            check('名稱必填' in pg.locator(SET + ' [data-role="pnl-set-err"]').inner_text(), '名稱沒填：擋下並提示')
            pg.locator(SET + ' [data-role="pnl-set-row"][data-id="S03"] [data-f="name"]').fill('第三店')
            pg.click(SET + ' [data-act="store-save"]')
            pg.wait_for_selector('.dialog [data-role="pnl-set-diff"]')
            dt = pg.locator('.dialog').inner_text()
            check('新增（1）' in dt and '修改（1）' in dt and 'S03' in dt and 'S02' in dt, '存檔預覽：新增 1、修改 1：%s' % dt.replace('\n', ' ')[:80])
            dlg(pg, '取消')
            check(backend('getSettings', {})['data']['stores'][1]['name'] != '測試二店', '取消後沒有寫入')
            pg.click(SET + ' [data-act="store-save"]')
            pg.wait_for_selector('.dialog [data-role="pnl-set-diff"]')
            dlg(pg, '確認存檔')
            toast_has(pg, '門市已存檔')
            st = backend('getSettings', {})['data']['stores']
            check([x['name'] for x in st] [1:] == ['測試二店', '第三店'] and st[1]['brand'] == '墨竹亭' and st[1]['unit_type'] == '門市', '門市存檔後後端：%s' % [(x['store_id'], x['name'], x['brand']) for x in st])
            # 群組單位
            pg.click(SET + ' [data-act="group-units"]')
            pg.wait_for_selector('.dialog')
            dlg(pg, '確認載入')
            toast_has(pg, '已載入集團單位清單')
            pg.wait_for_selector(SET + ' [data-role="pnl-set-row"][data-id="S10"]', timeout=10000)
            check(pg.locator(SET + ' [data-role="pnl-set-row"][data-id="S10"] [data-f="active"]').is_checked() is False, '載入集團單位清單：新單位 S10 預設停用')
            tab(pg, '科目'); tab(pg, '門市')

            # ====== ④ 科目 ======
            tab(pg, '科目')
            arows = pg.locator(SET + ' [data-role="pnl-set-accounts"] [data-role="pnl-set-row"]')
            check(arows.count() > 10, '科目列表：%d 列' % arows.count())
            first = arows.first
            first_id = first.get_attribute('data-id')
            first.locator('[data-f="name"]').fill('改名科目')
            first.locator('[data-f="sort"]').fill('999')
            first.locator('[data-f="in_pnl"]').uncheck(); first.locator('[data-f="in_pnl"]').check()
            first.locator('[data-f="active"]').uncheck(); first.locator('[data-f="active"]').check()
            first.locator('[data-f="block"]').select_option(first.locator('[data-f="block"]').input_value())
            pg.click(SET + ' [data-act="acc-add"]')
            newid = pg.locator(SET + ' [data-role="pnl-set-accounts"] [data-role="pnl-set-row"]').last.get_attribute('data-id')
            last = pg.locator(SET + ' [data-role="pnl-set-row"][data-id="%s"]' % newid)
            last.locator('[data-f="name"]').fill('測試公式')
            last.locator('[data-f="mode"]').select_option('公式')
            check(last.locator('[data-f="p.formula"]').count() == 1, '取值方式改公式：出現公式欄')
            last.locator('[data-f="p.formula"]').fill('A001+')
            pg.click(SET + ' [data-act="acc-save"]')
            pg.wait_for_selector(SET + ' [data-role="pnl-acc-err"]')
            check('公式語法錯' in pg.locator(SET + ' [data-role="pnl-acc-err"]').first.inner_text(), '壞公式：列下方紅字，不送出')
            last = pg.locator(SET + ' [data-role="pnl-set-row"][data-id="%s"]' % newid)
            last.locator('[data-f="p.formula"]').fill('A001*2')
            last.locator('[data-f="p.optional"]').check()
            last.locator('[data-f="mode"]').select_option('手動')
            check(last.locator('[data-f="p.carry_from"]').count() == 1 and last.locator('[data-f="p.sign"]').count() == 1, '手動：sign／fee／carry_from 欄')
            last.locator('[data-f="p.sign"]').select_option('-1'); last.locator('[data-f="p.fee"]').fill('5')
            last.locator('[data-f="p.carry_from"]').select_option(first_id)
            last.locator('[data-f="mode"]').select_option('固定')
            pg.click(SET + ' [data-act="acc-save"]')
            pg.wait_for_selector('.dialog [data-role="pnl-set-diff"]')
            dt = pg.locator('.dialog').inner_text()
            check('影響所有月份' in dt and '新增（1）' in dt, '科目預覽：紅字影響範圍、新增 1：%s' % dt.replace('\n', ' ')[:100])
            dlg(pg, '確認存檔')
            toast_has(pg, '科目已存檔')
            acc = {a['acc_id']: a for a in backend('getSettings', {})['data']['accounts']}
            check(acc[first_id]['name'] == '改名科目' and acc[first_id]['sort'] == 999 and acc[newid]['mode'] == '固定', '科目存檔後後端：%s／%s' % (acc[first_id]['name'], acc[newid]['mode']))
            pg.click(SET + ' [data-role="pnl-set-row"][data-id="%s"] [data-act="acc-del"]' % newid)
            check(pg.locator(SET + ' [data-role="pnl-set-row"][data-id="%s"]' % newid).count() == 0, '移除科目')
            # 把名稱改回去並存（不留下刪除，之後門市科目要用固定科目）
            pg.click(SET + ' [data-act="acc-add"]')
            nid = pg.locator(SET + ' [data-role="pnl-set-accounts"] [data-role="pnl-set-row"]').last.get_attribute('data-id')
            check(nid == newid, '新增科目 id 流水號接續：%s' % nid)
            r2 = pg.locator(SET + ' [data-role="pnl-set-row"][data-id="%s"]' % nid)
            r2.locator('[data-f="name"]').fill('測試固定費'); r2.locator('[data-f="mode"]').select_option('固定')
            pg.click(SET + ' [data-act="acc-save"]')
            pg.wait_for_selector('.dialog [data-role="pnl-set-diff"]'); dlg(pg, '確認存檔'); toast_has(pg, '科目已存檔')

            # ====== ⑤ 門市科目 ======
            tab(pg, '門市科目')
            pg.select_option(SET + ' [data-role="pnl-sa-store"]', 'S01')
            row = pg.locator(SET + ' [data-role="pnl-set-storeaccounts"] [data-role="pnl-set-row"][data-id="%s"]' % nid)
            row.locator('[data-k="fixed_amount"]').fill('12345')
            row.locator('[data-k="amort_total"]').fill('1200')
            row.locator('[data-k="amort_months"]').fill('12')
            pg.click(SET + ' [data-act="sa-save"]')
            check('必填起月' in pg.locator(SET + ' [data-role="pnl-set-err"]').inner_text(), '有攤提月數沒填起月：擋下')
            row.locator('[data-k="from_month"]').fill('2026-08'); row.locator('[data-k="to_month"]').fill('2027-07')
            pg.click(SET + ' [data-act="sa-save"]')
            pg.wait_for_selector('.dialog [data-role="pnl-set-diff"]'); dlg(pg, '確認存檔'); toast_has(pg, '門市固定值已存檔')
            sa = [x for x in backend('getSettings', {})['data']['storeAccounts'] if x['acc_id'] == nid]
            check(len(sa) == 1 and sa[0]['fixed_amount'] == 12345 and sa[0]['from_month'] == '2026-08', '門市科目存檔後後端：%s' % sa)
            pg.click(SET + ' [data-role="pnl-set-row"][data-id="%s"] [data-act="sa-clear"]' % nid)
            check(pg.locator(SET + ' [data-role="pnl-set-row"][data-id="%s"] [data-k="fixed_amount"]' % nid).input_value() == '', '清空這列')
            pg.click(SET + ' [data-act="sa-save"]')
            pg.wait_for_selector('.dialog [data-role="pnl-set-diff"]')
            check('刪除（1）' in pg.locator('.dialog').inner_text(), '清空後預覽顯示刪除 1')
            dlg(pg, '確認存檔'); toast_has(pg, '門市固定值已存檔')

            # ====== ⑥ 連接器 ======
            tab(pg, '連接器')
            pg.click(SET + ' [data-act="conn-add"]')
            crow = pg.locator(SET + ' [data-role="pnl-set-connectors"] [data-role="pnl-set-row"]').last
            crow.locator('[data-f="name"]').fill('測試現金帳')
            crow.locator('[data-f="newUrl"]').fill('Eason')
            check('is-invalid' in (crow.locator('[data-f="newUrl"]').get_attribute('class') or ''), '無效 URL（Eason）：輸入框標紅')
            key_in = crow.locator('[data-f="key"]')
            check(key_in.get_attribute('type') == 'text' and pg.locator(SET + ' input[type=password]').count() == 0, '金鑰欄 type=text、頁面沒有 password 欄')
            ts = key_in.evaluate('e => getComputedStyle(e).webkitTextSecurity')
            check(ts == 'disc', '金鑰欄遮罩 -webkit-text-security: %s' % ts)
            key_in.fill('SECRET-KEY-1')
            pg.click(SET + ' [data-act="conn-save"]')
            check('URL 必須是' in pg.locator(SET + ' [data-role="pnl-set-err"]').inner_text(), '無效 URL：存檔被擋、提示')
            crow.locator('[data-f="newUrl"]').fill('http://127.0.0.1:18801/cashbook/api')
            check('is-invalid' not in (crow.locator('[data-f="newUrl"]').get_attribute('class') or ''), '本機 http URL 有效')
            crow.locator('[data-f="type"]').select_option('transfer')
            crow.locator('[data-f="type"]').select_option('cashbook')
            crow.locator('[data-f="store_id"]').select_option('S01')
            crow.locator('[data-f="active"]').uncheck(); crow.locator('[data-f="active"]').check()
            pg.click(SET + ' [data-act="mk-add"]')
            mrow = pg.locator(SET + ' [data-role="pnl-set-maprow"]').last
            mrow.locator('[data-f="mk-sel"]').select_option('__custom__')
            mrow.locator('[data-f="mk-custom"]').fill('expense.新科目')
            mrow = pg.locator(SET + ' [data-role="pnl-set-maprow"]').last
            mrow.locator('[data-f="mk-sel"]').select_option('expense.食材')
            opts = mrow.locator('[data-f="mv-acc"] option').all_inner_texts()
            if len(opts) > 1:
                mrow.locator('[data-f="mv-acc"]').select_option(index=1)
            pg.click(SET + ' [data-act="mk-add"]')
            pg.locator(SET + ' [data-act="mk-del"]').last.click()
            pg.click(SET + ' [data-act="conn-save"]')
            pg.wait_for_selector('.dialog [data-role="pnl-set-diff"]')
            dt = pg.locator('.dialog').inner_text()
            check('新增（1）' in dt and '金鑰將更新' in dt and 'SECRET-KEY-1' not in dt, '連接器預覽：不顯示金鑰：%s' % dt.replace('\n', ' ')[:90])
            dlg(pg, '確認存檔'); toast_has(pg, '連接器已存檔')
            conns = backend('getSettings', {})['data']['connectors']
            c = [x for x in conns if x['name'] == '測試現金帳']
            check(len(c) == 1 and c[0]['url_set'] and c[0]['key'] == '***' and c[0]['store_id'] == 'S01' and 'expense.食材' in c[0]['mapping'], '連接器存檔後後端（金鑰不回傳）：%s' % c)
            crow = pg.locator(SET + ' [data-role="pnl-set-row"][data-id="測試現金帳"]')
            check('已設定' in crow.inner_text() and '127.0.0.1:18801' in crow.inner_text() and crow.locator('[data-f="key"]').input_value() == '', '存檔後畫面：已設定、網域顯示、金鑰欄清空')
            # 只改啟用不動金鑰：送 ***
            crow.locator('[data-f="active"]').uncheck()
            pg.click(SET + ' [data-act="conn-save"]'); pg.wait_for_selector('.dialog [data-role="pnl-set-diff"]'); dlg(pg, '確認存檔'); toast_has(pg, '連接器已存檔')
            c = [x for x in backend('getSettings', {})['data']['connectors'] if x['name'] == '測試現金帳'][0]
            check(c['active'] is False and c['url_set'], '金鑰沒改送 ***：連接器仍保留 URL（active=False）')
            pg.click(SET + ' [data-role="pnl-set-row"][data-id="測試現金帳"] [data-act="conn-del"]')
            pg.click(SET + ' [data-act="conn-save"]'); pg.wait_for_selector('.dialog [data-role="pnl-set-diff"]')
            check('刪除（1）' in pg.locator('.dialog').inner_text(), '移除連接器：預覽刪除 1')
            dlg(pg, '確認存檔'); toast_has(pg, '連接器已存檔')

            # ====== ⑦ 匯入範本 ======
            tab(pg, '匯入範本')
            pg.click(SET + ' [data-act="tpl-add"]')
            tp = pg.locator(SET + ' [data-role="pnl-set-templates"] [data-role="pnl-set-row"]').last
            tid = tp.get_attribute('data-id')
            tp.locator('[data-f="name"]').fill('測試範本'); tp.locator('[data-f="file_type"]').fill('xls')
            tp.locator('[data-f="header_row"]').fill('2'); tp.locator('[data-f="date_col"]').fill('日期')
            tp.locator('[data-f="amount_col"]').fill('金額'); tp.locator('[data-f="group_col"]').fill('科目')
            pg.click(SET + ' [data-act="tpl-save"]')
            check('至少要有一條對應' in pg.locator(SET + ' [data-role="pnl-set-err"]').inner_text(), '沒有對應：擋下')
            tp.locator('[data-f="direct"]').check()
            check('直接當科目代號' in tp.inner_text() and tp.locator('[data-f="map-val"]').count() == 0, '勾「分組欄的值就是科目代號」：不用逐列對應')
            tp.locator('[data-f="direct"]').uncheck()
            tp = pg.locator(SET + ' [data-role="pnl-set-row"][data-id="%s"]' % tid)
            tp.locator('[data-act="map-add"]').click()
            tp.locator('[data-act="map-add"]').click()
            check(tp.locator('[data-role="pnl-set-maprow"]').count() == 2, '新增兩組對應')
            tp.locator('[data-fc="map-key"]').nth(0).fill('食材*'); tp.locator('[data-fc="map-key"]').nth(0).blur()
            tp.locator('[data-fc="map-key"]').nth(1).fill('食材*'); tp.locator('[data-fc="map-key"]').nth(1).blur()
            toast_has(pg, '已經是這個範本裡的另一組對應')
            tp.locator('[data-fc="map-key"]').nth(1).fill('其他'); tp.locator('[data-fc="map-key"]').nth(1).blur()
            tp = pg.locator(SET + ' [data-role="pnl-set-row"][data-id="%s"]' % tid)
            tp.locator('[data-f="map-val"]').nth(0).select_option(index=1)
            pg.click(SET + ' [data-act="tpl-save"]')
            check('尚未選科目' in pg.locator(SET + ' [data-role="pnl-set-err"]').inner_text(), '對應沒選科目：擋下')
            tp.locator('[data-act="map-del"]').nth(1).click()
            pg.click(SET + ' [data-act="tpl-save"]'); pg.wait_for_selector('.dialog [data-role="pnl-set-diff"]'); dlg(pg, '確認存檔'); toast_has(pg, '匯入範本已存檔')
            t = [x for x in backend('getSettings', {})['data']['templates'] if x['tpl_id'] == tid]
            check(len(t) == 1 and t[0]['header_row'] == 2 and list(t[0]['mapping'].keys()) == ['食材*'], '範本存檔後後端：%s' % t)
            pg.click(SET + ' [data-role="pnl-set-row"][data-id="%s"] [data-act="tpl-del"]' % tid)
            pg.click(SET + ' [data-act="tpl-save"]'); pg.wait_for_selector('.dialog [data-role="pnl-set-diff"]')
            check('刪除（1）' in pg.locator('.dialog').inner_text(), '移除範本：預覽刪除 1')
            dlg(pg, '確認存檔'); toast_has(pg, '匯入範本已存檔')

            # ====== ⑧ 系統設定 ======
            tab(pg, '系統設定')
            pg.fill('#pnl-sys-color', 'red')
            pg.click(SET + ' [data-act="sys-save"]')
            check('#RRGGBB' in pg.locator(SET + ' [data-role="pnl-set-err"]').inner_text(), '主色格式錯：擋下')
            pg.fill('#pnl-sys-name', '損益測試'); pg.fill('#pnl-sys-color', '#112233')
            pg.click(SET + ' [data-act="sys-save"]'); pg.wait_for_selector('.dialog [data-role="pnl-set-diff"]'); dlg(pg, '確認存檔'); toast_has(pg, '系統設定已存檔')
            sy = backend('getSettings', {})['data']['system']
            check(sy.get('系統名稱') == '損益測試' and sy.get('主色') == '#112233', '系統設定存檔後後端：%s' % sy)

            # ====== ⑨ 使用者（只列管理系統帳號、只能改可看門市）======
            tab(pg, '使用者')
            urows = pg.locator(SET + ' [data-role="pnl-set-users"] [data-role="pnl-set-row"]')
            unames = [urows.nth(i).get_attribute('data-id') for i in range(urows.count())]
            check(len(unames) >= 3 and all(n.startswith('管理系統:') for n in unames), '只列「管理系統:」帳號：%s' % unames)
            check(pg.locator(SET + ' [data-role="pnl-set-users"] [data-act="user-add"], ' + SET + ' [data-role="pnl-set-users"] [data-act="user-del"]').count() == 0 and
                  pg.locator(SET + ' [data-role="pnl-set-users"]').inner_text().count('通行碼') == 0 and pg.locator(SET + ' [data-role="pnl-set-users"]').inner_text().count('邀請碼') == 0,
                  '沒有新增／刪除／通行碼／邀請碼')
            rd = [r for r in range(urows.count()) if '檢視者' in urows.nth(r).inner_text().split('\n')[1:3].__str__() or urows.nth(r).locator('td').nth(1).inner_text() == '檢視者']
            check(len(rd) == 1, '有一位檢視者影子帳號')
            vrow = urows.nth(rd[0])
            vrow.locator('[data-f="uall"]').uncheck()
            vrow.locator('[data-f="ustore"][data-v="S01"]').check()
            check('看不到全部合計' in pg.locator(SET + ' [data-role="pnl-set-users"] [data-role="pnl-set-row"]').nth(rd[0]).locator('[data-role="pnl-user-note"]').inner_text(), '勾個別門市：提示看不到全部合計')
            wr = [r for r in range(urows.count()) if urows.nth(r).locator('td').nth(1).inner_text() == '填寫者']
            wrow = urows.nth(wr[0])
            wrow.locator('[data-f="uall"]').uncheck()
            pg.click(SET + ' [data-act="user-save"]')
            check('至少要選一家' in pg.locator(SET + ' [data-role="pnl-set-err"]').inner_text(), '填寫者沒勾門市：擋下')
            pg.locator(SET + ' [data-role="pnl-set-users"] [data-role="pnl-set-row"]').nth(wr[0]).locator('[data-f="uall"]').check()
            pg.click(SET + ' [data-act="user-save"]'); pg.wait_for_selector('.dialog [data-role="pnl-set-diff"]')
            dt = pg.locator('.dialog').inner_text()
            check('修改（1）' in dt, '使用者預覽：修改 1：%s' % dt.replace('\n', ' ')[:80])
            dlg(pg, '確認存檔'); toast_has(pg, '使用者已存檔')
            us = backend('getSettings', {})['data']['users']
            check(any(u['role'] == '檢視者' and u['stores'] == ['S01'] for u in us) and all(u['name'] for u in us), '使用者存檔後後端：%s' % [(u['name'], u['role'], u['stores']) for u in us])
            check(sum(1 for u in us if u['role'] == '管理者') >= 1, '整表送出沒有弄丟其他帳號（含管理者）')

            # ====== ⑩ 月份作業 ======
            tab(pg, '月份作業')
            # 建立草稿（S02 2026-09，排隊）
            pg.select_option('[data-role="pnl-create-store"]', 'S02')
            pg.fill('[data-role="pnl-create-month"]', '2026-09')
            pg.click('[data-act="create-draft"]')
            pg.wait_for_function("() => /排隊中|執行中/.test(document.querySelector('[data-role=pnl-say-create]').textContent)", timeout=10000)
            check(True, '建立草稿：畫面顯示「排隊中／執行中」進度')
            pg.wait_for_function("() => /草稿已建立|月份已存在/.test(document.querySelector('[data-role=pnl-say-create]').textContent)", timeout=60000)
            txt = pg.locator('[data-role="pnl-say-create"]').inner_text()
            check('S02 2026-09' in txt, '建立草稿完成：%s' % txt)
            m = backend('getMonth', {'store_id': 'S02', 'month': '2026-09'})
            check(m['data']['status'] == '草稿', '後端 S02 2026-09 狀態＝草稿')
            # 重新帶入固定值
            pg.click('[data-act="refresh-fixed"]')
            pg.wait_for_selector('.dialog'); dlg(pg, '取消')
            pg.click('[data-act="refresh-fixed"]'); pg.wait_for_selector('.dialog'); dlg(pg, '確認重新帶入')
            pg.wait_for_function("() => /更新 \\d+、補寫 \\d+/.test(document.querySelector('[data-role=pnl-say-fixed]').textContent)", timeout=30000)
            check('S02 2026-09' in pg.locator('[data-role="pnl-say-fixed"]').inner_text(), '重新帶入固定值結果：%s' % pg.locator('[data-role="pnl-say-fixed"]').inner_text()[:80])
            # 立即拉取連接器
            pg.select_option('[data-role="pnl-refresh-store"]', 'S01')
            pg.fill('[data-role="pnl-refresh-month"]', '2026-08')
            pg.click('[data-act="refresh-conn"]')
            pg.wait_for_function("() => /排隊中|執行中/.test(document.querySelector('[data-role=pnl-say-refresh]').textContent)", timeout=10000)
            pg.wait_for_function("() => /共 \\d+ 個連接器/.test(document.querySelector('[data-role=pnl-say-refresh]').textContent)", timeout=60000)
            check('S01 2026-08' in pg.locator('[data-role="pnl-say-refresh"]').inner_text(), '立即拉取完成：%s' % pg.locator('[data-role="pnl-say-refresh"]').inner_text())
            # 定稿／解除
            pg.select_option('[data-role="pnl-fin-store"]', 'S02'); pg.select_option('[data-role="pnl-fin-month"]', '2026-09')
            pg.click('[data-act="fin-load"]')
            pg.wait_for_selector('[data-role="pnl-fin-status"]')
            check('草稿' in pg.locator('[data-role="pnl-fin-status"]').inner_text(), '查看狀態：草稿')
            pend = pg.locator('[data-f="fin-zero"]').count()
            pg.click('[data-act="fin-do"]')
            if pend:
                check('尚未勾選' in pg.locator('[data-role="pnl-say-fin"]').inner_text(), '待補科目沒勾：擋下（%d 項）' % pend)
                for i in range(pend):
                    pg.locator('[data-f="fin-zero"]').nth(i).check()
                pg.click('[data-act="fin-do"]')
            toast_has(pg, '已定稿')
            pg.wait_for_selector('[data-role="pnl-fin-unlock"]')
            check(backend('getMonth', {'store_id': 'S02', 'month': '2026-09'})['data']['status'] == '定稿', '後端狀態＝定稿')
            pg.click('[data-act="fin-unlock"]'); pg.wait_for_selector('.dialog'); dlg(pg, '取消')
            pg.click('[data-act="fin-unlock"]'); pg.wait_for_selector('.dialog [data-role="pnl-set-reason"]')
            dlg(pg, '確定')
            check('請填解除定稿的原因' in pg.locator('[data-role="pnl-say-fin"]').inner_text(), '解除定稿沒填原因：擋下')
            pg.click('[data-act="fin-unlock"]'); pg.wait_for_selector('.dialog [data-role="pnl-set-reason"]')
            pg.fill('.dialog [data-role="pnl-set-reason"]', 'e2e 測試'); dlg(pg, '確定')
            toast_has(pg, '已解除定稿')
            check(backend('getMonth', {'store_id': 'S02', 'month': '2026-09'})['data']['status'] == '草稿', '後端狀態＝草稿（已解除）')
            pg.select_option('[data-role="pnl-fin-month"]', '2026-01'); pg.click('[data-act="fin-load"]')
            pg.wait_for_selector('[data-role="pnl-fin-status"]:has-text("尚無這個月份")')
            check(True, '沒建過的月份：提示先建草稿')

            # ====== ⑪ 異動紀錄 ======
            tab(pg, '異動紀錄')
            lrows = pg.locator(SET + ' [data-role="pnl-set-logrow"]')
            check(lrows.count() >= 10, '異動紀錄列出本次做過的存檔與作業：%d 筆' % lrows.count())
            lt = pg.locator(SET + ' [data-role="pnl-set-log"]').inner_text()
            check('存檔：門市' in lt and '建立草稿' in lt and '解除定稿' in lt, '紀錄內容含存檔／建草稿／解除定稿')
            pg.click('[data-act="log-clear"]')
            check(pg.locator(SET + ' [data-role="pnl-set-logrow"]').count() == 0, '清除畫面上的紀錄')

            # ====== ⑫ 匯出 CSV ======
            tab(pg, '匯出 CSV')
            pg.select_option('[data-role="pnl-export-store"]', 'S01'); pg.select_option('[data-role="pnl-export-month"]', '2026-08')
            with pg.expect_download() as dl:
                pg.click('[data-act="export-csv"]')
            d = dl.value
            path = os.path.join(out_dir, d.suggested_filename)
            d.save_as(path)
            raw = open(path, 'rb').read()
            text = raw.decode('utf-8')
            rows_csv = list(csv.reader(io.StringIO(text.lstrip('\ufeff'))))
            exp = backend('exportEntries', {'store_id': 'S01', 'month': '2026-08'})['data']['entries']
            check(d.suggested_filename.startswith('明細_') and d.suggested_filename.endswith('_2026-08.csv'), 'CSV 檔名：%s' % d.suggested_filename)
            check(raw[:3] == b'\xef\xbb\xbf' and b'\r\n' in raw and rows_csv[0][0] == '門市' and len(rows_csv[0]) == 14, 'CSV：BOM、CRLF、14 欄表頭')
            check(len(rows_csv) - 1 == len(exp) and len(exp) > 0, 'CSV 筆數＝後端 exportEntries（%d 筆）' % len(exp))
            pg.select_option('[data-role="pnl-export-store"]', 'ALL')
            with pg.expect_download() as dl2:
                pg.click('[data-act="export-csv"]')
            check('全部' in dl2.value.suggested_filename, '全部門市也能匯出：%s' % dl2.value.suggested_filename)

            # ====== ⑬ 維護 ======
            tab(pg, '維護')
            pg.click('[data-act="maint-selfcheck"]')
            pg.wait_for_selector('[data-role="pnl-selfcheck-result"] .tag')
            sc = pg.locator('[data-role="pnl-selfcheck-result"]').inner_text()
            check('Mac mini' in sc and '明細' in sc, '自我檢查結果顯示：%s' % sc.replace('\n', ' ')[:70])
            def preview_flow(btn, key, confirm, done_re):
                """點預覽鈕 → 等差異（對話框或已一致）→ 回 (預覽文字, 有沒有對話框)"""
                pg.click(btn)
                pg.wait_for_function("(k) => document.querySelector('.dialog') || /已一致|不需要|驗證不通過|失敗|錯/.test(document.querySelector('[data-role=pnl-say-' + k + ']').textContent)", arg=key, timeout=30000)
                has = pg.locator('.dialog').count() > 0
                return pg.locator('[data-role="pnl-say-%s"]' % key).inner_text(), has

            before = backend('getSettings', {})['data']['accounts']
            txt, has = preview_flow('[data-act="maint-sync-safe"]', 'sync', '確認同步', '')
            check('新增' in txt, '保守同步預覽文字：%s' % txt[:90])
            if has:
                dlg(pg, '取消')
                check(backend('getSettings', {})['data']['accounts'] == before, '保守同步預覽後取消：科目沒變')
                txt, has = preview_flow('[data-act="maint-sync-safe"]', 'sync', '確認同步', '')
                dlg(pg, '確認同步')
                pg.wait_for_function("() => /已同步/.test(document.querySelector('[data-role=pnl-say-sync]').textContent)", timeout=30000)
                check(True, '保守同步確認後寫入：%s' % pg.locator('[data-role="pnl-say-sync"]').inner_text()[:60])
            else:
                check(True, '保守同步：已一致，不需要變更')
            txt, has = preview_flow('[data-act="maint-sync-full"]', 'sync', '確認同步', '')
            check('完整同步' in txt, '完整同步預覽文字：%s' % txt[:90])
            if has:
                dlg(pg, '確認同步')
                pg.wait_for_function("() => document.querySelector('.dialog') || /已同步/.test(document.querySelector('[data-role=pnl-say-sync]').textContent)", timeout=30000)
                if pg.locator('.dialog').count():
                    check('已定稿月份' in pg.locator('.dialog').inner_text(), '完整同步有定稿月份：二次確認')
                    dlg(pg, '我了解，繼續')
                pg.wait_for_function("() => /已同步/.test(document.querySelector('[data-role=pnl-say-sync]').textContent)", timeout=30000)
            check(True, '完整同步流程跑完：%s' % pg.locator('[data-role="pnl-say-sync"]').inner_text()[:80])
            txt, has = preview_flow('[data-act="maint-s01conn"]', 's01conn', '確認套用', '')
            check(len(txt) > 0, '光復連接器對應預覽：%s' % txt[:90])
            if has:
                dlg(pg, '確認套用')
                pg.wait_for_function("() => /已套用/.test(document.querySelector('[data-role=pnl-say-s01conn]').textContent)", timeout=30000)
            check(True, '套用光復連接器對應流程跑完：%s' % pg.locator('[data-role="pnl-say-s01conn"]').inner_text()[:80])
            # 建上月草稿
            pg.click('[data-act="maint-lastmonth"]'); pg.wait_for_selector('.dialog'); dlg(pg, '確認建立')
            pg.wait_for_function("() => /處理完成/.test(document.querySelector('[data-role=pnl-say-lastmonth]').textContent)", timeout=90000)
            ll = pg.locator('[data-role="pnl-lastmonth-list"]').inner_text()
            check('S01' in ll and 'S02' in ll and '排隊中' not in ll, '建上月草稿逐店顯示結果：%s' % ll.replace('\n', ' ')[:100])
            # 載入光復門市資料
            pg.click('[data-act="maint-s01seed"]'); pg.wait_for_selector('.dialog'); dlg(pg, '確認載入')
            toast_has(pg, '已載入光復門市資料')
            check(True, '載入光復門市資料：成功')
            no_login_form(pg, '維護區')
            pg.screenshot(path=os.path.join(out_dir, 'settings-1280.png'))

            # ====== ⑭ 重整後資料還在（真的寫進後端）、手機寬 ======
            settings_after_reload(pg)
            check(pg.locator(SET + ' [data-role="pnl-set-row"][data-id="S02"] [data-f="name"]').input_value() == '測試二店', '重整後 S02 名稱仍是「測試二店」')
            pg.context.close()
            mp = new_page('pnladm', 375, 812)
            open_settings(mp)
            check(mp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), '手機寬 375：沒有橫向捲動')
            tab(mp, '連接器')
            check(mp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), '手機寬 375 連接器頁：沒有橫向捲動')
            mp.screenshot(path=os.path.join(out_dir, 'settings-375.png'))
            mp.context.close()
            browser.close()

        check(mock.leaked == [], '真實網路與機密零流出：%s' % mock.leaked)
        print('截圖目錄：' + out_dir)
    finally:
        if httpd:
            httpd.shutdown()
        proc.terminate()
    finish()


if __name__ == '__main__':
    main()
