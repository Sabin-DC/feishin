import type { AudioSource } from '@apple-protocols/devices';

import { ChildProcess, spawn } from 'child_process';

import log from '/@/main/logger';

// AirPlay audio sources deliver 44.1 kHz, 16-bit big-endian stereo PCM (4 bytes per frame)
const SAMPLE_RATE = 44100;
const FRAME_BYTES = 4;
// Decode at most ~30 s ahead of what the device has consumed
const MAX_BUFFERED_BYTES = SAMPLE_RATE * FRAME_BYTES * 30;

export type PcmSourceFailure = 'decode-failed' | 'ffmpeg-missing';

/**
 * Decodes a stream URL to AirPlay PCM with the system ffmpeg, optionally starting at an offset.
 * `position` is what has been handed to the device so far, so it runs slightly ahead of what is
 * audible (the receiver buffers a short latency).
 */
export class FfmpegPcmSource implements AudioSource {
    readonly duration: number;
    failure: null | PcmSourceFailure = null;
    /** Linear gain applied to the samples as they are handed out, 0 (silent) to 1 (unchanged) */
    gain = 1;

    get position() {
        return this.startAt + this.framesRead / SAMPLE_RATE;
    }
    private buffered = 0;
    private chunks: Buffer[] = [];
    private ended = false;
    private framesRead = 0;
    private process: ChildProcess | null = null;
    private stderr = '';
    private stopped = false;

    private waiter: (() => void) | null = null;

    constructor(
        private readonly url: string,
        private readonly startAt: number,
        duration: number,
    ) {
        this.duration = duration;
    }

    async readFrames(count: number): Promise<Buffer | null> {
        const wanted = count * FRAME_BYTES;
        while (this.buffered < wanted && !this.ended) {
            await new Promise<void>((resolve) => {
                this.waiter = resolve;
            });
        }

        const available = Math.min(wanted, this.buffered - (this.buffered % FRAME_BYTES));
        if (available <= 0) return null;

        const joined = Buffer.concat(this.chunks);
        const out = joined.subarray(0, available);
        const rest = joined.subarray(available);
        this.chunks = rest.length > 0 ? [rest] : [];
        this.buffered = rest.length;
        this.framesRead += available / FRAME_BYTES;
        if (this.gain !== 1) this.applyGain(out);
        if (this.buffered < MAX_BUFFERED_BYTES / 2) this.process?.stdout?.resume();
        return out;
    }

    async reset() {
        // A one-shot decode; the session never rewinds a live stream
    }

    async start() {
        const args = ['-v', 'error', '-nostdin'];
        if (this.startAt > 0) args.push('-ss', String(this.startAt));
        args.push('-i', this.url, '-vn', '-f', 's16be', '-ar', String(SAMPLE_RATE), '-ac', '2');
        args.push('pipe:1');

        const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.process = child;

        child.stdout?.on('data', (chunk: Buffer) => {
            this.chunks.push(chunk);
            this.buffered += chunk.length;
            if (this.buffered >= MAX_BUFFERED_BYTES) child.stdout?.pause();
            this.wake();
        });
        child.stderr?.on('data', (data: Buffer) => {
            if (this.stderr.length < 2000) this.stderr += data.toString();
        });
        child.on('error', (err: NodeJS.ErrnoException) => {
            this.fail(err.code === 'ENOENT' ? 'ffmpeg-missing' : 'decode-failed', err.message);
            // A failed spawn emits no close event
            this.ended = true;
            this.wake();
        });
        child.on('close', (code) => {
            if (code && !this.stopped) this.fail('decode-failed', `ffmpeg exited with ${code}`);
            this.ended = true;
            this.wake();
        });
    }

    async stop() {
        this.stopped = true;
        this.ended = true;
        this.process?.kill('SIGKILL');
        this.wake();
    }

    private applyGain(samples: Buffer) {
        for (let i = 0; i + 1 < samples.length; i += 2) {
            const scaled = Math.round(samples.readInt16BE(i) * this.gain);
            samples.writeInt16BE(Math.max(-32768, Math.min(32767, scaled)), i);
        }
    }

    private fail(failure: PcmSourceFailure, detail: string) {
        this.failure = failure;
        // The stream URL carries credentials, so keep it out of the log
        const stderr = this.stderr.split(this.url).join('<url>').trim();
        log.error(`[airplay] ${failure}: ${detail}${stderr ? ` (${stderr})` : ''}`);
    }

    private wake() {
        const waiter = this.waiter;
        this.waiter = null;
        waiter?.();
    }
}
