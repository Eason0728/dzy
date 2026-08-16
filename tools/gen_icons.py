#!/usr/bin/env python3
"""
產生 dzy 首頁卡片的四顆模組圖示（assets/icons/<模組id>.png，180×180）。

    python3 tools/gen_icons.py

慣例正本：記憶庫 mala-webapp-icon-convention——dzy 屬**鼎兆元族**，emblem 用墨竹亭竹葉
（不是小辛辣干鍋），靠底色區分模組。竹葉直接從宿舍合約系統的正式圖示抽 alpha
（~/mala-dorm-contract/assets/icon-180.png，同一招調撥 `gen_icon.py` 用過、逐 px 對齊），
不是重畫一顆近似的。

卡片圖示顯示尺寸小（~44px），照慣例「32px 只放 emblem 不放字」的原則：**只放竹葉、不放字**
（模組名稱就在圖示旁邊，放字是重複資訊）。圓角交給 CSS（border-radius），PNG 保持方形滿版。

配色（沿用已定案的、新的兩顆是本次提案、待 Eason 過目截圖時一併確認）：
  dorm        薄荷綠 #86CBBF＋藏藍竹葉 —— 與宿舍 app 正式圖示完全同款（同一個系統）
  audit-stock 藏藍   #1F3A5F＋白竹葉   —— 沿用稽核 app 正式圖示的藏藍
  audit-ops   鋼青   #4E7FA8＋白竹葉   —— 與盤點同為稽核系統，同色系但明顯更淺
                                          （比照調撥對宿舍「同色系不同深度」的先例）
  users       鼎兆元紅 #C8402C＋白竹葉 —— 平台自帶模組，用系統主色（tokens.css --brand）
"""

import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DORM_ICON = os.path.expanduser('~/mala-dorm-contract/assets/icon-180.png')
OUT_DIR = os.path.join(ROOT, 'assets', 'icons')

# 宿舍那顆量出來的幾何與顏色（180 畫布；與 ~/mala-transfer/tools/gen_icon.py 同一組數字）
DORM_MINT = np.array([134, 203, 191])   # 底色
DORM_NAVY = np.array([19, 23, 91])      # emblem 線色
EMBLEM_SPLIT_Y = 105                    # 105 以上是 emblem，以下是「宿舍」兩個字

SIZE = 180

# (模組 id, 底色, 竹葉色)
ICONS = [
    ('users',       (0xC8, 0x40, 0x2C), (0xFF, 0xFF, 0xFF)),
    ('audit-stock', (0x1F, 0x3A, 0x5F), (0xFF, 0xFF, 0xFF)),
    ('audit-ops',   (0x4E, 0x7F, 0xA8), (0xFF, 0xFF, 0xFF)),
    ('dorm',        (0x86, 0xCB, 0xBF), tuple(int(v) for v in DORM_NAVY)),
]


def emblem_alpha():
    """從宿舍那顆抽出竹葉 emblem 的 alpha 遮罩（含反鋸齒），並回傳其外框。"""
    src = np.array(Image.open(DORM_ICON).convert('RGB')).astype(float)
    den = np.abs(DORM_NAVY - DORM_MINT).sum()
    alpha = np.clip(np.abs(src - DORM_MINT).sum(axis=2) / den, 0, 1)
    alpha[EMBLEM_SPLIT_Y:, :] = 0        # 切掉「宿舍」兩個字，只留竹葉
    a8 = (alpha * 255).astype(np.uint8)
    ys, xs = np.nonzero(a8)
    box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    return Image.fromarray(a8).crop(box)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    mask = emblem_alpha()

    # 竹葉在 180 畫布置中，佔畫布寬 52%（卡片小尺寸顯示要比 app icon 的 30% 大顆才看得清）
    target_w = int(SIZE * 0.52)
    scale = target_w / mask.width
    scaled = mask.resize((target_w, max(1, int(mask.height * scale))), Image.LANCZOS)
    x = (SIZE - scaled.width) // 2
    y = (SIZE - scaled.height) // 2

    for mod_id, bg, fg in ICONS:
        canvas = Image.new('RGB', (SIZE, SIZE), bg)
        layer = Image.new('RGB', (scaled.width, scaled.height), fg)
        canvas.paste(layer, (x, y), scaled)
        out = os.path.join(OUT_DIR, f'{mod_id}.png')
        canvas.save(out, optimize=True)
        print(f'{out}  底色 #{bg[0]:02X}{bg[1]:02X}{bg[2]:02X}  {os.path.getsize(out)} bytes')


if __name__ == '__main__':
    main()
