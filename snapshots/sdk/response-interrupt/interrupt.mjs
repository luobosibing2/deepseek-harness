/** Interrupt the stalled recorded response at its delivered-text barrier. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'response-interrupt-fixture'
export const inject = ['agents']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime. */
export function apply(ctx) {
  let owner
  let turnSignal
  let requested = false
  let accepted = false
  let admitted = 0
  const correction = 'Stop that approach and inspect the plugin instead.'

  ctx.on('agent/pre-step', ({ agent, turn, signal }, next) => {
    if (owner === undefined) {
      owner = agent
      turnSignal = signal
    }
    if (agent === owner && (turn !== 1 || signal !== turnSignal || signal.aborted)) {
      throw new Error('response interruption changed or aborted the owning turn')
    }
    return next()
  })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent !== owner || requested || frame.type !== 'chunk'
      || frame.chunk.type !== 'text-delta' || frame.chunk.text !== 'partial') return
    requested = true
    agent.steer(createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: correction }],
    }))
    accepted = agent.interruptResponse()
  })
  ctx.on('session/event', (session, event) => {
    if (owner?.session !== session || event.type !== 'user/message' || event.data.source.kind !== 'user') return
    if (event.data.content.some(block => block.type === 'text' && block.text === correction)) admitted++
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (agent !== owner) return
    if (!requested || !accepted) throw new Error('the recorded stalled response was not interrupted')
    if (turnSignal.aborted) throw new Error('response interruption cancelled the turn')
    if (admitted !== 1) throw new Error(`correction admitted ${admitted} times`)
  })
}
