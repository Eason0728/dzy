#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""資料帶入測試・管理部門（盤點抽查／營運稽核）——隨機資料集＋獨立算式。

每次執行全部重抽（門市數、品項、盤點數量、差異、金庫金額、稽核題目與合格與否、日期…），
分層抽樣讓合格率高中低都出現。種子印在 stdout，`E2E_SEED=<種子>` 可重現。

這裡的每個「預期值」都照 docs/spec.md §4／稽核 requirements 自己算一次，**不 import 系統的
任何計算模組**（format.js／fill-submit.js 都不碰）。捨入一律 int(x + 0.5)（＝JS Math.round，
Python round() 是銀行家捨入不能用）。

getAll 回傳形狀（扁平）照 platform/api.js 檔頭與 ~/mala-audit/apps-script/Code.gs handleGetAll／
loadOpsRecords：{ok, config:{reasons, change_fund_std, petty_cash_std, accountant_ok, stores, all_stores},
items, records, details, ops_records, ops_details}。
"""
import os
import random
import time

YEAR = '2026'
SAMPLE_SIZE = 20
MONTH_LABELS = {'01': '一月', '02': '二月', '03': '三月', '04': '四月', '05': '五月', '06': '六月',
                '07': '七月', '08': '八月', '09': '九月', '10': '十月', '11': '十一月', '12': '十二月'}

# 營運稽核表 19 項（照 modules/audit-shared/ops-checklist.js 的文字抄一份當「規格」，id 規則 c{大類}g{群組}i{項目}）
OPS_CATEGORIES = [
    ('營運管理', [
        ('消防安全', ['一家店至少兩支滅火器', '廚區〈爐火旁〉一支、客席區一支是否設置滅火器', '滅火器壓力、有效期限是否正常',
                     '有後門之門市，出入是否暢通', '瓦斯桶是否固定（不傾斜）', '瓦斯桶是否張貼警語',
                     '新進同仁是否進行新進同仁教育訓練、一般安全教育訓練，簽名留檔']),
        ('營運', ['營運表單填寫是否正確〈日報表〉', '文宣露出是否依規範執行']),
    ]),
    ('品牌形象', [
        ('環境清潔', ['是否保持各項對外文宣張貼應乾淨無髒污', '無張貼自製文宣品',
                     '保持餐廳外圍環境清潔〈招牌、LOGO、DM 架〉，清潔包含天、地、壁', '保持餐廳內「客席區」環境清潔，包含天、地、壁',
                     '保持餐廳內「化妝室」環境清潔，包含天、地、壁', '保持餐廳內「廚區」環境清潔，包含天、地、壁']),
        ('食安', ['任一商品保存是否在有效日期內（架上或庫存）※退貨商品已明確標示且區隔者不受此限',
                 '洗滌區清潔用品標示是否明確，放置區域依規範執行', '洗手區域是否設置酒精瓶、酒精、擦手紙、洗手步驟', '濾心日期是否定期更換']),
    ]),
]
OPS_FLAT = []
for ci, (cat, groups) in enumerate(OPS_CATEGORIES):
    for gi, (gname, items) in enumerate(groups):
        for ii, text in enumerate(items):
            OPS_FLAT.append({'id': 'c%dg%di%d' % (ci, gi, ii), 'cat': cat, 'group': gname, 'text': text})
OPS_TOTAL = len(OPS_FLAT)  # 19

STORE_CODE_POOL = ['sxl-gf', 'ck', 'mzt-gf', 'mzt-js', 'mzt-lzl', 'st-01', 'st-02', 'st-03']
STORE_NAME_PARTS = (['小辛辣', '墨竹亭', '一悟', '央廚', '燃麵'], ['光復', '金山', '六張犁', '美村', '南昌', '竹北', '新豐'])
ITEM_POOL = ['牛肉片', '鴨血', '煙燻豬頭皮', '感熱貼紙', '肉燥', '打拋醬', '麻辣底料', '花椰菜', '鴨掌', '木耳', '豆皮', '油豆腐',
             '米血', '王子麵', '高麗菜', '牛肚', '毛肚', '蒟蒻', '娃娃菜', '金針菇', '杏鮑菇', '手工麵', '冬粉', '鴨腸', '豬血糕',
             '滷蛋', '甜不辣', '黑木耳', '炒豬頭皮', '芝麻醬', '辣油', '花椒', '乾辣椒', '紙碗', '塑膠袋', '筷子', '外帶袋', '餐巾紙',
             '酒精', '洗碗精', '雞翅', '鴨翅', '鳳爪', '牛腱', '豆干', '百頁', '凍豆腐', '魚丸', '貢丸', '蟹肉棒']
UNIT_POOL = ['公斤', '盒', '包', '捲', '箔', '罐', '袋', '斤', '顆', '條']
REASON_POOL = ['盤點錯誤（門市盤錯）', '損耗未記', '單位混淆', '進出貨未入帳', '其他']
NOTE_POOL = ['冰箱後面漏盤', '上週報廢未登', '兩箱併一箱', '廠商補貨未入', '口頭交接漏掉', '夜班盤錯層架']


def js_round(x):
    """JS Math.round（正數）：.5 進位。"""
    return int(x + 0.5)


def rate(correct, total):
    """照 format.js 規格：correctRate(correct,total) = Math.round((correct/total)*100)，total 為 0 → 0。運算順序照抄。"""
    if not total:
        return 0
    return js_round((correct / total) * 100)


def jsnum(x):
    """JS 把數字接成字串時的寫法：整數沒有小數點、小數照 repr。"""
    if isinstance(x, float) and x.is_integer():
        return str(int(x))
    return str(x)


def month_label(m):
    return MONTH_LABELS.get(str(m).split('-')[1], '')


def anomaly_text(anomaly_details):
    """規格：只取 verdict==='異常'，依傳入順序編號：{序}.{品項}:盤點{盤點數}{單位}，覆盤{複盤數}{單位}，'\\n' 連接。"""
    lines = []
    i = 0
    for d in anomaly_details:
        if d['verdict'] != '異常':
            continue
        i += 1
        lines.append('%d.%s:盤點%s%s，覆盤%s%s' % (i, d['item'], jsnum(d['book_qty']), d['unit'], jsnum(d['recount_qty']), d['unit']))
    return '\n'.join(lines)


def ops_summary(details):
    """規格：只取 verdict==='未完成'，{序}.{群組}－{項目}[:{說明}]，'\\n' 連接。"""
    lines = []
    i = 0
    for d in details:
        if d['verdict'] != '未完成':
            continue
        i += 1
        head = '%d.%s－%s' % (i, d['group'], d['text'])
        note = (d.get('note') or '').strip()
        lines.append(head + ':' + note if note else head)
    return '\n'.join(lines)


def ops_counts(details):
    """規格：分母固定＝19（未檢查算分母），pass_rate = round(pass/19*100)。"""
    p = sum(1 for d in details if d['verdict'] == '合格')
    f = sum(1 for d in details if d['verdict'] == '未完成')
    t = sum(1 for d in details if d['track'])
    return {'total': OPS_TOTAL, 'pass': p, 'fail': f, 'pending': max(0, OPS_TOTAL - p - f), 'track': t, 'pass_rate': rate(p, OPS_TOTAL)}


def current_month():
    """台北時間的年月（稽核日期規格一律台灣時間）。"""
    t = time.gmtime(time.time() + 8 * 3600)
    return '%04d-%02d' % (t.tm_year, t.tm_mon)


def today_taipei():
    t = time.gmtime(time.time() + 8 * 3600)
    return '%04d-%02d-%02d' % (t.tm_year, t.tm_mon, t.tm_mday)


class Dataset:
    def __init__(self, seed):
        self.seed = seed
        self.rng = random.Random(seed)
        r = self.rng
        self.cur_month = current_month()
        cur_mm = int(self.cur_month[5:])
        self.months = ['%s-%02d' % (YEAR, m) for m in range(1, cur_mm + 1)]  # 一月到本月

        # ---- 門市（啟用 3–6 家＋停用 0–2 家）----
        n_active = r.randint(3, 6)
        n_inactive = r.randint(0, 2)
        codes = r.sample(STORE_CODE_POOL, n_active + n_inactive)
        self.all_stores = []
        for i, code in enumerate(codes):
            name = r.choice(STORE_NAME_PARTS[0]) + r.choice(STORE_NAME_PARTS[1]) + ('%d' % i if r.random() < 0.3 else '')
            self.all_stores.append({'code': code, 'name': name, 'tab': name, 'active': i < n_active, 'order': i + 1})
        self.stores = [{'code': s['code'], 'name': s['name'], 'order': i + 1}
                       for i, s in enumerate([x for x in self.all_stores if x['active']])]
        self.store_codes = [s['code'] for s in self.stores]
        self.name_of = {s['code']: s['name'] for s in self.all_stores}

        # ---- 設定 ----
        self.reasons = r.sample(REASON_POOL, len(REASON_POOL))
        if '其他' not in self.reasons:
            self.reasons.append('其他')
        self.change_fund_std = r.choice([10000, 5000, 30000, 12345, 20000])
        self.petty_cash_std = r.choice([10000, 3000, 8800, 50000])

        # ---- 品項庫（每店 22–40 項；一兩項故意沒單位）----
        self.items = []
        self.items_by_store = {}
        for s in self.all_stores:
            n = r.randint(22, 40)
            names = r.sample(ITEM_POOL, n)
            lst = []
            for j, nm in enumerate(names):
                unit = r.choice(UNIT_POOL)
                if j == 0 and r.random() < 0.5:
                    unit = ''  # 品項庫留空單位（2026-08-07 真實案例）
                active = not (j == 1 and r.random() < 0.5)  # 一項停用，抽樣不該抽到
                it = {'store': s['code'], 'name': nm, 'unit': unit, 'active': active}
                lst.append(it)
                self.items.append(it)
            self.items_by_store[s['code']] = lst

        # ---- 盤點抽查紀錄／明細（分層：每店抽一個水準中心 high/mid/low）----
        self.records = []
        self.details = []
        tiers = ['high', 'mid', 'low']
        for si, s in enumerate(self.stores):
            tier = tiers[si % 3] if si < 3 else r.choice(tiers)
            for m in self.months:
                is_cur = (m == self.cur_month)
                roll = r.random()
                if is_cur:
                    # 本月：讓「還沒盤點」與「已盤點」都出現（badge 要算得出不同值）
                    status = '已稽核' if si % 2 == 0 else ('輪休' if r.random() < 0.3 else None)
                else:
                    status = '已稽核' if roll < 0.62 else ('輪休' if roll < 0.78 else None)
                if status is None:
                    continue
                key = '%s_%s' % (s['code'], m)
                day = r.randint(1, 9)
                if status == '輪休':
                    self.records.append({'record_key': key, 'store': s['code'], 'month': m, 'status': '輪休',
                                         'audit_date': '%s-%02d' % (m, day), 'sample_count': 0, 'correct_count': 0, 'correct_rate': 0,
                                         'change_fund': '', 'petty_cash': '', 'tip_amount': 0, 'tip_match': '', 'anomaly_text': '',
                                         'note': '', 'submitted_at': '%s-%02dT10:00:00+08:00' % (m, day)})
                    continue
                full_mode = r.random() < 0.5
                n = SAMPLE_SIZE if not full_mode else r.randint(12, SAMPLE_SIZE)
                k = {'high': r.randint(0, 1), 'mid': r.randint(2, 5), 'low': r.randint(6, min(12, n))}[tier]
                k = min(k, n)
                pool = [it for it in self.items_by_store[s['code']] if it['active']]
                picked = r.sample(pool, n if full_mode else k)
                rows = []
                for idx, it in enumerate(picked):
                    is_anom = (idx < k)
                    book = r.choice([r.randint(1, 60), round(r.uniform(0.5, 60), 1), round(r.uniform(0.5, 30), 2)])
                    if is_anom:
                        delta = r.choice([r.randint(1, 10), round(r.uniform(0.1, 9.9), 1)])
                        recount = round(book + delta, 2) if r.random() < 0.5 else round(max(0, book - delta), 2)
                        if isinstance(book, int) and isinstance(delta, int):
                            recount = int(recount)
                        reason = r.choice(self.reasons)
                        note = r.choice(NOTE_POOL) if (reason == '其他' or r.random() < 0.4) else ''
                    else:
                        recount = book
                        reason = ''
                        note = ''
                    unit = it['unit'] or r.choice(UNIT_POOL)  # 缺單位的當場補過了才送得出去
                    rows.append({'record_key': key, 'store': s['code'], 'month': m, 'item': it['name'], 'unit': unit,
                                 'book_qty': book, 'recount_qty': recount, 'verdict': '異常' if is_anom else '正確',
                                 'reason': reason, 'note': note})
                r.shuffle(rows)  # 明細順序＝送出順序，異常不一定排前面
                correct = n - k
                tip = r.randint(0, 3000)
                self.records.append({
                    'record_key': key, 'store': s['code'], 'month': m, 'status': '已稽核',
                    'audit_date': '%s-%02d' % (m, day), 'sample_count': n, 'correct_count': correct,
                    'correct_rate': rate(correct, n),
                    'change_fund': r.choice(['正確', '不正確']), 'petty_cash': r.choice(['正確', '不正確']),
                    'tip_amount': tip, 'tip_match': r.choice(['相符', '不相符']),
                    'anomaly_text': anomaly_text(rows), 'note': r.choice(['', '', '金庫鑰匙交接完成', '店長不在由副店陪盤']),
                    'submitted_at': '%s-%02dT10:00:00+08:00' % (m, day)})
                self.details.extend(rows)

        # ---- 營運稽核紀錄／明細（分層同上）----
        self.ops_records = []
        self.ops_details = []
        for si, s in enumerate(self.stores):
            tier = tiers[(si + 1) % 3] if si < 3 else r.choice(tiers)
            for m in self.months:
                if r.random() < 0.4:
                    continue
                key = '%s_%s' % (s['code'], m)
                n_fail = {'high': r.randint(0, 1), 'mid': r.randint(2, 5), 'low': r.randint(6, 10)}[tier]
                n_pending = r.randint(0, 3) if r.random() < 0.5 else 0
                verdicts = ['未完成'] * n_fail + ['未檢查'] * n_pending
                verdicts += ['合格'] * (OPS_TOTAL - len(verdicts))
                r.shuffle(verdicts)
                rows = []
                for it, v in zip(OPS_FLAT, verdicts):
                    track = (r.random() < 0.7) if v == '未完成' else (r.random() < 0.1)
                    note = r.choice(['一盞不亮', '壓力表偏低', '出口堆雜物', '標示脫落', '無紀錄']) if v == '未完成' else ''
                    rows.append({'record_key': key, 'store': s['code'], 'month': m, 'item_id': it['id'], 'cat': it['cat'],
                                 'group': it['group'], 'text': it['text'], 'verdict': v, 'track': track, 'note': note})
                c = ops_counts(rows)
                day = r.randint(1, 12)
                self.ops_records.append({
                    'record_key': key, 'store': s['code'], 'month': m, 'status': '已稽核', 'audit_date': '%s-%02d' % (m, day),
                    'auditor': r.choice(['王會計', '林會計', '陳稽核']), 'total_count': c['total'], 'pass_count': c['pass'],
                    'fail_count': c['fail'], 'pending_count': c['pending'], 'track_count': c['track'], 'pass_rate': c['pass_rate'],
                    'summary': ops_summary(rows), 'note': '', 'submitted_at': '%s-%02dT09:00:00.000Z' % (m, day)})
                self.ops_details.extend(rows)

        # ---- 角色用到的店 ----
        self.lead_store = r.choice(self.store_codes)
        # 督導：REGIONS 開＝只管一個真子集；關＝品牌全部（＝這裡全部啟用門市）
        k_region = r.randint(1, len(self.store_codes) - 1)
        self.region_scope = sorted(r.sample(self.store_codes, k_region))
        self.lead_scope_from_backend = r.random() < 0.5  # 新後端會回 audit_scope；舊後端不回

    # ---- getAll 形狀 ----
    def getall(self):
        import copy
        return copy.deepcopy({
            'ok': True,
            'config': {'reasons': self.reasons, 'change_fund_std': self.change_fund_std, 'petty_cash_std': self.petty_cash_std,
                       'stores': self.stores, 'all_stores': self.all_stores, 'accountant_ok': True},
            'items': self.items, 'records': self.records, 'details': self.details,
            'ops_records': self.ops_records, 'ops_details': self.ops_details,
        })

    # ---- 獨立算式：首頁待辦 ----
    def pending_stock_nodes(self, codes=None, records=None):
        """本月沒有「已稽核／輪休」紀錄的店（spec：badge 由模組自己算）。"""
        codes = codes if codes is not None else self.store_codes
        records = list(records) if records is not None else self.records
        done = {rec['store'] for rec in records if rec['month'] == self.cur_month and rec['status'] in ('已稽核', '輪休')}
        return [c for c in codes if c not in done]

    def ops_track_by_store(self, codes=None, ops_records=None, ops_details=None):
        """每店最新一筆已稽核的 track 數 → {code: (month, count)}。"""
        codes = codes if codes is not None else self.store_codes
        ops_records = list(ops_records) if ops_records is not None else self.ops_records
        ops_details = list(ops_details) if ops_details is not None else self.ops_details
        latest = {}
        for rec in ops_records:
            if rec['status'] != '已稽核' or rec['store'] not in codes:
                continue
            if rec['store'] not in latest or rec['month'] > latest[rec['store']]['month']:
                latest[rec['store']] = rec
        out = {}
        for code, rec in latest.items():
            out[code] = (rec['month'], sum(1 for d in ops_details if d['record_key'] == rec['record_key'] and d['track'] is True))
        return out

    # ---- 獨立算式：異常分析 ----
    def analysis(self, frm=None, to=None, codes=None, records=None, details=None, stores=None):
        codes = codes if codes is not None else self.store_codes
        records = list(records) if records is not None else self.records
        details = list(details) if details is not None else self.details
        stores = list(stores) if stores is not None else self.stores

        def in_range(m):
            if frm and m < frm:
                return False
            if to and m > to:
                return False
            return True
        anoms = [d for d in details if d['verdict'] == '異常' and in_range(d['month']) and d['store'] in codes]
        # (a) 累犯：count desc，再 item 升冪（JS 字串比較＝碼位比較）
        rep = {}
        for d in anoms:
            row = rep.setdefault(d['item'], {'item': d['item'], 'count': 0, 'stores': [], 'months': []})
            row['count'] += 1
            if d['store'] not in row['stores']:
                row['stores'].append(d['store'])
            row['months'].append(d['month'])
        rep_rows = sorted(rep.values(), key=lambda x: (-x['count'], x['item']))
        for row in rep_rows:
            row['months'] = sorted(row['months'])
        # (b) 原因：count desc，同數依第一次出現順序（JS/Python sort 都穩定）
        reasons = {}
        order = []
        for d in anoms:
            k = d['reason'] or '（未填）'
            if k not in reasons:
                order.append(k)
            reasons[k] = reasons.get(k, 0) + 1
        reason_rows = sorted([(k, reasons[k]) for k in order], key=lambda x: -x[1])
        # (c) 各店：異常項數、已稽核次數、異常率＝round(anomalies/抽查總項數*100)，依異常數 desc（穩定）
        store_rows = []
        for s in sorted([x for x in stores if x['code'] in codes], key=lambda x: x['order']):
            mine = [rec for rec in records if rec['store'] == s['code'] and rec['status'] == '已稽核' and in_range(rec['month'])]
            a = sum(1 for d in anoms if d['store'] == s['code'])
            sampled = sum(int(rec['sample_count']) for rec in mine)
            store_rows.append({'name': s['name'], 'anomalies': a, 'audits': len(mine), 'rate': js_round((a / sampled) * 100) if sampled else 0})
        store_rows.sort(key=lambda x: -x['anomalies'])
        return rep_rows, reason_rows, store_rows

    def month_options(self, codes=None, records=None, details=None):
        codes = codes if codes is not None else self.store_codes
        records = list(records) if records is not None else self.records
        details = list(details) if details is not None else self.details
        s = {rec['month'] for rec in records if rec['store'] in codes} | {d['month'] for d in details if d['store'] in codes}
        return sorted(s)

    # ---- 獨立算式：我的門市 ----
    def latest_stock(self, code):
        mine = [rec for rec in self.records if rec['store'] == code]
        return max(mine, key=lambda x: x['month']) if mine else None

    def latest_ops(self, code):
        mine = [rec for rec in self.ops_records if rec['store'] == code]
        return max(mine, key=lambda x: x['month']) if mine else None


def pick_seed():
    env = os.environ.get('E2E_SEED')
    return int(env) if env else int(time.time() * 1000) % 1000000007
