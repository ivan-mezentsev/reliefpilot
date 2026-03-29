import type { Bot } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { parseTelegramActionCallback } from './messageBridge'
import type { RemoteInboxItem, RemoteSession, StoredDiffSnapshot } from './remoteSessionRegistry'
import { bindOwner, createAuthMiddleware, hasOwner, isAuthorized } from './telegramAuth'
import type { TelegramBotService } from './telegramBotService'

export function registerCommands(bot: Bot, botService: TelegramBotService): void {
  // /start — available to everyone (for owner binding), but with special handling.
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
      await ctx.reply('Relief Pilot Bot is ready. Send text, voice, or document messages to control Relief remotely.')
    } else {
      await ctx.reply('Unauthorized. Contact the bot owner.')
    }
  })

  // Handle owner binding callback.
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

  // Handle approval and voice-related callback actions.
  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data
    const action = parseTelegramActionCallback(data)
    if (!action) {
      await next()
      return
    }

    const userId = ctx.from?.id
    if (!userId || !isAuthorized(userId)) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized.' })
      return
    }

    const bridge = botService.getMessageBridge()
    if (!bridge) {
      await ctx.answerCallbackQuery({ text: 'Telegram bridge unavailable.' })
      return
    }

    await bridge.handleActionCallback(ctx, data)
  })

  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data
    if (!data.startsWith('session:select:')) {
      await next()
      return
    }

    const userId = ctx.from?.id
    if (!userId || !isAuthorized(userId)) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized.' })
      return
    }

    const sessionId = data.slice('session:select:'.length)
    const registry = botService.getRemoteSessionRegistry()
    const session = registry?.selectSession(sessionId)
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'Session not found.' })
      return
    }

    await ctx.answerCallbackQuery({ text: `Active: ${truncate(session.title, 40)}` })
    await ctx.editMessageText(renderSelectedSessionMessage(session))
  })

  const authMiddleware = createAuthMiddleware()

  // /status — authorized users only.
  bot.command('status', authMiddleware, async (ctx) => {
    const state = botService.getState()
    const uptime = state.connectedAt
      ? formatUptime(Date.now() - state.connectedAt.getTime())
      : 'N/A'
    const registry = botService.getRemoteSessionRegistry()
    const activeSession = registry?.getSelectedSession()
    const pendingItem = activeSession
      ? registry?.getNextPendingItem(activeSession.sessionId)
      : registry?.getNextPendingItem()
    const latestDiff = activeSession
      ? registry?.getLatestDiffSnapshot(activeSession.sessionId)
      : undefined
    const notificationMode = registry?.getNotificationMode() ?? 'actionable'

    await ctx.reply(
      `🤖 Bot Status: ${capitalize(state.status)}\n` +
      `⏱ Uptime: ${uptime}\n` +
      `📨 Messages processed: ${state.messageCount}\n` +
      `💻 VS Code: Active\n` +
      `🔕 Notification mode: ${notificationMode}\n` +
      `🧠 Active session: ${activeSession ? activeSession.title : 'none'}\n` +
      `📌 Next pending: ${pendingItem ? summarizePendingItem(pendingItem) : 'none'}\n` +
      `🧾 Latest diff: ${latestDiff ? summarizeDiff(latestDiff) : 'none'}`,
    )
  })

  bot.command('pending', authMiddleware, async (ctx) => {
    const registry = botService.getRemoteSessionRegistry()
    const activeSession = registry?.getSelectedSession()
    const pendingItem = activeSession
      ? registry?.getNextPendingItem(activeSession.sessionId)
      : registry?.getNextPendingItem()

    if (!pendingItem) {
      await ctx.reply('✅ Pending inbox item not found. Remote inbox is clear right now.')
      return
    }

    await ctx.reply(renderPendingItem(activeSession, pendingItem))
  })

  bot.command('resume', authMiddleware, async (ctx) => {
    const registry = botService.getRemoteSessionRegistry()
    const sessions = registry?.listRecentSessions(5) ?? []

    if (sessions.length === 0) {
      await ctx.reply('Remote sessions not found yet. Send a Telegram message to start one.')
      return
    }

    if (sessions.length === 1) {
      const selected = registry?.selectSession(sessions[0].sessionId)
      await ctx.reply(selected ? renderSelectedSessionMessage(selected) : 'Session could not be resumed.')
      return
    }

    const keyboard = new InlineKeyboard()
    sessions.forEach((session) => {
      keyboard.text(buildSessionButtonLabel(session), `session:select:${session.sessionId}`).row()
    })

    await ctx.reply('Choose the remote session to resume:', { reply_markup: keyboard })
  })

  bot.command('diff', authMiddleware, async (ctx) => {
    const userId = ctx.from?.id
    const chatId = ctx.chat?.id
    const registry = botService.getRemoteSessionRegistry()
    const diffProvider = botService.getDiffProvider()
    const bridge = botService.getMessageBridge()

    if (typeof userId !== 'number' || typeof chatId !== 'number') {
      await ctx.reply('Unable to determine the current Telegram chat.')
      return
    }

    if (!registry || !diffProvider || !bridge) {
      await ctx.reply('Diff workflow is unavailable right now.')
      return
    }

    const session = registry.getSelectedSession() ?? registry.listRecentSessions(1)[0]
    if (!session) {
      await ctx.reply('No remote session is active yet. Resume a task or send a new request first.')
      return
    }

    if (!session.workspacePath) {
      await ctx.reply(`No workspace is linked to "${session.title}" yet, so I cannot build a git diff.`)
      return
    }

    await ctx.reply(`🧾 Capturing latest diff for: ${session.title}`)

    const snapshot = await diffProvider.captureLatestDiff(session.sessionId, session.workspacePath)
    registry.recordDiffSnapshot({
      sessionId: session.sessionId,
      sessionTitle: session.title,
      workspacePath: session.workspacePath,
      snapshot: {
        diffId: snapshot.diffId,
        sessionId: session.sessionId,
        source: snapshot.source,
        summary: snapshot.summary,
        fullArtifactPath: snapshot.fullArtifactPath,
        fingerprint: snapshot.fingerprint,
        createdAt: snapshot.createdAt,
        status: snapshot.status,
      },
    })

    await bridge.sendDiffSnapshotToChat({
      chatId,
      userId,
      sessionId: session.sessionId,
      sessionTitle: session.title,
      summary: snapshot.summary,
      artifactPath: snapshot.fullArtifactPath,
    })
  })

  bot.command('summary', authMiddleware, async (ctx) => {
    const registry = botService.getRemoteSessionRegistry()
    const activeSession = registry?.getSelectedSession()
    const actionableOnly = registry?.getNotificationMode() === 'actionable'
    const items = registry?.listRecentInboxItems({
      sessionId: activeSession?.sessionId,
      limit: 5,
      actionableOnly,
    }) ?? []

    if (items.length === 0) {
      await ctx.reply('🧾 Catch-up summary is empty right now. No recent inbox activity matched the current notification mode.')
      return
    }

    await ctx.reply(renderCatchUpSummary(activeSession, items, actionableOnly))
  })

  // /help — authorized users only.
  bot.command('help', authMiddleware, async (ctx) => {
    await ctx.reply(
      'Available commands:\n' +
      '/start - Initialize bot\n' +
      '/status - Check bot and Relief status\n' +
      '/pending - Show the next pending remote inbox item\n' +
      '/resume - Pick the remote session to continue\n' +
      '/diff - Send the latest diff summary and full patch if available\n' +
      '/summary - Show a short catch-up summary from the remote inbox\n' +
      '/help - Show this help\n\n' +
      'Send text to continue the active remote session or start a new task.\n' +
      'Send a voice message to transcribe it before forwarding.\n' +
      'Send a document to stage it for Relief workflows.',
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

function buildSessionButtonLabel(session: RemoteSession): string {
  return `${truncate(session.title, 32)} · ${formatRelativeTime(session.lastActivityAt)}`
}

function renderSelectedSessionMessage(session: RemoteSession): string {
  return [
    '🔁 Remote session resumed',
    '',
    `Title: ${session.title}`,
    `Status: ${session.status}`,
    `Last activity: ${formatRelativeTime(session.lastActivityAt)}`,
  ].join('\n')
}

function renderPendingItem(activeSession: RemoteSession | undefined, pendingItem: RemoteInboxItem): string {
  return [
    '📌 Next pending inbox item',
    '',
    `Session: ${activeSession?.title ?? pendingItem.sessionId}`,
    `Kind: ${pendingItem.kind}`,
    `Title: ${pendingItem.title}`,
    `Summary: ${truncate(pendingItem.summary, 180)}`,
    `Created: ${formatRelativeTime(pendingItem.createdAt)}`,
  ].join('\n')
}

function summarizePendingItem(item: RemoteInboxItem): string {
  return `${item.kind} · ${truncate(item.title, 24)}`
}

function summarizeDiff(snapshot: StoredDiffSnapshot): string {
  return `${snapshot.status} · ${formatRelativeTime(snapshot.createdAt)}`
}

function renderCatchUpSummary(
  activeSession: RemoteSession | undefined,
  items: RemoteInboxItem[],
  actionableOnly: boolean,
): string {
  const lines = [
    `🧾 Catch-up summary${activeSession ? ` · ${activeSession.title}` : ''}`,
    '',
    `Mode: ${actionableOnly ? 'actionable only' : 'all inbox events'}`,
    '',
  ]

  items.forEach((item) => {
    lines.push(`- [${item.status}] ${item.title} · ${truncate(item.summary, 100)} (${formatRelativeTime(item.createdAt)})`)
  })

  return lines.join('\n')
}

function formatRelativeTime(date: Date): string {
  const deltaMs = Date.now() - date.getTime()
  const deltaMinutes = Math.max(0, Math.floor(deltaMs / 60000))
  if (deltaMinutes < 1) {
    return 'just now'
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`
  }
  const deltaHours = Math.floor(deltaMinutes / 60)
  if (deltaHours < 24) {
    return `${deltaHours}h ago`
  }
  return `${Math.floor(deltaHours / 24)}d ago`
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}
