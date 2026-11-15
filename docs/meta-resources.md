# Meta wearables: developer resources

Start at the developer site, <https://wearables.developer.meta.com>, before building anything.

## Frameworks

There are two ways to build for Meta Ray-Ban Display glasses:

- **Device Access Toolkit (DAT):** native iOS and Android apps that use the glasses' camera, microphone, display and inputs. Memory Lane uses this one, because it's the only option with camera access. Getting started: <https://wearables.developer.meta.com/docs/develop/dat/getting-started-toolkit>
- **Web Apps:** standalone HTML, CSS and JS apps that run on the glasses. They have no camera access. Docs: <https://wearables.developer.meta.com/docs/develop/webapps>
  - UI toolkit for Web Apps: <https://wearables.developer.meta.com/docs/develop/webapps/design/getting-started/what-is-the-toolkit/>
  - Web App simulator (Chrome extension): <https://chromewebstore.google.com/detail/jpjlmmodokemlepklkdbimceggpbjcll>

For running a DAT app with no glasses (emulator plus Mock Device Kit), see [emulator-testing.md](emulator-testing.md).

## GitHub repos for agents

- Web Apps: <https://github.com/meta/meta-wearables-webapp>
- DAT for iOS: <https://github.com/meta/meta-wearables-dat-ios>
- DAT for Android: <https://github.com/meta/meta-wearables-dat-android>

The Android DAT repo was cloned from `github.com/facebook/meta-wearables-dat-android`, which also works. It ships agent skills in `plugins/mwdat-android/skills/` and samples in `samples/` (DisplayAccess, CameraAccess, BirdSpotter).

## Hardware: common issues

**Device registered to another account?** Factory reset it:

- Glasses: <https://www.meta.com/en-gb/help/ai-glasses/814846737027479/>
- Meta Neural Band: <https://www.meta.com/en-gb/help/ai-glasses/1481163499576351/>

**Can't pair the device?**

- Glasses: <https://www.meta.com/en-gb/help/ai-glasses/852077233025627/>
- Meta Neural Band: <https://www.meta.com/en-gb/help/ai-glasses/770840295349358/>
