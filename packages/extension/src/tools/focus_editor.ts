import type {
    CancellationToken,
    LanguageModelTool,
    LanguageModelToolInvocationOptions,
    LanguageModelToolInvocationPrepareOptions,
    PreparedToolInvocation,
} from 'vscode'
import * as vscode from 'vscode'
import { z } from 'zod'
import { env } from '../utils/env'
import { haltForFeedbackController } from '../utils/haltForFeedbackController'
import { statusBarActivity } from '../utils/statusBar'

// Zod schema consistent with other tools
export const focusEditorSchema = z.object({
    filePath: z.string().describe('The absolute path to the file to focus in the editor.'),
    // NOTE: Coordinates are provided as displayed to users. Values <= 0 will be treated as 1 (converted internally to 0-based for VS Code).
    line: z
        .number()
        .int()
        .optional()
        .default(1)
        .describe('Line number to navigate to (minimum: 1, default: 1).'),
    column: z
        .number()
        .int()
        .optional()
        .default(1)
        .describe('Column position to navigate to (minimum: 1, default: 1).'),
    startLine: z
        .number()
        .int()
        .optional()
        .describe('Starting line number for highlighting (minimum: 1).'),
    startColumn: z
        .number()
        .int()
        .optional()
        .describe('Starting column number for highlighting (minimum: 1).'),
    endLine: z
        .number()
        .int()
        .optional()
        .describe('Ending line number for highlighting (minimum: 1).'),
    endColumn: z
        .number()
        .int()
        .optional()
        .describe('Ending column number for highlighting (minimum: 1).'),
})

// Common tool handler result shape used by Relief Pilot tools
type ToolHandlerResult = {
    isError: boolean
    content: Array<{ text: string }>
}

/**
 * Encapsulates the logic to focus a file in the editor and optionally highlight a range.
 * This class is intentionally small and stateless to keep execution predictable and testable.
 */
class FocusEditorTool {
    /**
     * Focuses the VS Code editor on a file and either selects a range or moves the caret.
     * Returns a human-readable message about the action performed.
     */
    async execute(params: z.infer<typeof focusEditorSchema>): Promise<string> {
        const { filePath, line = 1, column = 1, startLine, startColumn, endLine, endColumn } = params

        // Open and show the document in an editor
        const uri = vscode.Uri.file(filePath)
        const document = await vscode.workspace.openTextDocument(uri)
        const editor = await vscode.window.showTextDocument(document)

        // Highlight range if all range parameters are provided and not all zeros
        const hasFullRange =
            typeof startLine === 'number' &&
            typeof startColumn === 'number' &&
            typeof endLine === 'number' &&
            typeof endColumn === 'number'

        if (hasFullRange) {
            // Convert 1-based inputs to 0-based VS Code positions
            const sLine = Math.max(0, Math.max(1, startLine) - 1)
            const sCol = Math.max(0, Math.max(1, startColumn) - 1)
            const eLine = Math.max(0, Math.max(1, endLine) - 1)
            const eCol = Math.max(0, Math.max(1, endColumn) - 1)

            const start = new vscode.Position(sLine, sCol)
            const end = new vscode.Position(eLine, eCol)
            editor.selection = new vscode.Selection(start, end)
            editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter)
            return `Focused file: ${filePath} with highlighted range from line ${startLine}, column ${startColumn} to line ${endLine}, column ${endColumn}`
        }

        // Move the cursor to the specified position
        // If a partial "start" position was provided (e.g., only startColumn),
        // treat it as a synonym for the single caret position when no full range is present.
        const posLine1Based = Math.max(1, typeof startLine === 'number' ? startLine : line)
        const posCol1Based = Math.max(1, typeof startColumn === 'number' ? startColumn : column)

        // Convert 1-based inputs to 0-based VS Code positions
        const zLine = Math.max(0, posLine1Based - 1)
        const zCol = Math.max(0, posCol1Based - 1)
        const position = new vscode.Position(zLine, zCol)
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter)
        editor.selection = new vscode.Selection(position, position)
        return `Focused file: ${filePath} at line ${posLine1Based}, column ${posCol1Based}`
    }
}

