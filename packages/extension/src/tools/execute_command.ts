import type {
  CancellationToken,
  LanguageModelTool,
  LanguageModelToolInvocationOptions,
  LanguageModelToolInvocationPrepareOptions,
  PreparedToolInvocation,
} from 'vscode'
import * as vscode from 'vscode'
import { z } from 'zod'
import { ApprovalCoordinator, type ConfirmationMode } from '../integrations/telegram/approvalCoordinator'
import type { TelegramBotService } from '../integrations/telegram/telegramBotService'
import { TerminalManager } from '../integrations/terminal/TerminalManager'
import { ConfirmationUI } from '../utils/confirmation_ui'
import { env } from '../utils/env'
import { haltForFeedbackController } from '../utils/haltForFeedbackController'
import { formatResponse, ToolResponse } from '../utils/response'
import { statusBarActivity } from '../utils/statusBar'
import { delay } from '../utils/time.js'

// Local type aliases for stricter typing and clearer intent
type TerminalId = number

interface ApprovalDecision {
  approved: boolean
  updatedCommand?: string
  feedback?: string
}

interface ApprovalRoutingPlan {
  mode: ConfirmationMode
  useVscode: boolean
  useTelegram: boolean
  warningMessage?: string
}

const executeCommandOutputChannel = vscode.window.createOutputChannel('Relief Pilot: Command Approval')

let sharedApprovalCoordinator: ApprovalCoordinator | null = null
let sharedTelegramBotService: TelegramBotService | null = null

export function configureExecuteCommandApprovals(options: {
  approvalCoordinator?: ApprovalCoordinator | null
  telegramBotService?: TelegramBotService | null
}): void {
  sharedApprovalCoordinator = options.approvalCoordinator ?? null
  sharedTelegramBotService = options.telegramBotService ?? null
}

/** Normalize the persisted setting into the supported confirmation mode union. */
export function parseConfirmationMode(value: string | undefined): ConfirmationMode {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'telegram':
      return 'telegram'
    case 'both':
      return 'both'
    case 'auto':
      return 'auto'
    case 'vscode':
    default:
      return 'vscode'
  }
}

/**
 * Decide whether this command should pause for approval.
 * In `auto` mode we always bypass prompts, otherwise destructive commands
 * and optionally read-only commands still require confirmation.
 */
export function shouldRequestCommandConfirmation(
  destructiveFlag: boolean,
  confirmNonDestructiveCommands: boolean,
  mode: ConfirmationMode,
): boolean {
  if (mode === 'auto') {
    return false
  }

  return destructiveFlag || confirmNonDestructiveCommands
}

/**
 * Build the effective approval routing plan for the current invocation.
 * This keeps fallback behavior explicit and testable when Telegram is offline.
 */
export function getApprovalRoutingPlan(mode: ConfirmationMode, telegramAvailable: boolean): ApprovalRoutingPlan {
  switch (mode) {
    case 'auto':
      return { mode, useVscode: false, useTelegram: false }
    case 'telegram':
      if (telegramAvailable) {
        return { mode, useVscode: false, useTelegram: true }
      }
      return {
        mode,
        useVscode: true,
        useTelegram: false,
        warningMessage: 'Telegram confirmation mode is enabled, but the Telegram bot is unavailable. Falling back to VS Code confirmation.',
      }
    case 'both':
      if (telegramAvailable) {
        return { mode, useVscode: true, useTelegram: true }
      }
      return {
        mode,
        useVscode: true,
        useTelegram: false,
        warningMessage: 'Both-mode confirmation requested, but Telegram is unavailable. Falling back to VS Code confirmation only.',
      }
    case 'vscode':
    default:
      return { mode: 'vscode', useVscode: true, useTelegram: false }
  }
}

export const executeCommandSchema = z.object({
  // Shell command to run
  command: z.string().describe('Command to execute in an integrated terminal'),
  // Optional override for CWD
  customCwd: z.string().optional().describe('Working directory to run the command in (defaults to workspace root)'),
  // Force a fresh terminal instance even if an existing one is idle
  newTerminal: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, always create a new terminal for this command.'),
  // Destructive/read-only hint controls confirmation UI
  destructiveFlag: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Marks the command as potentially modifying state. Keep true for commands that can change files/system. Set to false for read-only commands (e.g., grep, find, ls).',
    ),
  // Background mode returns immediately after starting the command
  background: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'If true, start the command and return immediately without waiting for completion. Prefer background=true or set a timeout for long-running commands (servers, pagers, etc.).',
    ),
  // Reporting timeout used only to stop waiting (does not kill the process)
  timeout: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(300000)
    .describe(
      'Milliseconds to wait before reporting intermediate output when not in background. This does not terminate the process.',
    ),
})

