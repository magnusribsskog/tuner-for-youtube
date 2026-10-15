/*
 * Tuner for YouTube — Background Service Worker
 * =========================================
 *
 * Reserved for a future thematic layer (local title classification). Communicates with the content script via
 * chrome.runtime.onMessage.
 *
 * Message contract:
 *   Request:  { type: "CLASSIFY_TITLE", title: string }
 *   Response: { theme: string[], format: string[], cached: boolean }
 *
 * The content script treats a null or absent response identically to
 * { theme: [], format: [], cached: false } — the thematic layer is additive
 * and its absence must never affect filtering behaviour.
 *
 * Today this is a stub that returns empty labels; filtering never depends on it.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "CLASSIFY_TITLE") return false;
    console.log(`[YT-INTELLIGENCE] classify: "${message.title}"`);
    sendResponse({ theme: [], format: [], cached: false });
    return false;
});
