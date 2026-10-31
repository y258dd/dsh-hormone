/**
 * dsh-hormone 单元测试。无第三方依赖，直接 `node tests/test.mjs`。
 *
 * 只测纯逻辑（衰减、事件映射、渲染），不测 IO —— 落盘和注入要靠真机跑一轮验证。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEvent, detectUserTone, settleTurn, textOfContent, tokensOf } from '../lib/events.js'
import { EMIT, MAX_CHARS, overages, render, renderEdge, THRESHOLD } from '../lib/render.js'
import {
  applyDeltas,
  BOREDOM,
  clamp01,
  COUPLING,
  DEBT,
  decayValue,
  effectiveDebt,
  ENERGY,
  energyCostScale,
  freshState,
  HALF_LIFE,
  loadState,
  localDay,
  nowSec,
  project,
  saveState,
  stateFile,
} from '../lib/state.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error.message}`)
  }
}

function ok(value, message = '断言失败') {
  if (!value) throw new Error(message)
}

function eq(actual, expected, message = '') {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function near(actual, expected, eps = 1e-6, message = '') {
  if (!(Math.abs(actual - expected) <= eps)) {
    throw new Error(`${message} 期望 ≈${expected}（±${eps}），实际 ${actual}`)
  }
}

/** 本地时间构造时间戳，测试不依赖机器时区。 */
function at(year, month, day, hour, minute = 0) {
  return Math.floor(new Date(year, month - 1, day, hour, minute, 0).getTime() / 1000)
}

// ── 基础数学 ───────────────────────────────────────────────────────────
console.log('state.js')

test('clamp01 夹在 0–1，非数字当 0', () => {
  eq(clamp01(-0.5), 0)
  eq(clamp01(1.5), 1)
  eq(clamp01(0.42), 0.42)
  eq(clamp01(NaN), 0)
  eq(clamp01(undefined), 0)
})

test('decayValue：过一个半衰期剩一半', () => {
  near(decayValue(0.8, 3600, 3600), 0.4, 1e-9)
  near(decayValue(0.8, 3600, 7200), 0.2, 1e-9)
})

test('decayValue：dt=0 或负数不变', () => {
  eq(decayValue(0.8, 3600, 0), 0.8)
  eq(decayValue(0.8, 3600, -100), 0.8)
})

test('project 是纯函数：不改 state', () => {
  const state = freshState(at(2026, 10, 28, 12))
  const snapshot = JSON.stringify(state)
  project(state, at(2026, 10, 28, 18))
  eq(JSON.stringify(state), snapshot)
})

test('project：cortisol 按半衰期衰减（爽度为 0 时不加速）', () => {
  const start = at(2026, 10, 28, 12)
  const state = freshState(start)
  state.values.cortisol = 0.8
  state.values.dopamine = 0
  near(project(state, start + HALF_LIFE.cortisol).cortisol, 0.4, 1e-6)
})

test('project：开心让压力散得更快（耦合 joyDecay）', () => {
  const start = at(2026, 10, 28, 12)
  const blue = freshState(start)
  blue.values.cortisol = 0.8
  blue.values.dopamine = 0
  const happy = freshState(start)
  happy.values.cortisol = 0.8
  happy.values.dopamine = 1
  const dt = 60 * 60
  const blueAfter = project(blue, start + dt).cortisol
  const happyAfter = project(happy, start + dt).cortisol
  ok(happyAfter < blueAfter, `开心时压力该掉得更快：${happyAfter} vs ${blueAfter}`)
})

test('project：dopamine 衰减比 cortisol 快得多', () => {
  const start = at(2026, 10, 28, 12)
  const state = freshState(start)
  state.values.cortisol = 0.8
  state.values.dopamine = 0.8
  const after = project(state, start + HALF_LIFE.dopamine)
  near(after.dopamine, 0.4, 1e-6)
  ok(after.cortisol > 0.6, `40 分钟后 cortisol 不该掉到一半以下，实际 ${after.cortisol}`)
})

