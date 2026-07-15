import './style.css';

const mobileModeQuery = window.matchMedia(
    '(max-width: 820px), (pointer: coarse) and (max-height: 520px)'
);

function startShell(mobileMode: boolean) {
    document.body.classList.toggle('mobile-mode', mobileMode);

    if (!mobileMode) {
        import(
            /* webpackChunkName: "immersive" */ './Application/Application'
        )
            .then(({ default: Application }) => new Application())
            .catch((error) => {
                console.warn('Unable to start the immersive shell', error);
                const shellError = document.getElementById('shell-error');
                if (shellError) shellError.hidden = false;
            });
    }
}

startShell(mobileModeQuery.matches);

mobileModeQuery.addEventListener('change', () => {
    window.location.reload();
});
