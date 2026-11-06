// node test/todo-groups.test.mjs —— 手機「待處理」分段（platform/todo.js，2026-11-06）
'use strict';
import { groupOf, cleanWhen, taipeiToday, TODO_GROUPS } from '../platform/todo.js';
let failed = 0;
function ok(c, label) { if (c) console.log('PASS: ' + label); else { failed++; console.error('FAIL: ' + label); } }
const T = '2026-11-06';
ok(groupOf({ level: 'warn', due: '2026-11-05' }, T) === 'overdue', '期限已過＝已逾期');
ok(groupOf({ level: 'warn', due: T }, T) === 'today', '期限今天＝今天');
ok(groupOf({ level: 'warn', due: '2026-11-10' }, T) === 'week', '期限之後＝這週');
ok(groupOf({ level: 'info', when: 'overdue' }, T) === 'overdue', 'when 優先於等級');
ok(groupOf({ level: 'error' }, T) === 'today', '沒日期的要緊＝今天');
ok(groupOf({ level: 'warn' }, T) === 'week', '沒日期的一般＝這週');
ok(groupOf({ level: 'info' }, T) === 'info', '沒日期的提醒＝提醒');
ok(groupOf({ level: 'warn', due: '11/05' }, T) === 'week', '日期格式錯當沒給');
ok(JSON.stringify(cleanWhen({ when: 'later', due: 'x' })) === '{}', '不合格的 when／due 丟掉');
ok(JSON.stringify(cleanWhen({ when: 'today', due: '2026-11-10' })) === '{"when":"today","due":"2026-11-10"}', '合格的保留');
ok(taipeiToday(new Date('2026-11-05T16:30:00Z')) === '2026-11-06', '台北今天（UTC 16:30＝台北隔天 00:30）');
ok(TODO_GROUPS.map((g) => g.name).join('／') === '已逾期／今天／這週／提醒', '四段名稱與順序');
process.exit(failed ? 1 : 0);
