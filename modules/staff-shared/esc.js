/** HTML 跳脫（與 platform/fmt.js 的 esc 同一規則；模組不得 import 平台內部，所以各留一份） */
export function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
