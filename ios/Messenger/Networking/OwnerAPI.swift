/**
 * @file OwnerAPI.swift
 * The HTTP client for the server's `/owner/...` endpoints and the errors it reports. LiveBackend and
 * the owner socket use it for every request.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

import Foundation

/** What can go wrong with a request to the owner API. */
enum APIError: LocalizedError, Equatable {
    case unauthorized
    case notConfigured
    case http(Int, String)
    case badResponse
    case decoding(String)

    /** The message shown to the user. */
    var errorDescription: String? {
        switch self {
        case .unauthorized: String(localized: "Signed out. Please sign in again.")
        case .notConfigured: String(localized: "Not signed in.")
        case .http(let code, let body): String(localized: "Server error \(code)") + (body.isEmpty ? "" : ": \(body)")
        case .badResponse: String(localized: "Unexpected response from the server.")
        case .decoding(let what): String(localized: "Couldn't read the server's reply (\(what)).")
        }
    }
}

/** The owner HTTP API (`/owner/...`), authenticated with the Bearer session token. A value type so notification actions can use it without the UI. */
struct OwnerAPI: Sendable {
    /** Base address of the server. */
    let base: URL
    /** The owner's session token. */
    let token: String

    /**
     * Built from UserDefaults (host) and the Keychain (token), or nil when signed out.
     *
     * - Returns: The API, or nil.
     */
    static func stored() -> OwnerAPI? {
        guard let host = AppConfig.dashHost, let base = AppConfig.dashURL(host: host),
              let token = Keychain.string(for: AppConfig.tokenAccount), !token.isEmpty else { return nil }
        return OwnerAPI(base: base, token: token)
    }

    /** An empty reply, for calls whose answer is not used. */
    private struct OK: Decodable {}
    /** Body of a new message. */
    private struct TextBody: Encodable { let text: String; var email: Bool = false }
    /** Body of a block request. */
    private struct BlockBody: Encodable { let blocked: Bool }
    /** Body of a device registration. */
    private struct DeviceBody: Encodable { let token: String; let env: String; let name: String }
    /** Body of a test-push request. */
    private struct KindBody: Encodable { let kind: String }

    /**
     * `GET owner/conversations`, up to 50.
     *
     * - Returns: The conversations.
     * - Throws: `APIError`, or a network error.
     */
    func conversations() async throws -> [Conversation] {
        struct R: Decodable { let conversations: [Conversation] }
        return try await call("GET", "owner/conversations", query: ["limit": "50"], as: R.self).conversations
    }

    /**
     * `GET owner/conversations/{vid}/messages`, up to 100.
     *
     * - Parameter vid: Visitor id.
     * - Returns: The messages.
     * - Throws: `APIError`, or a network error.
     */
    func messages(vid: String) async throws -> [Message] {
        struct R: Decodable { let messages: [Message] }
        return try await call("GET", "owner/conversations/\(vid)/messages", query: ["limit": "100"], as: R.self).messages
    }

    /**
     * `POST owner/conversations/{vid}/messages`.
     *
     * - Parameter vid: Visitor id.
     * - Parameter text: The message text.
     * - Parameter email: True to send it as an email too.
     * - Returns: The message as stored.
     * - Throws: `APIError`, or a network error.
     */
    func send(vid: String, text: String, email: Bool = false) async throws -> Message {
        struct R: Decodable { let message: Message }
        return try await call("POST", "owner/conversations/\(vid)/messages", body: TextBody(text: text, email: email), as: R.self).message
    }

    /**
     * `POST owner/conversations/{vid}/read`.
     *
     * - Parameter vid: Visitor id.
     * - Throws: `APIError`, or a network error.
     */
    func markRead(vid: String) async throws {
        _ = try await call("POST", "owner/conversations/\(vid)/read", as: OK.self)
    }

    /**
     * `POST owner/conversations/{vid}/block`.
     *
     * - Parameter vid: Visitor id.
     * - Parameter blocked: True to block.
     * - Throws: `APIError`, or a network error.
     */
    func setBlocked(vid: String, blocked: Bool) async throws {
        _ = try await call("POST", "owner/conversations/\(vid)/block", body: BlockBody(blocked: blocked), as: OK.self)
    }

