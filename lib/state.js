/**
 * dsh-hormone 的状态层：读/写 state.json、衰减、跨天恢复、原子写。
 *
 * 三个数只是 0–1 的连续变量，没有「情绪标签」。变化只有两个来源：
 *   1. 事件增量（events.js）；
 *   2. 时间衰减 / 跨天恢复（本文件）。
 * 模型不能改它们（DESIGN 护栏 1）——插件不提供任何写入工具。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 半衰期（秒）。cortisol 4 小时，dopamine 40 分钟。energy 不走半衰期，见 ENERGY。 */
export const HALF_LIFE = {
  cortisol: 4 * 60 * 60,
  dopamine: 40 * 60,
}

export const ENERGY = {
  /**
   * 日预算：一轮的 token 消耗 ÷ 这个数 = energy 扣减量。
   * 8,000,000 是按 ~/.dsh/.dshw-usage.json 里 2026-10-20~28 的真实日用量估的：
   * 普通日几十万，重度调试日 427 万 / 966 万。取重度日量级，一次重活掉 ~0.07。
   * 觉得掉太快/太慢就改这一个数。
   */
  dailyBudget: 8_000_000,
  /** 跨天恢复：日期变了，energy 至少回升这么多。 */
  dayRecover: 0.8,
  /** 空闲超过这个时长才开始回升（秒）。 */
  idleRecoverAfter: 12 * 60 * 60,
  /** 回升半衰期：向基线靠拢一半所需时间。 */
  recoverHalfLife: 6 * 60 * 60,
  /** 白天基线。 */
  dayBaseline: 0.9,
  /** 深夜基线：23:00–06:00 压低，熬夜不会回满。 */
  nightBaseline: 0.45,
  nightFrom: 23,
  nightTo: 6,
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

/** 本地小时对应的 energy 基线。 */
export function baselineEnergy(hour) {
  const night = hour >= ENERGY.nightFrom || hour < ENERGY.nightTo
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
  return { cortisol: 0.2, energy: ENERGY.dayBaseline, dopamine: 0.1 }
}

export function freshState(now = nowSec()) {
  return {
    version: 1,
    updatedAt: now,
    day: localDay(now),
    values: freshValues(),
    session: { turn: null, tokensInTurn: 0, errorsInTurn: 0, consecutiveErrors: 0 },
    history: [],
  }
}

/**
 * 从 updatedAt 投影到现在。纯函数：不改 state、不落盘。
 * 渲染和「加增量」都用它打底，所以衰减不会被重复叠加。
 */
export function project(state, now = nowSec()) {
  const dt = Math.max(0, now - state.updatedAt)
  const hour = new Date(now * 1000).getHours()
  const values = state.values ?? freshValues()
  let energy = clamp01(values.energy)

  // 1. 跨天：日期变了就回升一大截（模拟睡了一觉）。
  if (state.day && state.day !== localDay(now)) {
    energy = clamp01(energy + ENERGY.dayRecover)
  }

  // 2. 长时间空闲：向「当前时段」的基线靠拢。
  //    不是加满——深夜的基线本来就低，熬夜补不回来。
  if (dt > ENERGY.idleRecoverAfter) {
    const idle = dt - ENERGY.idleRecoverAfter
    const target = baselineEnergy(hour)
    energy = clamp01(energy + (target - energy) * (1 - Math.pow(0.5, idle / ENERGY.recoverHalfLife)))
  }

  return {
    cortisol: decayValue(values.cortisol, HALF_LIFE.cortisol, dt),
    energy,
    dopamine: decayValue(values.dopamine, HALF_LIFE.dopamine, dt),
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
  }
  if (why) row.why = why
  state.history.push(row)
  if (state.history.length > MAX_HISTORY) {
    state.history.splice(0, state.history.length - MAX_HISTORY)
  }
}

/**
 * 先投影到现在，再加增量，写回 state（含 updatedAt / day / history）。
 * 返回 state 本身，方便链式调用。
 */
export function applyDeltas(state, deltas, now = nowSec(), why = '') {
  const projected = project(state, now)
  const before = state.values ?? freshValues()
  const next = {
    cortisol: clamp01(projected.cortisol + (deltas?.cortisol ?? 0)),
    energy: clamp01(projected.energy + (deltas?.energy ?? 0)),
    dopamine: clamp01(projected.dopamine + (deltas?.dopamine ?? 0)),
  }
  const moved =
    Math.abs(next.cortisol - before.cortisol) +
    Math.abs(next.energy - before.energy) +
    Math.abs(next.dopamine - before.dopamine)

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
    values: {
      cortisol: clamp01(asFiniteOr(v.cortisol, base.values.cortisol)),
      energy: clamp01(asFiniteOr(v.energy, base.values.energy)),
      dopamine: clamp01(asFiniteOr(v.dopamine, base.values.dopamine)),
    },
    session: {
      turn: Number.isFinite(s.turn) ? s.turn : null,
      tokensInTurn: asFiniteOr(s.tokensInTurn, 0),
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
