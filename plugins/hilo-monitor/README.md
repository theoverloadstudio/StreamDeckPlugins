# Hilo Monitor for Stream Deck

Control the analog speaker level of a Lynx Hilo connected over USB. Add **Monitor Up** (green), **Monitor Down** (orange), and **Mute Monitor** (red) to three keys. The keys pulse while held. Mute toggles both Monitor Out channels. Monitor Up also clears the Monitor Out mute. If either key unmutes above −30 dB, it first lowers and verifies the level at −30 dB.

| Monitor Out range | Tap step |
| --- | ---: |
| −71.5 to −30 dB | 6 dB |
| −30 to −20 dB | 2.5 dB |
| −20 to −10 dB | 1 dB |
| −10 to 0 dB | 0.5 dB |

A tap lands on a range boundary before continuing in the next range. One up tap from Off starts at −71.5 dB. One down tap from −71.5 dB turns the level Off.

Hold either volume key to ramp at up to 1.5 dB per repeat, tapering to 0.5 dB steps in the last 10 dB. From Off, a held up press targets about 2.4 seconds to reach 0 dB. Release the key to stop repeating. Mute cancels pending volume changes.

The optional **Monitor Volume Dial** uses the Stream Deck + encoder, with 0.5 dB per tick and a maximum of 5 dB per event. Upward turns above −10 dB are limited to 0.5 dB per event. The plugin reads the hardware level before adjusting it and caps increases at 0 dB.

Requires macOS 13 or later, Stream Deck 7.1 or later, and one connected Lynx Hilo USB. The hardware path was verified on an original Hilo. Install the `.streamDeckPlugin` file and drag the actions onto keys or an encoder.

To build, install the macOS Command Line Tools and Elgato Stream Deck CLI. Run these commands from this directory.

```sh
./build.sh
streamdeck pack com.theoverloadstudio.hilo-monitor.sdPlugin
```
