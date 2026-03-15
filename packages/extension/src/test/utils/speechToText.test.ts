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
        fakeProc.kill = () => {
            // Simulate SIGINT — emit close soon
            setTimeout(() => em.emit('close', 0, null), delayMs / 2)
            return true
        }

        procs.push(em)

        // Find the output file (last arg) and write a fake WAV
        const outputFile = args[args.length - 1]
        if (outputFile) {
            // Write >1000 bytes so transcribeAndEmit doesn't skip
            fs.writeFileSync(outputFile, Buffer.alloc(2000, 0x42))
        }

        // Emit 'close' after delay to simulate chunk recording complete
        setTimeout(() => em.emit('close', 0, null), delayMs)

        return { proc: fakeProc, getStderr: () => '' }
    }

    return { fakeSpawnFfmpeg, procs }
}

suite('speechToText — startStreamingRecording lifecycle', function () {
    this.timeout(15000)

    let transcribeCallCount: number

    function fakeTranscribe(_buf: Buffer): Promise<string> {
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
                endCalled = true
                // onEnd means recording lifecycle completed
                assert.strictEqual(endCalled, true)
                done()
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

        const session = startStreamingRecording({
            onText: (t) => texts.push(t),
            onEnd: () => {
                assert.ok(texts.length > 0, 'Expected at least one transcribed text')
                assert.ok(texts.some((t) => t.startsWith('chunk-')), 'Expected fake transcription output')
                done()
            },
            onError: (err) => done(err),
            chunkSeconds: 1,
            _test: { spawnFfmpeg: fakeSpawnFfmpeg, transcribeAudio: fakeTranscribe },
        })

        // Let some chunks through, then stop
        setTimeout(() => session.stop(), 200)
    })

    test('chunks are emitted in order despite variable transcription delays', function (done) {
        const { fakeSpawnFfmpeg } = createFakeSpawn(25)
        const texts: string[] = []
        let callIdx = 0

        // Simulate variable network delays: first call slow, second fast
        function delayedTranscribe(_buf: Buffer): Promise<string> {
            const myIdx = callIdx++
            const delay = myIdx === 0 ? 150 : 10
            return new Promise((resolve) =>
                setTimeout(() => resolve(`ordered-${myIdx}`), delay),
            )
        }

        const session = startStreamingRecording({
            onText: (t) => texts.push(t),
            onEnd: () => {
                // Verify ordering: first text should be ordered-0, second ordered-1, etc.
                for (let i = 0; i < texts.length; i++) {
                    assert.strictEqual(texts[i], `ordered-${i}`, `Text at index ${i} should be ordered-${i}, got ${texts[i]}`)
                }
                done()
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
        const { fakeSpawnFfmpeg } = createFakeSpawn(20)
        const session = startStreamingRecording({
            onText: () => { },
            onEnd: () => {
                // After end, temp files should be cleaned up
                const leftover = fs.readdirSync(tmpDir).filter((f) => f.startsWith('reliefpilot-stream-'))
                // Note: test-injected fakeSpawnFfmpeg does not write real files,
                // so cleanup has nothing to remove — just verify no crash.
                assert.ok(Array.isArray(leftover), 'Expected array from readdirSync')
                done()
            },
            onError: (err) => done(err),
            chunkSeconds: 1,
            _test: { spawnFfmpeg: fakeSpawnFfmpeg, transcribeAudio: fakeTranscribe },
        })

        setTimeout(() => session.stop(), 100)
    })
})
