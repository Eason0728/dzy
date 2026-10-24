#!/usr/bin/env python3
"""選單圖示產生器（2026-10-16 Eason：選單不用 logo，改 LINE 圖文選單那種線條圖示）。
每個圖示＝圓角色塊＋白色線條，輸出 assets/icons/<名稱>.png（180×180）。改圖示改這裡再跑：python3 tools/make-icons.py
新模組要圖示：在 ICONS 加一列（名稱＝manifest.icon）。"""
import os
from playwright.sync_api import sync_playwright

S = 'fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"'
ICONS = {
    'home': ('#5b6b7c', f'<path {S} d="M40 88 L90 46 L140 88"/><path {S} d="M54 78 V134 H126 V78"/><path {S} d="M80 134 V106 H100 V134"/>'),
    'me': ('#c8402c', f'<circle {S} cx="90" cy="70" r="20"/><path {S} d="M50 134 C54 108 70 98 90 98 C110 98 126 108 130 134 Z"/>'),
    'bulletin': ('#e07a2c', f'<path {S} d="M48 78 V104 H64 L112 128 V54 L64 78 Z"/><path {S} d="M64 104 L72 132 H86 L80 106"/><path {S} d="M128 76 C136 84 136 98 128 106"/>'),
    'users': ('#3d6fb6', f'<rect {S} x="40" y="52" width="100" height="76" rx="12"/><circle {S} cx="72" cy="84" r="11"/><path {S} d="M54 114 C57 102 64 98 72 98 C80 98 87 102 90 114"/><path {S} d="M104 80 H124 M104 96 H124 M104 112 H118"/>'),
    'staff': ('#7a4fb0', f'<circle {S} cx="70" cy="72" r="16"/><path {S} d="M40 128 C43 108 55 98 70 98 C85 98 97 108 100 128"/><circle {S} cx="116" cy="78" r="13"/><path {S} d="M108 100 C124 100 136 110 140 128 H112"/>'),
    'dorm': ('#2f9a8a', f'<path {S} d="M38 84 L90 46 L142 84"/><path {S} d="M50 76 V134 H130 V76"/><path {S} d="M64 124 V100 H116 V124"/><path {S} d="M64 112 H116"/>'),
    'audit-stock': ('#24467a', f'<path {S} d="M50 70 L90 50 L130 70 L90 90 Z"/><path {S} d="M50 70 V112 L90 132 V90"/><path {S} d="M130 70 V96"/><path {S} d="M108 120 L118 130 L138 108"/>'),
    'audit-ops': ('#4a86b8', f'<rect {S} x="52" y="48" width="76" height="92" rx="10"/><path {S} d="M74 44 H106 V58 H74 Z"/><path {S} d="M66 84 L72 90 L82 78 M92 84 H114"/><path {S} d="M66 112 L72 118 L82 106 M92 112 H114"/>'),
    'approvals': ('#8a5a2b', f'<path {S} d="M56 44 H104 L128 68 V136 H56 Z"/><path {S} d="M104 44 V68 H128"/><path {S} d="M70 100 L82 112 L106 88"/><path {S} d="M70 126 H114"/>'),
    'storeops': ('#d4a017', f'<path {S} d="M44 70 L54 46 H126 L136 70"/><path {S} d="M44 70 C44 80 58 80 58 70 C58 80 76 80 76 70 C76 80 94 80 94 70 C94 80 112 80 112 70 C112 80 130 80 130 70 H136 C136 80 130 84 124 82"/><path {S} d="M52 84 V134 H128 V84"/><path {S} d="M76 134 V104 H104 V134"/>'),
    'payroll': ('#b5462f', f'<rect {S} x="40" y="56" width="100" height="68" rx="10"/><circle {S} cx="90" cy="90" r="16"/><path {S} d="M56 74 V106 M124 74 V106"/><path {S} d="M52 138 H128"/>'),
    'cashbook': ('#2f7d5b', f'<rect {S} x="46" y="46" width="88" height="88" rx="12"/><path {S} d="M62 74 H118 M62 94 H118 M62 114 H98"/><path {S} d="M108 106 L118 116 L132 98"/>'),
    'schedule': ('#6a4fc0', f'<rect {S} x="42" y="52" width="96" height="84" rx="10"/><path {S} d="M42 76 H138 M70 42 V60 M110 42 V60"/><path {S} d="M62 96 H74 M84 96 H96 M106 96 H118 M62 116 H74 M84 116 H96"/>'),
    'attendance': ('#1f8a5b', f'<circle {S} cx="90" cy="88" r="42"/><path {S} d="M90 62 V90 L108 102"/><path {S} d="M70 140 H110"/>'),
}

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'icons')
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 180, 'height': 180})
    for name, (color, body) in ICONS.items():
        pg.set_content(f'<html><body style="margin:0;background:transparent"><svg width="180" height="180" viewBox="0 0 180 180" xmlns="http://www.w3.org/2000/svg"><rect width="180" height="180" rx="40" fill="{color}"/>{body}</svg></body></html>')
        pg.screenshot(path=os.path.join(OUT, name + '.png'), omit_background=True)
    b.close()
print('已輸出', len(ICONS), '個圖示')
