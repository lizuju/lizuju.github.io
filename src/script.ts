import './style.css';

import Application from './Application/Application';

if (window.matchMedia('(max-width: 820px)').matches) {
    document.body.classList.add('mobile-mode');
} else {
    new Application();
}
