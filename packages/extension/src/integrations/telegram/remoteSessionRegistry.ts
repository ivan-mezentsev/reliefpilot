import { randomUUID } from 'node:crypto'

export type RemoteSessionStatus = 'active' | 'paused' | 'completed' | 'cancelled'
export type RemoteInboxItemKind = 'ask_report' | 'approval' | 'status' | 'completion' | 'failure' | 'diff-summary' | 'artifact'
export type RemoteInboxItemStatus = 'pending' | 'resolved' | 'expired' | 'superseded' | 'informational' | 'failed'
export type AskReportBindingStatus = 'pending' | 'resolved' | 'expired'
export type AskReportAnswerMode = 'predefined' | 'freeform' | 'mixed'

export interface RemoteSession {
  sessionId: string
  title: string
  status: RemoteSessionStatus
  workspacePath: string | null
  latestInboxItemId: string | null
  lastActivityAt: Date
}

export interface RemoteInboxItem {
  inboxItemId: string
  sessionId: string
  kind: RemoteInboxItemKind
  status: RemoteInboxItemStatus
  title: string
  summary: string
  createdAt: Date
  resolvedAt: Date | null
}

export interface AskReportBinding {
  reportId: string
  sessionId: string
  inboxItemId: string
  answerMode: AskReportAnswerMode
  status: AskReportBindingStatus
}

export interface RegisterAskReportInput {
  reportId: string
  topicName: string
  message: string
  options?: string[]
  sessionId?: string
  sessionTitle: string
  workspacePath?: string | null
}

export interface RegisterApprovalInput {
  approvalId: string
  command: string
  destructive: boolean
  customCwd?: string | null
  sessionId?: string
  sessionTitle: string
  workspacePath?: string | null
}

export interface RegisterRemoteItemInput {
  kind: RemoteInboxItemKind
  title: string
  summary: string
  status: RemoteInboxItemStatus
  sessionId?: string
  sessionTitle: string
  workspacePath?: string | null
}

export interface RegisterRemoteItemResult {
  session: RemoteSession
  item: RemoteInboxItem
}

export interface StoredDiffSnapshot {
  diffId: string
  sessionId: string
  source: 'git-worktree' | 'unavailable'
  summary: string
  fullArtifactPath: string | null
  fingerprint: string | null
  createdAt: Date
  status: 'ready' | 'unavailable' | 'stale'
}

export type TelegramNotificationMode = 'all' | 'actionable'

export class RemoteSessionRegistry {
  private readonly sessions = new Map<string, RemoteSession>()
  private readonly inboxItems = new Map<string, RemoteInboxItem>()
  private readonly askReportBindings = new Map<string, AskReportBinding>()
  private readonly approvalInboxItemIds = new Map<string, string>()
  private readonly diffSnapshots = new Map<string, StoredDiffSnapshot>()
  private selectedSessionId: string | null = null
  private notificationMode: TelegramNotificationMode = 'actionable'

  public registerAskReport(input: RegisterAskReportInput): {
    session: RemoteSession
    item: RemoteInboxItem
    binding: AskReportBinding
  } {
    const existingBinding = this.askReportBindings.get(input.reportId)
    if (existingBinding) {
      const existingSession = this.sessions.get(existingBinding.sessionId)
      const existingItem = this.inboxItems.get(existingBinding.inboxItemId)
      if (existingSession && existingItem) {
        return {
          session: cloneSession(existingSession),
          item: cloneInboxItem(existingItem),
          binding: cloneAskReportBinding(existingBinding),
        }
      }
    }

    const session = this.ensureSession({
      sessionId: input.sessionId,
      sessionTitle: input.sessionTitle,
      workspacePath: input.workspacePath ?? null,
    })

    const item = this.createInboxItem({
      kind: 'ask_report',
      status: 'pending',
      title: `ask_report: ${input.topicName}`,
      summary: summarizeForInbox(input.message),
      sessionId: session.sessionId,
    })

    const binding: AskReportBinding = {
      reportId: input.reportId,
      sessionId: session.sessionId,
      inboxItemId: item.inboxItemId,
      answerMode: resolveAskReportAnswerMode(input.options),
      status: 'pending',
    }

    this.askReportBindings.set(input.reportId, binding)
    this.touchSession(session.sessionId, item.inboxItemId)

    return {
      session: cloneSession(this.sessions.get(session.sessionId)!),
      item: cloneInboxItem(item),
      binding: cloneAskReportBinding(binding),
    }
  }

