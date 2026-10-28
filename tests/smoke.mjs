/**
 * 接线冒烟测试：用一个假的 ctx 调 `apply()`，看插件能不能正常订阅、注册注入、写盘。
 *
 * 不碰真 DSH，只验 index.js 的装配逻辑（真机事件字段要靠真跑一轮来核）。
 * `node tests/smoke.mjs`
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-hormone-smoke-'))
process.env.DSH_HOME = home
process.env.DSH_HORMONE_MODE = 'inject'
delete process.env.DSH_HORMONE_DEBUG

const { apply, inject, name } = await import('../lib/index.js')

const listeners = []
const contexts = []
const disposers = []

const ctx = {
  on(type, fn) {
    assert.equal(type, 'session/event')
    listeners.push(fn)
  },
  systemPrompt: {
    context(def) {
      contexts.push(def)
    },
  },
  effect(setup) {
    const dispose = setup()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
}

assert.equal(name, 'dsh-hormone')
assert.deepEqual(inject, ['systemPrompt'])

apply(ctx)
assert.equal(listeners.length, 1, '应该订阅了一次 session/event')
assert.equal(contexts.length, 1, '应该注册了一次注入')
assert.equal(contexts[0].name, 'dsh-hormone')

const emit = (event) => listeners[0]({ id: 'test-session' }, event)
const prompt = () => contexts[0].text()

try {
  // 刚启动：一切正常，不注入。
  assert.equal(prompt(), '', '初始状态不该注入')

  // 一堆工具报错把压力顶上去。
  for (let i = 0; i < 5; i += 1) {
    emit({ type: 'tool/result', data: { message: { isError: true } } })
  }
  const text = prompt()
  assert.ok(text.startsWith('[hormone]'), `压力拉满后应该注入，实际 ${JSON.stringify(text)}`)
  assert.ok(text.length <= 80, `注入超长：${text.length}`)

  // 用户夸一句，爽度上去。
  emit({
    type: 'user/message',
    data: { content: [{ type: 'text', text: '好棒' }], source: { kind: 'user' } },
  })

  // 插件自己注入的消息不该被当成用户情绪。
  const beforePluginMessage = prompt()
  emit({
    type: 'user/message',
    data: { content: [{ type: 'text', text: '太棒了' }], source: { kind: 'plugin' } },
  })
  assert.equal(prompt(), beforePluginMessage, '插件注入的消息不该改变状态文本')

  // 换一轮，触发结算。
  emit({ type: 'assistant/message', data: { turn: 1, usage: { outputTokens: 1000 } } })
  emit({ type: 'assistant/message', data: { turn: 2, usage: { outputTokens: 1000 } } })

  // 卸载：应该把状态落盘。
  assert.ok(disposers.length === 1)
  disposers[0]()

  const saved = JSON.parse(readFileSync(join(home, 'hormone', 'state.json'), 'utf8'))
  assert.equal(saved.version, 1)
  assert.ok(saved.values.cortisol > 0.5, `压力应该攒起来了，实际 ${saved.values.cortisol}`)
  assert.ok(Array.isArray(saved.history) && saved.history.length > 0, 'history 应该有记录')
  assert.ok(
    saved.history.some((row) => row.why === 'errors-3'),
    '连续失败应该被标成 errors-3',
  )

  console.log('smoke ok：订阅 / 注入 / 事件 / 落盘 全部打通')
  console.log('  最终状态：', saved.values)
  console.log('  注入样例：', text)
} finally {
  rmSync(home, { recursive: true, force: true })
}
