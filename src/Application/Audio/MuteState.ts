import UIEventBus from '../UI/EventBus';

let muted = false;

export const getMuteState = () => muted;

export const setMuteState = (nextMuted: boolean) => {
    if (muted === nextMuted) return;
    muted = nextMuted;
    UIEventBus.dispatch('muteToggle', muted);
};

export const toggleMuteState = () => setMuteState(!muted);
