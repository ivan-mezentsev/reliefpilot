import { spawn } from 'node:child_process';
import type {
  CancellationToken,
  LanguageModelTool,
  LanguageModelToolInvocationOptions,
  LanguageModelToolInvocationPrepareOptions,
  PreparedToolInvocation,
} from 'vscode';
import * as vscode from 'vscode';
import { z } from 'zod';
import { env } from '../utils/env';
import { statusBarActivity } from '../utils/statusBar';

const TOOL_NAME = 'ripgrep';

const DEFAULT_LIMITS = {
  maxMatches: 2000,
  maxFiles: 200,
  maxOutputChars: 200000,
  timeoutMs: 10000,
};

const STDERR_MAX_CHARS = 2000;

const RIPGREP_INSTALL_URL = 'https://github.com/BurntSushi/ripgrep?tab=readme-ov-file#installation';

/**
 * Show a modal asking the user to install ripgrep and wait for a decision.
 * Returns true if the user pressed OK (retry), false if cancelled.
 * The message includes a clickable link and an action to open the installation guide.
 */
async function promptToInstallRipgrep(): Promise<boolean> {
  const message = 'ripgrep (rg) is not found on your system. Please install it and press OK to retry. Installation guide: ' + RIPGREP_INSTALL_URL;
  while (true) {
    const selection = await vscode.window.showInformationMessage(
      message,
      { modal: true, detail: 'ripgrep is used for fast project-wide search.' },
      'Open installation guide',
      'OK',
    );

    if (selection === 'Open installation guide') {
      await vscode.env.openExternal(vscode.Uri.parse(RIPGREP_INSTALL_URL));
      continue;
    }
    if (selection === 'OK') return true;
    return false;
  }
}

export const ripgrepInputSchema = z.object({
  pattern: z.string().min(1).describe('Pattern to search for.'),
  paths: z.array(z.string()).optional().describe('Paths to search (defaults to workspace root).'),
  cwd: z.string().optional().describe('Working directory (defaults to workspace root).'),
  fixedStrings: z.boolean().optional().default(false).describe('Use fixed strings (-F).'),
  caseMode: z.enum(['sensitive', 'ignore', 'smart']).optional().describe('Case matching mode.'),
  detail: z.enum(['summary', 'files', 'lines', 'lines+submatches']).optional().default('lines'),
  glob: z.array(z.string()).optional().describe('Glob patterns mapped to --glob.'),
  type: z.array(z.string()).optional().describe('File types mapped to --type.'),
  typeNot: z.array(z.string()).optional().describe('File types mapped to --type-not.'),
  contextLines: z.number().int().min(0).optional().describe('Context lines mapped to -C.'),
  maxMatches: z.number().int().min(1).optional().default(DEFAULT_LIMITS.maxMatches),
  maxFiles: z.number().int().min(1).optional().default(DEFAULT_LIMITS.maxFiles),
  maxOutputChars: z.number().int().min(1).optional().default(DEFAULT_LIMITS.maxOutputChars),
  timeoutMs: z.number().int().min(0).optional().default(DEFAULT_LIMITS.timeoutMs),
  includeHidden: z.boolean().optional().default(true).describe('Include hidden files (maps to --hidden).'),
  unrestricted: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional().default(3),
  followSymlinks: z.boolean().optional().default(false).describe('Follow symlinks (maps to --follow).'),
});

export type RipgrepInput = z.infer<typeof ripgrepInputSchema>;

interface RipgrepSubmatch {
  match: string;
  start: number;
  end: number;
}

interface RipgrepMatch {
  path: string;
  line_number: number;
  lines: string;
  submatches?: RipgrepSubmatch[];
}

interface RipgrepContextLine {
  path: string;
  line_number: number;
  lines: string;
}

interface RipgrepSummary {
  filesWithMatches: number;
  matchCount: number;
  elapsed?: { secs: number; nanos: number } | null;
  stats?: unknown;
}

