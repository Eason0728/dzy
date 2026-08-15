// 稽核系統共用格式化純函式（spec.md §5 逐字元契約）
// 同時支援瀏覽器（掛 window.Format）與 node（module.exports）

(function (root) {
  'use strict';

  var MONTH_LABELS = {
    '01': '一月', '02': '二月', '03': '三月', '04': '四月',
    '05': '五月', '06': '六月', '07': '七月', '08': '八月',
    '09': '九月', '10': '十月', '11': '十一月', '12': '十二月'
  };

  // recordKey('sxl-gf', '2026-08') → 'sxl-gf_2026-08'
  function recordKey(store, month) {
    return store + '_' + month;
  }

  // monthLabel('2026-08') → '八月'
  function monthLabel(month) {
    var mm = String(month).split('-')[1];
    return MONTH_LABELS[mm] || '';
  }

  // correctRate(19, 20) → 95（四捨五入整數）
  function correctRate(correct, total) {
    if (!total) return 0;
    return Math.round((correct / total) * 100);
  }

  // anomalyOnlyCounts(異常項數, 標準項數) → {sample_count, correct_count, correct_rate}
  // 「只填異常項」模式用：會計只輸入異常的品項，其餘視同正確，
  // 分母固定＝標準項數（預設 20），所以 1 項異常 → 19/20 → 95。
  // 異常項數超過標準項數時 correct_count 夾在 0（不產生負數），由前端另外擋下送出。
  function anomalyOnlyCounts(anomalyCount, sampleSize) {
    var total = Number(sampleSize) > 0 ? Number(sampleSize) : 20;
    var anomalies = Math.max(0, Number(anomalyCount) || 0);
    var correct = Math.max(0, total - anomalies);
    return {
      sample_count: total,
      correct_count: correct,
      correct_rate: correctRate(correct, total)
    };
  }

  // buildAnomalyText(details) → 只取 verdict==='異常' 的項，依傳入順序編號
  // 格式：{序號}.{品項}:盤點{盤點數}{單位}，覆盤{複盤數}{單位}，多筆以 '\n' 連接
  function buildAnomalyText(details) {
    var list = (details || []).filter(function (d) {
      return d.verdict === '異常';
    });
    var lines = list.map(function (d, i) {
      return (i + 1) + '.' + d.item + ':盤點' + d.book_qty + d.unit +
        '，覆盤' + d.recount_qty + d.unit;
    });
    return lines.join('\n');
  }

  // ── 營運稽核表（2026-08-11 新增；與上面的月初盤點抽查是兩套獨立統計）──────────

  // opsCounts(details, total) → {total, pass, fail, pending, track, pass_rate}
  // details: [{verdict:'合格'|'未完成'|'未檢查', track:bool}]，total＝檢查表細項總數。
  // 合格率分母固定＝total（細項總數），**未檢查的項目算在分母裡**——
  // 沒檢查完的稽核不該顯示 100%，這是刻意的（跟盤點那套「只填異常項」的固定分母同精神）。
  function opsCounts(details, total) {
    var list = details || [];
    var denom = Number(total) > 0 ? Number(total) : list.length;
    var pass = 0, fail = 0, track = 0;
    list.forEach(function (d) {
      if (d.verdict === '合格') pass++;
      else if (d.verdict === '未完成') fail++;
      if (d.track) track++;
    });
    return {
      total: denom,
      pass: pass,
      fail: fail,
      pending: Math.max(0, denom - pass - fail),
      track: track,
      pass_rate: correctRate(pass, denom)
    };
  }

  // buildOpsSummary(details) → 只取 verdict==='未完成' 的項，依傳入順序編號
  // 格式：{序號}.{群組}－{檢查項目}:{說明}，多筆以 '\n' 連接（冒號半形，同 buildAnomalyText）
  // 沒填說明就只到項目名為止，不留一個孤零零的冒號。
  function buildOpsSummary(details) {
    var list = (details || []).filter(function (d) {
      return d.verdict === '未完成';
    });
    var lines = list.map(function (d, i) {
      var head = (i + 1) + '.' + (d.group || '') + '－' + (d.text || '');
      var note = (d.note || '').trim();
      return note ? head + ':' + note : head;
    });
    return lines.join('\n');
  }

  var Format = {
    recordKey: recordKey,
    monthLabel: monthLabel,
    correctRate: correctRate,
    anomalyOnlyCounts: anomalyOnlyCounts,
    buildAnomalyText: buildAnomalyText,
    opsCounts: opsCounts,
    buildOpsSummary: buildOpsSummary
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Format;
  } else {
    root.Format = Format;
  }
})(typeof window !== 'undefined' ? window : this);
