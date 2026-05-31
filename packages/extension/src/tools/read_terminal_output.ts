import type {
    CancellationToken,
    LanguageModelTool,
    LanguageModelToolInvocationOptions,
    LanguageModelToolInvocationPrepareOptions,
    PreparedToolInvocation,
} from "vscode";
import * as vscode from "vscode";
import { z } from "zod";
import { stripAnsi } from "../integrations/terminal/ansiUtils.js";
import { TerminalRegistry } from "../integrations/terminal/TerminalRegistry";
import { env } from "../utils/env";
import { haltForFeedbackController } from "../utils/haltForFeedbackController";
import { formatResponse, ToolResponse } from "../utils/response";
import { statusBarActivity } from "../utils/statusBar";

// Schema kept string-only for model/tool compatibility. We validate numeric content via regex.
export const getTerminalOutputSchema = z.object({
  terminalId: z
    .string()
    .regex(/^\d+$/, { message: "terminalId must be a numeric string (e.g., '1')." })
    .describe("The ID of the terminal to get output from (provide as a string, e.g., \"1\")."),
  maxLines: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1000)
    .describe("Maximum number of lines to retrieve (default: 1000)"),
})

/**
 * Normalize and validate numeric terminal id.
 * Accepts string or number, returns a finite positive integer or undefined if invalid.
 */
function coerceTerminalId(input: string | number): number | undefined {
  if (typeof input === "number") {
    return Number.isInteger(input) && input >= 0 ? input : undefined
  }
  // Ensure pure digits to avoid parseInt quirks like parseInt('1x') === 1
  if (!/^\d+$/.test(input)) return undefined
  const n = Number(input)
  return Number.isFinite(n) ? n : undefined
}

/** Ensure maxLines is a sane, positive integer. */
function normalizeMaxLines(value: unknown, fallback = 1000): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.max(1, Math.min(100_000, Math.trunc(n)))
  return i
}

/** Keep only the last N lines from the content. */
function limitLines(content: string, maxLines: number): string {
  const lines = content.split("\n")
  if (lines.length <= maxLines) return content
  return lines.slice(-maxLines).join("\n")
}

/**
 * Build a user-friendly summary message for the tool result.
 */
function buildTerminalOutputMessage(
  terminalId: number,
  terminalInfo: { busy?: boolean; lastCommand?: string | undefined },
  terminalContents: string,
): string {
  const state = terminalInfo.busy ? "busy" : "idle"
  const last = terminalInfo.lastCommand ? `, last command: "${terminalInfo.lastCommand}"` : ""
  return `Terminal ${terminalId} output (${state})${last}:\n\n${terminalContents}`
}