test('project：跨天 energy 回升', () => {
  const day1 = at(2026, 10, 28, 12)
  const state = freshState(day1)
  state.values.energy = 0.1
  const next = project(state, at(2026, 10, 29, 12))
  ok(next.energy > 0.5, `跨天后 energy 应明显回升，实际 ${next.energy}`)
  eq(localDay(at(2026, 10, 29, 12)) !== localDay(day1), true)
})

test('project：空闲超过 1h 才回升，且不直接回满', () => {
  const start = at(2026, 10, 28, 12)
  const state = freshState(start)
  state.values.energy = 0.1
  const noIdle = project(state, start + 30 * 60)
  near(noIdle.energy, 0.1, 1e-9, '不到 1h 不该回升：')
  const idle = project(state, start + 3 * 3600)
  ok(idle.energy > 0.1, `空闲 3h 应回升，实际 ${idle.energy}`)
  ok(idle.energy < ENERGY.dayBaseline, `不该一次回满，实际 ${idle.energy}`)
})

test('project：闲聊不推迟恢复（计时只看 lastWorkAt）', () => {
  const start = at(2026, 10, 28, 12)
  const state = freshState(start)
  state.values.energy = 0.1
  // 每 20 分钟来一条闲聊，updatedAt 一直刷新，但没干活
  state.updatedAt = start + 20 * 60
  state.lastWorkAt = start
  const after = project(state, start + 90 * 60)
  ok(after.energy > 0.1, `没干活就该开始回升，实际 ${after.energy}`)
})

test('project：同样空闲 3 小时，深夜基线低于白天', () => {
  // 起点和空闲时长都一样，只有投影时刻落在深夜还是白天不同。
  const nightStart = at(2026, 10, 28, 1)
  const night = freshState(nightStart)
  night.values.energy = 0.1
  const nightEnergy = project(night, nightStart + 3 * 3600).energy

  const dayStart = at(2026, 10, 28, 12)
  const day = freshState(dayStart)
  day.values.energy = 0.1
  const dayEnergy = project(day, dayStart + 3 * 3600).energy

  ok(nightEnergy < dayEnergy, `深夜应低于白天：${nightEnergy} vs ${dayEnergy}`)
})

test('project：没人说话就慢慢无聊，且不会超过 1', () => {
  const start = at(2026, 10, 28, 12)
  const state = freshState(start)
  eq(project(state, start + 10 * 60).boredom, BOREDOM.start, '宽限期内不涨：')
  const quiet = project(state, start + 6 * 3600).boredom
  ok(quiet > BOREDOM.start + 0.2, `6 小时没人说话该闷起来，实际 ${quiet}`)
  ok(quiet < 1, `不该顶满，实际 ${quiet}`)
})

test('project：分段投影和一次性投影结果一致（不会重复叠加）', () => {
  const start = at(2026, 10, 28, 12)
  const once = freshState(start)
  once.values.energy = 0.2
  once.values.boredom = 0.1
  const expected = project(once, start + 2 * 3600)

  const step = freshState(start)
  step.values.energy = 0.2
  step.values.boredom = 0.1
  // 模拟每半小时落盘一次：投影值写回，updatedAt 前进
  for (let i = 1; i <= 4; i += 1) {
    const t = start + i * 1800
    const p = project(step, t)
    step.values.energy = p.energy
    step.values.boredom = p.boredom
    step.updatedAt = t
  }
  near(step.values.energy, expected.energy, 1e-9, 'energy：')
  near(step.values.boredom, expected.boredom, 1e-9, 'boredom：')
})

