# Hilo Monitor for Stream Deck

Control the analog speaker level of a Lynx Hilo connected over USB. Hilo Remote can be closed. Add **Monitor Up** (green), **Monitor Down** (orange), and **Mute Monitor** (red) to three keys. The keys pulse while held. Mute toggles both Monitor Out channels. Monitor Up also clears the Monitor Out mute. When either key unmutes, the level fades in from the Hilo’s quietest analog level to the intended setting, capped at −30 dB.

| Monitor Out range | Tap step |
| --- | ---: |
| −71.5 to −30 dB | 6 dB |
| −30 to −20 dB | 2.5 dB |
| −20 to −10 dB | 1 dB |
| −10 to 0 dB | 0.5 dB |

A tap ramps to its target in verified 0.5 dB steps. It stops at a range boundary before continuing in the next range. One up tap from Off ends at −71.5 dB. One down tap from −71.5 dB fades to −95.5 dB and mutes both channels for Off.

Hold either volume key for continuous changes. Volume Down moves faster through the full range. Volume Up slows in the last 10 dB. Every half-decibel step is verified over USB. Release the key to stop repeating. Reversing direction or pressing Mute interrupts an active volume ramp and cancels pending changes from the previous direction.

If the Hilo stops answering over USB, the plugin stops the ramp and shows a warning on the key. Once the connection is back, press the key again to start from the level reported by the Hilo.

The optional **Monitor Volume Dial** uses the Stream Deck + encoder, with 0.5 dB per tick and a maximum of 5 dB per event. Upward turns above −10 dB are limited to 0.5 dB per event. The plugin reads the hardware level before adjusting it and caps increases at 0 dB.

Requires macOS 13 or later, Stream Deck 7.1 or later, and one connected Lynx Hilo USB. The hardware path was verified on an original Hilo. Install the `.streamDeckPlugin` file and drag the actions onto keys or an encoder.

To build, install the macOS Command Line Tools and Elgato Stream Deck CLI. Run these commands from this directory.

```sh
./build.sh
streamdeck pack com.theoverloadstudio.hilo-monitor.sdPlugin
```
