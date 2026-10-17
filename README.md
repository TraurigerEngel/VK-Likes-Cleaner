# VK Likes Cleaner

**v0.2.6 — Preview / test build (NOT a Stable Release).**

Chromium Manifest V3 extension for locally managing and removing **your own** reactions on VK (`vk.com`, `vk.ru`). The extension is unaffiliated with VK.

## Current state

- **v0.2.1**: small batches (1 or 3 reactions) confirmed by the user on real VK; three likes did not reappear after a page refresh.
- **v0.2.6 Preview**: 1,516 offline assertions passed. Real-world testing of this exact build, especially the unlimited mode and CAPTCHA handling, **has not been confirmed**. Do not label it Stable until verified.

## Features in v0.2.6 Preview

- Select a VK reactions category; preview or scan without removing anything.
- Limited batches of 1, 3, 10 or 25 attempts, with adjustable delays.
- Experimental `∞ · До конца выбранного раздела` mode with autoscroll, internal batches, pause/resume/stop, and an end-of-available-feed condition. **This does not guarantee clearing every historical VK reaction.**
- Explicitly stop when common VK CAPTCHA / `Я не робот` challenges are detected. **Does not solve or bypass CAPTCHAs, and must not resume automatically.** Some challenges may be missed. Stop when you see one.
- Show local progress and category counters. A status of `Вероятно снято` is **not** server-verified proof.

## Installing the Preview

1. Download the source ZIP or extension ZIP, unpack it into its own folder.
2. In a Chromium-based browser, open `chrome://extensions/` (or your browser's extension-management page), enable developer mode and load the folder containing `manifest.json` as an unpacked extension.
3. Disable older copies while testing, open `vk.ru` / `vk.com`, and refresh the VK tab.
4. Start with **1–3 reactions**, check the result manually on VK after refreshing, and stop on CAPTCHA or unexpected behavior.
5. Only test extended operation on your own account after validating short batches. There is no one-click undo.

**Important permission:** `debugger` has a broader browser capability than VK alone; the code limits its actions to VK tabs, but the granted browser permission is broader. Review the source and extension permissions before use.

## Test suite (Node.js)

```bash
node --check background.js
node --check content.js
node --check dashboard.js
node tests/test-background.js
node tests/test-content.js
node tests/test-dashboard.js
```

There are no external JavaScript dependencies. Chromium is required to test the browser integration. All HTML/CSS/JS in the extension is local; no extra domains beyond `vk.com` and `vk.ru` are requested.

## Privacy, limits and rights

No VK credentials, authentication tokens, personal reaction reports, cookies, user profiles or live session data are distributed with these source files. The extension stores its own progress data locally in the browser profile. The project is not affiliated with or endorsed by VK, and usage may be subject to VK's platform terms and rate limits.

Author-owned code: [MIT License](LICENSE). The "VK" and "ВКонтакте" names are trademarks of their respective owner; this licence does not grant rights to those trademarks.

See [SECURITY_PRIVACY_RU.md](SECURITY_PRIVACY_RU.md) and the original detailed [README.txt](README.txt).
