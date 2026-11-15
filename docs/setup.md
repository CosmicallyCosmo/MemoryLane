# Setting up and running: the detail

The short version is in the [README](../README.md). This page holds pairing, the scripts and every setting.

## Pairing a phone and the access code

The server makes an eight-character household code the first time it starts and keeps it in its data folder.

- **This computer is trusted.** The browser on the laptop that runs the server, and a phone connected over USB with `adb reverse tcp:8787 tcp:8787`, need no code.
- **Everything else needs the code**: a phone on Wi-Fi, or a browser on another computer. Without it the API and the media files answer `401`.
- **To pair a phone over Wi-Fi**, open the family app on the server's computer, go to **Settings → Connect the glasses phone → Show code**, and scan the QR code with the phone's normal camera app. It opens a `memorylane://pair?server=…&code=…` link, which the Memory Lane app handles.
- **To use the family app from another computer or phone**, open `http://<server address>:8787` and type the code when asked.
- **Make a new code** on the same panel replaces the code and disconnects every paired phone and every other signed-in browser.
- Ten wrong codes from one address lock that address out for ten minutes.

Clients send the code as an `x-memorylane-code` header, a `?code=` query parameter (for media players that cannot set headers), or the session cookie from `POST /api/session`.

This is one shared secret for one household over plain HTTP. It keeps other people on the same Wi-Fi out; it is not enough for a server on the public internet, which would also need HTTPS and per-person accounts.

## Scripts

Run these from `server/`, with the server already running (`npm start`).

**Demo household from a folder of recordings.** Builds the household used in the demo video from the recordings folder (kept out of git): Maya and Jake, the elephant keychain with Maya's voice message and the beach video, the graduation photo with Jake's voice message and the graduation video, and Maya's hello with her video. It goes in `server/data-recordings`, never `server/data`, and does not need the server running. The file names it expects are listed at the top of the script.

```bash
npm run seed:recordings -- <folder of recordings>   # rebuilds server/data-recordings
npm run start:recordings                            # the server on it
```

Afterwards, in the family app, press **Put it on the glasses** on each memory's page and under **Your hello** on Maya's profile: the glasses copies are recorded in the browser and are not made by the script.

**Recognition scorecard.** Sends your own photos through recognition and prints a table of hits, misses, false matches and latency. Needs a vision model key (not rehearsal mode) and the memories already added in the family app. The folder names are fixed by the script.

```text
my-test/
  keepsakes/
    Elephant keychain/  folder name = the memory's name or id; photos that should match it
      held-in-hand.jpg
  distractors/          photos that should match nothing
    red-mug.jpg
```

```bash
npm run scorecard -- my-test
npm run scorecard -- my-test http://127.0.0.1:8795 --runs 3
```

Keep each photo under about 1 MB (larger ones are skipped with a warning). The script exits with status 1 if any distractor was matched, since a wrong memory is the worst outcome. From another machine, set `ML_CODE` to the household code for either script.

**How Gemini recognises a memory.** With a Gemini key, recognition goes through the Gemini Decisions API (`gemini-decision-1`), which gives a probability for each memory and for "none of them". Each memory is one numbered option: its name, its identifying features and its photos together. The photos are sent at 512 px on the long side; the originals stay on disk as uploaded. A choice of 0.6 or more is then confirmed against that memory alone, its photos and the frame and nothing else: "the same object, or another of its kind?" (0.7 or more needed) and a yes/no for each of its checks (any clear "no" turns it down). If the confirmation cannot be had in time, the look fails rather than letting the match through.

Each memory is prepared once, in the background, one call at a time: Gemini Flash-Lite writes its identifying features and checks from the full-size photos, then the Gemini image model makes two pictures of look-alikes from its photo and they are looked at as the glasses would. If either is taken for a memory, the family is told, and the memory's page asks for a close-up of something only theirs has. The pictures are not kept. This happens when a memory is added, when photos are added to it, and at start-up for any memory not yet prepared. When nothing matches, Gemini Flash-Lite names the object, shown the same memories, so the glasses and "ideas for new memories" still have a name for it. `ML_GEMINI_DECISIONS=0` goes back to Gemini vision for recognition. Memory lanes and choosing answers to questions use the usual Gemini models either way.

## Configuration

### Server environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port to listen on. |
| `ML_DATA_DIR` | `server/data` | Where the JSON store and media files live. |
| `GEMINI_API_KEY` | unset | Enables Gemini. Without it the server runs in rehearsal mode. Put it in `server/.env` (git-ignored); `npm start` loads that file. |
| `ML_GEMINI_MODEL` | `gemini-3.5-flash-lite,gemini-3.1-flash-lite` | Gemini models, tried in turn until one answers or the time is up. They must accept the thinking level `minimal` (3.5 and 3.1 Flash-Lite do; 3.8 Flash and 4 Hydrogen do not). |
| `ML_RECOGNISER` | automatic | Force `gemini` or `rehearsal`. |
| `ML_REHEARSAL_MEMORY` | unset | Rehearsal mode only: a memory's id or part of its name. Every look the phone does not name a memory for finds this one, so "What's this?" on the glasses can be rehearsed hands-free. |
| `ML_MIN_CONFIDENCE` | `0.6` | Below this, a match is treated as no match. |
| `ML_CONFIRM_SAME` | `0.7` | Decisions API only: how sure the confirmation must be that it is the same object. |
| `ML_GEMINI_IMAGE_MODEL` | `gemini-3.1-flash-image` | Makes the look-alike pictures for each memory's self-test. |
| `ML_PREPARE_GAP_MS` | `3000` | Pause between the background calls that prepare memories, so they leave room for the wearer's looks. |
| `ML_RECOGNISE_TIMEOUT_MS` | `12000` | How long a look may take before the wearer is told it failed. |
| `ML_GEMINI_DECISIONS` | unset (on) | With Gemini, objects are recognised by the Gemini Decisions API (`gemini-decision-1`); `0` uses Gemini vision instead. |
| `ML_LANE_TIMEOUT_MS` | `90000` | How long Gemini may take to plan a memory lane before the simple plan is used. |
| `CLOUDINARY_URL` | unset | `cloudinary://key:secret@cloud`. Serves a memory lane's glasses video from a public https address, which real glasses are expected to need. Without it the glasses are given this server's own http address. |

In rehearsal mode the phone tells the server which object is "in view". It exists to rehearse the loop and to keep a demo going on a bad network. It does not recognise anything.

### Android `local.properties`

| Key | Default | Purpose |
|---|---|---|
| `sdk.dir` | none | Path to the Android SDK. |
| `memorylane_server_url` | `http://127.0.0.1:8787` | Default server address. Can also be changed in the app. |
| `mwdat_application_id` | `0` | From the Wearables Developer Center. `0` works in developer mode. |
| `mwdat_client_token` | `0` | As above. |
