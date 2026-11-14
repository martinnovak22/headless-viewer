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
| `Esc` or `Ctrl+L` | show/hide the menu with the URL field and the fullscreen, new-window and close-window buttons |
| `F`, `F11` or double-click | fullscreen |
| `C` | fit / fill (`object-fit: contain` / `cover`) |
| `B` or `Ctrl+B` | browse mode / media mode |
| `A` | ad blocking on / off (reloads the page) |
| `Space` or `K` | play / pause |
| `←` / `→` | seek 5 s back / forward |
| `↑` / `↓` | volume up / down |
| `M` | mute / unmute |
| `R` or `Ctrl+R` | reload |
| `Ctrl+N` | open another viewer window |
| `Ctrl+Alt+1` … `Ctrl+Alt+9` | arrange all windows into layout 1–9 (see [Layouts](#layouts)) |
| `Ctrl+Alt+L` | lock / unlock the layout |
| `Ctrl+Shift+H` | pause everything and minimize all windows; press again to restore and resume |
| `Alt+←` / `Alt+→`, mouse side buttons, two-finger swipe | back / forward in history (on macOS also `Cmd+[` / `Cmd+]`) |
| `Ctrl+Q` | quit the app (all windows) |
| `Alt+F4` | close the current window |

On macOS, `Cmd` works in place of `Ctrl`. `Ctrl+Shift+H` is a global shortcut: it works even when the viewer is in the background, and while the viewer is running it takes that combination away from other apps. Restoring any one window from the Dock or taskbar brings back all of them and resumes playback. Single-letter shortcuts do not fire while you are typing in a text field on the page. The playback keys are taken over only in media mode and only when the viewer has found a video; otherwise the page keeps its own keyboard behaviour.

## Context menu

Right-clicking the loaded page opens a menu in three sections, showing only what applies to the spot you clicked:

- **Open** – the link, image, video, embedded frame (e.g. a player on someone else's page) or the page itself, in a new viewer window or in your default browser. Opening an image in a new window shows it on its own, without the page around it.
- **Copy** – selected text, link text, and the address of each of the above. In a text field it offers Cut, Copy, Paste and Select all instead.
- **Inspect element** – opens the developer tools on the clicked element, for anything the menu cannot see, such as images set as a CSS background or hidden under an overlay.

Videos streamed through a `blob:` address cannot be opened or copied by address; use the frame or page instead.

## Layouts

**Layouts** in the menu (`Esc`) shows the window layouts. Clicking one, or pressing `Ctrl+Alt+` and its number, arranges all viewer windows into its zones on the display of the current window. The current window takes zone 1 (highlighted); the others keep their zones from the previous layout, so applying a layout again does not shuffle them. Empty zones get new windows, and windows beyond the number of zones stay where they are.

The default layouts are *Center + corners* (one large window in the middle, two small ones on each side), halves, thirds, a 2×2 grid and one main window with two on the side. **New layout** opens a grid editor: set the columns and rows, drag across cells to add a zone, click a zone to remove it. Existing layouts can be edited (✎) or deleted (×), and **Restore defaults** brings back the original set. Windows in a layout touch edge to edge, with no gaps. Layouts are saved in `settings.json`, up to nine.

**Lock layout** (`Ctrl+Alt+L`) stops every window from being moved or resized by hand. Fullscreen, minimizing, stashing and applying another layout keep working.

## Pages with their own player

You do not need a direct link to the video file. Many sites stream through `blob:` addresses, which only work inside the page that created them, so paste the address of the page itself. In media mode the viewer then:

1. Looks for a visible `<video>` on the page and stretches the largest one.
2. If the page has none, looks inside embedded frames (players hosted on another domain) and stretches the frame together with its video.
3. If there is still no video, stretches the image when the page has exactly one.
4. Otherwise leaves the page as it is.

The stretched video covers the site's own player buttons, so the viewer turns on the browser's native video controls and adds the playback shortcuts above. Both are undone in browse mode.

## Ad blocking

Ads and pre-roll ad requests are blocked with [`@ghostery/adblocker-electron`](https://github.com/ghostery/adblocker) (EasyList-based filters). The filter engine is downloaded on first start and cached, so later starts work offline. If it cannot be loaded, the viewer runs without blocking.

Press `A` to turn blocking off for sites that refuse to play with a blocker; the choice is remembered. Ads stitched into the video stream itself (YouTube, Twitch) are not reliably removed.

## Signing in to websites

Cookies and logins are stored persistently, so you stay signed in after restarting the app. All viewer windows share the same login.

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
- If a page has several images and no video, nothing is stretched; open a direct link to the file.
- A page whose only video is an advertisement gets that advertisement stretched. Ad blocking usually prevents this.
- DRM-protected services (Netflix and similar) do not play in a stock Electron build.
- When loading some videos, Electron prints a `GUEST_VIEW_MANAGER_CALL … ERR_FAILED` message to the terminal. It does not affect playback.
