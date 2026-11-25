import { ipcRenderer, IpcRendererEvent } from 'electron';

export interface AirplayDevice {
    id: string;
    model: string;
    name: string;
}

function singleOn<T extends (...args: any[]) => void>(channel: string, cb: T): () => void {
    ipcRenderer.on(channel, cb);
    return () => ipcRenderer.removeListener(channel, cb);
}

const discover = (): Promise<AirplayDevice[]> => ipcRenderer.invoke('airplay-discover');
const connect = (id: string): Promise<{ needsPin?: boolean; success: boolean; volume: number }> =>
    ipcRenderer.invoke('airplay-connect', id);
const pairStart = (id: string): Promise<boolean> => ipcRenderer.invoke('airplay-pair-start', id);
const pairFinish = (pin: string): Promise<boolean> =>
    ipcRenderer.invoke('airplay-pair-finish', pin);
const pairCancel = () => ipcRenderer.send('airplay-pair-cancel');
const disconnect = (): Promise<boolean> => ipcRenderer.invoke('airplay-disconnect');
const playUrl = (
    url: string,
    options?: {
        duration?: number;
        metadata?: { album: string; artist: string; title: string };
        seekTo?: number;
    },
) => ipcRenderer.send('airplay-play-url', { url, ...options });
const play = () => ipcRenderer.send('airplay-play');
const pause = () => ipcRenderer.send('airplay-pause');
const stop = () => ipcRenderer.send('airplay-stop');
const seek = (seconds: number) => ipcRenderer.send('airplay-seek', seconds);
const volume = (value: number) => ipcRenderer.send('airplay-volume', value);
const mute = (muted: boolean) => ipcRenderer.send('airplay-mute', muted);
const getPosition = (): Promise<number> => ipcRenderer.invoke('airplay-get-position');

const rendererCurrentTime = (cb: (event: IpcRendererEvent, time: number) => void) =>
    singleOn('renderer-airplay-current-time', cb);
const rendererTrackEnded = (cb: (event: IpcRendererEvent) => void) =>
    singleOn('renderer-airplay-track-ended', cb);
const rendererVolume = (cb: (event: IpcRendererEvent, volume: number) => void) =>
    singleOn('renderer-airplay-volume', cb);
const rendererError = (cb: (event: IpcRendererEvent, code: string) => void) =>
    singleOn('renderer-airplay-error', cb);

export const airplayPlayer = {
    connect,
    disconnect,
    discover,
    getPosition,
    mute,
    pairCancel,
    pairFinish,
    pairStart,
    pause,
    play,
    playUrl,
    seek,
    stop,
    volume,
};

export const airplayPlayerListener = {
    rendererCurrentTime,
    rendererError,
    rendererTrackEnded,
    rendererVolume,
};

export type AirplayPlayer = typeof airplayPlayer;

export type AirplayPlayerListener = typeof airplayPlayerListener;
