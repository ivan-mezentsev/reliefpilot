import {
    BasePromptElementProps,
    PromptElement,
    type PromptPiece,
    renderElementJSON,
} from '@vscode/prompt-tsx';
import { isBinaryFile } from 'isbinaryfile';
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
import { formatResponse, ToolResponse } from '../utils/response';
import { statusBarActivity } from '../utils/statusBar';

export interface ReadFileInput {
	filePath: string;
	offset?: number;
	limit?: number;
	ranges?: Array<{
		startLine: number;
		endLine?: number;
	}>;
	includeLineNumbers?: boolean;
	numberBlankLines?: boolean;
	includeRangeHeaders?: boolean;
}

type ReadFileTokenizationOptions = {
	tokenBudget?: number;
	countTokens?: (text: string, token?: CancellationToken) => Thenable<number>;
};

interface ReadFileRequestedRange {
	startLine: number;
	endLine: number;
}

interface ReadFileStructuredLine {
	lineNumber?: number;
	text: string;
	isBlank: boolean;
}

interface ReadFileStructuredRange {
	startLine: number;
	endLine: number;
	lines: ReadFileStructuredLine[];
}

interface ReadFileAdvancedOptions {
	ranges: ReadFileRequestedRange[];
	includeLineNumbers: boolean;
	numberBlankLines: boolean;
	includeRangeHeaders: boolean;
}

interface ReadFileToolResponse extends ToolResponse {
	filePath: string;
	ranges?: ReadFileStructuredRange[];
}

interface ReadFilePromptElementProps extends BasePromptElementProps {
	content: string;
}

const uriSchemeRegexp = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const windowsDriveLetterRegexp = /^[a-zA-Z]:[\\/]/;
const copilotSessionResourcePathRegexp = /(?:^|[\\/])workspaceStorage[\\/][^\\/]+[\\/]GitHub\.copilot-chat[\\/]chat-session-resources(?:[\\/]|$)/i;
const MAX_BINARY_HEXDUMP_BYTES = 512;
const BYTES_PER_HEXDUMP_ROW = 16;
const MAX_LINES_PER_READ = 2000;

class ReadFilePromptElement extends PromptElement<ReadFilePromptElementProps> {
	override render(): PromptPiece {
		return {
			ctor: (globalThis as { vscppf?: unknown }).vscppf as string,
			props: {},
			children: [this.props.content],
		};
	}
}

function looksLikeUri(raw: string): boolean {
	return uriSchemeRegexp.test(raw) && !windowsDriveLetterRegexp.test(raw);
}

function normalizePathForComparison(fsPath: string): string {
	const normalized = path.resolve(fsPath);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isFsPathInside(basePath: string, targetPath: string): boolean {
	const normalizedBase = normalizePathForComparison(basePath);
	const normalizedTarget = normalizePathForComparison(targetPath);
	const relative = path.relative(normalizedBase, normalizedTarget);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

function escapeMarkdownLinkTitle(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function toDisplayPath(uri: vscode.Uri): string {
	return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

function isCopilotSessionResourceUri(uri: vscode.Uri): boolean {
	if (uri.scheme !== 'file') {
		return false;
	}

	return copilotSessionResourcePathRegexp.test(uri.fsPath);
}

function getFileLinkLabel(uri: vscode.Uri): string {
	if (uri.scheme === 'file') {
		return path.basename(uri.fsPath) || uri.fsPath;
	}

	return path.posix.basename(uri.path) || uri.toString();
}

function formatMarkdownFileLink(uri: vscode.Uri): string {
	const label = escapeMarkdownLinkText(getFileLinkLabel(uri));
	const title = escapeMarkdownLinkTitle(toDisplayPath(uri));
	return `[${label}](${uri.toString()} "${title}")`;
}

function buildCompactSessionResourceInvocationMessage(
	uri: vscode.Uri,
	offset: number | undefined,
	limit: number | undefined,
	showPauseButton: boolean,
): vscode.MarkdownString {
	const md = new vscode.MarkdownString(undefined, true);
	md.supportHtml = true;
	md.isTrusted = true;
	const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png');
	md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `);
	md.appendMarkdown('Relief Pilot · **rp_read_file** ');
	md.appendMarkdown(formatMarkdownFileLink(uri));
	if (offset !== undefined || limit !== undefined) {
		const compactRange = [offset, limit]
			.filter((value): value is number => typeof value === 'number')
			.join(', ');
		if (compactRange.length > 0) {
			md.appendMarkdown(` \`${compactRange}\``);
		}
	}
	if (showPauseButton) {
		md.appendMarkdown(' [⏸](command:reliefpilot.haltForFeedback)');
	}
	return md;
}

function tryParseDirectUri(rawFilePath: string): vscode.Uri | undefined {
	const trimmed = rawFilePath.trim();
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

function normalizeOffset(value: unknown): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	if (typeof value !== 'number' || !Number.isInteger(value)) {
		throw new Error('offset must be an integer.');
	}

	if (value === 0) {
		throw new Error('offset must not be 0. Omit offset to read from the beginning, use a positive offset to read from a 1-indexed line or byte, or use -1 for tail mode.');
	}

	if (value < -1) {
		throw new Error('offset must be a positive integer or -1 for tail mode. Other negative offsets are not supported.');
	}

	return value;
}

function normalizeLimit(value: unknown): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		throw new Error('limit must be a positive integer.');
	}

	return value;
}

