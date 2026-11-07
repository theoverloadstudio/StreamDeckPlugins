# ISeeYou for Stream Deck

Inspect selected Finder files in ISeeYou with one key press. Select multiple files to send them to the inspector together.

## Setup

1. Install [ISeeYou](https://github.com/theoverloadstudio/ISeeYou) and open it once. The plugin requires the macOS app with bundle identifier `com.theoverloadstudio.iseeyou`.
2. Open the `.streamDeckPlugin` installer. In Stream Deck, drag **ISeeYou → Inspect Finder Selection** onto a key.
3. Select files in Finder and press the key. macOS may ask whether Stream Deck can control Finder. Allow that request so the plugin can read the selection.

Requires macOS 13 or later and Stream Deck 7.1 or later. If the key shows an alert, check that files are selected, ISeeYou is installed, and Finder access is enabled in **System Settings → Privacy & Security → Automation**.

## Build

From this directory, use the [Elgato Stream Deck CLI](https://docs.elgato.com/streamdeck/cli/):

```sh
streamdeck pack com.theoverloadstudio.iseeyou-finder.sdPlugin
```
