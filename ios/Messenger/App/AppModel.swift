/**
 * @file AppModel.swift
 * The app's single shared state object. It holds the configuration, the active backend (live or demo),
 * conversations and messages, the real-time connection, navigation and push registration, and every
 * view reads from it and calls into it.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

import SwiftUI
import UserNotifications

/**
 * App-wide state: configuration, the active backend (live or demo), conversations and messages,
 * the real-time connection, navigation and push registration.
 */
@MainActor @Observable
final class AppModel {
    /** The one instance shared by the views and the app delegate. */
    static let shared = AppModel()

    /** The two tabs of the main screen. */
    enum Tab: Hashable { case chats, settings }

    // MARK: Configuration

    /** Host name of the owner's server, or nil when none has been saved yet. */
    private(set) var dashHost: String? = AppConfig.dashHost
    /** True while an owner token is stored in the Keychain. */
    private(set) var isSignedIn = Keychain.string(for: AppConfig.tokenAccount) != nil
    /** True while the app runs on made-up data instead of a server. */
    private(set) var demoMode = UserDefaults.standard.bool(forKey: AppConfig.Keys.demoMode)
    /** The backend all calls go through: live, demo, or nil when the app is not set up. */
    private(set) var backend: (any ChatBackend)?
    /** Shown on the sign-in screen after a 401. */
    var signInNotice: String?

    /** True when a backend exists, so the main UI can be shown instead of setup. */
    var isReady: Bool { backend != nil }

    // MARK: Data

    /** All known conversations, newest activity first. */
    private(set) var conversations: [Conversation] = []
    /** True once the first load of the conversation list has finished, whether it worked or not. */
    private(set) var conversationsLoaded = false
    /** Why the conversation list could not be loaded, for display in the list. */
    var conversationsError: String?
    /** Loaded messages by visitor id; a missing key means that thread has not been loaded. */
    private(set) var messages: [String: [Message]] = [:]
    /** When each visitor last read the owner's messages (ms since 1970), by visitor id. */
    private(set) var visitorReadAt: [String: Double] = [:]
    /** Visitor ids that are typing right now. */
    private(set) var typing: Set<String> = []
    /** What each visitor has typed so far but not sent (live "sneak peek"). */
    private(set) var drafting: [String: String] = [:]
    /** Per-visitor timers that clear the typing state when no new typing frame arrives. */
    private var typingTimers: [String: Task<Void, Never>] = [:]
    /** People with the site open right now; messaging one pops the chat open in their browser. */
    private(set) var onSite: [OnlineVisitor] = []
    /** The owner's settings as last loaded or saved; nil until loaded. */
    var settings: OwnerSettings?
    /** State of the real-time connection. */
    private(set) var connection: ConnectionState = .off

    /** Unread messages summed over all conversations that are not blocked. */
    var totalUnread: Int { conversations.filter { !$0.blocked }.reduce(0) { $0 + $1.unread } }

    // MARK: Navigation

    /** The tab on screen. */
    var selectedTab: Tab = .chats
    /** Navigation path of the Chats tab: the visitor ids of the open threads. */
    var chatPath: [String] = []
    /** Visitor id of the thread on screen, or nil. */
    private(set) var openThreadVid: String?
    /** Prefilled composer text, e.g. from "Say hi". */
    var drafts: [String: String] = [:]
    /** Error text for the app-wide alert; nil hides it. */
    var alertMessage: String?

    // MARK: Push

    /** This device's APNs token as hex, kept in UserDefaults between launches. */
    private(set) var apnsToken: String? = UserDefaults.standard.string(forKey: AppConfig.Keys.apnsToken)
    /** Human-readable push registration state, shown in Settings. */
    var pushStatus: String = String(localized: "Not registered yet")
    /** True while the scene is in the foreground. */
    private(set) var isActive = false
    /** When the owner's typing signal was last sent, by visitor id (used to throttle it). */
    private var lastTypingSent: [String: Date] = [:]
    /** The notification action in flight (the delegate awaits it before telling iOS it's done). */
    @ObservationIgnored var notificationTask: Task<Void, Never>?

