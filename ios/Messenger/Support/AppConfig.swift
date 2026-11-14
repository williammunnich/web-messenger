/**
 * @file AppConfig.swift
 * Fixed names and small helpers for the app's configuration: the sign-in callback scheme, the
 * UserDefaults and Keychain keys, the inbox host and the push environment.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

import Foundation

/** Keys from docs/chat-protocol.md, plus the inbox host the owner types in once. */
enum AppConfig {
    /** URL scheme the sign-in page redirects back to. */
    static let callbackScheme = "webmessenger"
    /** Keychain account under which the owner's session token is stored. */
    static let tokenAccount = "session"

    /** UserDefaults keys. */
    enum Keys {
        static let dashHost = "dashHost"
        static let demoMode = "demoMode"
        static let apnsToken = "apnsToken"
    }

    /** The saved inbox host, or nil when none has been entered. */
    static var dashHost: String? {
        UserDefaults.standard.string(forKey: Keys.dashHost)
    }

    /**
     * Builds the server's base address: http for localhost, https for everything else.
     *
     * - Parameter host: Host name, with a port if needed.
     * - Returns: The URL, or nil when the host can't form one.
     */
    static func dashURL(host: String) -> URL? {
        URL(string: (isLocal(host) ? "http://" : "https://") + host)
    }

    /**
     * Tells whether a host is this machine (the local bench). Only then does the app use plain http,
     * so the match is exact: a prefix test would also accept names like "localhost.example.com" and
     * send the owner's session token to them without TLS.
     *
     * - Parameter host: Host name, with a port if needed.
     * - Returns: True for exactly "localhost" or "127.0.0.1", with or without ":port".
     */
    static func isLocal(_ host: String) -> Bool {
        let name = host.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? host
        return name == "localhost" || name == "127.0.0.1"
    }

    /**
     * Accepts the inbox address from the deploy output, with or without "https://" or a trailing path, or
     * localhost:8790 for the local bench.
     *
     * - Parameter raw: What the owner typed.
     * - Returns: The bare lowercase host (and port), or nil if it can't be one.
     */
    static func normalizeHost(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }
        if let cut = s.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) { s = String(s[..<cut]) }
        guard !s.isEmpty, s.contains(".") || isLocal(s), s.allSatisfy({ $0.isLetter || $0.isNumber || ".-:".contains($0) }) else { return nil }
        return s
    }

    /** The APNs environment the chat service should send to (contract: sandbox for Debug builds). */
    static var pushEnvironment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }

    /** Version and build number as "1.0 (3)", for the Settings screen. */
    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let v = info?["CFBundleShortVersionString"] as? String ?? "?"
        let b = info?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }
}
