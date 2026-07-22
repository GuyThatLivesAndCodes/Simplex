import Foundation

/// Remembers where you were in a video so it resumes on reopen. Positions are saved
/// locally (per device) keyed by the vault file id, auto-saved every few seconds during
/// playback, so an accidental close doesn't lose your place. A video watched to (near)
/// the end is cleared so it starts over next time.
enum VideoProgress {
    private static let key = "videoProgress"   // [fileId: seconds]
    private static let finishedFraction = 0.97 // treat >=97% watched as "finished"
    private static let minResumeSeconds = 5.0  // don't bother resuming the first few seconds

    private static func all() -> [String: Double] {
        (UserDefaults.standard.dictionary(forKey: key) as? [String: Double]) ?? [:]
    }
    private static func write(_ dict: [String: Double]) {
        UserDefaults.standard.set(dict, forKey: key)
    }

    /// The saved resume position for a file (seconds), or nil if none / too small.
    static func position(for fileId: String) -> Double? {
        guard let secs = all()[fileId], secs >= minResumeSeconds else { return nil }
        return secs
    }

    /// Save the current position. Clears the entry once the video is essentially finished
    /// (so it restarts next time) or when the position is negligible.
    static func save(fileId: String, seconds: Double, duration: Double) {
        var dict = all()
        if duration > 0 && seconds >= duration * finishedFraction {
            dict.removeValue(forKey: fileId)          // finished → start over next time
        } else if seconds < minResumeSeconds {
            dict.removeValue(forKey: fileId)          // negligible → nothing to resume
        } else {
            dict[fileId] = seconds
        }
        write(dict)
    }

    /// Forget a file's saved position (e.g. the user chose "restart from beginning").
    static func clear(fileId: String) {
        var dict = all()
        dict.removeValue(forKey: fileId)
        write(dict)
    }

    static func hasResume(for fileId: String) -> Bool { position(for: fileId) != nil }
}
