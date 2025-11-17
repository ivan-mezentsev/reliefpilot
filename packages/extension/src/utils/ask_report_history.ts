import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'

// Ask Report history entry stored in memory only (per session)
export type AskReportHistoryEntry = {
    id: string
    timestamp: number // epoch ms
    topic: string
    markdown: string
    predefinedOptions?: string[]
    result?: { decision: 'Submit' | 'Cancel'; value: string; timeout?: boolean }
    // Reference to an open webview panel for this entry, if any
    panel?: vscode.WebviewPanel
}

// Shape persisted into workspace storage (no non-serializable fields)
type StoredAskReportHistoryEntry = Omit<AskReportHistoryEntry, 'panel'>

const STORAGE_KEY = 'reliefpilot.askReportHistory.entries'

function getMaxEntries(): number {
    const cfg = vscode.workspace.getConfiguration('reliefpilot')
    const n = cfg.get<number>('askReportHistoryMaxEntries', 20)
    if (!Number.isFinite(n) || n <= 0) return 20
    return Math.max(1, Math.floor(n))
}

class AskReportHistory {
    private entries: AskReportHistoryEntry[] = []
    private storage?: vscode.Memento

    /** Bind workspace storage and load any existing entries. Safe to call multiple times. */
    initStorage(memento: vscode.Memento) {
        this.storage = memento
        this.loadFromStorage()
    }

    private serialize(): StoredAskReportHistoryEntry[] {
        return this.entries.map((e) => ({
            id: e.id,
            timestamp: e.timestamp,
            topic: e.topic,
            markdown: e.markdown,
            predefinedOptions: e.predefinedOptions,
            result: e.result,
        }))
    }

    private async saveToStorage(): Promise<void> {
        try {
            if (!this.storage) return
            const payload = this.serialize()
            await this.storage.update(STORAGE_KEY, payload)
        } catch {
            // ignore storage errors silently
        }
    }

    private loadFromStorage() {
        try {
            if (!this.storage) return
            const data = this.storage.get<StoredAskReportHistoryEntry[]>(STORAGE_KEY, []) || []
            if (Array.isArray(data)) {
                // newest first is preserved in saved order
                this.entries = data.map((d) => ({ ...d, panel: undefined }))
                // Ensure limit from settings
                const max = getMaxEntries()
                if (this.entries.length > max) {
                    this.entries.length = max
                    void this.saveToStorage()
                }
            }
        } catch {
            // ignore load errors
        }
    }

    add(entry: Omit<AskReportHistoryEntry, 'id' | 'timestamp'> & { timestamp?: number; id?: string }): AskReportHistoryEntry {
        const e: AskReportHistoryEntry = {
            id: typeof entry.id === 'string' && entry.id ? entry.id : randomUUID(),
            timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
            topic: entry.topic,
            markdown: entry.markdown,
            predefinedOptions: entry.predefinedOptions,
            result: entry.result,
            panel: entry.panel,
        }
        // push newest at head
        this.entries.unshift(e)
        const max = getMaxEntries()
        if (this.entries.length > max) {
            this.entries.length = max
        }
        // Persist asynchronously
        void this.saveToStorage()
        return e
    }

    /** Update result for a given entry id and persist. No-op when id not found. */
    updateResult(id: string, result: { decision: 'Submit' | 'Cancel'; value: string; timeout?: boolean } | undefined) {
        const e = this.entries.find((x) => x.id === id)
        if (!e) return
        e.result = result
        void this.saveToStorage()
    }

    list(): AskReportHistoryEntry[] {
        return [...this.entries]
    }

    getById(id: string): AskReportHistoryEntry | undefined {
        return this.entries.find((e) => e.id === id)
    }

    /** Remove an entry by id and persist. Returns true when an entry was removed. */
    removeById(id: string): boolean {
        const idx = this.entries.findIndex((e) => e.id === id)
        if (idx === -1) return false
        this.entries.splice(idx, 1)
        void this.saveToStorage()
        return true
    }

    // Trim when setting changes
    applyLimitFromSettings() {
        const max = getMaxEntries()
        if (this.entries.length > max) {
            this.entries.length = max
            void this.saveToStorage()
        }
    }
}

export const askReportHistory = new AskReportHistory()

export function registerAskReportHistoryConfigWatcher(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('reliefpilot.askReportHistoryMaxEntries')) {
                askReportHistory.applyLimitFromSettings()
            }
        }),
    )
}

// Initialize Ask Report history storage from extension context
export function initAskReportHistoryStorage(context: vscode.ExtensionContext) {
    askReportHistory.initStorage(context.workspaceState)
}

export function formatTimestampSeconds(ts: number): string {
    try {
        const d = new Date(ts)
        // Use VS Code env language for locale-aware formatting with seconds
        const locale = (vscode.env as any).language as string | undefined
        const fmt = new Intl.DateTimeFormat(locale || undefined, {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        })
        return fmt.format(d)
    } catch {
        return new Date(ts).toLocaleString()
    }
}
