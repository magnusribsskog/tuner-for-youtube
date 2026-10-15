/*
 * Tuner for YouTube — Clown Mode Module 🤡
 * =====================================================================
 *
 * "Ships when the serious work is done."
 * The serious work was done. Sent in the clowns at three in the morning,
 * during a heat wave, as is right and proper.
 *
 * Loaded after self-healing.js, before content.js; exposes Clown to the
 * shared content script execution context. Same module pattern as
 * SelfHealer: content.js calls in, Clown never reaches into content.js.
 *
 * Design constraints (non-negotiable):
 *   - The nuke ceiling is never touched. The Brainrot Parade lowers
 *     heuristic thresholds only, and only for its near-miss display tier.
 *     The circus obeys physics.
 *   - The Brainrot Parade does not hide anything. Hiding the 70%+ of cards
 *     that pass the filters would blow through the ceiling and reopen
 *     hostilities with YouTube's anomaly detection. Instead: a parade.
 *     Everything the filters would kill stays visible and gets a big fat
 *     cartoon stamp naming the shame straight over the thumbnail; clean
 *     cards are dimmed to gray so the brainrot stands alone in the light.
 *     Every card stays in layout. Every impression beacon stays honest.
 *   - The parade has a diagnostic purpose. Everything that would have been
 *     nuked is highlighted and labeled with the rule that caught it, cards
 *     that only the lowered thresholds catch are marked as near-misses, and
 *     cards the ceiling would have spared are marked as lucky. This makes
 *     adjusting your filters to taste trivial, and less boring.
 *   - No stylesheet injection into the page. Animations run through the
 *     Web Animations API (element.animate — CSP-proof, never touches the
 *     style attribute, so watchForUnhide stays quiet). Cosmetic state is
 *     inline style properties, tracked and reverted on exit.
 *   - YouTube's DOM receives nothing random, ever. Self-owned overlays
 *     (confetti canvas, banner, parachuting emoji) are permitted: they are
 *     pointer-events:none, self-removing, and never touch YouTube's
 *     elements or fire its telemetry.
 *   - Session-only. Clown state does not persist. Nobody should wake up
 *     to a circus they don't remember hiring — the safety valve exists
 *     for the same reason.
 *   - No external assets. All audio is synthesized via Web Audio.
 */

