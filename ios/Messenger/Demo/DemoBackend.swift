/**
 * @file DemoBackend.swift
 * The in-memory backend behind Demo mode. It implements ChatBackend with invented data and a small
 * script, so the app can be tried without a server.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

import Foundation
import UserNotifications

/**
 * Made-up conversations and visitors, kept in memory, with a little script that makes visitors
 * type, reply, read and arrive so the whole UI can be tried without a server. Nothing leaves the phone.
 */
@MainActor
final class DemoBackend: ChatBackend {
    /** Always true: this is the demo backend. */
    var isDemo: Bool { true }

    /** Conversations by visitor id. */
    private var convs: [String: Conversation] = [:]
    /** Messages by visitor id. */
    private var msgs: [String: [Message]] = [:]
    /** The made-up sessions of people on the site. */
    private var sessions: [LiveSession] = []
    /** The demo owner settings. */
    private var current = OwnerSettings(available: true, visitPings: .all,
                                        greeting: "Hi! Ask me anything — I usually reply within a few hours.")
    /** Where real-time events are delivered while "connected". */
    private var handler: (@MainActor (RealtimeEvent) -> Void)?
    /** The running demo script, if any. */
    private var script: Task<Void, Never>?
    /** Counter used to make message and visitor ids unique. */
    private var counter = 0

    /** Fills the backend with the sample data. */
    init() { seed() }

    // MARK: ChatBackend

    /**
     * Lists the demo conversations, newest first.
     *
     * - Returns: The conversations.
     * - Throws: CancellationError when the task is cancelled during the short pause.
     */
    func conversations() async throws -> [Conversation] {
        try await pause()
        return convs.values.sorted { $0.lastAt > $1.lastAt }
    }

    /**
     * Lists one thread's messages.
     *
     * - Parameter vid: Visitor id.
     * - Returns: The messages, or an empty list for an unknown visitor.
     * - Throws: CancellationError when the task is cancelled during the short pause.
     */
    func messages(vid: String) async throws -> [Message] {
        try await pause()
        return msgs[vid] ?? []
    }

    /**
     * Stores an owner message and schedules the visitor's scripted reaction.
     *
     * - Parameter vid: Visitor id.
     * - Parameter text: The message text.
     * - Parameter email: Ignored in the demo.
     * - Returns: The stored message.
     * - Throws: CancellationError when the task is cancelled during the short pause.
     */
    func send(vid: String, text: String, email: Bool) async throws -> Message {
        try await pause()
        let m = Message(id: nextId(), vid: vid, from: .owner, text: text, at: Fmt.nowMs)
        append(m)
        respond(to: vid)
        return m
    }

    /**
     * Clears a conversation's unread count.
     *
     * - Parameter vid: Visitor id.
     */
    func markRead(vid: String) async throws {
        convs[vid]?.unread = 0
    }

    /**
     * Blocks or unblocks a visitor, creating the conversation from their session first if needed.
     *
     * - Parameter vid: Visitor id.
     * - Parameter blocked: True to block.
     */
    func setBlocked(vid: String, blocked: Bool) async throws {
        if convs[vid] == nil, let s = sessions.first(where: { $0.vid == vid }) { convs[vid] = Self.conversation(from: s) }
        convs[vid]?.blocked = blocked
    }

    /**
     * Returns the demo settings.
     *
     * - Returns: The current settings.
     * - Throws: CancellationError when the task is cancelled during the short pause.
     */
    func settings() async throws -> OwnerSettings {
        try await pause()
        return current
    }

    /**
     * Applies the given fields to the demo settings.
     *
     * - Parameter patch: The fields to change.
     * - Returns: The settings after the change.
     * - Throws: CancellationError when the task is cancelled during the short pause.
     */
    func updateSettings(_ patch: SettingsPatch) async throws -> OwnerSettings {
        try await pause()
        if let a = patch.available { current.available = a }
        if let v = patch.visitPings, let p = VisitPings(rawValue: v) { current.visitPings = p }
        if let g = patch.greeting { current.greeting = g }
        return current
    }

    /**
     * Does nothing: the demo has no server to register with.
     *
     * - Parameter apnsToken: Ignored.
     */
    func registerDevice(apnsToken: String) async throws {}
    /**
     * Does nothing: the demo has no server to unregister from.
     *
     * - Parameter apnsToken: Ignored.
     */
    func unregisterDevice(apnsToken: String) async throws {}

