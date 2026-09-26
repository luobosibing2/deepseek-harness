/** One-shot terminal consumer of the installed OpenAI Codex authorization flow. */

const FLOW_KEY = 'llm-pi-ai/openai-codex'
const SETTINGS_NS = 'llm-pi-ai'
const ROUTE = 'openai-codex'

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function say(message) {
  process.stdout.write(`${message}\n`)
}

function fail(message) {
  process.stderr.write(`ChatGPT login: ${message}\n`)
}

/** Terminal input never echoes authorization responses, including manual callback URLs. */
function terminalInteraction(attempt) {
  return {
    notify(notice) {
      say(notice.message)
      if (notice.url !== undefined) say(`Open: ${notice.url}`)
      if (notice.code !== undefined) say(`Device code: ${notice.code}`)
    },
    prompt(prompt) {
      if (prompt.signal?.aborted) return Promise.reject(new Error('prompt withdrawn'))
      say(prompt.message)
      if (prompt.kind === 'select') {
        prompt.options.forEach((option, index) => say(`  ${index + 1}. ${option.label}`))
        say('Press Enter for the first option.')
      } else {
        say('Input is hidden. Press Enter to submit; Ctrl-C or Ctrl-D cancels.')
      }
      if (!process.stdin.isTTY && process.stdin.readableEnded) {
        attempt.abort()
        return Promise.reject(new Error('input closed'))
      }
      return new Promise((resolve, reject) => {
        const input = process.stdin
        let pending = ''
        let settled = false
        const cleanup = () => {
          input.off('data', onData)
          input.off('end', onEnd)
          input.off('error', onError)
          prompt.signal?.removeEventListener('abort', onPromptAbort)
          attempt.signal.removeEventListener('abort', onAttemptAbort)
        }
        const finish = (answer, error) => {
          if (settled) return
          settled = true
          cleanup()
          if (error !== undefined) reject(error)
          else resolve(answer)
        }
        const onPromptAbort = () => finish(undefined, new Error('prompt withdrawn'))
        const onAttemptAbort = () => finish(undefined, new Error('authorization cancelled'))
        const onEnd = () => {
          attempt.abort()
          finish(undefined, new Error('input closed'))
        }
        const onError = () => {
          attempt.abort()
          finish(undefined, new Error('input failed'))
        }
        const onData = (chunk) => {
          for (const byte of Buffer.from(chunk)) {
            if (byte === 3 || byte === 4) {
              attempt.abort()
              finish(undefined, new Error('authorization cancelled'))
              return
            }
            if (byte === 13 || byte === 10) {
              say('')
              if (prompt.kind !== 'select') {
                finish(pending)
                return
              }
              const choice = pending.trim()
              const index = choice === '' ? 0 : Number(choice) - 1
              const selected = prompt.options[index] ?? prompt.options.find(option => option.id === choice)
              if (selected === undefined) {
                say('Choose one of the listed numbers or ids.')
                pending = ''
                return
              }
              finish(selected.id)
              return
            }
            if (byte === 8 || byte === 127) {
              pending = pending.slice(0, -1)
            } else if (byte >= 32) {
              pending += String.fromCharCode(byte)
            }
          }
        }
        prompt.signal?.addEventListener('abort', onPromptAbort, { once: true })
        attempt.signal.addEventListener('abort', onAttemptAbort, { once: true })
        input.on('data', onData)
        input.once('end', onEnd)
        input.once('error', onError)
        if (prompt.signal?.aborted) onPromptAbort()
        else if (attempt.signal.aborted) onAttemptAbort()
      })
    },
  }
}

