import './style.css';

const mobileModeQuery = window.matchMedia(
    '(max-width: 820px), (pointer: coarse) and (max-height: 520px)'
);

function startMobilePortfolio() {
    const enterButton = document.querySelector<HTMLButtonElement>('[data-mobile-enter]');
    const portfolio = document.getElementById('mobile-portfolio') as HTMLIFrameElement | null;

    if (!enterButton || !portfolio) return;

    enterButton.addEventListener('click', () => {
        if (!portfolio.getAttribute('src')) {
            portfolio.src = portfolio.dataset.src || 'portfolio/';
        }
        document.body.classList.add('mobile-portfolio-started');
    });
}

function startShell(mobileMode: boolean) {
    document.body.classList.toggle('mobile-mode', mobileMode);

    if (mobileMode) {
        startMobilePortfolio();
        return;
    }

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

startShell(mobileModeQuery.matches);

mobileModeQuery.addEventListener('change', () => {
    window.location.reload();
});
