import type { DiscoveredDevice } from '@apple-protocols/devices';

import { connect as airplayConnect, TimingServer } from '@apple-protocols/airplay';
import { connect as raopConnect } from '@apple-protocols/airplay/raop';
import { createDevice, Credentials, DeviceFamily } from '@apple-protocols/devices';

import type { FfmpegPcmSource } from './pcm-source';

import log from '/@/main/logger';

/** One connected receiver, whichever AirPlay generation it speaks. */
export interface Sink {
    disconnect: () => Promise<void>;
    /** The volume the receiver reported on connect (0-100), when it reports one. */
    initialVolume: null | number;
    onVolumeChange: (listener: (percent: number) => void) => void;
    setMuted: (muted: boolean) => Promise<void>;
    setVolume: (percent: number) => Promise<void>;
    stream: (
        source: FfmpegPcmSource,
        options: { metadata?: StreamMetadata; muted: boolean; volume: number },
    ) => Promise<StreamHandle>;
}

/** Long-term pairing credentials with the binary fields as hex, as stored on disk. */
export type StoredCredentials = ReturnType<Credentials['toFields']>;

export interface StreamHandle {
    /** Settles once the source ran out and the device was told. */
    ended: Promise<void>;
    /** Stops the stream and resolves once the device let go, so a new stream can start at once. */
    stop: () => Promise<void>;
}

export interface StreamMetadata {
    album: string;
    artist: string;
    duration: number;
    title: string;
}

const toAccessoryCredentials = (fields: StoredCredentials) => ({
    accessoryIdentifier: fields.accessoryIdentifier,
    accessoryLongTermPublicKey: Buffer.from(fields.accessoryLongTermPublicKey, 'hex'),
    pairingId: Buffer.from(fields.pairingId, 'hex'),
    publicKey: Buffer.from(fields.publicKey, 'hex'),
    secretKey: Buffer.from(fields.secretKey, 'hex'),
});

// AirPlay volume runs from -30 dB (quietest) to 0 dB (loudest), -144 dB being mute
const AIRPLAY_MIN_DB = 30;
const MUTE_DB = -144;
const percentToAirplayDb = (percent: number) =>
    percent <= 0 ? MUTE_DB : -AIRPLAY_MIN_DB + (AIRPLAY_MIN_DB * Math.min(percent, 100)) / 100;
// The same span as plain attenuation, for volume applied to the audio itself
const percentToGain = (percent: number) =>
    percent <= 0 ? 0 : 10 ** (percentToAirplayDb(percent) / 20);

const STOP_TIMEOUT_MS = 2000;

const settled = (promise: Promise<unknown>) =>
    Promise.race([
        promise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]).then(() => undefined);

/** AirPlay 2 over the device layer: HomePods and Apple TVs. */
async function connectAirplay2(found: DiscoveredDevice, stored?: StoredCredentials): Promise<Sink> {
    const device = createDevice(found, stored && { credentials: Credentials.parse(stored) });
    await device.connect();

    return {
        disconnect: () => device.disconnect(),
        initialVolume: device.volume.available ? Math.round(device.volume.level * 100) : null,
        onVolumeChange: (listener) =>
            device.volume.on('change', (state) => listener(Math.round(state.level * 100))),
        setMuted: (muted) => (muted ? device.volume.mute() : device.volume.unmute()),
        setVolume: (percent) => device.volume.set(percent / 100),
        stream: async (source, { muted, volume }) => {
            const playback = await device.media.streamAudio(source, {
                volume: muted || volume <= 0 ? 0 : percentToGain(volume),
            });
            return {
                ended: playback.ended,
                stop: () => {
                    playback.stop();
                    return settled(playback.ended);
                },
            };
        },
    };
}

/**
 * AirPlay 2 audio only, without the remote-control channel of the device layer. Third-party AirPlay
 * 2 receivers (WiiM and similar) refuse that channel, and AirPlay 1 streams to them are accepted
 * but stay silent. The volume is fixed when a stream starts; this mode cannot change it mid-stream.
 */
