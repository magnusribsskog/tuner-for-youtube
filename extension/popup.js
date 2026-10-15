(async () => {
    const countEl      = document.getElementById('count');
    const extStatusEl  = document.getElementById('ext-status');
    const btnExt       = document.getElementById('btn-ext');
    const btnHud       = document.getElementById('btn-hud');
    const filterSection = document.getElementById('filter-section');
    const phraseInput  = document.getElementById('phrase-input');
    const phraseAdd    = document.getElementById('phrase-add');
    const phraseList   = document.getElementById('phrase-list');
    const mainEl       = document.getElementById('main');
    const notYtEl      = document.getElementById('not-youtube');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let state = null;
    try {
        state = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
    } catch (_) {}

    if (!state) {
        mainEl.style.display   = 'none';
        notYtEl.style.display  = 'block';
        return;
    }

    // ── Extension on/off ─────────────────────────────────────────────────────
    function setExtBtn(enabled) {
        btnExt.textContent  = enabled ? 'ON' : 'OFF';
        btnExt.className    = `toggle ${enabled ? 'on' : 'off'}`;
        extStatusEl.textContent = enabled
            ? (state.active ? 'Filtering homepage' : 'On — not on homepage')
            : 'Filtering paused';
    }
    setExtBtn(state.extensionEnabled);

    btnExt.addEventListener('click', async () => {
        try {
            const res = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_EXTENSION' });
            state.extensionEnabled = res.extensionEnabled;
            setExtBtn(res.extensionEnabled);
            setFiltersDisabled(!res.extensionEnabled);
        } catch (_) {}
    });

    // ── HUD toggle ───────────────────────────────────────────────────────────
    function setHudBtn(visible) {
        btnHud.textContent = visible ? 'ON' : 'OFF';
        btnHud.className   = `toggle ${visible ? 'on' : 'off'}`;
    }
    setHudBtn(state.hudVisible);

    btnHud.addEventListener('click', async () => {
        try {
            const res = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_HUD' });
            setHudBtn(res.hudVisible);
        } catch (_) {}
    });

    // ── Nuke count ───────────────────────────────────────────────────────────
    countEl.textContent = state.nukeCount ?? '0';

    // ── Filter rows ──────────────────────────────────────────────────────────
    function setFiltersDisabled(disabled) {
        filterSection.querySelectorAll('.toggle').forEach(btn => {
            btn.classList.toggle('disabled', disabled);
        });
    }

    const subEls = {};

    for (const [key, filter] of Object.entries(state.filters)) {
        const row = document.createElement('div');
        row.className = 'row';

        const left = document.createElement('div');
        left.className = 'row-label';

        const keyEl = document.createElement('span');
        keyEl.className = 'row-key';
        keyEl.textContent = `[${key}] ${filter.label}`;

        const sub = document.createElement('span');
        sub.className = 'row-sub';
        sub.textContent = `caught: ${filter.count}`;
        subEls[key] = sub;

        left.appendChild(keyEl);
        left.appendChild(sub);

        const btn = document.createElement('button');
        btn.className = `toggle ${filter.enabled ? 'on' : 'off'}`;
        btn.textContent = filter.enabled ? 'ON' : 'OFF';

        btn.addEventListener('click', async () => {
            if (btn.classList.contains('disabled')) return;
            try {
                const res = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_FILTER', filter: key });
                btn.textContent = res.enabled ? 'ON' : 'OFF';
                btn.className   = `toggle ${res.enabled ? 'on' : 'off'}`;
            } catch (_) {}
        });

        row.appendChild(left);
        row.appendChild(btn);
        filterSection.appendChild(row);
    }

    if (!state.extensionEnabled) setFiltersDisabled(true);

    // ── Clown mode ───────────────────────────────────────────────────────────
    const btnClown    = document.getElementById('btn-clown');
    const btnParade   = document.getElementById('btn-parade');
    const clownStatus = document.getElementById('clown-status');
    const clownOpts   = document.getElementById('clown-opts');

    function renderClown(c) {
        if (!c) return;
        btnClown.textContent = c.active ? 'ON' : 'OFF';
        btnClown.className   = `toggle ${c.active ? 'on' : 'off'}`;
        clownOpts.style.display = c.active ? 'flex' : 'none';
        btnParade.className  = `toggle ${c.parade ? 'on' : 'off'}`;
        const mins = Math.floor(c.secondsLeft / 60), secs = c.secondsLeft % 60;
        clownStatus.textContent = c.active
            ? `🎪 circus leaves town in ${mins}:${String(secs).padStart(2, '0')}`
            : 'the circus is closed';
    }
    renderClown(state.clown);

    async function clownMsg(type) {
        // A silent fallback is indistinguishable from correct operation and
        // is therefore unacceptable — doctrine applies to the popup too. The
        // classic failure here is a stale content script after an extension
        // reload; say so instead of doing nothing.
        try {
            const res = await chrome.tabs.sendMessage(tab.id, { type });
            if (!res || !res.clown) throw new Error("no response");
            renderClown(res.clown);
        } catch (_) {
            clownStatus.textContent = "⚠ no answer from tab — refresh the YouTube tab";
        }
    }
    btnClown.addEventListener('click',  () => clownMsg('TOGGLE_CLOWN'));
    btnParade.addEventListener('click', () => clownMsg('TOGGLE_CLOWN_PARADE'));

    // ── Live count refresh ───────────────────────────────────────────────────
    const liveRefresh = setInterval(async () => {
        try {
            const fresh = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
            if (!fresh) return;
            countEl.textContent = fresh.nukeCount ?? '0';
            for (const [key, filter] of Object.entries(fresh.filters)) {
                if (subEls[key]) subEls[key].textContent = `caught: ${filter.count}`;
            }
            renderClown(fresh.clown);   // keeps the countdown live and reflects the safety valve firing
        } catch (_) {
            clearInterval(liveRefresh);
        }
    }, 1000);

    // ── Custom phrases ───────────────────────────────────────────────────────
    function renderPhrases(phrases) {
        phraseList.replaceChildren();
        if (!phrases.length) {
            const empty = document.createElement('span');
            empty.className = 'phrase-empty';
            empty.textContent = 'none';
            phraseList.appendChild(empty);
            return;
        }
        phrases.forEach(phrase => {
            const item = document.createElement('div');
            item.className = 'phrase-item';

            const text = document.createElement('span');
            text.textContent = phrase;

            const rm = document.createElement('span');
            rm.className = 'phrase-remove';
            rm.textContent = '✕';
            rm.addEventListener('click', async () => {
                try {
                    const res = await chrome.tabs.sendMessage(tab.id, { type: 'REMOVE_PHRASE', phrase });
                    renderPhrases(res.phrases);
                } catch (_) {}
            });

            item.appendChild(text);
            item.appendChild(rm);
            phraseList.appendChild(item);
        });
    }

    renderPhrases(state.phrases || []);

    async function addPhrase() {
        const val = phraseInput.value.toLowerCase().trim();
        if (!val) return;
        try {
            const res = await chrome.tabs.sendMessage(tab.id, { type: 'ADD_PHRASE', phrase: val });
            phraseInput.value = '';
            renderPhrases(res.phrases);
        } catch (_) {}
    }

    phraseAdd.addEventListener('click', addPhrase);
    phraseInput.addEventListener('keydown', e => { if (e.key === 'Enter') addPhrase(); });

    // ── Diagnostic dump ──────────────────────────────────────────────────────
    const btnDiag   = document.getElementById('btn-diag');
    const diagStatus = document.getElementById('diag-status');

    btnDiag.addEventListener('click', async () => {
        diagStatus.textContent = 'collecting…';
        diagStatus.className   = '';
        try {
            const d = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DIAGNOSTIC' });
            if (!d) { diagStatus.textContent = 'no response'; return; }
            const nuked    = d.session.nukeCount;
            const scans    = d.session.scanCount;
            const corr     = d.corrections.length;
            const sessions = d.metrics.length;
            diagStatus.textContent = `${scans} scans · ${nuked} nuked · ${corr} corrections · ${sessions} stored sessions`;
            diagStatus.className   = 'live';
            console.log('[YT-TUNER DIAGNOSTIC]', d);
        } catch (e) {
            diagStatus.textContent = 'failed — ' + e.message;
        }
    });

})();