export class ReadTerminalOutputTool {
  /**
   * Capture output from a VS Code terminal registered in TerminalRegistry.
   * Note: terminalId can be a numeric string (preferred) or number.
   */
  async execute(
    terminalId: string | number,
    maxLines: number = 1000,
    token?: CancellationToken,
  ): Promise<ToolResponse> {
    const id = coerceTerminalId(terminalId)
    if (id === undefined) {
      return formatResponse.toolResult(
        `Invalid terminal ID: ${terminalId}. Please provide a valid numeric ID (e.g., "1").`,
      )
    }

    const limit = normalizeMaxLines(maxLines)

    // Get terminal from registry
    const terminalInfo = TerminalRegistry.getTerminal(id)
    if (!terminalInfo) {
      return formatResponse.toolResult(`Terminal with ID ${id} not found or has been closed.`)
    }

    if (token?.isCancellationRequested) {
      return formatResponse.toolResult("Operation cancelled.")
    }

    try {
      // Focus the terminal to ensure selectAll targets the right instance
      terminalInfo.terminal.show()

      // Store original clipboard content to restore later
      const originalClipboard = await vscode.env.clipboard.readText()

      try {
        if (token?.isCancellationRequested) {
          return formatResponse.toolResult("Operation cancelled.")
        }

        // Select terminal content and copy
        await vscode.commands.executeCommand("workbench.action.terminal.selectAll")
        await vscode.commands.executeCommand("workbench.action.terminal.copySelection")
        await vscode.commands.executeCommand("workbench.action.terminal.clearSelection")

        // Read terminal contents from clipboard
        let terminalContents = (await vscode.env.clipboard.readText()).trim()

        // If clipboard hasn't changed, likely no content selected
        if (terminalContents === originalClipboard.trim()) {
          return formatResponse.toolResult(`No content found in terminal ${id}.`)
        }

        // Remove ANSI escape sequences and limit the output
        terminalContents = limitLines(stripAnsi(terminalContents), limit)

        return formatResponse.toolResult(
          buildTerminalOutputMessage(id, terminalInfo, terminalContents),
        )
      } finally {
        // Restore original clipboard content regardless of outcome
        await vscode.env.clipboard.writeText(originalClipboard)
      }
    } catch (error) {
      console.error(`Error retrieving terminal output:`, error)
      return formatResponse.toolResult(
        `Error retrieving output from terminal ${id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

export async function getTerminalOutputToolHandler(
  params: z.infer<typeof getTerminalOutputSchema>,
  token?: CancellationToken,
) {
  const tool = new ReadTerminalOutputTool()
  const response = await tool.execute(params.terminalId, params.maxLines, token)

  return {
    isError: false,
    content: [{ text: response.text }],
  }
}

export type GetTerminalOutputInput = z.infer<typeof getTerminalOutputSchema>

export class GetTerminalOutputLanguageModelTool implements LanguageModelTool<GetTerminalOutputInput> {
  async invoke(
    options: LanguageModelToolInvocationOptions<GetTerminalOutputInput>,
    token: CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    statusBarActivity.start('read_terminal_output')
    try {
      // Halt for Feedback gating: must happen before any terminal focus/clipboard/commands.
      let state = haltForFeedbackController.getSnapshot()
      if (state.kind === 'paused') {
        state = await haltForFeedbackController.waitUntilNotPaused(token)
      }

      // Keep current tool contract on cancellation.
      if (token.isCancellationRequested) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart("Operation cancelled."),
        ])
      }

      if (state.kind === 'declined') {
        haltForFeedbackController.takeDeclineAndReset()
        throw new Error('Tool execution was declined by the user. Feedback: ' + state.feedback)
      }

      const parseResult = await getTerminalOutputSchema.safeParseAsync(options.input ?? {})

      if (!parseResult.success) {
        throw new Error(`read_terminal_output invalid arguments: ${parseResult.error.message}`)
      }

      const result = await getTerminalOutputToolHandler(parseResult.data, token)
      const messages = (result.content ?? [])
        .map((part) => ("text" in part ? part.text : undefined))
        .filter((text): text is string => typeof text === "string" && text.length > 0)

      const parts = (messages.length > 0 ? messages : ["No terminal output retrieved."]).map(
        (text) => new vscode.LanguageModelTextPart(text),
      )

      return new vscode.LanguageModelToolResult(parts)
    } finally {
      statusBarActivity.end('read_terminal_output')
    }
  }

  prepareInvocation(
    options: LanguageModelToolInvocationPrepareOptions<GetTerminalOutputInput>,
  ): PreparedToolInvocation {
    const input = options.input ?? {}
    const terminalId = typeof input.terminalId === "string" ? input.terminalId : undefined
    const maxLines = typeof input.maxLines === "number" ? input.maxLines : undefined

    const md = new vscode.MarkdownString(undefined, true)
    md.supportHtml = true
    md.isTrusted = true
    const showPauseButton = vscode.workspace
      .getConfiguration('reliefpilot')
      .get<boolean>('showPauseButtonInChat', true)

    const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
    md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
    md.appendMarkdown(`Relief Pilot · **read_terminal_output**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
    if (terminalId) md.appendMarkdown(`• Terminal: \`${terminalId}\`  \n`)
    if (typeof maxLines === "number") md.appendMarkdown(`• Max lines: \`${maxLines}\`  \n`)

    return { invocationMessage: md }
  }
}
