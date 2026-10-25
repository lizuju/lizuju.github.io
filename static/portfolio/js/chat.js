import '../css/base.css';
import '../css/desktop.css';
import '../css/apps/preview-zoom.css';
import '../css/apps/sync-space.css';
import '../css/apps/sync-preview.css';
import '../css/taskbar.css';
import '../css/desktop-responsive.css';
import '../css/chat.css';
import './desktop/core.js';
import './desktop/window-manager.js';
import './apps/sync-preview.js';
import './apps/sync-space.js';

document.addEventListener('DOMContentLoaded', () => {
    const desktopApi = window.GavinDesktop;
    const manager = desktopApi.createWindowManager({
        desktop: document.querySelector('[data-retro-desktop]'),
        startButton: document.querySelector('[data-start-toggle]'),
        startMenu: document.querySelector('[data-start-menu]')
    });
    const preview = desktopApi.apps.syncPreview(manager);
    const chat = desktopApi.apps.syncSpace(manager, preview);
    manager.bindGlobalListeners();
    chat.element.classList.add('is-maximized');
    chat.show();

    const languageButton = document.querySelector('[data-taskbar-lang]');
    const applyLanguage = () => {
        const language = desktopApi.getLanguage();
        const copy = desktopApi.t();
        document.documentElement.lang = language;
        document.title = `${copy.desktopSyncSpace} | GAVIN OS`;
        for (const [attribute, target] of [['data-i18n', 'textContent'], ['data-i18n-placeholder', 'placeholder'], ['data-i18n-aria', 'ariaLabel']]) {
            document.querySelectorAll(`[${attribute}]`).forEach(element => {
                const text = copy[element.getAttribute(attribute)];
                if (text) element[target] = text;
            });
        }
        const chinese = language === 'zh-CN';
        languageButton.textContent = chinese ? 'EN' : '中';
        languageButton.title = chinese ? '切换为英文' : 'Switch to Chinese';
        languageButton.setAttribute('aria-label', languageButton.title);
        window.dispatchEvent(new CustomEvent('portfolio-language-change', { detail: { language } }));
    };
    languageButton.addEventListener('click', () => {
        desktopApi.setLanguage(desktopApi.getLanguage() === 'zh-CN' ? 'en' : 'zh-CN');
        applyLanguage();
    });
    applyLanguage();
});
