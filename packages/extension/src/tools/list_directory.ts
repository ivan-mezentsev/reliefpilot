import * as path from 'node:path';
import type {
    CancellationToken,
    LanguageModelTool,
    LanguageModelToolInvocationOptions,
    LanguageModelToolInvocationPrepareOptions,
    PreparedToolInvocation,
} from 'vscode';
import * as vscode from 'vscode';
import { env } from '../utils/env';
import { haltForFeedbackController } from '../utils/haltForFeedbackController';
import { statusBarActivity } from '../utils/statusBar';
import { isUriInsideWorkspaceFolders } from './read_file';

export interface ListDirectoryInput {
	path: string;
}

export interface ListDirectoryResponse {
	text: string;
	path: string;
	entries: string[];
}

const uriSchemeRegexp = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const windowsDriveLetterRegexp = /^[a-zA-Z]:[\\/]/;
const copilotSessionResourcePathRegexp = /(?:^|[\\/])workspaceStorage[\\/][^\\/]+[\\/]GitHub\.copilot-chat[\\/]chat-session-resources(?:[\\/]|$)/i;

function looksLikeUri(raw: string): boolean {
	return uriSchemeRegexp.test(raw) && !windowsDriveLetterRegexp.test(raw);
}

function pathExistsError(error: unknown): boolean {
	const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
	return code === 'FileNotFound' || code === 'ENOENT';
}

function escapeInlineCode(text: string): string {
	return text.replace(/`/g, '\\`');
}

function escapeMarkdownLinkText(text: string): string {
	return text.replace(/([\\\[\]])/g, '\\$1');
}

function toDisplayPath(uri: vscode.Uri): string {
	return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

function formatUriForFileWidget(uri: vscode.Uri, linkText: string): string {
	const uriWithQuery = uri.with({ query: 'vscodeLinkType=skill' });
	return `[${escapeMarkdownLinkText(linkText)}](${uriWithQuery.toString()})`;
}

function tryParseDirectUri(rawPath: string): vscode.Uri | undefined {
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	if (looksLikeUri(trimmed)) {
		return vscode.Uri.parse(trimmed, true);
	}

	if (path.isAbsolute(trimmed)) {
		return vscode.Uri.file(path.normalize(trimmed));
	}

	return undefined;
}

function isCopilotSessionResourceUri(uri: vscode.Uri): boolean {
	if (uri.scheme !== 'file') {
		return false;
	}

	return copilotSessionResourcePathRegexp.test(uri.fsPath);
}

function relativePathMayEscapeWorkspace(rawPath: string): boolean {
	const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
	return normalized === '..' || normalized.startsWith('../');
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch (error) {
		if (pathExistsError(error)) {
			return false;
		}
		throw error;
	}
}

async function resolveRelativePathInWorkspace(rawPath: string): Promise<vscode.Uri> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		throw new Error('Relative paths require an open workspace. Use an absolute path or a file URI instead.');
	}

	const trimmed = rawPath.trim();
	if (workspaceFolders.length === 1) {
		const folder = workspaceFolders[0];
		if (folder.uri.scheme === 'file') {
			return vscode.Uri.file(path.resolve(folder.uri.fsPath, trimmed));
		}

		return vscode.Uri.joinPath(folder.uri, ...trimmed.split(/[\\/]+/).filter(Boolean));
	}

	const candidates = workspaceFolders.map((folder) => {
		if (folder.uri.scheme === 'file') {
			return vscode.Uri.file(path.resolve(folder.uri.fsPath, trimmed));
		}

		return vscode.Uri.joinPath(folder.uri, ...trimmed.split(/[\\/]+/).filter(Boolean));
	});

	const existingCandidates: vscode.Uri[] = [];
	for (const candidate of candidates) {
		if (await pathExists(candidate)) {
			existingCandidates.push(candidate);
		}
	}

	const uniqueCandidates = Array.from(new Map(existingCandidates.map((candidate) => [candidate.toString(), candidate])).values());
	if (uniqueCandidates.length === 1) {
		return uniqueCandidates[0];
	}

	if (uniqueCandidates.length > 1) {
		throw new Error(`Relative path is ambiguous in a multi-root workspace: ${trimmed}. Use an absolute path or a file URI instead.`);
	}

	throw new Error(`Relative path was not found in the current workspace folders: ${trimmed}`);
}

async function resolveListDirectoryUri(rawPath: string): Promise<vscode.Uri> {
	const directUri = tryParseDirectUri(rawPath);
	if (directUri) {
		return directUri;
	}

	return resolveRelativePathInWorkspace(rawPath);
}