function normalizePositiveLineNumber(value: unknown, fieldName: string): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		throw new Error(`${fieldName} must be a positive integer.`);
	}

	return value;
}

function normalizeRequestedRanges(
	ranges: ReadFileInput['ranges'],
): ReadFileRequestedRange[] | undefined {
	if (ranges === undefined) {
		return undefined;
	}

	if (!Array.isArray(ranges) || ranges.length === 0) {
		throw new Error('ranges must be a non-empty array.');
	}

	return ranges.map((range, index) => {
		if (!range || typeof range !== 'object') {
			throw new Error(`ranges[${index}] must be an object.`);
		}

		let startLine = normalizePositiveLineNumber(range.startLine, `ranges[${index}].startLine`);
		let endLine = range.endLine === undefined
			? startLine
			: normalizePositiveLineNumber(range.endLine, `ranges[${index}].endLine`);

		if (startLine > endLine) {
			[startLine, endLine] = [endLine, startLine];
		}

		return { startLine, endLine };
	});
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function hasLegacyRangeRequest(input: ReadFileInput): boolean {
	return input.offset !== undefined || input.limit !== undefined;
}

function validateReadMode(input: ReadFileInput | undefined): void {
	if (!input) {
		return;
	}

	if (input.ranges !== undefined && hasLegacyRangeRequest(input)) {
		throw new Error('Use either offset/limit or ranges, not both.');
	}
}

function getAdvancedReadOptions(
	input: ReadFileInput,
	uri: vscode.Uri | undefined,
): ReadFileAdvancedOptions | undefined {
	if (hasLegacyRangeRequest(input)) {
		return undefined;
	}

	if (uri && isCopilotSessionResourceUri(uri)) {
		return undefined;
	}

	const ranges = normalizeRequestedRanges(input.ranges);
	if (!ranges) {
		return undefined;
	}

	return {
		ranges,
		includeLineNumbers: input.includeLineNumbers === true,
		numberBlankLines: input.numberBlankLines === true,
		includeRangeHeaders: input.includeRangeHeaders === true,
	};
}

function getTextRange(
	totalLines: number,
	input: ReadFileInput,
	documentText: string,
): { startLine: number; endLine: number; truncated: boolean } {
	const offset = normalizeOffset(input.offset);
	const requestedLimit = normalizeLimit(input.limit);
	if (offset === -1) {
		const tailEndLine = documentText.endsWith('\n') && totalLines > 1
			? totalLines - 1
			: totalLines;
		const effectiveLimit = clamp(requestedLimit ?? 1, 1, MAX_LINES_PER_READ);
		return {
			startLine: clamp(tailEndLine - effectiveLimit + 1, 1, tailEndLine),
			endLine: tailEndLine,
			truncated: false,
		};
	}

	if (offset !== undefined && offset > totalLines) {
		throw new Error(`Invalid offset ${offset}: file only has ${totalLines} line${totalLines === 1 ? '' : 's'}. Line numbers are 1-indexed.`);
	}

	const effectiveLimit = clamp(requestedLimit ?? Number.POSITIVE_INFINITY, 1, MAX_LINES_PER_READ);
	const requestedStartLine = offset ?? 1;
	const startLine = clamp(requestedStartLine, 1, totalLines);
	const endLine = clamp(startLine + effectiveLimit - 1, 1, totalLines);
	return {
		startLine,
		endLine,
		truncated: effectiveLimit !== requestedLimit && endLine < totalLines,
	};
}

function getRequestedTextRanges(
	totalLines: number,
	ranges: ReadonlyArray<ReadFileRequestedRange>,
): ReadFileRequestedRange[] {
	return ranges.map((range, index) => {
		if (range.startLine > totalLines) {
			throw new Error(`Invalid ranges[${index}].startLine ${range.startLine}: file only has ${totalLines} line${totalLines === 1 ? '' : 's'}. Line numbers are 1-indexed.`);
		}

		return {
			startLine: clamp(range.startLine, 1, totalLines),
			endLine: clamp(range.endLine, 1, totalLines),
		};
	});
}

function getBinaryByteRange(
	totalBytes: number,
	input: ReadFileInput,
): { startByte: number; endByte: number; truncated: boolean } {
	const offset = normalizeOffset(input.offset);
	const limit = normalizeLimit(input.limit);
	if (offset === -1) {
		const requestedLength = limit ?? 1;
		const effectiveLength = Math.min(requestedLength, MAX_BINARY_HEXDUMP_BYTES);
		const startByte = Math.max(totalBytes - effectiveLength, 0);
		return {
			startByte,
			endByte: totalBytes,
			truncated: requestedLength > effectiveLength && startByte > 0,
		};
	}

	let requestedStartByte = offset === undefined
		? 0
		: offset;
	let requestedEndByte = offset !== undefined && limit !== undefined
		? requestedStartByte + limit
		: requestedStartByte + 128;
	if (requestedStartByte > requestedEndByte) {
		[requestedStartByte, requestedEndByte] = [requestedEndByte, requestedStartByte];
	}

	const startByte = Math.min(requestedStartByte, totalBytes);
	const endByte = Math.min(requestedEndByte, totalBytes, startByte + MAX_BINARY_HEXDUMP_BYTES);
	return {
		startByte,
		endByte,
		truncated: startByte !== requestedStartByte || endByte < Math.min(requestedEndByte, totalBytes),
	};
}

export function isUriInsideWorkspaceFolders(
	uri: vscode.Uri,
	workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined = vscode.workspace.workspaceFolders,
): boolean {
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return false;
	}

	for (const folder of workspaceFolders) {
		if (uri.scheme === 'file' && folder.uri.scheme === 'file') {
			if (isFsPathInside(folder.uri.fsPath, uri.fsPath)) {
				return true;
			}
			continue;
		}

		const folderString = folder.uri.toString();
		const targetString = uri.toString();
		if (targetString === folderString || targetString.startsWith(`${folderString}/`)) {
			return true;
		}
	}

	return false;
}

