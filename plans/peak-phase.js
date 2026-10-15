/**
 * DeepSeek API 峰谷计价相位（纯函数，无副作用）。
 *
 * 口径照抄 dsh-cost-meter 的 lib/pricing.js（本机安装副本逐一核对）：
 *   - 峰时段窗口（UTC 小时，半开区间 [start, end)）：1..4 与 6..10，
 *     即北京时间 09:00–12:00 与 14:00–18:00；
 *   - 周末（周六、周日，按**北京日历日**）全天谷价，自 2026-08-23 起生效；
 *   - 中国公众假期全天谷价（北京日历日）；调休上班的周末仍按周末（谷价）处理；
 *   - 2026-08-01 之后全部处于「峰谷时代」，本插件只做展示、不做历史计费，
 *     因此不再实现生效时刻门控（isPeakHour 的 effectiveAtMs 恒为 undefined）。
 *
 * 本文件不请求网络、不读配置；index.js 在组装 /api/plan-usage 响应时调用
 * peakPhaseAt(now) 给 DeepSeek（账号登录）条目附上相位，client.js 据此渲染
 * classic 峰谷时间条。假日表硬编码、不做配置——排期表公布新一年安排时
 * 在 PEAK_HOLIDAYS 里补日期即可。
 */

/** 周末全谷价生效时刻（UTC）：2026-08-23（周日）00:00 北京时间。 */
const WEEKEND_OFFPEAK_EFFECTIVE_AT = Date.parse('2026-08-22T16:00:00Z')

/**
 * 国务院办公厅 2026 年安排中，峰谷规则生效后剩余的中国公众假期（北京日历日）。
 * 与 dsh-cost-meter DEFAULT_PEAK_HOLIDAYS 同源；2027 年安排公布后在此追加。
 */
export const PEAK_HOLIDAYS = [
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]

/** 峰时段窗口（UTC 小时，半开区间 [start, end)）。 */
export const PEAK_WINDOWS = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
]

/** 北京时间日 index（epoch 天数，按 UTC+8 日界取整）。 */
function beijingDay(atMs) {
  return Math.floor((atMs + 8 * 3600000) / 86400000)
}

/** 北京日历日 → 「该日 00:00（北京时间）」的 epoch ms。 */
function dayStartMs(day) {
  return day * 86400000 - 8 * 3600000
}

/** 北京日 index → YYYY-MM-DD（用于与假日表比对）。 */
function dayKey(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10)
}

/**
 * 某一时刻所处的「周末全谷价」区间（北京时间周六/周日）。
 * @returns { start, end }（UTC ms）；非周末或生效前返回 null。
 */
export function weekendZoneAt(atMs) {
  if (!Number.isFinite(atMs) || atMs < WEEKEND_OFFPEAK_EFFECTIVE_AT) return null
  const day = beijingDay(atMs)
  // 北京日 index → 星期：1970-01-01（day=0）是**周四**，故 (day+4)%7，
  // 0=周日 … 6=周六（与 dsh-cost-meter 的 weekday 口径一致）。
  const weekday = (day + 4) % 7
  if (weekday !== 6 && weekday !== 0) return null
  const satDay = weekday === 6 ? day : day - 1
  return {
    start: Math.max(dayStartMs(satDay), WEEKEND_OFFPEAK_EFFECTIVE_AT),
    end: dayStartMs(satDay + 2),
  }
}

/** 中国公众假期的北京时间日区间；调休上班的周末仍由 weekendZoneAt 判为谷价。 */
export function holidayZoneAt(atMs, holidays = PEAK_HOLIDAYS) {
  if (!Number.isFinite(atMs) || atMs < WEEKEND_OFFPEAK_EFFECTIVE_AT || !Array.isArray(holidays)) return null
  const day = beijingDay(atMs)
  if (!holidays.includes(dayKey(day))) return null
  return { start: dayStartMs(day), end: dayStartMs(day + 1) }
}

function offPeakZoneAt(atMs, holidays) {
  return holidayZoneAt(atMs, holidays) ?? weekendZoneAt(atMs)
}

/**
 * 某一时刻是否处于峰时段。周末与假日全天谷价，优先于峰窗口。
 * @returns 峰时段 true；窗口外/周末/假日 false。
 */