function tryResolvePathForInvocation(rawPath: string): vscode.Uri | undefined {
	const directUri = tryParseDirectUri(rawPath);
	if (directUri) {
		return directUri;
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length !== 1) {
		return undefined;
	}

	const [folder] = workspaceFolders;
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	if (folder.uri.scheme === 'file') {
		return vscode.Uri.file(path.resolve(folder.uri.fsPath, trimmed));
	}

	return vscode.Uri.joinPath(folder.uri, ...trimmed.split(/[\\/]+/).filter(Boolean));
}

function formatDirectoryEntry(name: string, type: vscode.FileType): string {
	return `${name}${type === vscode.FileType.Directory ? '/' : ''}`;
}

function buildOutsideWorkspaceConfirmation(rawPath: string): vscode.LanguageModelToolConfirmationMessages | undefined {
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	const directUri = tryParseDirectUri(trimmed);
	const shouldConfirm = directUri
		? directUri.scheme === 'file' && !isUriInsideWorkspaceFolders(directUri) && !isCopilotSessionResourceUri(directUri)
		: relativePathMayEscapeWorkspace(trimmed);

	if (!shouldConfirm) {
		return undefined;
	}

	const escapedPath = escapeInlineCode(trimmed);
	const message = new vscode.MarkdownString(
		`Allow **rp_list_directory** to read \`${escapedPath}\`? This path is outside the current workspace or may resolve outside it.`,
		true,
	);
	message.supportHtml = false;
	message.isTrusted = false;

	return {
		title: 'Read Directory Outside Workspace',
		message,
	};
}

export class ListDirectoryTool {
	async execute(input: ListDirectoryInput): Promise<ListDirectoryResponse> {
		if (!input || typeof input.path !== 'string' || input.path.trim().length === 0) {
			throw new Error('path must be a non-empty string.');
		}

		const uri = await resolveListDirectoryUri(input.path);
		const entries = (await vscode.workspace.fs.readDirectory(uri)).map(([name, type]) => formatDirectoryEntry(name, type));
		const text = entries.length === 0 ? 'Folder is empty' : entries.join('\n');
		return {
			text,
			path: toDisplayPath(uri),
			entries,
		};
	}
}

export class ListDirectoryLanguageModelTool implements LanguageModelTool<ListDirectoryInput> {
	async invoke(
		options: LanguageModelToolInvocationOptions<ListDirectoryInput>,
		token: CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		statusBarActivity.start('rp_list_directory');
		try {
			let state = haltForFeedbackController.getSnapshot();
			if (state.kind === 'paused') {
				state = await haltForFeedbackController.waitUntilNotPaused(token);
			}

			if (token.isCancellationRequested) {
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart('Operation cancelled.'),
				]);
			}

			if (state.kind === 'declined') {
				haltForFeedbackController.takeDeclineAndReset();
				throw new Error('Tool execution was declined by the user. Feedback: ' + state.feedback);
			}

			const tool = new ListDirectoryTool();
			const response = await tool.execute(options.input);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(response.text),
			]);
		} finally {
			statusBarActivity.end('rp_list_directory');
		}
	}

	prepareInvocation(
		options: LanguageModelToolInvocationPrepareOptions<ListDirectoryInput>,
	): PreparedToolInvocation {
		const rawPath = typeof options.input?.path === 'string' ? options.input.path.trim() : '<missing-path>';
		const resolvedUri = tryResolvePathForInvocation(rawPath);
		const displayPath = resolvedUri ? toDisplayPath(resolvedUri) : rawPath;
		const pathPresentation = resolvedUri && isUriInsideWorkspaceFolders(resolvedUri)
			? formatUriForFileWidget(resolvedUri, displayPath)
			: `\`${escapeInlineCode(displayPath)}\``;
		const showPauseButton = vscode.workspace
			.getConfiguration('reliefpilot')
			.get<boolean>('showPauseButtonInChat', true);
		const md = new vscode.MarkdownString(undefined, true);
		md.supportHtml = true;
		md.isTrusted = true;
		const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png');
		md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `);
		md.appendMarkdown(`Relief Pilot · **rp_list_directory**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}\n`);
		md.appendMarkdown(`- Path: ${pathPresentation}  \n`);

		const confirmationMessages = buildOutsideWorkspaceConfirmation(rawPath);
		return confirmationMessages
			? { invocationMessage: md, confirmationMessages }
			: { invocationMessage: md };
	}
}
