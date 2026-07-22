import Foundation
import Security

/// Durable storage for the Simplex session cookie so the user stays signed in across
/// app launches (and only has to pass Face ID, not re-enter credentials). The cookie
/// value is kept in the Keychain — encrypted at rest, surviving relaunch — rather than
/// relying on `HTTPCookieStorage`, whose session-scoped cookies iOS may drop.
///
/// The stored cookie's server-side HMAC is valid for the session max-age (~30 days), so
/// restoring it on launch re-authenticates without a password. It's cleared only on a
/// MANUAL sign-out; a rejected session (server restart re-locking per-user keys, or
/// changed credentials) falls back to the login screen on its own.
enum SessionStore {
    private static let service = "net.guythatlives.simplexvault.session"
    private static let cookieName = "simplex_session"   // must match the server's SESSION_COOKIE

    /// The account name/key under which the cookie is stored (host-scoped so switching
    /// servers doesn't cross the wires).
    private static func account() -> String {
        "cookie@" + (API.shared.baseURLSync.host ?? "default")
    }

    // MARK: - persist / restore

    /// Save the current session cookie (if any) from the shared cookie storage.
    static func persistFromStorage() {
        guard let host = API.shared.baseURLSync.host,
              let cookies = HTTPCookieStorage.shared.cookies,
              let session = cookies.first(where: { $0.name == cookieName && $0.domain.contains(host) })
                ?? cookies.first(where: { $0.name == cookieName }) else { return }
        save(value: session.value)
    }

    /// Re-inject a stored cookie into the shared cookie storage so the next request is
    /// authenticated. Returns true if a cookie was restored.
    @discardableResult
    static func restoreToStorage() -> Bool {
        guard let value = load(), let url = URL(string: API.shared.baseURLSync.absoluteString),
              let host = url.host else { return false }
        var props: [HTTPCookiePropertyKey: Any] = [
            .name: cookieName,
            .value: value,
            .domain: host,
            .path: "/",
            .secure: url.scheme == "https" ? "TRUE" : "FALSE",
        ]
        // give it a far-future expiry locally so HTTPCookieStorage keeps it for the session
        props[.expires] = Date().addingTimeInterval(60 * 60 * 24 * 30)
        if let cookie = HTTPCookie(properties: props) {
            HTTPCookieStorage.shared.setCookie(cookie)
            return true
        }
        return false
    }

    /// Whether we have a stored session to try restoring on launch.
    static var hasStored: Bool { load() != nil }

    /// Clear the stored cookie AND the live cookie storage (manual sign-out).
    static func clear() {
        deleteKeychain()
        if let cookies = HTTPCookieStorage.shared.cookies {
            for c in cookies where c.name == cookieName { HTTPCookieStorage.shared.deleteCookie(c) }
        }
    }

    // MARK: - Keychain primitives

    private static func save(value: String) {
        let data = Data(value.utf8)
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(),
        ]
        SecItemDelete(query as CFDictionary)   // replace any existing
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(query as CFDictionary, nil)
    }

    private static func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data, let s = String(data: data, encoding: .utf8), !s.isEmpty else { return nil }
        return s
    }

    private static func deleteKeychain() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(),
        ]
        SecItemDelete(query as CFDictionary)
    }
}
