import { describe, expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult, On } from 'claude-code'

const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const USAGE = { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Reply = (e: ModelCompleteInput, n: number) => ModelCompleteResult | Promise<ModelCompleteResult>
const answer = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage: USAGE })

/** The engine beneath the plugin, with a model that answers by `reply` and records every request. */
function world(on: On, reply: Reply, opts: { failWrite?: boolean } = {}) {
  const seen = { requests: [] as ModelCompleteInput[], tools: [] as { name: string; isDeferred?: boolean }[], writes: [] as { path: string; text: string }[], commands: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', ($, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => {
    seen.tools.push({ name: e.name, isDeferred: e.isDeferred })
    return { value: { tool: `mcp__fanout__${e.name}` } }
  })
  on('model.complete', async ($, e) => {
    seen.requests.push(e)
    return { value: await reply(e, seen.requests.length) }
  })
  on('fs.write', ($, e) => {
    if (opts.failWrite) return { deny: 'disk full' }
    seen.writes.push(e)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  mock.env(on, { TMPDIR: '/tmp/x/' })
  return seen
}

const start = ($: any) => $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
const itemOf = (e: ModelCompleteInput) => /<item>\n([\s\S]*)\n<\/item>/.exec(e.prompt)![1]!
const classify = ($: any, input: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__fanout__classify', tool_use_id: 'tu1', ...input })
const complete = ($: any, input: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__fanout__complete', tool_use_id: 'tu2', ...input })

describe('registration', () => {
  test('registers both tools behind ToolSearch, and /fanout', async ($, on) => {
    const seen = world(on, () => answer('x'))
    await start($)
    expect(seen.tools).toEqual([
      { name: 'complete', isDeferred: true },
      { name: 'classify', isDeferred: true },
    ])
    expect(seen.commands).toEqual(['fanout'])
  })

  test('alwaysLoaded puts the schemas in the prompt', { options: { alwaysLoaded: true } }, async ($, on) => {
    const seen = world(on, () => answer('x'))
    await start($)
    expect(seen.tools.map(t => t.isDeferred)).toEqual([false, false])
  })

  test('enabled off registers no tools until /fanout on', { options: { enabled: false } }, async ($, on) => {
    const seen = world(on, () => answer('x'))
    await start($)
    expect(seen.tools).toEqual([])
    await $.command.run({ command: 'fanout', args: 'on', ...COMMAND })
    expect(seen.tools.map(t => t.name)).toEqual(['complete', 'classify'])
  })
})

describe('classify', () => {
  test('labels every item in order, with the shared block cached first', async ($, on) => {
    const seen = world(on, e => answer(itemOf(e).includes('pills') ? 'spam' : 'ham'))
    await start($)
    const r = await classify($, { instructions: 'Is it spam?', labels: ['spam', 'ham'], items: ['cheap pills', 'lunch at noon', 'more pills'] })
    expect(r.deny).toBeUndefined()
    const text = r.result as string
    expect(text).toContain('status ok: 3 items, 3 ok, 0 failed, 0 retried')
    expect(text).toContain('1\tspam\n2\tham\n3\tspam')
    expect(text).toContain('300 input')
    const q = seen.requests[0]!
    expect(q.model).toBe('claude-haiku-5-5')
    expect(q.effort).toBe('low')
    expect(q.maxTokens).toBe(128)
    expect(q.promptBlocks![0]!.cache).toBe(true)
    expect(q.promptBlocks![0]!.text).toContain('Is it spam?')
    expect(q.promptBlocks![1]!.cache).toBeUndefined()
    expect(q.system).toContain('data')
  })

  test('a failing item fails alone, retried once; auth errors are not retried', async ($, on) => {
    const seen = world(on, e => {
      const it = itemOf(e)
      if (it === 'busy') return { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }
      if (it === 'denied') return { isAnswered: false, reason: 'api-error', status: 401, error: 'authentication_failed', usage: USAGE }
      return answer('ham')
    })
    await start($)
    const r = await classify($, { instructions: 'x', labels: ['spam', 'ham'], items: ['ok', 'busy', 'denied'], ids: ['a', 'b', 'c'] })
    const text = r.result as string
    expect(text).toContain('status partial: 3 items, 1 ok, 2 failed, 1 retried')
    expect(text).toContain('b\tFAILED\tapi-error overloaded (529)')
    expect(text).toContain('c\tFAILED\tapi-error authentication_failed (401)')
    expect(seen.requests.filter(q => itemOf(q) === 'busy')).toHaveLength(2)
    expect(seen.requests.filter(q => itemOf(q) === 'denied')).toHaveLength(1)
    expect(text).toContain('4 requests')
  })

  test('a reply with no label is retried, and both attempts are counted', async ($, on) => {
    let first = true
    world(on, () => {
      if (first) {
        first = false
        return answer('I think it might be spam')
      }
      return answer('spam')
    })
    await start($)
    const r = await classify($, { instructions: 'x', labels: ['spam', 'ham'], items: ['a'] })
    const text = r.result as string
    expect(text).toContain('1 ok, 0 failed, 1 retried')
    expect(text).toContain('200 input')
    expect(text).toContain('2 requests')
  })

  test('every item failing reads as failed', async ($, on) => {
    world(on, () => ({ isAnswered: false, reason: 'empty-reply', usage: USAGE }))
    await start($)
    const r = await classify($, { instructions: 'x', labels: ['spam', 'ham'], items: ['a', 'b'] })
    expect(r.result as string).toContain('status failed: 2 items, 0 ok, 2 failed')
  })

  test('over the limits the call is refused before any request', { options: { maxItems: 2 } }, async ($, on) => {
    const seen = world(on, () => answer('spam'))
    await start($)
    const r = await classify($, { instructions: 'x', labels: ['spam', 'ham'], items: ['a', 'b', 'c'] })
    expect(r.isError ?? r.deny !== undefined).toBe(true)
    expect(r.text ?? r.deny).toContain('3 items; the limit is 2')
    expect(seen.requests).toHaveLength(0)
  })

  test('a call may pick an allowed model, not another', async ($, on) => {
    const seen = world(on, () => answer('spam'))
    await start($)
    await classify($, { instructions: 'x', labels: ['spam', 'ham'], items: ['a'], model: 'claude-sonnet-5-5' })
    expect(seen.requests[0]!.model).toBe('claude-sonnet-5-5')
    const r = await classify($, { instructions: 'x', labels: ['spam', 'ham'], items: ['a'], model: 'claude-opus-5-5' })
    expect(r.text ?? r.deny).toContain('not in the allowed models')
    expect(seen.requests).toHaveLength(1)
  })
})

describe('complete', () => {
  test('json replies are checked against the schema', async ($, on) => {
    world(on, e => answer(itemOf(e) === 'bad' ? '{"n": "two"}' : '{"n": 2}'))
    await start($)
    const r = await complete($, {
      instructions: 'Count.', items: ['good', 'bad'], format: 'json',
      schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
    })
    const text = r.result as string
    expect(text).toContain('1\t{"n":2}')
    expect(text).toContain('2\tFAILED\treply fails the schema: $.n is string, expected integer')
  })

  test('runs at most `concurrency` requests at once, across calls', { options: { concurrency: 2 } }, async ($, on) => {
    const clock = mock.clock(on)
    let inFlight = 0
    let peak = 0
    world(on, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await clock.sleep(100)
      inFlight--
      return answer('done')
    })
    await start($)
    const a = complete($, { instructions: 'x', items: ['1', '2', '3'] })
    const b = complete($, { instructions: 'x', items: ['4', '5', '6'] })
    for (let i = 0; i < 6; i++) await clock.advance(100)
    const [ra, rb] = await Promise.all([a, b])
    expect(peak).toBe(2)
    expect(ra.result as string).toContain('3 ok')
    expect(rb.result as string).toContain('3 ok')
  })

  test('a large result spills to a JSONL file under TMPDIR', { options: { inlineResultChars: 1000 } }, async ($, on) => {
    const seen = world(on, () => answer('y'.repeat(100)))
    await start($)
    const r = await complete($, { instructions: 'x', items: Array.from({ length: 20 }, (_, i) => `item ${i}`) })
    expect(seen.writes).toHaveLength(1)
    const w = seen.writes[0]!
    expect(w.path).toMatch(/^\/tmp\/x\/claude-fanout\/sess-1\/complete-[\w-]+\.jsonl$/)
    expect(w.text.trim().split('\n')).toHaveLength(20)
    expect(JSON.parse(w.text.split('\n')[0]!)).toEqual({ id: '1', ok: true, value: 'y'.repeat(100), attempts: 1 })
    const text = r.result as string
    expect(text).toContain(`Full results (JSONL, one row per item): ${w.path}`)
    expect(text).not.toContain('yyyy')
  })

  test('a failed spill says so instead of returning a path', { options: { inlineResultChars: 1000 } }, async ($, on) => {
    world(on, () => answer('y'.repeat(100)), { failWrite: true })
    await start($)
    const r = await complete($, { instructions: 'x', items: Array.from({ length: 20 }, (_, i) => `item ${i}`) })
    const text = r.result as string
    expect(text).toContain('Could not write the full results to a file')
    expect(text).toMatch(/\d+ rows left out/)
  })
})

describe('/fanout', () => {
  test('status shows session totals; /clear resets them', async ($, on) => {
    world(on, () => answer('spam'))
    await start($)
    await classify($, { instructions: 'x', labels: ['spam', 'ham'], items: ['a', 'b'] })
    const s = await $.command.run({ command: 'fanout', args: '', ...COMMAND })
    expect(s.text).toContain('1 calls, 2 items (2 ok, 0 failed, 0 retried), 2 requests')
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } } as any)
    const after = await $.command.run({ command: 'fanout', args: 'status', ...COMMAND })
    expect(after.text).toContain('0 calls, 0 items')
  })

  test('/fanout off refuses calls for the session', async ($, on) => {
    const seen = world(on, () => answer('spam'))
    await start($)
    const off = await $.command.run({ command: 'fanout', args: 'off', ...COMMAND })
    expect(off.text).toContain('off (set for this session)')
    const r = await classify($, { instructions: 'x', labels: ['spam', 'ham'], items: ['a'] })
    expect(r.text ?? r.deny).toContain('fanout is off for this session')
    expect(seen.requests).toHaveLength(0)
  })

  test('an unknown argument answers with usage', async ($, on) => {
    world(on, () => answer('x'))
    await start($)
    const res = await $.command.run({ command: 'fanout', args: 'bogus', ...COMMAND })
    expect(res.text).toContain('Usage: /fanout')
  })
})

describe('timeouts', () => {
  test('an aborted request the call did not cancel is a timeout: retried once, then failed', async ($, on) => {
    const seen = world(on, () => ({ isAnswered: false, reason: 'aborted', usage: ZERO_USAGE }))
    await start($)
    const r = await classify($, { instructions: 'x', labels: ['spam', 'ham'], items: ['a'] })
    expect(r.result as string).toContain('1\tFAILED\ttimed out')
    expect(seen.requests).toHaveLength(2)
  })
})

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
