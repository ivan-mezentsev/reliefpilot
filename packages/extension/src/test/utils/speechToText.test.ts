import * as assert from 'assert'
import type { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import { buildFfmpegArgs, isHallucination, startStreamingRecording } from '../../utils/speechToText'

suite('speechToText — buildFfmpegArgs', function () {
    this.timeout(5000)

    test('Linux with pulse backend', () => {
        const args = buildFfmpegArgs({ outputFile: '/tmp/out.wav', linuxBackend: 'pulse' })
        // On non-Linux CI the function will use the host platform branch.
        // We test only when actually on Linux.
        if (process.platform === 'linux') {
            assert.ok(args.includes('-f'))
            assert.ok(args.includes('pulse'))
            assert.ok(args.includes('/tmp/out.wav'))
            assert.ok(args.includes('-ar'))
            assert.ok(args.includes('16000'))
            assert.ok(args.includes('-ac'))
            assert.ok(args.includes('1'))
            assert.ok(args.includes('-y'))
        }
    })

    test('Linux with alsa backend', () => {
        if (process.platform !== 'linux') return
        const args = buildFfmpegArgs({ outputFile: '/tmp/out.wav', linuxBackend: 'alsa' })
        assert.ok(args.includes('alsa'))
    })

    test('chunkSeconds adds -t flag', () => {
        const args = buildFfmpegArgs({ outputFile: '/tmp/out.wav', chunkSeconds: 5 })
        const tIdx = args.indexOf('-t')
        assert.ok(tIdx >= 0, 'Expected -t flag')
        assert.strictEqual(args[tIdx + 1], '5')
    })

    test('no chunkSeconds omits -t flag', () => {
        const args = buildFfmpegArgs({ outputFile: '/tmp/out.wav' })
        assert.ok(!args.includes('-t'))
    })

    test('output file is always last argument', () => {
        const args = buildFfmpegArgs({ outputFile: '/tmp/test.wav', chunkSeconds: 3 })
        assert.strictEqual(args[args.length - 1], '/tmp/test.wav')
    })

    test('always includes -y for overwrite', () => {
        const args = buildFfmpegArgs({ outputFile: '/tmp/out.wav' })
        assert.ok(args.includes('-y'))
    })

    test('windowsDevice is used on Windows', () => {
        if (process.platform !== 'win32') return
        const args = buildFfmpegArgs({ outputFile: 'C:\\tmp\\out.wav', windowsDevice: 'Microphone (Realtek)' })
        assert.ok(args.includes('audio=Microphone (Realtek)'))
    })

    test('macDevice is used on macOS', () => {
        if (process.platform !== 'darwin') return
        const args = buildFfmpegArgs({ outputFile: '/tmp/out.wav', macDevice: ':0' })
        assert.ok(args.includes(':0'))
    })
})

suite('speechToText — isHallucination', function () {
    this.timeout(5000)

    test('blank audio markers are hallucinations', () => {
        assert.strictEqual(isHallucination('[BLANK_AUDIO]'), true)
        assert.strictEqual(isHallucination('[SILENCE]'), true)
        assert.strictEqual(isHallucination('[MUSIC]'), true)
    })

    test('known hallucination phrases are detected', () => {
        assert.strictEqual(isHallucination('Продолжение следует...'), true)
        assert.strictEqual(isHallucination('Thank you for watching!'), true)
        assert.strictEqual(isHallucination('Please subscribe and like'), true)
        assert.strictEqual(isHallucination('Субтитры сделал DimaTorzworka'), true)
    })

    test('empty or whitespace-only is a hallucination', () => {
        assert.strictEqual(isHallucination(''), true)
        assert.strictEqual(isHallucination('   '), true)
    })

    test('real speech is NOT a hallucination', () => {
        assert.strictEqual(isHallucination('Привет, это тестовая запись'), false)
        assert.strictEqual(isHallucination('Hello world, this is a test'), false)
        assert.strictEqual(isHallucination('Please fix the bug in line 42'), false)
    })
})

// ── Lifecycle tests for startStreamingRecording ──────────────────────

/**
 * Creates a fake ChildProcess-like EventEmitter for testing.
 * On construction, writes a fake WAV file at `outputFile` (extracted from args)
 * then emits 'close' after `delayMs`.
 */
function createFakeSpawn(delayMs = 20) {
    const procs: EventEmitter[] = []

    function fakeSpawnFfmpeg(args: string[]): { proc: ChildProcess; getStderr: () => string } {
        const em = new EventEmitter()
        const fakeProc = em as unknown as ChildProcess
            ; (fakeProc as unknown as Record<string, unknown>).pid = 99999

        const outputTarget = args[args.length - 1]
        let segmentIndex = 0
        let closed = false

        const resolveSegmentPath = (pattern: string, index: number) => {
            const padded = String(index).padStart(6, '0')
            return pattern.replace(/%0\d+d/, padded).replace(/%d/, String(index))
        }

        const emitSegment = () => {
            if (closed || !outputTarget) return
            const outputFile = resolveSegmentPath(outputTarget, segmentIndex++)
            fs.writeFileSync(outputFile, Buffer.alloc(2000, 0x42))
        }

        emitSegment()
        const segmentTimer = setInterval(() => emitSegment(), delayMs)

        fakeProc.kill = () => {
            if (closed) return true
            closed = true
            clearInterval(segmentTimer)
            setTimeout(() => em.emit('close', 0, null), delayMs / 2)
            return true
        }

        procs.push(em)

        return { proc: fakeProc, getStderr: () => '' }
    }

    return { fakeSpawnFfmpeg, procs }
}

suite('speechToText — startStreamingRecording lifecycle', function () {
    this.timeout(15000)

    let transcribeCallCount: number

    function fakeTranscribe(_buf: Buffer, _signal?: AbortSignal): Promise<string> {
        transcribeCallCount++
        return Promise.resolve(`chunk-${transcribeCallCount}`)
    }

    setup(() => {
        transcribeCallCount = 0
    })

    test('cancel() stops recording immediately and calls no callbacks after', (done) => {
        const { fakeSpawnFfmpeg } = createFakeSpawn(50)
        const texts: string[] = []
        let endCalled = false

        const session = startStreamingRecording({
            onText: (t) => texts.push(t),
            onEnd: () => { endCalled = true },
            onError: () => { assert.fail('onError should not be called after cancel') },
            chunkSeconds: 1,
            _test: { spawnFfmpeg: fakeSpawnFfmpeg, transcribeAudio: fakeTranscribe },
        })

        // Cancel immediately
        setTimeout(() => {
            session.cancel()
            // Wait a bit to ensure no more callbacks fire
            setTimeout(() => {
                assert.strictEqual(endCalled, false, 'onEnd should not be called after cancel')
                done()
            }, 200)
        }, 10)
    })

    test('stop() triggers onEnd after final chunk transcription', function (done) {
        const { fakeSpawnFfmpeg } = createFakeSpawn(30)
        const texts: string[] = []
        let endCalled = false

        const session = startStreamingRecording({
            onText: (t) => texts.push(t),
            onEnd: () => {
                try {
                    endCalled = true
                    // onEnd means recording lifecycle completed
                    assert.strictEqual(endCalled, true)
                    done()
                } catch (err) { done(err) }
            },
            onError: (err) => done(err),
            chunkSeconds: 1,
            _test: { spawnFfmpeg: fakeSpawnFfmpeg, transcribeAudio: fakeTranscribe },
        })

        // Let at least one chunk start, then stop
        setTimeout(() => session.stop(), 100)
    })

    test('onText receives transcribed text from chunks', function (done) {
        const { fakeSpawnFfmpeg } = createFakeSpawn(30)
        const texts: string[] = []
        let stopRequested = false

        const timeout = setTimeout(() => {
            if (!stopRequested) {
                session.cancel()
                done(new Error('Timed out waiting for the first onText callback'))
            }
        }, 5000)

        const session = startStreamingRecording({
            onText: (t) => {
                texts.push(t)
                if (!stopRequested) {
                    stopRequested = true
                    session.stop()
                }
            },
            onEnd: () => {
                try {
                    clearTimeout(timeout)
                    assert.ok(texts.length > 0, 'Expected at least one transcribed text')
                    assert.ok(texts.some((t) => t.startsWith('chunk-')), 'Expected fake transcription output')
                    done()
                } catch (err) { done(err) }
            },
            onError: (err) => {
                clearTimeout(timeout)
                done(err)
            },
            chunkSeconds: 1,
            _test: { spawnFfmpeg: fakeSpawnFfmpeg, transcribeAudio: fakeTranscribe },
        })
    })

    test('chunks are emitted in order despite variable transcription delays', function (done) {
        const { fakeSpawnFfmpeg } = createFakeSpawn(25)
        const texts: string[] = []
        let callIdx = 0

        // Simulate variable network delays: first call slow, second fast
        function delayedTranscribe(_buf: Buffer, _signal?: AbortSignal): Promise<string> {
            const myIdx = callIdx++
            const delay = myIdx === 0 ? 150 : 10
            return new Promise((resolve) =>
                setTimeout(() => resolve(`ordered-${myIdx}`), delay),
            )
        }

        const session = startStreamingRecording({
            onText: (t) => texts.push(t),
            onEnd: () => {
                try {
                    // Must have at least one chunk for the ordering check to be meaningful
                    assert.ok(texts.length > 0, 'Expected at least one ordered chunk')
                    // Verify ordering: first text should be ordered-0, second ordered-1, etc.
                    for (let i = 0; i < texts.length; i++) {
                        assert.strictEqual(texts[i], `ordered-${i}`, `Text at index ${i} should be ordered-${i}, got ${texts[i]}`)
                    }
                    done()
                } catch (err) { done(err) }
            },
            onError: (err) => done(err),
            chunkSeconds: 1,
            _test: { spawnFfmpeg: fakeSpawnFfmpeg, transcribeAudio: delayedTranscribe },
        })

        // Let enough chunks go through for ordering test
        setTimeout(() => session.stop(), 250)
    })

    test('cleanup removes temporary WAV files', function (done) {
        const tmpDir = os.tmpdir()
        const existingDirs = new Set(
            fs.readdirSync(tmpDir).filter((f) => f.startsWith('reliefpilot-stream-')),
        )
        const { fakeSpawnFfmpeg } = createFakeSpawn(20)
        const session = startStreamingRecording({
            onText: () => { },
            onEnd: () => {
                try {
                    const leftover = fs.readdirSync(tmpDir)
                        .filter((f) => f.startsWith('reliefpilot-stream-') && !existingDirs.has(f))
                    assert.deepStrictEqual(leftover, [], 'Expected stop() to remove newly created temp directories')
                    done()
                } catch (err) { done(err) }
            },
            onError: (err) => done(err),
            chunkSeconds: 1,
            _test: { spawnFfmpeg: fakeSpawnFfmpeg, transcribeAudio: fakeTranscribe },
        })

        setTimeout(() => session.stop(), 100)
    })

    test('prompts to install FFmpeg and retries once when ffmpeg is missing', function (done) {
        const { fakeSpawnFfmpeg } = createFakeSpawn(20)
        let spawnCount = 0
        let promptCount = 0
        let stopRequested = false

        function missingThenWorkingSpawn(args: string[]): { proc: ChildProcess; getStderr: () => string } {
            spawnCount++
            if (spawnCount === 1) {
                const em = new EventEmitter()
                const fakeProc = em as unknown as ChildProcess
                ; (fakeProc as unknown as Record<string, unknown>).pid = 99998
                fakeProc.kill = () => true
                setTimeout(() => em.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })), 0)
                return { proc: fakeProc, getStderr: () => '' }
            }

            return fakeSpawnFfmpeg(args)
        }

        const session = startStreamingRecording({
            onText: () => {
                if (!stopRequested) {
                    stopRequested = true
                    session.stop()
                }
            },
            onEnd: () => {
                try {
                    assert.strictEqual(promptCount, 1, 'Expected exactly one FFmpeg install prompt')
                    assert.ok(spawnCount >= 2, 'Expected FFmpeg spawn to be retried after prompt')
                    done()
                } catch (err) { done(err) }
            },
            onError: (err) => done(err),
            chunkSeconds: 1,
            _test: {
                spawnFfmpeg: missingThenWorkingSpawn,
                transcribeAudio: fakeTranscribe,
                promptToInstallFfmpeg: async () => {
                    promptCount++
                    return true
                },
            },
        })
    })

    test('prompts to install FFmpeg when Windows device discovery fails with ENOENT and then retries recording', function (done) {
        const { fakeSpawnFfmpeg } = createFakeSpawn(20)
        let promptCount = 0
        let discoveryCount = 0
        let stopRequested = false

        const session = startStreamingRecording({
            onText: () => {
                if (!stopRequested) {
                    stopRequested = true
                    session.stop()
                }
            },
            onEnd: () => {
                try {
                    assert.strictEqual(promptCount, 1, 'Expected exactly one FFmpeg install prompt during Windows discovery')
                    assert.strictEqual(discoveryCount, 2, 'Expected Windows device discovery to be retried after install prompt')
                    done()
                } catch (err) { done(err) }
            },
            onError: (err) => done(err),
            chunkSeconds: 1,
            _test: {
                platform: 'win32',
                spawnFfmpeg: fakeSpawnFfmpeg,
                transcribeAudio: fakeTranscribe,
                promptToInstallFfmpeg: async () => {
                    promptCount++
                    return true
                },
                discoverWindowsAudioDevices: async () => {
                    discoveryCount++
                    if (discoveryCount === 1) {
                        return { devices: [], ffmpegMissing: true }
                    }
                    return { devices: ['Microphone (Test Device)'], ffmpegMissing: false }
                },
            },
        })
    })
})
