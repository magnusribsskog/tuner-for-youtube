/*
 * Tuner for YouTube — Self-Healing Module
 * =====================================================================
 *
 * Container tag discovery, correction storage, and structural recovery.
 * Loaded before content.js; exposes SelfHealer to the shared content
 * script execution context.
 *
 * Hooks registered via SelfHealer.setHooks() during content.js init:
 *   logToHUD(reason, message)
 *   captureDOM(reason)            — in memory; never downloads unasked
 *   attachNarrowObserver() → bool
 *   processPage()
 *   loadNukeLog() → Promise<Array>
 *   loadInstantiation() → Promise<record|null>   (instantiator.js)
 */

const SelfHealer = (() => {
    "use strict";

    const Storage = {
        get: key => chrome.storage.local.get([key]).then(r => r[key] ?? null),
        set: (key, val) => chrome.storage.local.set({ [key]: val }),
    };

    // ======================== CONTAINER TAG BASELINE ========================
    // Hardcoded known-good tag set. Never modified at runtime. Stored
    // corrections are merged on top via buildActiveTagSet() to produce
    // activeContainerTags. If storage is cleared, cold start falls back
    // here identically to pre-self-healing behaviour.
    //
    // Self-healing design:
    //   When the health check fires a CRIT and anchor search finds pivot
    //   candidates, the code validates the candidate (≥2 beacon matches),
    //   writes the discovered tag to storage with a timestamp and hit count,
    //   adds it to activeContainerTags for the current session, reattaches
    //   the observer, and re-runs processPage(). No time-based expiry —
    //   corrections are valid until a subsequent anchor search replaces them.
    //
    // Storage entry format (per correction):
    //   { tag, discovered: ISO8601, hits: number, last_confirmed: ISO8601 }
    //
    // A/B testing note: corrections accumulate rather than replace — the
    // active tag set is the union of all DOM shapes this user has observed.
    // A user cycled between A/B buckets may legitimately need both an old
    // and a new tag active simultaneously.
    const CONTAINER_TAGS_BASELINE = new Set([
        "YTD-RICH-ITEM-RENDERER",
        "YTD-COMPACT-VIDEO-RENDERER",
        "YTD-VIDEO-RENDERER",
        "YTD-GRID-VIDEO-RENDERER",
        "YTD-REEL-ITEM-RENDERER",
        "YTD-SHELF-RENDERER",
        "YTD-HORIZONTAL-LIST-RENDERER",
        "YTD-ITEM-SECTION-RENDERER",
        "YTD-COMPACT-RADIO-RENDERER",
        "YTD-RADIO-RENDERER"
    ]);

    let activeContainerTags = new Set(CONTAINER_TAGS_BASELINE);

    const CORRECTIONS_KEY = "yt-tuner-selector-corrections";

    let hooks = {};

    // ======================== CORRECTION STORAGE ========================

    async function loadSelectorCorrections() {
        try {
            const val = await Storage.get(CORRECTIONS_KEY);
            return Array.isArray(val) ? val : [];
        } catch (e) { return []; }
    }

    async function saveSelectorCorrections(corrections) {
        try {
            await Storage.set(CORRECTIONS_KEY, corrections);
        } catch (e) {
            console.warn("[YT-PURGE] Selector corrections save failed:", e.message);
        }
    }

    // ======================== PUBLIC API ========================

    async function buildActiveTagSet() {
        activeContainerTags = new Set(CONTAINER_TAGS_BASELINE);
        const corrections = await loadSelectorCorrections();
        corrections.forEach(c => activeContainerTags.add(c.tag));
        console.log(`[YT-PURGE] Active tag set: ${[...activeContainerTags].join(", ")}`);
        if (corrections.length > 0) {
            console.log(`[YT-PURGE] Loaded ${corrections.length} correction(s) from storage`);
        }
        return activeContainerTags;
    }

    async function commitCorrection(tag) {
        const now = new Date().toISOString();
        const corrections = await loadSelectorCorrections();
        const existing = corrections.find(c => c.tag === tag);
        if (existing) {
            existing.hits++;
            existing.last_confirmed = now;
        } else {
            corrections.push({ tag, discovered: now, hits: 1, last_confirmed: now });
        }
        await saveSelectorCorrections(corrections);
        await buildActiveTagSet();
        hooks.logToHUD("INFO", `Selector correction committed: <${tag.toLowerCase()}>`);
        console.log(`[YT-PURGE] Correction committed: ${tag}`);
    }

    // ======================== CONTAINER DETECTION ========================
    function findVideoContainerFromElement(element) {
        let node = element;
        while (node && node !== document.body) {
            if (activeContainerTags.has(node.tagName)) return node;
            node = node.parentElement;
        }
        // Fallback: find the YTD-* element that is a direct child of a div#contents.
        // YouTube's grid and list layouts consistently place the video card element
        // as a direct child of div#contents inside the row or section renderer.
        // div#contents (plural) is the grid row's child list; div#content (singular)
        // is an inner layout div within a single card — these are reliably distinct.
        node = element.parentElement;
        while (node && node !== document.body) {
            if (node.tagName?.startsWith("YTD-") && node.parentElement?.id === "contents") {
                return node;
            }
            node = node.parentElement;
        }
        return element.parentElement;
    }

    // ======================== ANCHOR SEARCH FRAMEWORK ========================
    // On structural failure ([CRIT]), identifies container tag names by finding
    // known titles in the DOM and walking up to the YTD-* child of div#contents.
    //
    // Beacon sources, in order:
    //   nuke log       — confirmed-rendered titles from prior nukes.
    //   instantiation  — titles the instantiator saw resolve to known cards.
    //
    // There is no cold-start path any more. It used every visible h3 as a
    // beacon, which on a fresh install turned the first structural failure
    // into a committed wrapper. An install that has not instantiated
    // successfully commits nothing, and says so as a CRIT.
    //
    // Validation before committing a correction:
    //   - Tag name starts with "YTD-"
    //   - Not already in CONTAINER_TAGS_BASELINE
    //   - ≥2 independent beacons confirmed the tag as pivot

    async function runAnchorSearch() {
        const inst = hooks.loadInstantiation ? await hooks.loadInstantiation() : null;
        if (inst?.status !== "ok") {
            const why = inst ? `instantiation failed: ${inst.reason}` : "this install has not instantiated";
            hooks.logToHUD("CRIT", `Anchor search refused — ${why}. Nothing committed.`);
            console.error(`[YT-PURGE] Anchor search refused — ${why}`);
            return;
        }
        let anchors = await hooks.loadNukeLog();
        if (!anchors.length) anchors = (inst.beacons || []).map(b => ({ reason: "INIT", label: b.label }));

        setTimeout(async () => {
            const candidates = new Map(); // tag → beacon count
            let beaconCount  = 0;

            const allText = document.querySelectorAll("h3, yt-formatted-string, span");
            const found   = [];

            anchors.forEach(anchor => {
                const anchorLabel = typeof anchor === "string" ? anchor : anchor.label;
                for (const el of allText) {
                    if (el.textContent?.trim() === anchorLabel) {
                        found.push(anchor);
                        let node = el.parentElement;
                        while (node && node !== document.body) {
                            if (node.tagName?.startsWith("YTD-") && node.parentElement?.id === "contents") {
                                candidates.set(node.tagName, (candidates.get(node.tagName) || 0) + 1);
                                break;
                            }
                            node = node.parentElement;
                        }
                        break;
                    }
                }
            });

            beaconCount = found.length;
            console.log(`[YT-PURGE] Anchor search: ${found.length}/${anchors.length} anchors found`);
            if (found.length < 2) {
                hooks.logToHUD("WARN", `Anchor search inconclusive — only ${found.length}/${anchors.length} anchors found`);
                return;
            }

            if (!candidates.size) {
                hooks.logToHUD("CRIT", "Pivot failed — no YTD container found in parent chain");
                return;
            }

            let recovered = false;

            for (const [tag, count] of candidates) {
                const isKnown = CONTAINER_TAGS_BASELINE.has(tag) || activeContainerTags.has(tag);
                if (isKnown) {
                    hooks.logToHUD("INFO", `Pivot confirmed known container: <${tag.toLowerCase()}> (${count} beacons)`);
                    console.log(`[YT-PURGE] Pivot confirmed known: ${tag} (${count} beacons)`);
                    continue;
                }

                if (!tag.startsWith("YTD-")) {
                    hooks.logToHUD("WARN", `Pivot candidate rejected — not a YTD element: <${tag.toLowerCase()}>`);
                    continue;
                }

                if (count < 2) {
                    hooks.logToHUD("WARN", `Pivot candidate below threshold: <${tag.toLowerCase()}> (${count} beacon)`);
                    continue;
                }

                await commitCorrection(tag);
                hooks.logToHUD("WARN", `Self-healed: <${tag.toLowerCase()}> (${count} beacons) — reattaching observer`);
                console.log(`[YT-PURGE] Self-heal: committed ${tag}, reattaching observer`);
                recovered = true;
            }

            hooks.captureDOM("anchor-search");

            if (recovered) {
                requestAnimationFrame(() => {
                    if (hooks.attachNarrowObserver()) {
                        hooks.logToHUD("INFO", "Observer reattached after self-heal");
                        // Self-heal fanfare — no-op unless the circus is in town.
                        if (typeof Clown !== "undefined") Clown.healFanfare();
                        hooks.processPage();
                    } else {
                        hooks.logToHUD("CRIT", "Observer reattach failed after self-heal — check DOM structure");
                    }
                });
            }

        }, 500);
    }

    return {
        setHooks(h) { hooks = h; },
        buildActiveTagSet,
        commitCorrection,
        findVideoContainerFromElement,
        runAnchorSearch,
        loadSelectorCorrections,
        get activeContainerTags() { return activeContainerTags; },
        get CONTAINER_TAGS_BASELINE() { return CONTAINER_TAGS_BASELINE; },
    };
})();
