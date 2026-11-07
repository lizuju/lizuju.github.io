import '../css/base.css';
import '../css/desktop.css';
import '../css/apps/preview-zoom.css';
import '../css/apps/project-folder.css';
import '../css/taskbar.css';
import '../css/desktop-responsive.css';
import '../css/honors.css';
import './desktop/core.js';
import './desktop/window-manager.js';
import './apps/project-folder.js';

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-menu-action="folder-up"], [data-menu-action="folder-close"], [data-menu-action="folder-toggle-size"]')
        .forEach(item => { item.hidden = true; });
    const desktopApi = window.GavinDesktop;
    const manager = desktopApi.createWindowManager({
        desktop: document.querySelector('[data-retro-desktop]'),
        startButton: document.querySelector('[data-start-toggle]'),
        startMenu: document.querySelector('[data-start-menu]')
    });
    const honors = desktopApi.apps.projectFolder(manager);
    manager.bindGlobalListeners();
    const active = new URLSearchParams(location.search).has('certificate') ? null : manager.restoreDesktopSession();
    const folder = document.querySelector('[data-project-folder-window]');
    folder.classList.add('is-maximized');
    honors.showHonors();
    if (active) manager.focusWindow(active.element);

    const languageButton = document.querySelector('[data-taskbar-lang]');
    const applyLanguage = () => {
        const language = desktopApi.getLanguage();
        const copy = desktopApi.t();
        document.documentElement.lang = language;
        document.title = `${copy.folderHonors} | GAVIN OS`;
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
