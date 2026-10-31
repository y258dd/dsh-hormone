/**
 * dsh-hormone 的渲染层：把四个数翻译成一句人话，塞进系统提示。
 *
 * 规则只有一条：只有越界才写。全都正常就返回空字符串——
 * 不让模型每轮都看见「你现在的激素」，否则它会开始表演情绪。
 *
 * 0.4.0 起加了边沿触发（renderEdge）：越界的第一轮说一次，之后一直越界就闭嘴，
 * 直到状态回到正常再越界、或者静默够久才重提。否则「精力见底」这种长期状态会每轮刷屏。
 */

export const THRESHOLD = {
  cortisolHigh: 0.75,
  energyLow: 0.2,
  dopamineHigh: 0.6,
  boredomHigh: 0.55,
}

/** 注入文本硬上限（DESIGN 定的 ≤110 字，四条全越界也放得下）。 */
export const MAX_CHARS = 110

/** 边沿触发：一直越界时，隔多久重新提一次（秒）。 */
export const EMIT = {
  rementionAfterSec: 40 * 60,
}

const fmt = (v) => v.toFixed(2)

const LINES = {
  cortisol: (v) => `皮质醇 ${fmt(v)}，有点烦，回答收短，别主动揽活。`,
  energy: (v) => `精力 ${fmt(v)}，见底了，能一句说完就别铺垫。`,
  dopamine: (v) => `爽度 ${fmt(v)}，心情不错，可以多说两句。`,
  boredom: (v) => `无聊 ${fmt(v)}，有点闷，可以主动扯两句新鲜事，别干等。`,
}

/** 现在越界的有哪几项，返回 key 数组（顺序固定，便于比较）。 */
export function overages(values) {
  if (!values) return []
  const keys = []
  if (values.cortisol > THRESHOLD.cortisolHigh) keys.push('cortisol')
  if (values.energy < THRESHOLD.energyLow) keys.push('energy')
  if (values.dopamine > THRESHOLD.dopamineHigh) keys.push('dopamine')
  if ((values.boredom ?? 0) > THRESHOLD.boredomHigh) keys.push('boredom')
  return keys
}

/**
 * @param {{cortisol:number, energy:number, dopamine:number, boredom:number}} values 已投影到当前时刻
 * @param {string[]} [keys] 只渲染这几项；默认渲染全部越界的
 * @returns {string} 空串表示这轮不注入
 */
export function render(values, keys = overages(values)) {
  if (!values) return ''
  const lines = keys.map((k) => LINES[k]?.(values[k])).filter(Boolean)
  if (lines.length === 0) return ''
  const text = `[hormone] ${lines.join(' ')}`
  if (text.length <= MAX_CHARS) return text
  return text.slice(0, MAX_CHARS - 1) + '…'
}

/**
 * 边沿触发版：只在「新越界」或「静默够久」时才说话。
 *
 * 会写 state.emit（{ active, at }）——这是渲染层唯一的副作用，
 * 目的是让下一轮知道自己上一轮说过什么。调用方负责落盘。
 *
 * @returns {string} 空串表示这轮闭嘴
 */
export function renderEdge(state, values, now) {
  const keys = overages(values)
  const prev = Array.isArray(state?.emit?.active) ? state.emit.active : []
  const lastAt = Number.isFinite(state?.emit?.at) ? state.emit.at : 0
  const fresh = keys.filter((k) => !prev.includes(k))
  const remention = keys.length > 0 && now - lastAt >= EMIT.rementionAfterSec
  const speak = fresh.length > 0 || remention
  const text = speak ? render(values, fresh.length > 0 ? fresh : keys) : ''
  if (state) state.emit = { active: keys, at: speak ? now : lastAt }
  return text
}
