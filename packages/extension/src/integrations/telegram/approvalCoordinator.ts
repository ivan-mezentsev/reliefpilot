import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

export type ConfirmationMode = 'vscode' | 'telegram' | 'both' | 'auto';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';
export type ApprovalResolutionSource = 'vscode' | 'telegram';

export interface PendingApprovalRequest {
  approvalId: string;
  command: string;
  originalCommand: string;
  destructive: boolean;
  customCwd: string | null;
  status: ApprovalStatus;
  resolutionSource: ApprovalResolutionSource | null;
  feedback: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  telegramMessages: Array<{ chatId: number; messageId: number }>;
}

export interface ApprovalResolution {
  approved: boolean;
  updatedCommand: string | null;
  feedback: string | null;
  source: ApprovalResolutionSource;
}

export interface CreateApprovalRequestInput {
  command: string;
  destructive: boolean;
  customCwd?: string | null;
}

export interface ApprovalResolvedEvent {
  request: PendingApprovalRequest;
  resolution: ApprovalResolution;
}

export interface ApprovalSessionHooks {
  applyExternalResolution(resolution: ApprovalResolution): void;
}

export interface ApprovalResolveResult {
  state: 'resolved' | 'already-resolved' | 'not-found';
  request?: PendingApprovalRequest;
  resolution?: ApprovalResolution;
}

interface PendingDenialFeedback {
  approvalId: string;
  userId: number;
  chatId: number;
}

interface ApprovalEntry {
  request: PendingApprovalRequest;
  resolutionPromise: Promise<ApprovalResolution>;
  resolveResolution: (resolution: ApprovalResolution) => void;
  vscodeSession?: ApprovalSessionHooks;
  pendingDenialFeedback?: PendingDenialFeedback;
  resolution?: ApprovalResolution;
}

/**
 * Coordinates approval state shared between VS Code and Telegram.
 * The first successful resolution wins, while later responses are reported as
 * already resolved so both surfaces stay consistent.
 */
export class ApprovalCoordinator implements vscode.Disposable {
  private readonly approvals = new Map<string, ApprovalEntry>();
  private readonly denialFeedbackByUser = new Map<number, PendingDenialFeedback>();
  private readonly onResolvedEmitter = new vscode.EventEmitter<ApprovalResolvedEvent>();

  public readonly onResolved = this.onResolvedEmitter.event;

  public createRequest(input: CreateApprovalRequestInput): PendingApprovalRequest {
    // Each approval request keeps enough context to update both the original
    // command session and any Telegram message copies.
    const approvalId = randomUUID();
    const request: PendingApprovalRequest = {
      approvalId,
      command: input.command,
      originalCommand: input.command,
      destructive: input.destructive,
      customCwd: input.customCwd ?? null,
      status: 'pending',
      resolutionSource: null,
      feedback: null,
      createdAt: new Date(),
      resolvedAt: null,
      telegramMessages: [],
    };

    let resolveResolution!: (resolution: ApprovalResolution) => void;
    const resolutionPromise = new Promise<ApprovalResolution>((resolve) => {
      resolveResolution = resolve;
    });

    this.approvals.set(approvalId, {
      request,
      resolutionPromise,
      resolveResolution,
    });

    return request;
  }

  public getRequest(approvalId: string): PendingApprovalRequest | undefined {
    return this.approvals.get(approvalId)?.request;
  }

  public waitForResolution(approvalId: string): Promise<ApprovalResolution> {
    const entry = this.approvals.get(approvalId);
    if (!entry) {
      return Promise.reject(new Error(`Unknown approval request: ${approvalId}`));
    }

    if (entry.resolution) {
      return Promise.resolve(entry.resolution);
    }

    return entry.resolutionPromise;
  }

  public attachVscodeSession(approvalId: string, session: ApprovalSessionHooks): boolean {
    const entry = this.approvals.get(approvalId);
    if (!entry) {
      return false;
    }

    entry.vscodeSession = session;
    if (entry.resolution && entry.resolution.source === 'telegram') {
      session.applyExternalResolution(entry.resolution);
    }
    return true;
  }

