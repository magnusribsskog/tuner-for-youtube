/*
 * Tuner for YouTube v4.1 — Chrome Extension Content Script
 * =====================================================================
 *
 * Filters YouTube homepage video cards against five heuristics:
 *   PHRASE   — regex clickbait patterns + user-managed custom phrase list
 *   SLOP     — missing apostrophes, grammar errors, punctuation repetition
 *   CAPS     — excessive uppercase ratio (>50% after filtering non-letters)
 *   DUPE     — channel-flooding suppression (one per channel per batch)
 *   WATCHED  — videos watched >90% (read from resume playback progress bar)
 *
 * Scope: homepage (/) only. Search, channel pages, and watch pages are
 * explicitly out of scope — the user is already expressing intent.
 *
 * Architecture:
 *   - MutationObserver narrowed to ytd-two-column-browse-results-renderer
 *   - yt-navigate-finish event drives SPA navigation lifecycle
 *   - Hydration gate: containers not processed until title + thumbnail present
 *   - sessionId stamps: invalidate stale stamps across SPA navigations
 *   - Recycled container re-evaluation via ytPurgeProcessed stamp
 *   - Shadow DOM HUD + Word Panel (draggable, collapsible)
 *
 * Self-Healing:
 *   - Handled by self-healing.js (SelfHealer module), loaded before this script
 *   - SelfHealer.buildActiveTagSet(), SelfHealer.runAnchorSearch(),
 *     SelfHealer.findVideoContainerFromElement() are called from this file
 *
 * Diagnostics:
 *   - Health check on homepage boot with three gates (context, skeleton,
 *     video item presence). Reports [CRIT] if structural elements missing.
 *   - DOM capture framework: automatic captures on CRIT states are kept in
 *     memory only; 📸 (or the instantiation banner) saves one to disk
 *   - Instantiation (instantiator.js): first home load surveys the feed and
 *     stores which card tags this user's layout uses; fails loudly otherwise
 *   - Anchor search: last 5 nuked titles as DOM beacons on structural failure
 *   - Console [DIAG] logging throughout; HUD levels [INFO]/[WARN]/[CRIT]
 *
 * chrome.storage.local keys:
 *   "yt-purge-phrases"              — array of user-managed custom phrase strings
 *   "yt-purge-nuke-log"             — last 5 confirmed-nuked titles for anchor search
 *   "yt-tuner-selector-corrections" — discovered container tag corrections
 *   "yt-tuner-instantiation"        — first-run survey record (instantiator.js)
 */

