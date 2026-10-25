(() => {
    const { SUPPORTED_LANGS, CONTENT } = window.PORTFOLIO_DATA;
    const LANGUAGE_KEY = 'portfolio-lang';
    const DESKTOP_SESSION_KEY = document.body.classList.contains('standalone-sync')
        ? 'gavin-chat-window-session' : 'gavin-portfolio-desktop-session';

    function normalizeLanguage(lang) {
        return SUPPORTED_LANGS.includes(lang) ? lang : 'zh-CN';
    }

    function readStoredLanguage() {
        try {
            return localStorage.getItem(LANGUAGE_KEY);
        } catch {
            return null;
        }
    }

    function storeLanguage(lang) {
        try {
            localStorage.setItem(LANGUAGE_KEY, lang);
        } catch {
            // Language persistence is optional; the page should still work without browser storage.
        }
    }

    function readDesktopSession() {
        try {
            const value = sessionStorage.getItem(DESKTOP_SESSION_KEY);
            return value ? JSON.parse(value) : null;
        } catch {
            return null;
        }
    }

    function storeDesktopSession(session) {
        try {
            sessionStorage.setItem(DESKTOP_SESSION_KEY, JSON.stringify(session));
        } catch {
            // Session recovery is optional; the portfolio remains usable without browser storage.
        }
    }

    let currentLang = normalizeLanguage(readStoredLanguage());

    // Shared state and helpers for the desktop scripts. Each app module adds a setup function to
    // GavinDesktop.apps; main.js creates the window manager and sets the apps up in order.
    window.GavinDesktop = {
        apps: {},
        getLanguage: () => currentLang,
        setLanguage(lang) {
            currentLang = normalizeLanguage(lang);
            storeLanguage(currentLang);
        },
        t: () => CONTENT[currentLang] || CONTENT['zh-CN'],
        readDesktopSession,
        storeDesktopSession,
        getSessionContext: () => window.parent === window ? 'direct' : 'embedded',
        isMobileHomepage: () => document.body.classList.contains('mobile-homepage')
    };
})();
