import { Bot } from 'grammy'
import * as vscode from 'vscode'
import { getTelegramBotToken } from '../../utils/telegram_auth'
import { ApprovalCoordinator } from './approvalCoordinator'
import type { DiffProvider } from './diffProvider'
import type { MediaTransfer } from './mediaStore'
import { TelegramMediaStore } from './mediaStore'
import { MessageBridge } from './messageBridge'
import type { RemoteSessionRegistry } from './remoteSessionRegistry'
import { registerCommands, syncTelegramCommandMenu } from './telegramCommands'

export type BotStatus = 'stopped' | 'starting' | 'connected' | 'reconnecting' | 'error'

export interface BotState {
  status: BotStatus
  lastError: string | null
  connectedAt: Date | null
  messageCount: number
}

/**
 * Manages the grammY bot lifecycle and wires shared Telegram capabilities into
 * the extension, including approval sync and media transfer helpers.
 */
export class TelegramBotService {
  private static readonly STARTUP_TIMEOUT_MS = 10_000
  private static readonly BACKOFF_INITIAL_MS = 1_000
  private static readonly BACKOFF_MAX_MS = 30_000

  private bot: Bot | null = null
  private messageBridge: MessageBridge | null = null
  private approvalCoordinator: ApprovalCoordinator | null = null
  private mediaStore: TelegramMediaStore | null = null
  private remoteSessionRegistry: RemoteSessionRegistry | null = null
  private diffProvider: DiffProvider | null = null
  private approvalResolutionSubscription: vscode.Disposable | null = null
  private startupWatchdog: ReturnType<typeof setTimeout> | null = null
  private state: BotState = {
    status: 'stopped',
    lastError: null,
    connectedAt: null,
    messageCount: 0,
  }
  private running = false
  private backoffDelay = TelegramBotService.BACKOFF_INITIAL_MS
  private restartRequested = false
  private outputChannel: vscode.OutputChannel

