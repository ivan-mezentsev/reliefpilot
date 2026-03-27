import type { Bot, Context } from 'grammy'
import { InlineKeyboard, InputFile } from 'grammy'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { resolveAskReportFromTelegram } from '../../tools/ask_report'
import { transcribeAudio } from '../../utils/speechToText'
import type { ApprovalResolution, PendingApprovalRequest } from './approvalCoordinator'
import { ApprovalCoordinator } from './approvalCoordinator'
import type { MediaTransfer } from './mediaStore'
import { TelegramMediaStore } from './mediaStore'
import { createAuthMiddleware } from './telegramAuth'
import type { TelegramBotService } from './telegramBotService'

const MAX_MESSAGE_LENGTH = 4096
const MAX_ASK_REPORT_MESSAGE_LENGTH = 4000

interface PendingVoiceConfirmation {
  voiceRequestId: string
  userId: number
  chatId: number
  recognizedText: string
  messageId?: number
}

interface PendingAskReportRecipient {
  userId: number
  chatId: number
  messageId?: number
  expectsFreeformResponse: boolean
}

interface PendingAskReportState {
  recipients: PendingAskReportRecipient[]
  options: string[]
}

export type AskReportDeliveryMode = 'auto' | 'message' | 'document'

export type TelegramActionCallback =
  | { type: 'approval-approve'; approvalId: string }
  | { type: 'approval-deny'; approvalId: string }
  | { type: 'approval-deny-skip'; approvalId: string }
  | { type: 'voice-confirm'; voiceRequestId: string }
  | { type: 'voice-cancel'; voiceRequestId: string }

export function parseTelegramActionCallback(data: string): TelegramActionCallback | undefined {
  if (data.startsWith('approval:approve:')) {
    return { type: 'approval-approve', approvalId: data.slice('approval:approve:'.length) }
  }
  if (data.startsWith('approval:deny:skip:')) {
    return { type: 'approval-deny-skip', approvalId: data.slice('approval:deny:skip:'.length) }
  }
  if (data.startsWith('approval:deny:')) {
    return { type: 'approval-deny', approvalId: data.slice('approval:deny:'.length) }
  }
  if (data.startsWith('voice:confirm:')) {
    return { type: 'voice-confirm', voiceRequestId: data.slice('voice:confirm:'.length) }
  }
  if (data.startsWith('voice:cancel:')) {
    return { type: 'voice-cancel', voiceRequestId: data.slice('voice:cancel:'.length) }
  }
  return undefined
}

export function parseAskReportDeliveryMode(value: string | undefined): AskReportDeliveryMode {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'message':
      return 'message'
    case 'document':
      return 'document'
    case 'auto':
    default:
      return 'auto'
  }
}

export function buildTelegramAskReportText(topic: string, message: string, maxLength: number = MAX_ASK_REPORT_MESSAGE_LENGTH): string {
  const base = `📋 ${topic}\n\n${message}`
  if (base.length <= maxLength) {
    return base
  }

  const suffix = '\n\n[truncated for Telegram]'
  const truncated = base.substring(0, Math.max(0, maxLength - suffix.length - 3)).trimEnd()
  return `${truncated}...${suffix}`
}

/** Split long Telegram responses into message-sized chunks while preferring newline boundaries. */
export function splitTelegramMessage(text: string, maxMessageLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxMessageLength) {
    return [text]
  }

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxMessageLength) {
      chunks.push(remaining)
      break
    }

    let splitAt = remaining.lastIndexOf('\n', maxMessageLength)
    if (splitAt <= 0) {
      splitAt = maxMessageLength
    }

    chunks.push(remaining.substring(0, splitAt))
    remaining = remaining.substring(splitAt).trimStart()
  }

  return chunks
}

/**
 * Bridges Telegram transport events with Relief Pilot actions inside VS Code.
 * Besides text forwarding, it now owns command approvals, voice confirmation,
 * file staging, and outbound file delivery.
 */
export class MessageBridge {
  private bot: Bot
  private botService: TelegramBotService
  private outputChannel: vscode.OutputChannel
  private approvalCoordinator: ApprovalCoordinator | null = null
  private mediaStore: TelegramMediaStore | null = null
  private pendingAskReports = new Map<string, PendingAskReportState>()
  private pendingVoiceConfirmations = new Map<string, PendingVoiceConfirmation>()

