/** Replace only the upstream network/browser step for the real dsh login path. */
import {
  openaiCodexOAuth as oauth,
} from '../../../../../../../../packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js'

export const inject = ['settings']

export function apply(ctx) {
  const scenario = process.env.DSH_TEST_CHATGPT_LOGIN_SCENARIO ?? 'browser'
  oauth.login = async (interaction) => {
    const method = await interaction.prompt({
      type: 'select', message: 'Select OpenAI Codex login method:', options: [
        { id: 'browser', label: 'Browser login (default)' },
        { id: 'device_code', label: 'Device code login' },
      ],
    })
    if (method === 'device_code') {
      interaction.notify({ type: 'device_code', userCode: 'TEST-CODE', verificationUri: 'https://example.test/device' })
      if (scenario === 'device-wait') {
        await new Promise((_resolve, reject) => {
          interaction.signal.addEventListener('abort', () => reject(new Error('device polling cancelled')), { once: true })
        })
      }
    } else {
      interaction.notify({ type: 'auth_url', url: 'https://example.test/start', instructions: 'Complete browser sign-in.' })
      const promptAbort = new AbortController()
      const pending = interaction.prompt({
        type: 'manual_code', message: 'Paste the callback URL:', signal: promptAbort.signal,
      })
      if (['browser', 'settings-failure', 'changed-settings', 'failure'].includes(scenario)) {
        promptAbort.abort()
        await pending.catch((_error) => {
          // The browser callback wins, so this manual prompt is deliberately withdrawn.
        })
      } else if (scenario === 'manual') {
        await pending
      } else if (scenario === 'cancel') {
        await pending
      }
    }
    if (scenario === 'failure') throw new Error('OAuth failure: TEST_PRIVATE_TOKEN')
    return { type: 'oauth', access: 'TEST_PRIVATE_TOKEN', refresh: 'TEST_REFRESH_TOKEN', expires: Date.now() + 60_000 }
  }

  if (scenario === 'settings-failure' || scenario === 'changed-settings') {
    const settings = ctx.get('settings')
    if (settings === undefined) throw new Error('settings unavailable')
    if (scenario === 'settings-failure') {
      settings.mutate = () => Promise.reject(new Error('simulated settings failure'))
    }
    if (scenario === 'changed-settings') {
      const original = oauth.login
      oauth.login = async (interaction) => {
        const result = await original(interaction)
        await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai'], value: {} }])
        return result
      }
    }
  }
}
