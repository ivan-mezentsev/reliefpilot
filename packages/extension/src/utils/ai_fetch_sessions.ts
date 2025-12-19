// Shared session registry for ai_fetch_url tool
import * as vscode from 'vscode';

export type AiFetchSession = {
    uid: string;
    url: string;
    topic: string;
    // Model metadata used for UI (e.g. progress panel header)
    modelId: string;
    modelMaxInputTokens: number;
    // Lightweight lifecycle state for UI / debugging
    status: 'pending' | 'running' | 'done';
    // Timing metadata for this session (wall-clock start of the tool invocation)
    startedAt: number;
    finishedAt?: number;
    leftEmitter: vscode.EventEmitter<string>; // converted markdown of fetched content
    rightTextEmitter: vscode.EventEmitter<string>; // model text stream
    rightDoneEmitter: vscode.EventEmitter<void>; // signals completion of the model text stream
    leftBuffer: string; // full latest left content
    rightTextBuffer: string; // accumulated right text
    panel?: vscode.WebviewPanel; // webview panel associated with this session (if open)
    dispose: () => void;
};

// Persisted shape (no emitters/panel)
type StoredAiFetchSession = {
    uid: string;
    url: string;
    topic: string;
    modelId: string;
    modelMaxInputTokens: number;
    status: 'pending' | 'running' | 'done';
    startedAt: number;
    finishedAt?: number;
    leftBuffer: string;
    rightTextBuffer: string;
}

const STORAGE_KEY = 'reliefpilot.aiFetchSessions';

function getMaxEntries(): number {
    const cfg = vscode.workspace.getConfiguration('reliefpilot');
    const n = cfg.get<number>('aiFetchHistoryMaxEntries', 20);
    if (!Number.isFinite(n) || n <= 0) return 20;
    return Math.max(1, Math.floor(n));
}

class AiFetchSessionManager {
    private sessions: AiFetchSession[] = [];
    private storage?: vscode.Memento;

    initStorage(memento: vscode.Memento) {
        this.storage = memento;
        this.loadFromStorage();
    }

    private loadFromStorage() {
        if (!this.storage) return;
        const data = this.storage.get<StoredAiFetchSession[]>(STORAGE_KEY, []) || [];
        if (Array.isArray(data)) {
            this.sessions = data.map(s => {
                const leftEmitter = new vscode.EventEmitter<string>();
                const rightTextEmitter = new vscode.EventEmitter<string>();
                const rightDoneEmitter = new vscode.EventEmitter<void>();
                return {
                    ...s,
                    status: 'done', // Loaded sessions are already completed
                    leftEmitter,
                    rightTextEmitter,
                    rightDoneEmitter,
                    panel: undefined,
                    dispose: () => {
                        leftEmitter.dispose();
                        rightTextEmitter.dispose();
                        rightDoneEmitter.dispose();
                        // No panel to dispose here as it's undefined on load
                    }
                };
            });
            // Enforce limit
            const max = getMaxEntries();
            if (this.sessions.length > max) {
                const removed = this.sessions.splice(max);
                removed.forEach(s => s.dispose());
                void this.saveToStorage();
            }
        }
    }

    private serialize(): StoredAiFetchSession[] {
        return this.sessions.map(s => ({
            uid: s.uid,
            url: s.url,
            topic: s.topic,
            modelId: s.modelId,
            modelMaxInputTokens: s.modelMaxInputTokens,
            status: s.status,
            startedAt: s.startedAt,
            finishedAt: s.finishedAt,
            leftBuffer: s.leftBuffer,
            rightTextBuffer: s.rightTextBuffer
        }));
    }

    private async saveToStorage() {
        if (!this.storage) return;
        try {
            await this.storage.update(STORAGE_KEY, this.serialize());
        } catch { }
    }

    createSession(
        uid: string,
        url: string,
        topic: string,
        modelId: string,
        modelMaxInputTokens: number,
    ): AiFetchSession {
        const leftEmitter = new vscode.EventEmitter<string>();
        const rightTextEmitter = new vscode.EventEmitter<string>();
        const rightDoneEmitter = new vscode.EventEmitter<void>();

        const session: AiFetchSession = {
            uid,
            url,
            topic,
            modelId,
            modelMaxInputTokens,
            status: 'pending',
            startedAt: Date.now(),
            leftEmitter,
            rightTextEmitter,
            rightDoneEmitter,
            leftBuffer: '',
            rightTextBuffer: '',
            panel: undefined,
            dispose: () => {
                leftEmitter.dispose();
                rightTextEmitter.dispose();
                rightDoneEmitter.dispose();
            },
        };
        session.dispose = () => {
            leftEmitter.dispose();
            rightTextEmitter.dispose();
            rightDoneEmitter.dispose();
            session.panel?.dispose();
        };

        this.sessions.unshift(session);

        const max = getMaxEntries();
        if (this.sessions.length > max) {
            const removed = this.sessions.splice(max);
            removed.forEach(s => s.dispose());
        }

        // We don't save immediately on create, only on finalize to avoid saving empty sessions?
        // Or we can save. Let's save to be safe.
        void this.saveToStorage();

        return session;
    }

    getSession(uid: string | undefined): AiFetchSession | undefined {
        if (!uid) return undefined;
        return this.sessions.find(s => s.uid === uid);
    }

    finalizeSession(uid: string) {
        const session = this.sessions.find(s => s.uid === uid);
        if (!session) return;

        // Idempotency: callers may finalize from multiple code paths (success/error/cancellation).
        if (session.status === 'done') return;

        // Mark completion time for UI (prevents progress timer from running forever on late-open panels).
        if (typeof session.finishedAt !== 'number' || !isFinite(session.finishedAt)) {
            session.finishedAt = Date.now();
        }

        // Signal completion to any open progress panel before disposing emitters/panel.
        try { session.rightDoneEmitter.fire(); } catch { /* ignore */ }

        session.status = 'done';
        void this.saveToStorage();

        // Release resources (emitters + associated webview panel).
        try { session.dispose(); } catch { /* ignore */ }
    }

    // Apply current limit from settings dynamically (configuration watcher).
    applyLimitFromSettings() {
        const max = getMaxEntries();
        if (this.sessions.length > max) {
            const removed = this.sessions.splice(max);
            removed.forEach(s => {
                try { s.dispose(); } catch { /* ignore */ }
            });
            void this.saveToStorage();
        }
    }
}

const manager = new AiFetchSessionManager();

export function initAiFetchSessionStorage(context: vscode.ExtensionContext) {
    manager.initStorage(context.workspaceState);
}

export function createSession(
    uid: string,
    url: string,
    topic: string,
    modelId: string,
    modelMaxInputTokens: number,
): AiFetchSession {
    return manager.createSession(uid, url, topic, modelId, modelMaxInputTokens);
}

export function getSession(uid: string | undefined): AiFetchSession | undefined {
    return manager.getSession(uid);
}

export function finalizeSession(uid: string) {
    manager.finalizeSession(uid);
}

// Watch configuration changes for dynamic trimming of ai_fetch history
export function registerAiFetchSessionConfigWatcher(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('reliefpilot.aiFetchHistoryMaxEntries')) {
                manager.applyLimitFromSettings();
            }
        })
    );
}