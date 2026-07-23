import Foundation
import AVFoundation
import UserNotifications

/// A pickable notification sound. `file` is the bundled resource name (a short .caf in
/// the app bundle); `nil` means the system default. The special `.silent` case delivers
/// with no sound (banner only).
struct NotifSound: Identifiable, Hashable {
    let id: String
    let name: String
    let file: String?      // e.g. "chime.caf"; nil = system default; "" = silent
    let symbol: String

    /// The UNNotificationSound to attach to a notification (nil for silent).
    var unSound: UNNotificationSound? {
        switch id {
        case "silent":  return nil
        case "default": return .default
        default:        return file.map { UNNotificationSound(named: UNNotificationSoundName($0)) } ?? .default
        }
    }

    static let all: [NotifSound] = [
        NotifSound(id: "default",  name: "Default",  file: nil,           symbol: "bell"),
        NotifSound(id: "chime",    name: "Chime",    file: "chime.caf",   symbol: "bell.badge"),
        NotifSound(id: "ping",     name: "Ping",     file: "ping.caf",    symbol: "dot.radiowaves.right"),
        NotifSound(id: "marimba",  name: "Marimba",  file: "marimba.caf", symbol: "music.note"),
        NotifSound(id: "bloom",    name: "Bloom",    file: "bloom.caf",   symbol: "sparkles"),
        NotifSound(id: "alert",    name: "Alert",    file: "alert.caf",   symbol: "exclamationmark.triangle"),
        NotifSound(id: "silent",   name: "Silent (banner only)", file: "", symbol: "bell.slash"),
    ]
    static func by(_ id: String) -> NotifSound { all.first { $0.id == id } ?? all[0] }

    /// Play the sound locally so the user can preview it in the picker (uses the same
    /// .caf file; the system default has no preview file so we fall back to a system click).
    static func preview(_ sound: NotifSound) {
        if let file = sound.file, !file.isEmpty,
           let url = Bundle.main.url(forResource: (file as NSString).deletingPathExtension, withExtension: "caf") {
            PreviewPlayer.shared.play(url)
        } else if sound.id == "silent" {
            // nothing to play
        } else {
            // system default: a light haptic-adjacent system sound as a stand-in preview
            AudioServicesPlaySystemSound(1007)
        }
    }
}

/// Tiny AVAudioPlayer holder so preview sounds don't get deallocated mid-play.
final class PreviewPlayer {
    static let shared = PreviewPlayer()
    private var player: AVAudioPlayer?
    func play(_ url: URL) {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
            try AVAudioSession.sharedInstance().setActive(true)
            player = try AVAudioPlayer(contentsOf: url)
            player?.play()
        } catch {
            AudioServicesPlaySystemSound(1007)
        }
    }
}

/// User-chosen Habit notification behavior, persisted in UserDefaults. Read by
/// `HabitNotifications` when scheduling and by the settings UI.
@MainActor
final class HabitNotifPrefs: ObservableObject {
    static let shared = HabitNotifPrefs()

    @Published var enabled: Bool { didSet { UserDefaults.standard.set(enabled, forKey: Keys.enabled) } }
    @Published var soundId: String { didSet { UserDefaults.standard.set(soundId, forKey: Keys.sound) } }
    /// Deliver as Time Sensitive so Simplex breaks through Focus/summaries and shows up
    /// prominently (Apple's interruption level). Degrades to normal without the entitlement.
    @Published var timeSensitive: Bool { didSet { UserDefaults.standard.set(timeSensitive, forKey: Keys.timeSensitive) } }

    private enum Keys {
        static let enabled = "habit.notif.enabled"
        static let sound = "habit.notif.sound"
        static let timeSensitive = "habit.notif.timeSensitive"
    }

    private init() {
        let d = UserDefaults.standard
        enabled = (d.object(forKey: Keys.enabled) as? Bool) ?? true
        soundId = d.string(forKey: Keys.sound) ?? "chime"          // a distinctive default (was practically silent before)
        timeSensitive = (d.object(forKey: Keys.timeSensitive) as? Bool) ?? true
    }

    var sound: NotifSound { NotifSound.by(soundId) }
}