test('applyDeltas：同样一活儿，压力大时更累、爽度高时没那么累', () => {
  const now = at(2026, 10, 28, 12)
  const cost = 0.1
  const happy = freshState(now)
  happy.values.cortisol = 0
  happy.values.dopamine = 0.9
  applyDeltas(happy, { energy: -cost }, now)

  const stressed = freshState(now)
  stressed.values.cortisol = 0.9
  stressed.values.dopamine = 0
  applyDeltas(stressed, { energy: -cost }, now)

  ok(happy.values.energy > stressed.values.energy, `开心时该掉得少：${happy.values.energy} vs ${stressed.values.energy}`)
  ok(
    energyCostScale({ cortisol: 0.9, dopamine: 0 }) > energyCostScale({ cortisol: 0, dopamine: 0.9 }),
    '压力让消耗变大、爽度让消耗变小',
  )
})

test('applyDeltas：上下界不会溢出', () => {
  const state = freshState(at(2026, 10, 28, 12))
  for (let i = 0; i < 50; i += 1) {
    applyDeltas(state, { cortisol: 0.5, dopamine: 0.5 }, at(2026, 10, 28, 12))
  }
  eq(state.values.cortisol, 1)
  eq(state.values.dopamine, 1)
  for (let i = 0; i < 50; i += 1) {
    applyDeltas(state, { cortisol: -0.5, energy: -0.5 }, at(2026, 10, 28, 12))
  }
  eq(state.values.cortisol, 0)
  eq(state.values.energy, 0)
})

test('applyDeltas：小变化不写 history，大变化写', () => {
  const state = freshState(at(2026, 10, 28, 12))
  applyDeltas(state, { cortisol: 0.005 }, at(2026, 10, 28, 12), 'tiny')
  eq(state.history.length, 0, '微小变化不该记历史：')
  applyDeltas(state, { cortisol: 0.3 }, at(2026, 10, 28, 12), 'big')
  eq(state.history.length, 1)
  eq(state.history[0].why, 'big')
})

test('applyDeltas：history 上限 400 条', () => {
  const state = freshState(at(2026, 10, 28, 12))
  for (let i = 0; i < 450; i += 1) {
    applyDeltas(state, { dopamine: i % 2 === 0 ? 0.3 : -0.3 }, at(2026, 10, 28, 12), 'spam')
  }
  ok(state.history.length <= 400, `history 应该被裁剪，实际 ${state.history.length}`)
})

// ── 情绪耦合与睡眠债 ──────────────────────────────────────────────────
test('energyCostScale：心情好时省得更快（爽度项开方）', () => {
  // 线性的话 d=0.25 是 1 - 0.5*0.25 = 0.875；开方后是 1 - 0.5*0.5 = 0.75
  near(energyCostScale({ cortisol: 0, dopamine: 0.25 }), 0.75, 1e-9)
  near(energyCostScale({ cortisol: 0, dopamine: 1 }), 0.5, 1e-9)
  near(energyCostScale({ cortisol: 0, dopamine: 0 }), 1, 1e-9)
  near(energyCostScale({ cortisol: 0, dopamine: 1 }), 1 - COUPLING.joyCost, 1e-9, '满值还是省 joyCost：')
})

test('effectiveDebt：24 小时线性衰减到 0，且有上限', () => {
  const t = at(2026, 10, 28, 0)
  const st = { debt: { amount: 0.4, at: t } }
  near(effectiveDebt(st, t), 0.4, 1e-9)
  near(effectiveDebt(st, t + 12 * 3600), 0.2, 1e-9)
  near(effectiveDebt(st, t + 24 * 3600), 0, 1e-9)
  eq(effectiveDebt(st, t + 48 * 3600), 0)
  near(effectiveDebt({ debt: { amount: 9, at: t } }, t), DEBT.max, 1e-9)
  eq(effectiveDebt(freshState(t), t), 0, '没记债就是 0：')
})

