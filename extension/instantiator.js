/*
 * Tuner for YouTube — Instantiator
 * =====================================================================
 *
 * First-run setup, and the only thing allowed to decide that an install
 * knows what a card looks like on this user's YouTube.
 *
 * Why it exists: a fresh install has an empty nuke log, so the self-healer
 * had nothing to recognise the page by and fell back to treating every
 * visible title as a beacon. On a layout where cards sit bare inside shelf
 * sections, that committed the whole section as a "card" on the very first
 * page load — with more beacons (8) than a seasoned install needed (2).
 * A shared remote config cannot replace this: the layout is decided per
 * user by YouTube's A/B bucketing, so it has to be observed where it runs.
 *
 * On a home page load with no successful instantiation stored:
 *   1. capture the DOM in memory (downloaded only when the user asks)
 *   2. resolve every visible video title to its container via SelfHealer
 *   3. FAIL at once if any title resolves to a container holding several
 *      titles — a wrapper mistaken for a card is structural, not timing
 *   4. otherwise succeed once ≥ MIN_BEACONS titles resolve to baseline card
 *      tags; while there are too few titles, retry (the feed may still be
 *      hydrating) and fail after the last attempt
 *   5. store the record either way. On success it carries the beacon titles
 *      the self-healer uses as anchors until the nuke log has its own.
 *   6. on failure, say so loudly: HUD CRIT, console.error, and a banner on
 *      the page that does not need the HUD open. SelfHealer refuses to
 *      commit anything until a later page load instantiates successfully.
 *
 * chrome.storage.local key:
 *   "yt-tuner-instantiation" — { status: "ok"|"failed", at, version,
 *                                beacons: [{label, tag}], cardTags: {tag: n},
 *                                wrappers: [{label, tag, titles}], reason }
 */

