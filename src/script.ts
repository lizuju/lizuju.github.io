import './style.css';

if (window.matchMedia('(max-width: 820px)').matches) {
    document.body.classList.add('mobile-mode');
} else {
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
