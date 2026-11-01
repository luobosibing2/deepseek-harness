/** Same-turn response interruption with explicit stream and recovery barriers. */
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

class StartedAdapter extends MockAdapter {
  readonly started = Promise.withResolvers<GenerateOptions>()

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.started.resolve(options)
    yield* super.stream(options)
  }
}

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('response-interrupt'), { provider: 'mock', model: 'mock' })
  const events: SessionEvent[] = []
  const frames: AssistantStreamFrame[] = []
  const errors: unknown[] = []
  ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event) })
  ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => { if (subject === agent) frames.push(frame) })
  ctx.on('agent/error', ({ agent: subject, error }) => { if (subject === agent) errors.push(error) })
  return { ctx, agent, events, frames, errors }
}

function input(text: string) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

function waitForChunk(ctx: Context, agent: Agent, type: StreamChunk['type']): Promise<void> {
  return new Promise((resolve) => {
    const stop = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject === agent && frame.type === 'chunk' && frame.chunk.type === type) {
        stop()
        resolve()
      }
    })
  })
}

describe('Agent.interruptResponse()', () => {
  it('interrupts a response with no chunks and admits steering in the same turn', async () => {
    const adapter = new StartedAdapter([{ hangAfter: [] }, textResponse('corrected')])
    const h = await harness(adapter)
    let turnSignal: AbortSignal | undefined
    let recoveries = 0
    const statuses: string[] = []
    h.ctx.on('agent/pre-step', ({ signal }, next) => { turnSignal = signal; return next() })
    h.ctx.on('agent/request-error', async () => { recoveries++ })
    h.ctx.on('agent/status', ({ status }) => { statuses.push(status) })

    h.agent.followup(input('original'))
    const request = await adapter.started.promise
    const correction = input('use the other repository')
    h.agent.steer(correction)
    expect(h.agent.interruptResponse()).toBe(true)
    expect(h.agent.interruptResponse()).toBe(false)
    expect(request.signal?.aborted).toBe(true)
    expect(turnSignal?.aborted).toBe(false)
    await h.agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.messages.filter(message => message.id === correction.id)).toHaveLength(1)
    expect(h.events.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    expect(h.events.flatMap(event => event.type === 'step/start' ? [event.data] : [])).toEqual([
      { turn: 1, step: 1 }, { turn: 1, step: 2 },
    ])
    expect(h.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(h.events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
    expect(h.frames.filter(frame => frame.type === 'end')).toHaveLength(2)
    expect(statuses).toEqual(['running', 'idle'])
    expect(recoveries).toBe(0)
    expect(h.errors).toEqual([])
  })

  it('retains streamed text and reasoning while discarding unexecuted tool calls', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'checking the original premise' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Visible prefix' },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: ToolCallId('pending-call'), name: 'probe', argumentsDelta: '{"path":' },
    ]
    const adapter = new MockAdapter([{ hangAfter: chunks }, textResponse('revised')])
    const h = await harness(adapter)
    let executions = 0
    h.ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: '', parameters: {},
      async execute() { executions++; return [{ type: 'text', text: 'unexpected' }] },
    }))
    const pending = waitForChunk(h.ctx, h.agent, 'tool-call-delta')
    h.agent.followup(input('original'))
    await pending
    h.agent.steer(input('the premise changed'))
    expect(h.agent.interruptResponse()).toBe(true)
    await h.agent.whenIdle()

    const interrupted = h.events.find(event => event.type === 'assistant/message' && event.data.interrupted)
    expect(interrupted).toMatchObject({
      data: { message: { content: [
        { type: 'reasoning', text: 'checking the original premise' },
        { type: 'text', text: 'Visible prefix' },
      ] } },
    })
    expect(h.events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')).toEqual([])
    expect(adapter.requests[1]?.messages.flatMap(message => message.content).some(block => block.type === 'tool-call')).toBe(false)
    expect(executions).toBe(0)
    expect(h.errors).toEqual([])
  })

  it('ends a recovery wait without retrying the old step or aborting the turn', async () => {
    const adapter = new MockAdapter([
      () => { throw new LlmError('busy', 'RATE_LIMIT') },
      textResponse('after correction'),
    ])
    const h = await harness(adapter)
    const entered = Promise.withResolvers<AbortSignal>()
    let turnSignal: AbortSignal | undefined
    h.ctx.on('agent/pre-step', ({ signal }, next) => { turnSignal = signal; return next() })
    h.ctx.on('agent/request-error', ({ signal }) => {
      entered.resolve(signal)
      return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ kind: 'retry' }) }, { once: true }) })
    })

    h.agent.followup(input('original'))
    const recoverySignal = await entered.promise
    h.agent.steer(input('corrected requirements'))
    expect(h.agent.interruptResponse()).toBe(true)
    expect(recoverySignal.aborted).toBe(true)
    expect(turnSignal?.aborted).toBe(false)
    await h.agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(h.events.flatMap(event => event.type === 'step/start' ? [event.data.step] : [])).toEqual([1, 2])
    expect(h.events.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    expect(h.events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
    expect(h.errors).toEqual([])
  })

  it('preserves a recovery failure after interruption was requested', async () => {
    const adapter = new MockAdapter([
      () => { throw new LlmError('busy', 'RATE_LIMIT') },
      textResponse('must not run'),
    ])
    const h = await harness(adapter)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const failure = new Error('recovery record rejected')
    onTestFinished(() => { release.resolve(undefined) })
    h.ctx.on('agent/request-error', async () => {
      entered.resolve(undefined)
      await release.promise
      throw failure
    })

    h.agent.followup(input('original'))
    await entered.promise
    h.agent.steer(input('corrected requirements'))
    expect(h.agent.interruptResponse()).toBe(true)
    release.resolve(undefined)
    await h.agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(h.errors).toEqual([failure])
    expect(h.events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'error' } } })
  })

  it('leaves an already executing tool on its turn signal', async () => {
    const adapter = new MockAdapter([toolCallResponse('call', 'probe', {}), textResponse('done')])
    const h = await harness(adapter)
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    h.ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: '', parameters: {},
      async execute(_args, execution) {
        entered.resolve(execution.signal)
        await release.promise
        return [{ type: 'text', text: 'tool finished' }]
      },
    }))

    h.agent.followup(input('original'))
    const toolSignal = await entered.promise
    h.agent.steer(input('corrected requirements'))
    expect(h.agent.interruptResponse()).toBe(false)
    expect(toolSignal.aborted).toBe(false)
    release.resolve(undefined)
    await h.agent.whenIdle()

    expect(h.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(2)
    expect(h.events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
  })

  it('does not wake idle or maintenance work and leaves preparation untouched', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const h = await harness(adapter)
    const unavailable: boolean[] = []
    expect(h.agent.interruptResponse()).toBe(false)
    await h.agent.runMaintenance(async (signal) => {
      expect(h.agent.interruptResponse()).toBe(false)
      expect(signal.aborted).toBe(false)
    })
    h.ctx.on('agent/pre-step', (_payload, next) => {
      unavailable.push(h.agent.interruptResponse())
      return next()
    })
    h.ctx.on('agent/request', (_payload, next) => {
      unavailable.push(h.agent.interruptResponse())
      return next()
    })
    h.ctx.on('session/event', (_session, event) => {
      if (event.type === 'assistant/message') unavailable.push(h.agent.interruptResponse())
    })
    expect(h.events).toEqual([])
    h.agent.followup(input('original'))
    await h.agent.whenIdle()
    expect(h.agent.interruptResponse()).toBe(false)
    expect(unavailable).toEqual([false, false, false])
    expect(adapter.requests).toHaveLength(1)
  })

  it('preserves unrelated queued turns while interrupting the current response', async () => {
    const adapter = new StartedAdapter([{ hangAfter: [] }, textResponse('corrected'), textResponse('queued')])
    const h = await harness(adapter)
    h.agent.followup(input('original'))
    await adapter.started.promise
    const queued = input('later work')
    h.agent.followup(queued)
    h.agent.steer(input('correct the current task'))
    expect(h.agent.interruptResponse()).toBe(true)
    await h.agent.whenIdle()

    expect(h.events.flatMap(event => event.type === 'turn/start' ? [event.data.turn] : [])).toEqual([1, 2])
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[1]?.messages.some(message => message.id === queued.id)).toBe(false)
    expect(adapter.requests[2]?.messages.filter(message => message.id === queued.id)).toHaveLength(1)
  })

  it('keeps a post-interruption pre-step rejection effective', async () => {
    const adapter = new StartedAdapter([{ hangAfter: [] }, textResponse('must not run')])
    const h = await harness(adapter)
    h.ctx.on('agent/pre-step', ({ step }, next) => step === 1 ? next() : Promise.resolve({ kind: 'reject' }))
    h.agent.followup(input('original'))
    await adapter.started.promise
    h.agent.steer(input('blocked correction'))
    expect(h.agent.interruptResponse()).toBe(true)
    await h.agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(h.events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'blocked' } } })
  })

  it('lets native cancellation win over an accepted response interruption', async () => {
    const adapter = new StartedAdapter([{ hangAfter: [] }, textResponse('must not run')])
    const h = await harness(adapter)
    h.agent.followup(input('original'))
    await adapter.started.promise
    h.agent.steer(input('correction'))
    expect(h.agent.interruptResponse()).toBe(true)
    h.agent.cancel({ kind: 'user' })
    expect(h.agent.interruptResponse()).toBe(false)
    await h.agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(h.events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  })

  it('does not continue after interrupted content cannot be recorded', async () => {
    const adapter = new MockAdapter(['hang', textResponse('must not run')])
    const h = await harness(adapter)
    const append = h.agent.session.append.bind(h.agent.session)
    Object.defineProperty(h.agent.session, 'append', {
      configurable: true,
      value: (...args: Parameters<typeof h.agent.session.append>): ReturnType<typeof h.agent.session.append> => {
        if (args[0] === 'assistant/message') throw new Error('durable settlement rejected')
        return Reflect.apply(append, h.agent.session, args) as ReturnType<typeof h.agent.session.append>
      },
    })
    const partial = waitForChunk(h.ctx, h.agent, 'text-delta')
    h.agent.followup(input('original'))
    await partial
    h.agent.steer(input('correction'))
    expect(h.agent.interruptResponse()).toBe(true)
    await h.agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(h.events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'error' } } })
    expect(h.errors).toHaveLength(1)
    expect(h.frames.at(-1)).toMatchObject({ type: 'end', outcome: { kind: 'abandoned' } })
  })
})
