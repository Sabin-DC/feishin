import { useCallback, useRef } from 'react';

import { AirplayPlayerEngine, AirplayPlayerEngineHandle } from './engine/airplay-player-engine';

import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import {
    usePlayerActions,
    usePlayerData,
    usePlayerMuted,
    usePlayerVolume,
} from '/@/renderer/store';

export function AirplayPlayer() {
    const playerRef = useRef<AirplayPlayerEngineHandle>(null);
    const { status } = usePlayerData();
    const { mediaAutoNext } = usePlayerActions();
    const isMuted = usePlayerMuted();
    const volume = usePlayerVolume();
    const player = usePlayer();

    const handleOnEnded = useCallback(() => {
        mediaAutoNext();
    }, [mediaAutoNext]);

    usePlayerEvents(
        {
            onQueueCleared: () => {
                player.mediaStop();
            },
        },
        [],
    );

    return (
        <AirplayPlayerEngine
            isMuted={isMuted}
            onEnded={handleOnEnded}
            playerRef={playerRef}
            playerStatus={status}
            volume={volume}
        />
    );
}
