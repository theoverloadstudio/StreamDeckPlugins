# Hilo Monitor for Stream Deck

Adjust the analog speaker level of a Lynx Hilo connected over USB. **Monitor Volume Up** and **Monitor Volume Down** adjust the level by 0.5 dB. **Monitor Volume Dial** uses the Stream Deck + encoder, with 0.5 dB per tick and a maximum of 5 dB per event. The plugin reads the current hardware level before changing it and limits increases to 0 dB.

Requires macOS 13 or later, Stream Deck 7.1 or later, and one connected Lynx Hilo USB. The hardware path was verified on an original Hilo. Install the `.streamDeckPlugin` file and drag the actions onto keys or an encoder.

To build, install the macOS Command Line Tools and Elgato Stream Deck CLI. Run these commands from this directory.

```sh
./build.sh
streamdeck pack com.theoverloadstudio.hilo-monitor.sdPlugin
```
