# Prompt for the ISeeYou app repository

Update the macOS ISeeYou app in `theoverloadstudio/ISeeYou` to support Stream Deck protocol 2. The matching plugin lives in `theoverloadstudio/StreamDeckPlugins` under `plugins/iseeyou`. Make the app changes, build an installable ZIP, and verify both actions end to end.

- **Toggle ISeeYou** flips the inspector's persistent visibility on each press. If the inspector is already visible, hide it. When opening, show the selected Finder files sent by the plugin. With an empty selection, show the last report or the app's normal empty inspector.
- **Hold to Show** shows the inspector while the key is down. On release, hide the temporary view and restore the previous persistent visibility. Keep the persistent view open if it was already open. A short press released before the app handles the command must not leave a window behind.
- Both actions must leave Finder as the frontmost app. Use a nonactivating AppKit panel and show it without making it key or activating ISeeYou. Support multiple selected files through the existing picker. Preserve the normal Finder service, menu bar, and direct file-opening behavior.

The plugin sends command documents to bundle ID `com.theoverloadstudio.iseeyou` using `/usr/bin/open -g -b`. Intercept these in the app's document-opening path before media inspection. Use this exact contract:

- The command directory is `~/Library/Caches/com.theoverloadstudio.iseeyou/`.
- The toggle filename is `stream-deck-toggle-<UUID>.json`. Each file represents one press. Process it at most once and remove it after handling. Recognize duplicate, missing, or expired command documents as commands and ignore them safely. Keep rapid presses ordered.
- The hold filename is `stream-deck-preview.json`. The plugin writes the file atomically on key-down, renews it every five seconds, and removes it on key-up, key removal, or disconnect. While a hold is active, check about every 100 ms. End the temporary view if the file disappears, expires, or becomes invalid. A newer valid hold token replaces the older hold.
- Both files contain `{"token":"<UUID>","files":["/absolute/path.wav"],"expiresAt":<Unix time in milliseconds>}`. Accept `files: []` as a request to use the app's existing content. Validate the command directory, filename, and payload. For a toggle, the filename UUID must equal the payload token. Treat missing or expired requests as no-ops, including on cold launch. Keep command documents out of the recent media list where possible.
- Add an integer Info.plist key named `ISeeYouStreamDeckProtocol` with value `2` to the built app. Bump the app version to 1.5 or later. Keep the existing bundle ID so the plugin can discover the update.

Verify cold launch with Finder active, two quick toggle presses, hold and release, release before cold launch completes, device disconnect, multiple selections, and hold while the toggle window is already open. Verify on macOS that Finder still receives keyboard input. Include the test results and the updated app ZIP.