interface RipgrepResult {
  tool: 'ripgrep';
  detail: 'summary' | 'files' | 'lines' | 'lines+submatches';
  found: boolean;
  cancelled: boolean;
  timedOut: boolean;
  truncated: boolean;
  truncatedReason?: string;
  limits: {
    maxMatches: number;
    maxFiles: number;
    maxOutputChars: number;
    timeoutMs: number;
  };
  summary: RipgrepSummary;
  files?: string[];
  matches?: RipgrepMatch[];
  context?: RipgrepContextLine[];
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

type RgJsonMessage = {
  type: string;
  data?: any;
};

const decodeTextOrBytes = (value?: { text?: string; bytes?: string }): string | undefined => {
  if (!value) return undefined;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.bytes === 'string') {
    try {
      return Buffer.from(value.bytes, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const buildArgs = (input: RipgrepInput): string[] => {
  const args: string[] = ['--json'];

  if (input.fixedStrings) {
    args.push('-F');
  }

  if (input.caseMode === 'ignore') {
    args.push('-i');
  } else if (input.caseMode === 'smart') {
    args.push('-S');
  }

  if (input.includeHidden) {
    args.push('--hidden');
  }

  if (input.unrestricted === 1) {
    args.push('-u');
  } else if (input.unrestricted === 2) {
    args.push('-uu');
  } else if (input.unrestricted === 3) {
    args.push('-uuu');
  }

  if (input.followSymlinks) {
    args.push('--follow');
  }

  if (typeof input.contextLines === 'number') {
    args.push('-C', String(input.contextLines));
  }

  if (Array.isArray(input.glob)) {
    for (const g of input.glob) {
      if (typeof g === 'string' && g.length > 0) {
        args.push('--glob', g);
      }
    }
  }

  if (Array.isArray(input.type)) {
    for (const t of input.type) {
      if (typeof t === 'string' && t.length > 0) {
        args.push('--type', t);
      }
    }
  }

  if (Array.isArray(input.typeNot)) {
    for (const t of input.typeNot) {
      if (typeof t === 'string' && t.length > 0) {
        args.push('--type-not', t);
      }
    }
  }

  args.push('--', input.pattern);

  if (Array.isArray(input.paths) && input.paths.length > 0) {
    args.push(...input.paths);
  }

  return args;
};

const appendWithLimit = (
  current: string,
  addition: string,
  limit: number,
): { text: string; truncated: boolean } => {
  if (current.length >= limit) {
    return { text: current, truncated: true };
  }
  const remaining = limit - current.length;
  if (addition.length <= remaining) {
    return { text: current + addition, truncated: false };
  }
  return { text: current + addition.slice(0, remaining), truncated: true };
};

const runRipgrep = async (
  input: RipgrepInput,
  token: CancellationToken,
  hasRetried = false,
): Promise<RipgrepResult> => {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    throw new Error('No workspace folder is open.');
  }

  if (token.isCancellationRequested) {
    return {
      tool: 'ripgrep',
      detail: input.detail,
      found: false,
      cancelled: true,
      timedOut: false,
      truncated: false,
      limits: {
        maxMatches: input.maxMatches,
        maxFiles: input.maxFiles,
        maxOutputChars: input.maxOutputChars,
        timeoutMs: input.timeoutMs,
      },
      summary: { filesWithMatches: 0, matchCount: 0, elapsed: null },
      files: input.detail === 'files' ? [] : undefined,
    };
  }

  const args = buildArgs(input);
  const cwd = input.cwd ?? workspaceRoot;

  const matches: RipgrepMatch[] = [];
  const context: RipgrepContextLine[] = [];
  const fileSet = new Set<string>();
  const filesList: string[] = [];
  let summaryData: unknown;

  let found = false;
  let matchCount = 0;
  let cancelled = false;
  let timedOut = false;
  let truncated = false;
  let truncatedReason: string | undefined;
  let parseErrors: string[] = [];

  let stdoutChars = 0;
  let stderrChars = 0;
  let stderrText = '';
  let stderrTruncated = false;

  let spawnError: Error | undefined;
  let exitCode: number | null | undefined;
  let exitSignal: NodeJS.Signals | null | undefined;

  let killRequested = false;

  const child = spawn('rg', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const requestKill = (reason: string) => {
    if (killRequested) return;
    killRequested = true;
    truncatedReason = reason;

    if (reason === 'cancelled') {
      cancelled = true;
    } else if (reason === 'timeout') {
      timedOut = true;
      truncated = true;
    } else {
      truncated = true;
    }

    try {
      child.kill();
    } catch {
      // ignore kill failures
    }
  };

  const totalOutputWithinLimit = (nextChunkLength: number) => {
    const nextTotal = stdoutChars + stderrChars + nextChunkLength;
    return nextTotal <= input.maxOutputChars;
  };

  const processMessage = (message: RgJsonMessage) => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'match') {
      const data = message.data ?? {};
      const path = decodeTextOrBytes(data.path);
      if (!path) return;

      if (!fileSet.has(path)) {
        if (fileSet.size + 1 > input.maxFiles) {
          requestKill('maxFiles');
          return;
        }
        fileSet.add(path);
        if (input.detail === 'files') {
          filesList.push(path);
        }
      }

      matchCount += 1;
      found = true;
      const reachedMatchLimit = matchCount >= input.maxMatches;

      if (input.detail === 'lines' || input.detail === 'lines+submatches') {
        const lines = decodeTextOrBytes(data.lines);
        const lineNumber = typeof data.line_number === 'number' ? data.line_number : undefined;
        if (typeof lines !== 'string' || typeof lineNumber !== 'number') {
          return;
        }

        const submatches: RipgrepSubmatch[] | undefined = input.detail === 'lines+submatches' && Array.isArray(data.submatches)
          ? data.submatches
            .map((sm: any): RipgrepSubmatch | undefined => {
              const matchText = decodeTextOrBytes(sm?.match);
              const start = typeof sm?.start === 'number' ? sm.start : undefined;
              const end = typeof sm?.end === 'number' ? sm.end : undefined;
              if (typeof matchText !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
                return undefined;
              }
              return { match: matchText, start, end };
            })
            .filter((sm: RipgrepSubmatch | undefined): sm is RipgrepSubmatch => Boolean(sm))
          : undefined;

        const match: RipgrepMatch = {
          path,
          line_number: lineNumber,
          lines,
        };
        if (submatches && submatches.length > 0) {
          match.submatches = submatches;
        }
        matches.push(match);
      }

      if (reachedMatchLimit) {
        requestKill('maxMatches');
        return;
      }
    } else if (message.type === 'context') {
      if (input.detail !== 'lines' && input.detail !== 'lines+submatches') {
        return;
      }
      const data = message.data ?? {};
      const path = decodeTextOrBytes(data.path);
      const lines = decodeTextOrBytes(data.lines);
      const lineNumber = typeof data.line_number === 'number' ? data.line_number : undefined;
      if (!path || typeof lines !== 'string' || typeof lineNumber !== 'number') {
        return;
      }
      context.push({ path, line_number: lineNumber, lines });
    } else if (message.type === 'summary') {
      summaryData = message.data ?? {};
    }
  };

  const subscription = token.onCancellationRequested(() => requestKill('cancelled'));

  let buffer = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    if (killRequested) return;
    const text = chunk.toString('utf8');
    stdoutChars += text.length;
    if (!totalOutputWithinLimit(0)) {
      requestKill('maxOutputChars');
      return;
    }

    buffer += text;
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      if (killRequested) {
        buffer = '';
        break;
      }
      const rawLine = buffer.slice(0, idx);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      buffer = buffer.slice(idx + 1);
      if (line.trim().length > 0) {
        try {
          const parsed = JSON.parse(line) as RgJsonMessage;
          processMessage(parsed);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          parseErrors.push(message);
        }
      }
      if (killRequested) {
        buffer = '';
        break;
      }
      idx = buffer.indexOf('\n');
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    if (killRequested) return;
    const text = chunk.toString('utf8');
    stderrChars += text.length;
    if (!totalOutputWithinLimit(0)) {
      requestKill('maxOutputChars');
      return;
    }
    const appended = appendWithLimit(stderrText, text, STDERR_MAX_CHARS);
    stderrText = appended.text;
    if (appended.truncated) {
      stderrTruncated = true;
    }
  });

