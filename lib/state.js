/**
 * dsh-hormone 的状态层：读/写 state.json、衰减、跨天恢复、原子写。
 *
 * 四个数只是 0–1 的连续变量，没有「情绪标签」。变化只有两个来源：
 *   1. 事件增量（events.js）；
 *   2. 时间衰减 / 跨天恢复 / 情绪之间互相拉扯（本文件）。
 * 模型不能改它们（DESIGN 护栏 1）——插件不提供任何写入工具。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 半衰期（秒）。cortisol 3 小时，dopamine 40 分钟。energy 不走半衰期，见 ENERGY。 */
export const HALF_LIFE = {
  cortisol: 3 * 60 * 60,
  dopamine: 40 * 60,
}

export const ENERGY = {
  /**
   * 日预算：一轮的 token 消耗 ÷ 这个数 = energy 扣减量。
   * 0.2.0 取 800 万，实测一天就见底；0.3.0 先放到 2500 万，太松（要连干 8 天才见底）；
   * 0.4.0 按 ~/.dsh/.dshw-usage.json 12 天实测定为 1300 万：
   * 日均 299 万掉 0.23、中位日 226 万掉 0.17、峰值日 967 万掉 0.74。
   * 觉得掉太快/太慢就改这一个数。
   */
  dailyBudget: 13_000_000,
  /** 跨天恢复：日期变了，energy 至少回升这么多。 */
  dayRecover: 0.8,
  /**
   * 距上次「干活」超过这个时长才缓慢回升（秒）。
   * 只认调过工具的真活：闲聊不刷新这个计时，否则一整天扯淡精力永远涨不回来。
   */
  idleRecoverAfter: 30 * 60,
  /** 回升半衰期：向基线靠拢一半所需时间（压力高时会被拉长，见 COUPLING）。 */
  recoverHalfLife: 4 * 60 * 60,
  /** 白天基线。 */
  dayBaseline: 0.9,
  /** 深夜基线：00:00–07:00 压低，熬夜不会回满。 */
  nightBaseline: 0.45,
  nightFrom: 0,
  nightTo: 7,
}

/**
 * 睡眠债：深夜还干活，第二天精力上限打折。
 * 记债时刻起 24 小时内线性衰减——睡一觉就还清，连续熬夜会累加（有上限）。
 */
export const DEBT = {
  /** 深夜窗口内每扣掉 1 点精力，记多少债。 */
  ratio: 1.3,
  /** 债的上限：第二天精力最多打这个折。 */
  max: 0.4,
  /** 从记债时刻起，多少小时内衰减到 0。 */
  decayHours: 24,
}

/**
 * 无聊：没人跟它说话就慢慢闷起来，真人一开口就缓解（DELTA.userChat）。
 * 计时源是 lastUserAt，不是 updatedAt——我自己干活刷新的时间不算「有人陪」。
 */
export const BOREDOM = {
  /** 多久没人说话才开始闷（秒）。 */
  grace: 25 * 60,
  /** 之后向 1 靠拢的半衰期。 */
  riseHalfLife: 5 * 60 * 60,
  /** 初始值。 */
  start: 0.05,
}

/**
 * 情绪耦合：四个变量不是各算各的。
 * 越开心越不累、越开心压力散得越快、压力越大恢复越慢。
 */
export const COUPLING = {
  /** 精力扣减放大：cortisol=1 时消耗 ×(1+0.4)。 */
  stressCost: 0.4,
  /** 精力扣减缩小：按 √dopamine 算，dopamine=1 时消耗 ×(1-0.5)，d=0.3 时已经省 27%。 */
  joyCost: 0.5,
  /** 开心让压力散得快：有效半衰期 ×(1-0.35×dopamine)，最快缩短 35%。 */
  joyDecay: 0.35,
  /** 压力让精力回得慢：有效恢复半衰期 ×(1+1.5×cortisol)，最慢拉到 2.5 倍。 */
  stressRecover: 1.5,
}

