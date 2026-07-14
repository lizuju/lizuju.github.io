import React, { useCallback, useEffect, useState } from 'react';
import eventBus from '../EventBus';

type LoadingFailure = {
    kind: 'resource' | 'webgl';
    sourceName?: string;
};

const getSpace = (sourceName: string) =>
    '\xa0'.repeat(Math.max(0, 24 - sourceName.length));

const getCurrentDate = () => {
    const date = new Date();
    return new Intl.DateTimeFormat('en-US', {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
    }).format(date);
};

const detectWebGLContext = () => {
    const canvas = document.createElement('canvas');
    const context =
        canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    return Boolean(context);
};

const LoadingScreen: React.FC = () => {
    const [progress, setProgress] = useState(0);
    const [toLoad, setToLoad] = useState(0);
    const [completed, setCompleted] = useState(0);
    const [resources, setResources] = useState<string[]>([]);
    const [failure, setFailure] = useState<LoadingFailure>();
    const [loadingTextVisible, setLoadingTextVisible] = useState(true);
    const [startPopupVisible, setStartPopupVisible] = useState(false);
    const [started, setStarted] = useState(false);

    const start = useCallback(() => {
        setStarted(true);
        document.querySelector('.direct-entry')?.classList.add('is-visible');
        eventBus.dispatch('loadingScreenDone', {});
        const ui = document.getElementById('ui');
        if (ui) ui.style.pointerEvents = 'none';
    }, []);

    useEffect(() => {
        if (new URLSearchParams(window.location.search).has('debug')) {
            start();
            return;
        }

        if (!detectWebGLContext()) {
            setFailure({ kind: 'webgl' });
        }
    }, [start]);

    useEffect(() => {
        const removeLoadedSource = eventBus.on('loadedSource', (data) => {
            setProgress(data.progress);
            setToLoad(data.toLoad);
            setCompleted(data.completed);
            setResources((current) => [
                ...current.slice(-7),
                `Loaded ${data.sourceName}${getSpace(data.sourceName)} ... ${Math.round(
                    data.progress * 100
                )}%`,
            ]);
        });
        const removeFailedSource = eventBus.on('failedSource', (data) => {
            setProgress(data.progress);
            setToLoad(data.toLoad);
            setCompleted(data.completed);
            setFailure({ kind: 'resource', sourceName: data.sourceName });
        });

        return () => {
            removeLoadedSource();
            removeFailedSource();
        };
    }, []);

    useEffect(() => {
        if (progress < 1 || failure) return;

        const loadingTimer = window.setTimeout(() => {
            setLoadingTextVisible(false);
        }, 1000);
        const popupTimer = window.setTimeout(() => {
            setStartPopupVisible(true);
        }, 1500);

        return () => {
            window.clearTimeout(loadingTimer);
            window.clearTimeout(popupTimer);
        };
    }, [progress, failure]);

    const errorTitle =
        failure?.kind === 'webgl'
            ? '无法启动 3D 场景 / 3D scene unavailable'
            : '3D 资源加载失败 / Resource loading failed';
    const errorDetail =
        failure?.kind === 'webgl'
            ? '浏览器未启用 WebGL。你仍可直接查看完整作品集。'
            : `资源 ${failure?.sourceName || ''} 未能加载。请重试，或直接查看完整作品集。`;

    return (
        <div
            style={Object.assign({}, styles.overlay, {
                opacity: started ? 0 : 1,
                transform: `scale(${started ? 1.1 : 1})`,
            })}
        >
            {!failure && !startPopupVisible && !loadingTextVisible && (
                <div style={styles.blinkingContainer}>
                    <span className="blinking-cursor" />
                </div>
            )}
            {!failure && (
                <div
                    style={Object.assign({}, styles.overlayText, {
                        opacity: loadingTextVisible ? 1 : 0,
                    })}
                >
                    <div style={styles.header} className="loading-screen-header">
                        <div style={styles.logoContainer}>
                            <div>
                                <p style={styles.green}>
                                    <b>Gavin,</b>{' '}
                                </p>
                                <p style={styles.green}>
                                    <b>Immersive Portfolio</b>
                                </p>
                            </div>
                        </div>
                        <div style={styles.headerInfo}>
                            <p>Released: 07/10/2026</p>
                            <p>GAVIN BIOS / PORTFOLIO SYSTEM</p>
                        </div>
                    </div>
                    <div style={styles.body} className="loading-screen-body">
                        <p>AI AGENT / ROBOTICS / COMPUTER VISION</p>
                        <div style={styles.spacer} />
                        <p>Gavin Portfolio System V1.0</p>
                        <p>Checking memory : 14000 OK</p>
                        <div style={styles.spacer} />
                        <div style={styles.spacer} />
                        {toLoad === 0 ? (
                            <p className="loading">Please wait</p>
                        ) : progress >= 1 ? (
                            <p>Core scene loaded</p>
                        ) : (
                            <p className="loading" data-loading-progress>
                                Loading resources ({completed}/{toLoad})
                            </p>
                        )}
                        <div style={styles.spacer} />
                        <div style={styles.resourcesLoadingList}>
                            {resources.map((sourceName) => (
                                <p key={sourceName}>{sourceName}</p>
                            ))}
                        </div>
                        <div style={styles.spacer} />
                        {progress >= 1 && (
                            <p>
                                Core scene loaded. Launching{' '}
                                <b style={styles.green}>'Gavin Lizuju Portfolio'</b>{' '}
                                V1.0
                            </p>
                        )}
                        <div style={styles.spacer} />
                        <span className="blinking-cursor" />
                    </div>
                    <div style={styles.footer} className="loading-screen-footer">
                        <p>Desktop immersive experience</p>
                        <p>{getCurrentDate()}</p>
                    </div>
                </div>
            )}
            <div
                style={Object.assign({}, styles.popupContainer, {
                    opacity: startPopupVisible && !started ? 1 : 0,
                    visibility: startPopupVisible && !started ? 'visible' : 'hidden',
                    pointerEvents: startPopupVisible && !started ? 'auto' : 'none',
                })}
            >
                <div style={styles.startPopup}>
                    <p>Gavin Lizuju · Immersive Portfolio</p>
                    <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                        <p>Click to enter{'\xa0'}</p>
                        <span className="blinking-cursor" />
                    </div>
                    <div className="bios-action-row">
                        <button
                            className="bios-start-button"
                            type="button"
                            data-start-scene
                            onClick={start}
                        >
                            Enter
                        </button>
                    </div>
                </div>
            </div>
            {failure && (
                <div style={styles.popupContainer} data-resource-error role="alert">
                    <div style={styles.startPopup}>
                        <p>
                            <b style={styles.error}>{errorTitle}</b>
                        </p>
                        <div style={styles.spacer} />
                        <p>{errorDetail}</p>
                        <div className="bios-action-row bios-action-row--error">
                            <button
                                className="bios-start-button"
                                type="button"
                                data-resource-retry
                                onClick={() => window.location.reload()}
                            >
                                重试 / Retry
                            </button>
                            <a className="bios-start-button" data-resource-direct href="portfolio/">
                                直接查看作品集 / Direct view
                            </a>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const styles: StyleSheetCSS = {
    overlay: {
        backgroundColor: 'black',
        width: '100%',
        height: '100%',
        display: 'flex',
        transition: 'opacity 0.2s, transform 0.2s',
        transitionTimingFunction: 'ease-in-out',
        boxSizing: 'border-box',
        fontSize: 16,
        letterSpacing: 0.8,
    },
    spacer: {
        height: 16,
    },
    header: {
        width: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'row',
    },
    popupContainer: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
        boxSizing: 'border-box',
    },
    blinkingContainer: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        display: 'flex',
        boxSizing: 'border-box',
        padding: 48,
    },
    startPopup: {
        backgroundColor: '#000',
        padding: 24,
        border: '7px solid #fff',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        width: 'min(500px, 100%)',
        boxSizing: 'border-box',
    },
    headerInfo: {
        marginLeft: 64,
    },
    error: {
        color: '#ff5c5c',
    },
    overlayText: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        transition: 'opacity 0.2s',
    },
    body: {
        flex: 1,
        display: 'flex',
        width: '100%',
        boxSizing: 'border-box',
        flexDirection: 'column',
    },
    logoContainer: {
        display: 'flex',
        flexDirection: 'row',
    },
    resourcesLoadingList: {
        display: 'flex',
        paddingLeft: 32,
        paddingBottom: 32,
        flexDirection: 'column',
    },
    footer: {
        boxSizing: 'border-box',
        width: '100%',
    },
    green: {
        color: '#00ff00',
    },
};

export default LoadingScreen;
