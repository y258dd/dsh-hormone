/**
 * dsh-hormone 的事件层：把 DSH 会话事件翻译成激素增量。
 *
 * 全部是关键词匹配，不是「理解」——宁可漏判，不要误判：
 * 误判成「被夸」会让爽度虚假上涨，比漏判更坏。
 * 实测不灵就改这里的 DELTA 和正则，别改 index.js。
 */

import { ENERGY, applyDeltas, nowSec } from './state.js'

/** 每种事件的增量（`applyDeltas` 的第二个参数）。 */
export const DELTA = {
  toolError: { cortisol: 0.15 },
  /** 连续失败时在 toolError 之上再叠一次。 */
  repeatedErrors: { cortisol: 0.3 },
  /** 一轮收尾且没出过错：压力泄掉，爽度上来。 */
  taskDone: { cortisol: -0.2, dopamine: 0.35 },
  praised: { dopamine: 0.4 },
  blamed: { cortisol: 0.25 },
}

/** 每连续失败几次额外叠一次 repeatedErrors。 */
export const REPEATED_ERROR_EVERY = 3

/** 先判批评再判夸奖：宁可漏掉一次爽度，也不要把骂当成夸。 */
const BLAME_RE =
  /(又错|错了|不对|搞错|弄错|理解错|搞砸|不是这个|怎么又|说了多少遍|你能不能认真|别瞎猜|没用啊|不行啊)/

const PRAISE_RE =
  /(好棒|太棒|好厉害|厉害了|不错|牛逼|牛啊|超赞|靠谱|辛苦了|谢谢|感谢|喜欢你|爱你|漂亮|乖)/

/** 返回 'blame' | 'praise' | null。 */
export function detectUserTone(text) {
  const t = typeof text === 'string' ? text : ''
  if (t === '') return null
  if (BLAME_RE.test(t)) return 'blame'
  if (PRAISE_RE.test(t)) return 'praise'
  return null
}

/** message.content 可能是字符串，也可能是 [{type:'text', text}] 块数组。 */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const part of content) {
    if (typeof part === 'string') out.push(part)
    else if (part && part.type === 'text' && typeof part.text === 'string') out.push(part.text)
  }
  return out.join('\n')
}

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** usage 的字段可能是字符串（dsh-context 里也是先 Number 化）。 */
export function tokensOf(usage) {
  if (!usage || typeof usage !== 'object') return 0
  return (
    num(usage.inputTokens) +
    num(usage.cacheReadTokens) +
    num(usage.cacheWriteTokens) +
    num(usage.outputTokens)
  )
}

/**
 * 结算「当前这一轮」：扣精力，没出过错就奖励。
 * 调用方负责把 session 的当前轮标记清掉。
 */
export function settleTurn(state, session, now = nowSec()) {
  if (session.turn === null || session.turn === undefined) return null
  const tokens = num(session.tokensInTurn)
  const errors = num(session.errorsInTurn)
  session.turn = null
  session.tokensInTurn = 0
  session.errorsInTurn = 0

  const deltas = { energy: -tokens / ENERGY.dailyBudget }
  if (errors === 0) {
    deltas.cortisol = DELTA.taskDone.cortisol
    deltas.dopamine = DELTA.taskDone.dopamine
  }
  return applyDeltas(state, deltas, now, errors === 0 ? 'turn-done' : 'turn-end')
}

/**
 * 纯函数：吃一个事件，可能改 state。
 * 返回 state 表示「有变化、该落盘」，返回 null 表示无视。
 */
export function applyEvent(state, event, now = nowSec()) {
  const session = state.session

  switch (event?.type) {
    case 'user/message': {
      const msg = event.data
      // 只认真人。插件往对话里塞的消息 source.kind 不是 'user'，不能算成用户夸我/骂我。
      if (!msg || msg.source?.kind !== 'user') return null
      const tone = detectUserTone(textOfContent(msg.content))
      if (tone === 'praise') return applyDeltas(state, DELTA.praised, now, 'praised')
      if (tone === 'blame') return applyDeltas(state, DELTA.blamed, now, 'blamed')
      return null
    }

    case 'tool/result': {
      const isError = event.data?.message?.isError === true
      if (!isError) {
        session.consecutiveErrors = 0
        return null
      }
      session.consecutiveErrors = num(session.consecutiveErrors) + 1
      session.errorsInTurn = num(session.errorsInTurn) + 1
      const repeated = session.consecutiveErrors % REPEATED_ERROR_EVERY === 0
      const deltas = { cortisol: DELTA.toolError.cortisol }
      if (repeated) deltas.cortisol += DELTA.repeatedErrors.cortisol
      return applyDeltas(state, deltas, now, repeated ? 'errors-3' : 'tool-error')
    }

    case 'assistant/message': {
      const data = event.data
      const turn = typeof data?.turn === 'number' ? data.turn : null
      let changed = null
      // turn 号一变，说明上一轮已经结束：先把上一轮结算掉。
      if (turn !== null && session.turn !== null && turn !== session.turn) {
        changed = settleTurn(state, session, now)
      }
      if (turn !== null) session.turn = turn
      session.tokensInTurn = num(session.tokensInTurn) + tokensOf(data?.usage)
      return changed
    }

    default:
      return null
  }
}