export function isPeakHour(atMs, windows = PEAK_WINDOWS, holidays = PEAK_HOLIDAYS) {
  if (!Array.isArray(windows) || windows.length === 0) return false
  if (offPeakZoneAt(atMs, holidays) !== null) return false
  const hour = new Date(atMs).getUTCHours()
  return windows.some((w) => {
    const start = Number(w && w.start)
    const end = Number(w && w.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false
    if (start < end) return hour >= start && hour < end
    // 跨午夜窗口（本配置不会出现，兼容处理）。
    return hour >= start || hour < end
  })
}

/**
 * [local patch 0.8.1] 峰谷「段序列」生成：给定时间窗 [spanStart, spanEnd)，
 * 返回连续的峰谷段（相邻段类型必不同），供详情面板峰谷时间条（A+C 动画条）
 * 渲染。窗口为半开区间（UTC 小时）；周末/假日按**段中点**判型（与
 * isPeakHour 的日级判定同口径，段远短于一天时无歧义）。
 *
 * @param spanStart - 窗口起点（epoch ms）。
 * @param spanEnd - 窗口终点（epoch ms），须大于起点。
 * @returns [{ s, e, t }]，s/e 为 epoch ms，t ∈ 'peak'|'off'|'weekend'|'holiday'；
 *   参数非法时返回 null。
 */
export function peakSegments(spanStart, spanEnd, windows = PEAK_WINDOWS, holidays = PEAK_HOLIDAYS) {
  if (!Array.isArray(windows) || windows.length === 0) return null
  if (!Number.isFinite(spanStart) || !Number.isFinite(spanEnd) || spanEnd <= spanStart) return null
  // 候选切点（缺一类都会导致跨谷大段被段中点误判）：
  //   1. 峰窗口端点——窗口是 **UTC 小时**（1-4/6-10 = 北京 9-12/14-18），必须按
  //      **UTC 日**铺开（dayStartMs 的北京日界 + UTC 小时会错位 8 小时）；
  //   2. 北京午夜——周末/假日类型在北京日界翻转，而它不是峰窗口端点；
  //   3. 窗口首尾。
  const candidates = new Set([spanStart, spanEnd])
  const utcDay0 = Math.floor(spanStart / 86400000) - 1
  const utcDay1 = Math.floor(spanEnd / 86400000) + 1
  for (let day = utcDay0; day <= utcDay1; day += 1) {
    for (const w of windows) {
      const start = Number(w && w.start)
      const end = Number(w && w.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      candidates.add(day * 86400000 + start * 3600000)
      candidates.add(day * 86400000 + end * 3600000)
    }
  }
  const bjDay0 = beijingDay(spanStart) - 1
  const bjDay1 = beijingDay(spanEnd) + 1
  for (let day = bjDay0; day <= bjDay1; day += 1) {
    candidates.add(dayStartMs(day)) // 北京午夜（周末/假日翻转点）
  }
  const points = [...candidates].filter((t) => t >= spanStart && t <= spanEnd).sort((a, b) => a - b)
  const segs = []
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    if (b <= a) continue
    const mid = (a + b) / 2
    const holiday = holidayZoneAt(mid, holidays)
    const zone = holiday ?? weekendZoneAt(mid)
    let type = 'off'
    if (holiday !== null) type = 'holiday'
    else if (zone !== null) type = 'weekend'
    else if (isPeakHour(mid, windows, holidays)) type = 'peak'
    if (segs.length > 0 && segs[segs.length - 1].t === type) {
      segs[segs.length - 1].e = b // 相邻同型合并（防御性保留）
    } else {
      segs.push({ s: a, e: b, t: type })
    }
  }
  return segs
}

/**
 * 某一时刻所处的峰谷相位与相邻切换点（供时间条游标与倒计时）。
 * 窗口为半开区间 [start, end)（UTC 小时），兼容跨午夜窗口（end <= start）。
 * 候选切换点扫描 ±span 天（span 随假日表长度扩大），只保留峰谷状态真实
 * 变化的端点——避免「周末结束但下一个峰窗口还没到」这类假切换。
 *
 * @returns { inPeak, weekend, holiday, prevAtMs, nextAtMs, nextIntoPeak }
 *   或 null（无有效窗口/时刻）。weekend=true 表示处于周末全谷价区间；
 *   holiday=true 表示处于法定假日（此时 weekend 恒为 false）。
 */
export function peakPhaseAt(atMs, windows = PEAK_WINDOWS, holidays = PEAK_HOLIDAYS) {
  if (!Array.isArray(windows) || windows.length === 0 || !Number.isFinite(atMs)) return null
  const hourAt = (dayOffset, hour) => {
    const date = new Date(atMs)
    date.setUTCDate(date.getUTCDate() + dayOffset)
    date.setUTCHours(hour, 0, 0, 0)
    return date.getTime()
  }
  const candidates = new Set()
  const span = Math.max(12, Math.min(380, (Array.isArray(holidays) ? holidays.length : 0) + 7))
  for (let day = -span; day <= span; day += 1) {
    candidates.add(hourAt(day, 16)) // 北京时间次日 00:00
    for (const w of windows) {
      const start = Number(w && w.start)
      const end = Number(w && w.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      candidates.add(hourAt(day, start))
      candidates.add(hourAt(end <= start ? day + 1 : day, end))
    }
  }
  const points = [...candidates].sort((a, b) => a - b).flatMap((at) => {
    const before = isPeakHour(at - 1, windows, holidays)
    const after = isPeakHour(at, windows, holidays)
    return before === after ? [] : [{ at, intoPeak: after }]
  })
  let prev = null
  let next = null
  for (const p of points) {
    if (p.at <= atMs && (prev === null || p.at > prev.at)) prev = p
    if (p.at > atMs && (next === null || p.at < next.at)) next = p
  }
  const holiday = holidayZoneAt(atMs, holidays)
  const wk = holiday ?? weekendZoneAt(atMs)
  if (wk !== null) {
    // 周末全谷价：当前谷，下一切换 = 下一个工作日的首个峰窗口起点。
    if (next === null) return null
    return {
      inPeak: false,
      weekend: holiday === null,
      ...(holiday ? { holiday: true } : {}),
      prevAtMs: wk.start,
      nextAtMs: next.at,
      nextIntoPeak: next.intoPeak,
    }
  }
  if (prev === null || next === null) return null
  return {
    inPeak: isPeakHour(atMs, windows, holidays),
    weekend: false,
    prevAtMs: prev.at,
    nextAtMs: next.at,
    nextIntoPeak: next.intoPeak,
  }
}
