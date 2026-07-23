/* ============================================================
   GUIDE (guide.js) — the in-app wiki/documentation, extracted from app.js and
   loaded on demand the first time the Guide view opens (see _render → state.view
   ==="docs" → loadFeature("guide")). Plain (non-module) script sharing app.js
   global scope: it DEFINES docsHTML + wireDocs + the DOCS wiki dataset and SEES
   core helpers (svg/esc/state/_render/…). The DOCS array is large static content
   that most sessions never open, so keeping it off the boot path is a clean win.
   ============================================================ */
/* ============================================================
   GUIDE / DOCUMENTATION PANEL
   ============================================================ */
let docsPage = 'welcome';
/* The guide is a small wiki: CHAPTERS → PAGES → numbered SECTIONS. Every page
   carries several topics; sections get anchors so the "On this page" contents
   box can jump to them. Content is static HTML in template strings (same voice
   as the old 8-topic guide, bulked out to cover the whole app). */
const DOCS = [
  { chapter: 'Start here', pages: [

    { id: 'welcome', title: 'Welcome to Simplex', icon: 'home',
      blurb: 'What this place is, how it is laid out, and how to read this wiki.',
      related: ['account', 'privacy', 'files'], sections: [
      { id: 'what', h: 'What Simplex is', body: () => `
        <p>Simplex is a <b>private, self-hosted vault and workspace</b>. Your files live encrypted on hardware the owners run themselves — not scattered across some big cloud. Everything you upload is encrypted before it touches the disk, and only you (and anyone you explicitly share with) can see it.</p>
        <div class="doc-cards">
          <div class="doc-card">${svg('lock', 18)}<div><b>Encrypted at rest</b><span>Every file and its details are encrypted on disk.</span></div></div>
          <div class="doc-card">${svg('files', 18)}<div><b>Your own vault</b><span>Each account has a separate, isolated space.</span></div></div>
          <div class="doc-card">${svg('share', 18)}<div><b>Share when you choose</b><span>Create read-only links; revoke them anytime.</span></div></div>
        </div>` },
      { id: 'tour', h: 'The Database at a glance', body: () => `
        <p>The Database app is where your files live. The <b>sidebar</b> holds All files, the Library categories (Films, Music, Photos, Documents), your <b>Tags</b>, any folders you've <b>pinned</b>, Starred, Trash, and the storage meter. The <b>top bar</b> has search, the grid/list toggle, sorting, and the breadcrumb trail — which doubles as a drop target for moving things up the tree.</p>` },
      { id: 'apps', h: 'More than files', body: () => `
        <p>The launcher holds the other apps: <b>AI</b> (chat with models, hosted or fully local), <b>Notes</b>, <b>Code</b>, <b>Tools</b> (in-browser utilities), <b>Music</b> (a shared library you can listen to together), <b>Neural</b> (train your own language model), <b>Analytics</b> (your private usage log), <b>Trading</b>, <b>Bug Reports</b>, <b>Connectors</b>, and <b>Settings</b>. Each gets its own topic later in this wiki.</p>` },
      { id: 'yours', h: 'Make it yours', body: () => `
        <p>Under <b>Settings → Appearance</b> you can pick light or dark themes, ambient background effects, UI and text scale, corner roundness, motion reduction, and layout density. All of it is saved to <i>your account</i>, so your look follows you between devices.</p>` },
      { id: 'phone', h: 'On your phone', body: () => `
        <p>Simplex works in any modern mobile browser — the layout adapts, panels become bottom sheets, and notches and home-bars are respected. If your connection starts dragging, a small <b>lag bar</b> appears at the bottom to tell you what's going on (and quietly holds off on heavy artwork until things recover).</p>` },
      { id: 'wiki', h: 'How to read this wiki', body: () => `
        <p>Pick a page on the left, use the <b>search box</b> to filter pages by anything in their text, and use the <b>contents box</b> at the top of each page to jump between its topics. Links at the bottom lead to related pages.</p>
        <p class="doc-tip">Nothing in this guide changes your data — it's just reading material.</p>` },
    ]},

    { id: 'account', title: 'Your account', icon: 'user',
      blurb: 'Signing in and out, account types, and what to do if you are locked out.',
      related: ['security', 'privacy'], sections: [
      { id: 'signin', h: 'Signing in', body: () => `
        <p>You sign in with a <b>username and password</b>. Your password is never stored directly; the server keeps only a one-way <span class="mono">scrypt</span> hash, so even someone holding the database can't read it back. If your password is weak (yes, "1234" counts), Simplex will stop you at sign-in and ask you to pick a better one before continuing.</p>` },
      { id: 'signout', h: 'Signing out', body: () => `
        <p>Open the account menu (bottom-left) → <b>Sign out</b>. You'll land back on the login screen. Signing out is deliberate: with two-auth on, it also <b>untrusts the device</b> you're on, so the next sign-in from it needs a fresh code — exactly what you want on a shared computer.</p>` },
      { id: 'types', h: 'Account types', body: () => `
        <ul>
          <li><b>Admin</b> — can create, edit, and delete <i>all</i> accounts, set each one's storage limit and permissions, and see the security screen. Account menu → <i>Manage accounts</i>.</li>
          <li><b>Member</b> — can edit only their own account: display name, password, safety settings, appearance.</li>
        </ul>` },
      { id: 'myaccount', h: 'My account', body: () => `
        <p>Account menu → <b>My account</b> lets you change your display name and password. With two-auth enabled, changing your password or recovery email also asks for a 6-digit code — a stolen session alone can't quietly take over your account.</p>` },
      { id: 'joining', h: 'Getting an account', body: () => `
        <p>New accounts can be requested from the sign-in screen. Requests are <b>queued for admin approval</b> — an admin reviews and accepts (or declines) each one, so the vault never fills with strangers.</p>` },
      { id: 'forgot', h: 'Forgot your password?', body: () => `
        <p>Use <b>Forgot password?</b> on the sign-in screen. The admins are pinged with your recovery email and can generate a <b>one-time reset code</b> for you (codes expire after 24 hours). Enter the code with a new password and you're back in.</p>
        <p class="doc-tip">Adding a recovery email under Settings → Safety is what makes this painless — do it before you need it.</p>` },
    ]},
  ]},

  { chapter: 'Privacy & safety', pages: [

    { id: 'privacy', title: 'Your eyes only', icon: 'eye',
      blurb: 'The heart of Simplex: what is encrypted, who can see what, and what never leaves the vault.',
      related: ['security', 'sharing', 'habits'], sections: [
      { id: 'promise', h: 'The promise', body: () => `
        <p><b>Your content is only for your eyes.</b> Your files aren't scanned for advertising, aren't sold, aren't fed to third parties, and aren't visible to other members. Each account's data is <b>cryptographically isolated</b> with its own derived keys — another account's key simply cannot open your files.</p>
        <p>Simplex is built to be a service that <b>stores what it cannot casually read</b>: on disk there is only scrambled ciphertext, and anything you seal with a personal passphrase (see below) can't be opened by the server at all.</p>` },
      { id: 'atrest', h: 'Encrypted at rest', body: () => `
        <p><b>Everything</b> is encrypted before it touches the disk: file contents, file names, and details like artist or album. Someone with raw access to the server's drives sees only scrambled data.</p>
        <ul>
          <li><b>Files</b> are encrypted with two layers of AES-256, in a way that keeps videos and music seekable — you can still scrub to the middle of a film instantly.</li>
          <li><b>Text &amp; names</b> use two layers of authenticated AES-256-GCM, so tampering is detectable, not just unreadable.</li>
        </ul>` },
      { id: 'keychain', h: 'Not one key — a keychain', body: () => `
        <p>Simplex doesn't encrypt everyone under one shared key. <b>Every account has its own personal key</b>, and that key exists at rest only <b>sealed under your password</b>. Not the admins, not the server's master key, not someone who stole the whole disk — nobody can open your files without something only you know. One account's keys can never be worked backwards into another's; if a single account's keys were somehow exposed, <b>every other vault stays sealed</b>.</p>
        <p>On top of that sits an optional second layer: the <b>personal passphrase lock</b> (two topics down) for individual files. And beneath it all sits the master key — covered next.</p>` },
      { id: 'keys', h: 'Where the keys live', body: () => `
        <p>Your personal key is random, created at your first sign-in, and stored only <b>wrapped</b>: your password (stretched through slow, brute-force-resistant math and mixed with the server's master key) is what unseals it. While you're signed in, the unsealed key lives in server memory only — never on disk, never in your browser. After a server restart you sign in once and it's back.</p>
        <p>The <b>master key</b> still matters: it protects system data, the shared Music library, and any <i>Legacy</i> files (next topic) — and it's one of the ingredients in your key's wrapping. <b>If it's lost with no backup, data is unrecoverable</b>, which is why admins are told to back it up. But on its own it can no longer read your files.</p>` },
      { id: 'legacy', h: 'Legacy files & re-encryption', body: () => `
        <p>Files stored before your account got its personal key are marked <b>Legacy</b> — they're still protected (encrypted under the master-derived account keys), just not yet under <i>your</i> key. Legacy files stay fully <b>watchable and readable</b>; only editing and downloading ask you to upgrade first.</p>
        <ul>
          <li><b>One file at a time:</b> right-click → <i>Re-encrypt…</i> (or accept the prompt when you try to download/edit). Takes a moment; the file doesn't change.</li>
          <li><b>Everything at once:</b> Settings → Safety → <i>Re-encrypt vault</i>. Your vault locks down behind a progress screen while every file moves to your key — minutes for most vaults.</li>
        </ul>
        <p class="doc-tip">Your account also has a <b>recovery key</b>, sealed inside your vault — you'll never be asked to manage it. If you want a copy (recommended!), reveal it once via Settings → Safety → <i>View key</i> and store it in a password manager. If you forget your password, it's the only way back in — a lost password with no saved recovery key means the files under your key are gone for good. That's not a bug; it's the promise.</p>` },
      { id: 'transit', h: 'In transit', body: () => `
        <p>On the web address, traffic runs over <b>HTTPS through Cloudflare</b>, and every file uploaded or downloaded passes through all of Cloudflare's checks — protection for both sides: you (client/user) and the server (owners). Decrypted file data is never cached by the network. On your home network you can also connect <b>directly by LAN address</b>, where nothing leaves the building at all.</p>` },
      { id: 'lock', h: 'A second lock only you hold', body: () => `
        <p>Any file or folder can carry its own passphrase on top of the vault encryption. Right-click → <b>Encrypt…</b> and choose a passphrase; the locking happens <b>in your browser</b> with AES-256-GCM, and the passphrase is never sent to the server. <b>Unlock…</b> opens it temporarily for this session; <b>Decrypt…</b> removes the extra lock for good.</p>
        <p class="doc-tip">Sealed this way, a file is unreadable even to the server and its admins. The flip side: forget the passphrase and <b>nobody</b> can recover it. There is no reset.</p>` },
      { id: 'admins', h: "What admins can and can't see", body: () => `
        <p>Admins manage accounts, storage limits, and security — the app gives them <b>no button to browse your vault</b>, and your files sit under a key that <b>only your password unseals</b>, so even direct access to the server's disks and master key reads nothing of yours. Your Analytics log is private to your account. Passphrase-locked files go one step further still: sealed even while you're signed in.</p>` },
      { id: 'leaves', h: 'What leaves the vault', body: () => `
        <p>Nothing, unless you make it: a <b>download</b> puts a decrypted copy on your device, and a <b>share link</b> exposes exactly the item you shared, read-only. The AI organizer learns only from how <i>you</i> arrange your own files, on the server. One honest exception to know about: the AI app's <b>Online</b> tab talks to hosted models over the internet — what you type in that chat goes to the model's provider. Use the <b>Local</b> tab when even that is too much; local models run entirely on the server's own hardware.</p>` },
    ]},

    { id: 'security', title: 'Account security', icon: 'lock',
      blurb: 'Safety levels, two-auth, trusted devices, and what happens to password guessers.',
      related: ['account', 'habits'], sections: [
      { id: 'levels', h: 'Safety levels', body: () => `
        <p><b>Settings → Safety</b> shows a three-step safety bar: <b>Minimal</b> (password only), <b>Moderate</b> (adds a recovery email), and <b>Maximum</b> (adds two-auth). Each step makes both takeover and lockout less likely — Maximum is worth the two minutes it takes.</p>` },
      { id: 'twoauth', h: 'Two-auth', body: () => `
        <p>Two-auth ties your account to an authenticator app. Setup shows a <b>QR code</b> (or a copyable text secret), verifies a 6-digit code, and finishes with a quick human check. Afterwards, signing in from an <b>unknown device or address</b> requires a fresh code — so a stolen password alone gets an attacker nowhere. You can regenerate the secret anytime if you think it leaked.</p>` },
      { id: 'trusted', h: 'Trusted devices', body: () => `
        <p>Devices you sign in from regularly stay trusted, so you're not typing codes all day. Signing out manually <b>untrusts</b> that device on purpose. New devices, new networks, or long absences put the code check back in the way.</p>` },
      { id: 'guessing', h: 'What happens to password guessers', body: () => `
        <p>Repeated wrong sign-ins are slowed down, then locked out, and persistent offenders earn a <b>durable address ban</b> with a full-screen countdown. You don't have to do anything — the server watches for this on its own.</p>` },
      { id: 'recovery', h: 'Recovery, the safe way', body: () => `
        <p>Password resets are <b>admin-mediated</b>: you request one, an admin issues a one-time code (expires in 24 hours), and you set a new password with it. There's no self-serve email link that an attacker could intercept and replay.</p>` },
      { id: 'pwkeys', h: 'Your password vs. your keys', body: () => `
        <p>Your password does two jobs: it <b>guards the door</b> (the server keeps only a one-way hash), and it <b>wraps your personal encryption key</b> (see <i>Your eyes only → Not one key — a keychain</i>). Changing your password is still instant — nothing re-encrypts, because the key itself never changes, only its wrapping.</p>
        <p>By design, the wrapping does <b>not</b> follow a password change automatically: you <b>swap</b> it yourself (we offer it right after the change, and it waits in Settings → Safety). Until you swap, your key still answers to your <i>previous</i> password — so at your next fresh sign-in, Simplex asks for it once (or your recovery code) and moves the key over.</p>
        <p class="doc-tip">Forgot your password entirely? An admin reset code gets you through the door, and your <b>recovery key</b> (Settings → Safety → <i>View key</i> — worth saving a copy ahead of time) gets your files back. Without it, files under your personal key are unrecoverable — nobody, including admins, can open them. Files still marked Legacy survive either way.</p>` },
    ]},

    { id: 'habits', title: 'Good habits', icon: 'check',
      blurb: 'Small routines that keep your account and the vault healthy.',
      related: ['privacy', 'storage', 'admins'], sections: [
      { id: 'everyone', h: 'For everyone', body: () => `
        <ul>
          <li>Use a <b>strong, unique password</b> — and change it if you suspect it's known.</li>
          <li>Turn on <b>two-auth</b> (Settings → Safety). It's the single biggest upgrade.</li>
          <li><b>Sign out</b> on shared computers — it untrusts the device too.</li>
          <li>Skim your <b>share links</b> now and then and delete ones you no longer need.</li>
        </ul>` },
      { id: 'space', h: 'Mind your space', body: () => `
        <p>Trash still counts against your quota until you empty it. If the sidebar meter creeps up, empty the Trash first — then look for forgotten giant files (sort by size).</p>` },
      { id: 'passphrases', h: 'Passphrase-locked files', body: () => `
        <p>The personal passphrase lock is absolute: no reset, no recovery, not even for admins. Keep those passphrases in a password manager, and think twice before sealing something irreplaceable.</p>` },
      { id: 'isnot', h: 'What Simplex is not', body: () => `
        <p>It isn't a sync client, a public CDN, or a backup by itself — encryption protects <i>privacy</i>, not against a failed disk. It's a private vault you control: data leaves only when you download it or share a link.</p>` },
    ]},
  ]},

  { chapter: 'Everyday use', pages: [

    { id: 'files', title: 'Files & organization', icon: 'files',
      blurb: 'Browsing, selecting, tagging, pinning, and letting the AI help you file things.',
      related: ['transfer', 'viewing', 'sharing'], sections: [
      { id: 'browse', h: 'Browsing', body: () => `
        <p>Use the sidebar to jump to <b>All files</b>, the <b>Library</b> categories (Films, Music, Photos, Documents), <b>Starred</b>, or <b>Trash</b>. Switch between grid and list view with the toggle in the top bar, and sort by name, size, kind, date — or tag.</p>` },
      { id: 'search', h: 'Search', body: () => `
        <p>The top-bar search covers your whole vault; open a folder first and it narrows to that folder. Results respect names and tags.</p>` },
      { id: 'select', h: 'Selecting & moving', body: () => `
        <ul>
          <li>Click to select; <span class="mono">Shift</span>/<span class="mono">Ctrl</span>-click for ranges and multi-select; <span class="mono">Ctrl/⌘+A</span> selects all.</li>
          <li>Drag items onto a folder (or a breadcrumb) to move them. Cut/Copy/Paste and Duplicate live on the right-click menu and the usual keyboard shortcuts.</li>
          <li><b>Right-click</b> anything for Open, Download, Rename, Move, Share, Star, and more.</li>
        </ul>` },
      { id: 'tags', h: 'Tags', body: () => `
        <p>Right-click → <b>Tags</b> to label any file or folder. The sidebar's <b>Tags</b> view collects everything by label, and search and sorting understand tags too. Tags are yours alone — they're part of your account's data like everything else.</p>` },
      { id: 'pins', h: 'Pins & stars', body: () => `
        <p><b>Pin</b> a folder to keep it one click away in the sidebar; <b>star</b> anything to collect it under Starred. Both are per-account preferences and follow you between devices.</p>` },
      { id: 'aistore', h: 'The AI Store', body: () => `
        <p>After an upload, small chips may suggest a <b>folder to file it in</b> and <b>tags to add</b> — learned from how you've organized your own vault, nothing else. Right-click → <b>AI Store…</b> shows the full set with confidence levels and an <b>Apply all</b> button. Nothing is ever applied automatically; you decide. Passphrase-locked files are left alone entirely.</p>` },
      { id: 'metadata', h: 'Metadata', body: () => `
        <p>Right-click → <b>Edit Metadata</b> shows what's embedded inside a file (camera EXIF, ID3 music tags…) and can <b>purge</b> it — images are re-encoded so the hidden data is truly gone, not just hidden. Music uploads auto-extract artist, album, and cover art so your library looks right from the start.</p>` },
      { id: 'trash', h: 'Trash', body: () => `
        <p>Deleting moves items to Trash first, where they can be restored. Emptying the Trash permanently removes them and frees the space. Trashing a shared item also disables its links.</p>` },
    ]},

    { id: 'transfer', title: 'Uploads & downloads', icon: 'upload',
      blurb: 'The upload screen, how big files travel, and what to do when something goes wrong.',
      related: ['files', 'storage'], sections: [
      { id: 'ways', h: 'Ways to upload', body: () => `
        <p>Click <b>Upload</b>, or <b>drag files onto the window</b>. Drag in a <b>whole folder</b> and its structure is recreated in your vault. A <b>.zip</b> uploads as-is; right-click it and choose <i>Extract here</i> to unpack it into a folder.</p>` },
      { id: 'screen', h: 'The upload screen', body: () => `
        <p>While a batch uploads, a full <b>upload screen</b> appears over a blurred backdrop: the file currently moving and <i>where it's going</i>, live <b>speed</b>, <b>ping</b>, <b>time left</b>, <b>data moved</b>, <b>connection type</b>, and a checklist of the whole batch. Minimize it to a small pill at the bottom (and expand it back) with the controls in the corner — it remembers which you prefer. Cancel works from either view.</p>` },
      { id: 'chunks', h: 'How big files travel', body: () => `
        <p>Simplex adapts to how you're connected. On a <b>direct LAN</b> connection there's no size cap and big files go up in large pieces, several at a time. Over the <b>secure web address</b>, large files are split into smaller chunks that fit the proxy's per-request limit. Either way the server reassembles the pieces (in any order), then encrypts and stores the file — and if one piece hiccups, only that piece retries.</p>` },
      { id: 'speed', h: 'Why speeds can differ', body: () => `
        <p>On the web address, <b>every byte in both directions runs through all of Cloudflare's checks</b> — that's deliberate protection for both you and the server, and it can cost a little speed versus a raw connection. On your home network, the direct LAN address skips the proxy entirely and is the fastest path.</p>` },
      { id: 'failures', h: 'If an upload fails', body: () => `
        <p>You get a plain-English explanation of what went wrong, not a shrug — and a one-tap <b>Send bug report</b> that hands the admins a full trace. Nothing partial is ever saved: an upload either lands whole and encrypted or not at all.</p>` },
      { id: 'downloads', h: 'Downloads', body: () => `
        <p>Right-click → <b>Download</b> (or the button in any viewer). Files are decrypted on the way out and arrive as the original file. Passphrase-locked items ask for their passphrase first — the unsealing happens in your browser.</p>` },
    ]},

    { id: 'viewing', title: 'Watching, listening & viewing', icon: 'play',
      blurb: 'Everything opens in-app: media, images, code, 3D models, even game files.',
      related: ['files', 'apps'], sections: [
      { id: 'video', h: 'Films', body: () => `
        <p>Videos play in-app with posters and instant seeking — scrub to any point and playback follows smoothly. Playback statistics and network handling are tuned so a flaky connection degrades gently instead of freezing.</p>` },
      { id: 'audio', h: 'Music playback', body: () => `
        <p>Music plays with cover art and a proper queue. The player's settings hide a <b>10-band equalizer</b> with a stack of presets and a custom slider editor — your EQ choice is saved to your account. Covers load in a quick low-res pass and sharpen when the connection allows, so audio always gets priority.</p>` },
      { id: 'images', h: 'Photos', body: () => `
        <p>Images open in a zoomable viewer. Purging camera metadata (location and all) is one right-click away — see <i>Files &amp; organization → Metadata</i>.</p>
        <p>High-quality <span class="mono">.exr</span> and <span class="mono">.tif</span>/<span class="mono">.tiff</span> images — the kind used for height and colour maps — are supported too. Browsers can't display them directly, so the server renders a preview you can view and thumbnail like any photo. Right-click one and pick <b>View as heightmap…</b> to see it as interactive 3D terrain, or <b>Convert to…</b> to turn it into (or out of) PNG, JPG, WebP, TIFF, or EXR.</p>` },
      { id: 'text', h: 'Text & code', body: () => `
        <p>Documents open in an editor; recognized code types get language treatment, and unknown types still open as raw text with a heads-up.</p>` },
      { id: 'models', h: '3D models', body: () => `
        <p><span class="mono">.gltf</span>, <span class="mono">.glb</span>, <span class="mono">.obj</span>, <span class="mono">.fbx</span>, and <span class="mono">.stl</span> files open in an interactive 3D viewer — orbit, zoom, inspect.</p>` },
      { id: 'game', h: 'Game files', body: () => `
        <p>Unreal Engine <span class="mono">.uasset</span> packages open in a read-only inspector that identifies what the asset actually is. UE <span class="mono">.sav</span> saves get a full <b>save editor</b> (right-click → <i>Edit Save…</i>) that edits values and writes the file back byte-perfect.</p>` },
      { id: 'convert', h: 'Convert & compress', body: () => `
        <p>Right-click media → <b>Convert to…</b> or <b>Compress…</b> to produce a new file in the format or size you need. The original stays untouched; the result saves alongside it.</p>` },
    ]},

    { id: 'sharing', title: 'Sharing links', icon: 'share',
      blurb: 'Read-only links you fully control — with rich previews where you paste them.',
      related: ['privacy', 'files'], sections: [
      { id: 'create', h: 'Creating a link', body: () => `
        <p>Right-click a file or folder → <b>Share…</b> → <b>Create link</b>. Anyone with the link can view it <b>read-only</b>, no login required. You choose whether downloads are allowed.</p>` },
      { id: 'previews', h: 'Rich previews', body: () => `
        <p>Paste a share link into Discord, iMessage, or social apps and it unfurls into a card — <b>videos and music play inline</b> right in the chat, images show a preview, all without anyone opening the link.</p>` },
      { id: 'control', h: 'Staying in control', body: () => `
        <ul>
          <li>Links are random and unguessable, and only ever expose the one item (or folder) you shared.</li>
          <li>Open the Share dialog anytime to <b>copy or delete</b> a link. Deleting instantly cuts off access.</li>
          <li>Trashing the shared item also disables its links.</li>
        </ul>` },
      { id: 'sees', h: 'What a visitor sees', body: () => `
        <p>Exactly the shared item and nothing more. A shared folder's breadcrumbs stop at that folder — visitors can't climb into the rest of your vault, can't search it, and can't tell what else exists.</p>` },
    ]},
  ]},

  { chapter: 'Apps', pages: [

    { id: 'apps', title: 'The apps', icon: 'grid',
      blurb: 'A tour of everything on the launcher beyond the Database.',
      related: ['api', 'viewing'], sections: [
      { id: 'music', h: 'Music', body: () => `
        <p>A <b>shared library</b> the whole vault contributes to, with public and private <b>playlists</b> and <b>jams</b> — synced listening sessions where everyone hears the same thing at the same time (if the host leaves, hosting passes to someone still listening). Adding a song copies it into the library, independent of anyone's vault, and you can pull any library song back into your own vault with <i>Save to my vault</i>. A quality setting keeps streaming smooth on slow connections.</p>` },
      { id: 'ai', h: 'AI', body: () => `
        <p>Chat with AI models in two flavors: <b>Online</b> (hosted models, streamed live) and <b>Local</b> (models that run on the server's own hardware — nothing you type leaves the machine). Local models can be added by the admins, or you can upload your own compatible model file to your vault and run it.</p>` },
      { id: 'neural', h: 'Neural', body: () => `
        <p>Train <b>your own language model from the ground up</b>. A short wizard lets you design a small transformer — pick the <b>tokenizer</b> (characters, subwords, words, or sentences), context length, embedding size, activation, dropout, and the hidden layer stack. Each model then opens on three tabs: <b>Data</b> (your pre-training and fine-tuning text — you can <b>stack</b> data in from templates or other models you've made), <b>Training</b> (a real optimizer — AdamW, RAdam, Lion, LAMB or SGD — with learning rate, batch size, epochs and a live loss curve), and <b>Inference</b> (a chat room with your creation).</p>
        <p>Don't want to start empty? Pick a <b>template</b> — a ready-made structure that ships with its own training data — and just hit train. You can also <b>upgrade</b> a model later to a bigger or smaller structure while keeping all its data. Everything runs in your browser by default; admins can enable server-side training per account. Models save into your encrypted vault like any other data.</p>` },
      { id: 'tools', h: 'Tools', body: () => `
        <p>A shelf of <b>in-browser utilities</b> — data converters, text tools, image helpers, QR codes, markdown-to-PDF, and more. They run entirely in your browser: nothing you paste into a tool is sent to the server.</p>` },
      { id: 'notescode', h: 'Notes & Code', body: () => `
        <p><b>Notes</b> is for rich, encrypted notes and docs. <b>Code</b> is an editor for editing and running code in your workspace. Both store their content in your vault, encrypted like everything else.</p>` },
      { id: 'analytics', h: 'Analytics', body: () => `
        <p>Your <b>private usage log</b>: sessions, uploads, app opens, tool use, file views, and active time, charted. It's per-account and for your eyes — other members can't see it, and it exists so <i>you</i> can see your own patterns.</p>` },
      { id: 'trading', h: 'Trading', body: () => `
        <p>An always-learning market model with a <b>sandbox</b> mode (paper money) and, where an admin has enabled it, a <b>live</b> mode connected to your own brokerage account. Simplex never holds your funds — live trading talks to your brokerage directly, and the sandbox is the default.</p>` },
      { id: 'misc', h: "Bug Reports, What's New & Connectors", body: () => `
        <p><b>Bug Reports</b> is the direct line to the admins — file an issue and they triage it in the same app. <b>What's New</b> (in the sidebar) is the changelog, written for humans. <b>Connectors</b> links outside services into your workspace. Admins also get a <b>Discord Bot</b> app — a voice assistant that can live in a Discord server.</p>` },
    ]},

    { id: 'api', title: 'Custom API', icon: 'key',
      blurb: 'Drive your vault from your own scripts, sites, and apps — free with every account.',
      related: ['apps', 'security'], sections: [
      { id: 'whatapi', h: 'What it is', body: () => `
        <p>The <b>Custom API</b> section (sidebar → System) issues API keys for your account. With a key, your own website, script, or app can list, upload, download, and play your files over a clean HTTP API — same encryption, same isolation, your rules.</p>` },
      { id: 'scopes', h: 'Scopes', body: () => `
        <p>Every key carries only the permissions you give it: <b>Read</b> (list files and metadata), <b>Download &amp; play</b> (stream contents, seeking supported), <b>Upload</b> (add files and folders), and <b>Delete</b> (move to Trash). A read-only key can never delete anything, no matter who holds it.</p>` },
      { id: 'keysafety', h: 'Treat keys like passwords', body: () => `
        <p>A key is as powerful as its scopes. Give each integration its own key with the <b>least</b> permissions it needs, and revoke keys you no longer use — revocation is instant.</p>` },
    ]},
  ]},

  { chapter: 'Limits & admin', pages: [

    { id: 'storage', title: 'Storage limits', icon: 'hdd',
      blurb: 'How quotas work and what actually counts against yours.',
      related: ['transfer', 'admins'], sections: [
      { id: 'quota', h: 'Your quota', body: () => `
        <p>Each account has a storage limit shown in the sidebar meter (used vs. total). The default is <b>200&nbsp;GB</b>, but an admin can set any limit per account — from a small <b>1&nbsp;GB</b> up to <b>300&nbsp;GB</b> or beyond.</p>` },
      { id: 'counts', h: 'What counts', body: () => `
        <p>Only your real files count; folders are free. Items in the <b>Trash still count</b> until you empty it. If an upload would exceed your limit, it's stopped up front — no partial file is ever saved.</p>` },
      { id: 'change', h: 'Changing a limit', body: () => `
        <p>Admins: account menu → <i>Manage accounts</i> → edit an account → set <b>Storage limit (GB)</b>. Members: ask an admin.</p>` },
    ]},

    { id: 'admins', title: 'For admins', icon: 'gear',
      blurb: 'Running the vault: accounts, security, restarts, and the one key that matters.',
      related: ['security', 'storage'], sections: [
      { id: 'manage', h: 'Manage accounts', body: () => `
        <p><i>Manage accounts</i> is the control room: create, edit, and delete accounts, set storage limits, grant per-account permissions (like server-side neural training), and approve pending <b>account requests</b> from the sign-in screen.</p>` },
      { id: 'seccenter', h: 'The Security section', body: () => `
        <p>Inside Manage accounts, <b>Security</b> shows per-username protection tiers, active address bans, and pending <b>password-reset requests</b> — each with a ready-made one-time code and an email draft to send back.</p>` },
      { id: 'restarts', h: 'Restarts', body: () => `
        <p>The server restarts itself on a <b>weekly schedule</b> you can customize (and you can trigger a manual restart anytime). Members see a friendly overlay that counts down and reconnects on its own — uploads and sessions aren't silently dropped mid-click.</p>` },
      { id: 'masterkey', h: 'The master key', body: () => `
        <p><b>Back it up.</b> The included key tool exports it; store the backup in a password manager or on an encrypted drive. Without the master key, the vault's data is unrecoverable by design — there is no vendor to call.</p>
        <p>Since the per-user-key update, the master key alone no longer reads members' files — each member's data sits under a key wrapped by <i>their</i> password. The master key still protects system data, the shared Music library, members' <b>Legacy</b> files, and is an ingredient in every key wrap — so it's exactly as critical to keep, and exactly less dangerous to lose control of.</p>` },
      { id: 'backups', h: 'Backups & the boring stuff', body: () => `
        <p>Keep copies of the <span class="mono">vault/</span> folder if the data matters — encryption protects privacy, not against a failed disk. Keep Cloudflare, HTTPS, and rate limiting on for the public address. The server keeps its own diagnostic log and a crash reporter, so when members hit something odd, Bug Reports usually already has the story.</p>` },
    ]},
  ]},
];