export class ExecuteCommandTool {
  private cwd: string
  private terminalManager: TerminalManager

  constructor(cwd: string) {
    this.cwd = cwd
    this.terminalManager = TerminalManager.getInstance()
  }

  async execute(
    command: string,
    customCwd?: string,
    destructiveFlag: boolean = true,
    background: boolean = false,
    timeout: number = 300000,
    newTerminal: boolean = false,
  ): Promise<[userRejected: boolean, ToolResponse]> {
    // Read extension setting that optionally forces confirmation for read-only commands.
    // Mode parsing extends the old behavior with Telegram/both/auto routing.
    const config = vscode.workspace.getConfiguration('reliefpilot')
    const confirmNonDestructiveCommands = config.get<boolean>('confirmNonDestructiveCommands', false)
    const confirmationMode = parseConfirmationMode(config.get<string>('commandConfirmationMode', 'vscode'))
    const shouldConfirm = shouldRequestCommandConfirmation(destructiveFlag, confirmNonDestructiveCommands, confirmationMode)
    const autoApproved = confirmationMode === 'auto'

    if (shouldConfirm) {
      const decision = await this.resolveApproval(command, customCwd, destructiveFlag, confirmationMode)
      if (!decision.approved) {
        const note = decision.feedback ? ` Feedback: ${decision.feedback}` : ''
        return [true, formatResponse.toolResult(`Command execution was declined by the user.${note}`)]
      }
      if (decision.updatedCommand && decision.updatedCommand !== command) {
        command = decision.updatedCommand
      }
    } else if (autoApproved) {
      executeCommandOutputChannel.appendLine(`[auto] Approved command: ${command}`)
    }

    command = command.trim()
    if (command.length === 0) {
      throw new Error('Command cannot be empty.')
    }

    // Terminal lifecycle and event wiring.
    const terminalInfo = await this.terminalManager.getOrCreateTerminal(customCwd || this.cwd, { forceNew: newTerminal })
    terminalInfo.terminal.show() // Ensures visibility; avoids known empty-space glitch on first open.
    const process = this.terminalManager.runCommand(terminalInfo, command)

    let collected = ''
    process.on('line', (line) => {
      collected += line + '\n'
    })

    let completed = false
    process.once('completed', () => {
      completed = true
    })

    process.once('no_shell_integration', async () => {
      await vscode.window.showWarningMessage(
        'Terminal shell integration is unavailable. Certain features may be limited.',
      )
    })

    if (background) {
      const terminalId: TerminalId = terminalInfo.id
      if (autoApproved) {
        executeCommandOutputChannel.appendLine(`[auto] Command started in background in terminal ${terminalId}: ${command}`)
      }
      return [
        false,
        formatResponse.toolResult(
          `Command started in background and continues in terminal (id: ${terminalId}). ` +
          `Use get_terminal_output later to retrieve ongoing output for this terminal.`,
        ),
      ]
    }

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(resolve, timeout)
    })

    // Wait for either process completion or timeout.
    await Promise.race([process, timeoutPromise])
    // Allow async output messages to flush and maintain ordering.
    await delay(50)

    const terminalId: TerminalId = terminalInfo.id
    const result = collected.trim()

    if (completed) {
      if (autoApproved) {
        executeCommandOutputChannel.appendLine(`[auto] Command completed in terminal ${terminalId}: ${command}`)
      }
      return [
        false,
        formatResponse.toolResult(
          `Command finished in terminal (id: ${terminalId}).${result ? `\nOutput:\n${result}` : ''}`,
        ),
      ]
    }

    const timeoutNote = timeout !== 300000 ? ` (waited ${timeout}ms)` : ''
    if (autoApproved) {
      executeCommandOutputChannel.appendLine(`[auto] Command still running in terminal ${terminalId}: ${command}`)
    }
    return [
      false,
      formatResponse.toolResult(
        `Command still running in terminal (id: ${terminalId})${timeoutNote}.${result ? `\nPartial output:\n${result}` : ''}` +
        '\n\nUse get_terminal_output to check for more output later.',
      ),
    ]
  }

  private async resolveApproval(
    command: string,
    customCwd: string | undefined,
    destructiveFlag: boolean,
    confirmationMode: ConfirmationMode,
  ): Promise<ApprovalDecision> {
    // Telegram approval is optional at runtime: when the bot or coordinator is
    // unavailable we deliberately fall back to the VS Code confirmation flow.
    const telegramAvailable = Boolean(sharedTelegramBotService?.isConnected() && sharedTelegramBotService.getMessageBridge())
    const routing = getApprovalRoutingPlan(confirmationMode, telegramAvailable)

    if (routing.warningMessage) {
      executeCommandOutputChannel.appendLine(`[routing] ${routing.warningMessage}`)
      void vscode.window.showWarningMessage(routing.warningMessage)
    }

    if (!routing.useTelegram) {
      return this.ask(command)
    }

    if (!sharedApprovalCoordinator) {
      executeCommandOutputChannel.appendLine('[routing] Approval coordinator unavailable. Falling back to VS Code confirmation.')
      return this.ask(command)
    }

    const request = sharedApprovalCoordinator.createRequest({
      command,
      destructive: destructiveFlag,
      customCwd: customCwd ?? null,
    })

    if (routing.useVscode) {
      // The local session can be completed either by direct VS Code interaction
      // or by an external Telegram resolution pushed back into the session.
      const session = ConfirmationUI.createCommandConfirmationSession(
        'Execute Command?',
        command,
        'Approve',
        'Deny',
      )
      sharedApprovalCoordinator.attachVscodeSession(request.approvalId, {
        applyExternalResolution: (resolution) => {
          session.applyExternalResolution({
            approved: resolution.approved,
            updatedCommand: resolution.updatedCommand,
            feedback: resolution.feedback,
            source: resolution.source,
          })
        },
      })
      void session.result.then((result) => {
        if (result.source !== 'vscode') {
          return
        }

        sharedApprovalCoordinator?.resolve(request.approvalId, {
          approved: result.decision === 'Approve',
          updatedCommand: result.command,
          feedback: result.feedback ?? null,
          source: 'vscode',
        })
      })
    }

    const bridge = sharedTelegramBotService?.getMessageBridge()
    if (!bridge) {
      executeCommandOutputChannel.appendLine('[routing] Telegram bridge unavailable. Falling back to VS Code confirmation.')
      return this.ask(command)
    }

    try {
      await bridge.sendApprovalRequest(request)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      executeCommandOutputChannel.appendLine(`[routing] Failed to send Telegram approval request: ${message}`)

      if (!routing.useVscode) {
        void vscode.window.showWarningMessage(`Telegram approval failed: ${message}. Falling back to VS Code confirmation.`)
        return this.ask(command)
      }
    }

    const resolution = await sharedApprovalCoordinator.waitForResolution(request.approvalId)
    if (resolution.approved) {
      return {
        approved: true,
        updatedCommand: resolution.updatedCommand ?? command,
      }
    }

    return {
      approved: false,
      feedback: resolution.feedback ?? undefined,
    }
  }

  protected async ask(command: string): Promise<ApprovalDecision> {
    // Ask user to approve/deny and allow editing when confirmation is required.
    const res = await ConfirmationUI.confirmCommandWithInputBox(
      'Execute Command?',
      command,
      'Approve',
      'Deny',
    )

    if (res.decision === 'Approve') {
      return { approved: true, updatedCommand: res.command }
    }
    return { approved: false, feedback: res.feedback }
  }
}