    /**
     * Builds the backend from what is stored and, in debug builds, applies launch arguments for
     * screenshots and the local bench.
     */
    private init() {
        rebuildBackend()
        #if DEBUG
        // Screenshot helpers: `-demoMode YES -screenshotTab settings -screenshotThread <vid>` as launch arguments.
        // Local bench without the sign-in sheet: `-benchHost localhost:8790 -benchToken <token the bench printed>`.
        let args = UserDefaults.standard
        if let host = args.string(forKey: "benchHost"), let token = args.string(forKey: "benchToken") {
            completeSignIn(host: host, token: token)
        }
        if args.string(forKey: "screenshotTab") == "settings" { selectedTab = .settings }
        if let vid = args.string(forKey: "screenshotThread") { chatPath = [vid] }
        #endif
    }

    // MARK: - Setup, sign-in, demo

    /**
     * Stores the host and owner token after a successful sign-in and switches to the live backend.
     *
     * - Parameter host: Host name of the owner's server.
     * - Parameter token: Owner token; saved in the Keychain.
     */
    func completeSignIn(host: String, token: String) {
        UserDefaults.standard.set(host, forKey: AppConfig.Keys.dashHost)
        Keychain.set(token, for: AppConfig.tokenAccount)
        dashHost = host
        isSignedIn = true
        signInNotice = nil
        setDemoMode(false)
    }

    /**
     * Saves the server host without signing in.
     *
     * - Parameter host: Host name of the owner's server.
     */
    func saveHost(_ host: String) {
        UserDefaults.standard.set(host, forKey: AppConfig.Keys.dashHost)
        dashHost = host
    }