  child.on('error', (err) => {
    spawnError = err;
  });

  const timeoutId = setTimeout(() => requestKill('timeout'), input.timeoutMs);

  // Wait for either 'close' or an immediate 'error' (e.g. ENOENT when 'rg' is missing)
  await new Promise<void>((resolve) => {
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code;
      exitSignal = signal;
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      spawnError = err;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      child.off('close', onClose);
      child.off('error', onError);
    };
    child.on('close', onClose);
    child.on('error', onError);
  });

  clearTimeout(timeoutId);
  subscription.dispose();

  if (!killRequested && buffer.trim().length > 0) {
    try {
      const parsed = JSON.parse(buffer) as RgJsonMessage;
      processMessage(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      parseErrors.push(message);
    }
  }

  if (spawnError) {
    // Handle missing binary scenario (ENOENT) by prompting the user with a clickable link
    const enoent = (spawnError as any)?.code === 'ENOENT' || /ENOENT/i.test(spawnError.message) || /spawn\s+rg\s+ENOENT/i.test(spawnError.message);
    if (enoent) {
      if (!hasRetried) {
        const retry = await promptToInstallRipgrep();
        if (retry) {
          // Retry once after the user confirms installation
          return await runRipgrep(input, token, true);
        }
        throw new Error('ripgrep is not installed. User cancelled.');
      }
      // Already retried once and still missing
      throw new Error('ripgrep is still not found after retry.');
    }
    throw new Error(`Failed to start rg: ${spawnError.message}`);
  }

  if (!cancelled && !timedOut && !truncated) {
    if (exitCode === 1) {
      found = false;
    } else if (exitCode === 0) {
      found = matchCount > 0 || found;
    } else if (exitCode === 2) {
      const suffix = stderrText
        ? ` stderr: ${stderrText}${stderrTruncated ? '…' : ''}`
        : '';
      throw new Error(`rg failed with exit code 2.${suffix}`);
    } else if (exitCode !== 0 && exitCode !== 1) {
      const suffix = stderrText
        ? ` stderr: ${stderrText}${stderrTruncated ? '…' : ''}`
        : '';
      throw new Error(`rg failed with exit code ${exitCode ?? 'unknown'}.${suffix}`);
    }
  }

  if (parseErrors.length > 0 && !cancelled && !timedOut && !truncated) {
    throw new Error(`rg JSON parse error: ${parseErrors[0]}`);
  }

  const stats = (summaryData as any)?.stats ?? undefined;
  const elapsed = (stats as any)?.elapsed ?? undefined;

  const summary: RipgrepSummary = {
    filesWithMatches: fileSet.size,
    matchCount,
    elapsed: elapsed ?? null,
    stats,
  };

  const result: RipgrepResult = {
    tool: 'ripgrep',
    detail: input.detail,
    found,
    cancelled,
    timedOut,
    truncated,
    truncatedReason,
    limits: {
      maxMatches: input.maxMatches,
      maxFiles: input.maxFiles,
      maxOutputChars: input.maxOutputChars,
      timeoutMs: input.timeoutMs,
    },
    summary,
    files: input.detail === 'files' ? filesList : undefined,
    matches: (input.detail === 'lines' || input.detail === 'lines+submatches') ? matches : undefined,
    context: (input.detail === 'lines' || input.detail === 'lines+submatches') ? context : undefined,
    exitCode,
    signal: exitSignal,
  };

  if (stderrText) {
    result.stderr = stderrTruncated ? `${stderrText}…` : stderrText;
  }

  return result;
};

