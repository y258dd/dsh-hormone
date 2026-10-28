/**
 * dsh-hormone — DSH 插件入口。
 *
 * 职责只有三件：订阅会话事件、把状态写盘、把越界的激素注入系统提示。
 * 所有「激素怎么变」的逻辑在 state.js / events.js / render.js，本文件不做判断。
 *
 * 环境变量：
 *   DSH_HORMONE_MODE=observe  只记状态，不注入（想先看着跑几天时用）
 *   DSH_HORMONE_DEBUG=1       把事件摘要追加到 %DSH_HOME%/hormone/events.jsonl
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyEvent, settleTurn } from './events.js'
import { render } from './render.js'
import { loadState, nowSec, project, saveState, stateFile } from './state.js'

export const name = 'dsh-hormone'

/** 需要 systemPrompt 服务才能注入；没有就退化成只记状态。 */
export const inject = ['systemPrompt']

const MODE = process.env.DSH_HORMONE_MODE === 'observe' ? 'observe' : 'inject'
const DEBUG = process.env.DSH_HORMONE_DEBUG === '1'

/** 写盘节流：事件可能一秒来好几个，攒一下再写。 */
const FLUSH_MS = 800

function debugLog(session, event) {
  if (!DEBUG) return
  try {
    const dir = dirname(stateFile())
    mkdirSync(dir, { recursive: true })
    const data = event?.data ?? {}
    const row = {
      t: new Date().toISOString(),
      session: session?.id ?? session?.sessionId ?? null,
      type: event?.type ?? null,
      turn: data.turn ?? null,
      step: data.step ?? null,
      usage: data.usage ?? null,
      isError: data.message?.isError ?? null,
      sourceKind: data.source?.kind ?? data.message?.source?.kind ?? null,
    }
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(row) + '\n', 'utf8')
  } catch {
    /* 调试日志写不进去不影响主逻辑 */
  }
}

export function apply(ctx) {
  let state = loadState()
  let timer = null

  const flush = () => {
    timer = null
    try {
      saveState(state)
    } catch (error) {
      console.error('[hormone] 状态写入失败:', error?.message ?? error)
    }
  }

  const schedule = () => {
    if (timer !== null) return
    timer = setTimeout(flush, FLUSH_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  try {
    ctx.on('session/event', (session, event) => {
      try {
        debugLog(session, event)
        if (applyEvent(state, event, nowSec()) !== null) schedule()
      } catch (error) {
        console.error('[hormone] 事件处理失败:', error?.message ?? error)
      }
    })
  } catch (error) {
    console.error('[hormone] 无法订阅 session/event，激素将不更新:', error?.message ?? error)
  }

  try {
    ctx.systemPrompt.context({
      name: 'dsh-hormone',
      order: 21,
      text: () => {
        if (MODE === 'observe') return ''
        try {
          return render(project(state, nowSec()))
        } catch {
          return ''
        }
      },
    })
  } catch (error) {
    console.error('[hormone] 无法注册注入，退化为只记状态:', error?.message ?? error)
  }

  // 插件卸载 / DSH 退出：把最后一轮结算掉，再把状态落盘。
  ctx.effect(() => () => {
    try {
      settleTurn(state, state.session, nowSec())
    } catch {
      /* 结算失败也要继续落盘 */
    }
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    flush()
  })

  if (DEBUG) console.log('[hormone] 已启动，模式:', MODE, '状态文件:', stateFile())
}
