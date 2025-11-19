import type {
  CancellationToken,
  LanguageModelTool,
  LanguageModelToolInvocationOptions,
  LanguageModelToolInvocationPrepareOptions,
  PreparedToolInvocation,
} from "vscode"
import * as vscode from "vscode"
import { z } from "zod"
import { TerminalManager } from "../integrations/terminal/TerminalManager"
import { ConfirmationUI } from "../utils/confirmation_ui"
import { env } from "../utils/env"
import { formatResponse, ToolResponse } from "../utils/response"
import { statusBarActivity } from "../utils/statusBar"
import { delay } from "../utils/time.js"

// Local type aliases for stricter typing and clearer intent
type TerminalId = number

interface ApprovalDecision {
  approved: boolean
  updatedCommand?: string
  feedback?: string
}

export const executeCommandSchema = z.object({
  // Shell command to run
  command: z.string().describe("Command to execute in an integrated terminal"),
  // Optional override for CWD
  customCwd: z.string().optional().describe("Working directory to run the command in (defaults to workspace root)"),
  // Destructive/read-only hint controls confirmation UI
  destructiveFlag: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Marks the command as potentially modifying state. Keep true for commands that can change files/system. Set to false for read-only commands (e.g., grep, find, ls)."
    ),
  // Background mode returns immediately after starting the command
  background: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, start the command and return immediately without waiting for completion. Prefer background=true or set a timeout for long-running commands (servers, pagers, etc.)."
    ),
  // Reporting timeout used only to stop waiting (does not kill the process)
  timeout: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(300000)
    .describe(
      "Milliseconds to wait before reporting intermediate output when not in background. This does not terminate the process."
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
    timeout: number = 300000
  ): Promise<[userRejected: boolean, ToolResponse]> {
    // Read extension setting that optionally forces confirmation for read-only commands
    const confirmNonDestructiveCommands = vscode.workspace
      .getConfiguration("reliefpilot")
      .get<boolean>("confirmNonDestructiveCommands", false)

    const shouldConfirm = destructiveFlag || confirmNonDestructiveCommands

    // Ask user to approve/deny and allow editing when confirmation is required
    if (shouldConfirm) {
      const decision = await this.ask(command)
      if (!decision.approved) {
        const note = decision.feedback ? ` Feedback: ${decision.feedback}` : ""
        return [true, formatResponse.toolResult(`Command execution was declined by the user.${note}`)]
      }
      if (decision.updatedCommand && decision.updatedCommand !== command) {
        command = decision.updatedCommand
      }
    } else {
      // Non-destructive path with confirmation disabled
      console.log(`Executing read-only command without confirmation: ${command}`)
    }

    // Basic input validation after potential edits
    command = command.trim()
    if (command.length === 0) {
      throw new Error("Command cannot be empty.")
    }

    // Terminal lifecycle and event wiring
    const terminalInfo = await this.terminalManager.getOrCreateTerminal(customCwd || this.cwd)
    terminalInfo.terminal.show() // Ensures visibility; avoids known empty-space glitch on first open
    const process = this.terminalManager.runCommand(terminalInfo, command)

    let collected = ""
    process.on("line", (line) => {
      collected += line + "\n"
    })

    let completed = false
    process.once("completed", () => {
      completed = true
    })

    process.once("no_shell_integration", async () => {
      await vscode.window.showWarningMessage(
        "Terminal shell integration is unavailable. Certain features may be limited."
      )
    })

    // Background: return as soon as the command is started
    if (background) {
      const terminalId: TerminalId = terminalInfo.id
      return [
        false,
        formatResponse.toolResult(
          `Command started in background and continues in terminal (id: ${terminalId}). ` +
          `Use get_terminal_output later to retrieve ongoing output for this terminal.`
        ),
      ]
    }

    // Create a promise that resolves after the timeout (does not terminate the process)
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(resolve, timeout)
    })

    // Wait for either process completion or timeout
    await Promise.race([process, timeoutPromise])

    // Allow async output messages to flush and maintain ordering
    await delay(50)

    const terminalId: TerminalId = terminalInfo.id
    const result = collected.trim()

    if (completed) {
      return [
        false,
        formatResponse.toolResult(
          `Command finished in terminal (id: ${terminalId}).${result ? `\nOutput:\n${result}` : ""}`
        ),
      ]
    }

    const timeoutNote = timeout !== 300000 ? ` (waited ${timeout}ms)` : ""
    return [
      false,
      formatResponse.toolResult(
        `Command still running in terminal (id: ${terminalId})${timeoutNote}.${result ? `\nPartial output:\n${result}` : ""
        }\n\nUse get_terminal_output to check for more output later.`
      ),
    ]
  }

  protected async ask(command: string): Promise<ApprovalDecision> {
    const res = await ConfirmationUI.confirmCommandWithInputBox(
      "Execute Command?",
      command,
      "Approve",
      "Deny",
    )

    if (res.decision === "Approve") {
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
      content: [{ text: "No workspace folder is open" }],
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
    )

    return {
      isError: userRejected,
      content: [{ text: response.text }],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
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
    _token: CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    // Indicate activity in the status bar while this tool runs
    statusBarActivity.start('execute_command')
    try {
      const parseResult = await executeCommandSchema.safeParseAsync(options.input ?? {})

      if (!parseResult.success) {
        throw new Error(`execute_command invalid arguments: ${parseResult.error.message}`)
      }

      const result = await executeCommandToolHandler(parseResult.data)
      const messages = (result.content ?? [])
        .map((part) => ("text" in part ? part.text : undefined))
        .filter((text): text is string => typeof text === "string" && text.length > 0)

      if (result.isError) {
        const message = messages[0] ?? "execute_command failed."
        throw new Error(message)
      }

      const parts = (messages.length > 0 ? messages : ["Command executed."]).map(
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
    const command = typeof input.command === "string" ? input.command : undefined
    const customCwd = typeof input.customCwd === "string" ? input.customCwd : undefined
    const destructiveFlag = typeof input.destructiveFlag === "boolean" ? input.destructiveFlag : undefined
    const background = typeof input.background === "boolean" ? input.background : undefined
    const timeout = typeof (input as any).timeout === "number" ? (input as any).timeout : undefined

    const md = new vscode.MarkdownString(undefined, true)
    md.supportHtml = true
    md.isTrusted = true

    const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
    md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
    md.appendMarkdown(`Relief Pilot · **execute_command**\n`)
    if (command) md.appendMarkdown(`- Command: \`${command}\`  \n`)
    if (customCwd) md.appendMarkdown(`- CWD: \`${customCwd}\`  \n`)
    if (typeof destructiveFlag === "boolean") md.appendMarkdown(`- Destructive: \`${destructiveFlag}\`  \n`)
    if (typeof background === "boolean") md.appendMarkdown(`- Background: \`${background}\`  \n`)
    if (typeof timeout === "number") md.appendMarkdown(`- Timeout: \`${timeout}ms\`  \n`)

    return { invocationMessage: md }
  }
}