/**
 * 精力扣减系数：压力往上推，爽度往下压，夹在 0.4–2.5 之间。
 *
 * 爽度那一条用 √ 而不是线性：为了「中等开心就已经省得明显」——
 * 线性省的话 dopamine=0.3 才省 15%，几乎感觉不到；开方后是 27%。
 * 极端值仍然封在 −50% / +40%，不会因为一时兴奋或烦躁把一项工作算成两个。
 */
export function energyCostScale(values) {
  const cortisol = clamp01(values?.cortisol ?? 0)
  const dopamine = clamp01(values?.dopamine ?? 0)
  const scale = 1 + COUPLING.stressCost * cortisol - COUPLING.joyCost * Math.sqrt(dopamine)
  return Math.min(2.5, Math.max(0.4, scale))
}

/** history 上限。只用于验收时看曲线，不参与任何计算。 */
export const MAX_HISTORY = 400

/** history 只在累计变化超过这个量时才记一条，避免刷盘噪音。 */
const HISTORY_MIN_MOVE = 0.02

export function clamp01(v) {
  if (!Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/** 半衰期衰减：过了 dt 秒，剩 v × 0.5^(dt / 半衰期)。 */
export function decayValue(v, halfLifeSec, dtSec) {
  if (!(dtSec > 0) || !(halfLifeSec > 0)) return clamp01(v)
  return clamp01(v * Math.pow(0.5, dtSec / halfLifeSec))
}

/** 本地小时对应的 energy 基线。注意 0–7 这个窗口不跨午夜，用 && 判。 */
export function baselineEnergy(hour) {
  const night = hour >= ENERGY.nightFrom && hour < ENERGY.nightTo
  return night ? ENERGY.nightBaseline : ENERGY.dayBaseline
}

export function localDay(nowSec) {
  const d = new Date(nowSec * 1000)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function nowSec() {
  return Math.floor(Date.now() / 1000)
}

export function freshValues() {
  return { cortisol: 0.2, energy: ENERGY.dayBaseline, dopamine: 0.1, boredom: BOREDOM.start }
}

export function freshState(now = nowSec()) {
  return {
    version: 1,
    updatedAt: now,
    day: localDay(now),
    /** 上次真正干活的时刻。精力恢复从这时计时，不随闲聊刷新。 */
    lastWorkAt: now,
    /** 上次真人说话的时刻。无聊从这时计时。 */
    lastUserAt: now,
    /** 睡眠债：{ amount, at }。at 是记债时刻，从那时起 24 小时线性衰减到 0。 */
    debt: { amount: 0, at: now },
    /** 注入边沿触发用：上一轮越界的是哪几项、上次说话的时刻。 */
    emit: { active: [], at: 0 },
    values: freshValues(),
    session: { turn: null, tokensInTurn: 0, toolsInTurn: 0, errorsInTurn: 0, consecutiveErrors: 0 },
    history: [],
  }
}

/** 现在还剩多少睡眠债（0–DEBT.max）。纯函数，靠绝对时间算，反复调用结果一致。 */
export function effectiveDebt(state, now = nowSec()) {
  const amount = Number(state?.debt?.amount)
  const at = state?.debt?.at
  if (!(amount > 0) || !Number.isFinite(at)) return 0
  const passed = Math.max(0, now - at)
  const left = 1 - passed / (DEBT.decayHours * 60 * 60)
  if (left <= 0) return 0
  return Math.min(DEBT.max, amount * left)
}

/** 一次「向目标靠拢」：从 base 出发，过了 sec 秒，靠拢了多少。 */
function approach(base, target, sec, halfLife) {
  if (!(sec > 0) || !(halfLife > 0)) return clamp01(base)
  return clamp01(base + (target - base) * (1 - Math.pow(0.5, sec / halfLife)))
}

/**
 * 从 updatedAt 投影到现在。纯函数：不改 state、不落盘。
 * 渲染和「加增量」都用它打底，所以衰减不会被重复叠加。
 * 依赖时长的几项只算「上次写盘之后新增的那一段」，反复调用结果一致。
 */
export function project(state, now = nowSec()) {
  const dt = Math.max(0, now - state.updatedAt)
  const hour = new Date(now * 1000).getHours()
  const values = state.values ?? freshValues()
  const cortisol0 = clamp01(values.cortisol)
  const dopamine0 = clamp01(values.dopamine)
  let energy = clamp01(values.energy)

  // 1. 跨天：日期变了就回升一大截（模拟睡了一觉）。
  if (state.day && state.day !== localDay(now)) {
    energy = clamp01(energy + ENERGY.dayRecover)
  }

  // 2. 长时间没干活：向「当前时段」的基线靠拢。
  //    不是加满——深夜的基线本来就低，熬夜补不回来。
  //    压力大时恢复变慢（COUPLING.stressRecover）。
  //    计时只认 lastWorkAt（上一轮真正干活的时刻），闲聊不推迟恢复。
  //    睡眠债会压低上限：熬夜后的第二天，回也回不到满。
  const debt = effectiveDebt(state, now)
  const ceiling = 1 - debt
  const lastWork = Number.isFinite(state.lastWorkAt) ? state.lastWorkAt : state.updatedAt
  const idle = Math.max(0, now - lastWork)
  const idleBefore = Math.max(0, state.updatedAt - lastWork)
  const recoverSec = Math.max(0, idle - Math.max(idleBefore, ENERGY.idleRecoverAfter))
  if (recoverSec > 0) {
    const halfLife = ENERGY.recoverHalfLife * (1 + COUPLING.stressRecover * cortisol0)
    energy = approach(energy, Math.min(baselineEnergy(hour), ceiling), recoverSec, halfLife)
  }
  energy = Math.min(energy, ceiling)

  // 3. 无聊：从「上次真人说话」起算，过了宽限期慢慢向 1 靠拢。
  //    同样只算上次写盘之后新增的那一段，避免每次结算重复叠加。
  const lastUser = Number.isFinite(state.lastUserAt) ? state.lastUserAt : state.updatedAt
  const quiet = Math.max(0, now - lastUser)
  const quietBefore = Math.max(0, state.updatedAt - lastUser)
  const boredSec = Math.max(0, quiet - Math.max(quietBefore, BOREDOM.grace))
  const boredom = approach(
    clamp01(values.boredom ?? BOREDOM.start),
    1,
    boredSec,
    BOREDOM.riseHalfLife,
  )

  // 4. 开心的时候压力散得更快：有效半衰期最短缩到 65%。
  const cortisolHalfLife = HALF_LIFE.cortisol * (1 - COUPLING.joyDecay * dopamine0)

  return {
    cortisol: decayValue(cortisol0, cortisolHalfLife, dt),
    energy,
    dopamine: decayValue(dopamine0, HALF_LIFE.dopamine, dt),
    boredom,
  }
}

function round3(v) {
  return Math.round(clamp01(v) * 1000) / 1000
}

function pushHistory(state, now, why) {
  const row = {
    t: now,
    cortisol: round3(state.values.cortisol),
    energy: round3(state.values.energy),
    dopamine: round3(state.values.dopamine),
    boredom: round3(state.values.boredom),
  }
  const debt = effectiveDebt(state, now)
  if (debt > 0) row.debt = round3(debt)
  if (why) row.why = why
  state.history.push(row)
  if (state.history.length > MAX_HISTORY) {
    state.history.splice(0, state.history.length - MAX_HISTORY)
  }
}

/**
 * 先投影到现在，再加增量，写回 state（含 updatedAt / day / history）。
 * 返回 state 本身，方便链式调用。
 *
 * 扣精力的增量要乘 energyCostScale：同样一活儿，烦的时候更累，心情好的时候没那么累
 * ——这就是「情绪互相影响」落到行为上的那一步。
 */
export function applyDeltas(state, deltas, now = nowSec(), why = '') {
  const projected = project(state, now)
  const before = state.values ?? freshValues()
  let energyDelta = deltas?.energy ?? 0
  if (energyDelta < 0) {
    energyDelta *= energyCostScale(projected)
    // 深夜（00:00–07:00）还在干活：记一笔睡眠债，第二天精力上限打折。
    // 注意是 &&：0–7 这个窗口不跨午夜，写成 || 会让全天都算深夜。
    const hour = new Date(now * 1000).getHours()
    if (hour >= ENERGY.nightFrom && hour < ENERGY.nightTo) {
      const owed = effectiveDebt(state, now)
      state.debt = { amount: Math.min(DEBT.max, owed - energyDelta * DEBT.ratio), at: now }
    }
  }
  const ceiling = 1 - effectiveDebt(state, now)
  const next = {
    cortisol: clamp01(projected.cortisol + (deltas?.cortisol ?? 0)),
    energy: Math.min(clamp01(projected.energy + energyDelta), ceiling),
    dopamine: clamp01(projected.dopamine + (deltas?.dopamine ?? 0)),
    boredom: clamp01(projected.boredom + (deltas?.boredom ?? 0)),
  }
  const moved =
    Math.abs(next.cortisol - before.cortisol) +
    Math.abs(next.energy - before.energy) +
    Math.abs(next.dopamine - before.dopamine) +
    Math.abs(next.boredom - (before.boredom ?? 0))

  state.values = next
  state.updatedAt = now
  state.day = localDay(now)
  if (moved >= HISTORY_MIN_MOVE) pushHistory(state, now, why)
  return state
}

// ── 存储 ──────────────────────────────────────────────────────────────
export function stateFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'hormone', 'state.json')
}

function asFiniteOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback
}

