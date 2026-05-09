import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    isUriInsideWorkspaceFolders,
    ReadFileLanguageModelTool,
    ReadFileTool,
} from '../../tools/read_file';

suite('Read File Tool Test Suite', function () {
	this.timeout(10000);

	const tmpDir = path.join(__dirname, '../../test-tmp-read-file');
	const textFilePath = path.join(tmpDir, 'sample.txt');
	const trailingNewlineFilePath = path.join(tmpDir, 'trailing-newline.txt');
	const emptyFilePath = path.join(tmpDir, 'empty.txt');
	const whitespaceFilePath = path.join(tmpDir, 'whitespace.txt');
	const binaryFilePath = path.join(tmpDir, 'sample.bin');
	const largeFilePath = path.join(tmpDir, 'large.txt');
	const outsideFilePath = path.join(os.tmpdir(), `reliefpilot-read-file-${Date.now()}.txt`);
	const copilotSessionWorkspacePath = path.join(
		os.homedir(),
		'Library',
		'Application Support',
		'Code',
		'User',
		'workspaceStorage',
		`reliefpilot-read-file-session-${Date.now()}`,
	);
	const copilotSessionResourceFilePath = path.join(
		copilotSessionWorkspacePath,
		'GitHub.copilot-chat',
		'chat-session-resources',
		'test-session',
		'test-call',
		'content.txt',
	);
	const tool = new ReadFileTool();
	const lmTool = new ReadFileLanguageModelTool();

	suiteSetup(async function () {
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(tmpDir));
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(textFilePath),
				Buffer.from('line 1\nline 2\n\nline 4\nline 5', 'utf8'),
		);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(trailingNewlineFilePath),
			Buffer.from('tail 1\ntail 2\ntail 3\n', 'utf8'),
		);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(emptyFilePath),
			Buffer.from('', 'utf8'),
		);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(whitespaceFilePath),
			Buffer.from(' \t\n', 'utf8'),
		);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(binaryFilePath),
			Uint8Array.from([0x4d, 0x5a, 0x00, 0x03, 0x00, 0x00, 0xff, 0xfe]),
		);
			await vscode.workspace.fs.writeFile(
				vscode.Uri.file(largeFilePath),
				Buffer.from(Array.from({ length: 2505 }, (_, index) => `line ${index + 1}`).join('\n'), 'utf8'),
			);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(outsideFilePath),
			Buffer.from('outside\nworkspace\n', 'utf8'),
		);
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(copilotSessionResourceFilePath)));
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(copilotSessionResourceFilePath),
			Buffer.from('alpha\nbeta\n\ngamma', 'utf8'),
		);
	});

	suiteTeardown(async function () {
		await vscode.workspace.fs.delete(vscode.Uri.file(tmpDir), { recursive: true });
		try {
			await vscode.workspace.fs.delete(vscode.Uri.file(copilotSessionWorkspacePath), { recursive: true });
		} catch {
			// Ignore cleanup errors for the temporary Copilot session resource path.
		}
		try {
			await vscode.workspace.fs.delete(vscode.Uri.file(outsideFilePath));
		} catch {
			// Ignore cleanup errors for the temp file outside the workspace.
		}
	});

	test('reads a whole text file by absolute path', async function () {
		const response = await tool.execute({ filePath: textFilePath });

		assert.strictEqual(response.text, 'line 1\nline 2\n\nline 4\nline 5');
	});

	test('reads a text file by relative path within the workspace', async function () {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			this.skip();
			return;
		}

		const relativePath = path.relative(workspaceRoot, textFilePath);
		const response = await tool.execute({ filePath: relativePath, offset: 4, limit: 2 });

		assert.strictEqual(response.text, 'line 4\nline 5');
	});

	test('reads a text file chunk via offset and limit', async function () {
		const response = await tool.execute({ filePath: textFilePath, offset: 2, limit: 4 });

		assert.strictEqual(response.text, 'line 2\n\nline 4\nline 5');
	});

	test('ignores empty default ranges when using offset and limit', async function () {
		const response = await tool.execute({
			filePath: textFilePath,
			offset: 2,
			limit: 2,
			ranges: [],
			includeLineNumbers: false,
			numberBlankLines: false,
			includeRangeHeaders: false,
		});

		assert.strictEqual(response.text, 'line 2\n');
		assert.strictEqual(response.ranges, undefined);
	});

	test('ignores empty default ranges when reading a whole file', async function () {
		const response = await tool.execute({
			filePath: textFilePath,
			ranges: [],
			includeLineNumbers: false,
			numberBlankLines: false,
			includeRangeHeaders: false,
		});

		assert.strictEqual(response.text, 'line 1\nline 2\n\nline 4\nline 5');
		assert.strictEqual(response.ranges, undefined);
	});

	test('reads a text file from the last line via negative offset', async function () {
		const response = await tool.execute({ filePath: textFilePath, offset: -1 });

		assert.strictEqual(response.text, 'line 5');
	});

	test('reads final text lines via tail mode and limit', async function () {
		const response = await tool.execute({ filePath: textFilePath, offset: -1, limit: 3 });

		assert.strictEqual(response.text, '\nline 4\nline 5');
	});

	test('reads final content lines via tail mode when the file ends with a newline', async function () {
		const response = await tool.execute({ filePath: trailingNewlineFilePath, offset: -1, limit: 2 });

		assert.strictEqual(response.text, 'tail 2\ntail 3');
	});

	test('throws for negative text offsets other than tail mode', async function () {
		await assert.rejects(
			() => tool.execute({ filePath: textFilePath, offset: -2, limit: 2 }),
			/offset must be a positive integer or -1 for tail mode\. Other negative offsets are not supported\./,
		);
	});

	test('reads multiple ranges with numbered blank lines and structured output', async function () {
		const response = await tool.execute({
			filePath: textFilePath,
			ranges: [
				{ startLine: 2, endLine: 4 },
				{ startLine: 5 },
			],
			includeLineNumbers: true,
			numberBlankLines: true,
			includeRangeHeaders: true,
		});

		assert.strictEqual(response.filePath, textFilePath);
		assert.strictEqual(
			response.text,
			'--- lines 2-4 ---\n2\tline 2\n3\t\n4\tline 4\n\n--- lines 5-5 ---\n5\tline 5',
		);
		assert.deepStrictEqual(response.ranges, [
			{
				startLine: 2,
				endLine: 4,
				lines: [
					{ lineNumber: 2, text: 'line 2', isBlank: false },
					{ lineNumber: 3, text: '', isBlank: true },
					{ lineNumber: 4, text: 'line 4', isBlank: false },
				],
			},
			{
				startLine: 5,
				endLine: 5,
				lines: [
					{ lineNumber: 5, text: 'line 5', isBlank: false },
				],
			},
		]);
	});

	test('throws when offset/limit mode is combined with ranges mode', async function () {
		await assert.rejects(
			() => tool.execute({
				filePath: textFilePath,
				limit: 2,
				ranges: [{ startLine: 4, endLine: 5 }],
				includeLineNumbers: true,
				includeRangeHeaders: true,
			}),
			/Use either offset\/limit or ranges, not both\./,
		);
	});

	test('returns an empty-file message for empty files', async function () {
		const response = await tool.execute({ filePath: emptyFilePath });

		assert.strictEqual(response.text, `(The file \`${emptyFilePath}\` exists, but is empty)`);
	});

	test('returns a whitespace-only message for whitespace files', async function () {
		const response = await tool.execute({ filePath: whitespaceFilePath });

		assert.strictEqual(response.text, `(The file \`${whitespaceFilePath}\` exists, but contains only whitespace)`);
	});

	test('returns a hexdump for binary files', async function () {
		const response = await tool.execute({ filePath: binaryFilePath, offset: 1, limit: 8 });

		assert.match(response.text, /00000001/);
		assert.match(response.text, /5a 00 03/);
		assert.match(response.text, /Z/);
	});

	test('reads a binary file tail via negative byte offset', async function () {
		const response = await tool.execute({ filePath: binaryFilePath, offset: -1, limit: 2 });

		assert.match(response.text, /00000006/);
		assert.match(response.text, /ff fe/);
		assert.doesNotMatch(response.text, /4d 5a/);
	});

	test('truncates a large file at 2000 lines by default', async function () {
		const response = await tool.execute({ filePath: largeFilePath });

		assert.match(response.text, /^line 1/m);
		assert.match(response.text, /^line 2000$/m);
		assert.match(response.text, /\[File content truncated at line 2000\. Use rp_read_file with offset\/limit parameters to view more\.\]$/);
		assert.doesNotMatch(response.text, /^line 2001$/m);
	});

	test('reads the tail of a large file via tail mode without default truncation', async function () {
		const response = await tool.execute({ filePath: largeFilePath, offset: -1, limit: 2 });

		assert.strictEqual(response.text, 'line 2504\nline 2505');
	});

	test('prepareInvocation requests confirmation for paths outside the workspace', async function () {
		const prepared = lmTool.prepareInvocation({ input: { filePath: outsideFilePath } } as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;
			const pathLine = invocationValue.split('\n').find((line) => line.startsWith('- Path: '));

		assert.ok(prepared.confirmationMessages);
		assert.strictEqual(prepared.confirmationMessages?.title, 'Read File Outside Workspace');
		assert.match(invocationValue, /rp_read_file/);
		assert.match(invocationValue, new RegExp(outsideFilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
		assert.doesNotMatch(invocationValue, /Range/);
			assert.strictEqual(pathLine, `- Path: \`${outsideFilePath}\`  `);
	});

	test('prepareInvocation renders a clickable file widget path for workspace files', async function () {
		const prepared = lmTool.prepareInvocation({ input: { filePath: textFilePath } } as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;

		assert.ok(!prepared.confirmationMessages);
		assert.match(invocationValue, /rp_read_file/);
		assert.match(invocationValue, new RegExp(textFilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
		assert.match(invocationValue, /- Path: \[[^\]]+\]\(file:/);
		assert.match(invocationValue, /vscodeLinkType%3Dskill/);
		assert.doesNotMatch(invocationValue, /Range/);
	});

	test('prepareInvocation ignores empty default ranges with offset and limit', async function () {
		const prepared = lmTool.prepareInvocation({
			input: {
				filePath: textFilePath,
				offset: 2,
				limit: 2,
				ranges: [],
				includeLineNumbers: false,
				numberBlankLines: false,
				includeRangeHeaders: false,
			},
		} as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;

		assert.ok(!prepared.confirmationMessages);
		assert.match(invocationValue, /- Offset: `2`/);
		assert.match(invocationValue, /- Limit: `2`/);
		assert.doesNotMatch(invocationValue, /Ranges/);
	});

	test('prepareInvocation does not request confirmation for Copilot chat session resource files', async function () {
		const prepared = lmTool.prepareInvocation({ input: { filePath: copilotSessionResourceFilePath } } as any);

		assert.ok(!prepared.confirmationMessages);
	});

	test('prepareInvocation renders a compact one-line message for Copilot chat session resource files', async function () {
		const prepared = lmTool.prepareInvocation({ input: { filePath: copilotSessionResourceFilePath, offset: 10, limit: 25 } } as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;

		assert.ok(!prepared.confirmationMessages);
		assert.match(invocationValue, /^!\[Relief Pilot\]\(.+\|width=10,height=10\) Relief Pilot · \*\*rp_read_file\*\* /);
		assert.match(invocationValue, /\[content\.txt\]\(file:[^)]+ "[^"]*content\.txt"\)/);
		assert.match(invocationValue, / `10, 25` /);
		assert.match(invocationValue, /\[⏸\]\(command:reliefpilot\.haltForFeedback\)$/);
		assert.ok(!invocationValue.includes('\n'));
		assert.ok(!invocationValue.includes('- Path:'));
	});

	test('ignores the new range block for Copilot chat session resource files', async function () {
		const response = await tool.execute({
			filePath: copilotSessionResourceFilePath,
			ranges: [{ startLine: 2, endLine: 3 }],
			includeLineNumbers: true,
			includeRangeHeaders: true,
		});

		assert.strictEqual(response.text, 'alpha\nbeta\n\ngamma');
		assert.strictEqual(response.ranges, undefined);
	});

	test('throws a real error for missing files instead of returning success text', async function () {
		await assert.rejects(
			() => tool.execute({ filePath: path.join(tmpDir, 'missing.txt') }),
			/ENOENT|no such file or directory|Relative path was not found/,
		);
	});

	test('throws when offset is beyond the file line count', async function () {
		await assert.rejects(
			() => tool.execute({ filePath: textFilePath, offset: 10 }),
			/Invalid offset 10: file only has 5 lines\. Line numbers are 1-indexed\./,
		);
	});

	test('throws when offset is 0', async function () {
		await assert.rejects(
			() => tool.execute({ filePath: textFilePath, offset: 0, limit: 2 }),
			/offset must not be 0\./,
		);
	});

	test('isUriInsideWorkspaceFolders detects workspace membership', function () {
		const textUri = vscode.Uri.file(textFilePath);
		assert.strictEqual(isUriInsideWorkspaceFolders(textUri), true);
		assert.strictEqual(isUriInsideWorkspaceFolders(vscode.Uri.file(outsideFilePath)), false);
	});
});