  constructor(bot: Bot, botService: TelegramBotService, outputChannel: vscode.OutputChannel) {
    this.bot = bot
    this.botService = botService
    this.outputChannel = outputChannel
  }

  public setApprovalCoordinator(approvalCoordinator: ApprovalCoordinator): void {
    this.approvalCoordinator = approvalCoordinator
  }

  public setMediaStore(mediaStore: TelegramMediaStore): void {
    this.mediaStore = mediaStore
  }

  public registerHandlers(): void {
    const authMiddleware = createAuthMiddleware()

    // Handle text messages (non-commands) — forward to Relief as prompt.
    this.bot.on('message:text', authMiddleware, async (ctx) => {
      const text = ctx.message.text
      const userId = ctx.from?.id

      if (typeof userId === 'number' && await this.tryHandlePendingAskReportResponse(ctx, userId, text)) {
        return
      }

      if (typeof userId === 'number' && await this.tryHandlePendingDenialFeedback(ctx, userId, text)) {
        return
      }

      // Skip if it's a command (already handled by telegramCommands).
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

    this.bot.on('message:voice', authMiddleware, async (ctx) => {
      await this.handleVoiceMessage(ctx)
    })

    this.bot.on('message:document', authMiddleware, async (ctx) => {
      await this.handleDocumentMessage(ctx)
    })

    // Handle unsupported message types.
    this.bot.on('message', authMiddleware, async (ctx) => {
      const message = ctx.message
      if (!message) {
        return
      }

      if (message.text || message.voice || message.document) {
        return
      }

      await ctx.reply('Supported message types: text, voice messages, and document uploads.')
    })

    // Handle callback queries for ask_report responses.
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data
      if (data.startsWith('bind_owner:')) return

      if (data.startsWith('ask_report:')) {
        await this.handleAskReportCallback(ctx, data)
      }
    })
  }

  public async handleActionCallback(ctx: Context, data: string): Promise<boolean> {
    const action = parseTelegramActionCallback(data)
    if (!action) {
      return false
    }

    const userId = ctx.from?.id
    if (!userId) {
      await ctx.answerCallbackQuery({ text: 'Unable to identify user.' })
      return true
    }

    switch (action.type) {
      case 'approval-approve':
        await this.handleApprovalApprove(ctx, action.approvalId)
        return true
      case 'approval-deny':
        await this.handleApprovalDeny(ctx, action.approvalId, userId)
        return true
      case 'approval-deny-skip':
        await this.handleApprovalDenySkip(ctx, action.approvalId, userId)
        return true
      case 'voice-confirm':
        await this.handleVoiceConfirmation(ctx, action.voiceRequestId, true)
        return true
      case 'voice-cancel':
        await this.handleVoiceConfirmation(ctx, action.voiceRequestId, false)
        return true
      default:
        return false
    }
  }

  public async sendApprovalRequest(request: PendingApprovalRequest): Promise<number> {
    // Send the same approval request to every authorized Telegram user so the
    // first person/device to respond can resolve the command.
    const authorizedIds = this.botService.getAuthorizedUserIds()
    if (authorizedIds.length === 0) {
      throw new Error('No authorized Telegram users are configured for approvals.')
    }

    let delivered = 0
    for (const userId of authorizedIds) {
      const sent = await this.bot.api.sendMessage(userId, this.renderApprovalRequest(request), {
        reply_markup: this.buildApprovalKeyboard(request.approvalId),
      })
      delivered++
      this.approvalCoordinator?.registerTelegramMessage(request.approvalId, userId, sent.message_id)
    }

    return delivered
  }

  public async updateApprovalResolution(request: PendingApprovalRequest, resolution: ApprovalResolution): Promise<void> {
    for (const telegramMessage of request.telegramMessages) {
      await this.safeEditMessage(
        telegramMessage.chatId,
        telegramMessage.messageId,
        this.renderApprovalResolution(request, resolution),
      )
    }
  }

  public async deliverFileToAuthorizedUsers(filePath: string, caption: string, userIds?: number[]): Promise<MediaTransfer[]> {
    const targetUserIds = userIds && userIds.length > 0 ? userIds : this.botService.getAuthorizedUserIds()
    if (targetUserIds.length === 0) {
      throw new Error('No authorized Telegram users are configured for outbound file delivery.')
    }

    const transfers: MediaTransfer[] = []
    for (const userId of targetUserIds) {
      const transfer = await this.deliverFileToChat(userId, userId, filePath, caption)
      transfers.push(transfer)
    }

    return transfers
  }