async function run(ctx, attempt) {
  const profile = ctx.get('profileContext')
  const authorization = ctx.get('authorization')
  const settings = ctx.get('settings')
  if (profile === undefined || authorization === undefined || settings === undefined) {
    fail('This profile needs profileContext, authorization, and settings services.')
    return 1
  }
  say(`Profile: ${profile.name}`)
  say(`Harness home: ${profile.home}`)
  const flow = authorization.list().find(entry => entry.key === FLOW_KEY)
  if (flow === undefined || !flow.methods.some(method => method.id === 'oauth')) {
    fail('OpenAI Codex OAuth is unavailable; enable the llm-pi-ai provider in this profile.')
    return 1
  }
  const settingsView = settings.describe({ redactSecrets: true }).find(view => view.ns === SETTINGS_NS)
  if (settingsView === undefined || !settings.writable) {
    fail('The llm-pi-ai settings entry is unavailable or not writable in this profile.')
    return 1
  }
  const configured = object(object(settingsView.value)?.providers)
  const existing = object(configured?.[ROUTE])
  if (existing !== undefined && Object.hasOwn(existing, 'apiKeyEnv') && existing.apiKeyEnv != null) {
    fail('openai-codex explicitly uses apiKeyEnv. Remove that override in model settings before OAuth login.')
    return 1
  }

  const input = process.stdin
  const wasRaw = input.isTTY ? input.isRaw : false
  const onEnd = () => attempt.abort()
  const onData = (chunk) => {
    if (Buffer.from(chunk).includes(3) || Buffer.from(chunk).includes(4)) attempt.abort()
  }
  input.on('end', onEnd)
  input.on('data', onData)
  if (input.isTTY) input.setRawMode(true)
  if (input.readableEnded) attempt.abort()
  input.resume()
  try {
    return await authorizeAndConfigure(authorization, attempt, flow, settings, settingsView, existing, profile.name)
  } finally {
    input.off('end', onEnd)
    input.off('data', onData)
    if (input.isTTY) input.setRawMode(wasRaw)
    input.pause()
  }
}

async function authorizeAndConfigure(authorization, attempt, flow, settings, settingsView, existing, profileName) {
  let outcome
  try {
    outcome = await authorization.begin({
      key: flow.key,
      method: 'oauth',
      signal: attempt.signal,
      interaction: terminalInteraction(attempt),
    })
  } catch (_error) {
    if (attempt.signal.aborted) {
      fail('Cancelled; this profile was not changed.')
    } else {
      // OAuth errors may embed a pasted callback or provider response.
      fail('Authorization failed. Check the browser login and try again; this profile was not changed.')
    }
    return 1
  }
  if (outcome.status !== 'authorized') {
    fail('Cancelled; this profile was not changed.')
    return 1
  }
  say('ChatGPT login complete; credential saved.')

  try {
    const current = settings.describe({ redactSecrets: true }).find(view => view.ns === SETTINGS_NS)
    if (current === undefined || current.revision !== settingsView.revision) {
      throw new Error('profile settings changed during authorization')
    }
    if (existing === undefined) {
      await settings.mutate(SETTINGS_NS, [
        { op: 'set', path: ['providers', ROUTE], value: {} },
      ], settingsView.revision)
    }
    const after = settings.describe({ redactSecrets: true }).find(view => view.ns === SETTINGS_NS)
    const route = object(object(after?.value)?.providers)?.[ROUTE]
    if (object(route) === undefined || route.apiKeyEnv != null) {
      throw new Error('route unavailable after settings write')
    }
    say(`Profile ${profileName}: openai-codex enabled.`)
    return 0
  } catch (_error) {
    fail(`Credential saved, but profile ${profileName} could not be enabled. Open model settings and add openai-codex; then retry.`)
    return 1
  }
}

export const inject = ['appReady', 'appExit', 'profileContext', 'authorization', 'settings']

/** Begin only after the complete profile has mounted; request launcher-owned exit. */
export function apply(ctx) {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (ready === undefined || exit === undefined) throw new Error('ChatGPT login requires the dsh profile launcher')
  const attempt = new AbortController()
  ctx.effect(() => {
    let running
    const cancel = ready.onReady(() => {
      running = run(ctx, attempt)
      void running.then(exit, (_error) => {
        fail('Startup or settings failed; check this profile and try again.')
        exit(1)
      })
    })
    return async () => {
      cancel()
      attempt.abort()
      await running?.catch((_error) => {
        // The caller owns the diagnostic; disposal waits only for terminal cleanup.
      })
    }
  }, 'chatgpt-login')
}
