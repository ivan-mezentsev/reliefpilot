import type { Bot } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { bindOwner, createAuthMiddleware, hasOwner, isAuthorized } from './telegramAuth'
import type { TelegramBotService } from './telegramBotService'

export function registerCommands(bot: Bot, botService: TelegramBotService): void {
  // /start — available to everyone (for owner binding), but with special handling
  bot.command('start', async (ctx) => {
    const userId = ctx.from?.id
    if (!userId) return

    if (!hasOwner()) {
      const keyboard = new InlineKeyboard()
        .text('Yes, bind me as owner', `bind_owner:${userId}`)
        .text('No', 'bind_owner:cancel')
      await ctx.reply(
        `Welcome! Your Telegram ID is \`${userId}\`.\nDo you want to bind this account as the bot owner?`,
        { parse_mode: 'Markdown', reply_markup: keyboard },
      )
      return
    }

    if (isAuthorized(userId)) {
      await ctx.reply('Relief Pilot Bot is ready. Send me a message to control Relief remotely.')
    } else {
      await ctx.reply('Unauthorized. Contact the bot owner.')
    }
  })

  // Handle owner binding callback
  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data
    if (!data.startsWith('bind_owner:')) {
      await next()
      return
    }

    if (data === 'bind_owner:cancel') {
      await ctx.answerCallbackQuery({ text: 'Cancelled.' })
      await ctx.editMessageText('Owner binding cancelled.')
      return
    }

    const userId = parseInt(data.replace('bind_owner:', ''), 10)
    if (isNaN(userId) || userId !== ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: 'Invalid action.' })
      return
    }

    await bindOwner(userId)
    await ctx.answerCallbackQuery({ text: 'You are now the owner!' })
    await ctx.editMessageText(`Owner bound: Telegram ID \`${userId}\`. Relief Pilot Bot is ready.`)
  })

  const authMiddleware = createAuthMiddleware()

  // /status — authorized users only
  bot.command('status', authMiddleware, async (ctx) => {
    const state = botService.getState()
    const uptime = state.connectedAt
      ? formatUptime(Date.now() - state.connectedAt.getTime())
      : 'N/A'

    await ctx.reply(
      `🤖 Bot Status: ${capitalize(state.status)}\n` +
      `⏱ Uptime: ${uptime}\n` +
      `📨 Messages processed: ${state.messageCount}\n` +
      `💻 VS Code: Active`,
    )
  })

  // /help — authorized users only
  bot.command('help', authMiddleware, async (ctx) => {
    await ctx.reply(
      'Available commands:\n' +
      '/start - Initialize bot\n' +
      '/status - Check bot and Relief status\n' +
      '/help - Show this help\n\n' +
      'Send any text message to execute it as a Relief command.',
    )
  })
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
