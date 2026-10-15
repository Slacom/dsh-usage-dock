/**
 * plans/peak-phase.js 单元测试：峰谷相位纯函数（离线）。
 *
 * 口径对照（dsh-cost-meter lib/pricing.js 同款）：
 *   - 峰窗口 UTC 1:00–4:00 / 6:00–10:00 = 北京时间 09:00–12:00 / 14:00–18:00；
 *   - 北京时间周六/周日全天谷价（2026-08-23 起）；假日表内日期全天谷价。
 *
 * 跑法：node tools/test-peak-phase.mjs
 */
import {
  peakPhaseAt, peakSegments, isPeakHour, weekendZoneAt, holidayZoneAt, PEAK_WINDOWS, PEAK_HOLIDAYS,
} from '../plans/peak-phase.js'

let passCount = 0
let failCount = 0

function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')) }
}

// 北京时间某日的 HH:mm → epoch ms（'2026-10-14 09:30' 形式）。
function bj(spec) {
  return Date.parse(spec.replace(' ', 'T') + '+08:00')
}

// T1 工作日上午 9:30（北京）= UTC 01:30 → 峰时段。
check('T1 工作日上午处于峰时段', isPeakHour(bj('2026-10-14 09:30')) === true)

// T2 工作日中午 12:30（北京）= UTC 04:30 → 谷时段（两峰窗口之间）。
check('T2 午间休息处于谷时段', isPeakHour(bj('2026-10-14 12:30')) === false)

// T3 工作日 13:30（北京）= UTC 05:30 → 谷；14:00 → 峰（第二窗口起点）。
check('T3a 13:30 为谷', isPeakHour(bj('2026-10-14 13:30')) === false)
check('T3b 14:00 整点入峰（半开区间）', isPeakHour(bj('2026-10-14 14:00')) === true)

// T4 工作日 18:00（北京）= UTC 10:00 → 出峰（end 不含）。
check('T4 18:00 整点出峰', isPeakHour(bj('2026-10-14 18:00')) === false)

// T5 周六全天谷价：2026-10-17 是周六。
check('T5 周六白天也是谷价', isPeakHour(bj('2026-10-17 10:00')) === false)
const wk = weekendZoneAt(bj('2026-10-17 10:00'))
check('T5 weekendZoneAt 命中且区间覆盖全天', wk !== null && wk.start === bj('2026-10-17 00:00') && wk.end === bj('2026-10-19 00:00'), wk)

// T6 假日：2026-10-01 在假日表内。
check('T6 假日全天谷价', isPeakHour(bj('2026-10-01 10:00')) === false)
const hd = holidayZoneAt(bj('2026-10-01 10:00'))
check('T6 holidayZoneAt 命中', hd !== null && hd.start === bj('2026-10-01 00:00') && hd.end === bj('2026-10-02 00:00'), hd)

// T7 假日优先于周末标记：10-03（周六）同时是假日 → weekend=false、holiday=true。
{
  const phase = peakPhaseAt(bj('2026-10-03 10:00'))
  check('T7 假日∩周末标记为 holiday 而非 weekend',
    phase !== null && phase.holiday === true && phase.weekend === false && phase.inPeak === false, phase)
}

// T8 相位与切换点：工作日 09:30 在峰内，nextAtMs 应为 12:00（北京时间）出峰点。
{
  const phase = peakPhaseAt(bj('2026-10-14 09:30'))
  check('T8a 工作日上午 inPeak=true', phase !== null && phase.inPeak === true && phase.weekend === false, phase)
  check('T8b 下一切换 = 北京 12:00', phase.nextAtMs === bj('2026-10-14 12:00'), phase)
  check('T8c nextIntoPeak=false（出峰）', phase.nextIntoPeak === false, phase)
  check('T8d 上一切换 = 北京 09:00', phase.prevAtMs === bj('2026-10-14 09:00'), phase)
}

// T9 谷时段切换点：12:30 的下一切换是 14:00 入峰。
{
  const phase = peakPhaseAt(bj('2026-10-14 12:30'))
  check('T9 谷时段下一切换 = 北京 14:00', phase.nextAtMs === bj('2026-10-14 14:00') && phase.nextIntoPeak === true, phase)
}