function relativePathMayEscapeWorkspace(rawFilePath: string): boolean {
	const normalized = path.posix.normalize(rawFilePath.replace(/\\/g, '/'));
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

async function resolveRelativePathInWorkspace(rawFilePath: string): Promise<vscode.Uri> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		throw new Error('Relative paths require an open workspace. Use an absolute path or a file URI instead.');
	}

	const trimmed = rawFilePath.trim();
	if (workspaceFolders.length === 1) {
		const folder = workspaceFolders[0];
		if (folder.uri.scheme === 'file') {
			return vscode.Uri.file(path.resolve(folder.uri.fsPath, trimmed));
		}

		return vscode.Uri.joinPath(folder.uri, ...trimmed.split(/[\\/]+/).filter(Boolean));
	}

	const candidates = workspaceFolders.map(folder => {
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

	const uniqueCandidates = Array.from(new Map(existingCandidates.map(candidate => [candidate.toString(), candidate])).values());
	if (uniqueCandidates.length === 1) {
		return uniqueCandidates[0];
	}

	if (uniqueCandidates.length > 1) {
		throw new Error(`Relative path is ambiguous in a multi-root workspace: ${trimmed}. Use an absolute path or a file URI instead.`);
	}

	throw new Error(`Relative path was not found in the current workspace folders: ${trimmed}`);
}

async function resolveReadFileUri(rawFilePath: string): Promise<vscode.Uri> {
	const directUri = tryParseDirectUri(rawFilePath);
	if (directUri) {
		return directUri;
	}

	return resolveRelativePathInWorkspace(rawFilePath);
}

function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
	return vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
}

function getDocumentRangeText(
	document: vscode.TextDocument,
	startLine: number,
	endLine: number,
): string {
	const start = new vscode.Position(startLine - 1, 0);
	const end = document.lineAt(endLine - 1).range.end;
	return document.getText(new vscode.Range(start, end));
}