  public resolveAskReport(reportId: string, summary: string): RemoteInboxItem | undefined {
    const binding = this.askReportBindings.get(reportId)
    if (!binding) {
      return undefined
    }

    binding.status = 'resolved'
    return this.updateInboxItemStatus(binding.inboxItemId, 'resolved', summary)
  }

  public expireAskReport(reportId: string, summary: string): RemoteInboxItem | undefined {
    const binding = this.askReportBindings.get(reportId)
    if (!binding) {
      return undefined
    }

    binding.status = 'expired'
    return this.updateInboxItemStatus(binding.inboxItemId, 'expired', summary)
  }

  public getAskReportBinding(reportId: string): AskReportBinding | undefined {
    const binding = this.askReportBindings.get(reportId)
    return binding ? cloneAskReportBinding(binding) : undefined
  }

  public getInboxItemForAskReport(reportId: string): RemoteInboxItem | undefined {
    const binding = this.askReportBindings.get(reportId)
    if (!binding) {
      return undefined
    }

    const item = this.inboxItems.get(binding.inboxItemId)
    return item ? cloneInboxItem(item) : undefined
  }

  public registerApprovalRequest(input: RegisterApprovalInput): RegisterRemoteItemResult {
    const existingInboxItemId = this.approvalInboxItemIds.get(input.approvalId)
    if (existingInboxItemId) {
      const existingItem = this.inboxItems.get(existingInboxItemId)
      if (existingItem) {
        const session = this.sessions.get(existingItem.sessionId)
        if (session) {
          return {
            session: cloneSession(session),
            item: cloneInboxItem(existingItem),
          }
        }
      }
    }

    const session = this.ensureSession({
      sessionId: input.sessionId,
      sessionTitle: input.sessionTitle,
      workspacePath: input.workspacePath ?? input.customCwd ?? null,
    })

    const item = this.createInboxItem({
      kind: 'approval',
      status: 'pending',
      title: 'Command approval requested',
      summary: summarizeForInbox(input.command),
      sessionId: session.sessionId,
    })

    this.approvalInboxItemIds.set(input.approvalId, item.inboxItemId)
    this.touchSession(session.sessionId, item.inboxItemId)

    return {
      session: cloneSession(this.sessions.get(session.sessionId)!),
      item: cloneInboxItem(item),
    }
  }

  public resolveApproval(approvalId: string, summary: string): RemoteInboxItem | undefined {
    const inboxItemId = this.approvalInboxItemIds.get(approvalId)
    if (!inboxItemId) {
      return undefined
    }

    return this.updateInboxItemStatus(inboxItemId, 'resolved', summary)
  }

  public registerRemoteItem(input: RegisterRemoteItemInput): RegisterRemoteItemResult {
    const session = this.ensureSession({
      sessionId: input.sessionId,
      sessionTitle: input.sessionTitle,
      workspacePath: input.workspacePath ?? null,
    })

    const item = this.createInboxItem({
      kind: input.kind,
      status: input.status,
      title: input.title,
      summary: input.summary,
      sessionId: session.sessionId,
    })

    this.touchSession(session.sessionId, item.inboxItemId)

    return {
      session: cloneSession(this.sessions.get(session.sessionId)!),
      item: cloneInboxItem(item),
    }
  }