// T10 周五晚的 next 切换应跨过周末落在下周一 09:00。
{
  // 2026-10-16 是周五；18:30（北京）已在谷段。
  const phase = peakPhaseAt(bj('2026-10-16 18:30'))
  check('T10 周五晚下一切换跨周末 → 下周一 09:00', phase.nextAtMs === bj('2026-10-19 09:00'), phase)
}

// T11 周日的 next 切换 = 下周一 09:00（北京时间）。
{
  const phase = peakPhaseAt(bj('2026-10-18 10:00'))
  check('T11 周日下一切换 = 下周一 09:00', phase !== null && phase.nextAtMs === bj('2026-10-19 09:00'), phase)
}

// T12 假日表末尾附近的切换点（扫描窗口覆盖假日表长度）。
{
  const phase = peakPhaseAt(bj('2026-10-07 15:00')) // 国庆最后一天（假日，谷）
  check('T12 假日末日的下一切换 = 假日次日 09:00', phase !== null && phase.nextAtMs === bj('2026-10-08 09:00'), phase)
}

// T13 非法输入返回 null。
check('T13 NaN 时刻返回 null', peakPhaseAt(NaN) === null)
check('T13 空窗口返回 null', peakPhaseAt(Date.now(), []) === null)

// T15 段序列：工作日 30h 窗口（周四 20:00 → 周五 02:00 北京）的段数与类型。
{
  const segs = peakSegments(bj('2026-10-15 20:00'), bj('2026-10-16 02:00'))
  const types = segs.map((s) => s.t).join(',')
  check('T15a 工作日夜跨窗段序列正确（全谷）', types === 'off', segs)
  check('T15b 段首尾与窗口对齐', segs[0].s === bj('2026-10-15 20:00') && segs[segs.length - 1].e === bj('2026-10-16 02:00'), segs)
}

// T16 段序列：含峰窗口与周末翻转（周五 06:00 → 周日 12:00 北京）。
{
  const segs = peakSegments(bj('2026-10-16 06:00'), bj('2026-10-18 12:00'))
  const types = segs.map((s) => s.t)
  // 北京周五 06:00 是谷（峰 09:00 起）：首段应为 off，之后 peak/off 交替、末段周末。
  check('T16a 首段为谷（周五 06:00 在峰前）', types[0] === 'off', segs)
  check('T16a2 完整序列 off-peak-off-peak-off-weekend',
    types.join(',') === 'off,peak,off,peak,off,weekend', segs)
  check('T16b 末段为周末（周日）', types[types.length - 1] === 'weekend', segs)
  check('T16c 相邻段类型必不同', types.every((t, i) => i === 0 || t !== types[i - 1]), segs)
  // 周五 09:00（北京）应落在某个 peak 段内。
  const nine = bj('2026-10-16 09:00')
  const inPeakSeg = segs.some((s) => s.t === 'peak' && s.s <= nine && nine < s.e)
  check('T16d 周五 09:00 落在峰段内', inPeakSeg, segs)
}

// T17 段序列：窗口起点在峰段中间时首段从窗口起点开始且为峰。
{
  const segs = peakSegments(bj('2026-10-15 10:00'), bj('2026-10-15 13:00'))
  check('T17a 首段为峰（10:00 在峰内）', segs[0].t === 'peak', segs)
  check('T17b 段序列 = 峰(10-12) + 谷(12-13)', segs.length === 2 && segs[0].e === bj('2026-10-15 12:00'), segs)
}

// T18 段序列：非法输入。
check('T18 非法窗口返回 null', peakSegments(NaN, Date.now()) === null && peakSegments(Date.now(), Date.now()) === null)

// T14 窗口常量与假日表未被意外改动。
check('T14 峰窗口 = UTC 1-4 / 6-10', PEAK_WINDOWS.length === 2 && PEAK_WINDOWS[0].start === 1 && PEAK_WINDOWS[0].end === 4 && PEAK_WINDOWS[1].start === 6 && PEAK_WINDOWS[1].end === 10)
check('T14 假日表 10 项（2026 年剩余安排）', PEAK_HOLIDAYS.length === 10)

console.log(failCount === 0
  ? '\n全部 ' + (passCount + failCount) + ' 项：' + passCount + ' 通过, 0 失败'
  : '\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