(function() {
    "use strict";

    // ======================== STORAGE ========================
    // Thin wrapper over chrome.storage.local. Values are stored as native
    // objects — no JSON.stringify/parse needed (the extension API handles
    // serialisation internally).
    const Storage = {
        get: key => chrome.storage.local.get([key]).then(r => r[key] ?? null),
        set: (key, val) => chrome.storage.local.set({ [key]: val }),
    };

    // Container tags that the h3 DOM walk legitimately reaches but which
    // host section headers and navigation entries rather than video cards.
    // These are skipped before any heuristic evaluates them.
    const NON_VIDEO_CONTAINERS = new Set([
        "YTD-GUIDE-SECTION-RENDERER",
        "YTD-GUIDE-ENTRY-RENDERER",
    ]);


    // ======================== CONFIG ========================
    const CONFIG = {
        grammarSlop:    /\b(dont|doesnt|shes|cant|ive|wont|im|didnt|couldnt|shouldnt|isnt|wasnt|arent)\b|([.!?,]){2,}/i,
        clickbait:      /OMG|BADASS|UNALIVE|INSANE|COPS|SECRET|GONE WRONG|RUINED MY LIFE|BREAKS REALITY/i,
        capsThreshold:  0.5,
        minTitleLength: 10,
        logLimit:       200,
        nukeCeiling:    0.30,  // max fraction of evaluated cards that may be nuked per batch
        PHRASES_KEY:    "yt-purge-phrases",
        NUKE_LOG_KEY:   "yt-purge-nuke-log",  // last N nuked titles for anchor search
        NUKE_LOG_SIZE:  5,                     // number of nuked titles to retain
    };

    // ======================== STOPWORDS ========================
    const STOPWORDS = new Set([
        "a","an","the","and","or","but","if","in","on","at","to","for","of","with",
        "by","from","as","is","it","its","be","was","are","were","been","have","has",
        "had","do","does","did","will","would","could","should","may","might","shall",
        "that","this","these","those","i","you","he","she","we","they","me","him","her",
        "us","them","my","your","his","our","their","what","which","who","when","where",
        "how","why","all","more","so","up","out","no","not","just","about","than","then",
        "them","some","can","into","over","after","before","between","through","during",
        "also","only","very","too","much","many","most","other","such","even","back",
        "still","here","there","now","get","got","go","went","make","made","know","like",
        "see","come","take","time","good","new","first","last","long","great","little",
        "own","right","big","high","old","same","another","because","while","both","each",
        "few","being","its","am","let","say","said","want","use","think","well","way",
        "down","off","again","further","once","any","few","more","most","other","above",
        "below","between","same","different","put","set","run","look","keep","going",
        "video","channel","watch","watching","new","official","full","part","episode",
        "ft","feat","vs","review","trailer","reaction","highlights","vlog","clip","clips",
        "day","week","month","year","best","top","update","live","stream","short","series",
        "show","ep","season","feat","music","song","cover","remix","version","extended"
    ]);

    // ======================== TOKENISER ========================
    function tokenise(title) {
        return title
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length > 2 && !STOPWORDS.has(w));
    }

    // ======================== PAGE CONTEXT ========================
    function getPageContext() {
        const path = window.location.pathname;
        if (path === "/" || path === "")  return "home";
        if (path.startsWith("/results")) return "search";
        if (path.startsWith("/watch"))   return "watch";
        if (
            path.startsWith("/@")       ||
            path.startsWith("/c/")      ||
            path.startsWith("/channel/")
        )                                return "channel";
        return "other";
    }

    let extensionEnabled = true;

    function filteringActive() {
        return extensionEnabled && getPageContext() === "home";
    }

    // ======================== HEURISTIC STATE ========================
    // Session-only toggles — reset on every page load, intentionally
    const heuristics = {
        SLOP:    { enabled: true, count: 0, label: "Grammar slop" },
        CAPS:    { enabled: true, count: 0, label: "Excessive caps" },
        PHRASE:  { enabled: true, count: 0, label: "Phrase / custom list" },
        DUPE:    { enabled: true, count: 0, label: "Channel Flooding" },
        WATCHED: { enabled: true, count: 0, label: "Watched > 90%" },
    };

    // ======================== CUSTOM PHRASE LIST ========================
    async function loadPhrases() {
        try {
            const val = await Storage.get(CONFIG.PHRASES_KEY);
            if (!val) return [];
            if (!Array.isArray(val)) return [];
            return val.map(p => String(p).toLowerCase().trim()).filter(Boolean);
        } catch (e) {
            console.warn("[YT-PURGE] Phrase list load failed:", e.message);
            return [];
        }
    }

    async function savePhrases() {
        try {
            await Storage.set(CONFIG.PHRASES_KEY, customPhrases);
        } catch (e) {
            console.warn("[YT-PURGE] Phrase list save failed:", e.message);
        }
    }

    let customPhrases = []; // populated during init()

    // ── Nuke log: persists last N nuked titles for anchor search ─────────
    async function loadNukeLog() {
        try {
            const val = await Storage.get(CONFIG.NUKE_LOG_KEY);
            if (!val) return [];
            if (!Array.isArray(val)) return [];
            return val.map(e => typeof e === "string" ? { reason: "?", label: e } : e);
        } catch (e) { return []; }
    }

    async function saveNukeLog(log) {
        try { await Storage.set(CONFIG.NUKE_LOG_KEY, log); }
        catch (e) { console.warn("[YT-PURGE] Nuke log save failed:", e.message); }
    }

    async function recordNuke(reason, label) {
        const log = await loadNukeLog();
        const updated = [{ reason, label }, ...log.filter(e => e.label !== label)].slice(0, CONFIG.NUKE_LOG_SIZE);
        await saveNukeLog(updated);
    }

    // ── Metrics: rolling per-session filter ratios ────────────────────────────
    //
    // One record per navigation session, upserted to chrome.storage.local every
    // FLUSH_N cards and on yt-navigate-finish. Capped at MAX sessions; oldest
    // rotated out. Confidence and drift are computed at read time — not stored.
    //
    // Schema v1: { v, id, t0, t1, cards, nuked, scans, counts: { PHRASE, SLOP, CAPS, DUPE, WATCHED } }
    //   scans — productive scans only (those that found new cards); cards/scans gives
    //           average new cards per productive scan, a local proxy for batch size.
    //           Downward drift signals throttling against this account's own baseline.
    //   t0  — session start timestamp (ms)
    //   t1  — last upsert timestamp; gap between t0/t1 relative to cards detects stale tabs
    //   cards — total cards evaluated (stamped ytPurgeProcessed) this session
    //   nuked — total cards hidden this session
    //   counts — per-heuristic nuke counts; ratio to nuked gives composition,
    //            ratio to cards gives absolute filtering rate
    const MetricsService = (() => {
        const KEY     = "yt-purge-metrics";
        const MAX     = 30;
        const FLUSH_N = 10;

        function newSession() {
            return {
                v:      1,
                id:     `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                t0:     Date.now(),
                t1:     Date.now(),
                cards:  0,
                nuked:  0,
                scans:  0,
                counts: { PHRASE: 0, SLOP: 0, CAPS: 0, DUPE: 0, WATCHED: 0 },
            };
        }

        let session = newSession();

        async function flush() {
            session.t1 = Date.now();
            try {
                const raw      = await Storage.get(KEY);
                const sessions = Array.isArray(raw) ? raw : [];
                const idx      = sessions.findIndex(s => s.id === session.id);
                if (idx >= 0) {
                    sessions[idx] = session;
                } else {
                    sessions.push(session);
                    if (sessions.length > MAX) sessions.splice(0, sessions.length - MAX);
                }
                await Storage.set(KEY, sessions);
            } catch (e) {
                console.warn("[YT-PURGE] Metrics flush failed:", e.message);
            }
        }

        return {
            recordCard() {
                session.cards++;
                if (session.cards % FLUSH_N === 0) flush();
            },
            recordScan() {
                session.scans++;
            },
            recordNuke(reason) {
                if (!(reason in session.counts)) return;
                session.counts[reason]++;
                session.nuked++;
            },
            async rotateSession() {
                if (session.cards > 0) await flush();
                session = newSession();
            },
        };
    })();

    function matchesCustomPhrase(title) {
        const lower = title.toLowerCase();
        return customPhrases.some(p => lower.includes(p));
    }

    // ======================== HUD ========================
    let hudHost       = null;
    let nukeCountSpan = null;
    let logPipeDiv    = null;
    let nukeCount     = 0;
    const systemEvents = []; // WARN and CRIT entries captured for diagnostic export

    function createHUD() {
        const host = document.createElement("div");
        host.id = "yt-purge-hud";
        host.style.cssText = `
            position: fixed !important;
            top: 50px !important;
            right: 20px !important;
            width: 360px !important;
            height: 500px !important;
            z-index: 2147483647 !important;
            isolation: isolate !important;
            pointer-events: auto !important;
            visibility: visible !important;
            opacity: 1 !important;
        `;
        const shadow = host.attachShadow({ mode: "closed" });

        const container = document.createElement("div");
        container.style.cssText = `
            width: 100%; height: 100%;
            background: #0f0f0f;
            border: 2px solid #3b3b3b;
            border-radius: 12px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 20px 50px rgba(0,0,0,0.9);
            color: white;
            overflow: hidden;
        `;

        const header = document.createElement("div");
        header.style.cssText = `
            padding: 12px 15px;
            background: #1a1a1a;
            cursor: move;
            border-bottom: 2px solid #ff4757;
            display: flex;
            justify-content: space-between;
            align-items: center;
            user-select: none;
            flex-shrink: 0;
        `;

        const titleArea = document.createElement("div");
        titleArea.style.cssText = "display: flex; flex-direction: column; gap: 2px;";

        const mainTitle = document.createElement("span");
        const { version } = chrome.runtime.getManifest();
        mainTitle.textContent = `☢️ Tuner for YouTube v${version} [ext]`;
        mainTitle.style.cssText = "font-size: 13px; font-weight: 800; color: #ff4757;";

        const metaRow = document.createElement("div");
        metaRow.style.cssText = "display: flex; gap: 10px; align-items: center;";

        const countRow = document.createElement("span");
        countRow.style.cssText = "font-size: 10px; color: #888;";
        countRow.textContent = "NUKED: ";
        nukeCountSpan = document.createElement("span");
        nukeCountSpan.textContent = "0";
        nukeCountSpan.style.color = "white";
        countRow.appendChild(nukeCountSpan);
        metaRow.appendChild(countRow);

        titleArea.appendChild(mainTitle);
        titleArea.appendChild(metaRow);

        const btnGroup = document.createElement("div");
        btnGroup.style.cssText = "display: flex; gap: 10px; align-items: center;";

        // DOM capture button — manual snapshot trigger
        const captureBtn = document.createElement("span");
        captureBtn.textContent = "📸";
        captureBtn.title = "Save a DOM snapshot";
        captureBtn.style.cssText = "cursor: pointer; font-size: 15px;";
        captureBtn.addEventListener("click", saveDOMSnapshot);
        btnGroup.appendChild(captureBtn);

        // Diagnostic export button
        const diagBtn = document.createElement("span");
        diagBtn.textContent = "✱";
        diagBtn.title = "Export session diagnostic";
        diagBtn.style.cssText = "cursor: pointer; font-size: 15px; color: #2ed573; font-weight: 700;";
        diagBtn.addEventListener("click", exportDiagnostic);
        btnGroup.appendChild(diagBtn);

        // Collapse button
        const collapseBtn = document.createElement("span");
        collapseBtn.textContent = "▲";
        collapseBtn.title = "Collapse log";
        collapseBtn.style.cssText = "cursor: pointer; font-size: 14px; color: #555; line-height: 1;";
        collapseBtn.addEventListener("click", () => {
            const collapsed = logPipeDiv.style.display === "none";
            logPipeDiv.style.display = collapsed ? "block" : "none";
            collapseBtn.textContent = collapsed ? "▲" : "▼";
            collapseBtn.title = collapsed ? "Collapse log" : "Expand log";
            host.style.height = collapsed ? "500px" : "42px";
        });
        btnGroup.appendChild(collapseBtn);

        header.appendChild(titleArea);
        header.appendChild(btnGroup);

        logPipeDiv = document.createElement("div");
        logPipeDiv.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 10px 12px;
            background: #050505;
            font-family: monospace;
            font-size: 11px;
            line-height: 1.5;
        `;

        container.appendChild(header);
        container.appendChild(logPipeDiv);
        shadow.appendChild(container);

        // Clown mode skins the HUD in place; refs registered whether or not
        // the circus is currently in town (it may arrive later).
        if (typeof Clown !== "undefined") {
            Clown.setHUD({ container, header, mainTitle, countRow, logPipeDiv });
        }

        let isDragging = false, offsetX = 0, offsetY = 0;
        header.addEventListener("mousedown", (e) => {
            e.preventDefault();
            isDragging = true;
            offsetX = e.clientX - host.offsetLeft;
            offsetY = e.clientY - host.offsetTop;
        });
        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            host.style.left = (e.clientX - offsetX) + "px";
            host.style.top  = (e.clientY - offsetY) + "px";
            host.style.right = "auto";
        });
        document.addEventListener("mouseup", () => { isDragging = false; });

        return host;
    }

    function logToHUD(reason, title) {
        const isWarn = reason === "WARN";
        const isCrit = reason === "CRIT";
        const isInfo = reason === "INFO";
        if (isWarn || isCrit) systemEvents.push({ level: reason, message: title || "" });
        // WARN, CRIT, and INFO are system messages — do not increment nuke counter
        if (!isWarn && !isCrit && !isInfo) {
            nukeCount++;
            if (nukeCountSpan) nukeCountSpan.textContent = nukeCount;
        }
        if (!logPipeDiv) return;
        const entry = document.createElement("div");
        entry.style.cssText = "margin-bottom: 5px; border-bottom: 1px solid #111; padding-bottom: 4px; display: flex; gap: 6px; flex-wrap: wrap;";
        const tag = document.createElement("span");
        tag.style.cssText = isCrit
            ? "color: #ff0000; font-weight: 900; font-size: 13px;"
            : isInfo
            ? "color: #2ed573; font-weight: 700;"
            : `color: ${isWarn ? "#ffa502" : "#ff4757"}; font-weight: 700;`;
        tag.textContent = (typeof Clown !== "undefined") ? Clown.tagText(reason) : `[${reason}]`;
        const msg = document.createElement("span");
        msg.style.cssText = isCrit ? "color: #ff6b6b; font-weight: 700;" : "color: #ccc;";
        msg.textContent = title || "";
        entry.appendChild(tag);
        entry.appendChild(msg);
        logPipeDiv.prepend(entry);
        if (!isCrit) {
            while (logPipeDiv.children.length > CONFIG.logLimit) {
                logPipeDiv.removeChild(logPipeDiv.lastChild);
            }
        }
    }

    // ======================== WORD PANEL ========================
    // Removed — filter controls now live in the extension popup.
    // Custom phrases are still loaded from storage and applied; management
    // moved to popup.js.



    // ======================== CHANNEL NAME EXTRACTION ========================
    const CHANNEL_SELECTORS = [
        "yt-content-metadata-view-model a[href^='/@']", // lockup card format (current)
        "ytd-channel-name #text",
        "#channel-name #text",
        "#channel-name",
        "ytd-channel-name",
        ".ytd-channel-name",
    ];

    function getChannelName(container) {
        for (const sel of CHANNEL_SELECTORS) {
            const el = container.querySelector(sel);
            const name = el?.textContent?.trim();
            if (name) {
                console.log(`[DIAG] selector OK: "${sel}" → "${name}" in <${container.tagName.toLowerCase()}>`);
                return name.toLowerCase();
            }
        }

        const tag = container.tagName.toLowerCase();
        const descendants = container.querySelectorAll("*");
        const shadowRootsFound = [];

        for (const el of descendants) {
            if (!el.shadowRoot) continue;
            shadowRootsFound.push(el.tagName.toLowerCase());
            console.log(`[DIAG] shadow root found on <${el.tagName.toLowerCase()}> inside <${tag}>`);
            for (const sel of CHANNEL_SELECTORS) {
                const target = el.shadowRoot.querySelector(sel);
                const name = target?.textContent?.trim();
                if (name) {
                    console.log(`[DIAG] SHADOW selector OK: "${sel}" → "${name}" on <${el.tagName.toLowerCase()}> in <${tag}>`);
                    return name.toLowerCase();
                } else if (target) {
                    console.log(`[DIAG] SHADOW selector matched but empty: "${sel}" on <${el.tagName.toLowerCase()}>`);
                }
            }
        }

        if (!getChannelName._warned) getChannelName._warned = new Set();
        if (!getChannelName._warned.has(tag)) {
            getChannelName._warned.add(tag);
            const shadowSummary = shadowRootsFound.length > 0
                ? `shadow roots on: ${[...new Set(shadowRootsFound)].join(", ")}`
                : "no shadow roots found";
            console.log(`[DIAG] getChannelName FAILED on <${tag}> — ${shadowSummary}`);
            logToHUD("WARN", `channel selector failed on <${tag}>`);
        }
        return null;
    }

    // ======================== WATCHED PERCENT ========================
    function getWatchedPercent(container) {
        // Tier 1: lockup card format (current) — yt-thumbnail-overlay-progress-bar-view-model
        // Progress bar is a div with class ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment.
        // Try light DOM first; if not found, pierce shadow roots — the lockup model renders
        // its thumbnail area inside a shadow root, so the progress bar is not reachable via
        // a plain querySelector from the card container.
        const WATCHED_CLASS = ".ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment";
        let progressBar = container.querySelector(WATCHED_CLASS);
        if (!progressBar) {
            for (const el of container.querySelectorAll("*")) {
                if (!el.shadowRoot) continue;
                progressBar = el.shadowRoot.querySelector(WATCHED_CLASS);
                if (progressBar) {
                    console.log(`[DIAG][WATCHED] shadow pierced on <${el.tagName.toLowerCase()}>`);
                    break;
                }
            }
        }
        if (progressBar?.style.width) {
            const pct = parseInt(progressBar.style.width, 10);
            console.log(`[DIAG][WATCHED] lockup → ${pct}%`);
            return isNaN(pct) ? null : pct;
        }

        // Tier 2: legacy format — ytd-thumbnail-overlay-resume-playback-renderer
        // Kept as fallback for non-lockup cards. Tries light DOM first, then shadow root.
        progressBar = container.querySelector(
            "ytd-thumbnail-overlay-resume-playback-renderer #progress"
        );
        if (progressBar?.style.width) {
            const pct = parseInt(progressBar.style.width, 10);
            console.log(`[DIAG][WATCHED] legacy light-DOM → ${pct}%`);
            return isNaN(pct) ? null : pct;
        }
        const renderer = container.querySelector("ytd-thumbnail-overlay-resume-playback-renderer");
        if (renderer?.shadowRoot) {
            progressBar = renderer.shadowRoot.querySelector("#progress");
            if (progressBar?.style.width) {
                const pct = parseInt(progressBar.style.width, 10);
                console.log(`[DIAG][WATCHED] legacy shadow-DOM → ${pct}%`);
                return isNaN(pct) ? null : pct;
            }
        }

        // Tier 3: structural fallback — search entire container for any element
        // whose class contains "progress" and carries a percentage width style.
        // Not constrained to ytd-thumbnail — the lockup format uses a different
        // thumbnail host element (ytThumbnailBottomOverlayViewModelHost).
        const candidates = container.querySelectorAll('[style*="width"]');
        for (const el of candidates) {
            const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
            if (!cls.includes("progress")) continue;
            const pct = parseInt(el.style.width, 10);
            if (!isNaN(pct) && pct > 0) {
                console.log(`[DIAG][WATCHED] structural fallback → ${pct}% on .${el.className}`);
                return pct;
            }
        }

        return null;
    }

    // ======================== HYDRATION GATE ========================
    const containerCreatedAt = new WeakMap();

    function isContainerLive(container, title) {
        if (!containerCreatedAt.has(container)) {
            containerCreatedAt.set(container, performance.now());
        }
        if (!title || title.length < 3) return false;
        const hasThumbnail = (
            container.querySelector("img[src*='ytimg.com']") ||
            container.querySelector("yt-img-shadow") ||
            container.querySelector("ytd-thumbnail img")
        );
        return !!hasThumbnail;
    }

    function logHydrationDelta(container, title) {
        const createdAt = containerCreatedAt.get(container);
        if (createdAt) {
            const delta = Math.round(performance.now() - createdAt);
            console.log(`[DIAG] hydration delta: ${delta}ms for "${title}"`);
        }
    }

    // ======================== UNHIDE WATCHER ========================
    function watchForUnhide(container, label) {
        const watcher = new MutationObserver(() => {
            const d = container.style.display;
            if (d !== "none") {
                console.warn(`[DIAG][UNHIDE] display restored to "${d || "empty"}" — "${label}"`);
                logToHUD("WARN", `[UNHIDE] ${label}`);
            }
        });
        watcher.observe(container, { attributes: true, attributeFilter: ["style"] });
    }

    // ======================== NUKE HELPER ========================
    // Removes the container from layout. Scroll velocity is managed by the
    // per-batch nuke ceiling (CONFIG.nukeCeiling) — at most 30% of evaluated
    // cards are nuked per batch, so 70% of cards remain visible and provide
    // natural scroll friction and impression beacons.
    function nuke(container, reason, label) {
        const isFirstNuke = !container.dataset.ytPurgeNuked;
        container.dataset.ytPurgeNuked = "1";
        if (isFirstNuke) {
            const h = heuristics[reason];
            if (h) {
                h.count++;
                if (h.countEl) h.countEl.textContent = `caught: ${h.count}`;
            }
            MetricsService.recordNuke(reason);
            logToHUD(reason, label);
            recordNuke(reason, label);
            watchForUnhide(container, label);
        }
        // Clown mode: first nuke of a container gets the full performance
        // (shake, confetti, BOING), then hides. Re-nukes of recycled
        // containers hide instantly — one card, one show.
        const hide = () => container.style.setProperty("display", "none", "important");
        if (isFirstNuke && typeof Clown !== "undefined" && Clown.active) {
            Clown.performNuke(container, hide);
        } else {
            hide();
        }
    }

    // ======================== PROCESSING ========================
    let scanCount = 0;
    let seenChannels = new Set(); // session-level channel tracking; cleared on yt-navigate-finish

    function processPage() {
        const ctx = getPageContext();
        if (!filteringActive()) {
            console.log(`[DIAG] context: ${ctx} — filtering inactive, skipping`);
            return;
        }

        const titles = document.querySelectorAll("h3");
        scanCount++;
        console.log(`[DIAG] scan ${scanCount} — context: ${ctx}, h3 count: ${titles.length}`);
        if (scanCount % 50 === 0) {
            console.log(`[DIAG] session milestone: ${scanCount} scans, ${nukeCount} nuked`);
        }
        if (titles.length === 0) return;

        const hasNew = Array.from(titles).some(h3 => {
            const title = h3.textContent?.trim();
            if (!title || title.length < 3) return false;
            const container = SelfHealer.findVideoContainerFromElement(h3);
            if (!container) return false;
            if (container.dataset.ytPurgePending) return true;
            return container.dataset.ytPurgeProcessed !== `${sessionId}:${title}`;
        });

        if (!hasNew) {
            console.log(`[DIAG] scan ${scanCount} — static DOM, nothing to evaluate`);
            return;
        }

        MetricsService.recordScan();

        let batchEvaluated = 0;
        let batchNuked     = 0;

        function attemptNuke(container, reason, label) {
            // Brainrot Parade: caught cards are stamped, not hidden. Nothing
            // leaves layout and every impression beacon stays honest — but
            // the ceiling is still simulated (batchNuked counts would-be
            // nukes) so the parade can show which cards it would have
            // spared. See clown.js design constraints.
            const parading = typeof Clown !== "undefined" && Clown.parade;
            if (batchEvaluated > 0 && batchNuked / batchEvaluated >= CONFIG.nukeCeiling) {
                if (parading) {
                    if (Clown.paradeSpared(container, reason)) {
                        logToHUD("INFO", `🍀 SPARED BY THE CEILING [${reason}] ${label}`);
                    }
                    return true;
                }
                console.log(`[DIAG][CEILING] sparing [${reason}]: "${label.slice(0, 50)}"`);
                return false;
            }
            if (parading) {
                if (Clown.paradeHit(container, reason)) {
                    logToHUD("INFO", `🤡 PARADE [${reason}] ${label}`);
                }
                batchNuked++;
                return true;
            }
            nuke(container, reason, label);
            batchNuked++;
            return true;
        }

        titles.forEach(h3 => {
            const title = h3.textContent?.trim();
            if (!title || title.length < 3) return;

            const container = SelfHealer.findVideoContainerFromElement(h3);
            if (!container) return;

            if (NON_VIDEO_CONTAINERS.has(container.tagName)) {
                console.log(`[DIAG] skip non-video container: <${container.tagName.toLowerCase()}> — "${title}"`);
                return;
            }

            if (container.dataset.ytPurgeProcessed === `${sessionId}:${title}`) {
                if (!container.dataset.ytPurgeNuked) {
                    if (heuristics.WATCHED.enabled) {
                        const percent = getWatchedPercent(container);
                        if (percent !== null && percent > 90) {
                            attemptNuke(container, "WATCHED", `[${percent}%] ${title}`);
                            return;
                        }
                    }
                    if (!container.dataset.ytPurgeDupeDone && heuristics.DUPE.enabled) {
                        const channelName = getChannelName(container);
                        if (channelName) {
                            container.dataset.ytPurgeDupeDone = "1";
                            if (seenChannels.has(channelName)) {
                                attemptNuke(container, "DUPE", `${channelName} — ${title}`);
                                return;
                            }
                            seenChannels.add(channelName);
                        }
                    }
                }
                return;
            }

            if (!isContainerLive(container, title)) {
                container.dataset.ytPurgePending = "1";
                console.log(`[DIAG] hydration pending: <${container.tagName.toLowerCase()}> — "${title}"`);
                return;
            }

            logHydrationDelta(container, title);
            delete container.dataset.ytPurgePending;

            container.dataset.ytPurgeProcessed = `${sessionId}:${title}`;
            MetricsService.recordCard();
            console.log(`[DIAG] container: <${container.tagName.toLowerCase()}> — "${title}"`);

            batchEvaluated++;
            classifyTitle(title);

            if (heuristics.DUPE.enabled) {
                const channelName = getChannelName(container);
                if (channelName) {
                    container.dataset.ytPurgeDupeDone = "1";
                    if (seenChannels.has(channelName)) {
                        if (attemptNuke(container, "DUPE", `${channelName} — ${title}`)) return;
                    } else {
                        seenChannels.add(channelName);
                    }
                }
            }

            if (heuristics.WATCHED.enabled) {
                const percent = getWatchedPercent(container);
                if (percent !== null && percent > 90) {
                    if (attemptNuke(container, "WATCHED", `[${percent}%] ${title}`)) return;
                }
            }

            if (heuristics.PHRASE.enabled) {
                if (CONFIG.clickbait.test(title) || matchesCustomPhrase(title)) {
                    if (attemptNuke(container, "PHRASE", title)) return;
                }
            }

            if (heuristics.SLOP.enabled) {
                if (CONFIG.grammarSlop.test(title)) {
                    if (attemptNuke(container, "SLOP", title)) return;
                }
            }

            if (heuristics.CAPS.enabled) {
                // Real nukes always use CONFIG's thresholds. The Brainrot
                // Parade re-checks misses with its lowered thresholds for the
                // near-miss display tier — those never nuke anything. The
                // nuke ceiling is untouchable even by clowns (see clown.js).
                const letters = title.replace(/[^a-zA-Z]/g, "");
                if (letters.length > 0) {
                    const upperRatio = letters.replace(/[^A-Z]/g, "").length / letters.length;
                    if (letters.length > CONFIG.minTitleLength && upperRatio >= CONFIG.capsThreshold) {
                        if (attemptNuke(container, "CAPS", title)) return;
                    } else {
                        const near = (typeof Clown !== "undefined") ? Clown.paradeThresholds() : null;
                        if (near && letters.length > near.minTitleLength && upperRatio >= near.capsThreshold) {
                            if (Clown.paradeNearMiss(container, "CAPS")) {
                                logToHUD("INFO", `😬 NEAR MISS [CAPS] ${title}`);
                            }
                        }
                    }
                }
            }

            // Brainrot Parade: a card that ran the gauntlet uncaught is, by
            // parade rules, not brainrot — dim it so the stamps get the light.
            // (Near-missed cards are marked, and Clown.dim skips them.)
            if (typeof Clown !== "undefined" && Clown.parade) {
                Clown.dim(container);
            }
        });

        if (batchNuked > 0 || batchEvaluated > 0) {
            const pct  = batchEvaluated > 0 ? Math.round(batchNuked / batchEvaluated * 100) : 0;
            const verb = (typeof Clown !== "undefined" && Clown.parade) ? "paraded" : "nuked";
            console.log(`[DIAG] batch: ${batchEvaluated} evaluated, ${batchNuked} ${verb} (${pct}% — ceiling ${CONFIG.nukeCeiling * 100}%)`);
        }
    }

    // ======================== THEMATIC INTELLIGENCE ========================
    // Interface to the background service worker. Fire-and-forget during the
    // diagnostic phase — the resolved value is not yet used by the filter pipeline.
    function classifyTitle(title) {
        return new Promise(resolve => {
            const t = setTimeout(() => resolve(null), 500);
            try {
                chrome.runtime.sendMessage({ type: "CLASSIFY_TITLE", title }, response => {
                    clearTimeout(t);
                    if (chrome.runtime.lastError) { resolve(null); return; }
                    resolve(response ?? null);
                });
            } catch (e) {
                clearTimeout(t);
                resolve(null);
            }
        });
    }

    // ======================== INIT ========================
    let rafPending = false;
    function schedulePage() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            processPage();
        });
    }

    const HEALTH_CHECK_ELEMENTS = [
        { selector: "ytd-app",                                  label: "YouTube root (ytd-app)" },
        { selector: "ytd-two-column-browse-results-renderer",   label: "Browse results renderer — primary observer target" },
        { selector: "ytd-rich-grid-renderer",                   label: "Feed grid (ytd-rich-grid-renderer)" },
        { selector: "ytd-rich-item-renderer",                   label: "Video card (ytd-rich-item-renderer)" },
    ];

    async function runHealthCheck() {
        if (!filteringActive()) return true;

        const isSkeleton = !!document.querySelector(
            "ytd-ghost-video-grid-renderer, #home-page-skeleton"
        );
        if (isSkeleton) {
            console.log("[YT-PURGE] Health check deferred — page skeleton detected");
            return true;
        }

        // First run (or every run until it succeeds): learn the card shape
        // before anything may be healed. A failure is announced there.
        const inst = await Instantiator.ensure(
            () => document.querySelector(ACTIVE_BROWSE_RENDERER_SELECTOR) || document);

        let allOk = true;
        HEALTH_CHECK_ELEMENTS.forEach(({ selector, label }) => {
            if (!document.querySelector(selector)) {
                allOk = false;
                console.error(`[YT-PURGE][CRIT] missing element: ${label}`);
            }
        });

        const hasItems = !!document.querySelector(
            "ytd-rich-item-renderer, ytd-video-renderer"
        );

        if (allOk && hasItems) {
            console.log("[YT-PURGE] Health check passed — all structural elements present");
            return true;
        } else {
            captureDOM("health-failure");
            if (inst?.status !== "ok") {
                logToHUD("CRIT", "Structural failure detected — not instantiated, so no anchor search");
                console.error("[YT-PURGE] Health check failed on an install that has not instantiated — anchor search skipped");
                return false;
            }
            logToHUD("CRIT", "Structural failure detected — running anchor search");
            console.log("[YT-PURGE] Health check failed — initiating anchor search");
            SelfHealer.runAnchorSearch();
            return false;
        }
    }

    // ======================== DIAGNOSTIC EXPORT ========================
    // Exported via the ✱ button. Downloaded as yt-tuner-diag-<ctx>-<ts>.md.
    //
    // Format:
    //   ## Header
    //   session_id, exported_at, page_context, scan_count, nuke_count
    //
    //   ## Filters
    //   One row per heuristic: filter | enabled | caught
    //
    //   ## Custom Phrases
    //   Persistent phrase list, or "_none_"
    //
    //   ## Selector Corrections
    //   Active corrections from storage, or "_none_"
    //
    //   ## Nuke Log
    //   Last 5 nuked titles (most recent first): [REASON] title
    //
    //   ## System Events
    //   All WARN and CRIT entries this session. "none" if clean.
    //   INFO entries are omitted — noise at this level.
    async function exportDiagnostic() {
        const ctx       = getPageContext();
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename  = `yt-tuner-diag-${ctx}-${timestamp}.md`;

        const filterRows = Object.entries(heuristics)
            .map(([key, h]) =>
                `| ${key.padEnd(7)} | ${h.enabled ? "yes" : "no "}     | ${String(h.count).padStart(6)} |`
            ).join("\n");

        const phrases = customPhrases.length > 0
            ? customPhrases.map(p => `- ${p}`).join("\n")
            : "_none_";

        const nukeLogEntries = await loadNukeLog();
        const nukeLogText = nukeLogEntries.length > 0
            ? nukeLogEntries.map((e, i) => `${i + 1}. [${e.reason}] ${e.label}`).join("\n")
            : "_empty_";

        const events = systemEvents.length > 0
            ? systemEvents.map(e => `[${e.level}] ${e.message}`).join("\n")
            : "none";

        const corrections = await SelfHealer.loadSelectorCorrections();
        const correctionsText = corrections.length > 0
            ? corrections.map(c => `- ${c.tag} (hits: ${c.hits}, discovered: ${c.discovered})`).join("\n")
            : "_none_";

        const md = [
            `## Header`,
            ``,
            `\`\`\``,
            `session_id:   ${sessionId}`,
            `exported_at:  ${new Date().toISOString()}`,
            `page_context: ${ctx}`,
            `scan_count:   ${scanCount}`,
            `nuke_count:   ${nukeCount}`,
            `\`\`\``,
            ``,
            `## Filters`,
            ``,
            `| filter  | enabled | caught |`,
            `|---------|---------|--------|`,
            filterRows,
            ``,
            `## Custom Phrases`,
            ``,
            phrases,
            ``,
            `## Selector Corrections`,
            ``,
            correctionsText,
            ``,
            `## Nuke Log`,
            ``,
            nukeLogText,
            ``,
            `## System Events`,
            ``,
            events,
        ].join("\n");

        try {
            const blob = new Blob([md], { type: "text/markdown" });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement("a");
            a.href     = url;
            a.download = filename;
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            logToHUD("INFO", `Diagnostic exported: ${filename}`);
            console.log(`[YT-PURGE] Diagnostic exported: ${filename}`);
        } catch (e) {
            logToHUD("CRIT", `Diagnostic export failed: ${e.message}`);
            console.error("[YT-PURGE] Diagnostic export failed:", e.message);
        }
    }


    // ======================== DOM CAPTURE FRAMEWORK ========================
    // Automatic captures stay in memory; nothing is downloaded unasked.
    function captureDOM(reason) {
        try {
            const c = Instantiator.captureDOM(`${reason}-${getPageContext()}`);
            logToHUD("INFO", `DOM captured in memory (${Math.round(c.html.length / 1024)}KB) — 📸 saves a snapshot`);
        } catch (e) {
            logToHUD("CRIT", `DOM capture failed: ${e.message}`);
            console.error("[YT-PURGE] DOM capture failed:", e.message);
        }
    }

    function saveDOMSnapshot() {
        try {
            Instantiator.captureDOM(`manual-${getPageContext()}`);
            const filename = Instantiator.downloadCapture();
            logToHUD("INFO", `DOM snapshot saved: ${filename}`);
        } catch (e) {
            logToHUD("CRIT", `DOM snapshot failed: ${e.message}`);
            console.error("[YT-PURGE] DOM snapshot failed:", e.message);
        }
    }


    // ── PRIMARY OBSERVER ─────────────────────────────────────────────────
    const ACTIVE_BROWSE_RENDERER_SELECTOR =
        "ytd-page-manager > *:not([hidden]) ytd-two-column-browse-results-renderer";

    let observer = null;
    let currentBrowseTarget = null;

    function attachNarrowObserver() {
        const target = document.querySelector(ACTIVE_BROWSE_RENDERER_SELECTOR);
        if (!target) return false;
        if (observer) observer.disconnect();
        currentBrowseTarget = target;
        observer = new MutationObserver(schedulePage);
        observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
        return true;
    }

    let booted    = false;
    let booting   = false;
    let sessionId = 0;

    let hudVisible = false;

    function showHUD() {
        if (!hudHost) hudHost = createHUD();
        if (!document.documentElement.contains(hudHost))
            document.documentElement.appendChild(hudHost);
        hudVisible = true;
    }

    function hideHUD() {
        if (hudHost && document.documentElement.contains(hudHost))
            document.documentElement.removeChild(hudHost);
        hudVisible = false;
    }

    function bootOnce() {
        if (booting || booted || !filteringActive()) return;
        booting = true;
        console.log(`[YT-PURGE] v4.1 booting. Context: ${getPageContext()}. Custom phrases: ${customPhrases.length}. Active tags: ${SelfHealer.activeContainerTags.size}.`);

        const waitForPrimaryTarget = (attempts = 0) => {
            if (attachNarrowObserver()) {
                booted = true;
                if (getPageContext() === "home") setTimeout(runHealthCheck, 1500);
                logToHUD("INFO", `Narrowed observer active after ${attempts * 250}ms`);
                console.log(`[YT-PURGE] Narrowed observer active after ${attempts * 250}ms`);
                processPage();
            } else if (attempts < 20) {
                setTimeout(() => waitForPrimaryTarget(attempts + 1), 250);
            } else {
                // ── LEGACY FALLBACK ───────────────────────────────────────────
                // PRIMARY TARGET NOT FOUND after 5 seconds.
                // Retained as resilience measure. Activation is always [CRIT].
                booted = true;
                console.error("[YT-PURGE][LEGACY] Primary target not found after 5s — falling back to document.body");
                logToHUD("CRIT", "Primary observer target absent — legacy fallback active (document.body)");
                captureDOM("observer-fallback");
                if (observer) observer.disconnect();
                observer = new MutationObserver(schedulePage);
                observer.observe(document.body, { childList: true, subtree: true });
                if (getPageContext() === "home") runHealthCheck();
                // ── END LEGACY FALLBACK ───────────────────────────────────────
            }
        };
        waitForPrimaryTarget();
    }

    async function init() {
        try {
            await SelfHealer.buildActiveTagSet();
            SelfHealer.setHooks({
                logToHUD,
                captureDOM,
                attachNarrowObserver,
                processPage,
                loadNukeLog,
                loadInstantiation: Instantiator.load,
            });
            Instantiator.setHooks({ logToHUD });
        } catch (e) {
            console.warn("[YT-PURGE] Self-healing module unavailable — running on baseline tags only:", e.message);
        }
        try {
            Clown.setHooks({ logToHUD });
        } catch (e) {
            console.warn("[YT-PURGE] Clown module unavailable — the show will not go on:", e.message);
        }
        customPhrases = await loadPhrases();
        const stored = await chrome.storage.local.get({ extensionEnabled: true });
        extensionEnabled = stored.extensionEnabled;

        window.addEventListener("yt-navigate-finish", () => {
            MetricsService.rotateSession();
            sessionId++;
            seenChannels.clear();
            console.log(`[YT-PURGE] yt-navigate-finish: sessionId now ${sessionId}`);
            if (!filteringActive()) {
                booted  = false;
                booting = false;
                console.log("[YT-PURGE] yt-navigate-finish: non-filterable context — boot flags reset");
                return;
            }
            requestAnimationFrame(() => {
                if (booted) {
                    const current = document.querySelector(ACTIVE_BROWSE_RENDERER_SELECTOR);
                    if (current && current !== currentBrowseTarget) {
                        if (attachNarrowObserver()) {
                            if (getPageContext() === "home") setTimeout(runHealthCheck, 1500);
                            logToHUD("INFO", "Observer re-attached after SPA navigation");
                            console.log("[YT-PURGE] Observer re-attached after SPA navigation");
                            processPage();
                        }
                    }
                } else {
                    bootOnce();
                }
            });
        });

        const waitForBody = () => {
            if (!document.body) { setTimeout(waitForBody, 10); return; }
            bootOnce();
        };
        waitForBody();
    }

    // ======================== DIAGNOSTICS ========================
    window.ytDiag = {
        audit() {
            const titles = document.querySelectorAll("h3");
            console.group("[AUDIT] Container state");
            titles.forEach(h3 => {
                const title = h3.textContent?.trim();
                if (!title || title.length < 3) return;
                const container = SelfHealer.findVideoContainerFromElement(h3);
                if (!container || NON_VIDEO_CONTAINERS.has(container.tagName)) return;
                const nuked    = container.dataset.ytPurgeNuked    ? "NUKED" : "LIVE ";
                const dupeDone = container.dataset.ytPurgeDupeDone ? "yes" : "no ";
                const display  = container.style.display || "(unset)";
                const channel  = getChannelName(container) || "?";
                const watched  = getWatchedPercent(container);
                const stamp    = container.dataset.ytPurgeProcessed || "none";
                console.log(
                    `[${nuked}]`,
                    `display:"${display}"`,
                    `dupe-done:${dupeDone}`,
                    `watched:${watched !== null ? watched + "%" : "—"}`,
                    `ch:"${channel}"`,
                    `stamp:${stamp.split(":")[0] ?? "—"}`,
                    `"${title.slice(0, 50)}"`
                );
            });
            console.groupEnd();
            console.log(`[AUDIT] seenChannels (${seenChannels.size}):`, [...seenChannels].join(", ") || "(empty)");
        },
    };

    // ======================== POPUP MESSAGING ========================
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.type === "GET_STATE") {
            sendResponse({
                active:            filteringActive(),
                extensionEnabled,
                hudVisible,
                nukeCount,
                filters: Object.fromEntries(
                    Object.entries(heuristics).map(([k, h]) => [
                        k, { enabled: h.enabled, count: h.count, label: h.label }
                    ])
                ),
                phrases: customPhrases.slice(),
                clown: (typeof Clown !== "undefined") ? Clown.state : null,
            });
            return true;
        }
        if (msg.type === "TOGGLE_CLOWN") {
            // The circus raises its own tent: activating clown mode shows the
            // HUD so the skin, chaos lines, and circus counter have a stage.
            if (typeof Clown !== "undefined" && !Clown.active) showHUD();
            sendResponse({ clown: (typeof Clown !== "undefined") ? Clown.toggle() : null });
            return true;
        }
        if (msg.type === "TOGGLE_CLOWN_PARADE") {
            const clown = (typeof Clown !== "undefined") ? Clown.toggleParade() : null;
            // Parade sweep: dim every already-evaluated clean card immediately,
            // not just cards evaluated after the toggle. Without this, a fully
            // filtered feed shows stamps but no darkness for them to stand in.
            if (clown?.parade) {
                document.querySelectorAll("h3").forEach(h3 => {
                    const title = h3.textContent?.trim();
                    if (!title || title.length < 3) return;
                    const container = SelfHealer.findVideoContainerFromElement(h3);
                    if (!container || NON_VIDEO_CONTAINERS.has(container.tagName)) return;
                    if (container.dataset.ytPurgeNuked) return;
                    if (container.dataset.ytPurgeProcessed) Clown.dim(container);
                });
            }
            sendResponse({ clown });
            return true;
        }
        if (msg.type === "TOGGLE_EXTENSION") {
            extensionEnabled = !extensionEnabled;
            chrome.storage.local.set({ extensionEnabled });
            sendResponse({ extensionEnabled });
            return true;
        }
        if (msg.type === "TOGGLE_HUD") {
            hudVisible ? hideHUD() : showHUD();
            sendResponse({ hudVisible });
            return true;
        }
        if (msg.type === "TOGGLE_FILTER") {
            const h = heuristics[msg.filter];
            if (h) h.enabled = !h.enabled;
            sendResponse({ enabled: heuristics[msg.filter]?.enabled ?? false });
            return true;
        }
        if (msg.type === "ADD_PHRASE") {
            const val = (msg.phrase || "").toLowerCase().trim();
            if (val && !customPhrases.includes(val)) {
                customPhrases.push(val);
                savePhrases();
            }
            sendResponse({ phrases: customPhrases.slice() });
            return true;
        }
        if (msg.type === "REMOVE_PHRASE") {
            const idx = customPhrases.indexOf(msg.phrase);
            if (idx !== -1) { customPhrases.splice(idx, 1); savePhrases(); }
            sendResponse({ phrases: customPhrases.slice() });
            return true;
        }
        if (msg.type === "GET_DIAGNOSTIC") {
            (async () => {
                const [metrics, nukeLog] = await Promise.all([
                    Storage.get("yt-purge-metrics"),
                    loadNukeLog(),
                ]);
                const corrections = await SelfHealer.loadSelectorCorrections();
                sendResponse({
                    session: {
                        sessionId,
                        scanCount,
                        nukeCount,
                        context:        getPageContext(),
                        filteringActive: filteringActive(),
                        extensionEnabled,
                        hudVisible,
                    },
                    heuristics: Object.fromEntries(
                        Object.entries(heuristics).map(([k, h]) => [k, { enabled: h.enabled, count: h.count }])
                    ),
                    seenChannels:       [...seenChannels],
                    activeContainerTags: [...SelfHealer.activeContainerTags],
                    customPhrases:      customPhrases.slice(),
                    systemEvents:       systemEvents.slice(),
                    corrections,
                    nukeLog,
                    metrics: Array.isArray(metrics) ? metrics : [],
                });
            })();
            return true;
        }
    });

    init();
})();
