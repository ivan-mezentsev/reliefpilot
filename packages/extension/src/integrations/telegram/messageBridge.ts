import type { Bot, Context } from 'grammy'
import { InlineKeyboard } from 'grammy'
import * as vscode from 'vscode'
import { createAuthMiddleware } from './telegramAuth'
import type { TelegramBotService } from './telegramBotService'

const MAX_MESSAGE_LENGTH = 4096

export class MessageBridge {
  private bot: Bot
  private botService: TelegramBotService
  private outputChannel: vscode.OutputChannel
  private pendingAskReports = new Map<string, { chatId: number; messageId?: number }>()

  constructor(bot: Bot, botService: TelegramBotService, outputChannel: vscode.OutputChannel) {
    this.bot = bot
    this.botService = botService
    this.outputChannel = outputChannel
  }

  public registerHandlers(): void {
    const authMiddleware = createAuthMiddleware()

    // Handle text messages (non-commands) — forward to Relief as prompt
    this.bot.on('message:text', authMiddleware, async (ctx) => {
      const text = ctx.message.text

      // Skip if it's a command (already handled by telegramCommands)
      if (text.startsWith('/')) return

      this.botService.incrementMessageCount()
      this.outputChannel.appendLine(`[Telegram] Received message from ${ctx.from?.id}: ${text.substring(0, 100)}...`)

      await ctx.reply('⏳ Processing your request...')

      try {
        const response = await this.forwardToRelief(text)
        await this.sendLongMessage(ctx, response)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.outputChannel.appendLine(`[Telegram] Error forwarding to Relief: ${message}`)
        await ctx.reply(`❌ Error: ${message}`)
      }
    })

    // Handle unsupported message types
    this.bot.on('message', authMiddleware, async (ctx) => {
      // If we get here, it's a non-text message (photo, sticker, etc.)
      await ctx.reply('Only text messages are supported.')
    })

    // Handle callback queries for ask_report responses
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data

      // Skip owner binding callbacks (handled in telegramCommands)
      if (data.startsWith('bind_owner:')) return

      if (data.startsWith('ask_report:')) {
        await this.handleAskReportCallback(ctx, data)
        return
      }
    })
  }

  private async forwardToRelief(text: string): Promise<string> {
    // Send text to Copilot Chat as a prompt via VS Code command
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: text,
        isPartialQuery: false,
      })
      return 'Message sent to Relief Pilot via Copilot Chat. Check VS Code for the response.'
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to forward to Copilot Chat: ${message}`)
    }
  }

  private async sendLongMessage(ctx: Context, text: string): Promise<void> {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await ctx.reply(text)
      return
    }

    // Split long messages at line boundaries
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunks.push(remaining)
        break
      }
      let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH)
      if (splitAt <= 0) splitAt = MAX_MESSAGE_LENGTH
      chunks.push(remaining.substring(0, splitAt))
      remaining = remaining.substring(splitAt).trimStart()
    }

    for (const chunk of chunks) {
      await ctx.reply(chunk)
    }
  }

  // --- ask_report integration ---

  public async sendAskReportNotification(
    chatId: number,
    reportId: string,
    topic: string,
    message: string,
    options?: string[],
  ): Promise<void> {
    let text = `📋 **${topic}**\n\n${message}`
    if (text.length > MAX_MESSAGE_LENGTH) {
      text = text.substring(0, MAX_MESSAGE_LENGTH - 3) + '...'
    }

    const keyboard = options && options.length > 0
      ? this.buildAskReportKeyboard(reportId, options)
      : undefined

    try {
      const sent = await this.bot.api.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      })
      this.pendingAskReports.set(reportId, { chatId, messageId: sent.message_id })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`[Telegram] Failed to send ask_report notification: ${errMsg}`)
    }
  }

  private buildAskReportKeyboard(reportId: string, options: string[]): InlineKeyboard {
    const keyboard = new InlineKeyboard()
    for (const option of options) {
      keyboard.text(option, `ask_report:${reportId}:${option}`).row()
    }
    return keyboard
  }

  private async handleAskReportCallback(ctx: Context, data: string): Promise<void> {
    // Format: ask_report:reportId:selectedOption
    const parts = data.split(':')
    if (parts.length < 3) {
      await ctx.answerCallbackQuery({ text: 'Invalid callback data.' })
      return
    }

    const reportId = parts[1]
    const selectedOption = parts.slice(2).join(':')

    this.outputChannel.appendLine(`[Telegram] ask_report callback: report=${reportId}, option=${selectedOption}`)

    await ctx.answerCallbackQuery({ text: `Selected: ${selectedOption}` })

    // Remove from pending
    this.pendingAskReports.delete(reportId)
  }

  public dispose(): void {
    this.pendingAskReports.clear()
  }
}
