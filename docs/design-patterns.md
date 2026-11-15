# Design patterns in use

Read this before planning a large change. Add to it after one.

## Something the glasses notice about the wearer (heart rate is the worked example)

1. **Its own consent switch.** A boolean in `DEFAULT_PROFILE.consent` (`server/src/store.js`),
   added to the key list in `PUT /api/profile` (`server/src/app.js`), to `choices` in
   `GET /api/consent`, and to the switch list, history wording, setup step and settings line in
   `family/src/views/consent.js`, `welcome.js` and `settings.js`. Off by default. If switching
   it off should delete what was kept, do that in `PUT /api/profile`.
2. **The phone learns the switch from the pack.** `/api/pack` carries the whole profile and
   `packVersion()` changes with it, so the phone re-syncs within 20 seconds. Parse the flag in
   `parsePack` (`android/.../Data.kt`) and mirror it into `UiState` in `applyPack()`.
3. **It travels as an event.** The phone calls `repo.queueEvent(type, keepsakeId, payload)`;
   events wait on the phone when offline and go to `POST /api/events`. The type must be in
   `CLIENT_EVENTS`. The server checks consent and cleans the payload before storing it, and
   never trusts the phone's own check.
4. **Meaning is worked out on the server, in a pure module.** `server/src/heart.js` has no
   store and no Express: `cleanSession`, `summarise`, `describeHeart`, `typical`. The stored
   event keeps the raw session; summaries are computed when asked for, so thresholds can change
   without migrating data.
5. **The family reads it three ways.** A line in `describe()` (`server/src/family.js`) for the
   activity list; a field on each memory in `/api/stats` for tiles and Home; a dedicated
   endpoint (`GET /api/keepsakes/:id/heart`) for the memory's page. Notices go through
   `notify()` with a `key` so the same thing is not said twice in a day, and their type is added
   to `clearWearerNotices`.
6. **Wording states what happened, not what it means.** Sentences come from the server so the
   glasses app, the activity list and the notification agree.

## Sources of readings on the phone

Heart rate is read from the glasses' motion (`mwdat-motion`, 60 Hz) by `PulseEstimator` in
`MotionPulse.kt`, which is plain Kotlin with no Android or SDK types so it has JVM unit tests
(`app/src/test`, `./gradlew testDebugUnitTest`). Keep signal processing like this out of the
view model and test it against `syntheticHeadMotion`.

Simulated glasses go through the same code: Mock Device Kit replays made-up samples
(`glasses.services.motion.setMotionFeed`). Anything that did not come from real hardware names
itself in what it sends (`source: "simulated"`), so it is labelled wherever it is shown. Real
glasses never fall back to made-up readings.

A capability is attached with `session.addX(...)`, which returns a `DatResult`; log the failure
and carry on without it, as camera, speech and motion all do.

## Sessions tied to a memory being open

`GlassesViewModel` has many paths in and out of a memory (offer, question, "who's that?", film,
linger, going home). Do not hook each one. Watch `ui.map { phase to currentKeepsake }` in one
collector, as the heart-rate session does in `init`.
