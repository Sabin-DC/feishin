import type { RefObject } from 'react';

import isElectron from 'is-electron';
import { useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { playerHandoff } from './player-handoff';

import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { getSongUrl } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';
import { AudioPlayer } from '/@/renderer/features/player/audio-player/types';
import { usePlaybackSettings, usePlayerActions, usePlayerStore } from '/@/renderer/store';
import { toast } from '/@/shared/components/toast/toast';
import { PlayerStatus } from '/@/shared/types/types';

export interface AirplayPlayerEngineHandle extends AudioPlayer {}

interface AirplayPlayerEngineProps {
    isMuted: boolean;
    onEnded: () => void;
    playerRef: RefObject<AirplayPlayerEngineHandle | null>;
    playerStatus: PlayerStatus;
    volume: number;
}

const airplayPlayer = isElectron() ? window.api.airplayPlayer : null;
const airplayPlayerListener = isElectron() ? window.api.airplayPlayerListener : null;

export const AirplayPlayerEngine = (props: AirplayPlayerEngineProps) => {
    const { isMuted, onEnded, playerRef, playerStatus, volume } = props;
    const { t } = useTranslation();
    const { transcode } = usePlaybackSettings();
    const { mediaPause, setTimestamp, setVolume } = usePlayerActions();
    // The id of the song the device currently holds; a play of the same song just resumes
    const sentSongIdRef = useRef<string>('');
    const sendGenerationRef = useRef(0);

    const sendCurrentTrack = useCallback(async () => {
        if (!airplayPlayer) return;
        const generation = ++sendGenerationRef.current;
        const song = usePlayerStore.getState().getPlayerData().currentSong;
        if (!song) return;

        const url = await getSongUrl(song, transcode);
        // A rapid skip supersedes this send
        if (!url || generation !== sendGenerationRef.current) return;

        const seekTo = Math.max(playerHandoff.pendingDlnaSeek, 0);
        playerHandoff.pendingDlnaSeek = -1;
        sentSongIdRef.current = song._uniqueId;
        airplayPlayer.playUrl(url, {
            duration: song.duration ? song.duration / 1000 : 0,
            metadata: {
                album: song.album ?? '',
                artist: song.artistName || song.artists?.[0]?.name || '',
                title: song.name,
            },
            seekTo,
        });
    }, [transcode]);

    // Mount: if the app was playing when casting started, send the track right away
    useEffect(() => {
        if (playerStatus === PlayerStatus.PLAYING) void sendCurrentTrack();
        // Only run on mount
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!airplayPlayerListener) return;
        return airplayPlayerListener.rendererCurrentTime((_event, time) => {
            if (usePlayerStore.getState().player.status === PlayerStatus.STOPPED) return;
            setTimestamp(Math.floor(time));
        });
    }, [setTimestamp]);

    useEffect(() => {
        if (!airplayPlayerListener) return;
        return airplayPlayerListener.rendererVolume((_event, vol) => setVolume?.(vol));
    }, [setVolume]);

    useEffect(() => {
        if (!airplayPlayerListener) return;
        return airplayPlayerListener.rendererTrackEnded(() => {
            const state = usePlayerStore.getState();
            const isAtEnd = !state.getPlayerData().nextSong;
            const endedId = sentSongIdRef.current;
            sentSongIdRef.current = '';
            if (isAtEnd && state.player.repeat === 'none') airplayPlayer?.stop();
            // Advances the queue; the song-change subscription below sends the next track
            onEnded();
            // Repeat-one keeps the same song, so nothing changes for the subscription to see
            const after = usePlayerStore.getState();
            if (
                after.player.status === PlayerStatus.PLAYING &&
                after.getPlayerData().currentSong?._uniqueId === endedId
            ) {
                void sendCurrentTrack();
            }
        });
    }, [onEnded, sendCurrentTrack]);

    useEffect(() => {
        if (!airplayPlayerListener) return;
        return airplayPlayerListener.rendererError((_event, code) => {
            toast.error({ message: t(`airplay.errors.${code}`, { defaultValue: code }) });
            // Without this the app would keep showing playback that is not happening
            mediaPause?.();
        });
    }, [mediaPause, t]);

    // Play / pause
    const isInitialMount = useRef(true);
    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }
        if (!airplayPlayer) return;
        if (playerStatus === PlayerStatus.PLAYING) {
            const currentId = usePlayerStore.getState().getPlayerData().currentSong?._uniqueId;
            if (currentId && currentId === sentSongIdRef.current) {
                airplayPlayer.play();
            } else {
                void sendCurrentTrack();
            }
        } else if (playerStatus === PlayerStatus.PAUSED) {
            airplayPlayer.pause();
        }
    }, [playerStatus, sendCurrentTrack]);

    useEffect(() => {
        airplayPlayer?.volume(volume);
    }, [volume]);

    useEffect(() => {
        airplayPlayer?.mute(isMuted);
    }, [isMuted]);

    usePlayerEvents(
        {
            onMediaNext: () => void sendCurrentTrack(),
            onMediaPrev: () => void sendCurrentTrack(),
            onPlayerSeekToTimestamp: (properties) => {
                // mediaStop emits a zero seek after setting STOPPED
                if (usePlayerStore.getState().player.status === PlayerStatus.STOPPED) return;
                const currentId = usePlayerStore.getState().getPlayerData().currentSong?._uniqueId;
                // A track change resets the timestamp in the same update; that is not a seek
                if (currentId !== sentSongIdRef.current) return;
                airplayPlayer?.seek(properties.timestamp);
            },
            onPlayerStop: () => {
                airplayPlayer?.stop();
                sentSongIdRef.current = '';
            },
            onQueueCleared: () => {
                airplayPlayer?.stop();
                sentSongIdRef.current = '';
            },
            onQueueRestored: () => void sendCurrentTrack(),
        },
        [sendCurrentTrack],
    );

    // A song change that no skip handler caught (auto-advance, play by index)
    useEffect(() => {
        return usePlayerStore.subscribe(
            (state) => state.getPlayerData().currentSong?._uniqueId ?? null,
            (nextId, prevId) => {
                if (nextId === prevId || !nextId) return;
                if (usePlayerStore.getState().player.status !== PlayerStatus.PLAYING) return;
                if (nextId === sentSongIdRef.current) return;
                void sendCurrentTrack();
            },
        );
    }, [sendCurrentTrack]);

    useImperativeHandle<AirplayPlayerEngineHandle, AirplayPlayerEngineHandle>(playerRef, () => ({
        decreaseVolume(by: number) {
            airplayPlayer?.volume(Math.max(0, volume - by));
        },
        increaseVolume(by: number) {
            airplayPlayer?.volume(Math.min(100, volume + by));
        },
        pause() {
            airplayPlayer?.pause();
        },
        play() {
            airplayPlayer?.play();
        },
        seekTo(seconds: number) {
            airplayPlayer?.seek(seconds);
        },
        setVolume(vol: number) {
            airplayPlayer?.volume(vol);
        },
    }));

    return <div id="airplay-player-engine" style={{ display: 'none' }} />;
};

AirplayPlayerEngine.displayName = 'AirplayPlayerEngine';
