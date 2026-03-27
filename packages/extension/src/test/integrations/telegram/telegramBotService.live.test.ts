import * as assert from 'assert'
import { Bot } from 'grammy'
import * as vscode from 'vscode'
import { TelegramBotService, type BotState, type BotStatus } from '../../../integrations/telegram/telegramBotService'
import { initTelegramAuth } from '../../../utils/telegram_auth'

class TestOutputChannel implements vscode.OutputChannel {
  public readonly name = 'Telegram Bot Live Test'
  public readonly lines: string[] = []

  append(value: string): void {
    if (this.lines.length === 0) {
      this.lines.push(value)
      return
    }

    this.lines[this.lines.length - 1] += value
  }

  appendLine(value: string): void {
    this.lines.push(value)
  }

  clear(): void {
    this.lines.length = 0
  }

  replace(value: string): void {
    this.lines.length = 0
    this.lines.push(value)
  }

  show(): void {
    // no-op for tests
  }

  hide(): void {
    // no-op for tests
  }

  dispose(): void {
    this.lines.length = 0
  }
}

function createMockContext(token: string): vscode.ExtensionContext {
  const secrets: vscode.SecretStorage = {
    get: async (key: string) => key === 'reliefpilot.telegram.botToken' ? token : undefined,
    store: async () => undefined,
    delete: async () => undefined,
    keys: async () => ['reliefpilot.telegram.botToken'],
    onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
  }

  return { secrets } as vscode.ExtensionContext
}

async function waitForBotState(
  service: TelegramBotService,
  statuses: readonly BotStatus[],
  timeoutMs: number,
): Promise<BotState> {
  const currentState = service.getState()
  if (statuses.includes(currentState.status)) {
    return currentState
  }

  return await new Promise<BotState>((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose()
      reject(new Error(`Timed out waiting for states: ${statuses.join(', ')}`))
    }, timeoutMs)

    const subscription = service.onStateChange((state) => {
      if (!statuses.includes(state.status)) {
        return
      }

      clearTimeout(timer)
      subscription.dispose()
      resolve(state)
    })
  })
}

async function waitForPromiseToSettle<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs)
    }),
  ])
}

async function connectRawBotInsideExtensionHost(token: string, timeoutMs: number): Promise<string> {
  const bot = new Bot(token)

  return await new Promise<string>((resolve, reject) => {
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void bot.stop().catch(() => undefined)
      reject(new Error(`Raw grammY bot did not connect within ${timeoutMs}ms`))
    }, timeoutMs)

    bot.start({
      onStart: (botInfo) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void bot.stop().catch(() => undefined)
        resolve(botInfo.username)
      },
    }).catch((error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void bot.stop().catch(() => undefined)
      reject(error)
    })
  })
}

suite('Telegram bot live startup smoke test', function () {
  this.timeout(40000)

  const token = process.env.RELIEFPILOT_TEST_TELEGRAM_BOT_TOKEN?.trim() ?? ''
  let service: TelegramBotService | undefined
  let outputChannel: TestOutputChannel | undefined

  setup(function () {
    if (!token) {
      this.skip()
    }

    initTelegramAuth(createMockContext(token))
    outputChannel = new TestOutputChannel()
    service = new TelegramBotService(outputChannel)
  })

  teardown(async () => {
    try {
      await service?.stop()
    } finally {
      service?.dispose()
      outputChannel?.dispose()
      service = undefined
      outputChannel = undefined
    }
  })

  test('raw grammY bot connects inside the extension host with a real token', async () => {
    assert.ok(token, 'Expected a live Telegram bot token for the raw grammY connectivity test')

    const username = await connectRawBotInsideExtensionHost(token, 12000)
    assert.ok(username.length > 0, 'Expected grammY to report a Telegram bot username after connecting')
  })

  test('TelegramBotService connects inside the extension host with a real bot token', async () => {
    assert.ok(service, 'Expected TelegramBotService to be created for the live test')
    assert.ok(outputChannel, 'Expected test output channel to be created for the live test')

    await waitForPromiseToSettle(service.start(), 12000, 'TelegramBotService.start()')

    let state: BotState
    try {
      state = await waitForBotState(service, ['connected', 'error', 'reconnecting'], 15000)
    } catch (error) {
      const logs = outputChannel.lines.join('\n')
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nTelegram logs:\n${logs}`)
    }

    const logs = outputChannel.lines.join('\n')
    assert.strictEqual(
      state.status,
      'connected',
      `Expected TelegramBotService to connect successfully, got ${state.status} (${state.lastError ?? 'no error'})\nTelegram logs:\n${logs}`,
    )
    assert.ok(service.getBot(), 'Expected bot instance to exist after successful startup')
    assert.ok(state.connectedAt instanceof Date, 'Expected connectedAt to be populated after a successful start')
  })
})