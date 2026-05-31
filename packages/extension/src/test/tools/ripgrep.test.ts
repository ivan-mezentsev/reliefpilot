import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RipgrepLanguageModelTool } from '../../tools/ripgrep';

suite('Ripgrep Tool Test Suite', function () {
	const lmTool = new RipgrepLanguageModelTool();

	test('prepareInvocation renders glob on the detail line', function () {
		const prepared = lmTool.prepareInvocation({
			input: {
				pattern: '\\A',
				detail: 'files',
				glob: ['**/set_env.sh'],
				includeHidden: true,
			},
		} as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;

		assert.match(invocationValue, /• Detail: `files` · glob: `\*\*\/set_env\.sh`/);
	});

	test('prepareInvocation hides CWD when it matches the workspace root', function () {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		assert.ok(workspaceRoot);

		const prepared = lmTool.prepareInvocation({
			input: {
				pattern: 'needle',
				cwd: workspaceRoot,
			},
		} as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;

		assert.doesNotMatch(invocationValue, /• CWD:/);
	});

	test('prepareInvocation shows CWD when it differs from the workspace root', function () {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		assert.ok(workspaceRoot);
		const differentCwd = `${workspaceRoot}-other`;

		const prepared = lmTool.prepareInvocation({
			input: {
				pattern: 'needle',
				cwd: differentCwd,
			},
		} as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;

		assert.ok(invocationValue.includes(`• CWD: \`${differentCwd}\``));
	});

	test('prepareInvocation renders Copilot session resource paths as clickable basename links', function () {
		const sessionResourcePath = path.join(
			os.homedir(),
			'Library',
			'Application Support',
			'Code',
			'User',
			'workspaceStorage',
			'ripgrep-session-resource-test',
			'GitHub.copilot-chat',
			'chat-session-resources',
			'test-session',
			'test-call',
			'content.txt',
		);

		const prepared = lmTool.prepareInvocation({
			input: {
				pattern: 'context.',
				paths: [sessionResourcePath],
				detail: 'lines+submatches',
			},
		} as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;
		const pathsLine = invocationValue.split('\n').find(line => line.startsWith('• Paths:'));

		assert.ok(pathsLine);
		assert.match(pathsLine, /\[content\.txt\]\(file:[^)]+ "[^"]*content\.txt"\)/);
		assert.doesNotMatch(pathsLine, /^• Paths: `/);
		assert.ok(pathsLine.startsWith('• Paths: [content.txt]('));
	});

	test('prepareInvocation renders context file paths as clickable basename links', function () {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		assert.ok(workspaceRoot);
		const contextPath = path.join(workspaceRoot, 'context.search.md');

		const prepared = lmTool.prepareInvocation({
			input: {
				pattern: 'needle',
				paths: [contextPath],
			},
		} as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;
		const pathsLine = invocationValue.split('\n').find(line => line.startsWith('• Paths:'));

		assert.ok(pathsLine);
		assert.match(pathsLine, /\[context\.search\.md\]\(file:[^)]+ "[^"]*context\.search\.md"\)/);
		assert.doesNotMatch(pathsLine, /^• Paths: `/);
		assert.ok(pathsLine.startsWith('• Paths: [context.search.md]('));
	});

	test('prepareInvocation preserves plain path formatting when no styled paths are present', function () {
		const prepared = lmTool.prepareInvocation({
			input: {
				pattern: 'needle',
				paths: ['src', 'README.md'],
			},
		} as any);
		const invocationValue = (prepared.invocationMessage as vscode.MarkdownString).value;

		assert.match(invocationValue, /• Paths: `src, README\.md`/);
	});
});