test('applyDeltas：深夜干活记睡眠债，立刻压低上限', () => {
  const night = at(2026, 10, 28, 2)
  const state = freshState(night)
  state.values.energy = 1
  applyDeltas(state, { energy: -0.2 }, night)
  ok(effectiveDebt(state, night) > 0.2, `深夜扣精力该记债，实际 ${effectiveDebt(state, night)}`)
  ok(state.values.energy < 0.8, `上限被压低，实际 ${state.values.energy}`)

  const day = at(2026, 10, 28, 14)
  const dayState = freshState(day)
  dayState.values.energy = 1
  applyDeltas(dayState, { energy: -0.2 }, day)
  eq(dayState.debt.amount, 0, '白天不该记债：')
})

test('project：睡眠债压低精力上限，回也回不到满', () => {
  const now = at(2026, 10, 28, 14)
  const state = freshState(now)
  state.values.energy = 1
  state.debt = { amount: 0.4, at: now }
  const p = project(state, now + 60)
  ok(p.energy <= 1 - 0.4 + 1e-3, `上限约 0.6（债在缓慢衰减），实际 ${p.energy}`)
})

test('applyDeltas：深夜记债后 history 带 debt 字段', () => {
  const night = at(2026, 10, 28, 3)
  const state = freshState(night)
  applyDeltas(state, { energy: -0.3 }, night, 'late')
  eq(state.history.length, 1)
  ok(state.history[0].debt > 0, `history 该记下债务：${JSON.stringify(state.history[0])}`)
})

// ── 事件映射 ───────────────────────────────────────────────────────────
console.log('events.js')

test('detectUserTone：认得出夸奖', () => {
  eq(detectUserTone('好棒，这个可以'), 'praise')
  eq(detectUserTone('谢谢'), 'praise')
  eq(detectUserTone('挺靠谱的'), 'praise')
})

test('detectUserTone：认得出批评，且批评优先', () => {
  eq(detectUserTone('这里又错了'), 'blame')
  eq(detectUserTone('你搞错了，不是这个'), 'blame')
  eq(detectUserTone('谢谢，但是你理解错了'), 'blame', '同一句里又有谢又有错，应该算批评：')
})

test('detectUserTone：普通指令不算情绪', () => {
  eq(detectUserTone('把那个文件改成 JSON'), null)
  eq(detectUserTone(''), null)
  eq(detectUserTone(undefined), null)
})

test('textOfContent：字符串和块数组都能取到文本', () => {
  eq(textOfContent('hello'), 'hello')
  eq(textOfContent([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
  eq(textOfContent(null), '')
})

test('tokensOf：四类 token 相加，字符串数字也认', () => {
  eq(tokensOf({ inputTokens: 10, outputTokens: 5 }), 15)
  eq(tokensOf({ inputTokens: '10', cacheReadTokens: '2', cacheWriteTokens: 3, outputTokens: '5' }), 20)
  eq(tokensOf(null), 0)
  eq(tokensOf({ inputTokens: -5 }), 0)
})

test('applyEvent：插件自己塞的 user/message 不算用户情绪', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  const before = state.values.dopamine
  const result = applyEvent(
    state,
    { type: 'user/message', data: { content: [{ type: 'text', text: '好棒' }], source: { kind: 'plugin' } } },
    now,
  )
  eq(result, null)
  eq(state.values.dopamine, before)
})

test('applyEvent：被夸 dopamine 上涨', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  const before = state.values.dopamine
  ok(applyEvent(state, { type: 'user/message', data: { content: [{ type: 'text', text: '好棒' }], source: { kind: 'user' } } }, now))
  near(state.values.dopamine, clamp01(before + 0.4), 1e-9)
})

test('applyEvent：被批评 cortisol 上涨', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  const before = state.values.cortisol
  ok(applyEvent(state, { type: 'user/message', data: { content: '又错了', source: { kind: 'user' } } }, now))
  near(state.values.cortisol, clamp01(before + 0.12), 1e-9)
})