export class RipgrepLanguageModelTool implements LanguageModelTool<RipgrepInput> {
  async invoke(
    options: LanguageModelToolInvocationOptions<RipgrepInput>,
    token: CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    statusBarActivity.start(TOOL_NAME);
    try {
      const parseResult = await ripgrepInputSchema.safeParseAsync(options.input ?? {});
      if (!parseResult.success) {
        throw new Error(`ripgrep invalid arguments: ${parseResult.error.message}`);
      }

      const result = await runRipgrep(parseResult.data, token);
      const payload = JSON.stringify(result);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(payload)]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${TOOL_NAME} error: ${message}`);
    } finally {
      statusBarActivity.end(TOOL_NAME);
    }
  }

  prepareInvocation(
    options: LanguageModelToolInvocationPrepareOptions<RipgrepInput>,
  ): PreparedToolInvocation {
    const input = options.input ?? {};
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const pattern = typeof input.pattern === 'string' ? input.pattern : '<missing-pattern>';
    const cwd = typeof input.cwd === 'string' ? input.cwd : workspaceRoot ?? '<no-workspace>';
    const paths = Array.isArray(input.paths) ? input.paths : [];
    const maxMatches = typeof input.maxMatches === 'number' ? input.maxMatches : DEFAULT_LIMITS.maxMatches;
    const maxFiles = typeof input.maxFiles === 'number' ? input.maxFiles : DEFAULT_LIMITS.maxFiles;
    const maxOutputChars = typeof input.maxOutputChars === 'number' ? input.maxOutputChars : DEFAULT_LIMITS.maxOutputChars;
    const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : DEFAULT_LIMITS.timeoutMs;
    const detail = typeof input.detail === 'string' ? input.detail : 'lines';

    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = true;
    md.isTrusted = true;

    const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png');
    md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `);
    md.appendMarkdown(`Relief Pilot · **ripgrep**\n`);
    md.appendMarkdown(`- Pattern: \`${pattern}\`  \n`);
    md.appendMarkdown(`- CWD: \`${cwd}\`  \n`);
    if (paths.length > 0) {
      md.appendMarkdown(`- Paths: \`${paths.join(', ')}\`  \n`);
    }
    md.appendMarkdown(`- Detail: \`${detail}\`  \n`);
    md.appendMarkdown(`- Limits: matches=${maxMatches}, files=${maxFiles}, outputChars=${maxOutputChars}, timeoutMs=${timeoutMs}  \n`);

    return { invocationMessage: md };
  }
}