function buildStructuredReadRanges(
	document: vscode.TextDocument,
	ranges: ReadonlyArray<ReadFileRequestedRange>,
	options: ReadFileAdvancedOptions,
): ReadFileStructuredRange[] {
	return ranges.map(({ startLine, endLine }) => {
		const lines: ReadFileStructuredLine[] = [];

		for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
			const lineText = document.lineAt(lineNumber - 1).text;
			const isBlank = lineText.length === 0;
			const shouldIncludeLineNumber = options.includeLineNumbers && (!isBlank || options.numberBlankLines);

			lines.push({
				...(shouldIncludeLineNumber ? { lineNumber } : {}),
				text: lineText,
				isBlank,
			});
		}

		return {
			startLine,
			endLine,
			lines,
		};
	});
}

function buildTextOutputFromRanges(
	ranges: ReadonlyArray<ReadFileStructuredRange>,
	options: ReadFileAdvancedOptions,
): string {
	const blocks = ranges.map((range) => {
		const lineOutput = range.lines
			.map((line) => line.lineNumber === undefined ? line.text : `${line.lineNumber}\t${line.text}`)
			.join('\n');

		if (!options.includeRangeHeaders) {
			return lineOutput;
		}

		const header = `--- lines ${range.startLine}-${range.endLine} ---`;
		return lineOutput.length > 0 ? `${header}\n${lineOutput}` : header;
	});

	return blocks.join(options.includeRangeHeaders ? '\n\n' : '\n');
}

function buildReadFileToolResponse(
	uri: vscode.Uri,
	text: string,
	ranges?: ReadFileStructuredRange[],
): ReadFileToolResponse {
	return {
		...formatResponse.toolResult(text),
		filePath: toDisplayPath(uri),
		...(ranges ? { ranges } : {}),
	};
}

function formatLineRange(range: ReadFileRequestedRange): string {
	return `${range.startLine}-${range.endLine}`;
}

function getEmptyOrWhitespaceDocumentMessage(uri: vscode.Uri, text: string): string | undefined {
	if (text.length === 0) {
		return `(The file \`${toDisplayPath(uri)}\` exists, but is empty)`;
	}

	if (text.trim().length === 0) {
		return `(The file \`${toDisplayPath(uri)}\` exists, but contains only whitespace)`;
	}

	return undefined;
}