test('applyEvent：工具报错 cortisol 上涨，连续 3 次额外叠一次', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  const base = state.values.cortisol
  const fail = { type: 'tool/result', data: { message: { isError: true } } }

  applyEvent(state, fail, now)
  near(state.values.cortisol, clamp01(base + 0.08), 1e-9, '第一次报错：')

  applyEvent(state, fail, now)
  near(state.values.cortisol, clamp01(base + 0.16), 1e-9, '第二次报错：')

  applyEvent(state, fail, now)
  near(state.values.cortisol, clamp01(base + 0.08 * 3 + 0.15), 1e-9, '第三次报错要额外叠 0.15：')
})

test('applyEvent：真人说话缓解无聊，并重置无聊计时', () => {
  const now = at(2026, 10, 28, 12)
  const start = now - 8 * 3600
  const state = freshState(start)
  state.lastUserAt = start
  const before = project(state, now).boredom
  ok(before > 0.3, `8 小时没人说话应该先闷起来，实际 ${before}`)
  applyEvent(state, { type: 'user/message', data: { content: '在吗', source: { kind: 'user' } } }, now)
  ok(state.values.boredom < before, `说话该缓解无聊：${state.values.boredom} vs ${before}`)
  eq(state.lastUserAt, now, '无聊计时该重置：')
})

test('applyEvent：成功的工具调用会清空连续错误计数', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  const fail = { type: 'tool/result', data: { message: { isError: true } } }
  applyEvent(state, fail, now)
  applyEvent(state, fail, now)
  eq(state.session.consecutiveErrors, 2)
  applyEvent(state, { type: 'tool/result', data: { message: { isError: false } } }, now)
  eq(state.session.consecutiveErrors, 0)
})

test('applyEvent：turn 变化时结算上一轮——没出错就有奖励', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  const beforeEnergy = state.values.energy
  const beforeDopamine = state.values.dopamine
  const beforeCortisol = state.values.cortisol

  // 第一轮干过活（有工具调用），跑了两条消息
  applyEvent(state, { type: 'tool/result', data: { message: { isError: false } } }, now)
  applyEvent(state, { type: 'assistant/message', data: { turn: 1, usage: { outputTokens: 500 } } }, now)
  applyEvent(state, { type: 'assistant/message', data: { turn: 1, usage: { outputTokens: 500 } } }, now)
  eq(state.session.tokensInTurn, 1000)
  eq(state.values.dopamine, beforeDopamine, '轮次没结束时不该结算：')

  // 第二轮开始 → 结算第一轮
  const changed = applyEvent(state, { type: 'assistant/message', data: { turn: 2, usage: { outputTokens: 0 } } }, now)
  ok(changed, '轮次切换应该产生变化')
  // 扣精力要乘情绪系数：这一轮开始时 cortisol 0.2、dopamine 0.1
  const scale = energyCostScale({ cortisol: beforeCortisol, dopamine: beforeDopamine })
  near(
    state.values.energy,
    clamp01(beforeEnergy - (1000 / ENERGY.dailyBudget) * scale),
    1e-9,
    '精力扣减：',
  )
  near(state.values.dopamine, clamp01(beforeDopamine + 0.35), 1e-9, '成功收尾加爽度：')
  near(state.values.cortisol, clamp01(beforeCortisol - 0.2), 1e-9, '成功收尾泄压力：')
  eq(state.session.tokensInTurn, 0, '新轮次 token 计数应清零：')
})

test('applyEvent：这一轮出过错就不给奖励', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  const beforeDopamine = state.values.dopamine

  applyEvent(state, { type: 'assistant/message', data: { turn: 1, usage: { outputTokens: 100 } } }, now)
  applyEvent(state, { type: 'tool/result', data: { message: { isError: true } } }, now)
  applyEvent(state, { type: 'assistant/message', data: { turn: 2, usage: { outputTokens: 100 } } }, now)

  near(state.values.dopamine, beforeDopamine, 1e-9, '出错的一轮不该加爽度：')
})

