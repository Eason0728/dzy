#!/usr/bin/env python3
"""網頁分頁圖示（favicon）＋手機加到主畫面圖示產生器（2026-10-17 Eason：直接一個「鼎」字，有質感的藍色背景）。

    uv run --with pillow python tools/gen_favicon.py

深藍斜向漸層（左上 #2B5A8C → 右下 #142C4C）＋白色宋體粗體「鼎」。
輸出 assets/favicon-32.png、favicon-192.png（圓角、透明邊）、apple-touch-icon.png（方形滿版、上鼎下「管理」，iOS 自己切圓角）。
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOP_LEFT = (0x2B, 0x5A, 0x8C)
BOTTOM_RIGHT = (0x14, 0x2C, 0x4C)
FG = (0xFF, 0xFF, 0xFF)
FONT = ('/System/Library/Fonts/Supplemental/Songti.ttc', 1)  # 宋體粗體
CHAR = '鼎'
N = 1024  # 先畫大圖再縮，邊緣才細


def gradient(size):
    img = Image.new('RGB', (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(TOP_LEFT, BOTTOM_RIGHT))
    return img


def draw_char(img, ratio):
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT[0], int(N * ratio), index=FONT[1])
    l, t, r, b = d.textbbox((0, 0), CHAR, font=f)
    d.text(((N - (r - l)) / 2 - l, (N - (b - t)) / 2 - t), CHAR, font=f, fill=FG)


def main():
    out = os.path.join(ROOT, 'assets')
    bg = gradient(256).resize((N, N), Image.BICUBIC)

    # 分頁圖示：圓角、字佔滿（32px 要大顆才認得出）
    tab = bg.copy()
    draw_char(tab, 0.80)
    mask = Image.new('L', (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, N - 1, N - 1), radius=int(N * 0.18), fill=255)
    tab = tab.convert('RGBA')
    tab.putalpha(mask)
    tab.resize((32, 32), Image.LANCZOS).save(os.path.join(out, 'favicon-32.png'), optimize=True)
    tab.resize((192, 192), Image.LANCZOS).save(os.path.join(out, 'favicon-192.png'), optimize=True)

    # 主畫面圖示：方形滿版，上「鼎」下「管理」（Eason 2026-10-17）
    touch = bg.copy()
    d = ImageDraw.Draw(touch)
    big = ImageFont.truetype(FONT[0], int(N * 0.50), index=FONT[1])
    small = ImageFont.truetype(FONT[0], int(N * 0.17), index=FONT[1])
    l, t, r, b = d.textbbox((0, 0), CHAR, font=big)
    d.text(((N - (r - l)) / 2 - l, N * 0.12 - t), CHAR, font=big, fill=FG)
    l2, t2, r2, b2 = d.textbbox((0, 0), '管理', font=small)
    d.text(((N - (r2 - l2)) / 2 - l2, N * 0.70 - t2), '管理', font=small, fill=FG)
    touch.resize((180, 180), Image.LANCZOS).save(os.path.join(out, 'apple-touch-icon.png'), optimize=True)
    print('已輸出 favicon-32.png、favicon-192.png、apple-touch-icon.png')


if __name__ == '__main__':
    main()
