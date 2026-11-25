import isElectron from 'is-electron';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { playerHandoff } from '../audio-player/engine/player-handoff';

import {
    getDefaultAudioDevice,
    useAudioDevices,
} from '/@/renderer/features/settings/components/playback/audio-settings';
import {
    usePlaybackSettings,
    usePlayerActions,
    usePlayerStore,
    usePlayerVolume,
    useSettingsStoreActions,
} from '/@/renderer/store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { AppIcon } from '/@/shared/components/icon/icon';
import { Paper } from '/@/shared/components/paper/paper';
import { Popover } from '/@/shared/components/popover/popover';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { PlayerStatus, PlayerType } from '/@/shared/types/types';

const airplayPlayer = isElectron() ? window.api.airplayPlayer : null;

interface AirplayDevice {
    id: string;
    model: string;
    name: string;
}

export const AirplayCastButton = () => {
    const { t } = useTranslation();
    const { setSettings } = useSettingsStoreActions();
    const { setVolume } = usePlayerActions();
    const volume = usePlayerVolume();
    const settings = usePlaybackSettings();

    const [showPopover, setShowPopover] = useState(false);
    const [devices, setDevices] = useState<AirplayDevice[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [connectedDevice, setConnectedDevice] = useState<AirplayDevice | null>(null);
    // Set while a device that asked for a PIN is waiting for the code shown on its screen
    const [pinDevice, setPinDevice] = useState<AirplayDevice | null>(null);
    const [pin, setPin] = useState('');
    const [pinError, setPinError] = useState(false);
    const previousPlayerTypeRef = useRef<PlayerType>(
        settings.type === PlayerType.AIRPLAY ? PlayerType.WEB : settings.type,
    );

    const isConnected = settings.type === PlayerType.AIRPLAY;
    // While casting, the settings hold AirPlay as the type, so the local output belongs to the
    // player that was active before
    const localType = isConnected ? previousPlayerTypeRef.current : settings.type;
    const localDevices = useAudioDevices(localType);
    const localDeviceKey = localType === PlayerType.LOCAL ? 'mpvAudioDeviceId' : 'audioDeviceId';
    const localDeviceId =
        settings[localDeviceKey] ?? getDefaultAudioDevice(localDevices, localType);

    // Discovery keeps the previous list on screen, so a refresh never empties it
    const handleDiscover = useCallback(async () => {
        if (!airplayPlayer) return;
        setIsLoading(true);
        try {
            setDevices(await airplayPlayer.discover());
        } catch {
            // Keep the cached list
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Look for devices at launch so the list is ready the first time the popover opens
    useEffect(() => {
        void handleDiscover();
    }, [handleDiscover]);

    const handleSelect = useCallback(
        async (device: AirplayDevice) => {
            if (!airplayPlayer) return;
            const localWasPlaying =
                usePlayerStore.getState().player.status === PlayerStatus.PLAYING;
            // Only a first connection hands the local position over; switching between AirPlay
            // devices is carried over by the main process
            playerHandoff.pendingDlnaSeek =
                localWasPlaying && settings.type !== PlayerType.AIRPLAY
                    ? useTimestampStoreBase.getState().timestamp
                    : -1;
            if (settings.type !== PlayerType.AIRPLAY) previousPlayerTypeRef.current = settings.type;

            setIsConnecting(true);
            const result = await airplayPlayer.connect(device.id);
            setIsConnecting(false);
            if (result.needsPin) {
                // The device asked for pairing; it shows a PIN on its screen once we start one
                playerHandoff.pendingDlnaSeek = -1;
                if (await airplayPlayer.pairStart(device.id)) {
                    setPin('');
                    setPinError(false);
                    setPinDevice(device);
                } else {
                    toast.error({ message: t('airplay.errors.pairing-failed') });
                }
                return;
            }
            if (!result.success) {
                playerHandoff.pendingDlnaSeek = -1;
                return;
            }

            setVolume(result.volume);
            setConnectedDevice(device);
            setSettings({
                playback: {
                    ...settings,
                    previousLocalVolume: volume,
                    previousPlayerType: previousPlayerTypeRef.current,
                    type: PlayerType.AIRPLAY,
                },
            });
        },
        [setSettings, setVolume, settings, t, volume],
    );

    const handlePinSubmit = useCallback(async () => {
        if (!airplayPlayer || !pinDevice) return;
        setIsConnecting(true);
        const paired = await airplayPlayer.pairFinish(pin.trim());
        setIsConnecting(false);
        if (!paired) {
            setPinError(true);
            return;
        }
        const device = pinDevice;
        setPinDevice(null);
        await handleSelect(device);
    }, [handleSelect, pin, pinDevice]);

    const handlePinCancel = useCallback(() => {
        airplayPlayer?.pairCancel();
        setPinDevice(null);
    }, []);

    // Leaves AirPlay and returns to the local player, optionally with another output device
    const handleSelectLocal = useCallback(
        async (deviceId?: string) => {
            const deviceUpdate = deviceId ? { [localDeviceKey]: deviceId } : {};
            if (!isConnected || !airplayPlayer) {
                if (deviceId) setSettings({ playback: deviceUpdate });
                return;
            }
            const position = await airplayPlayer.getPosition();
            if (position > 0) playerHandoff.pendingLocalSeek = position;
            await airplayPlayer.disconnect();

            setConnectedDevice(null);
            setSettings({
                playback: { ...settings, ...deviceUpdate, type: previousPlayerTypeRef.current },
            });
            if (settings.previousLocalVolume !== undefined) setVolume(settings.previousLocalVolume);
        },
        [isConnected, localDeviceKey, setSettings, setVolume, settings],
    );

    // A persisted AirPlay type left over from a previous run is reset by the DLNA cast button's
    // mount effect, which restores previousPlayerType for any casting type.

    useEffect(() => {
        const listener = window.api?.airplayPlayerListener;
        if (!listener) return;
        // Connection failures happen before the engine mounts, so surface them here too
        return listener.rendererError((_event, code) => {
            if (code === 'connect-failed' || code === 'access-denied') {
                toast.error({ message: t(`airplay.errors.${code}`) });
            }
        });
    }, [t]);

    if (!isElectron()) return null;

    const busy = isConnecting || pinDevice !== null;
    // The connected device can drop out of a discovery pass; keep it listed
    const airplayDevices =
        connectedDevice && !devices.some((d) => d.id === connectedDevice.id)
            ? [connectedDevice, ...devices]
            : devices;

    return (
        <Popover onChange={setShowPopover} opened={showPopover} position="top">
            <Popover.Target>
                <ActionIcon
                    icon="airplay"
                    iconProps={{ color: isConnected ? 'primary' : undefined, size: 'lg' }}
                    onClick={(e) => {
                        e.stopPropagation();
                        const opening = !showPopover;
                        setShowPopover(opening);
                        if (opening) void handleDiscover();
                    }}
                    size="sm"
                    tooltip={{
                        label:
                            isConnected && connectedDevice
                                ? t('airplay.castingToDevice', { name: connectedDevice.name })
                                : t('airplay.castToDevice'),
                        openDelay: 0,
                    }}
                    variant="subtle"
                />
            </Popover.Target>
            <Popover.Dropdown
                onClick={(event) => event.stopPropagation()}
                p="sm"
                style={{ minWidth: 300 }}
            >
                <Paper p="md" radius="md">
                    {isConnecting && (
                        <Group p="sm">
                            <Spinner size="sm" />
                            <Text c="dimmed">{t('airplay.connecting')}</Text>
                        </Group>
                    )}
                    {!isConnecting && pinDevice && (
                        <Stack gap="sm">
                            <Text>{t('airplay.pinPrompt', { name: pinDevice.name })}</Text>
                            <TextInput
                                autoFocus
                                error={pinError ? t('airplay.pinWrong') : undefined}
                                inputMode="numeric"
                                onChange={(e) => {
                                    setPin(e.currentTarget.value);
                                    setPinError(false);
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && pin.trim()) void handlePinSubmit();
                                }}
                                value={pin}
                            />
                            <Group grow>
                                <Button onClick={handlePinCancel} variant="default">
                                    {t('airplay.cancel')}
                                </Button>
                                <Button disabled={!pin.trim()} onClick={handlePinSubmit}>
                                    {t('airplay.pair')}
                                </Button>
                            </Group>
                        </Stack>
                    )}
                    {!busy && (
                        <Stack gap="xs">
                            <Text fw={600} size="sm" tt="uppercase">
                                {t('airplay.audioOutput')}
                            </Text>
                            {localDevices.length === 0 ? (
                                <OutputRow
                                    label={t('airplay.thisComputer')}
                                    onClick={() => handleSelectLocal()}
                                    selected={!isConnected}
                                />
                            ) : (
                                localDevices.map((device, index) => (
                                    <OutputRow
                                        key={device.value}
                                        // The browser hides output names until audio permission is granted
                                        label={
                                            device.label ||
                                            (index === 0
                                                ? t('airplay.thisComputer')
                                                : `${t('airplay.audioOutput')} ${index + 1}`)
                                        }
                                        onClick={() => handleSelectLocal(device.value)}
                                        selected={!isConnected && device.value === localDeviceId}
                                    />
                                ))
                            )}
                            <Group justify="space-between" mt="sm">
                                <Text fw={600} size="sm" tt="uppercase">
                                    AirPlay
                                </Text>
                                <ActionIcon
                                    icon="refresh"
                                    loading={isLoading}
                                    onClick={() => void handleDiscover()}
                                    size="xs"
                                    tooltip={{ label: t('airplay.search'), openDelay: 0 }}
                                    variant="subtle"
                                />
                            </Group>
                            {airplayDevices.length === 0 && (
                                <Group p="sm">
                                    {isLoading ? (
                                        <Spinner size="sm" />
                                    ) : (
                                        <AppIcon.circleSlash size={12} />
                                    )}
                                    <Text c="dimmed">
                                        {isLoading
                                            ? t('airplay.searching')
                                            : t('airplay.noDevicesFound')}
                                    </Text>
                                </Group>
                            )}
                            {airplayDevices.map((device) => (
                                <OutputRow
                                    key={device.id}
                                    label={device.name}
                                    onClick={() => handleSelect(device)}
                                    selected={isConnected && connectedDevice?.id === device.id}
                                    subLabel={device.model}
                                />
                            ))}
                        </Stack>
                    )}
                </Paper>
            </Popover.Dropdown>
        </Popover>
    );
};

const OutputRow = ({
    label,
    onClick,
    selected,
    subLabel,
}: {
    label: string;
    onClick: () => void;
    selected: boolean;
    subLabel?: string;
}) => (
    <Button
        fullWidth
        justify="space-between"
        onClick={selected ? undefined : onClick}
        rightSection={selected ? <AppIcon.check size={14} /> : undefined}
        variant={selected ? 'filled' : 'subtle'}
    >
        <Stack gap={0} style={{ alignItems: 'flex-start' }}>
            <Text component="span" size="sm">
                {label}
            </Text>
            {subLabel && (
                <Text c="dimmed" component="span" size="xs">
                    {subLabel}
                </Text>
            )}
        </Stack>
    </Button>
);