export async function executeCommandToolHandler(params: z.infer<typeof executeCommandSchema>) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    return {
      isError: true,
      content: [{ text: 'No workspace folder is open' }],
    }
  }

  const tool = new ExecuteCommandTool(workspaceRoot)
  try {
    const [userRejected, response] = await tool.execute(
      params.command,
      params.customCwd,
      params.destructiveFlag,
      params.background,
      params.timeout,
      params.newTerminal,
    )

    return {
      isError: userRejected,
      content: [{ text: response.text }],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // Preserve exact error format for Halt for Feedback declines.
    if (typeof message === 'string' && message.startsWith('Tool execution was declined by the user.')) {
      return {
        isError: true,
        content: [{ text: message }],
      }
    }

    return {
      isError: true,
      content: [{ text: `execute_command failed: ${message}` }],
    }
  }
}

export type ExecuteCommandInput = z.infer<typeof executeCommandSchema>

export class ExecuteCommandLanguageModelTool implements LanguageModelTool<ExecuteCommandInput> {
  async invoke(
    options: LanguageModelToolInvocationOptions<ExecuteCommandInput>,
    token: CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    statusBarActivity.start('execute_command')
    try {
      // Halt for Feedback gating: must happen before any confirmation UI and before terminal initialization.
      let state = haltForFeedbackController.getSnapshot()
      if (state.kind === 'paused') {
        state = await haltForFeedbackController.waitUntilNotPaused(token)
      }

      // Respect VS Code cancellation while waiting in paused state.
      if (token.isCancellationRequested) {
        throw new Error('This operation was aborted')
      }

      if (state.kind === 'declined') {
        haltForFeedbackController.takeDeclineAndReset()
        throw new Error('Tool execution was declined by the user. Feedback: ' + state.feedback)
      }

      const parseResult = await executeCommandSchema.safeParseAsync(options.input ?? {})

      if (!parseResult.success) {
        throw new Error(`execute_command invalid arguments: ${parseResult.error.message}`)
      }

      const result = await executeCommandToolHandler(parseResult.data)
      const messages = (result.content ?? [])
        .map((part) => ('text' in part ? part.text : undefined))
        .filter((text): text is string => typeof text === 'string' && text.length > 0)

      // Halt for Feedback gating (second checkpoint):
      // the command may have been running while the user paused/declined.
      // Gate right before returning/throwing the final tool result.
      let finalState = haltForFeedbackController.getSnapshot()
      if (finalState.kind === 'paused') {
        finalState = await haltForFeedbackController.waitUntilNotPaused(token)
      }

      if (token.isCancellationRequested) {
        throw new Error('This operation was aborted')
      }

      if (finalState.kind === 'declined') {
        haltForFeedbackController.takeDeclineAndReset()
        throw new Error('Tool execution was declined by the user. Feedback: ' + finalState.feedback)
      }

      if (result.isError) {
        const message = messages[0] ?? 'execute_command failed.'
        throw new Error(message)
      }

      const parts = (messages.length > 0 ? messages : ['Command executed.']).map(
        (text) => new vscode.LanguageModelTextPart(text),
      )

      return new vscode.LanguageModelToolResult(parts)
    } finally {
      statusBarActivity.end('execute_command')
    }
  }