async function connectAirplay2Audio(
    found: DiscoveredDevice,
    stored?: StoredCredentials,
): Promise<Sink> {
    const service = found.services.airplay;
    if (!service) throw new Error('The device does not advertise AirPlay');
    const target = { address: found.address, id: found.id, port: service.port, txt: service.txt };

    // Pair once now so a refusal surfaces while connecting, not on the first play
    const credentials = stored && toAccessoryCredentials(stored);
    await (await airplayConnect(target, { credentials })).close();

    // This mode cannot change the receiver's stream volume once playing, so the app's volume is
    // applied to the audio itself and the receiver's own volume stays the master.
    let volume = 50;
    let muted = false;
    let active: FfmpegPcmSource | null = null;
    const applyGain = () => {
        if (active) active.gain = muted ? 0 : percentToGain(volume);
    };

    return {
        disconnect: async () => undefined,
        initialVolume: null,
        onVolumeChange: () => undefined,
        setMuted: async (next) => {
            muted = next;
            applyGain();
        },
        setVolume: async (percent) => {
            volume = percent;
            applyGain();
        },
        stream: async (source, options) => {
            volume = options.volume;
            muted = options.muted;
            active = source;
            applyGain();
            const session = await airplayConnect(target, { credentials });
            try {
                const playback = await session.streamAudio(source, { volumeDb: 0 });
                const release = () => session.close().catch(() => undefined);
                void playback.ended.then(release, release);
                return {
                    ended: playback.ended,
                    stop: async () => {
                        playback.stop();
                        await settled(playback.ended);
                        await release();
                    },
                };
            } catch (err) {
                await session.close().catch(() => undefined);
                throw err;
            }
        },
    };
}

let timingServer: null | Promise<TimingServer> = null;

const getTimingServer = () => {
    timingServer ??= (async () => {
        const server = new TimingServer();
        await server.listen();
        return server;
    })();
    return timingServer;
};

/**
 * Connects to a receiver, trying the protocols that suit it best first and falling back to the
 * rest: HomePods and Apple TVs use the full AirPlay 2 device layer, other AirPlay 2 receivers
 * (they advertise a public key) use audio-only AirPlay 2, and AirPlay 1 receivers use RAOP.
 */
export async function connectSink(
    found: DiscoveredDevice,
    stored?: StoredCredentials,
): Promise<Sink> {
    const isApple = found.family === DeviceFamily.HomePod || found.family === DeviceFamily.AppleTV;
    const isAirplay2 = Boolean(found.services.airplay?.txt?.pk);
    const attempts: Array<(f: DiscoveredDevice, s?: StoredCredentials) => Promise<Sink>> = isApple
        ? [connectAirplay2, connectRaop]
        : isAirplay2
          ? [connectAirplay2Audio, connectRaop, connectAirplay2]
          : [connectRaop, connectAirplay2Audio];

    let firstError: unknown;
    for (const attempt of attempts) {
        try {
            return await attempt(found, stored);
        } catch (err) {
            log.warn(`[airplay] ${attempt.name} failed for ${found.modelName || 'device'}`, err);
            firstError ??= err;
        }
    }
    throw firstError;
}

/**
 * AirPlay 1 (RAOP): shairport-sync and other receivers without AirPlay 2. A RAOP session carries one
 * stream, so each stream opens its own session.
 */
async function connectRaop(found: DiscoveredDevice): Promise<Sink> {
    const service = found.services.raop;
    if (!service) throw new Error('The device does not advertise RAOP');
    const target = { address: found.address, id: found.id, port: service.port, txt: service.txt };
    const timing = await getTimingServer();

    // Open one session now so a refusal surfaces while connecting, not on the first play
    await (await raopConnect(target, { timing })).close();

    let volume = 50;
    let muted = false;
    let active: Awaited<ReturnType<typeof raopConnect>> | null = null;
    const dbfs = () => (muted ? MUTE_DB : percentToAirplayDb(volume));

    return {
        disconnect: async () => undefined,
        initialVolume: null,
        onVolumeChange: () => undefined,
        setMuted: async (next) => {
            muted = next;
            await active?.setVolumeDb(dbfs());
        },
        setVolume: async (percent) => {
            volume = percent;
            await active?.setVolumeDb(dbfs());
        },
        stream: async (source, options) => {
            volume = options.volume;
            muted = options.muted;
            const session = await raopConnect(target, { timing });
            try {
                const playback = await session.stream(source, {
                    metadata: options.metadata,
                    volumeDb: dbfs(),
                });
                active = session;
                const release = () => {
                    if (active === session) active = null;
                    return session.close().catch(() => undefined);
                };
                void playback.ended.then(release, release);
                return {
                    ended: playback.ended,
                    stop: async () => {
                        playback.stop();
                        await settled(playback.ended);
                        await release();
                    },
                };
            } catch (err) {
                await session.close().catch(() => undefined);
                throw err;
            }
        },
    };
}
