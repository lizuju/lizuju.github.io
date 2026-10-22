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
        const portfolioWindow = manager.getWindow('portfolio').element;
        const greetings = ['petHello', 'petGreeting', 'petPatrol'];
        let viewingMonitor = window.parent === window;
        let autoShowPending = true;
        let autoShowTimer = null;
        let greetingIndex = 0;
        let speechKey = 'petHello';
        let position = 0;
        let pointerX = null;
        let patrolTimer;
        let movementFrame;
        let previousFrame = null;
        let destination = 0;
        let movementSpeed = 45;
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

        const place = (nextPosition) => {
            position = Math.max(8, Math.min(nextPosition, desktop.clientWidth - pet.offsetWidth - 8));
            pet.style.transform = `translateX(${position}px)`;
            pet.style.setProperty('--pet-ground', `${taskbar.offsetHeight + 8}px`);
            const speechLeft = Math.max(8, Math.min(position - 60, desktop.clientWidth - 208));
            pet.style.setProperty('--speech-left', `${speechLeft - position}px`);
        };

        const stopWalking = () => {
            window.cancelAnimationFrame(movementFrame);
            movementFrame = null;
            previousFrame = null;
            pet.classList.remove('is-walking');
        };

        const canMove = () => !pet.hidden && desktopMode.matches && !document.hidden && !pet.inert && !reducedMotion.matches;

        const step = (timestamp) => {
            if (!canMove() || pet.matches(':hover')) {
                stopWalking();
                return;
            }
            const elapsed = previousFrame === null ? 0 : Math.min(timestamp - previousFrame, 50) / 1000;
            previousFrame = timestamp;
            const distance = destination - position;
            const travel = movementSpeed * elapsed;
            if (Math.abs(distance) <= Math.max(4, travel)) {
                place(destination);
                stopWalking();
                return;
            }
            pet.classList.toggle('is-facing-left', distance < 0);
            place(position + Math.sign(distance) * travel);
            movementFrame = window.requestAnimationFrame(step);
        };

        const walkTo = (target, speed) => {
            if (!canMove() || pet.matches(':hover')) return;
            destination = Math.max(8, Math.min(target, desktop.clientWidth - pet.offsetWidth - 8));
            movementSpeed = speed;
            if (Math.abs(destination - position) < 4) {
                stopWalking();
                return;
            }
            pet.classList.toggle('is-facing-left', destination < position);
            pet.classList.add('is-walking');
            if (!movementFrame) movementFrame = window.requestAnimationFrame(step);
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
            if (pointerX !== null) walkTo(pointerX - pet.offsetWidth / 2, 60);
            else walkTo(position + (Math.random() - 0.5) * 320, 45);
        };

        const syncAutoShow = () => {
            if (!autoShowPending || !desktopMode.matches || document.hidden || pet.inert
                || !viewingMonitor || !manager.isWindowVisible(portfolioWindow)) {
                window.clearTimeout(autoShowTimer);
                autoShowTimer = null;
                return;
            }
            if (autoShowTimer === null) autoShowTimer = window.setTimeout(() => show(), 10000);
        };

        const syncActivity = () => {
            window.clearInterval(patrolTimer);
            stopWalking();
            const paused = !canMove();
            pet.classList.toggle('is-paused', paused);
            if (!paused) {
                if (pointerX !== null && !pet.querySelector(':focus-visible')) walkTo(pointerX - pet.offsetWidth / 2, 60);
                patrolTimer = window.setInterval(patrol, 6000);
            }
            syncAutoShow();
        };

        const show = (spawnCenter = desktop.clientWidth - 90) => {
            if (!desktopMode.matches) return;
            autoShowPending = false;
            window.clearTimeout(autoShowTimer);
            autoShowTimer = null;
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
            if (pet.hidden || event.pointerType === 'touch') return;
            pointerX = event.clientX - desktop.getBoundingClientRect().left;
            walkTo(pointerX - pet.offsetWidth / 2, 60);
        }, { passive: true });
        desktop.addEventListener('pointerleave', () => {
            pointerX = null;
            stopWalking();
        });
        window.addEventListener('resize', () => {
            if (!pet.hidden) {
                stopWalking();
                place(position);
                if (pointerX !== null) walkTo(pointerX - pet.offsetWidth / 2, 60);
            }
        });
        document.addEventListener('visibilitychange', syncActivity);
        reducedMotion.addEventListener('change', syncActivity);
        desktopMode.addEventListener('change', () => {
            if (!desktopMode.matches && !pet.hidden) hide(pet.contains(document.activeElement));
            syncAutoShow();
        });
        new MutationObserver(syncActivity).observe(pet, { attributes: true, attributeFilter: ['inert'] });
        new MutationObserver(syncAutoShow).observe(portfolioWindow, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('message', (event) => {
            if (event.origin !== window.location.origin || event.source !== window.parent
                || event.data?.source !== 'gavin-shell' || event.data?.type !== 'portfolio-view-state') return;
            viewingMonitor = event.data.active === true;
            syncAutoShow();
        });
        window.addEventListener('portfolio-language-change', updateLanguage);
        updateLanguage();
        syncAutoShow();
    };
})();
