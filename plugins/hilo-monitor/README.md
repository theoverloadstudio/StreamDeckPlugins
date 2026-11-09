# Hilo Monitor for Stream Deck

Control the analog speaker level of a Lynx Hilo connected over USB. Hilo Remote can be closed. Add **Monitor Up** (green), **Monitor Down** (orange), and **Mute Monitor** (red). The keys pulse while held. Mute toggles both Monitor Out channels. Unmute fades back to the analog level shown before unmuting; pressing Mute again during the fade re-mutes and restores that setting. A new Up tap while muted restores that level; from Off, it brings the monitors up to the first usable step. Holding Up while muted keeps the monitors muted.

Add **Dim Monitor** to a fourth key. It fades the two Monitor Out digital channels down by 15 dB and lights the key. Press it again to fade back. The analog volume and mute stay independent, so you can change volume while dimmed and still return to the corresponding undimmed level. If the digital channels are already close to their minimum, Dim uses the available headroom equally on both channels. If another control changes the digital levels while Dim is on, the key will warn on the next press and will not restore the old level.

| Monitor Out range | Tap step |
| --- | ---: |
| −71.5 to −30 dB | 6 dB |
| −30 to −20 dB | 2.5 dB |
| −20 to −10 dB | 1 dB |
| −10 to 0 dB | 0.5 dB |

A tap ramps to its target in verified 0.5 dB steps. It stops at a range boundary before continuing in the next range. One up tap from Off ends at −71.5 dB. One down tap from −71.5 dB fades to −95.5 dB and mutes both channels for Off.

Hold either volume key for continuous changes. The hold starts after about a fifth of a second; a shorter press sends one tap step on release. Volume Down moves faster through the full range. Volume Up slows in the last 10 dB. Every half-decibel step is verified over USB. Releasing a hold cancels the ramp, so no further steps are sent. A hold also times out after 3.5 seconds if the release event is missed. Reversing direction or pressing Mute cancels earlier volume input.

If the Hilo stops answering over USB, the plugin stops the ramp and shows a warning on the key. Once the connection is back, press the key again to start from the level reported by the Hilo.

The optional **Monitor Volume Dial** uses the Stream Deck + encoder, with 0.5 dB per tick and a maximum of 5 dB per event. Upward turns above −10 dB are limited to 0.5 dB per event. The plugin reads the hardware level before adjusting it and caps increases at 0 dB.

Requires macOS 13 or later, Stream Deck 7.1 or later, and one connected Lynx Hilo USB. The hardware path was verified on an original Hilo. Install the `.streamDeckPlugin` file and drag the actions onto keys or an encoder.

To build, install the macOS Command Line Tools and Elgato Stream Deck CLI. Run these commands from this directory.

```sh
./build.sh
streamdeck pack com.theoverloadstudio.hilo-monitor.sdPlugin
```
