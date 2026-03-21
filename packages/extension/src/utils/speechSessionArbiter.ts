import type { StreamingRecordingSession } from './speechToText'

type ActiveSpeechSession = {
    token: string
    session: StreamingRecordingSession
    onPreempted: () => void
}

let activeSpeechSession: ActiveSpeechSession | undefined

function preemptActiveSpeechSession(): void {
    if (!activeSpeechSession) return

    const current = activeSpeechSession
    activeSpeechSession = undefined
    current.session.cancel()
    current.onPreempted()
}

export function replaceActiveSpeechSession(opts: {
    token: string
    createSession: () => StreamingRecordingSession
    onPreempted: () => void
}): StreamingRecordingSession {
    preemptActiveSpeechSession()

    const session = opts.createSession()
    activeSpeechSession = {
        token: opts.token,
        session,
        onPreempted: opts.onPreempted,
    }

    return session
}

export function stopActiveSpeechSession(token: string): boolean {
    if (activeSpeechSession?.token !== token) return false

    activeSpeechSession.session.stop()
    return true
}

export function cancelActiveSpeechSession(token: string): boolean {
    if (activeSpeechSession?.token !== token) return false

    const current = activeSpeechSession
    activeSpeechSession = undefined
    current.session.cancel()
    return true
}

export function releaseActiveSpeechSession(token: string): void {
    if (activeSpeechSession?.token === token) {
        activeSpeechSession = undefined
    }
}

/** @internal test-only */
export function resetSpeechSessionArbiterForTests(): void {
    if (activeSpeechSession) {
        const current = activeSpeechSession
        activeSpeechSession = undefined
        current.session.cancel()
    }
}