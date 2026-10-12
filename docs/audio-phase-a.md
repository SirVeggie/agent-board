# Chat dictation (phase A, #567)

`src/audio/` owns speech-to-text settings, engines and calls. `AudioService` receives a live
`sources()` lookup from the agent host; only source IDs and names reach the shell. The default
engine posts multipart audio to the source's `/audio/transcriptions` endpoint. There is no new
dependency. Sources must support this endpoint; chat model support alone does not imply STT.

- Settings: `audio-settings.json` in the data directory, `stt: { source?, model, language? }`
  and `input: { sendAfterDictation, pushToTalk }`. Default model: `whisper-1`; sending off;
  push-to-talk on. `audio-usage.json` holds today's calls, failed calls and uploaded bytes.
- `SttEngine.transcribe(request)` gets the daemon-only source, model, Blob, optional language
  and prompt, and an abort signal. It returns `AudioResult`. Inject it and an `AudioStore` for tests.
- Calls have a 60-second total deadline and one retry (300 ms delay) for 429 or 5xx. Responses
  never include upstream error bodies. Errors are typed and preserve the composer's text.
- `/api/audio/settings` (GET/PUT), `/transcriptions` (POST, raw `audio/*`, 25 MiB), `/test`
  (POST JSON, built-in short WAV saying “Scribe audio test.”). Origin checking precedes parsing;
  JSON is required for settings/tests. A transcription with `x-scribe-tab` is denied unless
  the router receives a page-permission callback. Phase B supplies that callback.

`public/audio.js` exposes `scribeAudio.capture`, `transcribe`, `dictate`, `available`, `refresh`,
`settings`, `device`, `setDevice`, `cancel(owner?)` and the pure `insertAtCaret` helper.
`capture`/`dictate` are asynchronous; sessions have idempotent `stop`, `cancel`, `state` and an
`ended` promise. `dictate.ended` resolves with the transcription result, including on automatic
stop. Capture defaults to five minutes; tracks close on stop, cancellation and shell unload.
Concurrent captures are refused. Microphone IDs live only in this browser profile's storage.

`public/audio-composer.js` binds click-to-toggle, the level ring, elapsed time, transcription
spinner, Escape cancellation and Ctrl+Shift+Space (hold/release). Transcripts replace the
current selection when they arrive, so typing while the request runs is preserved. Switching
threads, handing a composer to another layout or closing its view cancels the session and
discards late results. Global keyboard listeners exist only while dictating.

`public/audio-settings.js` supplies Settings → Audio. Source/model/language and input choices
save on change; the Test button sends the built-in clip and displays the returned transcript.
Mic permission is first requested when recording starts; device enumeration does not open it.

Verification: `npm test` includes fake-engine service/route tests, a local multipart endpoint,
pure caret tests, and Chromium synthetic-microphone capture/composer tests. Real provider calls,
physical microphone behavior and Tauri/WebView2 permission persistence require a manual check.
No WebView2 auto-allow handler was added without evidence that its normal prompt fails.