async function applyTokenBudget(
	content: string,
	tokenizationOptions: ReadFileTokenizationOptions | undefined,
	token: CancellationToken,
): Promise<string> {
	const tokenBudget = tokenizationOptions?.tokenBudget;
	const countTokens = tokenizationOptions?.countTokens;
	const fullResponse = content;

	if (!tokenBudget || tokenBudget <= 0 || !countTokens) {
		return fullResponse;
	}

	if ((await countTokens(fullResponse, token)) <= tokenBudget) {
		return fullResponse;
	}

	const lines = content.split('\n');
	let bestResponse = '[File content truncated to fit the model token budget.]';
	let low = 0;
	let high = lines.length;

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const candidateContent = lines.slice(0, mid).join('\n');
		const candidateResponse = `${candidateContent}\n[File content truncated to fit the model token budget.]`;
		const tokens = await countTokens(candidateResponse, token);

		if (tokens <= tokenBudget) {
			bestResponse = candidateResponse;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	if (bestResponse !== '[File content truncated to fit the model token budget.]') {
		return bestResponse;
	}

	let charLow = 0;
	let charHigh = content.length;
	while (charLow <= charHigh) {
		const mid = Math.floor((charLow + charHigh) / 2);
		const candidateContent = content.slice(0, mid);
		const candidateResponse = `${candidateContent}\n[File content truncated to fit the model token budget.]`;
		const tokens = await countTokens(candidateResponse, token);

		if (tokens <= tokenBudget) {
			bestResponse = candidateResponse;
			charLow = mid + 1;
		} else {
			charHigh = mid - 1;
		}
	}

	return bestResponse;
}

function formatHexdump(data: Uint8Array, startByte: number, endByte: number): string {
	if (startByte >= endByte) {
		return '';
	}

	const lines: string[] = [];
	for (let offset = startByte; offset < endByte; offset += BYTES_PER_HEXDUMP_ROW) {
		const chunk = data.slice(offset, Math.min(endByte, offset + BYTES_PER_HEXDUMP_ROW));
		const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
		const paddedHex = hex.padEnd(BYTES_PER_HEXDUMP_ROW * 3 - 1, ' ');
		const ascii = Array.from(chunk, (byte) => (
			byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.'
		)).join('');
		lines.push(`${offset.toString(16).padStart(8, '0')}  ${paddedHex}  ${ascii}`);
	}

	return lines.join('\n');
}

function buildBinaryReadResponse(
	data: Uint8Array,
	startByte: number,
	endByte: number,
	truncated: boolean,
): string {
	const hexdump = formatHexdump(data, startByte, endByte);
	if (!truncated) {
		return hexdump;
	}

	return `${hexdump}\n[Binary content truncated at byte ${endByte}. Request a smaller or later byte range to inspect more.]`;
}

type ReadableFileData =
	| { kind: 'text'; document: vscode.TextDocument }
	| { kind: 'binary'; data: Uint8Array };

async function getReadableFileData(uri: vscode.Uri): Promise<ReadableFileData> {
	const openDocument = findOpenDocument(uri);
	if (openDocument) {
		return { kind: 'text', document: openDocument };
	}

	const stat = await vscode.workspace.fs.stat(uri);
	if ((stat.type & vscode.FileType.Directory) !== 0) {
		throw new Error(`Path points to a directory, not a file: ${toDisplayPath(uri)}`);
	}

	const rawBuffer = await vscode.workspace.fs.readFile(uri);
	if (await isBinaryFile(Buffer.from(rawBuffer))) {
		return { kind: 'binary', data: rawBuffer };
	}

	const document = await vscode.workspace.openTextDocument(uri);
	return { kind: 'text', document };
}

async function createPromptTsxToolPart(
	content: string,
	tokenizationOptions: ReadFileTokenizationOptions | undefined,
	token: CancellationToken,
): Promise<unknown> {
	const budgetInformation = (
		typeof tokenizationOptions?.tokenBudget === 'number' && typeof tokenizationOptions.countTokens === 'function'
	)
		? {
			tokenBudget: tokenizationOptions.tokenBudget,
			countTokens: tokenizationOptions.countTokens,
		}
		: undefined;

	const promptElementJson = await renderElementJSON(
		ReadFilePromptElement,
		{ content },
		budgetInformation,
		token,
	);
	const PromptTsxPartCtor = (vscode as typeof vscode & {
		LanguageModelPromptTsxPart?: new (value: unknown) => unknown;
	}).LanguageModelPromptTsxPart;
	if (!PromptTsxPartCtor) {
		throw new Error('LanguageModelPromptTsxPart is unavailable in this VS Code build.');
	}

	return new PromptTsxPartCtor(promptElementJson);
}

function buildOutsideWorkspaceConfirmation(rawFilePath: string): vscode.LanguageModelToolConfirmationMessages | undefined {
	const trimmed = rawFilePath.trim();
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
		`Allow **rp_read_file** to read \`${escapedPath}\`? This path is outside the current workspace or may resolve outside it.`,
		true,
	);
	message.supportHtml = false;
	message.isTrusted = false;

	return {
		title: 'Read File Outside Workspace',
		message,
	};
}

export class ReadFileTool {
	async execute(
		input: ReadFileInput,
		tokenizationOptions?: ReadFileTokenizationOptions,
		token?: CancellationToken,
	): Promise<ReadFileToolResponse> {
		if (!input || typeof input.filePath !== 'string' || input.filePath.trim().length === 0) {
			throw new Error('filePath must be a non-empty string.');
		}

		if (token?.isCancellationRequested) {
			return buildReadFileToolResponse(vscode.Uri.file(input.filePath), 'Operation cancelled.');
		}

		validateReadMode(input);
		const uri = await resolveReadFileUri(input.filePath);
		const fileData = await getReadableFileData(uri);

		if (fileData.kind === 'binary') {
			const { startByte, endByte, truncated } = getBinaryByteRange(fileData.data.byteLength, input);
			const responseText = buildBinaryReadResponse(fileData.data, startByte, endByte, truncated);
			return buildReadFileToolResponse(uri, responseText);
		}

		const totalLines = Math.max(fileData.document.lineCount, 1);
		const documentText = fileData.document.getText();
		const specialMessage = getEmptyOrWhitespaceDocumentMessage(uri, documentText);
		if (specialMessage) {
			return buildReadFileToolResponse(uri, specialMessage);
		}

		const advancedOptions = getAdvancedReadOptions(input, uri);
		if (advancedOptions) {
			const ranges = getRequestedTextRanges(totalLines, advancedOptions.ranges);
			const structuredRanges = buildStructuredReadRanges(fileData.document, ranges, advancedOptions);
			const rawResponseText = buildTextOutputFromRanges(structuredRanges, advancedOptions);
			const responseText = await applyTokenBudget(
				rawResponseText,
				tokenizationOptions,
				token ?? new vscode.CancellationTokenSource().token,
			);

			return buildReadFileToolResponse(
				uri,
				responseText,
				structuredRanges,
			);
		}

		const { startLine, endLine, truncated } = getTextRange(totalLines, input, documentText);

		let content = getDocumentRangeText(fileData.document, startLine, endLine);
		if (truncated) {
			content += `\n[File content truncated at line ${endLine}. Use rp_read_file with offset/limit parameters to view more.]`;
		}
		const responseText = await applyTokenBudget(
			content,
			tokenizationOptions,
			token ?? new vscode.CancellationTokenSource().token,
		);

		return buildReadFileToolResponse(uri, responseText);
	}
}