const Clown = (() => {
    "use strict";

    const HOT_MINUTE_MS  = 600 * 1000;  // "a safety valve that automatically turns it off after a hot minute" — a hot minute is 10 minutes (a diagnostic session, not a gag reel)
    const CHAOS_TICK_MS  = 10 * 1000;   // "random chaos injection every 10 seconds while active"

    // Brainrot Parade near-miss thresholds (the old MAXIMUM CHAOS overrides,
    // demoted to a display tier: they no longer nuke anything, they mark what
    // ALMOST gets caught). Heuristic sensitivities only — CONFIG.nukeCeiling
    // is deliberately absent from this object and must never be added to it.
    const PARADE_THRESHOLDS = {
        capsThreshold:  0.4,   // normal 0.5 — a tight near-miss band, not "one capitalized word". 0.25 flagged ordinary titles (acronyms, "iPhone 15 Pro") that never neared the real cutoff.
        minTitleLength: 8,     // normal 10  — short titles lose a little immunity, but 6 was catching near-normal-length titles too
    };

    // Stamp text per heuristic — the shame, named in big fat letters.
    const STAMP_TEXT = {
        PHRASE:  "CLICKBAIT",
        SLOP:    "SLOP",
        CAPS:    "SHOUTING",
        DUPE:    "CHANNEL FLOODING",
        WATCHED: "ALREADY WATCHED",
    };

    let active = false;
    let parade = false;

    let safetyTimer  = null;
    let chaosTimer   = null;
    let activatedAt  = 0;

    let audioCtx = null;

    // HUD element references, registered by content.js when it builds the
    // HUD. Original cssText is snapshotted before skinning so exit restores
    // the sober look exactly.
    let hud = null;          // { container, header, mainTitle, countRow, logPipeDiv }
    let hudOriginal = null;  // { el → cssText } snapshots

    // Page-DOM cosmetic state, all reverted on exit. (The parade's stamp
    // map lives beside the parade code below.)
    const dimmed = new Set();  // containers with inline filter/opacity set

    let log = () => {};          // logToHUD, registered via setHooks

    // ======================== AUDIO (all synthesized) ========================
    function ctx() {
        if (!audioCtx) audioCtx = new AudioContext();
        if (audioCtx.state === "suspended") audioCtx.resume();
        return audioCtx;
    }

    function tone(freqFrom, freqTo, dur, type = "sine", gainPeak = 0.08, when = 0) {
        try {
            const ac  = ctx();
            const t0  = ac.currentTime + when;
            const osc = ac.createOscillator();
            const g   = ac.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freqFrom, t0);
            osc.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 1), t0 + dur);
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(gainPeak, t0 + dur * 0.15);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
            osc.connect(g).connect(ac.destination);
            osc.start(t0);
            osc.stop(t0 + dur + 0.05);
        } catch (e) { /* audio is garnish; never let it break filtering */ }
    }

    // Chrome mutes Web Audio in the page until the PAGE receives a user
    // gesture — a popup click does not count. on() arms a one-time unlock
    // so the first click/keypress on the page opens the pit orchestra.
    function armAudioUnlock() {
        const unlock = () => { try { ctx(); } catch (e) {} };
        window.addEventListener("pointerdown", unlock, { once: true, capture: true });
        window.addEventListener("keydown",     unlock, { once: true, capture: true });
    }

    const boing   = () => tone(340, 90, 0.35, "sine", 0.10);                    // the BOING
    function laugh() {                                                          // sine-sweep laugh track, no external audio files
        [0, 0.12, 0.26, 0.42].forEach((when, i) =>
            tone(520 - i * 60, 380 - i * 50, 0.11, "triangle", 0.05, when));
    }
    function fanfare() {                                                        // three ascending beeps
        [[523, 0], [659, 0.18], [784, 0.36]].forEach(([f, when]) =>
            tone(f, f, 0.16, "square", 0.06, when));
    }

    // ======================== CONFETTI ========================
    // One short-lived canvas per burst, fixed-position, pointer-events none,
    // removes itself when the last particle exits. Page layout untouched.
    const CONFETTI_COLORS = ["#ff4757", "#ffa502", "#2ed573", "#1e90ff", "#ff6b81", "#eccc68", "#ff7f50"];

    function confettiBurst(x, y, count = 36) {
        try {
            const canvas = document.createElement("canvas");
            canvas.width  = window.innerWidth;
            canvas.height = window.innerHeight;
            canvas.style.cssText =
                "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
            document.documentElement.appendChild(canvas);
            const c = canvas.getContext("2d");

            const parts = Array.from({ length: count }, () => ({
                x, y,
                vx: (Math.random() - 0.5) * 12,
                vy: -Math.random() * 11 - 3,
                w:  Math.random() * 7 + 4,
                h:  Math.random() * 4 + 2,
                rot: Math.random() * Math.PI,
                vr:  (Math.random() - 0.5) * 0.4,
                color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
            }));

            const t0 = performance.now();
            (function frame(t) {
                const elapsed = t - t0;
                c.clearRect(0, 0, canvas.width, canvas.height);
                let alive = false;
                for (const p of parts) {
                    p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
                    if (p.y < canvas.height + 20) alive = true;
                    c.save();
                    c.translate(p.x, p.y);
                    c.rotate(p.rot);
                    c.fillStyle = p.color;
                    c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                    c.restore();
                }
                if (alive && elapsed < 2500) requestAnimationFrame(frame);
                else canvas.remove();
            })(t0);
        } catch (e) { /* garnish */ }
    }

    // ======================== BANNER ========================
    // Big, DOM-based, deliberately unmissable. Belt to the confetti's braces:
    // if canvas painting ever fails, the banner still announces the circus.
    function banner(text) {
        try {
            const b = document.createElement("div");
            b.textContent = text;
            b.style.cssText = `
                position: fixed; top: 18%; left: 50%; z-index: 2147483646;
                transform: translateX(-50%);
                background: #d63384; color: #fff;
                border: 5px solid; padding: 18px 34px; border-radius: 16px;
                border-image: repeating-linear-gradient(45deg, #ff4757 0 10px, #fff 10px 20px) 5;
                font-family: 'Comic Sans MS', 'Comic Sans', cursive;
                font-size: 30px; font-weight: 900; letter-spacing: 1px;
                pointer-events: none; white-space: nowrap;
                box-shadow: 0 12px 40px rgba(0,0,0,0.6);
            `;
            document.documentElement.appendChild(b);
            b.animate([
                { transform: "translateX(-50%) translateY(-250%) rotate(-6deg)" },
                { transform: "translateX(-50%) translateY(12%)   rotate(3deg)", offset: 0.55 },
                { transform: "translateX(-50%) translateY(-4%)   rotate(-1deg)", offset: 0.75 },
                { transform: "translateX(-50%) translateY(0)     rotate(0deg)" },
            ], { duration: 900, easing: "ease-out" });
            setTimeout(() => {
                const out = b.animate(
                    [{ opacity: 1, transform: "translateX(-50%) scale(1)" },
                     { opacity: 0, transform: "translateX(-50%) scale(0.6) rotate(8deg)" }],
                    { duration: 400, easing: "ease-in" });
                out.onfinish = () => b.remove();
            }, 2600);
        } catch (e) { /* garnish */ }
    }

    // ======================== PARACHUTING EMOJI ========================
    // Chaos-tick page gag. Own overlay element, pointer-events none,
    // self-removing — YouTube's DOM is never touched.
    const PARACHUTISTS = ["🤡", "🎈", "🦆", "🍌", "🎪", "🤹", "🐘"];

    function parachute() {
        try {
            const d = document.createElement("div");
            d.textContent = PARACHUTISTS[Math.floor(Math.random() * PARACHUTISTS.length)];
            const x = 8 + Math.random() * 84;
            d.style.cssText = `
                position: fixed; top: -60px; left: ${x}vw; z-index: 2147483646;
                font-size: 42px; pointer-events: none;
            `;
            document.documentElement.appendChild(d);
            const fall = d.animate([
                { transform: "translateY(0) rotate(-8deg)" },
                { transform: `translateY(40vh) translateX(${Math.random() > 0.5 ? "" : "-"}30px) rotate(8deg)`, offset: 0.5 },
                { transform: "translateY(115vh) rotate(-6deg)" },
            ], { duration: 4200 + Math.random() * 1500, easing: "linear" });
            fall.onfinish = () => d.remove();
            fall.oncancel = () => d.remove();
        } catch (e) { /* garnish */ }
    }

    // ======================== NUKE PERFORMANCE ========================
    // "every nuke a performance": violent shake, rotation, confetti, BOING.
    // hide() is supplied by content.js and performs the real display:none.
    // Web Animations API only — the style attribute is never touched during
    // the performance, so watchForUnhide sees exactly one mutation: the hide.
    function performNuke(container, hide) {
        if (!active) { hide(); return; }
        try {
            const rect = container.getBoundingClientRect();
            confettiBurst(rect.left + rect.width / 2, rect.top + rect.height / 2, 30);
            boing();
            laugh();
            const anim = container.animate([
                { transform: "translateX(0) rotate(0deg)",      opacity: 1 },
                { transform: "translateX(-14px) rotate(-4deg)", opacity: 1,   offset: 0.15 },
                { transform: "translateX(12px) rotate(5deg)",   opacity: 0.9, offset: 0.3 },
                { transform: "translateX(-10px) rotate(-7deg)", opacity: 0.8, offset: 0.45 },
                { transform: "translateX(8px) rotate(10deg)",   opacity: 0.6, offset: 0.6 },
                { transform: "scale(0.7) rotate(25deg)",        opacity: 0.3, offset: 0.8 },
                { transform: "scale(0.05) rotate(60deg)",       opacity: 0 },
            ], { duration: 600, easing: "ease-in" });
            anim.onfinish = hide;
            anim.oncancel = hide;   // toggle-off mid-performance still hides
        } catch (e) {
            hide();                 // the show must not block the filter
        }
    }

    // ======================== THE BRAINROT PARADE ========================
    // MAXIMUM CHAOS and Reverse Polarity, merged into one diagnostic mode.
    // A card the heuristics catch is NOT hidden — see design constraints —
    // it stays in layout and gets a big fat cartoon stamp slammed over the
    // thumbnail naming the rule that caught it. Three display tiers:
    //   hit       — the real filters would kill this card (frame + stamp)
    //   near-miss — only the lowered PARADE_THRESHOLDS catch it ("barely
    //               survived": where threshold tuning lives)
    //   spared    — the filters caught it but the simulated nuke ceiling
    //               ran out ("got lucky")
    // Cards that pass everything are dimmed to gray so the brainrot stands
    // alone in the light. Each marker returns true only when newly applied,
    // so callers can log once instead of once per scan (WATCHED/DUPE
    // re-check cards every scan).

    const TIER_STYLE = {
        hit: {
            outline: "4px solid #eccc68",
            glow: "0 0 24px 6px rgba(236,204,104,0.55)",
            stamp: "background: rgba(180,20,40,0.92); color: #fff; border: 3px dashed #fff; font-size: 24px; padding: 6px 16px;",
            tilt: -8,
        },
        near: {
            outline: "3px dashed rgba(236,204,104,0.7)",
            glow: "none",
            stamp: "background: rgba(236,204,104,0.92); color: #1a1a1a; border: 2px dashed #1a1a1a; font-size: 13px; padding: 3px 10px;",
            tilt: 6,
        },
        spared: {
            outline: "3px solid #576574",
            glow: "none",
            stamp: "background: rgba(87,101,116,0.92); color: #fff; border: 2px solid #fff; font-size: 13px; padding: 3px 10px;",
            tilt: -4,
        },
    };

    const marked = new Map();  // container → { stampEl, tier }

    function mark(container, tier, text) {
        const prev = marked.get(container);
        if (prev) {
            // Dedup on the full stamp content, not tier alone. YouTube recycles
            // the same container element for new videos as you scroll; a recycled
            // card re-evaluated as a hit for a DIFFERENT heuristic keeps its tier
            // ("hit") but needs a new label — keying on tier alone left the old
            // occupant's stamp in place (right card, previous card's label). Also
            // re-apply if YouTube's re-render detached the old stamp element.
            if (prev.tier === tier && prev.text === text && prev.stampEl.isConnected) return false;
            prev.stampEl.remove();   // tier upgrade or recycled → new label
        }
        try {
            const style = TIER_STYLE[tier];
            container.style.setProperty("outline", style.outline, "important");
            container.style.setProperty("outline-offset", "3px", "important");
            container.style.setProperty("box-shadow", style.glow, "important");
            container.style.setProperty("position", "relative", "important");
            container.style.setProperty("z-index", "10", "important");
            container.style.removeProperty("filter");   // un-dim if a re-scan promoted it
            dimmed.delete(container);

            const stampEl = document.createElement("div");
            stampEl.textContent = text;
            stampEl.style.cssText = `
                position: absolute; top: 12%; left: 50%; z-index: 11;
                font-family: 'Comic Sans MS', 'Comic Sans', cursive;
                font-weight: 900; letter-spacing: 1px; white-space: nowrap;
                border-radius: 8px; pointer-events: none;
                transform: translateX(-50%) rotate(${style.tilt}deg);
                ${style.stamp}
            `;
            container.appendChild(stampEl);
            // The slam: the stamp arrives from above like a rubber stamp,
            // Web Animations API only — the style attribute is set once at
            // creation and never touched again.
            stampEl.animate([
                { transform: `translateX(-50%) rotate(${style.tilt}deg) scale(2.4)`, opacity: 0 },
                { transform: `translateX(-50%) rotate(${style.tilt}deg) scale(0.9)`, opacity: 1, offset: 0.7 },
                { transform: `translateX(-50%) rotate(${style.tilt}deg) scale(1)`,   opacity: 1 },
            ], { duration: 350, easing: "ease-in" });
            marked.set(container, { stampEl, tier, text });
            return true;
        } catch (e) { return false; }
    }

    const paradeHit      = (container, reason) => mark(container, "hit",    `🤡 ${STAMP_TEXT[reason] ?? reason}`);
    const paradeNearMiss = (container, reason) => mark(container, "near",   `😬 BARELY SURVIVED — ${STAMP_TEXT[reason] ?? reason}`);
    const paradeSpared   = (container, reason) => mark(container, "spared", `🍀 SPARED BY THE CEILING — ${STAMP_TEXT[reason] ?? reason}`);

    function dim(container) {
        if (dimmed.has(container) || marked.has(container)) return;
        try {
            container.style.setProperty("filter", "grayscale(1) brightness(0.45)", "important");
            container.style.setProperty("transition", "filter 0.4s", "important");
            dimmed.add(container);
        } catch (e) { /* garnish */ }
    }

    function clearParade() {
        for (const el of dimmed) {
            el.style.removeProperty("filter");
            el.style.removeProperty("transition");
        }
        dimmed.clear();
        for (const [el, m] of marked) {
            m.stampEl.remove();
            el.style.removeProperty("outline");
            el.style.removeProperty("outline-offset");
            el.style.removeProperty("box-shadow");
            el.style.removeProperty("position");
            el.style.removeProperty("z-index");
        }
        marked.clear();
    }

    // ======================== HUD CIRCUS TENT ========================
    function setHUD(refs) {
        hud = refs;
        hudOriginal = null;
        if (active) skinHUD();   // HUD created while the circus is already in town
    }

    let hudOriginalText = null;  // exact title/counter text, restored on exit

    function skinHUD() {
        if (!hud) return;
        if (!hudOriginal) {
            hudOriginal = new Map();
            for (const el of Object.values(hud)) hudOriginal.set(el, el.style.cssText);
            hudOriginalText = {
                title: hud.mainTitle.textContent,
                count: hud.countRow.firstChild.textContent,
            };
        }
        const comic = "font-family: 'Comic Sans MS', 'Comic Sans', cursive;";
        // Circus tent: striped border, hot pink, polka dots.
        hud.container.style.cssText += `
            background:
                radial-gradient(circle at 20% 30%, rgba(255,255,255,0.10) 0 6px, transparent 7px),
                radial-gradient(circle at 70% 60%, rgba(255,255,255,0.10) 0 5px, transparent 6px),
                radial-gradient(circle at 45% 85%, rgba(255,255,255,0.10) 0 7px, transparent 8px),
                #d63384;
            border: 6px solid;
            border-image: repeating-linear-gradient(45deg, #ff4757 0 12px, #fff 12px 24px) 6;
        `;
        hud.header.style.cssText   += "background: #b02a6f; border-bottom: 3px dashed #fff;";
        hud.mainTitle.style.cssText += `color: #fff; ${comic} font-size: 14px;`;
        hud.mainTitle.textContent   = `🎪 YOUTUBE CIRCUS ${hud.mainTitle.textContent.match(/v[\d.]+/)?.[0] ?? ""} 🤡`;
        hud.countRow.firstChild.textContent = "SENT TO THE CIRCUS: ";
        hud.countRow.style.cssText += `color: #ffe3f1; ${comic}`;
        hud.logPipeDiv.style.cssText += `background: #2a0a1e; ${comic} font-size: 12px;`;
    }

    function unskinHUD() {
        if (!hud || !hudOriginal) return;
        for (const [el, css] of hudOriginal) el.style.cssText = css;
        hud.mainTitle.textContent = hudOriginalText.title;
        hud.countRow.firstChild.textContent = hudOriginalText.count;
        hudOriginal = hudOriginalText = null;
    }

    // Emoji log levels for the HUD while the circus is up.
    const EMOJI_LEVELS = { INFO: "🎪", WARN: "😬", CRIT: "🔥" };
    function tagText(reason) {
        if (!active) return `[${reason}]`;
        return `[${EMOJI_LEVELS[reason] ?? "🤡"} ${reason}]`;
    }

    // ======================== CHAOS INJECTION ========================
    // Every 10 seconds, one small contained gag. HUD shadow root only —
    // the page DOM receives nothing random, ever (see design constraints).
    const CHAOS_LINES = [
        "🤡 honk.",
        "🎪 the tent holds.",
        "🦁 the lion is a rescue.",
        "🎠 the carousel only goes clockwise. nobody knows why.",
        "🍿 popcorn beacon rate: substantially honest.",
        "🤹 juggling five heuristics, dropping none.",
        "🐘 the elephant remembers every selector.",
        "🎈 99 luft-balloons deployed against the algorithm.",
    ];

    function chaosTick() {
        if (!active) return;
        try {
            parachute();   // page-visible chaos — the SPA is officially infested
            if (hud?.logPipeDiv) {
                const line = document.createElement("div");
                line.textContent = CHAOS_LINES[Math.floor(Math.random() * CHAOS_LINES.length)];
                line.style.cssText = "color:#ff9ff3;margin-bottom:5px;font-style:italic;";
                hud.logPipeDiv.prepend(line);
            }
            if (hud?.container) {
                hud.container.animate(
                    [{ transform: "rotate(0deg)" }, { transform: `rotate(${(Math.random() - 0.5) * 2.4}deg)` }, { transform: "rotate(0deg)" }],
                    { duration: 700, easing: "ease-in-out" });
            }
        } catch (e) { /* garnish */ }
    }

    // ======================== LIFECYCLE ========================
    function on() {
        if (active) return;
        active = true;
        activatedAt = Date.now();
        skinHUD();
        armAudioUnlock();
        fanfare();
        banner("🎪 THE CIRCUS IS IN TOWN 🤡");
        // Opening salvo: three staggered bursts across the viewport. If the
        // feed is fully normalized there may be no nukes to perform — the
        // activation itself must therefore be a show.
        const w = window.innerWidth, h = window.innerHeight;
        confettiBurst(w * 0.25, h * 0.3, 50);
        setTimeout(() => confettiBurst(w * 0.5,  h * 0.22, 60), 250);
        setTimeout(() => confettiBurst(w * 0.75, h * 0.3,  50), 500);
        log("INFO", `THE CIRCUS IS IN TOWN 🤡🎪 — safety valve armed (${HOT_MINUTE_MS / 60000}m)`);
        chaosTimer = setInterval(chaosTick, CHAOS_TICK_MS);
        setTimeout(() => { if (active) chaosTick(); }, 1500);   // first gag arrives promptly, not after a dead 10s
        safetyTimer = setTimeout(() => off("safety valve — the circus has left town on schedule 🎪"), HOT_MINUTE_MS);
    }

    function off(reasonMsg = "clown mode off") {
        if (!active) return;
        active = false;
        parade = false;
        clearTimeout(safetyTimer);
        clearInterval(chaosTimer);
        safetyTimer = chaosTimer = null;
        clearParade();
        unskinHUD();
        fanfare();
        banner("🎪 the circus has left town");
        log("INFO", reasonMsg);
    }

    function healFanfare() {
        if (!active) return;
        fanfare();
        confettiBurst(window.innerWidth / 2, window.innerHeight * 0.3, 50);
        log("INFO", "THE CIRCUS FIXED YOUTUBE AGAIN 🤡🎉");
    }

    // ======================== PUBLIC API ========================
    return {
        get active() { return active; },
        get parade() { return active && parade; },
        get state() {
            return {
                active,
                parade,
                secondsLeft: active ? Math.max(0, Math.round((HOT_MINUTE_MS - (Date.now() - activatedAt)) / 1000)) : 0,
            };
        },
        setHooks({ logToHUD }) { log = logToHUD; },
        setHUD,
        toggle()       { active ? off() : on(); return this.state; },
        toggleParade() {
            if (active) {
                parade = !parade;
                if (!parade) clearParade();
                log("INFO", parade ? "🧠 THE BRAINROT PARADE IS MARCHING — nothing hides, everything confesses" : "parade dismissed — normal filtering restored");
            }
            return this.state;
        },
        // Near-miss threshold overrides for the parade's second display
        // tier; null when the parade isn't marching. These never decide a
        // real nuke. nukeCeiling is not here and never will be.
        paradeThresholds() { return active && parade ? PARADE_THRESHOLDS : null; },
        performNuke,
        paradeHit,
        paradeNearMiss,
        paradeSpared,
        dim,
        tagText,
        healFanfare,
    };
})();
