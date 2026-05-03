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
	const emptyFilePath = path.join(tmpDir, 'empty.txt');
	const whitespaceFilePath = path.join(tmpDir, 'whitespace.txt');
	const binaryFilePath = path.join(tmpDir, 'sample.bin');
	const largeFilePath = path.join(tmpDir, 'large.txt');
	const outsideFilePath = path.join(os.tmpdir(), `reliefpilot-read-file-${Date.now()}.txt`);
	const tool = new ReadFileTool();
	const lmTool = new ReadFileLanguageModelTool();

	suiteSetup(async function () {
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(tmpDir));
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(textFilePath),
				Buffer.from('line 1\nline 2\n\nline 4\nline 5', 'utf8'),
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
	});

	suiteTeardown(async function () {
		await vscode.workspace.fs.delete(vscode.Uri.file(tmpDir), { recursive: true });
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

	test('truncates a large file at 2000 lines by default', async function () {
		const response = await tool.execute({ filePath: largeFilePath });

		assert.match(response.text, /^line 1/m);
		assert.match(response.text, /^line 2000$/m);
		assert.match(response.text, /\[File content truncated at line 2000\. Use rp_read_file with offset\/limit parameters to view more\.\]$/);
		assert.doesNotMatch(response.text, /^line 2001$/m);
	});

	test('prepareInvocation requests confirmation for paths outside the workspace', async function () {
		const prepared = lmTool.prepareInvocation({ input: { filePath: outsideFilePath } } as any);

		assert.ok(prepared.confirmationMessages);
		assert.strictEqual(prepared.confirmationMessages?.title, 'Read File Outside Workspace');
		assert.match((prepared.invocationMessage as vscode.MarkdownString).value, /rp_read_file/);
		assert.match((prepared.invocationMessage as vscode.MarkdownString).value, /full file/);
	});

	test('prepareInvocation does not request confirmation for Copilot chat session resource files', async function () {
		const internalResourcePath = path.join(
			os.homedir(),
			'Library',
			'Application Support',
			'Code',
			'User',
			'workspaceStorage',
			'test-workspace',
			'GitHub.copilot-chat',
			'chat-session-resources',
			'test-session',
			'test-call',
			'content.txt',
		);

		const prepared = lmTool.prepareInvocation({ input: { filePath: internalResourcePath } } as any);

		assert.ok(!prepared.confirmationMessages);
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

	test('clamps offset 0 to the beginning of the file like the reference implementation', async function () {
		const response = await tool.execute({ filePath: textFilePath, offset: 0, limit: 2 });

		assert.strictEqual(response.text, 'line 1\nline 2');
	});

	test('isUriInsideWorkspaceFolders detects workspace membership', function () {
		const textUri = vscode.Uri.file(textFilePath);
		assert.strictEqual(isUriInsideWorkspaceFolders(textUri), true);
		assert.strictEqual(isUriInsideWorkspaceFolders(vscode.Uri.file(outsideFilePath)), false);
	});
});