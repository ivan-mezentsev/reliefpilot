import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export type MediaTransferDirection = 'inbound' | 'outbound';
export type MediaTransferStatus = 'received' | 'staged' | 'sent' | 'rejected' | 'failed';

export interface MediaTransfer {
  transferId: string;
  direction: MediaTransferDirection;
  userId: number;
  chatId: number;
  fileName: string;
  mimeType: string | null;
  localPath: string | null;
  telegramFileId: string | null;
  status: MediaTransferStatus;
  errorMessage: string | null;
  createdAt: Date;
}

export interface InboundDocumentValidationInput {
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
}

export interface InboundDocumentValidationResult {
  ok: boolean;
  message?: string;
}

export interface StageInboundBufferInput {
  userId: number;
  chatId: number;
  fileName: string;
  mimeType?: string | null;
  telegramFileId?: string | null;
  buffer: Buffer;
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * Tracks Telegram file transfers and stages inbound files in a workspace-scoped
 * temporary directory so local workflows can consume them safely.
 */
export class TelegramMediaStore {
  private readonly transfers = new Map<string, MediaTransfer>();

  constructor(
    private readonly outputChannel: vscode.OutputChannel,
    private readonly maxFileSizeBytes: number = DEFAULT_MAX_FILE_SIZE_BYTES,
  ) { }

  public validateInboundDocument(input: InboundDocumentValidationInput): InboundDocumentValidationResult {
    // Validation is intentionally lightweight: workspace availability, filename,
    // and size limits are enough for the first iteration of Telegram media flows.
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return {
        ok: false,
        message: 'No active workspace is available, so the file cannot be staged right now.',
      };
    }

    const fileName = (input.fileName ?? '').trim();
    if (!fileName) {
      return {
        ok: false,
        message: 'The uploaded file is missing a usable filename.',
      };
    }

    if (typeof input.fileSize === 'number' && input.fileSize > this.maxFileSizeBytes) {
      return {
        ok: false,
        message: `File is too large. The current limit is ${Math.round(this.maxFileSizeBytes / (1024 * 1024))} MB.`,
      };
    }

    return { ok: true };
  }

  public async stageInboundBuffer(input: StageInboundBufferInput): Promise<MediaTransfer> {
    // Inbound files are copied into a deterministic temp area instead of being
    // referenced through Telegram URLs later, which keeps workflows offline-safe.
    const validation = this.validateInboundDocument({
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileSize: input.buffer.byteLength,
    });

    if (!validation.ok) {
      throw new Error(validation.message ?? 'The uploaded file could not be staged.');
    }

    const transferId = randomUUID();
    const stagedDir = await this.ensureStageDirectory();
    const safeFileName = sanitizeFileName(input.fileName);
    const localPath = path.join(stagedDir, `${transferId}-${safeFileName}`);

    const transfer: MediaTransfer = {
      transferId,
      direction: 'inbound',
      userId: input.userId,
      chatId: input.chatId,
      fileName: safeFileName,
      mimeType: input.mimeType ?? null,
      localPath,
      telegramFileId: input.telegramFileId ?? null,
      status: 'received',
      errorMessage: null,
      createdAt: new Date(),
    };

    this.transfers.set(transferId, transfer);

    try {
      await fs.writeFile(localPath, input.buffer);
      transfer.status = 'staged';
      this.outputChannel.appendLine(`[Telegram] Staged inbound file ${safeFileName} at ${localPath}`);
      return { ...transfer };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      transfer.status = 'failed';
      transfer.errorMessage = message;
      this.outputChannel.appendLine(`[Telegram] Failed to stage inbound file ${safeFileName}: ${message}`);
      throw err;
    }
  }

  public async beginOutboundTransfer(userId: number, chatId: number, filePath: string, mimeType?: string | null): Promise<MediaTransfer> {
    // Outbound transfers are recorded before the send so failures can still be
    // surfaced back to the user and to logs with a stable transfer id.
    const fileName = path.basename(filePath);
    const transferId = randomUUID();

    await fs.access(filePath);

    const transfer: MediaTransfer = {
      transferId,
      direction: 'outbound',
      userId,
      chatId,
      fileName,
      mimeType: mimeType ?? null,
      localPath: filePath,
      telegramFileId: null,
      status: 'staged',
      errorMessage: null,
      createdAt: new Date(),
    };

    this.transfers.set(transferId, transfer);
    return { ...transfer };
  }

  public markSent(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      return;
    }

    transfer.status = 'sent';
    transfer.errorMessage = null;
  }

  public markFailed(transferId: string, errorMessage: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      return;
    }

    transfer.status = 'failed';
    transfer.errorMessage = errorMessage;
  }

  public markRejected(transferId: string, errorMessage: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      return;
    }

    transfer.status = 'rejected';
    transfer.errorMessage = errorMessage;
  }

  public getTransfer(transferId: string): MediaTransfer | undefined {
    const transfer = this.transfers.get(transferId);
    return transfer ? { ...transfer } : undefined;
  }

  public listTransfers(): MediaTransfer[] {
    return [...this.transfers.values()].map((transfer) => ({ ...transfer }));
  }

  public listInboundTransfers(): MediaTransfer[] {
    return this.listTransfers().filter((transfer) => transfer.direction === 'inbound');
  }

  private async ensureStageDirectory(): Promise<string> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error('No active workspace is available, so the file cannot be staged right now.');
    }

    const workspaceName = sanitizeFileName(path.basename(workspaceRoot) || 'workspace');
    const stageDir = path.join(os.tmpdir(), 'reliefpilot-telegram-media', workspaceName);
    await fs.mkdir(stageDir, { recursive: true });
    return stageDir;
  }

  private getWorkspaceRoot(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).trim();
  const sanitized = base.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return sanitized || 'telegram-file';
}