test('settleTurn：没调工具的闲聊轮不扣精力、不给收尾奖励', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  const before = { ...state.values }
  state.lastWorkAt = now - 7200
  applyEvent(state, { type: 'assistant/message', data: { turn: 1, usage: { outputTokens: 50000 } } }, now)
  const changed = applyEvent(state, { type: 'assistant/message', data: { turn: 2, usage: { outputTokens: 0 } } }, now)

  eq(changed, null, '闲聊轮不该产生状态变化：')
  near(state.values.energy, before.energy, 1e-9, '闲聊不该扣精力：')
  near(state.values.dopamine, before.dopamine, 1e-9, '闲聊不该加爽度：')
  near(state.values.cortisol, before.cortisol, 1e-9, '闲聊不该泄压力：')
  eq(state.lastWorkAt, now - 7200, '闲聊不该刷新干活时间：')
  eq(state.session.toolsInTurn, 0, '闲聊轮结束后工具计数应清零：')
})

test('settleTurn：重复调用不会二次结算', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  applyEvent(state, { type: 'tool/result', data: { message: { isError: false } } }, now)
  applyEvent(state, { type: 'assistant/message', data: { turn: 1, usage: { outputTokens: 1000 } } }, now)
  const first = settleTurn(state, state.session, now)
  ok(first)
  const second = settleTurn(state, state.session, now)
  eq(second, null)
})

test('applyEvent：陌生事件直接忽略', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  eq(applyEvent(state, { type: 'compaction/summary', data: {} }, now), null)
  eq(applyEvent(state, null, now), null)
})

// ── 渲染 ───────────────────────────────────────────────────────────────
console.log('render.js')

test('render：都不越界时返回空串（不注入）', () => {
  eq(render({ cortisol: 0.3, energy: 0.8, dopamine: 0.2 }), '')
})

test('render：阈值是开区间，正好等于阈值不注入', () => {
  eq(render({ cortisol: THRESHOLD.cortisolHigh, energy: 0.5, dopamine: 0 }), '')
  eq(render({ cortisol: 0.3, energy: THRESHOLD.energyLow, dopamine: 0 }), '')
  eq(render({ cortisol: 0.3, energy: 0.5, dopamine: THRESHOLD.dopamineHigh }), '')
})

test('render：越界才出文本，且带前缀', () => {
  const text = render({ cortisol: 0.85, energy: 0.8, dopamine: 0.1 })
  ok(text.startsWith('[hormone]'), `缺前缀：${text}`)
  ok(text.includes('0.85'), `缺数值：${text}`)
})

test('render：四条全越界也不超过 MAX_CHARS', () => {
  const text = render({ cortisol: 1, energy: 0, dopamine: 1, boredom: 1 })
  ok(text.length <= MAX_CHARS, `超长 ${text.length} > ${MAX_CHARS}：${text}`)
  ok(text.includes('无聊'), `该带上无聊：${text}`)
  ok(text.length > 0)
})

test('render：空输入不炸', () => {
  eq(render(null), '')
  eq(render(undefined), '')
})

test('overages：按固定顺序给出越界项', () => {
  eq(
    overages({ cortisol: 0.9, energy: 0.1, dopamine: 0.9, boredom: 0.9 }).join(),
    'cortisol,energy,dopamine,boredom',
  )
  eq(overages({ cortisol: 0.1, energy: 0.9, dopamine: 0.1, boredom: 0 }).length, 0)
})

test('renderEdge：新越界说一次，持续越界不再刷屏', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  const tired = { cortisol: 0.3, energy: 0.1, dopamine: 0.2, boredom: 0 }
  const first = renderEdge(state, tired, now)
  ok(first.includes('精力'), `第一次该说：${first}`)
  eq(state.emit.active.join(), 'energy')
  eq(renderEdge(state, tired, now + 60), '', '还越界但没新情况，闭嘴：')
})

