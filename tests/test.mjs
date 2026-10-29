/**
 * dsh-hormone 单元测试。无第三方依赖，直接 `node tests/test.mjs`。
 *
 * 只测纯逻辑（衰减、事件映射、渲染），不测 IO —— 落盘和注入要靠真机跑一轮验证。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEvent, detectUserTone, settleTurn, textOfContent, tokensOf } from '../lib/events.js'
import { MAX_CHARS, render, THRESHOLD } from '../lib/render.js'
import {
  applyDeltas,
  clamp01,
  decayValue,
  ENERGY,
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

test('project：cortisol 按 4 小时半衰期衰减', () => {
  const start = at(2026, 10, 28, 12)
  const state = freshState(start)
  state.values.cortisol = 0.8
  near(project(state, start + HALF_LIFE.cortisol).cortisol, 0.4, 1e-6)
})

test('project：dopamine 衰减比 cortisol 快得多', () => {
  const start = at(2026, 10, 28, 12)
  const state = freshState(start)
  state.values.cortisol = 0.8
  state.values.dopamine = 0.8
  const after = project(state, start + HALF_LIFE.dopamine)
  near(after.dopamine, 0.4, 1e-6)
  ok(after.cortisol > 0.7, `cortisol 半衰期长，40 分钟后不该掉这么多，实际 ${after.cortisol}`)
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
  near(state.values.cortisol, clamp01(before + 0.25), 1e-9)
})

test('applyEvent：工具报错 cortisol 上涨，连续 3 次额外叠一次', () => {
  const now = at(2026, 10, 28, 12)
  const state = freshState(now)
  const base = state.values.cortisol
  const fail = { type: 'tool/result', data: { message: { isError: true } } }

  applyEvent(state, fail, now)
  near(state.values.cortisol, clamp01(base + 0.15), 1e-9, '第一次报错：')

  applyEvent(state, fail, now)
  near(state.values.cortisol, clamp01(base + 0.3), 1e-9, '第二次报错：')

  applyEvent(state, fail, now)
  near(state.values.cortisol, clamp01(base + 0.15 * 3 + 0.3), 1e-9, '第三次报错要额外叠 0.30：')
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
  near(state.values.energy, clamp01(beforeEnergy - 1000 / ENERGY.dailyBudget), 1e-9, '精力扣减：')
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

test('render：三条全越界也不超过 80 字', () => {
  const text = render({ cortisol: 1, energy: 0, dopamine: 1 })
  ok(text.length <= MAX_CHARS, `超长 ${text.length} > ${MAX_CHARS}：${text}`)
  ok(text.length > 0)
})

test('render：空输入不炸', () => {
  eq(render(null), '')
  eq(render(undefined), '')
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
