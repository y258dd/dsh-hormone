/**
 * dsh-hormone 的渲染层：把三个数翻译成一句人话，塞进系统提示。
 *
 * 规则只有一条：只有越界才写。全都正常就返回空字符串——
 * 不让模型每轮都看见「你现在的激素」，否则它会开始表演情绪。
 */

export const THRESHOLD = {
  cortisolHigh: 0.7,
  energyLow: 0.2,
  dopamineHigh: 0.6,
}

/** 注入文本硬上限（DESIGN 定的 ≤80 字）。 */
export const MAX_CHARS = 80

const fmt = (v) => v.toFixed(2)

/**
 * @param {{cortisol:number, energy:number, dopamine:number}} values 已投影到当前时刻
 * @returns {string} 空串表示这轮不注入
 */
export function render(values) {
  if (!values) return ''
  const lines = []

  if (values.cortisol > THRESHOLD.cortisolHigh) {
    lines.push(`皮质醇 ${fmt(values.cortisol)}，有点烦，回答收短，别主动揽活。`)
  }
  if (values.energy < THRESHOLD.energyLow) {
    lines.push(`精力 ${fmt(values.energy)}，见底了，能一句说完就别铺垫。`)
  }
  if (values.dopamine > THRESHOLD.dopamineHigh) {
    lines.push(`爽度 ${fmt(values.dopamine)}，心情不错，可以多说两句。`)
  }

  if (lines.length === 0) return ''
  const text = `[hormone] ${lines.join(' ')}`
  if (text.length <= MAX_CHARS) return text
  return text.slice(0, MAX_CHARS - 1) + '…'
}