  prepareInvocation(
    options: LanguageModelToolInvocationPrepareOptions<ExecuteCommandInput>,
  ): PreparedToolInvocation {
    const input = options.input ?? {}
    const command = typeof input.command === 'string' ? input.command : undefined
    const customCwd = typeof input.customCwd === 'string' ? input.customCwd : undefined
    // Only show this field when explicitly provided by the agent/model.
    const hasNewTerminal = Object.prototype.hasOwnProperty.call(input, 'newTerminal')
    const newTerminal = hasNewTerminal && typeof input.newTerminal === 'boolean' ? input.newTerminal : undefined
    const destructiveFlag = typeof input.destructiveFlag === 'boolean' ? input.destructiveFlag : undefined
    const background = typeof input.background === 'boolean' ? input.background : undefined
    const timeout = typeof (input as any).timeout === 'number' ? (input as any).timeout : undefined

    const md = new vscode.MarkdownString(undefined, true)
    md.supportHtml = true
    md.isTrusted = true
    const showPauseButton = vscode.workspace
      .getConfiguration('reliefpilot')
      .get<boolean>('showPauseButtonInChat', true)

    // Markdown rendering helpers (English-only comments per repo convention).
    const inlineCode = (value: string): string => {
      const tickRuns = value.match(/`+/g) ?? []
      const maxTicks = tickRuns.reduce((m, run) => Math.max(m, run.length), 0)
      const fence = '`'.repeat(Math.max(1, maxTicks + 1))
      // Inline code cannot contain newlines reliably; fall back to a fenced block upstream for multiline values.
      const content = value.startsWith(' ') || value.endsWith(' ') ? ` ${value} ` : value
      return `${fence}${content}${fence}`
    }

    const fencedCodeBlock = (code: string, language: string): string => {
      const tickRuns = code.match(/`+/g) ?? []
      const maxTicks = tickRuns.reduce((m, run) => Math.max(m, run.length), 0)
      const fence = '`'.repeat(Math.max(3, maxTicks + 1))
      // Ensure trailing newline for consistent rendering in VS Code markdown.
      const normalized = code.endsWith('\n') ? code : code + '\n'
      return `${fence}${language}\n${normalized}${fence}\n`
    }

    const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
    md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
    md.appendMarkdown(`Relief Pilot · **execute_command**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}\n`)

    if (command) {
      md.appendMarkdown(`\n\n`)
      md.appendMarkdown(fencedCodeBlock(command, 'sh'))
    }

    // Keep remaining fields compact; these are single-line values.
    if (customCwd) md.appendMarkdown(`- CWD: ${inlineCode(customCwd)}  \n`)
    if (typeof newTerminal === 'boolean') md.appendMarkdown(`- New terminal: ${inlineCode(String(newTerminal))}  \n`)
    if (typeof destructiveFlag === 'boolean') md.appendMarkdown(`- Destructive: ${inlineCode(String(destructiveFlag))}  \n`)
    if (typeof background === 'boolean') md.appendMarkdown(`- Background: ${inlineCode(String(background))}  \n`)
    if (typeof timeout === 'number') md.appendMarkdown(`- Timeout: ${inlineCode(`${timeout}ms`)}  \n`)

    return { invocationMessage: md }
  }
}