function docPages() { return DOCS.flatMap(c => c.pages); }
/* plain-text cache of section bodies so guide search can match body text cheaply */
const _docTextCache = new Map();
function _docPlain(sec) {
  let t = _docTextCache.get(sec);
  if (t == null) { const d = document.createElement('div'); d.innerHTML = sec.body(); t = d.textContent.toLowerCase(); _docTextCache.set(sec, t); }
  return t;
}
function docMatches(p, q) {
  if (!p) return false;
  if (p.title.toLowerCase().includes(q)) return true;
  return p.sections.some(s => s.h.toLowerCase().includes(q) || _docPlain(s).includes(q));
}

function docsHTML() {
  const pages = docPages();
  const cur = pages.find(p => p.id === docsPage) || pages[0];
  const chap = DOCS.find(c => c.pages.includes(cur));
  const idx = pages.indexOf(cur);
  const prev = pages[idx - 1], next = pages[idx + 1];
  const topics = pages.reduce((s, p) => s + p.sections.length, 0);
  const seeAlso = (cur.related || []).map(id => pages.find(p => p.id === id)).filter(Boolean);
  return `<div class="pad docs-pad" data-screen-label="Guide">
    <div class="section-head"><h1>Guide</h1><span class="sub">The Simplex wiki — ${pages.length} pages · ${topics} topics</span></div>
    <div class="docs-layout">
      <nav class="docs-nav">
        <input id="docsSearch" class="docs-search" type="search" placeholder="Search the guide…" autocomplete="off" aria-label="Search the guide">
        ${DOCS.map(c => `<div class="docs-chap">
          <div class="docs-chap-h eyebrow">${esc(c.chapter)}</div>
          ${c.pages.map(p => `<button class="docs-navitem ${p.id === cur.id ? 'active' : ''}" data-doc="${p.id}">${svg(p.icon, 16, 1.8)}<span>${esc(p.title)}</span></button>`).join('')}
        </div>`).join('')}
      </nav>
      <article class="docs-content">
        <div class="docs-crumb mono">${esc(chap.chapter)} <span class="sep">/</span> ${esc(cur.title)}</div>
        <h2>${esc(cur.title)}</h2>
        ${cur.blurb ? `<p class="docs-blurb">${esc(cur.blurb)}</p>` : ''}
        <div class="docs-toc">
          <div class="docs-toc-h eyebrow">On this page</div>
          <ol>${cur.sections.map(s => `<li><button data-sec="${s.id}">${esc(s.h)}</button></li>`).join('')}</ol>
        </div>
        <div class="docs-body">
          ${cur.sections.map((s, i) => `<section class="docs-sec" id="docsec-${s.id}">
            <h3><span class="docs-secn mono">${i + 1}</span>${esc(s.h)}</h3>${s.body()}</section>`).join('')}
        </div>
        ${seeAlso.length ? `<div class="docs-see"><span class="eyebrow">See also</span><div class="docs-see-row">${seeAlso.map(r =>
          `<button class="docs-see-chip" data-doc="${r.id}">${svg(r.icon, 13)}${esc(r.title)}</button>`).join('')}</div></div>` : ''}
        <div class="docs-pager">
          ${prev ? `<button class="docs-pgr" data-doc="${prev.id}"><span class="eyebrow">← Previous</span><b>${esc(prev.title)}</b></button>` : '<span></span>'}
          ${next ? `<button class="docs-pgr next" data-doc="${next.id}"><span class="eyebrow">Next →</span><b>${esc(next.title)}</b></button>` : '<span></span>'}
        </div>
      </article>
    </div>
  </div>`;
}
function wireDocs() {
  const content = document.getElementById('content');
  // page navigation (nav items, see-also chips, prev/next pagers all carry data-doc)
  content.querySelectorAll('[data-doc]').forEach(b => b.onclick = () => {
    docsPage = b.dataset.doc;
    const q = document.getElementById('docsSearch')?.value || '';
    content.innerHTML = docsHTML(); wireDocs();
    const inp = document.getElementById('docsSearch');
    if (inp && q) { inp.value = q; inp.dispatchEvent(new Event('input')); }
    content.scrollTo(0, 0);
    content.querySelector('.docs-content')?.scrollTo(0, 0);
  });
  // contents-box jumps
  content.querySelectorAll('[data-sec]').forEach(a => a.onclick = () => {
    document.getElementById('docsec-' + a.dataset.sec)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  // live search: filters the nav by title, headings, or body text (no re-render,
  // so the input keeps focus while typing)
  const inp = document.getElementById('docsSearch');
  if (inp) inp.oninput = () => {
    const q = inp.value.trim().toLowerCase();
    const pages = docPages();
    content.querySelectorAll('.docs-navitem').forEach(btn =>
      btn.classList.toggle('hidden', !!q && !docMatches(pages.find(x => x.id === btn.dataset.doc), q)));
    content.querySelectorAll('.docs-chap').forEach(ch =>
      ch.classList.toggle('hidden', !!q && !ch.querySelector('.docs-navitem:not(.hidden)')));
  };
}
