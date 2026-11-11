# Headless Viewer

A lightweight, frameless media viewer for the web, built on Electron. It opens a URL in a clean window with no browser UI at all and stretches the image or video to fill the window. Works on Windows, macOS and Linux.

## Running from the repository

You need [Node.js](https://nodejs.org/) 20 or newer (the LTS installer is enough, `npm` comes with it) and [Git](https://git-scm.com/).

```bash
git clone https://github.com/martinnovak22/headless-viewer.git
cd headless-viewer
npm install
npm start
```

The steps are the same on every system. On Windows, run the commands in PowerShell or Command Prompt. The first `npm install` downloads Electron (roughly 100–250 MB), so it takes a while.

## Building a standalone app

Build on the system you are targeting: the Windows build on Windows, the macOS build on a Mac.

| Command | Output in `dist/` |
| --- | --- |
| `npm run dist:win` | portable `.exe` (no installation) and a `-setup.exe` installer |
| `npm run dist:mac` | `.dmg` and `.zip` |
| `npm run dist` | build for the system you run the command on |

The app is not code-signed, so Windows (SmartScreen) and macOS (Gatekeeper) show a warning on first launch that you have to confirm.

## Controls

After launch, type a URL and press `Enter` (a missing `https://` is added for you), or use the **Paste & Go** button. Move the window by dragging the invisible strip along its top edge.

| Shortcut | Action |
| --- | --- |
| `Esc` or `Ctrl+L` | show/hide the menu with the URL field and the fullscreen and close-window buttons |
| `F`, `F11` or double-click | fullscreen |
| `C` | fit / fill (`object-fit: contain` / `cover`) |
| `B` or `Ctrl+B` | browse mode / media mode |
| `R` or `Ctrl+R` | reload |
| `Alt+←` / `Alt+→` | back / forward in history |
| `Ctrl+Q` or `Alt+F4` | quit |

On macOS, `Cmd` works in place of `Ctrl`. Single-letter shortcuts do not fire while you are typing in a text field on the page.

## Signing in to websites

Cookies and logins are stored persistently, so you stay signed in after restarting the app.

In media mode the app modifies the page (hides scrollbars, stretches the main video or image), which breaks login forms and normal browsing. So:

1. Press `B` – the page is shown as it normally would be.
2. Sign in and find the image or video.
3. Press `B` again – the media is stretched to fill the window.

Signing in with Google may not work; Google often blocks it in embedded browsers.

## Project structure

| File | Purpose |
| --- | --- |
| `main.js` | main process: window, shortcuts, CSS and JS injected into pages |
| `index.html`, `renderer.js` | home screen and the menu with the URL field |
| `preload.js` | bridge between the UI window and the main process |
| `webview-preload.js` | single-letter shortcuts and double-click inside the loaded page |

## Known limitations

- The top 28 px of the window are used for dragging and do not pass clicks through to the page (disabled in fullscreen). Double-clicking this strip maximizes the window.
- On a regular page, the largest `<video>` is stretched, or the only `<img>` if there is exactly one. If the page has several images, open a direct link to the file.
- When loading some videos, Electron prints a `GUEST_VIEW_MANAGER_CALL … ERR_FAILED` message to the terminal. It does not affect playback.
