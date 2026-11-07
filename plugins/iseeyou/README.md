# ISeeYou for Stream Deck

**Toggle ISeeYou** opens the inspector on one press and hides it on the next. **Hold to Show** displays a temporary preview. If the inspector was already open, it stays open when the preview ends. Both actions use the current Finder selection when available and keep Finder active.

Select a **Hold to Show** key in Stream Deck to set its **Minimum show time** from 0 to 5 seconds. A quick tap keeps the preview open for the chosen time. With the default of 0 seconds, the preview hides on release.

## Setup

1. Build and install ISeeYou with Stream Deck protocol 2. See the [ISeeYou app handoff](APP-HANDOFF.md) for the app changes.
2. Open the `.streamDeckPlugin` installer. In Stream Deck, drag **Toggle ISeeYou** and **Hold to Show** onto separate keys.
3. Allow Finder automation if macOS prompts you. If Finder access is unavailable, the buttons can still show the inspector using the app's existing content.

Requires macOS 13 or later and Stream Deck 7.1 or later. The plugin checks for the app's protocol marker and shows an alert if an older app is installed.

## Build

Run the [Elgato Stream Deck CLI](https://docs.elgato.com/streamdeck/cli/) from this directory.

```sh
streamdeck pack com.theoverloadstudio.iseeyou-finder.sdPlugin
```
