import type {
    CancellationToken,
    LanguageModelTool,
    LanguageModelToolInvocationOptions,
    LanguageModelToolInvocationPrepareOptions,
    PreparedToolInvocation,
} from 'vscode';
import * as vscode from 'vscode';
import {
    DiagnosticSeverity,
    LanguageModelTextPart,
    LanguageModelToolResult,
    languages,
} from 'vscode';
import { env } from '../utils/env';
import { haltForFeedbackController } from '../utils/haltForFeedbackController';
import { statusBarActivity } from '../utils/statusBar';

export type CodeCheckerInput = {
    severityLevel?: 'Error' | 'Warning' | 'Information' | 'Hint';
};

/**
 * Narrow string label for VS Code DiagnosticSeverity enum.
 */
export type SeverityLabel = 'Error' | 'Warning' | 'Information' | 'Hint';

/**
 * Map DiagnosticSeverity enum to human-readable labels.
 * Kept as a frozen object for immutability and better type-safety.
 */
const severityLabels: Record<DiagnosticSeverity, SeverityLabel> = Object.freeze({
    [DiagnosticSeverity.Error]: 'Error',
    [DiagnosticSeverity.Warning]: 'Warning',
    [DiagnosticSeverity.Information]: 'Information',
    [DiagnosticSeverity.Hint]: 'Hint',
});

const severityFromInput = (
    raw?: CodeCheckerInput['severityLevel'],
): DiagnosticSeverity => {
    switch (raw) {
        case 'Error':
            return DiagnosticSeverity.Error;
        case 'Information':
            return DiagnosticSeverity.Information;
        case 'Hint':
            return DiagnosticSeverity.Hint;
        case 'Warning':
        default:
            return DiagnosticSeverity.Warning;
    }
};

/**
 * A minimal, stable diagnostic report payload per file.
 * Intentionally limited to fields required by callers to preserve wire-compatibility.
 */
export type DiagnosticReport = {
    file: string;
    diagnostics: Array<{
        severity: SeverityLabel;
        message: string;
        source: string;
    }>;
};

/**
 * Collect diagnostics across the workspace filtered by the minimum severity.
 * Returns a stable, JSON-safe structure suitable for tool output.
 */
export const collectDiagnostics = (
    severityLevel: DiagnosticSeverity = DiagnosticSeverity.Warning,
): DiagnosticReport[] => {
    const diagnosticsByFile = languages.getDiagnostics();

    const reports: DiagnosticReport[] = [];
    for (const [uri, diags] of diagnosticsByFile) {
        // Keep only diagnostics meeting the minimum severity (Error=0 is most severe)
        const filtered = diags.filter((d) => d.severity <= severityLevel);
        if (filtered.length === 0) continue;

        const items = filtered.map((d) => ({
            severity: severityLabels[d.severity],
            message: d.message,
            source: d.source ?? '',
        }));

        // Optional: stable order (by severity then message) for deterministic output
        items.sort((a, b) => {
            // Map label back to enum order for consistent severity ordering
            const order = {
                Error: DiagnosticSeverity.Error,
                Warning: DiagnosticSeverity.Warning,
                Information: DiagnosticSeverity.Information,
                Hint: DiagnosticSeverity.Hint,
            } as const;
            const sevDiff = order[a.severity] - order[b.severity];
            return sevDiff !== 0 ? sevDiff : a.message.localeCompare(b.message);
        });

        reports.push({ file: uri.fsPath, diagnostics: items });
    }

    // Stable file ordering for reproducible JSON
    reports.sort((a, b) => a.file.localeCompare(b.file));
    return reports;
};

/**
 * VS Code Language Model tool that reports current diagnostics as JSON.
 */
export class CodeCheckerLanguageModelTool
    implements LanguageModelTool<CodeCheckerInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<CodeCheckerInput>,
        token: CancellationToken,
    ): Promise<LanguageModelToolResult> {
        statusBarActivity.start('code_checker');
        try {
            // Halt for Feedback integration: gate before reading diagnostics.
            let state = haltForFeedbackController.getSnapshot();
            if (state.kind === 'paused') {
                state = await haltForFeedbackController.waitUntilNotPaused(token);
                // Respect VS Code cancellation while waiting in paused state.
                if (token.isCancellationRequested) {
                    // Keep current tool contract on cancellation.
                    throw new Error('This operation was aborted');
                }
            }

            if (state.kind === 'declined') {
                haltForFeedbackController.takeDeclineAndReset();
                throw new Error(
                    'Tool execution was declined by the user. Feedback: ' +
                        state.feedback,
                );
            }

            const minSeverity = severityFromInput(options.input?.severityLevel);
            const reports = collectDiagnostics(minSeverity);

            if (reports.length === 0) {
                return new LanguageModelToolResult([
                    new LanguageModelTextPart('No issues found.'),
                ]);
            }

            const payload = JSON.stringify(reports, null, 2);
            return new LanguageModelToolResult([
                new LanguageModelTextPart(payload),
            ]);
        } finally {
            statusBarActivity.end('code_checker');
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<CodeCheckerInput>,
    ): PreparedToolInvocation {
        const severity = severityFromInput(options.input?.severityLevel);
        const label = severityLabels[severity];
        const md = new vscode.MarkdownString(undefined, true);
        md.supportHtml = true;
        md.isTrusted = true;
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true);
        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png');
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `);
        md.appendMarkdown(`Relief Pilot · **code_checker**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`);
        md.appendMarkdown(`• Severity: \`${label}\`  \n`);
        return { invocationMessage: md };
    }
}
