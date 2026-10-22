import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import UIEventBus from '../EventBus';
import { Easing } from '../Animation';
import { getMuteState, toggleMuteState } from '../../Audio/MuteState';
// @ts-ignore
import volumeOn from '../../../../static/textures/UI/volume_on.svg';
// @ts-ignore
import volumeOff from '../../../../static/textures/UI/volume_off.svg';

interface MuteToggleProps {
    disabled: boolean;
}

const MuteToggle: React.FC<MuteToggleProps> = ({ disabled }) => {
    const [isHovering, setIsHovering] = useState(false);
    const [isActive, setIsActive] = useState(false);
    const [muted, setMuted] = useState(getMuteState);

    const onMouseDownHandler = useCallback(
        () => {
            setIsActive(true);
        },
        []
    );

    const onMouseUpHandler = useCallback(() => {
        setIsActive(false);
    }, []);

    useEffect(() => UIEventBus.on('muteToggle', setMuted), []);

    return (
        <button
            type="button"
            tabIndex={0}
            disabled={disabled}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
            style={styles.container}
            onMouseDown={onMouseDownHandler}
            onMouseUp={onMouseUpHandler}
            onClick={toggleMuteState}
            className="icon-control-container"
            data-audio-mute-toggle
            aria-label={muted ? 'Unmute background music' : 'Mute background music'}
            aria-pressed={muted}
            id="prevent-click"
        >
            <motion.img
                alt=""
                id="prevent-click"
                src={muted ? volumeOff : volumeOn}
                style={{ opacity: isActive ? 0.2 : isHovering ? 0.8 : 1 }}
                width={window.innerWidth < 768 ? 8 : 10}
                animate={
                    isActive ? 'active' : isHovering ? 'hovering' : 'default'
                }
                variants={iconVars}
            />
        </button>
    );
};

const iconVars = {
    hovering: {
        // scale: 1.2,
        opacity: 0.8,
        transition: {
            duration: 0.1,
            ease: 'easeOut',
        },
    },
    active: {
        scale: 0.8,
        opacity: 0.5,
        transition: {
            duration: 0.1,
            ease: Easing.expOut,
        },
    },
    default: {
        scale: 1,
        opacity: 1,
        transition: {
            duration: 0.2,
            ease: 'easeOut',
        },
    },
};

const styles: StyleSheetCSS = {
    container: {
        background: 'black',
        // padding: 4,
        // paddingLeft: 8,
        // paddingRight: 8,
        textAlign: 'center',
        display: 'flex',
        // position: 'absolute',
        boxSizing: 'border-box',
        justifyContent: 'center',
        alignItems: 'center',
        cursor: 'pointer',
    },
};

export default MuteToggle;
