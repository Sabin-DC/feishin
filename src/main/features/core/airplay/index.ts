import type { PinPairing } from '@apple-protocols/airplay';
import type { DiscoveredDevice } from '@apple-protocols/devices';

import { pair } from '@apple-protocols/airplay';
import { Credentials, discover } from '@apple-protocols/devices';
import { app, ipcMain } from 'electron';

import type { Sink, StreamHandle, StreamMetadata } from './sink';

import { getMainWindow } from '../../../index';
import { store } from '../settings';
import { FfmpegPcmSource } from './pcm-source';
import { connectSink, StoredCredentials } from './sink';

import log from '/@/main/logger';

interface AirplayDevice {
    id: string;
    model: string;
    name: string;
}

interface PlayUrlPayload {
    duration?: number;
    metadata?: Omit<StreamMetadata, 'duration'>;
    seekTo?: number;
    url: string;
}

const POSITION_INTERVAL_MS = 1000;
const CREDENTIALS_KEY = 'airplay_credentials';
const VOLUMES_KEY = 'airplay_volumes';
// Starting level for a device that has no remembered volume and reports none of its own, so a new
// speaker never inherits the loudness of the previous one
const DEFAULT_VOLUME = 30;
const SAVE_DELAY_MS = 500;

// Per-device data is keyed by the device's MAC address, which survives a change of its name
const deviceKey = (device: DiscoveredDevice) => device.mac ?? device.id;
const loadCredentials = (device: DiscoveredDevice): StoredCredentials | undefined =>
    (store.get(CREDENTIALS_KEY, {}) as Record<string, StoredCredentials>)[deviceKey(device)];

const savedVolumes = () => store.get(VOLUMES_KEY, {}) as Record<string, number>;

// The device whose volume is remembered while connected, and the volume change waiting to be written
let connectedKey: null | string = null;
let pendingVolume: null | { key: string; value: number } = null;
let saveTimer: null | ReturnType<typeof setTimeout> = null;

const flushVolume = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (!pendingVolume) return;
    store.set(VOLUMES_KEY, { ...savedVolumes(), [pendingVolume.key]: pendingVolume.value });
    pendingVolume = null;
};

// A slider drag sends many values; only the last one is written
const rememberVolume = (value: number) => {
    if (!connectedKey) return;
    pendingVolume = { key: connectedKey, value: Math.round(value) };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushVolume, SAVE_DELAY_MS);
};

app.on('before-quit', flushVolume);

let pendingPairing: null | { device: DiscoveredDevice; pairing: PinPairing } = null;

let found = new Map<string, DiscoveredDevice>();
let sink: null | Sink = null;
let source: FfmpegPcmSource | null = null;
let playback: null | StreamHandle = null;
let positionTimer: null | ReturnType<typeof setInterval> = null;
// Bumped whenever a stream starts or stops, so a late `ended` from an old stream is ignored
let generation = 0;
let current: null | { duration: number; metadata?: StreamMetadata; url: string } = null;
let pausedAt: null | number = null;
let volume = 50;
let muted = false;

const send = (channel: string, ...args: unknown[]) => {
    getMainWindow()?.webContents.send(channel, ...args);
};

const sendError = (code: string) => send('renderer-airplay-error', code);

const stopStream = async () => {
    generation++;
    if (positionTimer) {
        clearInterval(positionTimer);
        positionTimer = null;
    }
    const oldPlayback = playback;
    const oldSource = source;
    playback = null;
    source = null;
    try {
        await oldPlayback?.stop();
    } catch (err) {
        log.warn('[airplay] Failed to stop stream', err);
    }
    await oldSource?.stop();
};

const startStream = async (
    url: string,
    duration: number,
    startAt: number,
    metadata?: StreamMetadata,
) => {
    if (!sink) return;
    await stopStream();
    const id = generation;
    const pcm = new FfmpegPcmSource(url, startAt, duration);
    try {
        const stream = await sink.stream(pcm, { metadata, muted, volume });
        if (id !== generation) {
            await stream.stop();
            await pcm.stop();
            return;
        }
        source = pcm;
        playback = stream;
    } catch (err) {
        log.error('[airplay] Failed to start stream', err);
        await pcm.stop();
        sendError(pcm.failure ?? 'stream-failed');
        return;
    }

    send('renderer-airplay-current-time', startAt);
    positionTimer = setInterval(() => {
        if (source) send('renderer-airplay-current-time', source.position);
    }, POSITION_INTERVAL_MS);

    playback.ended
        .catch((err) => log.warn('[airplay] Stream ended with an error', err))
        .then(() => {
            if (id !== generation) return;
            const failure = pcm.failure;
            void stopStream();
            if (failure) {
                sendError(failure);
            } else {
                send('renderer-airplay-track-ended');
            }
        });
};

const disconnect = async () => {
    flushVolume();
    connectedKey = null;
    await stopStream();
    current = null;
    pausedAt = null;
    const old = sink;
    sink = null;
    try {
        await old?.disconnect();
    } catch (err) {
        log.warn('[airplay] Failed to disconnect', err);
    }
};

ipcMain.handle('airplay-discover', async (): Promise<AirplayDevice[]> => {
    try {
        const devices = await discover();
        // Only audio receivers; this also filters out phones and tablets that just advertise AirPlay
        const receivers = devices.filter((d) => d.services.raop);
        found = new Map(receivers.map((d) => [d.id, d]));
        return receivers.map((d) => ({
            id: d.id,
            model: d.modelName,
            name: d.name.replace(/\.local$/, ''),
        }));
    } catch (err) {
        log.error('[airplay] Discovery failed', err);
        return [];
    }
});