export class ReadFileLanguageModelTool implements LanguageModelTool<ReadFileInput> {
	async invoke(
		options: LanguageModelToolInvocationOptions<ReadFileInput>,
		token: CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		statusBarActivity.start('rp_read_file');
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

			const tool = new ReadFileTool();
			const tokenizationOptions = (
				options as LanguageModelToolInvocationOptions<ReadFileInput> & { tokenizationOptions?: ReadFileTokenizationOptions }
			).tokenizationOptions;
			const response = await tool.execute(options.input, tokenizationOptions, token);
			const promptTsxPart = await createPromptTsxToolPart(response.text, tokenizationOptions, token);
			return new vscode.LanguageModelToolResult([
				promptTsxPart as unknown as vscode.LanguageModelTextPart,
			]);
		} finally {
			statusBarActivity.end('rp_read_file');
		}
	}

	prepareInvocation(
		options: LanguageModelToolInvocationPrepareOptions<ReadFileInput>,
	): PreparedToolInvocation {
		const rawFilePath = typeof options.input?.filePath === 'string' ? options.input.filePath.trim() : '<missing-filePath>';
		const directUri = tryParseDirectUri(rawFilePath);
		validateReadMode(options.input);
		const offset = normalizeOffset(options.input?.offset);
		const limit = normalizeLimit(options.input?.limit);
		const advancedOptions = getAdvancedReadOptions(options.input, directUri);
		const showPauseButton = vscode.workspace
			.getConfiguration('reliefpilot')
			.get<boolean>('showPauseButtonInChat', true);

		if (directUri && isCopilotSessionResourceUri(directUri)) {
			return {
				invocationMessage: buildCompactSessionResourceInvocationMessage(directUri, offset, limit, showPauseButton),
			};
		}

		const md = new vscode.MarkdownString(undefined, true);
		md.supportHtml = true;
		md.isTrusted = true;
		const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png');
		md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `);
		md.appendMarkdown(`Relief Pilot · **rp_read_file**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}\n`);
		md.appendMarkdown(`- Path: \`${escapeInlineCode(rawFilePath)}\`  \n`);
		if (offset !== undefined || limit !== undefined) {
			if (offset !== undefined) {
				md.appendMarkdown(`- Offset: \`${offset}\`  \n`);
			}
			if (limit !== undefined) {
				md.appendMarkdown(`- Limit: \`${limit}\`  \n`);
			}
		} else if (advancedOptions) {
			md.appendMarkdown(`- Ranges: \`${advancedOptions.ranges.map(formatLineRange).join('; ')}\`  \n`);
			if (advancedOptions.includeLineNumbers) {
				md.appendMarkdown(`- Include line numbers: \`true\`  \n`);
				if (advancedOptions.numberBlankLines) {
					md.appendMarkdown(`- Number blank lines: \`true\`  \n`);
				}
			}
			if (advancedOptions.includeRangeHeaders) {
				md.appendMarkdown(`- Include range headers: \`true\`  \n`);
			}
		} else {
			md.appendMarkdown(`- Range: \`full file\`  \n`);
		}

		const confirmationMessages = buildOutsideWorkspaceConfirmation(rawFilePath);
		return confirmationMessages
			? { invocationMessage: md, confirmationMessages }
			: { invocationMessage: md };
	}
}