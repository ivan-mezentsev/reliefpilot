import * as assert from 'assert'
import type { Bot } from 'grammy'
import { getTelegramBotCommandMenu, registerCommands, syncTelegramCommandMenu } from '../../../integrations/telegram/telegramCommands'
import type { TelegramBotService } from '../../../integrations/telegram/telegramBotService'

interface RegisteredCommand {
  name: string
  handlers: unknown[]
}

class FakeBot {
  public readonly commands: RegisteredCommand[] = []
  public readonly listeners: Array<{ event: string; handlers: unknown[] }> = []
  public readonly publishedCommandMenus: Array<Array<{ command: string; description: string }>> = []
  public readonly api = {
    setMyCommands: async (commands: Array<{ command: string; description: string }>) => {
      this.publishedCommandMenus.push(commands)
    },
  }

  public command(name: string, ...handlers: unknown[]): this {
    this.commands.push({ name, handlers })
    return this
  }

  public on(event: string, ...handlers: unknown[]): this {
    this.listeners.push({ event, handlers })
    return this
  }
}

suite('telegramCommands', () => {
  test('exports the Telegram command menu for UI publishing', () => {
    const commandMenu = getTelegramBotCommandMenu()

    assert.ok(commandMenu.some((entry) => entry.command === 'errors'))
    assert.ok(commandMenu.some((entry) => entry.command === 'mode'))
    assert.ok(commandMenu.some((entry) => entry.command === 'commands'))
    assert.ok(commandMenu.every((entry) => entry.description.length > 0))
  })

  test('syncTelegramCommandMenu publishes the exported command menu', async () => {
    const bot = new FakeBot()

    await syncTelegramCommandMenu(bot as unknown as Bot)

    assert.strictEqual(bot.publishedCommandMenus.length, 1)
    assert.deepStrictEqual(bot.publishedCommandMenus[0], getTelegramBotCommandMenu())
  })

  test('registers auth-protected phone-first quick actions', () => {
    const bot = new FakeBot()

    registerCommands(bot as unknown as Bot, {} as TelegramBotService)

    const commands = new Map(bot.commands.map((entry) => [entry.name, entry]))

    assert.ok(commands.has('start'))
    assert.strictEqual(commands.get('start')?.handlers.length, 1)

    const authProtectedCommands = [
      'status',
      'pending',
      'blockers',
      'errors',
      'resume',
      'diff',
      'patch',
      'summary',
      'mode',
      'help',
      'commands',
    ]

    for (const commandName of authProtectedCommands) {
      assert.ok(commands.has(commandName), `Expected /${commandName} to be registered`)
      assert.strictEqual(
        commands.get(commandName)?.handlers.length,
        2,
        `Expected /${commandName} to include auth middleware plus a handler`,
      )
    }
  })
})