  private readonly _onStateChange = new vscode.EventEmitter<BotState>()
  public readonly onStateChange = this._onStateChange.event

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel
  }

  public setApprovalCoordinator(approvalCoordinator: ApprovalCoordinator): void {
    this.approvalCoordinator = approvalCoordinator
    this.wireBridgeDependencies()
  }

  public getApprovalCoordinator(): ApprovalCoordinator | null {
    return this.approvalCoordinator
  }

  public setMediaStore(mediaStore: TelegramMediaStore): void {
    this.mediaStore = mediaStore
    this.wireBridgeDependencies()
  }

  public getMediaStore(): TelegramMediaStore | null {
    return this.mediaStore
  }

  public setRemoteSessionRegistry(remoteSessionRegistry: RemoteSessionRegistry): void {
    this.remoteSessionRegistry = remoteSessionRegistry
    this.wireBridgeDependencies()
  }

  public getRemoteSessionRegistry(): RemoteSessionRegistry | null {
    return this.remoteSessionRegistry
  }

  public setDiffProvider(diffProvider: DiffProvider): void {
    this.diffProvider = diffProvider
    this.wireBridgeDependencies()
  }

  public getDiffProvider(): DiffProvider | null {
    return this.diffProvider
  }

  public getAuthorizedUserIds(): number[] {
    return vscode.workspace.getConfiguration('reliefpilot').get<number[]>('telegramAuthorizedUserIds', [])
  }

  public isConnected(): boolean {
    return this.state.status === 'connected'
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

  public async deliverFileToAuthorizedUsers(filePath: string, caption: string, userIds?: number[]): Promise<MediaTransfer[]> {
    if (!this.messageBridge) {
      throw new Error('Telegram bot is not connected.')
    }

    return this.messageBridge.deliverFileToAuthorizedUsers(filePath, caption, userIds)
  }

  private setState(patch: Partial<BotState>): void {
    Object.assign(this.state, patch)
    this._onStateChange.fire(this.getState())
  }

  public async start(): Promise<void> {
    if (this.running || this.state.status === 'connected' || this.state.status === 'starting') {
      this.outputChannel.appendLine('Telegram bot is already running or starting.')
      return
    }

    const token = await getTelegramBotToken()
    if (!token) {
      vscode.window.showErrorMessage('Telegram Bot token is not configured. Use the Relief Pilot menu to set it up.')
      return
    }

    try {
      this.running = true
      this.backoffDelay = TelegramBotService.BACKOFF_INITIAL_MS
      this.restartRequested = false
      this.setState({ status: 'starting', lastError: null, connectedAt: null })
      this.outputChannel.appendLine('Starting Telegram bot...')
      this.bot = new Bot(token)
      this.setupHandlers()
      void this.startPollingLoop()
    } catch (err) {
      this.running = false
      this.handleBotFailure('start', err)
    }
  }

  public async stop(): Promise<void> {
    this.clearStartupWatchdog()
    this.running = false
    this.restartRequested = false
    this.backoffDelay = TelegramBotService.BACKOFF_INITIAL_MS
    this.disposeApprovalResolutionSubscription()

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

    // Register bot commands (/start, /status, /help, owner binding).
    registerCommands(this.bot, this)

    // Register message bridge (text forwarding, ask_report callbacks, approvals, media flows).
    this.messageBridge = new MessageBridge(this.bot, this, this.outputChannel)
    this.wireBridgeDependencies()
    this.messageBridge.registerHandlers()

    this.bot.catch((err) => {
      if (this.isRoutinePollingTimeout(err)) {
        return
      }

      const message = err.message ?? String(err)
      this.outputChannel.appendLine(`Telegram bot runtime error: ${message}`)

      if (!this.running || this.state.status === 'stopped') {
        return
      }

      this.setState({ lastError: message })
    })
  }

  private wireBridgeDependencies(): void {
    // The bridge is created after the bot starts, so approval/media dependencies
    // are wired lazily and re-wired across reconnects.
    if (!this.messageBridge) {
      return
    }

    if (this.approvalCoordinator) {
      this.messageBridge.setApprovalCoordinator(this.approvalCoordinator)
      this.disposeApprovalResolutionSubscription()
      this.approvalResolutionSubscription = this.approvalCoordinator.onResolved((event) => {
        void this.messageBridge?.updateApprovalResolution(event.request, event.resolution)
      })
    }

    if (this.mediaStore) {
      this.messageBridge.setMediaStore(this.mediaStore)
    }

    if (this.remoteSessionRegistry) {
      this.messageBridge.setRemoteSessionRegistry(this.remoteSessionRegistry)
    }

    if (this.diffProvider) {
      this.messageBridge.setDiffProvider(this.diffProvider)
    }
  }

  private disposeApprovalResolutionSubscription(): void {
    try {
      this.approvalResolutionSubscription?.dispose()
    } catch {
      // ignore cleanup errors
    }
    this.approvalResolutionSubscription = null
  }

  private async startPollingLoop(): Promise<void> {
    while (this.running && this.bot) {
      this.armStartupWatchdog()

      try {
        await this.bot.start({
          onStart: (botInfo) => {
            this.clearStartupWatchdog()
            this.restartRequested = false
            this.backoffDelay = TelegramBotService.BACKOFF_INITIAL_MS
            this.setState({
              status: 'connected',
              connectedAt: new Date(),
              lastError: null,
            })
            this.outputChannel.appendLine(`Telegram bot connected and polling as @${botInfo.username}.`)
            void this.publishCommandMenu()
          },
        })

        this.clearStartupWatchdog()

        if (!this.running) {
          return
        }

        if (!this.restartRequested) {
          return
        }
      } catch (err) {
        this.clearStartupWatchdog()

        if (!this.running) {
          return
        }

        this.handleBotFailure('polling', err)
      }

      if (!this.running) {
        return
      }

      const delay = this.backoffDelay
      this.outputChannel.appendLine(`Reconnecting in ${delay / 1000}s...`)
      await this.sleep(delay)
      this.backoffDelay = Math.min(this.backoffDelay * 2, TelegramBotService.BACKOFF_MAX_MS)
    }
  }

  private armStartupWatchdog(): void {
    this.clearStartupWatchdog()

    this.startupWatchdog = setTimeout(() => {
      if (this.state.status !== 'starting' && this.state.status !== 'reconnecting') {
        return
      }

      const message = `Telegram bot startup timed out after ${TelegramBotService.STARTUP_TIMEOUT_MS}ms while waiting for polling readiness.`
      this.outputChannel.appendLine(message)
      this.restartRequested = true
      this.setState({ status: 'reconnecting', lastError: message })

      void this.bot?.stop().catch(() => {
        // ignore watchdog stop errors
      })
    }, TelegramBotService.STARTUP_TIMEOUT_MS)
  }

  private clearStartupWatchdog(): void {
    if (this.startupWatchdog) {
      clearTimeout(this.startupWatchdog)
      this.startupWatchdog = null
    }
  }

  private isNetworkError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err)
    return /network|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|429|timed out|timeout|abort|aborted/i.test(message)
  }

  private isRoutinePollingTimeout(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err)
    return /timeout/i.test(message)
  }

  private handleBotFailure(stage: 'start' | 'runtime' | 'polling' | 'reconnect', err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    this.clearStartupWatchdog()
    this.outputChannel.appendLine(`Telegram bot ${stage} error: ${message}`)

    if (this.state.status === 'stopped') {
      return
    }

    if (this.isNetworkError(err)) {
      this.setState({ status: 'reconnecting', lastError: message })
      this.restartRequested = true
      return
    }

    this.setState({ status: 'error', lastError: message })
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async publishCommandMenu(): Promise<void> {
    if (!this.bot) {
      return
    }

    try {
      await syncTelegramCommandMenu(this.bot)
      this.outputChannel.appendLine('Telegram command menu published successfully.')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`Failed to publish Telegram command menu: ${message}`)
    }
  }

  public dispose(): void {
    this.disposeApprovalResolutionSubscription()
    this._onStateChange.dispose()
    this.clearStartupWatchdog()
  }
}