const Instantiator = (() => {
    "use strict";

    const KEY                = "yt-tuner-instantiation";
    const MIN_BEACONS        = 4;
    const MAX_STORED_BEACONS = 12;
    const ATTEMPTS           = 6;
    const RETRY_MS           = 1000;

    // A video title is an h3 carrying a link. Section headers and other
    // chrome are left out so they cannot pose as cards or as wrappers.
    const TITLE_SELECTOR = "h3";
    const isVideoTitle = h3 => !!h3.querySelector("a[href]") && (h3.textContent?.trim().length ?? 0) >= 3;

    let capture = null; // { reason, filename, html } — this page load only
    let hooks   = {};
    let running = null;

    // ======================== STORAGE ========================

    async function load() {
        try {
            const r = await chrome.storage.local.get([KEY]);
            return r[KEY] ?? null;
        } catch (e) { return null; }
    }

    async function save(record) {
        try { await chrome.storage.local.set({ [KEY]: record }); }
        catch (e) { console.error("[YT-PURGE][INSTANTIATE] could not store the instantiation record:", e.message); }
    }

    // ======================== DOM CAPTURE (in memory) ========================

    function captureDOM(reason) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        capture = {
            reason,
            filename: `yt-purge-dom-capture-${reason}-${timestamp}.html`,
            html: document.documentElement.outerHTML,
        };
        console.log(`[YT-PURGE] DOM captured in memory: ${capture.filename} (${Math.round(capture.html.length / 1024)}KB)`);
        return capture;
    }

    // Only ever called from a user's click.
    function downloadCapture() {
        if (!capture) captureDOM("manual");
        const url = URL.createObjectURL(new Blob([capture.html], { type: "text/html" }));
        const a   = document.createElement("a");
        a.href = url;
        a.download = capture.filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return capture.filename;
    }

    // ======================== SURVEY ========================

    function survey(root) {
        const beacons  = [];
        const wrappers = [];
        const unknown  = [];
        const baseline = SelfHealer.CONTAINER_TAGS_BASELINE;
        for (const h3 of root.querySelectorAll(TITLE_SELECTOR)) {
            if (!isVideoTitle(h3)) continue;
            const label     = h3.textContent.trim();
            const container = SelfHealer.findVideoContainerFromElement(h3);
            const tag       = container?.tagName ?? "?";
            const titles    = container ? [...container.querySelectorAll(TITLE_SELECTOR)].filter(isVideoTitle).length : 0;
            if (titles > 1)              wrappers.push({ label, tag, titles });
            else if (baseline.has(tag))  beacons.push({ label, tag });
            else                         unknown.push({ label, tag });
        }
        return { beacons, wrappers, unknown };
    }

    function verdict(s) {
        if (s.wrappers.length) {
            const w = s.wrappers[0];
            return `${s.wrappers.length} title(s) resolve to a container holding several titles `
                 + `(e.g. "${w.label}" -> <${w.tag.toLowerCase()}> with ${w.titles}); `
                 + `the card shape on this layout is not known`;
        }
        if (s.beacons.length < MIN_BEACONS) {
            return `only ${s.beacons.length} title(s) resolved to a known card `
                 + `(need ${MIN_BEACONS}; ${s.unknown.length} resolved to unknown tags)`;
        }
        return null;
    }

    // ======================== RUN ========================

    async function attempt(root) {
        for (let i = 1; ; i++) {
            const s = survey(root());
            if (s.wrappers.length || s.beacons.length >= MIN_BEACONS || i >= ATTEMPTS) return s;
            await new Promise(r => setTimeout(r, RETRY_MS));
        }
    }

    // Resolves to the stored record. A successful record is final; a failed
    // one is retried on every home page load until it succeeds.
    async function ensure(root = () => document) {
        const existing = await load();
        if (existing?.status === "ok") return existing;
        if (running) return running;

        running = (async () => {
            captureDOM("instantiation");
            const s      = await attempt(root);
            const reason = verdict(s);
            const cardTags = {};
            s.beacons.forEach(b => { cardTags[b.tag] = (cardTags[b.tag] || 0) + 1; });
            const record = {
                status:   reason ? "failed" : "ok",
                at:       new Date().toISOString(),
                version:  chrome.runtime.getManifest().version,
                beacons:  s.beacons.slice(0, MAX_STORED_BEACONS),
                cardTags,
                wrappers: s.wrappers.slice(0, MAX_STORED_BEACONS),
                reason,
            };
            await save(record);
            if (reason) {
                captureDOM("instantiation-failed");
                const msg = `Instantiation FAILED — ${reason}. Filtering runs on built-in tags only; self-healing is off until a page load instantiates.`;
                console.error(`[YT-PURGE][INSTANTIATE] ${msg}`);
                hooks.logToHUD?.("CRIT", msg);
                showBanner(msg);
            } else {
                const tags = Object.entries(cardTags).map(([t, n]) => `<${t.toLowerCase()}>×${n}`).join(", ");
                console.log(`[YT-PURGE][INSTANTIATE] ok — ${s.beacons.length} titles resolved to known cards: ${tags}`);
                hooks.logToHUD?.("INFO", `Instantiated: ${s.beacons.length} cards recognised (${tags})`);
            }
            return record;
        })();
        try { return await running; } finally { running = null; }
    }

    // ======================== LOUD FAILURE ========================
    // A banner in its own shadow root, independent of the HUD, because the
    // HUD is usually closed and a failure nobody sees is the silent kind.

    function showBanner(message) {
        document.getElementById("yt-tuner-instantiation-banner")?.remove();
        const host = document.createElement("div");
        host.id = "yt-tuner-instantiation-banner";
        host.style.cssText = "position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; z-index: 2147483647 !important;";
        const shadow = host.attachShadow({ mode: "open" });
        const bar = document.createElement("div");
        bar.style.cssText = "background: #b00020; color: #fff; font: 600 13px/1.4 system-ui, sans-serif; padding: 10px 16px; display: flex; gap: 12px; align-items: center; box-shadow: 0 2px 12px rgba(0,0,0,.5);";
        const text = document.createElement("span");
        text.style.cssText = "flex: 1;";
        text.textContent = `Tuner for YouTube: ${message}`;
        const btn = (label, onClick) => {
            const b = document.createElement("button");
            b.textContent = label;
            b.style.cssText = "background: #fff; color: #b00020; border: 0; border-radius: 4px; padding: 5px 10px; font: inherit; cursor: pointer;";
            b.addEventListener("click", onClick);
            return b;
        };
        bar.append(
            text,
            btn("Save DOM snapshot", () => downloadCapture()),
            btn("Dismiss", () => host.remove()),
        );
        shadow.appendChild(bar);
        (document.body || document.documentElement).appendChild(host);
    }

    return {
        KEY,
        MIN_BEACONS,
        setHooks(h) { hooks = h; },
        ensure,
        load,
        survey,
        captureDOM,
        downloadCapture,
        get lastCapture() { return capture; },
    };
})();