  public getSession(sessionId: string): RemoteSession | undefined {
    const session = this.sessions.get(sessionId)
    return session ? cloneSession(session) : undefined
  }

  public getLatestInboxItem(sessionId: string): RemoteInboxItem | undefined {
    const session = this.sessions.get(sessionId)
    if (!session?.latestInboxItemId) {
      return undefined
    }

    const item = this.inboxItems.get(session.latestInboxItemId)
    return item ? cloneInboxItem(item) : undefined
  }

  public listRecentInboxItems(input?: {
    sessionId?: string
    limit?: number
    actionableOnly?: boolean
  }): RemoteInboxItem[] {
    const limit = input?.limit ?? 5
    return [...this.inboxItems.values()]
      .filter((item) => !input?.sessionId || item.sessionId === input.sessionId)
      .filter((item) => !input?.actionableOnly || item.status === 'pending' || item.status === 'failed')
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit)
      .map((item) => cloneInboxItem(item))
  }

  public setNotificationMode(mode: TelegramNotificationMode): void {
    this.notificationMode = mode
  }

  public getNotificationMode(): TelegramNotificationMode {
    return this.notificationMode
  }

  public getSelectedSession(): RemoteSession | undefined {
    if (this.selectedSessionId) {
      const selected = this.sessions.get(this.selectedSessionId)
      if (selected) {
        return cloneSession(selected)
      }
    }

    const fallback = [...this.sessions.values()]
      .filter((session) => session.status === 'active' || session.status === 'paused')
      .sort((left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime())[0]

    return fallback ? cloneSession(fallback) : undefined
  }

  public listRecentSessions(limit: number = 5): RemoteSession[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime())
      .slice(0, limit)
      .map((session) => cloneSession(session))
  }

  public selectSession(sessionId: string): RemoteSession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return undefined
    }

    this.selectedSessionId = sessionId
    session.status = 'active'
    session.lastActivityAt = new Date()
    return cloneSession(session)
  }

  public getNextPendingItem(sessionId?: string): RemoteInboxItem | undefined {
    const candidates = [...this.inboxItems.values()]
      .filter((item) => item.status === 'pending' && (!sessionId || item.sessionId === sessionId))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())

    return candidates[0] ? cloneInboxItem(candidates[0]) : undefined
  }

  public recordDiffSnapshot(input: {
    sessionId?: string
    sessionTitle: string
    workspacePath?: string | null
    snapshot: StoredDiffSnapshot
  }): RegisterRemoteItemResult {
    const session = this.ensureSession({
      sessionId: input.sessionId ?? input.snapshot.sessionId,
      sessionTitle: input.sessionTitle,
      workspacePath: input.workspacePath ?? null,
    })

    const snapshot: StoredDiffSnapshot = {
      ...input.snapshot,
      sessionId: session.sessionId,
      createdAt: new Date(input.snapshot.createdAt),
    }

    this.diffSnapshots.set(session.sessionId, snapshot)
    this.supersedeSessionItems(
      session.sessionId,
      (item) => item.kind === 'diff-summary' && item.status !== 'superseded',
      'Superseded by a newer diff snapshot.',
    )

    return this.registerRemoteItem({
      kind: 'diff-summary',
      title: 'Latest diff',
      summary: input.snapshot.summary,
      status: 'informational',
      sessionId: session.sessionId,
      sessionTitle: session.title,
      workspacePath: session.workspacePath,
    })
  }

  public getLatestDiffSnapshot(sessionId: string): StoredDiffSnapshot | undefined {
    const snapshot = this.diffSnapshots.get(sessionId)
    return snapshot ? cloneDiffSnapshot(snapshot) : undefined
  }

  public updateDiffSnapshotStatus(sessionId: string, status: StoredDiffSnapshot['status'], summary?: string): StoredDiffSnapshot | undefined {
    const snapshot = this.diffSnapshots.get(sessionId)
    if (!snapshot) {
      return undefined
    }

    snapshot.status = status
    if (summary) {
      snapshot.summary = summary
    }

    return cloneDiffSnapshot(snapshot)
  }

  private ensureSession(input: { sessionId?: string; sessionTitle: string; workspacePath?: string | null }): RemoteSession {
    const sessionId = input.sessionId ?? this.buildWorkspaceSessionId(input.workspacePath ?? null)
    const existing = this.sessions.get(sessionId)
    if (existing) {
      existing.title = input.sessionTitle || existing.title
      existing.workspacePath = input.workspacePath ?? existing.workspacePath
      existing.lastActivityAt = new Date()
      existing.status = 'active'
      return existing
    }

    const session: RemoteSession = {
      sessionId,
      title: input.sessionTitle,
      status: 'active',
      workspacePath: input.workspacePath ?? null,
      latestInboxItemId: null,
      lastActivityAt: new Date(),
    }

    this.sessions.set(sessionId, session)
    return session
  }

  private createInboxItem(input: {
    kind: RemoteInboxItemKind
    status: RemoteInboxItemStatus
    title: string
    summary: string
    sessionId: string
  }): RemoteInboxItem {
    const item: RemoteInboxItem = {
      inboxItemId: randomUUID(),
      sessionId: input.sessionId,
      kind: input.kind,
      status: input.status,
      title: input.title,
      summary: input.summary,
      createdAt: new Date(),
      resolvedAt: null,
    }

    this.inboxItems.set(item.inboxItemId, item)
    return item
  }

  private updateInboxItemStatus(inboxItemId: string, status: RemoteInboxItemStatus, summary: string): RemoteInboxItem | undefined {
    const item = this.inboxItems.get(inboxItemId)
    if (!item) {
      return undefined
    }

    item.status = status
    item.summary = summarizeForInbox(summary)
    item.resolvedAt = status === 'pending' || status === 'informational' ? null : new Date()
    this.touchSession(item.sessionId, item.inboxItemId)
    return cloneInboxItem(item)
  }

  private touchSession(sessionId: string, inboxItemId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }

    session.latestInboxItemId = inboxItemId
    session.lastActivityAt = new Date()
    session.status = 'active'
    this.selectedSessionId = sessionId
  }

  private supersedeSessionItems(
    sessionId: string,
    predicate: (item: RemoteInboxItem) => boolean,
    summary: string,
  ): void {
    for (const item of this.inboxItems.values()) {
      if (item.sessionId !== sessionId || !predicate(item)) {
        continue
      }

      item.status = 'superseded'
      item.summary = summarizeForInbox(summary)
      item.resolvedAt = new Date()
    }
  }

  private buildWorkspaceSessionId(workspacePath: string | null): string {
    return workspacePath ? `workspace:${workspacePath}` : 'workspace:default'
  }
}

function resolveAskReportAnswerMode(options?: string[]): AskReportAnswerMode {
  if (!options || options.length === 0) {
    return 'freeform'
  }

  return 'mixed'
}

function summarizeForInbox(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 240) {
    return normalized
  }

  return `${normalized.slice(0, 237).trimEnd()}...`
}

function cloneSession(session: RemoteSession): RemoteSession {
  return {
    ...session,
    lastActivityAt: new Date(session.lastActivityAt),
  }
}

function cloneInboxItem(item: RemoteInboxItem): RemoteInboxItem {
  return {
    ...item,
    createdAt: new Date(item.createdAt),
    resolvedAt: item.resolvedAt ? new Date(item.resolvedAt) : null,
  }
}

function cloneAskReportBinding(binding: AskReportBinding): AskReportBinding {
  return { ...binding }
}

function cloneDiffSnapshot(snapshot: StoredDiffSnapshot): StoredDiffSnapshot {
  return {
    ...snapshot,
    createdAt: new Date(snapshot.createdAt),
  }
}