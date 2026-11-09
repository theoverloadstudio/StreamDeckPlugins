# Hilo Monitor for Stream Deck

Control the analog speaker level of a Lynx Hilo connected over USB. Hilo Remote can be closed. Add **Monitor Up** (green), **Monitor Down** (orange), and **Mute Monitor** (red when muted). Both volume keys show the current analog fader position, including during a ramp. The keys pulse while held. Mute shows **LIVE** or **MUTED** based on the hardware, including changes made from the Hilo itself. Mute and Unmute toggle both Monitor Out channels without moving the analog volume. A new Up tap while muted also unmutes without changing the level; holding Up while muted keeps the monitors muted.

Add **Dim Monitor** to a fourth key. It displays the live analog Monitor Out setting in dB, the same level the Hilo shows in Analog mode. Press it to fade both Monitor Out digital channels down by 15 dB and light the amber indicator; press again to fade back. The displayed number remains the analog setting while Dim is active. If the digital channels are already close to their minimum, Dim uses the available headroom equally on both channels. If another control changes the digital levels while Dim is on, the key will warn on the next press and will not restore the old level.

Add **Mono Monitor** to average the existing Monitor Out mix into the left speaker and silence the right. Press again to restore the exact stereo mix. Mono leaves the analog volume, output mute, and the separate Dim control in place. Select the key in Stream Deck to set extra mono attenuation from 0 to 24 dB; it defaults to 6 dB and takes effect the next time Mono is enabled. If the routing is changed elsewhere while Mono is on, the plugin preserves the saved stereo mix and warns instead of overwriting those changes.

Single taps use the same series of stops in both directions. Spacing gradually grows from 0.5 dB near unity to as much as 3 dB at quiet levels. A tap from a level between stops goes to the next stop. Quick taps in the same direction move farther, up to 5.5 dB per tap at quiet levels and 1 dB per tap in the top 10 dB. Pausing or reversing direction resets the acceleration. Each change is still a ramp in verified 0.5 dB steps. A busy connection retains only a short, bounded batch of taps; old inputs expire rather than replaying later.

An Up tap from Off unmutes at the current level. A subsequent Up tap brings the level to −71.5 dB. A Down tap at −71.5 dB fades to −95.5 dB and mutes both channels for Off.

Hold either volume key for a continuous ramp that starts gently and accelerates. Held Up runs at twice its previous pace and still slows as it approaches 0 dB. The hold starts after about a fifth of a second; a shorter press sends one tap step on release. Every half-decibel step is verified over USB, so a slow connection may extend the sweep. Releasing a hold cancels the ramp, so no further steps are sent. A hold also times out after 3.5 seconds if the release event is missed. Reversing direction or pressing Mute cancels earlier volume input.

If the Hilo stops answering over USB, the plugin stops the ramp and shows a warning on the key. Once the connection is back, press the key again to start from the level reported by the Hilo.

The optional **Monitor Volume Dial** uses the Stream Deck + encoder, with 0.5 dB per tick and a maximum of 5 dB per event. Upward turns above −10 dB are limited to 0.5 dB per event. The plugin reads the hardware level before adjusting it and caps increases at 0 dB.

Requires macOS 13 or later, Stream Deck 7.1 or later, and one connected Lynx Hilo USB. The hardware path was verified on an original Hilo. Install the `.streamDeckPlugin` file and drag the actions onto keys or an encoder.

To build, install the macOS Command Line Tools and Elgato Stream Deck CLI. Run these commands from this directory.

```sh
./build.sh
streamdeck pack com.theoverloadstudio.hilo-monitor.sdPlugin
```
