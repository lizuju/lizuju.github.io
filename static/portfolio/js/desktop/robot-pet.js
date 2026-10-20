(() => {
    const desktopApi = window.GavinDesktop;

    desktopApi.setupRobotPet = (manager) => {
        if (desktopApi.isMobileHomepage() || !window.matchMedia('(pointer: fine)').matches) return;
        const { desktop, startButton, closeStartMenu } = manager;
        const pet = document.querySelector('[data-desktop-pet]');
        const toggle = document.querySelector('[data-pet-toggle]');
        const toggleLabel = toggle.querySelector('[data-i18n]');
        const robot = pet.querySelector('[data-pet-greet]');
        const dismiss = pet.querySelector('[data-pet-dismiss]');
        const speech = pet.querySelector('[data-pet-speech]');
        const taskbar = document.querySelector('.desktop-taskbar');
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const desktopMode = window.matchMedia('(min-width: 901px) and (pointer: fine)');
        const greetings = ['petHello', 'petGreeting', 'petPatrol'];
        let greetingIndex = 0;
        let speechKey = 'petHello';
        let position = 0;
        let pointerX = null;
        let patrolTimer;
        let movementTimer;
        let speechTimer;

        const updateLanguage = () => {
            const copy = desktopApi.t();
            toggleLabel.dataset.i18n = pet.hidden ? 'petShow' : 'petHide';
            toggleLabel.textContent = copy[toggleLabel.dataset.i18n];
            toggle.setAttribute('aria-expanded', String(!pet.hidden));
            robot.setAttribute('aria-label', copy.petGreetLabel);
            dismiss.setAttribute('aria-label', copy.petDismissLabel);
            speech.textContent = copy[speechKey];
        };

        const place = (nextPosition, duration = 0) => {
            position = Math.max(8, Math.min(nextPosition, desktop.clientWidth - pet.offsetWidth - 8));
            pet.style.setProperty('--pet-duration', `${duration}s`);
            pet.style.transform = `translateX(${position}px)`;
            pet.style.setProperty('--pet-ground', `${taskbar.offsetHeight + 8}px`);
            const speechLeft = Math.max(8, Math.min(position - 60, desktop.clientWidth - 208));
            pet.style.setProperty('--speech-left', `${speechLeft - position}px`);
        };

        const stopWalking = () => {
            window.clearTimeout(movementTimer);
            const currentPosition = pet.getBoundingClientRect().left - desktop.getBoundingClientRect().left;
            place(currentPosition);
            pet.classList.remove('is-walking');
        };

        const greet = () => {
            stopWalking();
            window.clearTimeout(speechTimer);
            speechKey = greetings[greetingIndex++ % greetings.length];
            speech.textContent = desktopApi.t()[speechKey];
            speech.hidden = false;
            pet.classList.add('is-greeting');
            speechTimer = window.setTimeout(() => {
                speech.hidden = true;
                pet.classList.remove('is-greeting');
            }, 4500);
        };

        const patrol = () => {
            if (pet.matches(':hover') || pet.querySelector(':focus-visible') || !speech.hidden) return;
            const followPointer = pointerX !== null && Math.random() < 0.5;
            const target = followPointer ? pointerX - pet.offsetWidth / 2 : position + (Math.random() - 0.5) * 320;
            const destination = Math.max(8, Math.min(target, desktop.clientWidth - pet.offsetWidth - 8));
            const distance = Math.min(200, Math.abs(destination - position));
            if (distance < 8) return;
            const direction = Math.sign(destination - position);
            pet.classList.toggle('is-facing-left', direction < 0);
            pet.classList.add('is-walking');
            place(position + direction * distance, distance / 45);
            movementTimer = window.setTimeout(() => pet.classList.remove('is-walking'), distance / 45 * 1000);
        };

        const syncActivity = () => {
            window.clearInterval(patrolTimer);
            if (!pet.hidden) stopWalking();
            const paused = pet.hidden || !desktopMode.matches || document.hidden || pet.inert || reducedMotion.matches;
            pet.classList.toggle('is-paused', paused);
            if (!paused) patrolTimer = window.setInterval(patrol, 6000);
        };

        const show = (spawnCenter = desktop.clientWidth - 90) => {
            if (!desktopMode.matches) return;
            pet.hidden = false;
            place(spawnCenter - pet.offsetWidth / 2);
            updateLanguage();
            syncActivity();
            greet();
        };

        const hide = (restoreFocus = true) => {
            stopWalking();
            window.clearTimeout(speechTimer);
            pet.hidden = true;
            speech.hidden = true;
            pointerX = null;
            pet.classList.remove('is-greeting');
            syncActivity();
            updateLanguage();
            if (restoreFocus) startButton.focus({ preventScroll: true });
        };

        desktop.addEventListener('dblclick', (event) => {
            if (event.target !== desktop || event.button !== 0 || !desktopMode.matches) return;
            if (pet.hidden) show(event.clientX);
            else greet();
        });
        toggle.addEventListener('click', () => {
            closeStartMenu();
            if (pet.hidden) {
                show();
                robot.focus({ preventScroll: true });
            } else hide();
        });
        robot.addEventListener('click', greet);
        dismiss.addEventListener('click', () => hide());
        pet.addEventListener('pointerenter', stopWalking);
        pet.addEventListener('focusin', stopWalking);
        pet.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Escape') hide();
        });
        pet.addEventListener('keyup', (event) => event.stopPropagation());
        desktop.addEventListener('pointermove', (event) => {
            if (!pet.hidden && event.pointerType !== 'touch') pointerX = event.clientX;
        }, { passive: true });
        desktop.addEventListener('pointerleave', () => { pointerX = null; });
        window.addEventListener('resize', () => {
            if (!pet.hidden) stopWalking();
        });
        document.addEventListener('visibilitychange', syncActivity);
        reducedMotion.addEventListener('change', syncActivity);
        desktopMode.addEventListener('change', () => {
            if (!desktopMode.matches && !pet.hidden) hide(pet.contains(document.activeElement));
        });
        new MutationObserver(syncActivity).observe(pet, { attributes: true, attributeFilter: ['inert'] });
        window.addEventListener('portfolio-language-change', updateLanguage);
        updateLanguage();
    };
})();
