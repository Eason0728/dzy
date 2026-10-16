/**
 * modules/bulletin/index.js — 公告專區：把電子佈告欄整頁嵌進內容區（iframe）。
 * 登入、簽名、附件都在佈告欄自己處理；嵌不進來或想全螢幕時，上方有「在新分頁開啟」。
 */
'use strict';

const BULLETIN_URL = 'https://dzy-bulletin.github.io/';

export default {
  mount(el) {
    const bar = document.createElement('div');
    bar.className = 'bulletin-bar';
    const tip = document.createElement('span');
    tip.textContent = '內容來自電子佈告欄（另需選名字＋密碼，或從 LINE 打卡選單進入）';
    const open = document.createElement('a');
    open.href = BULLETIN_URL;
    open.target = '_blank';
    open.rel = 'noopener';
    open.className = 'btn';
    open.textContent = '在新分頁開啟';
    bar.appendChild(tip);
    bar.appendChild(open);

    const frame = document.createElement('iframe');
    frame.src = BULLETIN_URL;
    frame.title = '電子佈告欄';
    frame.className = 'bulletin-frame';
    frame.setAttribute('data-role', 'bulletin-frame');

    el.appendChild(bar);
    el.appendChild(frame);
    return function unmount() {
      while (el.firstChild) el.removeChild(el.firstChild);
    };
  },
  onRoute() {}
};
