import { Bot } from 'grammy'
import * as vscode from 'vscode'
import { getTelegramBotToken } from '../../utils/telegram_auth'
import { MessageBridge } from './messageBridge'
import { registerCommands } from './telegramCommands'

export type BotStatus = 'stopped' | 'starting' | 'connected' | 'reconnecting' | 'error'

export interface BotState {
  status: BotStatus
  lastError: string | null
  connectedAt: Date | null
  messageCount: number
}

export class TelegramBotService {
  private bot: Bot | null = null
  private messageBridge: MessageBridge | null = null
  private state: BotState = {
    status: 'stopped',
    lastError: null,
    connectedAt: null,
    messageCount: 0,
  }
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private outputChannel: vscode.OutputChannel

  private readonly _onStateChange = new vscode.EventEmitter<BotState>()
  public readonly onStateChange = this._onStateChange.event

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel
  }

  public getState(): BotState {
    return { ...this.state }
  }

  public getBot(): Bot | null {
    return this.bot
  }

  public getMessageBridge(): MessageBridge | null {
    return this.messageBridge
  }

  public incrementMessageCount(): void {
    this.state.messageCount++
  }

  private setState(patch: Partial<BotState>): void {
    Object.assign(this.state, patch)
    this._onStateChange.fire(this.getState())
  }

  public async start(): Promise<void> {
    if (this.state.status === 'connected' || this.state.status === 'starting') {
      this.outputChannel.appendLine('Telegram bot is already running or starting.')
      return
    }

    const token = await getTelegramBotToken()
    if (!token) {
      vscode.window.showErrorMessage('Telegram Bot token is not configured. Use the Relief Pilot menu to set it up.')
      return
    }

    this.setState({ status: 'starting', lastError: null })
    this.outputChannel.appendLine('Starting Telegram bot...')

    try {
      this.bot = new Bot(token)
      this.setupHandlers()
      await this.startPolling()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`Failed to start Telegram bot: ${message}`)
      this.setState({ status: 'error', lastError: message })
      this.scheduleReconnect()
    }
  }

  public async stop(): Promise<void> {
    this.clearReconnectTimer()
    this.reconnectAttempt = 0

    if (this.messageBridge) {
      this.messageBridge.dispose()
      this.messageBridge = null
    }

    if (this.bot) {
      try {
        await this.bot.stop()
      } catch {
        // ignore stop errors
      }
      this.bot = null
    }

    this.setState({
      status: 'stopped',
      connectedAt: null,
      messageCount: 0,
    })
    this.outputChannel.appendLine('Telegram bot stopped.')
  }

  private setupHandlers(): void {
    if (!this.bot) return

    // Register bot commands (/start, /status, /help, owner binding)
    registerCommands(this.bot, this)

    // Register message bridge (text forwarding, ask_report callbacks)
    this.messageBridge = new MessageBridge(this.bot, this, this.outputChannel)
    this.messageBridge.registerHandlers()

    this.bot.catch((err) => {
      const message = err.message ?? String(err)
      this.outputChannel.appendLine(`Telegram bot error: ${message}`)

      if (this.isNetworkError(err)) {
        this.setState({ status: 'reconnecting', lastError: message })
        this.scheduleReconnect()
      } else {
        this.setState({ lastError: message })
      }
    })
  }

  private async startPolling(): Promise<void> {
    if (!this.bot) return

    // bot.start() runs the polling loop. It resolves when the initial
    // getUpdates succeeds, then continues polling in the background.
    this.bot.start({
      onStart: () => {
        this.reconnectAttempt = 0
        this.setState({
          status: 'connected',
          connectedAt: new Date(),
        })
        this.outputChannel.appendLine('Telegram bot connected and polling.')
      },
    })
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer()

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000)
    this.reconnectAttempt++
    this.outputChannel.appendLine(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempt})...`)

    this.reconnectTimer = setTimeout(async () => {
      if (this.state.status === 'stopped') return
      this.setState({ status: 'reconnecting' })
      try {
        if (this.bot) {
          try { await this.bot.stop() } catch { /* ignore */ }
          this.bot = null
        }
        const token = await getTelegramBotToken()
        if (!token) {
          this.setState({ status: 'error', lastError: 'Token not configured' })
          return
        }
        this.bot = new Bot(token)
        this.setupHandlers()
        await this.startPolling()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.outputChannel.appendLine(`Reconnect failed: ${message}`)
        this.setState({ status: 'error', lastError: message })
        this.scheduleReconnect()
      }
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private isNetworkError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err)
    return /network|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|429/i.test(message)
  }

  public dispose(): void {
    this._onStateChange.dispose()
    this.clearReconnectTimer()
  }
}
