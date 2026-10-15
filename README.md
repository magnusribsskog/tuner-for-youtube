# Tuner for YouTube

> ## ⚠️ This may cost you infinite scroll
>
> **Read this before installing.** Hiding videos from the YouTube homepage can
> make YouTube decide your account is behaving like a bot. When an earlier,
> more aggressive version of this extension ran on the developer's account,
> **YouTube removed infinite scroll from that account**: the homepage stopped
> loading more videos.
>
> Tuner now never hides more than **30% of any batch** of videos, so most of
> what YouTube sends you is still shown and counted as seen. In our testing the
> feed keeps loading. But we are **still finding out where the safe limit is**,
> and we can only learn it through use, over days, on real accounts.
>
> And even if we find it, **YouTube can change its rules at any time without
> telling anyone.** A setting that is safe today may not be safe next month.
> There will always be some chance that using Tuner costs an account its
> infinite scroll, at least for a while.
>
> If that risk is not acceptable for your account, don't install it.

---

Tuner makes the YouTube homepage less exhausting. It quietly removes the
videos most likely to be low-effort clickbait, so what's left is easier to
choose from. It does not try to replace YouTube's recommendations, only to
take the worst of them off the table.

It works on the **homepage only**. Search results, channel pages and the
sidebar beside a video are left alone: there, you've already said what you
want.

## What it filters

| Filter | What it catches |
|---|---|
| **PHRASE** | Clickbait words in titles (`INSANE`, `GONE WRONG`, `BREAKS REALITY`…), plus any phrases you add yourself |
| **SLOP** | Titles with missing apostrophes (`dont`, `im`, `wont`…) or punctuation stacked up like `!!!` and `??` |
| **CAPS** | Titles that are more than half capital letters |
| **DUPE** | Channel flooding: only one video per channel per batch |
| **WATCHED** | Videos you've already watched more than 90% of |

Each filter can be switched off in the popup for the current session. The
popup counts what was removed; the in-page log shows each title and the rule
that caught it.

## The 30% ceiling

However many videos match, Tuner never hides more than 30% of what YouTube
delivers in one batch. Matches beyond that are spared and logged as such
(🍀 *spared by the ceiling*). This is deliberate: YouTube counts videos as seen
when they appear on screen, and a page where most videos vanish unseen looks
like a scraper to it. The ceiling keeps Tuner's footprint close to a person
scrolling past things they don't want. It is not adjustable.

## It repairs itself

YouTube changes its page structure often, and runs different layouts for
different users at the same time. Tuner doesn't rely on fixed names for the
parts of the page. It learns them.

- **On first run** on a fresh install, it surveys your homepage to learn what a
  video card looks like *for your account*. If it can't learn the shape
  safely, it says so loudly with a red banner rather than guessing, and offers
  a **Save DOM snapshot** button so you can send us the page that confused it.
- **Afterwards**, if YouTube changes its layout under it, Tuner notices that
  its filters stopped matching, finds the videos again from titles it already
  knows, and records the correction locally.

## Diagnostics

The in-page log (open it from the popup) shows each decision as it happens.
Two buttons there save files, **only when you click them**:

- **✱** exports a short session report: counts per filter and the titles that
  were removed.
- **📸** saves a snapshot of the current page.

These are the most useful things to attach to a bug report. Tuner never
downloads anything on its own.

## Clown mode 🤡

Two switches in the popup, both for fun and both safe. The parade only runs
while the clowns are in:

- **Send in the clowns** makes every removal a small performance, with a
  synthesized laugh track and confetti. Filtering itself is unchanged.
- **The Brainrot Parade** hides *nothing*. For a while, every video the
  filters would remove stays on screen with a cartoon stamp naming the rule
  that caught it, near-misses are marked, videos the ceiling would have spared
  are marked as lucky, and everything clean dims to grey. It's the easiest way
  to see what the filters are thinking.

Neither touches the 30% ceiling. Clown mode is session-only and switches
itself off after ten minutes, taking the parade with it.

## Install

Not yet in the Chrome Web Store.

1. Download the latest release, or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension` folder.
4. Open the YouTube homepage and give the feed a moment to load.

## Privacy

Tuner has no server, no analytics and no network access of its own. It reads
the YouTube homepage, hides some cards, and stores only your settings, your
phrase list and its learned page structure in your browser. Diagnostic files
are saved only when you click for them, and stay on your machine.

## Contributing

Bug reports and session reports are very welcome. We can't accept pull
requests for now: this is dual-licensed, and outside code would need a
contributor agreement we don't yet have.

## Not affiliated with YouTube

Tuner for YouTube is an independent project. It is not made, endorsed or
supported by YouTube or Google. YouTube is a trademark of Google LLC.

## Licence

Free for personal use, hobby projects, research, education and nonprofits,
and for commercial use by organisations of up to 10 people. Larger
organisations need a commercial licence: contact **magnus.ribsskog@gmail.com**.

The full terms are in [LICENSE](LICENSE): the PolyForm Noncommercial License
1.0.0, plus the small-organisation permission stated at its top.

## Credits

Made by Magnus Ribsskog, with Florence: a persistent, multimodal AI running on
Claude.