    /**
     * Turns Demo mode on or off, remembers the choice and rebuilds the backend.
     *
     * - Parameter on: True to run on made-up data.
     */
    func setDemoMode(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: AppConfig.Keys.demoMode)
        demoMode = on
        rebuildBackend()
    }

    /** Unregisters this device from the server (best effort), deletes the token and leaves Demo mode. */
    func signOut() async {
        if let token = apnsToken, let backend, !backend.isDemo {
            try? await backend.unregisterDevice(apnsToken: token)
        }
        Keychain.delete(AppConfig.tokenAccount)
        isSignedIn = false
        setDemoMode(false)
    }

    /**
     * Reacts to a 401 from the server: deletes the token, shows a notice on the sign-in screen and
     * drops the backend. Does nothing in Demo mode or when already signed out.
     */
    private func handleUnauthorized() {
        guard !demoMode, isSignedIn else { return }
        Keychain.delete(AppConfig.tokenAccount)
        isSignedIn = false
        signInNotice = String(localized: "Your session ended. Sign in again.")
        rebuildBackend()
    }

    /**
     * Stops the old backend, clears all loaded data and creates the backend that matches the current
     * mode: demo, live (when a host and token are stored) or none. Reconnects if the app is in front.
     */
    private func rebuildBackend() {
        backend?.stopRealtime()
        connection = .off
        conversations = []
        conversationsLoaded = false
        conversationsError = nil
        messages = [:]
        visitorReadAt = [:]
        typing = []
        settings = nil
        chatPath = []
        if demoMode {
            backend = DemoBackend()
        } else if let api = OwnerAPI.stored() {
            backend = LiveBackend(api: api)
        } else {
            backend = nil
        }
        if isActive, backend != nil { Task { await becameActive() } }
    }

    // MARK: - Lifecycle

    /**
     * Follows the scene phase: connects and refreshes when the app becomes active, and stops the
     * real-time connection when it goes to the background.
     *
     * - Parameter phase: The new scene phase.
     */
    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .active:
            isActive = true
            Task { await becameActive() }
        case .background:
            isActive = false
            updateRinging()
            backend?.stopRealtime()
            connection = .off
        default:
            break
        }
    }

    /**
     * Starts real-time events, reloads the conversation list and the open thread, and registers the
     * device for push.
     */
    private func becameActive() async {
        guard let backend else { return }
        backend.startRealtime { [weak self] event in self?.handle(event) }
        await refreshConversations()
        if let vid = openThreadVid { await loadMessages(vid: vid) }
        await registerDeviceIfPossible()
    }

    /**
     * Called once the main UI shows: permission prompt + APNs registration.
     * Also prints the notification settings as a diagnostic line.
     */
    func setUpPush() async {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "screenshotNoPrompt") { return }
        #endif
        let granted = await NotificationSetup.requestAuthorizationAndRegister()
        if !granted { pushStatus = String(localized: "Notifications are off for Messenger in Settings") }
        let ns = await UNUserNotificationCenter.current().notificationSettings()
        // 0 notSupported, 1 disabled, 2 enabled; read over the cable with `devicectl … --console`
        print("DIAG auth=\(ns.authorizationStatus.rawValue) sound=\(ns.soundSetting.rawValue) alert=\(ns.alertSetting.rawValue) lock=\(ns.lockScreenSetting.rawValue) banner=\(ns.alertStyle.rawValue) timeSensitive=\(ns.timeSensitiveSetting.rawValue) critical=\(ns.criticalAlertSetting.rawValue) summary=\(ns.scheduledDeliverySetting.rawValue) announce=\(ns.announcementSetting.rawValue)")
    }

    /**
     * Remembers the APNs token iOS handed out and sends it to the server.
     *
     * - Parameter hex: The device token as a hex string.
     */
    func didReceiveAPNsToken(_ hex: String) {
        apnsToken = hex
        UserDefaults.standard.set(hex, forKey: AppConfig.Keys.apnsToken)
        Task { await registerDeviceIfPossible() }
    }

    /** Registers the stored APNs token with the backend and updates `pushStatus`. Demo mode sends nothing. */
    private func registerDeviceIfPossible() async {
        guard let backend, let token = apnsToken else { return }
        if backend.isDemo {
            pushStatus = String(localized: "Demo mode: device not sent to the server")
            return
        }
        do {
            try await backend.registerDevice(apnsToken: token)
            pushStatus = String(localized: "Registered (\(AppConfig.pushEnvironment))")
        } catch {
            if (error as? APIError) == .unauthorized { handleUnauthorized(); return }
            pushStatus = String(localized: "Couldn't register: \(error.localizedDescription)")
        }
    }

    // MARK: - Conversations

    /**
     * Loads the conversation list from the backend, sorts it newest first, marks the open thread read
     * if it has unread messages and updates the badge. On failure the error text is kept for the list.
     */
    func refreshConversations() async {
        guard let backend else { return }
        do {
            let list = try await backend.conversations()
            conversations = list.sorted { $0.lastAt > $1.lastAt }
            conversationsError = nil
            conversationsLoaded = true
            if let vid = openThreadVid, unread(vid) > 0 { await markRead(vid: vid) }
            updateBadge()
        } catch {
            if !fail(error) { conversationsError = error.localizedDescription }
            conversationsLoaded = true
        }
    }

    /**
     * Looks up a conversation, falling back to the visitor's entry in the online list and then to an
     * empty conversation.
     *
     * - Parameter vid: Visitor id.
     * - Returns: The conversation for that visitor; never nil.
     */
    func conversation(_ vid: String) -> Conversation {
        if let c = conversations.first(where: { $0.vid == vid }) { return c }
        if let o = onSite.first(where: { $0.vid == vid }) { return o.asConversation }
        return Conversation(vid: vid)
    }

    /**
     * Unread count of one conversation.
     *
     * - Parameter vid: Visitor id.
     * - Returns: The unread count, or 0 when the conversation is unknown.
     */
    private func unread(_ vid: String) -> Int { conversations.first { $0.vid == vid }?.unread ?? 0 }

    /**
     * Tells whether a visitor is typing right now.
     *
     * - Parameter vid: Visitor id.
     * - Returns: True while typing frames keep arriving for that visitor.
     */
    func isTyping(_ vid: String) -> Bool { typing.contains(vid) }

    // MARK: - Thread

    /**
     * Marks a thread as the one on screen, loads its messages and marks it read.
     *
     * - Parameter vid: Visitor id.
     */
    func openThread(_ vid: String) async {
        openThreadVid = vid
        updateRinging()
        await loadMessages(vid: vid)
        await markRead(vid: vid)
    }

    /**
     * Notes that a thread left the screen.
     *
     * - Parameter vid: Visitor id.
     */
    func closeThread(_ vid: String) {
        if openThreadVid == vid { openThreadVid = nil }
        updateRinging()
    }

    /**
     * Loads a thread's messages, sorted oldest first, keeping local messages that are still being sent
     * or have failed at the end. An error is shown only when the thread has nothing loaded yet.
     *
     * - Parameter vid: Visitor id.
     */
    func loadMessages(vid: String) async {
        guard let backend else { return }
        do {
            let list = try await backend.messages(vid: vid)
            let pending = (messages[vid] ?? []).filter { $0.isPending || $0.isFailed }
            messages[vid] = list.sorted { $0.at < $1.at } + pending
        } catch {
            if !fail(error), messages[vid] == nil { alertMessage = error.localizedDescription }
        }
    }

    /**
     * Clears a conversation's unread count locally and tells the backend.
     *
     * - Parameter vid: Visitor id.
     */
    func markRead(vid: String) async {
        guard let backend else { return }
        let had = unread(vid)
        setConversation(vid) { $0.unread = 0 }
        updateBadge()
        guard had > 0 || backend.isDemo == false else { return }
        do { try await backend.markRead(vid: vid) } catch { _ = fail(error) }
    }

    /**
     * Sends a reply: shows it at once as pending, then delivers it.
     *
     * - Parameter vid: Visitor id.
     * - Parameter text: The message; trimmed, ignored when empty, and cut to 2000 characters.
     * - Parameter email: True to ask the server to send it as an email too.
     */
    func send(vid: String, text: String, email: Bool = false) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let backend, !text.isEmpty else { return }
        let temp = Message(id: "local-\(UUID().uuidString)", vid: vid, from: .owner, text: String(text.prefix(2000)),
                           at: Fmt.nowMs, isPending: true)
        messages[vid, default: []].append(temp)
        await deliver(temp, backend: backend, email: email)
    }

    /**
     * Tries again to send a message that failed.
     *
     * - Parameter message: The failed local message.
     */
    func retry(_ message: Message) async {
        guard let backend else { return }
        replace(message.id, in: message.vid) { $0.isFailed = false; $0.isPending = true }
        await deliver(message, backend: backend)
    }

    /**
     * Sends a pending message through the backend and swaps it for the server's copy, or marks it
     * failed and shows the error.
     *
     * - Parameter temp: The local pending message.
     * - Parameter backend: The backend to send through.
     * - Parameter email: True to ask the server to send it as an email too.
     */
    private func deliver(_ temp: Message, backend: any ChatBackend, email: Bool = false) async {
        let vid = temp.vid
        do {
            let sent = try await backend.send(vid: vid, text: temp.text, email: email)
            if messages[vid]?.contains(where: { $0.id == sent.id }) == true {
                messages[vid]?.removeAll { $0.id == temp.id }       // the WebSocket echo got here first
            } else {
                replace(temp.id, in: vid) { $0 = sent }
            }
            upsertSummary(for: sent, conversation: nil)
        } catch {
            replace(temp.id, in: vid) { $0.isPending = false; $0.isFailed = true }
            if !fail(error) { alertMessage = error.localizedDescription }
        }
    }

    /**
     * Tells the visitor the owner is typing, at most once every 2 seconds per thread.
     *
     * - Parameter vid: Visitor id.
     */
    func ownerTyping(vid: String) {
        guard let backend else { return }
        let now = Date.now
        if let last = lastTypingSent[vid], now.timeIntervalSince(last) < 2 { return }
        lastTypingSent[vid] = now
        backend.sendTyping(vid: vid)
    }

    /**
     * Blocks or unblocks a visitor and updates the list and the badge.
     *
     * - Parameter vid: Visitor id.
     * - Parameter blocked: True to block.
     */
    func setBlocked(vid: String, _ blocked: Bool) async {
        guard let backend else { return }
        do {
            try await backend.setBlocked(vid: vid, blocked: blocked)
            if conversations.contains(where: { $0.vid == vid }) {
                setConversation(vid) { $0.blocked = blocked }
            } else {
                await refreshConversations()
            }
            updateBadge()
        } catch {
            if !fail(error) { alertMessage = error.localizedDescription }
        }
    }

    /**
     * From the online list or a VISIT notification: jump to that visitor's thread, with a greeting
     * ready in the composer when there's no conversation yet.
     *
     * - Parameter vid: Visitor id.
     * - Parameter sayHi: True to prefill the greeting when nothing has been said or drafted.
     */
    func openChat(vid: String, sayHi: Bool = false) {
        if sayHi, (messages[vid] ?? []).isEmpty, conversations.first(where: { $0.vid == vid })?.lastText == nil,
           (drafts[vid] ?? "").isEmpty {
            drafts[vid] = String(localized: "Hi! Thanks for stopping by. Anything I can help with?")
        }
        selectedTab = .chats
        chatPath = [vid]
    }

    // MARK: - Who's online

    /** Reloads the list of people who have the site open. */
    func refreshOnline() async {
        guard let backend else { return }
        do { onSite = try await backend.online() } catch { _ = fail(error) }
    }

    // MARK: - Settings

    /**
     * Loads the owner's settings.
     *
     * - Throws: The backend's error, after a 401 has been handled.
     */
    func loadSettings() async throws {
        guard let backend else { return }
        do { settings = try await backend.settings() } catch { _ = fail(error); throw error }
    }

    /**
     * Saves changed settings and keeps the server's answer; shows an alert on failure.
     *
     * - Parameter patch: The fields to change.
     */
    func updateSettings(_ patch: SettingsPatch) async {
        guard let backend else { return }
        do {
            settings = try await backend.updateSettings(patch)
        } catch {
            if !fail(error) { alertMessage = error.localizedDescription }
        }
    }

    /**
     * Asks the server to send a test push to the owner's devices.
     *
     * - Parameter kind: Which push to send, "message" or "visit".
     * - Returns: A line for the UI saying how many devices it went to, or the error text.
     */
    func testPush(kind: String) async -> String {
        guard let backend else { return "" }
        do {
            let n = try await backend.testPush(kind: kind)
            return n == 0 ? String(localized: "Sent to 0 devices — is this phone registered?")
                          : String(localized: "Sent to \(n) device(s)")
        } catch {
            _ = fail(error)
            return error.localizedDescription
        }
    }

    // MARK: - Real-time events

    /**
     * Routes a real-time event: connection state, sign-out, or a server frame.
     *
     * - Parameter event: The event from the backend.
     */
    private func handle(_ event: RealtimeEvent) {
        switch event {
        case .state(let s): connection = s
        case .unauthorized: handleUnauthorized()
        case .frame(let f): handle(frame: f)
        }
    }

    /**
     * Applies one server frame to the local state: a new message, a visitor going online or offline,
     * typing, a read receipt, or a visitor who deleted their data.
     *
     * - Parameter f: The decoded frame.
     */
    private func handle(frame f: ServerFrame) {
        switch f.type {
        case "message":
            guard let m = f.message else { return }
            let vid = f.vid ?? m.vid
            var message = m
            if message.vid.isEmpty { message.vid = vid }
            insert(message)
            upsertSummary(for: message, conversation: f.conversation)
            if message.from == .visitor {
                stopTyping(vid)
                let blocked = conversations.first { $0.vid == vid }?.blocked ?? false
                _ = blocked                                   // ringing (updateBadge → updateRinging) covers the sound
                if openThreadVid == vid && isActive { Task { await markRead(vid: vid) } }
            }
            updateBadge()
        case "visitor":
            guard let vid = f.vid else { return }
            if let c = f.conversation {
                upsertConversation(c)
            } else if f.event == "online" || f.event == "offline" {
                setConversation(vid) { $0.online = f.event == "online" }
            }
            if f.event == "online" && !demoMode { Feedback.shared.visitHaptic() }
            if f.event == "online" {
                let b = f.visitor
                let o = OnlineVisitor(vid: vid, page: f.page ?? "/", at: f.at ?? Fmt.nowMs,
                                      since: onSite.first { $0.vid == vid }?.since,
                                      place: b?.place?.nonEmpty ?? f.conversation?.place, device: b?.device?.nonEmpty ?? f.conversation?.device,
                                      visits: b?.visits ?? f.conversation?.visits ?? 1, conversation: f.conversation)
                onSite.removeAll { $0.vid == vid }
                onSite.insert(o, at: 0)
            }
            if f.event == "offline" { stopTyping(vid); onSite.removeAll { $0.vid == vid } }
        case "typing":
            guard let vid = f.vid else { return }
            if let text = f.text {
                if text.isEmpty { drafting[vid] = nil; stopTyping(vid); return }
                drafting[vid] = text
            }
            startTyping(vid)
        case "read":
            guard let vid = f.vid else { return }
            visitorReadAt[vid] = max(visitorReadAt[vid] ?? 0, f.at ?? Fmt.nowMs)
        case "forgotten":                                     // the visitor deleted their data (docs/chat-protocol.md)
            guard let vid = f.vid else { return }
            conversations.removeAll { $0.vid == vid }
            messages[vid] = nil
            drafting[vid] = nil
            stopTyping(vid)
            onSite.removeAll { $0.vid == vid }
            chatPath.removeAll { $0 == vid }
            updateBadge()
        default:
            break
        }
    }

    /**
     * Adds a message to its loaded thread, replacing the matching pending copy of an owner message.
     * Does nothing when the thread isn't loaded or already has the message.
     *
     * - Parameter m: The message to add.
     */
    private func insert(_ m: Message) {
        var list = messages[m.vid] ?? []
        guard messages[m.vid] != nil else { return }               // thread not loaded; it'll be fetched on open
        if list.contains(where: { $0.id == m.id }) { return }
        if m.from == .owner, let i = list.firstIndex(where: { $0.isPending && $0.text == m.text }) {
            list[i] = m
        } else {
            list.append(m)
            list.sort { $0.at < $1.at }
        }
        messages[m.vid] = list
    }

    /**
     * Updates the conversation row for a new message, using the server's summary when the frame
     * carried one and otherwise adjusting the last text, time and unread count locally.
     *
     * - Parameter m: The new message.
     * - Parameter conversation: The summary the server sent with it, if any.
     */
    private func upsertSummary(for m: Message, conversation: Conversation?) {
        if let conversation {
            var c = conversation
            if c.vid.isEmpty { c.vid = m.vid }
            if openThreadVid == c.vid && isActive { c.unread = 0 }
            upsertConversation(c)
            return
        }
        if conversations.contains(where: { $0.vid == m.vid }) {
            setConversation(m.vid) {
                $0.lastText = m.text; $0.lastFrom = m.from; $0.lastAt = max($0.lastAt, m.at)
                if m.from == .visitor && !(self.openThreadVid == m.vid && self.isActive) { $0.unread += 1 }
            }
        } else {
            var c = self.conversation(m.vid)
            c.lastText = m.text; c.lastFrom = m.from; c.lastAt = m.at
            c.unread = m.from == .visitor && openThreadVid != m.vid ? 1 : 0
            upsertConversation(c)
        }
    }

    /**
     * Inserts or replaces a conversation and re-sorts the list newest first.
     *
     * - Parameter c: The conversation.
     */
    private func upsertConversation(_ c: Conversation) {
        if let i = conversations.firstIndex(where: { $0.vid == c.vid }) { conversations[i] = c } else { conversations.append(c) }
        conversations.sort { $0.lastAt > $1.lastAt }
    }

    /**
     * Changes one conversation in place.
     *
     * - Parameter vid: Visitor id.
     * - Parameter change: The edit to apply; not called when the conversation is unknown.
     */
    private func setConversation(_ vid: String, _ change: (inout Conversation) -> Void) {
        guard let i = conversations.firstIndex(where: { $0.vid == vid }) else { return }
        change(&conversations[i])
    }

    /**
     * Changes one message in place.
     *
     * - Parameter id: Message id.
     * - Parameter vid: Visitor id of the thread.
     * - Parameter change: The edit to apply; not called when the message is not found.
     */
    private func replace(_ id: String, in vid: String, _ change: (inout Message) -> Void) {
        guard let i = messages[vid]?.firstIndex(where: { $0.id == id }) else { return }
        change(&messages[vid]![i])
    }

    /**
     * Marks a visitor as typing and (re)starts the timer that clears it after 20 seconds.
     *
     * - Parameter vid: Visitor id.
     */
    private func startTyping(_ vid: String) {
        typing.insert(vid)
        typingTimers[vid]?.cancel()
        typingTimers[vid] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))          // a paused draft stays visible for a while
            guard !Task.isCancelled else { return }
            self?.typing.remove(vid)
            self?.drafting[vid] = nil
        }
    }

    /**
     * Clears a visitor's typing state and draft at once.
     *
     * - Parameter vid: Visitor id.
     */
    private func stopTyping(_ vid: String) {
        typingTimers[vid]?.cancel()
        typing.remove(vid)
        drafting[vid] = nil
    }

    // MARK: - Notifications

    /**
     * Decides how a push shows while the app is in front.
     *
     * - Parameter kind: The push's "kind" value.
     * - Parameter vid: The push's visitor id.
     * - Returns: Nothing for a message or typing push whose thread is on screen; otherwise banner,
     *   list, sound and badge.
     */
    func presentationOptions(kind: String?, vid: String?) -> UNNotificationPresentationOptions {
        if kind == "message" || kind == "typing", let vid, vid == openThreadVid, isActive { return [] }   // already watching it live
        // chat messages always sound, even with the app open: they are meant to cut through
        return [.banner, .list, .sound, .badge]
    }

    /**
     * Handles a tap (deep link) or an action button (REPLY / READ / SAY_HI). Works when the app was
     * launched in the background just for the action: the backend is built from the Keychain token.
     *
     * - Parameter action: The action identifier from the notification response.
     * - Parameter kind: The push's "kind" value.
     * - Parameter vid: The push's visitor id.
     * - Parameter replyText: What the owner typed for REPLY.
     */
    func handleNotificationAction(_ action: String, kind: String?, vid: String, replyText: String?) async {
        switch action {
        case NotificationSetup.replyAction:
            guard let text = replyText?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
            if let backend {
                _ = try? await backend.send(vid: vid, text: text, email: false)
                try? await backend.markRead(vid: vid)
            }
            await refreshBadgeFromServer()
        case NotificationSetup.readAction:
            if let backend { try? await backend.markRead(vid: vid) }
            await refreshBadgeFromServer()
        case UNNotificationDismissActionIdentifier:
            break
        default: // default tap or SAY_HI (foreground)
            openChat(vid: vid, sayHi: action == NotificationSetup.sayHiAction || kind == "visit")
        }
    }

    /** Reloads conversations so the badge matches the server after a background action. */
    private func refreshBadgeFromServer() async {
        await refreshConversations()
        updateBadge()
    }

    /** Updates ringing and, once the list has loaded, sets the app icon badge to the unread total. */
    private func updateBadge() {
        updateRinging()
        guard conversationsLoaded else { return }
        UNUserNotificationCenter.current().setBadgeCount(totalUnread) { _ in }
    }

    /**
     * Ring (looping alert) while the app is open and some chat other than the one on screen has unread messages.
     * Demo mode never rings.
     */
    func updateRinging() {
        let waiting = conversations.contains { !$0.blocked && $0.unread > 0 && $0.vid != openThreadVid }
        Feedback.shared.setRinging(waiting && isActive && !demoMode)
    }

    /**
     * Sorts out an error from the backend.
     *
     * - Parameter error: The error.
     * - Returns: True when the error was handled (401 → sign in again) or was a cancellation.
     */
    private func fail(_ error: Error) -> Bool {
        if (error as? APIError) == .unauthorized {
            handleUnauthorized()
            return true
        }
        return error is CancellationError
    }
}
