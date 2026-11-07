# ISeeYou for Stream Deck

Inspect selected Finder files with a Stream Deck key. **Hold to Inspect** shows the selection while the key is held and keeps Finder active. Release to hide the panel. The panel includes a picker when you select multiple files. **Inspect Finder Selection** opens the regular ISeeYou inspector.

## Setup

1. Install [ISeeYou](https://github.com/theoverloadstudio/ISeeYou) and open it once. **Hold to Inspect** requires ISeeYou 1.4 or later. The plugin requires the macOS app with bundle identifier `com.theoverloadstudio.iseeyou`.
2. Open the `.streamDeckPlugin` installer. In Stream Deck, drag **ISeeYou → Hold to Inspect** onto a key.
3. Select files in Finder and hold the key to inspect them. macOS may ask whether Stream Deck can control Finder. Allow that request so the plugin can read the selection.

Requires macOS 13 or later and Stream Deck 7.1 or later. If the key shows an alert, check that files are selected, ISeeYou is installed, and Finder access is enabled in **System Settings → Privacy & Security → Automation**.

## Build

From this directory, use the [Elgato Stream Deck CLI](https://docs.elgato.com/streamdeck/cli/):

```sh
streamdeck pack com.theoverloadstudio.iseeyou-finder.sdPlugin
```