    /**
     * `GET owner/settings`.
     *
     * - Returns: The owner's settings.
     * - Throws: `APIError`, or a network error.
     */
    func settings() async throws -> OwnerSettings {
        try await call("GET", "owner/settings", as: OwnerSettings.self)
    }

    /**
     * `PUT owner/settings`.
     *
     * - Parameter patch: The fields to change.
     * - Returns: The settings after the change.
     * - Throws: `APIError`, or a network error.
     */
    func updateSettings(_ patch: SettingsPatch) async throws -> OwnerSettings {
        try await call("PUT", "owner/settings", body: patch, as: OwnerSettings.self)
    }

    /**
     * `POST owner/devices`.
     *
     * - Parameter apns: The APNs token as hex.
     * - Parameter env: The push environment.
     * - Parameter name: The device's name.
     * - Throws: `APIError`, or a network error.
     */
    func registerDevice(token apns: String, env: String, name: String) async throws {
        _ = try await call("POST", "owner/devices", body: DeviceBody(token: apns, env: env, name: name), as: OK.self)
    }

    /**
     * `DELETE owner/devices/{token}`.
     *
     * - Parameter apns: The APNs token as hex.
     * - Throws: `APIError`, or a network error.
     */
    func unregisterDevice(token apns: String) async throws {
        _ = try await call("DELETE", "owner/devices/\(apns)", as: OK.self)
    }

    /** A 60 s socket ticket, and the address of the socket. */
    struct Ticket: Decodable, Sendable { let ticket: String; let ws: String }

    /**
     * `POST owner/ticket`.
     *
     * - Returns: The ticket and socket address.
     * - Throws: `APIError`, or a network error.
     */
    func ticket() async throws -> Ticket {
        try await call("POST", "owner/ticket", as: Ticket.self)
    }

    /**
     * `POST owner/test-push`.
     *
     * - Parameter kind: "message" or "visit".
     * - Returns: How many devices it was sent to; 0 when the server doesn't say.
     * - Throws: `APIError`, or a network error.
     */
    func testPush(kind: String) async throws -> Int {
        struct R: Decodable { let sent: Int? }
        return try await call("POST", "owner/test-push", body: KindBody(kind: kind), as: R.self).sent ?? 0
    }

    /**
     * `GET owner/online`.
     *
     * - Returns: The visitors on the site; empty when the server sends none.
     * - Throws: `APIError`, or a network error.
     */
    func online() async throws -> [OnlineVisitor] {
        struct R: Decodable { let visitors: [OnlineVisitor]? }
        return try await call("GET", "owner/online", as: R.self).visitors ?? []
    }

    /**
     * `GET owner/visitor/{vid}`.
     *
     * - Parameter vid: Visitor id.
     * - Returns: The visitor's profile and visits.
     * - Throws: `APIError`, or a network error.
     */
    func visitor(vid: String) async throws -> VisitorDetails {
        try await call("GET", "owner/visitor/\(vid)", as: VisitorDetails.self)
    }

    // MARK: - Transport

    /**
     * Sends one JSON request with the Bearer token and decodes the reply. An empty reply is decoded as `{}`.
     *
     * - Parameter method: HTTP method.
     * - Parameter path: Path under the base address.
     * - Parameter query: Query parameters.
     * - Parameter body: A value to send as JSON, if any.
     * - Parameter type: The type to decode the reply as.
     * - Returns: The decoded reply.
     * - Throws: `APIError.unauthorized` for 401, `.http` for other non-2xx answers (with up to 200
     *   characters of the body), `.badResponse`, `.decoding`, or the network or encoding error.
     */
    private func call<T: Decodable>(_ method: String, _ path: String, query: [String: String] = [:],
                                    body: (any Encodable & Sendable)? = nil, as type: T.Type) async throws -> T {
        var comps = URLComponents(url: base.appending(path: path), resolvingAgainstBaseURL: false)
        if !query.isEmpty {
            comps?.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = comps?.url else { throw APIError.badResponse }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        req.httpMethod = method
        req.httpShouldHandleCookies = false
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.httpBody = try JSONEncoder().encode(body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            let text = String(decoding: data.prefix(200), as: UTF8.self)
            throw APIError.http(http.statusCode, text.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        do {
            return try JSONDecoder().decode(T.self, from: data.isEmpty ? Data("{}".utf8) : data)
        } catch {
            throw APIError.decoding(path)
        }
    }
}