  public registerTelegramMessage(approvalId: string, chatId: number, messageId: number): boolean {
    const entry = this.approvals.get(approvalId);
    if (!entry) {
      return false;
    }

    entry.request.telegramMessages.push({ chatId, messageId });
    return true;
  }

  public beginTelegramDenialFeedback(approvalId: string, userId: number, chatId: number): ApprovalResolveResult {
    // Telegram denials are two-step: first mark the request as awaiting optional
    // feedback, then resolve when the user replies or explicitly skips.
    const entry = this.approvals.get(approvalId);
    if (!entry) {
      return { state: 'not-found' };
    }

    if (entry.request.status !== 'pending') {
      return {
        state: 'already-resolved',
        request: entry.request,
        resolution: entry.resolution,
      };
    }

    const pending: PendingDenialFeedback = { approvalId, userId, chatId };
    entry.pendingDenialFeedback = pending;
    this.denialFeedbackByUser.set(userId, pending);

    return {
      state: 'resolved',
      request: entry.request,
    };
  }

  public getPendingDenialFeedback(userId: number): PendingDenialFeedback | undefined {
    return this.denialFeedbackByUser.get(userId);
  }

  public resolveTelegramDenialFeedback(userId: number, feedback?: string | null): ApprovalResolveResult {
    const pending = this.denialFeedbackByUser.get(userId);
    if (!pending) {
      return { state: 'not-found' };
    }

    this.clearPendingDenialFeedback(pending.approvalId, userId);
    return this.resolve(pending.approvalId, {
      approved: false,
      feedback: feedback ?? null,
      source: 'telegram',
    });
  }

  public skipTelegramDenialFeedback(approvalId: string, userId: number): ApprovalResolveResult {
    this.clearPendingDenialFeedback(approvalId, userId);
    return this.resolve(approvalId, {
      approved: false,
      feedback: null,
      source: 'telegram',
    });
  }

  public resolve(
    approvalId: string,
    resolution: Omit<ApprovalResolution, 'updatedCommand'> & { updatedCommand?: string | null },
  ): ApprovalResolveResult {
    // This method is intentionally idempotent from the caller's point of view:
    // once a request leaves `pending`, follow-up responses cannot overwrite it.
    const entry = this.approvals.get(approvalId);
    if (!entry) {
      return { state: 'not-found' };
    }

    if (entry.request.status !== 'pending') {
      return {
        state: 'already-resolved',
        request: entry.request,
        resolution: entry.resolution,
      };
    }

    const finalResolution: ApprovalResolution = {
      approved: resolution.approved,
      updatedCommand: resolution.updatedCommand ?? null,
      feedback: resolution.feedback ?? null,
      source: resolution.source,
    };

    entry.request.status = finalResolution.approved ? 'approved' : 'denied';
    entry.request.command = finalResolution.updatedCommand ?? entry.request.command;
    entry.request.feedback = finalResolution.feedback;
    entry.request.resolutionSource = finalResolution.source;
    entry.request.resolvedAt = new Date();
    entry.resolution = finalResolution;

    if (entry.pendingDenialFeedback) {
      this.clearPendingDenialFeedback(entry.pendingDenialFeedback.approvalId, entry.pendingDenialFeedback.userId);
    }

    if (finalResolution.source === 'telegram' && entry.vscodeSession) {
      entry.vscodeSession.applyExternalResolution(finalResolution);
    }

    entry.resolveResolution(finalResolution);
    this.onResolvedEmitter.fire({
      request: { ...entry.request, telegramMessages: [...entry.request.telegramMessages] },
      resolution: finalResolution,
    });

    return {
      state: 'resolved',
      request: entry.request,
      resolution: finalResolution,
    };
  }

  private clearPendingDenialFeedback(approvalId: string, userId: number): void {
    const pending = this.denialFeedbackByUser.get(userId);
    if (pending && pending.approvalId === approvalId) {
      this.denialFeedbackByUser.delete(userId);
    }

    const entry = this.approvals.get(approvalId);
    if (entry?.pendingDenialFeedback?.userId === userId) {
      entry.pendingDenialFeedback = undefined;
    }
  }

  public dispose(): void {
    this.approvals.clear();
    this.denialFeedbackByUser.clear();
    this.onResolvedEmitter.dispose();
  }
}
