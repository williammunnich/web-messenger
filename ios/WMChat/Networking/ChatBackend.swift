/**
 * @file ChatBackend.swift
 * The ChatBackend protocol that the UI talks to, its live implementation over the owner HTTP API,
 * and the owner WebSocket that delivers real-time events.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */

import Foundation
import UIKit

/** What the real-time channel reports: a connection state change, a server frame, or a rejected sign-in. */
enum RealtimeEvent: Sendable {
    case state(ConnectionState)
    case frame(ServerFrame)
    case unauthorized
}

/**
 * Everything the UI needs from "the server". `LiveBackend` talks to the owner API and the socket;
 * `DemoBackend` fakes it all in memory so the app can be tried before the backend exists.
 */
@MainActor
protocol ChatBackend: AnyObject {
    /** True for the demo backend. */
    var isDemo: Bool { get }

    /**
     * Lists the conversations.
     *
     * - Returns: The conversations.
     * - Throws: When the request fails.
     */
    func conversations() async throws -> [Conversation]
    /**
     * Lists one thread's messages.
     *
     * - Parameter vid: Visitor id.
     * - Returns: The messages.
     * - Throws: When the request fails.
     */
    func messages(vid: String) async throws -> [Message]
    /**
     * Sends an owner message.
     *
     * - Parameter vid: Visitor id.
     * - Parameter text: The message text.
     * - Parameter email: True to send it as an email too.
     * - Returns: The message as stored.
     * - Throws: When the request fails.
     */
    func send(vid: String, text: String, email: Bool) async throws -> Message
    /**
     * Marks a conversation read.
     *
     * - Parameter vid: Visitor id.
     * - Throws: When the request fails.
     */
    func markRead(vid: String) async throws
    /**
     * Blocks or unblocks a visitor.
     *
     * - Parameter vid: Visitor id.
     * - Parameter blocked: True to block.
     * - Throws: When the request fails.
     */
    func setBlocked(vid: String, blocked: Bool) async throws
    /**
     * Loads the owner's settings.
     *
     * - Returns: The settings.
     * - Throws: When the request fails.
     */
    func settings() async throws -> OwnerSettings
    /**
     * Changes the owner's settings.
     *
     * - Parameter patch: The fields to change.
     * - Returns: The settings after the change.
     * - Throws: When the request fails.
     */
    func updateSettings(_ patch: SettingsPatch) async throws -> OwnerSettings
    /**
     * Registers this device for push.
     *
     * - Parameter apnsToken: The APNs token as hex.
     * - Throws: When the request fails.
     */
    func registerDevice(apnsToken: String) async throws
    /**
     * Removes this device's push registration.
     *
     * - Parameter apnsToken: The APNs token as hex.
     * - Throws: When the request fails.
     */
    func unregisterDevice(apnsToken: String) async throws
    /**
     * Sends a test push.
     *
     * - Parameter kind: "message" or "visit".
     * - Returns: How many devices it was sent to.
     * - Throws: When the request fails.
     */
    func testPush(kind: String) async throws -> Int
    /**
     * Lists who has the site open right now.
     *
     * - Returns: The visitors.
     * - Throws: When the request fails.
     */
    func online() async throws -> [OnlineVisitor]
    /**
     * Loads what is known about one visitor.
     *
     * - Parameter vid: Visitor id.
     * - Returns: The visitor's profile and visits.
     * - Throws: When the request fails.
     */
    func visitor(vid: String) async throws -> VisitorDetails

    /**
     * Opens the real-time channel; events arrive on the main actor until `stopRealtime()`.
     *
     * - Parameter handler: Receives the events.
     */
    func startRealtime(_ handler: @escaping @MainActor (RealtimeEvent) -> Void)
    /** Closes the real-time channel. */
    func stopRealtime()
    /**
     * Fire-and-forget owner frames (`typing`, `read`). Ignored when not connected.
     *
     * - Parameter vid: Visitor id.
     */
    func sendTyping(vid: String)
}

/** The real backend: each call goes to the owner HTTP API, and real-time events come from an OwnerSocket. */
@MainActor
final class LiveBackend: ChatBackend {
    /** The HTTP client all requests go through. */
    let api: OwnerAPI
    /** The open socket, or nil while real-time is off. */
    private var socket: OwnerSocket?

    /**
     * Creates the backend.
     *
     * - Parameter api: The signed-in owner API.
     */
    init(api: OwnerAPI) { self.api = api }

    /** Always false: this is the live backend. */
    var isDemo: Bool { false }

