import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    ListDirectoryLanguageModelTool,
    ListDirectoryTool,
} from '../../tools/list_directory';

suite('List Directory Tool Test Suite', function () {
	this.timeout(10000);

	const tmpDir = path.join(__dirname, '../../test-tmp-list-directory');
	const sampleDirPath = path.join(tmpDir, 'sample');
	const nestedDirPath = path.join(sampleDirPath, 'nested');
	const emptyDirPath = path.join(tmpDir, 'empty');
	const outsideDirPath = path.join(os.tmpdir(), `reliefpilot-list-directory-${Date.now()}`);
	const copilotSessionWorkspacePath = path.join(
		os.homedir(),
		'Library',
		'Application Support',
		'Code',
		'User',
		'workspaceStorage',
		`reliefpilot-list-directory-session-${Date.now()}`,
	);
	const copilotSessionResourceDirPath = path.join(
		copilotSessionWorkspacePath,
		'GitHub.copilot-chat',
		'chat-session-resources',
		'test-session',
		'test-call',
	);
	const tool = new ListDirectoryTool();
	const lmTool = new ListDirectoryLanguageModelTool();

	suiteSetup(async function () {
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(nestedDirPath));
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(path.join(sampleDirPath, 'alpha.txt')),
			Buffer.from('alpha', 'utf8'),
		);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(path.join(nestedDirPath, 'child.txt')),
			Buffer.from('child', 'utf8'),
		);
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(emptyDirPath));
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(outsideDirPath));
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(path.join(outsideDirPath, 'outside.txt')),
			Buffer.from('outside', 'utf8'),
		);
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(copilotSessionResourceDirPath));
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(path.join(copilotSessionResourceDirPath, 'content.txt')),
			Buffer.from('alpha', 'utf8'),
		);
	});

	suiteTeardown(async function () {
		await vscode.workspace.fs.delete(vscode.Uri.file(tmpDir), { recursive: true });
		try {
			await vscode.workspace.fs.delete(vscode.Uri.file(outsideDirPath), { recursive: true });
		} catch {
			// Ignore cleanup errors for the temp directory outside the workspace.
		}
		try {
			await vscode.workspace.fs.delete(vscode.Uri.file(copilotSessionWorkspacePath), { recursive: true });
		} catch {
			// Ignore cleanup errors for the temporary Copilot session resource path.
		}
	});

	test('lists directory contents by absolute path', async function () {
		const response = await tool.execute({ path: sampleDirPath });

		assert.strictEqual(response.path, sampleDirPath);
		assert.deepStrictEqual([...response.entries].sort(), ['alpha.txt', 'nested/']);
		assert.deepStrictEqual(response.text.split('\n').sort(), ['alpha.txt', 'nested/']);
	});

	test('lists directory contents by file URI', async function () {
		const response = await tool.execute({ path: vscode.Uri.file(sampleDirPath).toString() });

		assert.deepStrictEqual([...response.entries].sort(), ['alpha.txt', 'nested/']);
	});

	test('lists directory contents by relative path within the workspace', async function () {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			this.skip();
			return;
		}

		const relativePath = path.relative(workspaceRoot, sampleDirPath);
		const response = await tool.execute({ path: relativePath });

		assert.deepStrictEqual([...response.entries].sort(), ['alpha.txt', 'nested/']);
	});

	test('returns an empty-folder message for empty directories', async function () {
		const response = await tool.execute({ path: emptyDirPath });

		assert.strictEqual(response.text, 'Folder is empty');
		assert.deepStrictEqual(response.entries, []);
	});

	test('throws a real error for missing directories', async function () {
		await assert.rejects(
			() => tool.execute({ path: path.join(tmpDir, 'missing') }),
			/ENOENT|no such file or directory|Relative path was not found/,
		);
	});

	test('prepareInvocation requests confirmation for paths outside the workspace', async function () {
		const prepared = lmTool.prepareInvocation({ input: { path: outsideDirPath } } as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;

		assert.ok(prepared.confirmationMessages);
		assert.strictEqual(prepared.confirmationMessages?.title, 'Read Directory Outside Workspace');
		assert.match(invocationValue, /rp_list_directory/);
		assert.match(invocationValue, new RegExp(outsideDirPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
		assert.doesNotMatch(invocationValue, /Range/);
		assert.doesNotMatch(invocationValue, /\[\]\(file:/);
	});

	test('prepareInvocation renders a clickable file widget path for workspace directories', async function () {
		const prepared = lmTool.prepareInvocation({ input: { path: sampleDirPath } } as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;

		assert.ok(!prepared.confirmationMessages);
		assert.match(invocationValue, /rp_list_directory/);
		assert.match(invocationValue, new RegExp(sampleDirPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
		assert.match(invocationValue, /\[[^\]]+\]\(file:/);
		assert.match(invocationValue, /vscodeLinkType%3Dskill/);
		assert.doesNotMatch(invocationValue, /Range/);
	});

	test('prepareInvocation does not request confirmation for Copilot chat session resource directories', async function () {
		const prepared = lmTool.prepareInvocation({ input: { path: copilotSessionResourceDirPath } } as any);

		assert.ok(!prepared.confirmationMessages);
		assert.match((prepared.invocationMessage as vscode.MarkdownString).value, /rp_list_directory/);
	});
});