// Public handler with unified return shape
export async function focusEditorToolHandler(params: z.infer<typeof focusEditorSchema>): Promise<ToolHandlerResult> {
    try {
        const tool = new FocusEditorTool()
        const message = await tool.execute(params)
        return { isError: false, content: [{ text: message }] }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { isError: true, content: [{ text: `Failed to focus editor: ${msg}` }] }
    }
}

export type FocusEditorInput = z.infer<typeof focusEditorSchema>;

export class FocusEditorLanguageModelTool implements LanguageModelTool<FocusEditorInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<FocusEditorInput>,
        token: CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        statusBarActivity.start('focus_editor')
        try {
            // Halt for Feedback integration: gate before any editor focus/open actions.
            let state = haltForFeedbackController.getSnapshot()
            if (state.kind === 'paused') {
                state = await haltForFeedbackController.waitUntilNotPaused(token)
                // Respect VS Code cancellation while waiting in paused state.
                if (token.isCancellationRequested) {
                    // Keep current tool contract on cancellation.
                    throw new Error('This operation was aborted')
                }
            }

            if (state.kind === 'declined') {
                haltForFeedbackController.takeDeclineAndReset()
                throw new Error('Tool execution was declined by the user. Feedback: ' + state.feedback)
            }

            const parseResult = await focusEditorSchema.safeParseAsync(
                options.input ?? {},
            )

            if (!parseResult.success) {
                throw new Error(
                    `focus_editor invalid arguments: ${parseResult.error.message}`,
                )
            }

            const result = await focusEditorToolHandler(parseResult.data)
            const messages = (result.content ?? [])
                .map((item) => ('text' in item ? item.text : undefined))
                .filter((text): text is string => typeof text === 'string' && text.length > 0)

            if (result.isError) {
                const message = messages[0] ?? 'focus_editor failed.'
                throw new Error(message)
            }

            const parts = (messages.length > 0 ? messages : ['Focused editor.'])
                .map((text) => new vscode.LanguageModelTextPart(text))

            return new vscode.LanguageModelToolResult(parts)
        } finally {
            statusBarActivity.end('focus_editor')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<FocusEditorInput>,
    ): PreparedToolInvocation {
        const input = options.input ?? {}
        const filePath = typeof input.filePath === 'string' ? input.filePath : undefined
        const line = typeof input.line === 'number' ? input.line : undefined
        const column = typeof input.column === 'number' ? input.column : undefined
        const startLine = typeof input.startLine === 'number' ? input.startLine : undefined
        const startColumn = typeof input.startColumn === 'number' ? input.startColumn : undefined
        const endLine = typeof input.endLine === 'number' ? input.endLine : undefined
        const endColumn = typeof input.endColumn === 'number' ? input.endColumn : undefined

        const hasRange =
            startLine !== undefined &&
            startColumn !== undefined &&
            endLine !== undefined &&
            endColumn !== undefined

        const displayPath = filePath
            ? vscode.workspace.asRelativePath(filePath, false) || filePath
            : undefined

        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)

        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **focus_editor**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        if (displayPath) md.appendMarkdown(`• File: \`${displayPath}\`  \n`)
        if (hasRange) {
            const sLn = Math.max(1, startLine!)
            const sCol = Math.max(1, startColumn!)
            const eLn = Math.max(1, endLine!)
            const eCol = Math.max(1, endColumn!)
            md.appendMarkdown(`• Range: \`${sLn}:${sCol}-${eLn}:${eCol}\`  \n`)
        } else {
            const rawLn = line ?? startLine ?? 1
            const rawCol = column ?? startColumn ?? 1
            const ln = Math.max(1, rawLn)
            const col = Math.max(1, rawCol)
            md.appendMarkdown(`• Cursor: \`${ln}:${col}\`  \n`)
        }

        return { invocationMessage: md }
    }
}
