# Magpie

**Ask about anything you're reading, without leaving the page.**

Select text in any app, click **Ask Magpie** (or press a shortcut), and a small floating window explains it. Your page doesn't move, your chat doesn't scroll, and nothing is lost. Every question is logged, and answers you want to keep become linked notes in an Obsidian-style vault.

Magpie works over any window: a browser tab, a PDF, a chat with an AI, a code editor. It is not tied to one AI. Bring Claude Code, Gemini, Codex, any API key, or a local model.

> Windows 10 and 11 (64-bit). Free and open source (MIT).

## Why

You ask an AI something. It writes a big answer full of words you don't know. If you ask about one of those words in the same chat, the answer pushes the page you were reading out of view. Magpie takes the side question out of that conversation entirely.

## Install

1. Download `Magpie-Setup-<version>.exe` from the [latest release](https://github.com/rudranshnareda/Magpie/releases/latest).
2. Run it. It installs for your user only and needs no admin rights.
3. Open **Settings** and choose your AI engine (see below).

The installer is not code-signed, so Windows SmartScreen may say "Windows protected your PC". Choose **More info**, then **Run anyway**. You can verify the download against the SHA-256 listed in the release notes.

## Using it

There are two ways to ask.

**1. Select text, click the button.** Highlight text in any app. A small **Ask Magpie** button appears next to your cursor. Click it and a prompt box opens with your selection attached. Press **Return** to have it explained, or type a more specific question about it first.

**2. Press the shortcut** (default `Ctrl + Alt + R`, changeable in Settings). A bare prompt box appears, Spotlight style. Type a question and press **Return**. If you had text selected, it is attached automatically.

In the answer, terms the AI thinks you may not know are highlighted in blue. Click one to **dig deeper**: a child window opens for that term and remembers where you came from.

| Key | Action |
| --- | --- |
| `Return` | Ask (or explain the selection) |
| `Esc` | Close the window |
| Shortcut again | Close an unused prompt |
| Click away | Closes a prompt you haven't asked yet. An answered window stays until you close it |

You can drag the window by its top grip or any empty area.

## What it remembers

Everything you ask appears in the **History** tab: searchable, grouped by day, with the full answer. In **Settings** you choose exactly what is stored, each with its own switch:

- Keep a history at all (master switch)
- The text you selected
- The application name (for example `chrome`, `Acrobat`)
- The window title (tab title or document name)
- A screenshot taken at the moment you ask: off, active window, or whole screen

## Notes vault

Press **Save** on an answer and it becomes a markdown note in your vault folder (default `~/Magpie-Vault`; point it at an Obsidian vault in Settings):

```markdown
---
parent: "[[what is an ASIC]]"
created: 2026-11-07T10:16:10.070Z
tags: [magpie]
---
# photolithography

...the answer...

## Dig deeper
- [[mask]]
- [[wafer]]
```

Dig-deeper notes link back to their parent, so your rabbit hole becomes a tree you can open in Obsidian's graph view. Terms you have already saved are passed to the AI as "already known", so later explanations don't repeat them.

## Choose your AI engine

Settings → **AI engine**. Pick a provider, type any model name it supports, and press **Test** to time a tiny request.

| Provider | What you need | Status |
| --- | --- | --- |
| Claude Code | [Claude Code](https://claude.com/claude-code) installed and signed in | Tested |
| OpenAI-compatible (OpenAI, OpenRouter, Groq, others) | API key (and server address for "other") | Tested against a mock server |
| Ollama, LM Studio (local) | The server running | Tested against a mock server |
| Custom command | Any program that reads the prompt on stdin and prints the answer | Tested |
| Anthropic API | API key | Implemented to the documented API, not yet tested live |
| Google Gemini API | API key | Implemented to the documented API, not yet tested live |
| Gemini CLI, Codex CLI | The CLI installed and signed in | Implemented, not yet tested live |

If you try one of the untested providers, please open an issue and say whether it worked.

**Speed.** Claude Code takes a few seconds to start, and Magpie starts it the moment you open the prompt so it is ready by the time you press Return. Direct API providers (Groq, Gemini Flash, Anthropic API) and local models avoid that start-up and are usually quicker and steadier.

**API keys** are stored encrypted with Windows DPAPI and are never shown again after you save them.

## Privacy

- Your history, settings and screenshots stay on your PC in `%APPDATA%\Magpie`.
- Screenshots are never sent anywhere.
- To answer, Magpie sends your chosen AI engine your question, the selected text, and only the app name and window title you have switched on. Nothing else.
- There is no Magpie server, account, analytics or telemetry.

## How it works

- A global shortcut and a low-level mouse listener ([uiohook-napi](https://github.com/SnosMe/uiohook-napi)) detect the shortcut and text selections.
- To read a selection, Magpie briefly sends `Ctrl + C` to the focused app and then restores your clipboard. It never does this in terminal windows, where `Ctrl + C` would interrupt a running command.
- On Windows 11 the windows use the system's Mica and Acrylic materials. On Windows 10 they use a solid colour that matches your theme.
- Right Alt on keyboards with an AltGr key is treated as plain Alt, so shortcuts like `Alt + M` work with either Alt key.

## Build from source

Requires Node.js 20 or newer.

```bash
git clone https://github.com/rudranshnareda/Magpie.git
cd Magpie
npm install
npm start
```

To build the Windows installer:

```bash
npm run dist
```

The installer appears in `dist/`. No Visual Studio is needed, because the one native module ships prebuilt binaries.

Project layout:

```
src/main.js        windows, shortcut, selection button, IPC
src/engine.js      talks to the chosen AI backend
src/providers.js   the list of supported providers
src/store.js       settings, history, encrypted keys
src/sysinfo.js     focused app, selection capture, screenshots
src/vault.js       saves linked markdown notes
src/ui/            the popup, the app window, the shared theme
```

## Limitations

- Windows only for now. The helper that reads the focused window is PowerShell-based.
- The installer is unsigned.
- The "Ask Magpie" button appears after any drag or double-click, so it can also appear when you drag a window or a file. It disappears on its own after a few seconds.
- Some apps don't support being asked to copy their selection, in which case the prompt opens without it.

## Troubleshooting

- **The shortcut won't register.** Another app owns it, or Windows reserves it. On keyboards with AltGr, `Ctrl + Alt + letter` is how special characters are typed and is not available. Pick another combination, for example `Alt + M`.
- **"Claude Code was not found".** Install it and run `claude` once to sign in, or choose a different provider.
- **Nothing happens on first Return.** Open Settings and press **Test** to see the error from your provider.

## License

MIT. See [LICENSE](LICENSE).
