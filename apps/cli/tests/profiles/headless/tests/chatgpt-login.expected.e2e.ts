/** The public headless overlay with only pi-ai's external OAuth step replaced. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import yaml from 'js-yaml'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../../../', import.meta.url))
const publicPatch = join(root, 'apps/cli/config/examples/chatgpt-login/cordis.patch.yml')
const fakeOAuth = fileURLToPath(new URL('./fixtures/chatgpt-login/fake-oauth.mjs', import.meta.url))
const expectedDir = fileURLToPath(new URL('./expected/chatgpt-login/', import.meta.url))
const secret = 'TEST_PRIVATE_TOKEN'

async function runScenario(
  scenario: string,
  answer = '\n',
  options: { initialPatch?: string; initializeWeb?: boolean; manualAnswer?: string } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-login-'))
  try {
    const home = join(dir, 'home')
    const profilePath = join(home, 'profiles/headless/cordis.patch.yml')
    let webBefore: string | undefined
    if (options.initialPatch !== undefined || options.initializeWeb === true) {
      for (const profile of ['headless', ...(options.initializeWeb === true ? ['web'] : [])]) {
        const init = resolveExampleLaunch({
          srcBin: join(root, 'apps/cli/src/bin.ts'), mode: 'lib',
          configArgs: ['--profile', profile, '--dump-config'],
        })
        const initialized = await execa(init.command, init.args, {
          cwd: root, env: { ...init.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
          timeout: 75_000, reject: false,
        })
        expect(initialized.exitCode, initialized.stderr).toBe(0)
      }
      if (options.initialPatch !== undefined) await writeFile(profilePath, options.initialPatch)
      if (options.initializeWeb === true) {
        webBefore = await readFile(join(home, 'profiles/web/cordis.patch.yml'), 'utf8')
      }
    }
    const fakePatch = join(dir, 'fake-oauth.patch.yml')
    await writeFile(fakePatch, JSON.stringify([{ insert: [{ id: 'fake-oauth', name: fakeOAuth }] }]))
    const launch = resolveExampleLaunch({
      srcBin: join(root, 'apps/cli/src/bin.ts'), mode: 'lib',
      configArgs: ['--profile', 'headless', '--patch', publicPatch, '--patch', fakePatch],
    })
    const child = execa(launch.command, launch.args, {
      cwd: root,
      env: {
        ...launch.env,
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
        DSH_TEST_CHATGPT_LOGIN_SCENARIO: scenario,
      },
      stdin: 'pipe', timeout: 75_000, killSignal: 'SIGKILL', reject: false,
    })
    child.stdin?.write(answer)
    if (scenario === 'cancel') child.stdin?.end()
    if (scenario === 'device-wait') {
      let seen = ''
      let closed = false
      child.stdout?.on('data', (chunk: Buffer) => {
        seen += chunk.toString()
        if (!closed && seen.includes('Device code: TEST-CODE')) {
          closed = true
          child.stdin?.end()
        }
      })
    }
    if (options.manualAnswer !== undefined) {
      let seen = ''
      let answered = false
      child.stdout?.on('data', (chunk: Buffer) => {
        seen += chunk.toString()
        if (!answered && seen.includes('Paste the callback URL:')) {
          answered = true
          child.stdin?.write(`${options.manualAnswer}\n`)
        }
      })
    }
    const result = await child
    const credentials = await readFile(join(home, '.credentials.yaml'), 'utf8').catch(() => '')
    const profile = await readFile(profilePath, 'utf8')
    const webAfter = options.initializeWeb === true
      ? await readFile(join(home, 'profiles/web/cordis.patch.yml'), 'utf8') : undefined
    return { result, home, credentials, profile, webBefore, webAfter, output: `${result.stdout}\n${result.stderr}` }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function expectOutput(actual: string, home: string, filename: string): Promise<void> {
  const expected = await readFile(join(expectedDir, filename), 'utf8')
  const lines = actual.replaceAll(home, '<DSH_HOME>').split('\n').filter(line => [
    'Profile:', 'Harness home:', 'Select OpenAI Codex', '  1.', '  2.',
    'Press Enter', 'Complete browser', 'Open:', 'Paste the callback',
    'Input is hidden', 'Device code:', 'ChatGPT login', 'Profile headless:',
  ].some(prefix => line.startsWith(prefix)))
  expect(`${lines.join('\n')}\n`).toBe(expected)
}

it('persists a browser OAuth grant and enables only the selected profile', async () => {
  const { result, home, credentials, profile, webBefore, webAfter, output } = await runScenario('browser', '\n', {
    initializeWeb: true,
  })
  expect(result.timedOut, output).toBe(false)
  expect(result.signal, output).toBeUndefined()
  expect(result.exitCode, output).toBe(0)
  expect(output).toContain('ChatGPT login complete; credential saved.')
  expect(output).toContain('Profile headless: openai-codex enabled.')
  expect(output).toContain('https://example.test/start')
  expect(output).not.toContain(secret)
  expect(output).not.toContain('TEST_REFRESH_TOKEN')
  await expectOutput(output, home, 'browser.stdout.expected.txt')
  expect(yaml.load(credentials)).toMatchObject({ records: { 'llm-pi-ai/openai-codex': { kind: 'grant' } } })
  expect(credentials).toContain(secret)
  expect(yaml.load(profile)).toMatchObject([{ id: 'llm-pi-ai', config: { providers: { 'openai-codex': {} } } }])
  expect(webAfter).toBe(webBefore)
})

it('offers the upstream device-code choice and keeps the grant private', async () => {
  const { result, credentials, output } = await runScenario('device', '2\n')
  expect(result.timedOut, output).toBe(false)
  expect(result.signal, output).toBeUndefined()
  expect(result.exitCode, output).toBe(0)
  expect(output).toContain('https://example.test/device')
  expect(output).toContain('Device code: TEST-CODE')
  expect(output).not.toContain(secret)
  expect(credentials).toContain(secret)
})

it('treats input EOF as cancellation and leaves settings and credentials alone', async () => {
  const { result, credentials, profile, output } = await runScenario('cancel')
  expect(result.timedOut, output).toBe(false)
  expect(result.signal, output).toBeUndefined()
  expect(result.exitCode, output).toBe(1)
  expect(output).toContain('Cancelled; this profile was not changed.')
  expect(output).not.toContain('ChatGPT login complete')
  expect(credentials).toBe('')
  expect(profile).not.toContain('openai-codex')
})

it('cancels device polling when stdin closes after the method prompt', async () => {
  const { result, credentials, profile, output } = await runScenario('device-wait', '2\n')
  expect(result.timedOut, output).toBe(false)
  expect(result.signal, output).toBeUndefined()
  expect(result.exitCode, output).toBe(1)
  expect(output).toContain('Device code: TEST-CODE')
  expect(output).toContain('Cancelled; this profile was not changed.')
  expect(credentials).toBe('')
  expect(profile).not.toContain('openai-codex')
})

it('reports partial success when settings cannot be written and retains the grant', async () => {
  const { result, credentials, profile, output } = await runScenario('settings-failure')
  expect(result.timedOut, output).toBe(false)
  expect(result.signal, output).toBeUndefined()
  expect(result.exitCode, output).toBe(1)
  expect(output).toContain('ChatGPT login complete; credential saved.')
  expect(output).toContain('Credential saved, but profile headless could not be enabled.')
  expect(output).not.toContain('Profile headless: openai-codex enabled.')
  expect(credentials).toContain(secret)
  expect(profile).not.toContain('openai-codex')
})

it('refuses to overwrite a profile revision changed during authorization', async () => {
  const { result, credentials, profile, output } = await runScenario('changed-settings')
  expect(result.timedOut, output).toBe(false)
  expect(result.signal, output).toBeUndefined()
  expect(result.exitCode, output).toBe(1)
  expect(output).toContain('Credential saved, but profile headless could not be enabled.')
  expect(credentials).toContain(secret)
  expect(yaml.load(profile)).toMatchObject([{ id: 'llm-pi-ai', config: { providers: { openai: {} } } }])
})

it('preserves an existing Codex route, other provider, and default model', async () => {
  const original = `- id: llm-pi-ai
  config:
    providers:
      openai-codex:
        displayName: My Codex
        modelOverrides:
          gpt-5.4-mini:
            name: My Mini
      openai:
        apiKeyEnv: OPENAI_API_KEY
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
`
  const { result, credentials, profile, output } = await runScenario('browser', '\n', { initialPatch: original })
  expect(result.timedOut, output).toBe(false)
  expect(result.signal, output).toBeUndefined()
  expect(result.exitCode, output).toBe(0)
  expect(profile).toBe(original)
  expect(credentials).toContain(secret)
})

it('reports apiKeyEnv override before starting OAuth', async () => {
  const original = `- id: llm-pi-ai
  config:
    providers:
      openai-codex:
        apiKeyEnv: CODEX_API_KEY
`
  const { result, credentials, profile, output } = await runScenario('browser', '\n', { initialPatch: original })
  expect(result.timedOut, output).toBe(false)
  expect(result.signal, output).toBeUndefined()
  expect(result.exitCode, output).toBe(1)
  expect(output).toContain('openai-codex explicitly uses apiKeyEnv')
  expect(output).not.toContain('Select OpenAI Codex')
  expect(profile).toBe(original)
  expect(credentials).toBe('')
})

it('does not print an upstream OAuth error containing a token', async () => {
  const { result, credentials, profile, output } = await runScenario('failure')
  expect(result.timedOut, output).toBe(false)
  expect(result.signal, output).toBeUndefined()
  expect(result.exitCode, output).toBe(1)
  expect(output).toContain('Authorization failed.')
  expect(output).not.toContain(secret)
  expect(profile).not.toContain('openai-codex')
  expect(credentials).toBe('')
})

it('accepts a manual callback without echoing its contents', async () => {
  const callback = 'https://example.test/callback?code=MANUAL_PRIVATE_CODE'
  const { result, credentials, output } = await runScenario('manual', '\n', { manualAnswer: callback })
  expect(result.timedOut, output).toBe(false)
  expect(result.signal, output).toBeUndefined()
  expect(result.exitCode, output).toBe(0)
  expect(output).not.toContain('MANUAL_PRIVATE_CODE')
  expect(output).not.toContain(secret)
  expect(credentials).toContain(secret)
})