    /** See `ChatBackend.conversations()`; forwards to the API. */
    func conversations() async throws -> [Conversation] { try await api.conversations() }
    /** See `ChatBackend.messages(vid:)`; forwards to the API. */
    func messages(vid: String) async throws -> [Message] { try await api.messages(vid: vid) }
    /** See `ChatBackend.send(vid:text:email:)`; forwards to the API. */
    func send(vid: String, text: String, email: Bool) async throws -> Message { try await api.send(vid: vid, text: text, email: email) }
    /** See `ChatBackend.markRead(vid:)`; forwards to the API. */
    func markRead(vid: String) async throws { try await api.markRead(vid: vid) }
    /** See `ChatBackend.setBlocked(vid:blocked:)`; forwards to the API. */
    func setBlocked(vid: String, blocked: Bool) async throws { try await api.setBlocked(vid: vid, blocked: blocked) }
    /** See `ChatBackend.settings()`; forwards to the API. */
    func settings() async throws -> OwnerSettings { try await api.settings() }
    /** See `ChatBackend.updateSettings(_:)`; forwards to the API. */
    func updateSettings(_ patch: SettingsPatch) async throws -> OwnerSettings { try await api.updateSettings(patch) }
    /**
     * Registers the device with the build's push environment and the device's name.
     *
     * - Parameter apnsToken: The APNs token as hex.
     * - Throws: When the request fails.
     */
    func registerDevice(apnsToken: String) async throws {
        try await api.registerDevice(token: apnsToken, env: AppConfig.pushEnvironment, name: UIDevice.current.name)
    }
    /** See `ChatBackend.unregisterDevice(apnsToken:)`; forwards to the API. */
    func unregisterDevice(apnsToken: String) async throws { try await api.unregisterDevice(token: apnsToken) }
    /** See `ChatBackend.testPush(kind:)`; forwards to the API. */
    func testPush(kind: String) async throws -> Int { try await api.testPush(kind: kind) }
    /** See `ChatBackend.online()`; forwards to the API. */
    func online() async throws -> [OnlineVisitor] { try await api.online() }
    /** See `ChatBackend.visitor(vid:)`; forwards to the API. */
    func visitor(vid: String) async throws -> VisitorDetails { try await api.visitor(vid: vid) }

    /**
     * Replaces any open socket with a new one and starts it.
     *
     * - Parameter handler: Receives the events.
     */
    func startRealtime(_ handler: @escaping @MainActor (RealtimeEvent) -> Void) {
        socket?.stop()
        let s = OwnerSocket(api: api, handler: handler)
        socket = s
        s.start()
    }

    /** Stops and drops the socket. */
    func stopRealtime() {
        socket?.stop()
        socket = nil
    }

    /**
     * Sends a `typing` frame over the socket, if one is open.
     *
     * - Parameter vid: Visitor id.
     */
    func sendTyping(vid: String) {
        socket?.send(["action": "typing", "vid": vid])
    }
}

/**
 * The owner's WebSocket: gets a 60 s ticket from `POST /owner/ticket`, connects with
 * `?role=owner&ticket=…`, and reconnects with exponential backoff (1 s … 30 s) until stopped.
 */
@MainActor
final class OwnerSocket {
    private let api: OwnerAPI
    private let handler: @MainActor (RealtimeEvent) -> Void
    private var task: URLSessionWebSocketTask?
    private var loop: Task<Void, Never>?

    /**
     * Creates the socket; nothing connects until `start()`.
     *
     * - Parameter api: Used to fetch the ticket.
     * - Parameter handler: Receives the events.
     */
    init(api: OwnerAPI, handler: @escaping @MainActor (RealtimeEvent) -> Void) {
        self.api = api
        self.handler = handler
    }

    /** Starts the connect-and-reconnect loop, once. */
    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in await self?.run() }
    }

    /** Cancels the loop, closes the socket and reports "off". */
    func stop() {
        loop?.cancel()
        loop = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        handler(.state(.off))
    }

    /**
     * Sends a JSON frame as text. Dropped when there is no socket or the frame can't be encoded.
     *
     * - Parameter frame: The frame's keys and values.
     */
    func send(_ frame: [String: String]) {
        guard let task, let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    /**
     * The connection loop: fetch a ticket, connect, ping every 45 seconds, pass decoded frames to the
     * handler, and after a failure wait with backoff and try again. A 401 for the ticket reports
     * `unauthorized` and ends the loop.
     */
    private func run() async {
        var attempt = 0
        while !Task.isCancelled {
            handler(.state(.connecting))
            do {
                let ticket = try await api.ticket()
                guard var comps = URLComponents(string: ticket.ws) else { throw APIError.badResponse }
                comps.queryItems = [URLQueryItem(name: "role", value: "owner"), URLQueryItem(name: "ticket", value: ticket.ticket)]
                guard let url = comps.url else { return }
                let ws = URLSession.shared.webSocketTask(with: url)
                task = ws
                ws.resume()
                try await Self.ping(ws)                      // proves the socket is open
                attempt = 0
                handler(.state(.connected))
                let pinger = Task {                          // keeps NAT/API Gateway paths warm, finds dead sockets
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(45))
                        if Task.isCancelled { break }
                        if (try? await Self.ping(ws)) == nil { ws.cancel(with: .abnormalClosure, reason: nil) }
                    }
                }
                defer { pinger.cancel() }
                while !Task.isCancelled {
                    let message = try await ws.receive()
                    let data: Data? = switch message {
                    case .string(let s): Data(s.utf8)
                    case .data(let d): d
                    @unknown default: nil
                    }
                    if let data, let frame = try? JSONDecoder().decode(ServerFrame.self, from: data) {
                        handler(.frame(frame))
                    }
                }
            } catch APIError.unauthorized {
                handler(.unauthorized)
                return
            } catch {
                // fall through to backoff
            }
            task?.cancel(with: .goingAway, reason: nil)
            task = nil
            if Task.isCancelled { return }
            attempt += 1
            let delay = min(30, 1 << min(attempt - 1, 5)) + Int.random(in: 0...1)
            handler(.state(.waiting(seconds: delay)))
            try? await Task.sleep(for: .seconds(delay))
        }
    }

    /**
     * Sends a WebSocket ping and waits for the pong.
     *
     * - Parameter ws: The socket task.
     * - Throws: When the ping fails.
     */
    private static func ping(_ ws: URLSessionWebSocketTask) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            ws.sendPing { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }
}