ipcMain.handle(
    'airplay-connect',
    async (
        _event,
        id: string,
    ): Promise<{ needsPin?: boolean; success: boolean; volume: number }> => {
        const target = found.get(id);
        if (!target) return { success: false, volume };

        // Switching devices mid-song carries the song over to the new one
        const carryOver = current && {
            ...current,
            paused: pausedAt !== null,
            position: pausedAt ?? source?.position ?? 0,
        };

        await disconnect();
        try {
            const stored = loadCredentials(target);
            const next = await connectSink(target, stored);
            sink = next;
            const saved = savedVolumes()[deviceKey(target)];
            volume = saved ?? next.initialVolume ?? DEFAULT_VOLUME;
            connectedKey = deviceKey(target);
            // Put the device itself back at the remembered level before anything plays
            if (saved !== undefined) await next.setVolume(saved).catch(() => undefined);
            next.onVolumeChange((percent) => {
                volume = percent;
                rememberVolume(percent);
                send('renderer-airplay-volume', volume);
            });
            log.info(`[airplay] Connected to ${target.modelName || 'device'}`);
            if (carryOver) {
                const { duration, metadata, url } = carryOver;
                current = { duration, metadata, url };
                if (carryOver.paused) {
                    pausedAt = carryOver.position;
                } else {
                    void startStream(url, duration, carryOver.position, metadata);
                }
            }
            return { success: true, volume };
        } catch (err) {
            log.error('[airplay] Failed to connect', err);
            // A receiver that refuses an unauthenticated client wants a PIN pairing first
            const refused = /403|forbidden|salt/i.test(err instanceof Error ? err.message : '');
            if (refused && !loadCredentials(target))
                return { needsPin: true, success: false, volume };
            sendError(refused ? 'access-denied' : 'connect-failed');
            return { success: false, volume };
        }
    },
);

ipcMain.handle('airplay-pair-start', async (_event, id: string): Promise<boolean> => {
    const target = found.get(id);
    const service = target?.services.airplay;
    if (!target || !service) return false;
    pendingPairing?.pairing.close();
    pendingPairing = null;
    try {
        // The device shows a PIN on its screen once this resolves
        const pairing = await pair({
            address: target.address,
            id: target.id,
            port: service.port,
            txt: service.txt,
        });
        pendingPairing = { device: target, pairing };
        return true;
    } catch (err) {
        log.error('[airplay] Failed to start pairing', err);
        return false;
    }
});

ipcMain.handle('airplay-pair-finish', async (_event, pin: string): Promise<boolean> => {
    if (!pendingPairing) return false;
    const { device, pairing } = pendingPairing;
    try {
        const credentials = await pairing.pin(pin);
        const all = store.get(CREDENTIALS_KEY, {}) as Record<string, StoredCredentials>;
        all[deviceKey(device)] = Credentials.from(credentials).toFields();
        store.set(CREDENTIALS_KEY, all);
        pairing.close();
        pendingPairing = null;
        log.info(`[airplay] Paired with ${device.modelName || 'device'}`);
        return true;
    } catch (err) {
        // A wrong PIN leaves the pairing open so the user can try again
        log.warn('[airplay] Pairing PIN was not accepted', err);
        return false;
    }
});

ipcMain.on('airplay-pair-cancel', () => {
    pendingPairing?.pairing.close();
    pendingPairing = null;
});

ipcMain.handle('airplay-disconnect', async () => {
    await disconnect();
    return true;
});

ipcMain.on('airplay-play-url', async (_event, payload: PlayUrlPayload) => {
    const duration = payload.duration ?? 0;
    const metadata = payload.metadata && { ...payload.metadata, duration };
    current = { duration, metadata, url: payload.url };
    pausedAt = null;
    await startStream(payload.url, duration, payload.seekTo ?? 0, metadata);
});

ipcMain.on('airplay-play', async () => {
    if (!current || pausedAt === null) return;
    const from = pausedAt;
    pausedAt = null;
    await startStream(current.url, current.duration, from, current.metadata);
});

ipcMain.on('airplay-pause', async () => {
    if (!source) return;
    // The stream has no pause; stopping flushes the device at once and play restarts it from here
    pausedAt = source.position;
    await stopStream();
});

ipcMain.on('airplay-stop', async () => {
    await stopStream();
    current = null;
    pausedAt = null;
});

ipcMain.on('airplay-seek', async (_event, seconds: number) => {
    if (!current) return;
    if (pausedAt !== null) {
        pausedAt = seconds;
        send('renderer-airplay-current-time', seconds);
        return;
    }
    await startStream(current.url, current.duration, seconds, current.metadata);
});

ipcMain.on('airplay-volume', async (_event, value: number) => {
    volume = value;
    rememberVolume(value);
    try {
        await sink?.setVolume(value);
    } catch (err) {
        log.debug('[airplay] Device does not accept a volume change', err);
    }
});

ipcMain.on('airplay-mute', async (_event, isMuted: boolean) => {
    muted = isMuted;
    try {
        await sink?.setMuted(isMuted);
    } catch (err) {
        log.debug('[airplay] Device does not accept a mute change', err);
    }
});

ipcMain.handle('airplay-get-position', () => pausedAt ?? source?.position ?? 0);