    /**
     * Demo "push": a local notification shaped exactly like the server's (same category, sound, keys).
     * It fires after 3 seconds.
     *
     * - Parameter kind: "visit" for a visit push; anything else gives a message push.
     * - Returns: Always 1.
     * - Throws: An error when the notification could not be scheduled.
     */
    func testPush(kind: String) async throws -> Int {
        let content = UNMutableNotificationContent()
        if kind == "visit" {
            content.title = "Returning visitor · 5th visit"
            content.body = "Springfield, IL · iPhone · /privacy.html · from google.com"
            content.sound = UNNotificationSound(named: UNNotificationSoundName("visit.caf"))
            content.categoryIdentifier = "VISIT"
            content.threadIdentifier = "visits"
            content.interruptionLevel = .active
            content.relevanceScore = 0.2
            content.userInfo = ["kind": "visit", "vid": DemoData.annaVid]
        } else {
            content.title = "Anna"
            content.body = "Test message: did the notification sound play?"
            content.sound = UNNotificationSound(named: UNNotificationSoundName("message-long.caf"))
            content.categoryIdentifier = "MESSAGE"
            content.threadIdentifier = DemoData.annaVid
            content.interruptionLevel = .timeSensitive
            content.relevanceScore = 1
            content.userInfo = ["kind": "message", "vid": DemoData.annaVid]
        }
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 3, repeats: false)
        try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString,
                                                                               content: content, trigger: trigger))
        return 1
    }

    /**
     * Lists the active, non-bot sessions that have a visitor id.
     *
     * - Returns: The visitors on the site.
     * - Throws: CancellationError when the task is cancelled during the short pause.
     */
    func online() async throws -> [OnlineVisitor] {
        try await pause()
        return sessions.filter { $0.active && !$0.bot && $0.vid != nil }.map { s in
            OnlineVisitor(vid: s.vid!, page: s.page, at: s.lastSeen * 1000, since: (s.firstSeen ?? s.lastSeen) * 1000,
                          place: s.place.nonEmpty, device: s.deviceLine.nonEmpty, visits: s.visits, conversation: convs[s.vid!])
        }
    }

    /**
     * Builds the made-up profile of one visitor.
     *
     * - Parameter vid: Visitor id.
     * - Returns: The visitor's details.
     * - Throws: CancellationError when the task is cancelled during the short pause.
     */
    func visitor(vid: String) async throws -> VisitorDetails {
        try await pause()
        return DemoData.details(for: vid, conversation: convs[vid], session: sessions.first { $0.vid == vid })
    }

    /**
     * Reports "connected" and starts the demo script.
     *
     * - Parameter handler: Receives the real-time events.
     */
    func startRealtime(_ handler: @escaping @MainActor (RealtimeEvent) -> Void) {
        self.handler = handler
        handler(.state(.connected))
        script?.cancel()
        script = Task { [weak self] in await self?.runScript() }
    }

    /** Stops the script, reports "off" and forgets the handler. */
    func stopRealtime() {
        script?.cancel()
        script = nil
        handler?(.state(.off))
        handler = nil
    }

    /**
     * Does nothing: no visitor is listening in the demo.
     *
     * - Parameter vid: Ignored.
     */
    func sendTyping(vid: String) {}

    // MARK: Script

    /**
     * The demo script: one visitor writes soon after launch, a new one arrives, and then every 35 to 60
     * seconds either another visitor arrives or Anna writes. Ends when cancelled.
     */
    private func runScript() async {
        // A visitor who's online starts typing shortly after launch, then a new visitor arrives.
        guard await wait(5) else { return }
        await visitorSays(DemoData.berlinVid, "Also — how long does a custom order usually take?")
        guard await wait(14) else { return }
        arrive()
        while !Task.isCancelled {
            guard await wait(Double.random(in: 35...60)) else { return }
            if Bool.random() { arrive() } else {
                let lines = ["Thanks again!", "One more question: do you gift-wrap?", "Love the new design btw 🙂"]
                await visitorSays(DemoData.annaVid, lines.randomElement()!)
            }
        }
    }

    /**
     * After the owner writes: sends a read receipt after 2 seconds and, sometimes (always for the
     * Berlin visitor), a short reply.
     *
     * - Parameter vid: Visitor id.
     */
    private func respond(to vid: String) {
        Task { [weak self] in
            guard let self, await self.wait(2) else { return }
            self.emit(ServerFrame(type: "read", vid: vid, at: Fmt.nowMs))
            guard await self.wait(1.5), Bool.random() || vid == DemoData.berlinVid else { return }
            let replies = ["Great, thank you!", "Perfect 👍", "That makes sense. I'll email you the details.", "Ha, nice."]
            await self.visitorSays(vid, replies.randomElement()!)
        }
    }

    /**
     * Makes a visitor type for a few seconds and then send a message. Skipped for unknown or blocked visitors.
     *
     * - Parameter vid: Visitor id.
     * - Parameter text: What the visitor says.
     */
    private func visitorSays(_ vid: String, _ text: String) async {
        guard convs[vid] != nil, convs[vid]?.blocked == false else { return }
        emit(ServerFrame(type: "typing", vid: vid))
        guard await wait(2.5) else { return }
        emit(ServerFrame(type: "typing", vid: vid))
        guard await wait(1.5) else { return }
        let m = Message(id: nextId(), vid: vid, from: .visitor, text: text, at: Fmt.nowMs, page: "/")
        append(m)
        convs[vid]?.unread += 1
        emit(ServerFrame(type: "message", vid: vid, message: m, conversation: convs[vid]))
    }

    /** Adds a random new visitor session and announces it as "online". */
    private func arrive() {
        let pages = ["/", "/blog/", "/products.html", "/privacy.html", "/about.html"]
        let places = [("Austin", "TX", "US"), ("London", "England", "GB"), ("Toronto", "ON", "CA"), ("Lisbon", "Lisbon", "PT")]
        let devs = [("Phone", "iOS", "Safari"), ("Desktop", "macOS", "Chrome"), ("Desktop", "Windows", "Edge")]
        let (ci, rg, c) = places.randomElement()!
        let (d, o, b) = devs.randomElement()!
        let now = Date.now.timeIntervalSince1970
        counter += 1
        let s = LiveSession(vid: "demoArrive\(counter)xxxxxxxxxx", visits: Int.random(in: 1...4), chat: false, lastSeen: now,
                            firstSeen: now, views: 1, page: pages.randomElement()!, ref: ["https://www.google.com/", nil,
                            "https://news.ycombinator.com/"].randomElement()!, city: ci, region: rg, country: c,
                            device: d, os: o, browser: b)
        sessions.insert(s, at: 0)
        emit(ServerFrame(type: "visitor", vid: s.vid, event: "online", page: s.page))
    }

    // MARK: Helpers

    /**
     * Delivers a frame to the real-time handler, if one is set.
     *
     * - Parameter frame: The frame to deliver.
     */
    private func emit(_ frame: ServerFrame) { handler?(.frame(frame)) }

    /**
     * Stores a message and updates its conversation's last text, sender and time, creating the
     * conversation from the visitor's session when it is their first message.
     *
     * - Parameter m: The message.
     */
    private func append(_ m: Message) {
        msgs[m.vid, default: []].append(m)
        if convs[m.vid] == nil, let s = sessions.first(where: { $0.vid == m.vid }) {
            convs[m.vid] = Self.conversation(from: s)
            if let i = sessions.firstIndex(where: { $0.vid == m.vid }) { sessions[i].chat = true }
        }
        convs[m.vid]?.lastText = m.text
        convs[m.vid]?.lastFrom = m.from
        convs[m.vid]?.lastAt = m.at
    }

    /**
     * Makes a new unique message id.
     *
     * - Returns: The id.
     */
    private func nextId() -> String {
        counter += 1
        return "m_demo\(counter)_\(Int(Fmt.nowMs))"
    }

    /**
     * A short delay that imitates the network.
     *
     * - Throws: CancellationError when the task is cancelled.
     */
    private func pause() async throws {
        try await Task.sleep(for: .milliseconds(150))
    }

    /**
     * Sleeps for the given time.
     *
     * - Parameter seconds: How long to sleep.
     * - Returns: False when the script was cancelled.
     */
    private func wait(_ seconds: Double) async -> Bool {
        (try? await Task.sleep(for: .seconds(seconds))) != nil && !Task.isCancelled
    }

    /**
     * Builds a conversation row from a session.
     *
     * - Parameter s: The session.
     * - Returns: A conversation with the session's place, device and visit count.
     */
    private static func conversation(from s: LiveSession) -> Conversation {
        Conversation(vid: s.vid ?? "", lastAt: Fmt.nowMs, online: s.active, place: s.place, device: s.deviceLine,
                     visits: s.visits)
    }

    /** Loads the sample conversations, messages and sessions. */
    private func seed() {
        let data = DemoData.make()
        for c in data.conversations { convs[c.vid] = c }
        for m in data.messages { msgs[m.vid, default: []].append(m) }
        sessions = data.sessions
    }
}
