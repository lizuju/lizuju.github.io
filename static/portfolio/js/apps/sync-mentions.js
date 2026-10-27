export function validMentions(mentions, text) {
    if (!Array.isArray(mentions) || mentions.length > 32) return false;
    let end = 0;
    return mentions.every(mention => {
        const valid = mention && /^[0-9a-f-]{36}$/i.test(mention.deviceId)
            && Number.isSafeInteger(mention.start) && Number.isSafeInteger(mention.end)
            && mention.start >= end && mention.end > mention.start + 1 && mention.end <= text.length
            && text[mention.start] === '@' && !/[\r\n]/.test(text.slice(mention.start, mention.end));
        end = mention?.end;
        return valid;
    });
}

export function createMentions({ input, menu, members, translate }) {
    let text = input.value;
    let mentions = [];
    let query = null;
    let candidates = [];
    let selected = 0;
    let pendingEdit = null;
    const close = () => {
        menu.hidden = true;
        query = null;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    };
    const sync = (edit = pendingEdit) => {
        pendingEdit = null;
        const next = input.value;
        if (next === text && !edit) return;
        const offset = next.length - text.length;
        let start = edit?.start;
        let end = edit?.end;
        if (edit?.type.startsWith('delete') && start === end) {
            if (edit.type.endsWith('Backward')) start += offset;
            else if (edit.type.endsWith('Forward')) end -= offset;
        }
        const precise = edit && /^(insert|delete)/.test(edit.type) && start >= 0 && end >= start
            && next.slice(0, start) === text.slice(0, start) && end + offset >= start
            && next.slice(end + offset) === text.slice(end);
        if (!precise) {
            let prefix = 0;
            while (prefix < text.length && prefix < next.length && text[prefix] === next[prefix]) prefix++;
            let suffix = 0;
            while (suffix < text.length && suffix < next.length && text[text.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
            // Ambiguous repeated text must not transfer a mention to a different occurrence.
            start = Math.min(prefix, text.length - suffix, next.length - suffix);
            end = Math.max(text.length - suffix, prefix, prefix - offset);
        }
        mentions = mentions.flatMap(mention => mention.end <= start ? [mention]
            : mention.start >= end ? [{ ...mention, start: mention.start + offset, end: mention.end + offset }] : []);
        text = next;
    };
    const choose = member => {
        if (!query) return;
        const value = `@${member.name.replace(/\s+/g, ' ')} `;
        const start = query.start;
        if (mentions.length >= 32 || text.length - (query.end - start) + value.length > input.maxLength) return;
        input.setRangeText(value, start, query.end, 'end');
        sync({ start, end: query.end, type: 'insertText' });
        mentions.push({ deviceId: member.deviceId, start, end: start + value.length - 1 });
        mentions.sort((a, b) => a.start - b.start);
        close();
        input.focus({ preventScroll: true });
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const update = () => {
        sync();
        if (document.activeElement !== input || input.disabled || input.selectionStart !== input.selectionEnd) return close();
        const end = input.selectionStart;
        const start = text.lastIndexOf('@', end - 1);
        if (start < 0 || end <= start || start && /[a-z0-9._%+-]/i.test(text[start - 1])
            || /[\r\n@]/.test(text.slice(start + 1, end)) || end - start > 32
            || mentions.some(mention => start >= mention.start && start < mention.end)) return close();
        query = { start, end };
        const term = text.slice(start + 1, end).toLocaleLowerCase();
        candidates = members().filter(member => member.name.toLocaleLowerCase().includes(term));
        selected = Math.min(selected, Math.max(0, candidates.length - 1));
        menu.replaceChildren();
        menu.setAttribute('aria-label', translate('syncMentionMember'));
        candidates.forEach((member, index) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.id = `sync-mention-${index}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(index === selected));
            option.dataset.syncMentionDevice = member.deviceId;
            option.textContent = member.name;
            const detail = document.createElement('small');
            detail.textContent = member.name === member.detail ? '' : member.detail;
            option.append(detail);
            option.addEventListener('mousedown', event => event.preventDefault());
            option.addEventListener('click', () => choose(member));
            menu.append(option);
        });
        if (!candidates.length) {
            const empty = document.createElement('p');
            empty.textContent = translate('syncMentionEmpty');
            menu.append(empty);
            input.removeAttribute('aria-activedescendant');
        } else input.setAttribute('aria-activedescendant', `sync-mention-${selected}`);
        menu.hidden = false;
        input.setAttribute('aria-expanded', 'true');
    };
    input.addEventListener('beforeinput', event => {
        pendingEdit = { start: input.selectionStart, end: input.selectionEnd, type: event.inputType };
    });
    input.addEventListener('input', event => { sync(); if (!event.isComposing) update(); else close(); });
    input.addEventListener('compositionend', update);
    input.addEventListener('click', update);
    input.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) update(); });
    input.addEventListener('keydown', event => {
        if (menu.hidden || event.isComposing || event.keyCode === 229) return;
        if (['ArrowDown', 'ArrowUp'].includes(event.key) && candidates.length) {
            event.preventDefault();
            event.stopImmediatePropagation();
            selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length;
            update();
            menu.children[selected].scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter' && !event.shiftKey && candidates.length) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!event.repeat) choose(candidates[selected]);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            close();
        } else if (event.key === 'Tab') close();
    });
    input.addEventListener('blur', event => { if (!menu.contains(event.relatedTarget)) close(); });
    document.addEventListener('pointerdown', event => {
        if (event.target !== input && !menu.contains(event.target)) close();
    });
    return {
        close,
        update,
        snapshot() { sync(); return mentions.map(mention => ({ ...mention })); },
        restore(value = []) { pendingEdit = null; text = input.value; mentions = validMentions(value, text) ? value.map(mention => ({ ...mention })) : []; close(); }
    };
}

export function renderMessageText(element, message, deviceId, mentionLabel) {
    const text = message.text;
    const tokens = (message.mentions || []).map(mention => ({ ...mention, mention: true }));
    for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)) {
        const value = match[0].replace(/[.,!?;:，。！？；：、）)\]}]+$/, '');
        let url;
        try { url = new URL(value); } catch { continue; }
        if (!['http:', 'https:'].includes(url.protocol)) continue;
        const end = match.index + value.length;
        if (!tokens.some(token => token.start < end && token.end > match.index)) tokens.push({ start: match.index, end, url });
    }
    element.replaceChildren();
    let end = 0;
    for (const token of tokens.sort((a, b) => a.start - b.start)) {
        element.append(document.createTextNode(text.slice(end, token.start)));
        const node = document.createElement(token.mention ? 'span' : 'a');
        node.textContent = text.slice(token.start, token.end);
        if (token.mention) {
            node.className = 'sync-mention';
            node.dataset.syncMention = token.deviceId;
            node.classList.toggle('is-self', token.deviceId === deviceId);
            if (token.deviceId === deviceId) node.title = mentionLabel;
        } else {
            node.href = token.url.href;
            node.target = '_blank';
            node.rel = 'noopener noreferrer';
        }
        element.append(node);
        end = token.end;
    }
    element.append(document.createTextNode(text.slice(end)));
}
