# Memory Lane

Memory Lane is for people living with memory loss and the family who care for them. It runs on Meta AI glasses.

The wearer looks at a keepsake, or asks a question out loud, and hears their own family: a relative's recorded message, a short film of the memory on the lens, or the answer a relative gave the last time that question was asked.

Built at Junction 2026 for the **Meta challenge**, and entered for **Best Use of Gemini API** and for **Cloudinary**.

## The problem

A person living with dementia may ask where their wife is eight times in a morning, and not know they have asked before. The family member answering does know. Photos and keepsakes are often the strongest link to who someone is, but a photo cannot explain itself, so the same questions fall to the same carer again and again.

Sourced figures, and a list of what we must not claim, are in [docs/evidence.md](docs/evidence.md).

## What it does

- **Memories live in objects.** A relative photographs a keepsake, records a voice message, and can add photos or a video. When the wearer looks at that object, the glasses offer **See memory**. Nothing plays until they say yes.
- **Asked once, answered from then on.** A question nobody has answered is sent to the family with a count of how often it has been asked. A relative answers it once, and from then on the glasses give that answer, in that relative's voice.
- **"Who is that?"** plays a relative's own recorded hello, from a framed photo of them. Each relative can also have a memory lane of clips from their life, which the glasses offer to walk through.
- **The family sees how it went.** Home shows the questions waiting, the answers given, the memories opened most, and the things the wearer keeps looking at that hold no memory yet.
- **How a memory lands.** If the family switches it on, heart rate is noted while a memory is open. So far this has only run on simulated glasses, and it is labelled as simulated wherever it shows ([docs/heart-rate.md](docs/heart-rate.md)).

### Why glasses

Opening a phone app is the step that fails for someone with memory loss: they would have to remember the phone. On glasses the trigger is what the wearer is already doing, which is looking at something or asking out loud. The lens shows bare text and at most two choices, and the whole loop also works by sound alone on glasses with no display.

### The rule the AI works under

**The model chooses; it never writes.** It picks which object is in view and which recorded answer fits. Every word the wearer hears was recorded or typed by their family. No voice is synthesised. When nothing fits, the wearer hears a fixed line saying so, because a wrong answer is worse than none.

**The demo family is made up.** Maya and Jake are not real people. We would not put a real family's voices on stage, so their voice messages were generated with ElevenLabs and several of their films with Kling AI; the files carry C2PA content credentials that say so. The fortnight of use in the demo household is made up too (`server/scripts/seed-recordings.mjs`). The product itself never synthesises a voice: in a real household every recording is a relative's own.

## How it is built

```
 Glasses            Phone                    Server (Node)              Browser
 camera    DAT    Memory Lane app   HTTP   memories, profiles,   HTTP   Family web app
 display  <---->  (Kotlin)         <---->  questions, answers   <---->  Home, Memories,
 mic              offline pack             |              |             Family
 speakers                                Gemini API   Cloudinary
```

| Path | What it is |
|---|---|
| `android/` | The glasses app. Kotlin, Meta Device Access Toolkit 1.0.1 (camera, display, speech, motion). |
| `android/e2e/` | End-to-end test that drives the app on simulated glasses. |
| `server/` | Node and Express API: memories, family profiles, recognition, questions and answers, notifications, pairing. |
| `family/` | Web app for the family. Vite, plain JavaScript. |
| `lane/` | The walk-through page for a person's memory lane. |
| `docs/` | Setup and settings, emulator testing, sourced evidence, how heart rate is read, design patterns. |

In the code a memory is still called a `keepsake`, and a memory's film is sometimes a `tunnel`. On screen they are always a memory and a memory lane.

## How we use the Gemini API

Gemini does four jobs, all through one small REST client (`server/src/gemini.js`). Every call asks for JSON against a response schema at temperature 0, so the model can only return a choice or a plan, never free text for the wearer.

| Job | What Gemini is given | What it returns | Code |
|---|---|---|---|
| **Which object is this?** | The family's reference photos of each keepsake, then one frame from the glasses | A keepsake id or "none", a confidence, and a plain label for the object | `geminiRecognise` |
| **Which answer fits?** | The wearer's question and the family's recorded answers | An answer id or "none" | `geminiChooseAnswer` |
| **Arrange a memory lane** | The memory's photos and the **audio** of the voice message | When each photo should appear in the recording, where its subject is, how it should move, and the music and pace | `server/src/lane.js` |
| **Write down a voice message** | The recording | A word-for-word draft, which a relative reads and saves | `server/src/transcript.js` |

What makes this more than a single prompt:

