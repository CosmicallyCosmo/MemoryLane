# Third-party notices

Memory Lane's own code is under the MIT License in [LICENSE](LICENSE). The fonts, images,
clips and libraries below are not ours: each keeps its own licence, and the MIT License does
not cover them.

## In this repository

| What | Where | Licence |
| --- | --- | --- |
| Lexend font, © 2019 The Lexend Project Authors | `family/public/fonts/lexend.woff2`, `site/fonts/lexend.woff2`, `android/app/src/main/res/font/lexend.ttf` | SIL Open Font License 1.1: `LEXEND-LICENSE.txt` beside each copy |
| Source Serif 4 font, © 2014–2021 Adobe, Reserved Font Name "Source" | `family/public/fonts/source-serif-4*.woff2`, `site/fonts/source-serif-4*.woff2` | SIL Open Font License 1.1: `SOURCE-SERIF-4-LICENSE.txt` beside each copy |

## Fetched when built or run

These are not in the repository. npm, Gradle or the browser fetches them.

| What | Used by | Licence |
| --- | --- | --- |
| qrcode-generator, © Kazuhiko Arase | family app (bundled into its build) | MIT |
| Vite | family app (build tool only) | MIT |
| Express, Multer | server | MIT |
| sharp | server | Apache 2.0 |
| AndroidX, Jetpack Compose, Material 3, Kotlin | glasses app | Apache 2.0 |
| Meta Wearables Device Access Toolkit (`com.meta.wearable:mwdat-*`) | glasses app | Meta's own licence, not open source: using it means agreeing to the [Meta Wearables Developer Terms](https://wearables.developer.meta.com/terms) and [Acceptable Use Policy](https://wearables.developer.meta.com/acceptable-use-policy) ([LICENSE](https://github.com/facebook/meta-wearables-dat-android/blob/main/LICENSE)) |
| three.js, from cdnjs | `lane/memory-lane.html` | MIT |

The Gemini API and Cloudinary are services used under their providers' terms,
with your own keys. Nothing of theirs is in this repository.

The demo recordings (`recordings/`) and household data (`server/data*/`) are never in git.
The demo family in them is made up: its voice messages were generated with ElevenLabs, and
several of its films with Kling AI, under those services' terms.