test('renderEdge：恢复正常后再越界，会重新说', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  const tired = { cortisol: 0.3, energy: 0.1, dopamine: 0.2, boredom: 0 }
  renderEdge(state, tired, now)
  renderEdge(state, { cortisol: 0.3, energy: 0.8, dopamine: 0.2, boredom: 0 }, now + 60)
  eq(state.emit.active.length, 0)
  const again = renderEdge(state, tired, now + 120)
  ok(again.includes('精力'), `重新越界该再说：${again}`)
})

test('renderEdge：一直越界，静默够久才重提一次', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  const tired = { cortisol: 0.3, energy: 0.1, dopamine: 0.2, boredom: 0 }
  renderEdge(state, tired, now)
  eq(renderEdge(state, tired, now + EMIT.rementionAfterSec - 60), '', '没到时间不该重提：')
  const again = renderEdge(state, tired, now + EMIT.rementionAfterSec + 60)
  ok(again.includes('精力'), `静默够久该重提：${again}`)
  eq(renderEdge(state, tired, now + EMIT.rementionAfterSec + 120), '', '重提后又要闭嘴：')
})

test('renderEdge：全部正常时不说话，也不留残留', () => {
  const state = freshState(at(2026, 10, 28, 12))
  eq(renderEdge(state, { cortisol: 0.1, energy: 0.9, dopamine: 0.1, boredom: 0 }, 0), '')
  eq(state.emit.active.length, 0)
})

test('renderEdge：同时新越界两项，一次都说出来', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  const text = renderEdge(state, { cortisol: 0.9, energy: 0.1, dopamine: 0.2, boredom: 0 }, now)
  ok(text.includes('皮质醇') && text.includes('精力'), `两条都该说：${text}`)
  eq(state.emit.active.join(), 'cortisol,energy')
})

// ── 落盘 ───────────────────────────────────────────────────────────────
console.log('持久化')

test('saveState / loadState 往返一致，坏文件回退默认', () => {
  const previousHome = process.env.DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hormone-test-'))
  process.env.DSH_HOME = dir
  try {
    eq(stateFile(), join(dir, 'hormone', 'state.json'))

    const now = at(2026, 10, 28, 12)
    const state = freshState(now)
    state.values.cortisol = 0.66
    state.values.energy = 0.33
    state.values.dopamine = 0.55
    state.session.consecutiveErrors = 2
    applyDeltas(state, { dopamine: 0.2 }, now, 'roundtrip')
    saveState(state)

    const loaded = loadState()
    near(loaded.values.cortisol, state.values.cortisol, 1e-9)
    near(loaded.values.energy, state.values.energy, 1e-9)
    near(loaded.values.dopamine, state.values.dopamine, 1e-9)
    eq(loaded.session.consecutiveErrors, 2)
    eq(loaded.history.length, state.history.length)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadState：老状态缺 emit / debt 时兜底，不把「没说过」当成「说过了」', () => {
  const previousHome = process.env.DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hormone-legacy-'))
  process.env.DSH_HOME = dir
  try {
    mkdirSync(join(dir, 'hormone'), { recursive: true })
    const now = at(2026, 10, 28, 12)
    writeFileSync(
      join(dir, 'hormone', 'state.json'),
      JSON.stringify({ version: 1, updatedAt: now, values: { cortisol: 0.2, energy: 0.5, dopamine: 0.1 } }),
      'utf8',
    )
    const loaded = loadState()
    eq(loaded.debt.amount, 0, '老状态没有睡眠债：')
    eq(loaded.emit.active.length, 0, '老状态没有 emit：')
    eq(loaded.emit.at, 0)
    eq(loaded.values.boredom, BOREDOM.start, '老状态补上无聊初值：')
    eq(loaded.lastUserAt, now, '老状态用 updatedAt 兜底：')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadState：一天没动过也能正常投影（不依赖写盘时机）', () => {
  const now = nowSec()
  const state = freshState(now)
  state.values.energy = 0.1
  const later = project(state, now + 20 * 3600)
  ok(later.energy > state.values.energy)
})

// ── 结果 ───────────────────────────────────────────────────────────────
console.log(`\n${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