/** 读盘。坏文件、旧版本、缺字段一律回退到默认值，不让插件因为脏数据起不来。 */
export function loadState() {
  let raw
  try {
    raw = JSON.parse(readFileSync(stateFile(), 'utf8'))
  } catch {
    return freshState()
  }
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return freshState()

  const base = freshState(asFiniteOr(raw.updatedAt, nowSec()))
  const v = raw.values ?? {}
  const s = raw.session ?? {}
  const state = {
    version: 1,
    updatedAt: base.updatedAt,
    day: typeof raw.day === 'string' && raw.day !== '' ? raw.day : base.day,
    // 老状态没有 lastWorkAt：用最后更新时间兜底，别让恢复计时从 0 开始。
    lastWorkAt: asFiniteOr(raw.lastWorkAt, base.updatedAt),
    // 老状态没有 lastUserAt：同上，别让无聊从 1970 年算起、一加载就顶满。
    lastUserAt: asFiniteOr(raw.lastUserAt, base.updatedAt),
    // 老状态没有睡眠债：从 0 开始，别让一次升级就顶着打折的上限。
    debt: {
      amount: clamp01(asFiniteOr(raw.debt?.amount, 0)),
      at: asFiniteOr(raw.debt?.at, base.updatedAt),
    },
    // 老状态没有 emit：当作「还没说过」，下一次越界会正常说一句。
    emit: {
      active: Array.isArray(raw.emit?.active)
        ? raw.emit.active.filter((k) => typeof k === 'string')
        : [],
      at: asFiniteOr(raw.emit?.at, 0),
    },
    values: {
      cortisol: clamp01(asFiniteOr(v.cortisol, base.values.cortisol)),
      energy: clamp01(asFiniteOr(v.energy, base.values.energy)),
      dopamine: clamp01(asFiniteOr(v.dopamine, base.values.dopamine)),
      boredom: clamp01(asFiniteOr(v.boredom, base.values.boredom)),
    },
    session: {
      turn: Number.isFinite(s.turn) ? s.turn : null,
      tokensInTurn: asFiniteOr(s.tokensInTurn, 0),
      toolsInTurn: asFiniteOr(s.toolsInTurn, 0),
      errorsInTurn: asFiniteOr(s.errorsInTurn, 0),
      consecutiveErrors: asFiniteOr(s.consecutiveErrors, 0),
    },
    history: Array.isArray(raw.history)
      ? raw.history.filter((row) => row && Number.isFinite(row.t)).slice(-MAX_HISTORY)
      : [],
  }
  return state
}

/** 临时文件 + rename 原子写；权限尽量压到 600（Windows 上 chmod 是 no-op，忽略）。 */
export function saveState(state) {
  const file = stateFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(state), 'utf8')
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* Windows 上不支持，无所谓 */
  }
}
