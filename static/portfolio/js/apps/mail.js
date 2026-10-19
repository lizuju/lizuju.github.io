(() => {
    const desktopApi = window.GavinDesktop;
    const { t } = desktopApi;

    // Mail compose window. Messages are posted to the FormSubmit endpoint on the form.
    function setupMail(manager) {
        const mailWindow = document.querySelector('[data-mail-window]');
        const mailTitlebar = document.querySelector('[data-mail-drag]');
        const mailResizeHandle = document.querySelector('[data-mail-resize]');
        const mailTask = document.querySelector('[data-mail-task]');
        const mailForm = document.querySelector('[data-mail-form]');
        const mailSendButton = document.querySelector('[data-mail-send]');
        const mailStatus = document.querySelector('[data-mail-status]');
        if (!mailWindow || !mailTitlebar || !mailResizeHandle || !mailTask || !mailForm
            || !mailSendButton || !mailStatus) return null;

        let mailStatusKey = 'mailStatusReady';
        let mailStatusState = '';
        let lastMailField = mailForm.querySelector('input[name="name"]');

        const entry = manager.registerWindow({
            id: 'mail',
            element: mailWindow,
            task: mailTask,
            titlebar: mailTitlebar,
            resizeHandle: mailResizeHandle,
            actionAttribute: 'data-mail-action',
            minWidth: 420,
            minHeight: 410,
            focusTarget: () => mailForm.querySelector('input[name="name"]')
        });

        const setMailStatus = (key, state = mailStatusState) => {
            mailStatusKey = key;
            mailStatusState = state;
            mailStatus.dataset.state = state;
            mailStatus.textContent = t()[key];
        };

        const sendMail = async (event) => {
            event.preventDefault();
            if (mailSendButton.disabled || !mailForm.reportValidity()) return;

            const formData = new FormData(mailForm);
            const payload = Object.fromEntries(formData.entries());
            payload._replyto = payload.email;
            payload._subject = t().mailSubject;
            payload._url = window.location.href;

            mailSendButton.disabled = true;
            setMailStatus('mailStatusSending', 'sending');

            try {
                const response = await fetch(mailForm.dataset.mailEndpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json'
                    },
                    body: JSON.stringify(payload)
                });
                if (!response.ok) throw new Error('Mail delivery failed');
                const result = await response.json();
                if (result.success !== true && result.success !== 'true') throw new Error('Mail delivery failed');

                mailForm.reset();
                setMailStatus('mailStatusSuccess', 'success');
            } catch {
                if (mailStatusKey !== 'mailStatusUnconfirmed') setMailStatus('mailStatusError', 'error');
            } finally {
                mailSendButton.disabled = false;
            }
        };

        const focusMailField = (selector) => {
            const field = mailForm.querySelector(selector);
            if (!field) return;
            lastMailField = field;
            field.focus({ preventScroll: true });
        };

        manager.addMenuActions({
            'mail-send': () => mailForm.requestSubmit(),
            'mail-clear-draft': () => {
                mailForm.reset();
                setMailStatus('mailStatusReady', '');
                focusMailField('input[name="name"]');
            },
            'mail-close': () => entry.hide('is-closed'),
            'mail-select-field': () => lastMailField?.select(),
            'mail-clear-field': () => {
                if (lastMailField) lastMailField.value = '';
                lastMailField?.focus({ preventScroll: true });
            },
            'mail-focus-name': () => focusMailField('input[name="name"]'),
            'mail-focus-message': () => focusMailField('textarea[name="message"]'),
            'mail-toggle-size': entry.toggleMaximize,
            'mail-help': () => setMailStatus('mailStatusHelp', '')
        });

        document.querySelectorAll('[data-open-mail-window]').forEach((button) => {
            button.addEventListener('click', entry.show);
        });
        mailForm.addEventListener('submit', sendMail);
        mailForm.querySelectorAll('input:not(.mail-honeypot), textarea').forEach((field) => {
            field.addEventListener('focus', () => {
                lastMailField = field;
            });
        });

        window.addEventListener('portfolio-language-change', () => {
            setMailStatus(mailStatusKey, mailStatusState);
        });
        // A reload mid-send cannot confirm delivery; say so instead of restoring "sending".
        window.addEventListener('beforeunload', () => {
            if (mailSendButton.disabled) setMailStatus('mailStatusUnconfirmed', '');
        });

        manager.onSession({
            save: () => ({
                mail: {
                    fields: ['name', 'email', 'company', 'message'].reduce((values, name) => {
                        const field = mailForm.querySelector(`[name="${name}"]`);
                        values[name] = field?.value || '';
                        return values;
                    }, {}),
                    statusKey: mailStatusKey,
                    statusState: mailStatusState
                }
            }),
            restore: (savedState) => {
                Object.entries(savedState.mail?.fields || {}).forEach(([name, value]) => {
                    const field = mailForm.querySelector(`[name="${name}"]`);
                    if (field && typeof value === 'string') field.value = value;
                });
                if (savedState.mail?.statusKey && t()[savedState.mail.statusKey]) {
                    if (savedState.mail.statusKey === 'mailStatusSending') {
                        setMailStatus('mailStatusUnconfirmed', '');
                    } else {
                        setMailStatus(savedState.mail.statusKey, savedState.mail.statusState || '');
                    }
                }
            }
        });

        return { open: entry.show };
    }

    desktopApi.apps.mail = setupMail;
})();