- **It listens as well as looks.** For a memory lane, Gemini hears the voice message and places each photo at the moment its subject is mentioned. In the demo household its note to the family reads: "I placed the graduation video right at the beginning to match Jake's opening greeting about the day he graduated."
- **The family edits in words.** "Make it slower" or "start with the wedding" sends the current plan back with the request. Gemini returns a revised plan and says what it changed, and every change can be undone.
- **Its output is checked before use.** A plan is cleaned against the memory's real files, so a photo that does not belong cannot appear. A match below a confidence of 0.6 counts as no match.
- **It is told never to identify or describe people.** Faces are not recognised at all (see "Data and consent").
- **It is built to fail quietly.** Calls go to `gemini-3.5-flash-lite`, then `gemini-3.1-flash-lite`, in short attempts within a time limit, because about one call in ten on the free tier got a 503 or no reply. With no answer, a lane falls back to a simple arrangement, questions are matched by wording on the phone, and the wearer is offered their memories as a list.
- **A miss is useful too.** When the object holds no memory, Gemini's label for it goes to the family as an idea for a new memory.

With a Gemini key, recognition goes through the Gemini Decisions API, which gives a probability for each memory and for "none of them"; a match is then confirmed against that memory alone. Measured live on the recordings household (15 November, held-out photos, each re-lit warm and dim and cool and blurred, against 18 look-alikes of the same kinds made with Gemini's image model and 4 objects with no memory): 18 of 18 real looks matched and 22 of 22 others were turned down. Without the confirmation, 10 of the look-alikes would have matched, one at 0.997. Median 1.4 s for a match; a miss takes about 4 s, because the object is then named. Each memory also tests itself against two look-alikes of its own when it is added; all six in the recordings household passed.

## How we use Cloudinary

The display takes a small silent MP4 from an https address: at most 400 pixels a side and 70,000 pixels in all. Families upload phone photos and videos of any size. Cloudinary is the whole of the path between the two (`server/src/cloudinary.js`, `server/src/films.js`), and with `CLOUDINARY_URL` set nothing for the glasses is rendered on our server or in a browser.

**The film is an address.** Originals are uploaded once, as they are. A memory lane is then a single transformation URL that Cloudinary assembles:

```
/video/upload/du_1.6/c_fill,h_264,w_264
  /fl_splice:transition_(name_fade;du_1.5),l_<photo 1>/du_5.5/c_crop,h_786,w_786,x_107,y_0/c_scale,h_264,w_264/fl_layer_apply
  /fl_splice:transition_(name_fade;du_1.5),l_<photo 2>/du_5.5/c_crop,.../fl_layer_apply
  /fl_splice:transition_(name_fade;du_1.5),l_<last photo>/e_zoompan:du_5.5;fps_25;from_(zoom_1;...);to_(zoom_1.18;...)/c_fill,h_264,w_264/fl_layer_apply
  /ac_none,vc_h264,q_auto/<base>.mp4
```

- **Gemini directs, Cloudinary cuts.** Gemini's plan says when each photo is mentioned and where its subject is. Those become each layer's duration (`du_`) and crop (`c_crop` around the subject), so the film follows the relative's voice.
- **Slow fades, and a slow move in.** Layers are spliced with a 1.5 second fade (`fl_splice:transition_`), and the last photo moves gently towards its subject (`e_zoompan`).
- **Sized for the lens.** 264 by 264, silent H.264 (`ac_none,vc_h264,q_auto`), which fits inside the display's limits.
- **A memory that is one video** is that clip, cropped around its subject (`c_fill,g_auto`). The plain crop goes to the glasses at once and the subject-aware one replaces it when Cloudinary has it ready.
- **A hello video is cropped around the faces in it** (`g_auto:faces`), the same way.
- **Tiles and stills** in the family app are a frame Cloudinary picks (`so_auto`), cropped around what matters and sent in the browser's best format (`c_fill,g_auto`, `f_auto,q_auto`).
- **A person's memory lane clips** get their display-sized copy as an eager transformation at upload.
- **It runs in the background after every change.** The family app shows "Being made for the glasses now" and the page can be closed. On start-up, anything without an up-to-date copy gets one.
- **Deleting is real.** Removing a memory, a hello or a person removes their uploads from Cloudinary too.

The sound stays on our server: the phone plays it through the glasses' speakers and keeps it for when there is no connection.

The demo household's memory lanes and hellos are all made this way. Not yet checked: these films playing on real glasses.

## Against the Meta brief

| The brief asks for | What we do |
|---|---|
| A clear problem and audience | People living with memory loss and their family carers; the repeated question and the keepsake that no longer prompts its memory. |
| First-person view, beyond mirroring a phone | Looking and asking are the whole interface. Nothing to find or open. |
| A working prototype | Server, phone app and family app run end to end, with 95 server tests and a 21-check end-to-end test on simulated glasses. |
| Permissions | Asked for when needed. Each missing one removes one feature: no microphone, and the choices on the lens still work. |
| Errors | Every failure has a calm spoken and written path. A look has a 12 second limit. An unsure match gives no answer. |
| Performance | Small frames, fast models first, the camera stream at its lowest quality, automatic looking off by default. |
| Connectivity | The phone keeps memories, recordings, hellos and answers. With no connection the wearer can still open memories and get recorded answers. |
| Device state | Taking the glasses off pauses everything. Low battery is spoken once and sent to the family. A lost session is retried three times. |
| Intuitive and inclusive | Everything spoken is written and everything written is spoken. Two choices at most. A memory is offered, never sprung. Works without a display. |
| Consent and safe data | See below. |
| A path to a pilot | One day centre, five to ten families, four weeks, with staff helping each family set up in the first week. |

## Data and consent

- **Agreement first.** The server refuses to look at any frame until the wearer, or the person who holds their legal authority, has agreed.
- **Frames are not kept.** A frame is checked and discarded; only the outcome is logged. The Gemini key in use is on the free tier, where Google may use submitted content to improve its products. Before any pilot this must move to a paid tier whose terms rule that out.
- **Nobody is identified from their face.** Telling someone a stranger is their daughter would do real harm. "Who is that?" is answered only from a framed or printed photo in a memory, which is an object, and the family says who is in it.
- **Family voices are real.** Recordings play as recorded. A typed answer is read by a neutral voice that says who wrote it.
- **Uploads need confirmation** that everyone pictured or recorded has agreed.
- **Opt-ins are separate and off by default:** noting questions, listing unfamiliar objects, and noting heart rate. Heart rate is health data: switching it off deletes every session kept.
- **Everything can be deleted**, including what was uploaded to Cloudinary.
- **Meta SDK analytics are turned off.**

## Run it

You need Node 22 or newer, and Android Studio with SDK 36 for the glasses app. Keys go in `server/.env` (git-ignored): `GEMINI_API_KEY` for recognition and memory lanes, and `CLOUDINARY_URL` (`cloudinary://key:secret@cloud`) for the glasses films. With no model key the server runs in rehearsal mode, which recognises nothing.

```bash
cd server && npm install && npm start      # http://localhost:8787
cd family && npm install && npm run build  # the server serves it at /
```

Open `http://localhost:8787`. The first person to arrive is walked through setting up and becomes the organiser.

```bash
adb reverse tcp:8787 tcp:8787              # the phone reaches the server over USB
cd android && ./gradlew installDebug
```

In the phone app, **Connect glasses** uses real glasses through the Meta AI app. **Use simulated glasses** uses Meta's Mock Device Kit, with the phone's camera and microphone standing in. On Windows, `./sim.sh` from Git Bash starts the server, the emulator and the app on simulated glasses in one go; on Linux use `./dev.sh`.

```bash
cd server
npm test                                   # server tests
npm run seed:recordings -- ../recordings  # the demo household, with a fortnight of use
npm run scorecard -- <folder of photos>    # recognition hits, misses, false matches, latency
node ../android/e2e/run.mjs                # the whole loop on simulated glasses
```

Pairing over Wi-Fi, every script and every setting are in [docs/setup.md](docs/setup.md). Running on an emulator is in [docs/emulator-testing.md](docs/emulator-testing.md).

## What has and has not been checked

Checked:

- The whole loop on an Android emulator with simulated glasses and live Gemini.
- Object recognition, the memory offer and replay on a physical phone with simulated glasses.
- Memory lanes planned by live Gemini and assembled by Cloudinary, in the demo household.

Not checked:

- **Real glasses.** Nothing has run on Ray-Ban Display or on audio-only glasses. We have no hardware; everything is on Mock Device Kit.
- **Real people.** It has never been tried with a person living with dementia. It is a support and comfort aid, not a treatment, and there is no evidence yet that it helps.
- **Heart rate** has only been read from made-up motion replayed by Mock Device Kit. No real reading has been taken.
- **Recognition in a real home.** It has been measured only on the demo household's photos and made-up look-alikes.
- **Real family recordings.** The demo household's voices are AI-generated (ElevenLabs) and several of its films are too (Kling AI). No real family's recordings have been used.
- **Sound** on the emulator, which ran with audio off.
- **The family app** on phones, other browsers and screen readers, and recording through a real microphone by hand.

Also: it holds one household in a JSON file, behind one shared access code over plain HTTP. That suits a home or venue network, not the public internet.

## More

- [docs/evidence.md](docs/evidence.md): sourced facts, and what not to claim
- [site/](site/index.html): the project website, with a demo to try. Static files: serve the folder, or publish it with GitHub Pages
- [docs/setup.md](docs/setup.md) and [docs/heart-rate.md](docs/heart-rate.md): pairing, scripts and settings; how the pulse is read
- [docs/design-patterns.md](docs/design-patterns.md): patterns to follow before a large change
- [docs/meta-resources.md](docs/meta-resources.md): Meta's developer resources

## Licence

MIT: see [LICENSE](LICENSE). The fonts, photos, clips and libraries used are under their own
licences, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The glasses app needs Meta's Wearables
Device Access Toolkit, which is under Meta's developer terms, not the MIT License.
