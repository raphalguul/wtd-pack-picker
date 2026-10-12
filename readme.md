# WTD Pack Picker

This is an external clip pack manager for **What the Dub?!** It allows you to select the available clip packs before launching the game. It's a little more versatile than the built-in selector (which still works even if you use this tool). Might be useful if you have many mods installed but don't want them always available at the same time. Pack Picker supports saving different pack configurations for quick switching.

You can also replace certain music files within the game.

![WTD Pack Picker Preview Screenshot.](/previews/preview.jpg)

## Requirements

To replace game audio, you will need to install [ffmpeg](https://ffmpeg.org/download.html).

## How to run

```
pip install -r audio-handler/requirements.txt
```
```
npm install

```
```
npm start
```

## How to compile

```
powershell -ExecutionPolicy Bypass -File build-release.ps1
```

## Features

- Shows all installed clip packs (you may have to point the app to your game installation folder and workshop folder if it cannot autodetect them)
- Displays packs with thumbnail (if present) and Workshop pack name (relies on Steam API, which can be rate-limited)
- You can select any clip pack to be enabled/disabled
- You can enable/disable all
- You can save and reload pack presets
- You can start the game with new selection straight from Pack Picker
- You can revert settings if necessary (reloads the last settings that were applied)
- Allows users to replace music files in WTD
- Game can run embedded into the pack picker
- Users can switch back to the picker via shortcut (only in embedded mode)

## Embedded Play

Pack Picker can launch the game embedded. This has two advantages:
- If you're streaming the game, embedded play is more seamless because there is no app switching
- When embedded, you can instantly terminate the game and switch back to the pack picker with a shortcut (default: alt+X)

Note that starting the game embedded will trigger a warning from Steam because the app is passing custom launch parameters to the game. This is for your safety and cannot be disabled.
