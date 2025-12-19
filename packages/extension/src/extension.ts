import * as vscode from 'vscode';
import { CREATE_SPECS_MODE_COMMAND, registerSpecsModeCommand } from './specsMode';
import { AiFetchUrlLanguageModelTool } from './tools/ai_fetch_url';
import { AskReportLanguageModelTool, openOrFocusAskReportById } from './tools/ask_report';
import { CodeCheckerLanguageModelTool } from './tools/code_checker';
import { Context7GetLibraryDocsTool } from './tools/context7_get_library_docs';
import { Context7ResolveLibraryIdTool } from './tools/context7_resolve_library_id';
import { DuckDuckGoSearchTool } from './tools/duckduckgo_search';
import { ExecuteCommandLanguageModelTool } from './tools/execute_command';
import { FeloSearchTool } from './tools/felo_search';
import { FocusEditorLanguageModelTool } from './tools/focus_editor';
import { GetTerminalOutputLanguageModelTool } from './tools/get_terminal_output';
import { GithubGetDirectoryContentsTool } from './tools/github_get_directory_contents';
import { GithubGetFileContentsTool } from './tools/github_get_file_contents';
import { GithubGetLatestReleaseTool } from './tools/github_get_latest_release';
import { GithubIssueReadTool } from './tools/github_issue_read';
import { GithubListIssuesTool } from './tools/github_list_issues';
import { GithubListPullRequestsTool } from './tools/github_list_pull_requests';
import { GithubListReleasesTool } from './tools/github_list_releases';
import { GithubPullRequestReadTool } from './tools/github_pull_request_read';
import { GithubSearchCodeTool } from './tools/github_search_code';
import { GithubSearchIssuesTool } from './tools/github_search_issues';
import { GithubSearchRepositoriesTool } from './tools/github_search_repositories';
import { GoogleSearchTool } from './tools/google_search';
import { openAiFetchProgressPanelByUid } from './utils/ai_fetch_progress';
import { initAiFetchSessionStorage, registerAiFetchSessionConfigWatcher } from './utils/ai_fetch_sessions';
import { askReportHistory, formatTimestampSeconds, initAskReportHistoryStorage, registerAskReportHistoryConfigWatcher } from './utils/ask_report_history';
import { hasContext7Token, initContext7Auth, setupOrUpdateContext7Token } from './utils/context7_auth';
import { openContext7ContentPanelByUid } from './utils/context7_content_panel';
import { initContext7SessionStorage, registerContext7SessionConfigWatcher } from './utils/context7_content_sessions';
import { openDuckDuckGoContentPanelByUid } from './utils/duckduckgo_search_content_panel';
import { initDuckDuckGoSessionStorage, registerDuckDuckGoSessionConfigWatcher } from './utils/duckduckgo_search_content_sessions';
import { env, initEnv } from './utils/env';
import { openFeloContentPanelByUid } from './utils/felo_search_content_panel';
import { initFeloSessionStorage, registerFeloSessionConfigWatcher } from './utils/felo_search_content_sessions';
import { hasGitHubToken, initGitHubAuth, setupOrUpdateGitHubToken } from './utils/github_auth';
import { openGithubContentPanelByUid } from './utils/github_content_panel';
import { initGithubSessionStorage, registerGithubSessionConfigWatcher } from './utils/github_content_sessions';
import { hasGoogleApiKey, hasGoogleSearchEngineId, initGoogleAuth, setupOrUpdateGoogleApiKey, setupOrUpdateGoogleSearchEngineId } from './utils/google_search_auth';
import { openGoogleContentPanelByUid } from './utils/google_search_content_panel';
import { initGoogleSessionStorage, registerGoogleSessionConfigWatcher } from './utils/google_search_content_sessions';
import { statusBarActivity } from './utils/statusBar';

const STATUS_MENU_COMMAND = 'reliefpilot.status.menu';
const SHOW_ASK_REPORT_HISTORY_COMMAND = 'reliefpilot.askReport.showHistory';
const SELECT_AI_FETCH_URL_MODEL_LABEL = 'Select Model for `ai_fetch_url`';

