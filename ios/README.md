# Simplex Vault — native iOS app

A native **SwiftUI** client for the Simplex **Database / file vault**. It talks to your
running Simplex server (default `https://data.guythatlives.net`) over its normal HTTPS
API — the server keeps doing all the encryption/decryption, so the app never handles
keys; it just shows the plaintext bytes the server returns to your authenticated
session.

Only the **vault** is implemented (browse, view, upload, manage) — not Trading, Music,
AI, Neural, Visual, etc.

## What it does

- **Sign in** with your Simplex username + password, including the **TOTP two-auth**
  step if your account has it enabled.
- **Bottom tab bar** — Files, Recents, Search, Account — styled to match the Simplex look
  (monospace metadata, colored type badges, colored folder tiles).
- **Browse** folders (grid or list). **Recents** lists files newest-first; **Search**
  filters the whole vault by name with recent-search chips.
- **View** files: text/code/markdown documents, and a **fullscreen media gallery** for
  photos & videos — swipe left/right through every image/video in the same folder,
  pinch-to-zoom photos, and an **AirPlay** button to cast a video to a TV.
- **Convert** vault media/images to another format (e.g. **mp4 → mov**, wav → mp3,
  png → jpg) — runs on the server (ffmpeg) and saves the result back into your vault,
  with live progress. Right-click a file → **Convert…**.
- **Upload** from the **Photos** library or the **Files** app. Big files use Simplex's
  chunked upload protocol automatically. The **first upload** shows the Terms of Service,
  which you must accept before adding content.
- **Manage**: new folder, rename, star/unstar, move between folders, move to Trash,
  restore, and delete-forever (from Trash).
- **Save / Share** any file out to the iOS share sheet (save to Files, AirDrop, etc.).
- **Privacy screen** — the vault is hidden whenever the app leaves focus (so it never
  shows in the app switcher) and requires **Face ID / passcode** to reveal on return.
  Toggle under Account → Security.
- **Appearance** — pick accent color, theme, background ambience, fonts, and default
  view; changes apply live and sync to your account, staying consistent with the web app.
- **Server picker** (login screen → "Server", or Account → "Server") to point the app
  at a different Simplex URL without rebuilding.

## Important: you can't build an `.ipa` on Windows

A native iOS app can only be compiled by **Xcode, which only runs on macOS**. This repo
was written on Windows, so the `.ipa` is produced by a **free GitHub Actions macOS
runner** instead — no Mac needed on your end. Sideloadly (on your PC) then signs the
`.ipa` with your Apple ID when it installs it, so the CI build is intentionally
**unsigned**.

## Getting the `.ipa` (GitHub Actions, no Mac)

1. Push this project to a GitHub repo. Two layouts both work:
   - **Whole Simplex repo:** move `ios/.github/workflows/ios.yml` to
     `.github/workflows/ios.yml` at the **repo root** (GitHub only runs workflows found
     there). The workflow already `cd`s into `ios/`.
   - **Just this folder as its own repo:** push the contents of `ios/` and the workflow
     runs as-is (its path is already `.github/workflows/ios.yml`).
2. In GitHub → **Actions** tab → **Build unsigned IPA** → it runs on push, or click
   **Run workflow** to trigger it by hand.
3. When it finishes (a few minutes), open the run and download the
   **`SimplexVault-unsigned-ipa`** artifact. Unzip it to get `SimplexVault-unsigned.ipa`.

## Installing with Sideloadly (Windows)

1. Open **Sideloadly**, plug in your iPhone.
2. Drag `SimplexVault-unsigned.ipa` onto Sideloadly (or browse to it).
3. Enter your **Apple ID** — Sideloadly signs the app with it. (A free Apple ID works;
   free-signed apps expire after 7 days and must be re-installed — a paid developer
   account lasts a year.)
4. Install. On the phone: **Settings → General → VPN & Device Management** → trust your
   Apple ID developer profile.
5. Launch **Simplex Vault**, sign in, and you're in your vault.

## Building on a Mac (if you have one)

```bash
cd ios
open SimplexVault.xcodeproj      # then set your Team under Signing & Capabilities and Run
# or, unsigned archive from the command line:
xcodebuild -project SimplexVault.xcodeproj -scheme SimplexVault \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -archivePath build/SimplexVault.xcarchive archive \
  CODE_SIGNING_ALLOWED=NO
```

## Notes / gotchas

- **Session end after a server restart.** Simplex's per-user-keys design means that
  after the server restarts, an otherwise-valid session is rejected until you sign in
  again (the server returns a `KEY` 401). The app detects this and drops you back to the
  login screen — just sign in again.
- **HTTPS only.** App Transport Security is on. If you ever point the app at a plain
  **http://** LAN address for testing, add an ATS exception in `Info.plist`.
- **Bundle id** is `net.guythatlives.simplexvault` — change it in the project's build
  settings (or `gen_pbxproj`'s `BUNDLE_ID`) if you want a different one.
- **Deployment target** is iOS 16.0.

## Project layout

```
ios/
  SimplexVault.xcodeproj/         hand-generated Xcode project + shared scheme
  SimplexVault/
    SimplexVaultApp.swift         @main entry + root routing + audio session
    Models.swift                  FileItem + Account decoders (tolerant of the API's loose JSON)
    API.swift                     networking, session cookie, login/2FA, CRUD, convert, prefs, ToS
    Uploader.swift                single-shot + chunked upload
    Store.swift                   app state (auth, file tree, mutations, uploads, ToS gate)
    Theme.swift                   live palette proxy + type badges/tints + formatters
    Appearance.swift              appearance model mirroring the web PREFS keys
    AppearanceView.swift          in-app appearance settings (accent/theme/ambience/fonts)
    LoginView.swift               sign-in + 2FA + server picker
    VaultView.swift               tab bar shell + folder browser + context actions
    RecentsSearchViews.swift      Recents + Search tabs
    FileViewer.swift              document viewer (+ single image/video/audio fallback)
    MediaGallery.swift            fullscreen swipe gallery + AirPlay route picker
    ConvertSheet.swift            format-conversion UI (server ffmpeg)
    PrivacyScreen.swift           blur-on-background + Face ID gate + ToS sheet
    Thumbnail.swift               cookie-authenticated image loader + cache
    AccountView.swift             account, storage breakdown, Face ID, Starred, Trash
    MovePicker.swift              move-to-folder picker + upload tray
    Pickers.swift                 Photos + Files pickers
    Assets.xcassets/              app icon (generated), accent + launch colors
    Info.plist
  .github/workflows/ios.yml       macOS CI that outputs the unsigned .ipa
```
