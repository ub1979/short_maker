# Short Maker

Turn a long 16:9 video into vertical 9:16 shorts for YouTube Shorts, Instagram Reels and TikTok. Everything runs on your Mac.

```bash
./start.sh
```

Then open http://127.0.0.1:8765. The server runs in the background, so your terminal is free (log: `data/server.log`). To stop it:

```bash
./stop.sh
```

`./start.sh --fg` runs it in the terminal instead (Ctrl+C stops it).

Needs: `ffmpeg` and `uv` (brew install ffmpeg). Transcription uses `mlx-whisper`, which needs an Apple Silicon Mac, plus Silero VAD. The first transcription downloads the Whisper model.

## How it works

1. **Upload** a video (mp4, mov, mkv, webm). Files a browser can't play, like HEVC or mkv, get a 720p preview copy. The final render always uses the original file.
2. **Transcribe** on your Mac with **Whisper** (pick the model in AI & settings). Whisper sometimes makes up text over silence or instrumental parts, so **Silero VAD** double-checks it: a line is removed only when Silero hears no voice there *and* Whisper itself said "no speech" or the audio is near silent. Silero alone misses singing over loud music, so it never removes text by itself. Removed lines are listed under the transcript (hover to see them). "AI: find best moments" transcribes first if needed. This gives you searchable text, word-timed captions and AI moment-picking.
3. **Make shorts** in any of these ways:
   - Press `I` / `O` (or *Start here* / *End here*) at the playhead.
   - Drag the clip edges on the timeline.
   - Press **+ short** on a transcript line.
   - Press **AI: find best moments**.
4. **Pick a template.** There are 14 built-in templates (solid, gradient, blurred video and patterns). In the **Template** tab you can tweak one and *Save as new template*. You can also *Upload background* to build a template from your own image, or import/export templates as `.json`.
5. **Edit on the preview with the mouse:** hover over the title, channel, links, captions or video and drag it up or down. Click it for **A− / A+** (size), **↕− / ↕+** (line spacing, for captions and title), **Edit** and **Reset**. Double-click to edit: the title right on the preview, the channel and links in Channel & links, a caption at its lyric line or transcript row. The **Edits** switch above the preview decides where moves and Template-tab changes go: **All shorts** (default) or **This short**. Positions and sizes are kept when you switch a short's template, and a new short starts with the layout of the one you're on.
6. **Channel & links** (logo, name, handle, call to action, links) are saved once and shown on every short.
7. **Your own lyrics / captions:** open **My lyrics** next to Transcript.
   - Paste your lines (one caption each), then press **Auto-sync**: Whisper is handed your exact lines and only works out *when* each one is sung (forced alignment), so repeated lines like "Now you…" land in the right place. A normal Whisper pass first finds lines it clearly hears, which lets it jump over instrumental breaks, and silent parts are skipped. Section labels like `[Chorus]` are skipped, and removed when you paste. Lines it couldn't hear get grey, guessed times; check those. Times you set yourself are kept.
   - Or time them by hand with **Tap to sync**: the video plays, and you press `Space` when each line starts (`⌫` undoes a tap, `Esc` stops and ends the last line).
   - You can also type times, set a line to the playhead, or import a timed `.lrc` / `.srt` file. **Export .lrc** saves the lines.
   - On the Short tab, choose **From my lyrics** to use them. The words light up karaoke-style.
8. **Fix captions** in "Edit caption text" on the Short tab. Corrections go into the transcript, so every short gets them.
9. **Render** gives you a 1080×1920 H.264/AAC MP4 that works on all three platforms. The **Post text** tab holds the title, description and hashtags for each platform. The first time you render a video, a Finder window asks **where to save** (change it any time under the Render button, or open the folder). Files are named after the video: `aye watan_r_1.mp4`, `aye watan_r_2.mp4`… where the number is the short's #. Rendering a short again replaces its file.

## AI chat

This uses the same connection types as Appling and CoB:
- Claude Code (signed in)
- Codex CLI (signed in)
- Ollama
- any OpenAI-compatible API
- the Anthropic API

API keys are read from the environment variable you name in Settings. They are never saved to disk.

The chat can change the editor: add, trim or delete shorts, change titles or templates, write post text, and start renders. Every change is checked before it is applied, and the chat lists what it changed.

## Design notes

- This ffmpeg build has no `drawtext`/`subtitles`. All text, logos and captions are drawn by the browser canvas, using the same code as the live preview, and sent to ffmpeg as PNG layers. ffmpeg only composites them. So the preview matches the final video.
- Data lives in `./data` (projects, renders, custom templates, uploaded images, settings).

## License

Copyright (c) 2026 Syed Usama Khalid Bukhari (ub1979).

Licensed under **CC BY-NC-ND 4.0**: free for noncommercial use, with education and research as the intended audience. Attribution is required. Commercial use and sharing adapted versions are not licensed. See [LICENSE](LICENSE).
The code is source-available, not OSI open source.
