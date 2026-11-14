# Messenger for iPhone

The owner's app for Web Messenger: a live chat inbox and push notifications. SwiftUI, iOS 18+, Swift 6, no third-party code. The contract it follows is [`../docs/chat-protocol.md`](../docs/chat-protocol.md).

It's designed to be installed over the cable on your own phone, not published on the App Store.

## Set up

You need Xcode and XcodeGen (`brew install xcodegen`). The `.xcodeproj` is generated and isn't in git.

```sh
cd ios
cp Local.xcconfig.example Local.xcconfig     # your team id and bundle id; gitignored
xcodegen
open WMChat.xcodeproj
```

Keep the repo out of cloud-synced folders such as iCloud Drive, Dropbox or Nextcloud. They can break the generated project (you'd see a `WMChat 2.xcodeproj`) and drop file permissions.

## Try it without a server

Run on any Simulator and turn on **Demo mode** on the first screen. Nothing goes over the network.

## Try it against the local bench

Start `npm run dev` in the repo root, run the app in the Simulator, type `localhost:8790` as the address and press **Sign in with Google**. The bench signs you straight in. Pushes don't arrive in the Simulator, but the bench prints them. To skip the sign-in sheet, pass the token the bench printed as launch arguments: `-benchHost localhost:8790 -benchToken <token>`.

## Install on your phone

Your Apple developer team must be signed in to Xcode (Xcode > Settings > Accounts). Unlock the phone, turn on Developer Mode, and trust this Mac. `xcrun devicectl list devices` shows your device id.

```sh
xcodebuild -project WMChat.xcodeproj -scheme WMChat -configuration Debug \
  -destination 'id=<device id>' -derivedDataPath build/device \
  -allowProvisioningUpdates build
xcrun devicectl device install app --device <device id> \
  build/device/Build/Products/Debug-iphoneos/WMChat.app
```

You can also press Run in Xcode. The first device build creates the App ID with the **Push Notifications** and **Time Sensitive Notifications** capabilities. Use a **Debug** build: it registers its push token with `env: "sandbox"`, which matches the development `aps-environment`. A Release build registers as `"production"`.

### Build helpers

- `scripts/sync_sounds.sh` copies the sounds from `assets-src/sounds/` into `WMChat/Resources/Sounds/`. It runs as the first build phase.
- `scripts/make_icon.swift` redraws the 1024 px icon, a plain speech bubble on the accent colour: `swift scripts/make_icon.swift WMChat/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`. It is a placeholder; replace the PNG with your own artwork.

## Theming

The app ships with the same plain look as the widget: light and dark, a blue accent, the system font. To change it, edit one file, `WMChat/Support/Theme.swift`:

- **Colours:** the `static let` lines at the top of `Theme`. Each takes a light-mode and a dark-mode value, for example `static let accent = dynamic(light: 0x2563EB, dark: 0x60A5FA)`.

  | Name | Used for |
  |---|---|
  | `paper`, `plate` | Page background; cards and list rows |
  | `bubble` | The visitor's message bubbles |
  | `ink`, `quiet` | Text; secondary text |
  | `accent`, `onAccent` | Your own bubbles, buttons, switches, unread counts, avatars; and the text on them |
  | `online`, `warning`, `danger` | The online dot; notices; errors, Block and the tab bar badge |

- **Font:** `Theme.fontDesign` (`.default`, `.rounded`, `.serif` or `.monospaced`).

No other Swift file contains a colour value. Two things sit outside that file and should be kept in step with it: `WMChat/Assets.xcassets/AccentColor.colorset/Contents.json` (the accent iOS reads itself; the same two values as `Theme.accent`) and the app icon (`scripts/make_icon.swift`, under "Build helpers").

## Screens

**Setup** (first run, after sign-out or after any 401): enter the `InboxUrl` from the deploy
(https:// and paths are stripped). "Sign in with Google" opens
`<host>/app/login?state=<32 random chars>` in `ASWebAuthenticationSession`. The app accepts only
`wmchat://auth?token=…&state=<same>`. It keeps the token in the Keychain (this device only, readable after first unlock,
so notification actions work while the phone is locked). Demo mode can be switched on here.

**Chats**: the conversation list (`GET /owner/conversations`) shows the name or "Visitor from <city>", a
dot when online, the last message ("You: …" for yours), the time, an unread badge, and
place · device · "Nth visit". Swipe right to mark read and left to block. Pull to refresh. The badge on the tab
and on the app icon is the total unread across conversations that aren't blocked.

**Thread**: Messages-style bubbles, with yours in the accent colour. Day/time headers appear after 15-minute gaps, and the page
a visitor wrote from is shown when it changes. When the visitor reads your latest message, "Read" appears under it. The typing dots show for 5 s
after each `typing` frame. Opening a thread marks it read (`POST …/read`). Sending uses
`POST …/messages`. The message shows as pending until it's confirmed, and a failed send gets a red retry button. The WebSocket echo is
de-duplicated. Your own typing goes out as a `typing` frame at most every 2 s. Tap the title for the
**visitor profile** (`GET /owner/visitor/{vid}`): visits, first and last seen,
devices, referrers, pages, IPs, the block toggle and the vid.

**On the site now**: at the top of Chats, from `GET /owner/online`. Each person shows their page and device, with a **Say hi** button that opens their thread with a greeting ready.

**Settings**:
- Available toggle and visit notifications (All / Returning only / Off).
- Greeting.
- Notification permission and device registration status.
- "Send test message/visit notification" (`POST /owner/test-push`).
- Open the inbox in Safari, the real-time connection state, Demo mode and Sign out. Sign out does `DELETE /owner/devices/{token}` and clears the Keychain.

## Real time

The app connects to the address and ticket from `POST /owner/ticket`, with `?role=owner&ticket=…`. A ping
confirms the connection is open, and another ping every 45 s finds dead connections. The app reconnects with backoff (1, 2, 4 … 30 s), connects when it comes to the foreground
and disconnects in the background. When a visitor message arrives, `message.caf` plays (the `.ambient` audio
session respects the silent switch). A visitor coming online gives a light haptic.

## Push

The app asks for alert, sound and badge permission once the main UI shows. Time-sensitive delivery comes from the
`com.apple.developer.usernotifications.time-sensitive` entitlement; the old `.timeSensitive`
authorization option is deprecated. It registers with APNs and sends `POST /owner/devices {token, env, name}`
on every launch or foreground.

- **Categories:** `MESSAGE` has REPLY (text input, needs the phone unlocked) and READ. `VISIT` has SAY_HI (foreground).
- **Background actions:** REPLY and READ run in the background against the owner API with the Keychain token, then the badge is refreshed.
- **Opening:** tapping a notification, or SAY_HI, opens that visitor's thread (custom keys `kind` / `vid`).
- **While the app is open:** notifications still show as a banner with sound. A message push for the thread on screen is suppressed. A message push while the WebSocket is connected shows silently, because the socket already played the sound.

## Demo mode

Turn it on from Setup or Settings, or launch with `-demoMode YES`. A `DemoBackend` behind the same
`ChatBackend` protocol as the live backend provides sample conversations and visitors.
A short script then plays out: a visitor types and writes, new visitors arrive, and after you send a message the visitor reads it and sometimes
replies. The test notification buttons schedule local notifications shaped like the server's pushes (same categories,
sounds and keys), so Reply, Mark read and deep links can be tried. Nothing goes over the network.

Debug-only launch arguments for screenshots: `-screenshotTab settings`,
`-screenshotThread <vid>` and `-screenshotNoPrompt YES` (skips the notification prompt).

## Layout

```
project.yml                  XcodeGen spec (entitlements, Info.plist, sound sync phase)
Config.xcconfig              committed defaults; includes your Local.xcconfig
WMChat/App                   app entry, AppModel (state + events), push/notification delegate
WMChat/Networking            OwnerAPI (HTTP), ChatBackend protocol, LiveBackend + OwnerSocket
WMChat/Demo                  DemoBackend + sample data
WMChat/Model                 contract types (lenient decoding)
WMChat/Views                 Setup, Chats, Thread, Visitor profile, Settings
WMChat/Support               config, Keychain, formatting, sounds/haptics, Theme.swift (every colour and the font)
scripts/                     make_icon.swift, sync_sounds.sh
```