  public async sendAskReportNotification(
    chatId: number,
    reportId: string,
    topic: string,
    message: string,
    options?: string[],
  ): Promise<void> {
    const markdownBody = `# ${topic}\n\n${message}`
    const localPath = await this.createAskReportTempFile(topic, markdownBody)
    const messageBody = buildTelegramAskReportText(topic, `Local path: ${localPath}\n\n${message}`)
    const caption = options && options.length > 0
      ? `📋 ask_report received.\nLocal path: ${localPath}\n\nChoose an option below.`
      : `📋 ask_report received.\nLocal path: ${localPath}\n\nReply with your next message.`
    const deliveryMode = parseAskReportDeliveryMode(
      vscode.workspace.getConfiguration('reliefpilot').get<string>('telegramAskReportDeliveryMode', 'auto'),
    )
    const sendAsDocument = deliveryMode === 'document'
      || (deliveryMode === 'auto' && `📋 ${topic}\n\nLocal path: ${localPath}\n\n${message}`.length > MAX_ASK_REPORT_MESSAGE_LENGTH)

    const keyboard = options && options.length > 0
      ? this.buildAskReportKeyboard(reportId, options)
      : undefined

    try {
      const sent = sendAsDocument
        ? await this.bot.api.sendDocument(
          chatId,
          new InputFile(localPath),
          {
            caption,
            reply_markup: keyboard,
          },
        )
        : await this.bot.api.sendMessage(chatId, messageBody, {
          reply_markup: keyboard,
        })
      const state = this.pendingAskReports.get(reportId) ?? {
        recipients: [],
        options: options ? [...options] : [],
      }
      state.recipients.push({
        userId: chatId,
        chatId,
        messageId: sent.message_id,
        expectsFreeformResponse: !options || options.length === 0,
      })
      if (state.options.length === 0 && options && options.length > 0) {
        state.options = [...options]
      }
      this.pendingAskReports.set(reportId, state)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`[Telegram] Failed to send ask_report notification: ${errMsg}`)
    }
  }

  private async tryHandlePendingAskReportResponse(ctx: Context, userId: number, text: string): Promise<boolean> {
    const pending = this.findPendingAskReportByUser(userId)
    if (!pending || !pending.recipient.expectsFreeformResponse) {
      return false
    }

    const value = text.trim()
    if (!value) {
      await ctx.reply('Reply with a non-empty answer for the pending ask_report request.')
      return true
    }

    const state = resolveAskReportFromTelegram(pending.reportId, value)
    if (state === 'resolved') {
      await this.markAskReportResolved(pending.reportId, `Submitted from Telegram ✓\n\n${value}`)
      await ctx.reply('✅ ask_report reply delivered to Relief Pilot.')
      return true
    }

    this.clearPendingAskReport(pending.reportId)
    await ctx.reply('This ask_report request is no longer pending.')
    return true
  }

  private async tryHandlePendingDenialFeedback(ctx: Context, userId: number, text: string): Promise<boolean> {
    if (!this.approvalCoordinator?.getPendingDenialFeedback(userId)) {
      return false
    }

    const result = this.approvalCoordinator.resolveTelegramDenialFeedback(userId, text.trim() || null)
    if (result.state === 'resolved') {
      await ctx.reply('✅ Denial feedback received. The command was rejected.')
    } else {
      await ctx.reply('The command has already been resolved.')
    }

    return true
  }

  private async handleApprovalApprove(ctx: Context, approvalId: string): Promise<void> {
    if (!this.approvalCoordinator) {
      await ctx.answerCallbackQuery({ text: 'Approval coordinator unavailable.' })
      return
    }

    const result = this.approvalCoordinator.resolve(approvalId, {
      approved: true,
      feedback: null,
      source: 'telegram',
    })

    if (result.state === 'resolved') {
      await ctx.answerCallbackQuery({ text: 'Approved ✓' })
      return
    }

    await ctx.answerCallbackQuery({ text: 'Already resolved.' })
  }

  private async handleApprovalDeny(ctx: Context, approvalId: string, userId: number): Promise<void> {
    if (!this.approvalCoordinator) {
      await ctx.answerCallbackQuery({ text: 'Approval coordinator unavailable.' })
      return
    }

    const chatId = typeof ctx.chat?.id === 'number' ? ctx.chat.id : userId
    const result = this.approvalCoordinator.beginTelegramDenialFeedback(approvalId, userId, chatId)
    if (result.state === 'already-resolved') {
      await ctx.answerCallbackQuery({ text: 'Already resolved.' })
      return
    }

    if (result.state === 'not-found') {
      await ctx.answerCallbackQuery({ text: 'Approval not found.' })
      return
    }

    await ctx.answerCallbackQuery({ text: 'Send optional feedback or skip.' })
    await ctx.reply('Command denied. Reply with optional feedback as your next message, or tap Skip feedback.', {
      reply_markup: new InlineKeyboard().text('Skip feedback', `approval:deny:skip:${approvalId}`),
    })
  }

  private async handleApprovalDenySkip(ctx: Context, approvalId: string, userId: number): Promise<void> {
    if (!this.approvalCoordinator) {
      await ctx.answerCallbackQuery({ text: 'Approval coordinator unavailable.' })
      return
    }

    const result = this.approvalCoordinator.skipTelegramDenialFeedback(approvalId, userId)
    if (result.state === 'resolved') {
      await ctx.answerCallbackQuery({ text: 'Denied.' })
      return
    }

    await ctx.answerCallbackQuery({ text: 'Already resolved.' })
  }

  private async handleVoiceMessage(ctx: Context): Promise<void> {
    // Voice messages are transcribed first and only forwarded after the user
    // confirms the recognized text preview.
    const message = ctx.message
    const voice = message?.voice
    const userId = ctx.from?.id
    const chatId = ctx.chat?.id

    if (!voice || typeof userId !== 'number' || typeof chatId !== 'number') {
      await ctx.reply('Unable to process this voice message.')
      return
    }

    await ctx.reply('🎙 Transcribing voice message...')

    try {
      const file = await ctx.getFile()
      if (!file.file_path) {
        throw new Error('Telegram did not return a downloadable file path.')
      }

      const audioBuffer = await this.downloadTelegramFile(file.file_path)
      const recognizedText = (await transcribeAudio(audioBuffer)).trim()
      if (!recognizedText) {
        await ctx.reply('❌ Could not recognize usable text from the voice message. Please try again or send text directly.')
        return
      }

      const voiceRequestId = randomUUID()
      const sent = await ctx.reply(
        `Recognized text:\n\n${recognizedText}`,
        {
          reply_markup: new InlineKeyboard()
            .text('Send to Relief', `voice:confirm:${voiceRequestId}`)
            .text('Cancel', `voice:cancel:${voiceRequestId}`),
        },
      )

      this.pendingVoiceConfirmations.set(voiceRequestId, {
        voiceRequestId,
        userId,
        chatId,
        recognizedText,
        messageId: sent.message_id,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`[Telegram] Voice transcription failed: ${message}`)
      await ctx.reply(`❌ Voice request could not be processed: ${message}`)
    }
  }

  private async handleVoiceConfirmation(ctx: Context, voiceRequestId: string, shouldForward: boolean): Promise<void> {
    const pending = this.pendingVoiceConfirmations.get(voiceRequestId)
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Voice request already resolved.' })
      return
    }

    if (ctx.from?.id !== pending.userId) {
      await ctx.answerCallbackQuery({ text: 'This voice request belongs to another user.' })
      return
    }

    this.pendingVoiceConfirmations.delete(voiceRequestId)

    if (!shouldForward) {
      await ctx.answerCallbackQuery({ text: 'Voice request cancelled.' })
      if (typeof pending.messageId === 'number') {
        await this.safeEditMessage(pending.chatId, pending.messageId, 'Voice request cancelled.')
      }
      return
    }

    await ctx.answerCallbackQuery({ text: 'Sending to Relief...' })

    try {
      const response = await this.forwardToRelief(pending.recognizedText)
      if (typeof pending.messageId === 'number') {
        await this.safeEditMessage(
          pending.chatId,
          pending.messageId,
          `Recognized text sent to Relief ✓\n\n${pending.recognizedText}`,
        )
      }
      await ctx.reply(response)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (typeof pending.messageId === 'number') {
        await this.safeEditMessage(
          pending.chatId,
          pending.messageId,
          `Failed to forward recognized text to Relief.\n\n${message}`,
        )
      }
      await ctx.reply(`❌ Failed to forward recognized text: ${message}`)
    }
  }

  private async handleDocumentMessage(ctx: Context): Promise<void> {
    // Files are staged locally for downstream workflows instead of being pushed
    // directly into Copilot Chat, which keeps the hand-off explicit.
    if (!this.mediaStore) {
      await ctx.reply('File staging is unavailable right now.')
      return
    }

    const message = ctx.message
    const document = message?.document
    const userId = ctx.from?.id
    const chatId = ctx.chat?.id
    if (!document || typeof userId !== 'number' || typeof chatId !== 'number') {
      await ctx.reply('Unable to process this file upload.')
      return
    }

    const validation = this.mediaStore.validateInboundDocument({
      fileName: document.file_name,
      mimeType: document.mime_type,
      fileSize: document.file_size,
    })
    if (!validation.ok) {
      await ctx.reply(`❌ ${validation.message}`)
      return
    }

    try {
      const file = await ctx.getFile()
      if (!file.file_path) {
        throw new Error('Telegram did not return a downloadable file path.')
      }

      const buffer = await this.downloadTelegramFile(file.file_path)
      const transfer = await this.mediaStore.stageInboundBuffer({
        userId,
        chatId,
        fileName: document.file_name ?? document.file_id,
        mimeType: document.mime_type ?? null,
        telegramFileId: document.file_id,
        buffer,
      })

      await ctx.reply(
        `✅ File received and staged for Relief.\nName: ${transfer.fileName}\nPath: ${transfer.localPath}`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`[Telegram] File staging failed: ${message}`)
      await ctx.reply(`❌ File upload failed: ${message}`)
    }
  }

  private async deliverFileToChat(chatId: number, userId: number, filePath: string, caption: string): Promise<MediaTransfer> {
    // Outbound delivery reuses the media store so status transitions are visible
    // for both successful sends and failed attempts.
    if (!this.mediaStore) {
      throw new Error('Media store is unavailable.')
    }

    const transfer = await this.mediaStore.beginOutboundTransfer(userId, chatId, filePath)
    try {
      await fs.access(filePath)
      await this.bot.api.sendDocument(chatId, new InputFile(filePath), {
        caption,
      })
      this.mediaStore.markSent(transfer.transferId)
      return this.mediaStore.getTransfer(transfer.transferId) ?? transfer
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.mediaStore.markFailed(transfer.transferId, message)
      await this.bot.api.sendMessage(chatId, `❌ File delivery failed: ${message}`)
      throw err
    }
  }

  private async forwardToRelief(text: string): Promise<string> {
    // Send text to Copilot Chat as a prompt via VS Code command.
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

  private async downloadTelegramFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${this.bot.token}/${filePath}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Telegram download failed with status ${response.status}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }

  private renderApprovalRequest(request: PendingApprovalRequest): string {
    // Keep the Telegram approval message compact but include enough execution
    // context to approve from a phone without guessing the environment.
    const context: string[] = []
    if (request.customCwd) {
      context.push(`cwd: ${request.customCwd}`)
    }
    context.push(`destructive: ${request.destructive ? 'yes' : 'no'}`)

    return [
      'Command approval requested',
      '',
      request.command,
      '',
      `Context: ${context.join(' · ')}`,
    ].join('\n')
  }

  private renderApprovalResolution(request: PendingApprovalRequest, resolution: ApprovalResolution): string {
    const status = resolution.approved
      ? resolution.source === 'vscode'
        ? 'Approved ✓ (from VS Code)'
        : 'Approved ✓'
      : resolution.feedback
        ? `Denied ✗\nFeedback: ${resolution.feedback}`
        : 'Denied ✗'

    return [
      status,
      '',
      request.command,
    ].join('\n')
  }

  private buildApprovalKeyboard(approvalId: string): InlineKeyboard {
    return new InlineKeyboard()
      .text('Approve', `approval:approve:${approvalId}`)
      .text('Deny', `approval:deny:${approvalId}`)
  }

  private async sendLongMessage(ctx: Context, text: string): Promise<void> {
    // Split long messages at line boundaries.
    for (const chunk of splitTelegramMessage(text)) {
      await ctx.reply(chunk)
    }
  }

  private buildAskReportKeyboard(reportId: string, options: string[]): InlineKeyboard {
    const keyboard = new InlineKeyboard()
    options.forEach((option, index) => {
      keyboard.text(option, `ask_report:${reportId}:${index}`).row()
    })
    keyboard.text('Custom', `ask_report:${reportId}:custom`).row()
    return keyboard
  }

  private resolveAskReportOption(reportId: string, rawSelection: string): string | undefined {
    const state = this.pendingAskReports.get(reportId)
    if (!state) {
      return undefined
    }

    if (rawSelection === 'custom') {
      return 'custom'
    }

    const optionIndex = Number.parseInt(rawSelection, 10)
    if (!Number.isNaN(optionIndex) && optionIndex >= 0 && optionIndex < state.options.length) {
      return state.options[optionIndex]
    }

    return rawSelection
  }

  private async handleAskReportCallback(ctx: Context, data: string): Promise<void> {
    // Format: ask_report:reportId:selectedOption
    const parts = data.split(':')
    if (parts.length < 3) {
      await ctx.answerCallbackQuery({ text: 'Invalid callback data.' })
      return
    }

    const reportId = parts[1]
    const selectedOption = this.resolveAskReportOption(reportId, parts.slice(2).join(':'))
    if (!selectedOption) {
      this.clearPendingAskReport(reportId)
      await ctx.answerCallbackQuery({ text: 'This ask_report request is no longer pending.' })
      return
    }

    if (selectedOption === 'custom') {
      const userId = ctx.from?.id
      if (typeof userId !== 'number') {
        await ctx.answerCallbackQuery({ text: 'Unable to identify user.' })
        return
      }

      if (!this.enableAskReportCustomReply(reportId, userId)) {
        this.clearPendingAskReport(reportId)
        await ctx.answerCallbackQuery({ text: 'This ask_report request is no longer pending.' })
        return
      }

      await ctx.answerCallbackQuery({ text: 'Send your custom reply as the next message.' })
      await ctx.reply('Custom selected. Send your next Telegram message and it will be used as the ask_report response.')
      return
    }

    this.outputChannel.appendLine(`[Telegram] ask_report callback: report=${reportId}, option=${selectedOption}`)

    const state = resolveAskReportFromTelegram(reportId, selectedOption)
    if (state === 'resolved') {
      await this.markAskReportResolved(reportId, `Submitted from Telegram ✓\n\n${selectedOption}`)
      await ctx.answerCallbackQuery({ text: `Selected: ${selectedOption}` })
      return
    }

    this.clearPendingAskReport(reportId)
    await ctx.answerCallbackQuery({ text: 'This ask_report request is no longer pending.' })
  }

  private findPendingAskReportByUser(userId: number): { reportId: string; recipient: PendingAskReportRecipient } | undefined {
    for (const [reportId, state] of this.pendingAskReports) {
      const recipient = state.recipients.find((entry) => entry.userId === userId)
      if (recipient) {
        return { reportId, recipient }
      }
    }

    return undefined
  }

  private clearPendingAskReport(reportId: string): void {
    this.pendingAskReports.delete(reportId)
  }

  private enableAskReportCustomReply(reportId: string, userId: number): boolean {
    const state = this.pendingAskReports.get(reportId)
    if (!state) {
      return false
    }

    const recipient = state.recipients.find((entry) => entry.userId === userId)
    if (!recipient) {
      return false
    }

    recipient.expectsFreeformResponse = true
    return true
  }

  private async markAskReportResolved(reportId: string, resolutionText: string): Promise<void> {
    const recipients = this.pendingAskReports.get(reportId)?.recipients ?? []
    this.pendingAskReports.delete(reportId)

    for (const recipient of recipients) {
      await this.bot.api.sendMessage(recipient.chatId, resolutionText)
    }
  }

  private buildAskReportFileName(topic: string): string {
    const base = topic
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')

    return `${base || 'ask-report'}.md`
  }

  private async createAskReportTempFile(topic: string, markdownBody: string): Promise<string> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const workspaceName = workspaceRoot
      ? path.basename(workspaceRoot).trim().replace(/[^a-zA-Z0-9._-]+/g, '_') || 'workspace'
      : 'workspace'

    const stageDir = path.join(os.tmpdir(), 'reliefpilot-telegram-media', workspaceName)
    await fs.mkdir(stageDir, { recursive: true })

    const filePath = path.join(stageDir, `${randomUUID()}-${this.buildAskReportFileName(topic)}`)
    await fs.writeFile(filePath, markdownBody, 'utf8')
    return filePath
  }

  private async safeEditMessage(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.bot.api.editMessageText(chatId, messageId, text)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`[Telegram] Failed to edit message ${messageId} in ${chatId}: ${message}`)
    }
  }

  public dispose(): void {
    this.pendingAskReports.clear()
    this.pendingVoiceConfirmations.clear()
  }
}