const extensionDisplayName = 'Relief Pilot';

// Relief Pilot status bar item (always visible)
let serverStatusBarItem: vscode.StatusBarItem;

// Static Relief Pilot status bar rendering
function showServerStatusBar() {
  if (!serverStatusBarItem) {
    return;
  }

  serverStatusBarItem.text = '$(reliefpilot-logo) RP';
  // Clicking the status bar opens Relief Pilot menu
  serverStatusBarItem.command = STATUS_MENU_COMMAND;
  serverStatusBarItem.show();
}

async function showReliefPilotMenu() {
  // Build dynamic label for History with current count
  const historyCount = askReportHistory.list().length;
  const historyMenuLabel = `History "ask_report" (${historyCount})`;

  // Detect whether tokens are already stored
  const context7TokenExists = await hasContext7Token();
  const githubTokenExists = await hasGitHubToken();
  const googleApiKeyExists = await hasGoogleApiKey();
  const googleSearchEngineIdExists = await hasGoogleSearchEngineId();
  const tokenMenuLabel = context7TokenExists
    ? 'Update API-token `context7`'
    : 'Setup API-token `context7`';
  const githubTokenMenuLabel = githubTokenExists
    ? 'Update API-token `github`'
    : 'Setup API-token `github`';
  const googleApiKeyMenuLabel = googleApiKeyExists
    ? 'Update API-token `GOOGLE_API_KEY`'
    : 'Setup API-token `GOOGLE_API_KEY`';
  const googleSearchEngineIdMenuLabel = googleSearchEngineIdExists
    ? 'Update API-token `GOOGLE_SEARCH_ENGINE_ID`'
    : 'Setup API-token `GOOGLE_SEARCH_ENGINE_ID`';

  const items: vscode.QuickPickItem[] = [
    {
      label: 'Relief Pilot Settings',
      description: 'Open VS Code Settings filtered by @reliefpilot',
    },
    {
      label: SELECT_AI_FETCH_URL_MODEL_LABEL,
      description: 'Select from all available VS Code chat models and store it in settings',
    },
    {
      label: historyMenuLabel,
      description: 'Show last ask_report entries from memory',
    },
    {
      label: 'Create Specs Mode',
      description: 'Copy bundled Spec.chatmode.md into your prompts folder',
    },
    {
      label: tokenMenuLabel,
      description: context7TokenExists ? 'Change stored Context7 API token' : 'Store a new Context7 API token securely',
    },
    {
      label: githubTokenMenuLabel,
      description: githubTokenExists ? 'Change stored GitHub API token' : 'Store a new GitHub API token securely',
    },
    {
      label: googleApiKeyMenuLabel,
      description: googleApiKeyExists ? 'Change stored Google API token `GOOGLE_API_KEY`' : 'Store a new Google API token `GOOGLE_API_KEY` securely',
    },
    {
      label: googleSearchEngineIdMenuLabel,
      description: googleSearchEngineIdExists ? 'Change stored Google API token `GOOGLE_SEARCH_ENGINE_ID`' : 'Store a new Google API token `GOOGLE_SEARCH_ENGINE_ID` securely',
    },
  ];

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Relief Pilot menu',
    ignoreFocusOut: true,
  });
  if (!pick) return;

  if (pick.label === 'Relief Pilot Settings') {
    try {
      await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${env.extensionId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to open settings: ${message}`);
    }
  } else if (pick.label === SELECT_AI_FETCH_URL_MODEL_LABEL) {
    await selectModelForAiFetchUrl();
  } else if (pick.label === historyMenuLabel || pick.label.startsWith('History "ask_report"')) {
    await showAskReportHistoryMenu();
  } else if (pick.label === 'Create Specs Mode') {
    await vscode.commands.executeCommand(CREATE_SPECS_MODE_COMMAND);
  } else if (pick.label === tokenMenuLabel) {
    await setupOrUpdateContext7Token();
  } else if (pick.label === githubTokenMenuLabel) {
    await setupOrUpdateGitHubToken();
  } else if (pick.label === googleApiKeyMenuLabel) {
    await setupOrUpdateGoogleApiKey();
  } else if (pick.label === googleSearchEngineIdMenuLabel) {
    await setupOrUpdateGoogleSearchEngineId();
  }
}

async function showAskReportHistoryMenu() {
  const refreshItems = (): Array<vscode.QuickPickItem & { id: string }> => {
    const entries = askReportHistory.list();
    return entries.map((e) => ({
      id: e.id,
      label: `${formatTimestampSeconds(e.timestamp)} ${e.topic}`,
      buttons: [deleteButton],
    }));
  };

  const deleteButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('trash'),
    tooltip: 'Delete this entry',
  };

  const entries = askReportHistory.list();
  if (!entries || entries.length === 0) {
    vscode.window.showInformationMessage('No ask_report history yet.');
    return;
  }

  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
  qp.title = 'Ask Report History';
  qp.placeholder = 'Select an ask_report entry to view';
  qp.ignoreFocusOut = true;
  qp.items = refreshItems();

  const dispose = () => {
    try { qp.hide(); } catch { }
    try { qp.dispose(); } catch { }
  };

  qp.onDidTriggerItemButton((e) => {
    if (e.button === deleteButton) {
      const id = (e.item as any).id as string | undefined;
      if (!id) return;
      const ok = askReportHistory.removeById(id);
      if (ok) {
        const next = refreshItems();
        if (next.length === 0) {
          vscode.window.showInformationMessage('No ask_report history left.');
          dispose();
          return;
        }
        qp.items = next;
      }
    }
  });

  qp.onDidAccept(async () => {
    const chosen = qp.selectedItems[0] as (vscode.QuickPickItem & { id?: string }) | undefined;
    if (!chosen || !chosen.id) {
      dispose();
      return;
    }
    const entry = askReportHistory.getById(chosen.id);
    dispose();
    if (!entry) return;
    await openOrFocusAskReportById(entry.id);
  });

  qp.onDidHide(() => {
    dispose();
  });

  qp.show();
}

async function selectModelForAiFetchUrl() {
  if (!vscode.lm) {
    vscode.window.showErrorMessage('Language model APIs are unavailable in this VS Code instance.');
    return;
  }
  let models: vscode.LanguageModelChat[] = [];
  try {
    // When selector is omitted, VS Code returns all available chat models across all providers.
    models = await vscode.lm.selectChatModels();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to resolve available models: ${message}`);
    return;
  }
  if (!models || models.length === 0) {
    vscode.window.showInformationMessage('No chat models available.');
    return;
  }

  // Make the list stable and easier to scan.
  models = [...models].sort((a, b) => {
    const av = (a.vendor ?? '').localeCompare(b.vendor ?? '');
    if (av !== 0) return av;
    const an = (a.name ?? '').localeCompare(b.name ?? '');
    if (an !== 0) return an;
    return (a.id ?? '').localeCompare(b.id ?? '');
  });

  // Read currently selected model from settings and mark it in the pick list
  const config = vscode.workspace.getConfiguration('reliefpilot');
  const currentModelId = config.get<string>('AiFetchUrlModel');

  const picks = models.map((m): vscode.QuickPickItem & { id: string } => ({
    id: m.id,
    label: `${m.vendor} · ${m.name}${m.id === currentModelId ? ' [Selected]' : ''}`,
    description: `${m.family}${m.version ? ` · ${m.version}` : ''}`,
    detail: `id: ${m.id}`,
  }));

  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Select model for ai_fetch_url',
    ignoreFocusOut: true,
  });
  if (!chosen) {
    return; // user canceled
  }

  try {
    await vscode.workspace
      .getConfiguration('reliefpilot')
      .update('AiFetchUrlModel', chosen.id, vscode.ConfigurationTarget.Global);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to update reliefpilot.AiFetchUrlModel: ${message}`);
  }
}


export const activate = async (context: vscode.ExtensionContext) => {
  // Create the output channel for logging
  const outputChannel = vscode.window.createOutputChannel(extensionDisplayName);
  outputChannel.appendLine(`Activating ${extensionDisplayName}...`);

  // Initialize shared environment (extensionUri, extensionId)
  initEnv(context);
  // Initialize auth modules
  initContext7Auth(context);
  initGitHubAuth(context);
  initGoogleAuth(context);
  // Initialize ask_report history storage (load from workspace storage)
  initAskReportHistoryStorage(context);
  // Initialize session storage
  initAiFetchSessionStorage(context);
  initContext7SessionStorage(context);
  initDuckDuckGoSessionStorage(context);
  initFeloSessionStorage(context);
  initGithubSessionStorage(context);
  initGoogleSessionStorage(context);
  // Watchers for dynamic limit application on configuration change
  registerAiFetchSessionConfigWatcher(context);
  registerContext7SessionConfigWatcher(context);
  registerDuckDuckGoSessionConfigWatcher(context);
  registerFeloSessionConfigWatcher(context);
  registerGithubSessionConfigWatcher(context);
  registerGoogleSessionConfigWatcher(context);

  if (vscode.lm) {
    try {
      const disposable = vscode.lm.registerTool(
        'ask_report',
        new AskReportLanguageModelTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: ask_report.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool ask_report: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'code_checker',
        new CodeCheckerLanguageModelTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: code_checker.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool code_checker: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'focus_editor',
        new FocusEditorLanguageModelTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: focus_editor.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool focus_editor: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'execute_command',
        new ExecuteCommandLanguageModelTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: execute_command.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool execute_command: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'get_terminal_output',
        new GetTerminalOutputLanguageModelTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: get_terminal_output.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool get_terminal_output: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'ai_fetch_url',
        new AiFetchUrlLanguageModelTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: ai_fetch_url.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool ai_fetch_url: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'context7_resolve-library-id',
        new Context7ResolveLibraryIdTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: context7_resolve-library-id.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool context7_resolve-library-id: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'context7_get-library-docs',
        new Context7GetLibraryDocsTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: context7_get-library-docs.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool context7_get-library-docs: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'github_search_repositories',
        new GithubSearchRepositoriesTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: github_search_repositories.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool github_search_repositories: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'github_get_file_contents',
        new GithubGetFileContentsTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: github_get_file_contents.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool github_get_file_contents: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'github_get_directory_contents',
        new GithubGetDirectoryContentsTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: github_get_directory_contents.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool github_get_directory_contents: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'github_search_code',
        new GithubSearchCodeTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: github_search_code.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool github_search_code: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'google_search',
        new GoogleSearchTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: google_search.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool google_search: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const disposable = vscode.lm.registerTool(
        'felo_search',
        new FeloSearchTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: felo_search.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool felo_search: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'duckduckgo_search',
        new DuckDuckGoSearchTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: duckduckgo_search.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool duckduckgo_search: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'github_list_releases',
        new GithubListReleasesTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: github_list_releases.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool github_list_releases: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'github_get_latest_release',
        new GithubGetLatestReleaseTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: github_get_latest_release.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool github_get_latest_release: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'github_search_issues',
        new GithubSearchIssuesTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: github_search_issues.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool github_search_issues: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'github_list_issues',
        new GithubListIssuesTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: github_list_issues.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool github_list_issues: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'github_issue_read',
        new GithubIssueReadTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: github_issue_read.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool github_issue_read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'github_list_pull_requests',
        new GithubListPullRequestsTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: github_list_pull_requests.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool github_list_pull_requests: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const disposable = vscode.lm.registerTool(
        'github_pull_request_read',
        new GithubPullRequestReadTool(),
      );
      context.subscriptions.push(disposable);
      outputChannel.appendLine('Registered language model tool: github_pull_request_read.');
    } catch (err) {
      outputChannel.appendLine(
        `Failed to register language model tool github_pull_request_read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    outputChannel.appendLine('Language model APIs unavailable; skipping language model tool registrations.');
  }

  // Create status bar item with a stable identifier; place it on the left with priority -100
  serverStatusBarItem = vscode.window.createStatusBarItem('reliefpilot.status', vscode.StatusBarAlignment.Left, -100);
  context.subscriptions.push(serverStatusBarItem);
  // Initialize activity tracker with the created status bar item and render initial state
  statusBarActivity.init(serverStatusBarItem);
  // Register command that the status bar item invokes to show the Relief Pilot menu
  context.subscriptions.push(
    vscode.commands.registerCommand(STATUS_MENU_COMMAND, () => showReliefPilotMenu()),
    // Public command to open ask_report history menu (bindable to keybindings)
    vscode.commands.registerCommand(SHOW_ASK_REPORT_HISTORY_COMMAND, () => showAskReportHistoryMenu()),
    // Internal command (not contributed) for possible programmatic usage/tests
    vscode.commands.registerCommand('reliefpilot.context7.setupToken', () => setupOrUpdateContext7Token()),
    vscode.commands.registerCommand('reliefpilot.github.setupToken', () => setupOrUpdateGitHubToken()),
    vscode.commands.registerCommand('reliefpilot.google.setupApiKey', () => setupOrUpdateGoogleApiKey()),
    vscode.commands.registerCommand('reliefpilot.google.setupSearchEngineId', () => setupOrUpdateGoogleSearchEngineId()),
  );
  registerSpecsModeCommand(context);
  showServerStatusBar();

  // Command: open AI Fetch progress webview (shown from Markdown command link)
  context.subscriptions.push(
    vscode.commands.registerCommand('reliefpilot.aiFetchUrl.showProgress', async (args?: { uid?: string }) => {
      await openAiFetchProgressPanelByUid(args?.uid ?? '');
    })
  );

  // Command: open Context7 content webview (shown from Markdown command link for both Context7 tools)
  context.subscriptions.push(
    vscode.commands.registerCommand('reliefpilot.context7.showContent', async (args?: { uid?: string }) => {
      await openContext7ContentPanelByUid(args?.uid ?? '');
    })
  );

  // Command: open GitHub content webview (shown from Markdown command link for GitHub tools)
  context.subscriptions.push(
    vscode.commands.registerCommand('reliefpilot.github.showContent', async (args?: { uid?: string }) => {
      await openGithubContentPanelByUid(args?.uid ?? '');
    })
  );

  // Command: open Google content webview (shown from Markdown command link for Google tools)
  context.subscriptions.push(
    vscode.commands.registerCommand('reliefpilot.google.showContent', async (args?: { uid?: string }) => {
      await openGoogleContentPanelByUid(args?.uid ?? '');
    })
  );

  // Command: open Felo content webview (shown from Markdown command link for Felo tool)
  context.subscriptions.push(
    vscode.commands.registerCommand('reliefpilot.felo.showContent', async (args?: { uid?: string }) => {
      await openFeloContentPanelByUid(args?.uid ?? '');
    })
  );

  // Command: open DuckDuckGo content webview (shown from Markdown command link for DuckDuckGo tool)
  context.subscriptions.push(
    vscode.commands.registerCommand('reliefpilot.duckduckgo.showContent', async (args?: { uid?: string }) => {
      await openDuckDuckGoContentPanelByUid(args?.uid ?? '');
    })
  );

  // Command: focus or open Ask Report webview by UID (shown from Markdown command link)
  context.subscriptions.push(
    vscode.commands.registerCommand('reliefpilot.askReport.showReport', async (args?: { uid?: string }) => {
      const uid = args?.uid ?? '';
      if (!uid) return;
      await openOrFocusAskReportById(uid);
    })
  );

  // Watch ask_report history size changes
  registerAskReportHistoryConfigWatcher(context);

  outputChannel.appendLine(`${extensionDisplayName} activated.`);
};

export function deactivate() {
  // Clean-up is managed by the disposables added in the activate method.
}
