# ATS Co-Driver

**Your tablet becomes the GPS and dashboard of your truck in American Truck Simulator.**
Free and open source.

Website: https://maxvel-coder.github.io/ats-co-driver/ · Download: [latest release](https://github.com/maxvel-coder/ats-co-driver/releases/latest) · Support: [Buy me a coffee](https://buymeacoffee.com/maxvelx)

## What it does

- **Turn-by-turn navigation** on a real map of your game, drawn like the in-game map, with true road widths.
- **Junction view**: zooms in 15 s before exits (21 s at busy interchanges) and shows which lanes to use.
- **Voice directions** (natural offline voice "Amy"), through your PC headset or the tablet.
- **As many stops as you like**, always in the best order.
- **Smart stops**: fuel, rest or a mechanic, the one with the least detour, one tap to add.
- **Delivery timing**: delivery window, deadline, real arrival time with stops and traffic lights, in the destination's time zone.
- **Enter helper**: one big button at the company, the pump, the garage or the parking (refuel to full, engine off first, sleep).
- **Your cab, one tap away**: lights, wipers, engine, hazards, cruise, radio, windows…
- **Build your own dashboard**: 40+ widgets, drag and drop, day and night themes, phone or tablet, portrait or landscape.
- Only the states you own are shown and used for routes.

## Install

1. Download `ATS-Co-Driver-Setup-x.y.z.exe` from the [latest release](https://github.com/maxvel-coder/ats-co-driver/releases/latest) and run it (Windows 10/11, 8 GB RAM, ATS on Steam).
2. Start **ATS Co-Driver**. The first start builds the map from your own game files (a few minutes, once) and downloads the voice.
3. On your phone or tablet (same Wi-Fi), scan the QR code or type the address shown, then "Add to Home screen".
4. Start the game; the first time it asks about "advanced SDK features": choose **OK**.

Uninstalling removes the game plugin and, if you like, the map and settings.

## How it works

- `src/plugin/codriver.cpp`: a small SCS telemetry + input plugin (port 25555, this PC only).
- `src/packages/apps/codriver/`: the server (`server.ts`), the first-start launcher (`launcher.ts`) and the web app (`web/`).
- The map, routing and game-file reading come from [truckermudgeon/maps](https://github.com/truckermudgeon/maps).
- `site/`: the website, published to GitHub Pages by `.github/workflows/pages.yml`.

## Build from source

Needs Node.js 24, a `npm install`ed checkout of truckermudgeon/maps (for the dependencies), zig (plugin) and Inno Setup (installer).

```
node build/build.mjs --deps <maps checkout>     # → dist/ATS Co-Driver
ISCC build/installer.iss                         # → dist/ATS-Co-Driver-Setup-x.y.z.exe
node build/site-scenes.mjs build                 # website scene data (needs a running Co-Driver)
node build/stats.mjs <user>/ats-co-driver        # download counts
```

## License and credits

GPL-3.0-or-later (see `LICENSE` in `src/`). Built on [truckermudgeon/maps](https://github.com/truckermudgeon/maps) (GPL-3.0),
[MapLibre GL JS](https://maplibre.org) (BSD-3), [Piper](https://github.com/rhasspy/piper) (MIT) and Node.js (MIT).
No game data is included: the map is built on your PC from your own copy of the game.

Not affiliated with or endorsed by SCS Software. American Truck Simulator is a trademark of SCS Software.
