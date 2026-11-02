import Foundation

/// "Continue watching": where you left off in a video.
///
/// The positions live on the SERVER (per account), so a spot saved in the web app or
/// on another device is offered here too. This type is a thin synchronous cache over
/// that: `FileItem.resume` arrives with every files list, views read it through
/// `position(for:)` without awaiting, and playback writes back through `save`.
///
/// Every reported position is saved — there is no minimum and no "near enough to the
/// end" rule. A spot is forgotten only when the video is watched to the end or the
/// viewer chooses "Start over", both of which call `clear`.
@MainActor
enum VideoProgress {
    private static var cache: [String: Double] = [:]   // fileId -> seconds

    /// Seed the cache from a files list (call whenever the vault list is refreshed).
    static func absorb(_ items: [FileItem]) {
        for item in items where item.type == "video" {
            if let secs = item.resumeSeconds { cache[item.id] = secs }
            else { cache.removeValue(forKey: item.id) }
        }
    }

    /// The saved resume position for a file (seconds), or nil if there is none.
    static func position(for fileId: String) -> Double? { cache[fileId] }
    static func hasResume(for fileId: String) -> Bool { cache[fileId] != nil }

    /// Report the current position. Fire-and-forget; the position is stored as-is.
    static func save(fileId: String, seconds: Double, duration: Double) {
        guard seconds.isFinite, seconds >= 0 else { return }
        cache[fileId] = seconds
        Task { try? await API.shared.saveProgress(fileId: fileId, pos: seconds, dur: duration) }
    }

    /// Forget a file's saved position (e.g. the user chose "Start over").
    static func clear(fileId: String) {
        cache.removeValue(forKey: fileId)
        Task { try? await API.shared.clearProgress(fileId: fileId) }
    }
}
