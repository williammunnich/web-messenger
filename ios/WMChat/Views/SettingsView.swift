/**
 * @file SettingsView.swift
 * The Settings tab: availability, visit notifications, the greeting, notification status and test
 * pushes, the inbox link, Demo mode and sign-out.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

import SwiftUI
import UserNotifications

/**
 * The Settings tab. Changes are saved through AppModel as soon as they are made, except the
 * greeting, which has its own Save button.
 */
struct SettingsView: View {
    /** When the inbox link was last copied. */
    @State private var copiedAt: Date?
    /** True for 2 seconds after the inbox link was copied. */
    private var copied: Bool { copiedAt.map { Date.now.timeIntervalSince($0) < 2 } ?? false }
    @Environment(AppModel.self) private var model
    /** The greeting as edited in the text field. */
    @State private var greeting = ""
    /** Why the settings could not be loaded, if they couldn't. */
    @State private var loadError: String?
    /** The result line of the last test push. */
    @State private var testResult: String?
    /** True while a test push is being sent. */
    @State private var sendingTest = false
    /** True while the sign-out confirmation is showing. */
    @State private var confirmSignOut = false
    /** iOS's notification permission for the app; nil until read. */
    @State private var notificationStatus: UNAuthorizationStatus?
    @Environment(\.scenePhase) private var scenePhase
    /**
     * Whether iOS will play sounds, deliver time-sensitive alerts and allow critical alerts for the
     * app; nil until read.
     */
    @State private var soundsOn: Bool?
    @State private var timeSensitiveOn: Bool?
    @State private var criticalOn: Bool?

    /** The settings form. */
    var body: some View {
        NavigationStack {
            Form {
                if let loadError {
                    WMSection {
                        Label(loadError, systemImage: "wifi.exclamationmark").foregroundStyle(.secondary)
                        Button("Try again") { Task { await load() } }
                    }
                }

                WMSection {
                    Toggle(isOn: Binding(get: { model.settings?.available ?? false },
                                         set: { on in Task { await model.updateSettings(SettingsPatch(available: on)) } })) {
                        Label {
                            Text("Available")
                        } icon: {
                            Image(systemName: "circle.fill")
                                .foregroundStyle(model.settings?.available == true ? Theme.online : Theme.quiet)
                        }
                    }
                    .disabled(model.settings == nil)
                } footer: {
                    Text("On: the site's chat bubble says “Online” and expects a reply soon. Off: it says “Leave a message” and asks for an email. Messages notify either way.")
                }

                WMSection {
                    Picker("Visit notifications", selection: Binding(
                        get: { model.settings?.visitPings ?? .all },
                        set: { p in Task { await model.updateSettings(SettingsPatch(visitPings: p.rawValue)) } })) {
                        ForEach(VisitPings.allCases) { Text($0.label).tag($0) }
                    }
                    .disabled(model.settings == nil)
                } footer: {
                    Text("A push when someone loads a page (at most one per visitor every 30 minutes).")
                }

                WMSection {
                    TextField("Greeting", text: $greeting, axis: .vertical)
                        .lineLimit(2...6)
                    if greeting != (model.settings?.greeting ?? "") {
                        Button("Save greeting") {
                            Task { await model.updateSettings(SettingsPatch(greeting: greeting)) }
                        }
                    }
                } header: {
                    Text("Greeting")
                } footer: {
                    Text("The first thing visitors see when they open the chat bubble.")
                }

                WMSection {
                    LabeledContent("Permission", value: permissionText)
                    LabeledContent("This device", value: model.pushStatus)
                    // what iOS will actually do with a chat alert (read from iOS, refreshed each time Settings opens)
                    LabeledContent("Sounds", value: soundsOn.map { $0 ? "On" : "OFF: alerts are silent" } ?? "…")
                    LabeledContent("Time Sensitive", value: timeSensitiveOn.map { $0 ? "On" : "OFF: Focus can hold alerts" } ?? "…")
                    LabeledContent("Rings on silent", value: criticalOn == true ? "Yes (critical alerts)" : "No: needs Apple's Critical Alerts approval")
                    if soundsOn == false || timeSensitiveOn == false {
                        Button("Fix in iOS Settings") {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    }
                    Button { Task { await test("message") } } label: {
                        Label("Send test message notification", systemImage: "message.badge")
                    }
                    Button { Task { await test("visit") } } label: {
                        Label("Send test visit notification", systemImage: "person.badge.clock")
                    }
                    if notificationStatus == .denied {
                        Button("Open iOS Settings") {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                    }
                } header: {
                    Text("Notifications")
                } footer: {
                    if sendingTest { Text("Sending…") } else if let testResult { Text(testResult) }
                }

                WMSection {
                    if let host = model.dashHost, let url = AppConfig.dashURL(host: host) {
                        Link(destination: url) {
                            Label("Open inbox in Safari", systemImage: "safari")
                        }
                        Button {
                            UIPasteboard.general.string = url.absoluteString
                            copiedAt = .now
                            UINotificationFeedbackGenerator().notificationOccurred(.success)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(copied ? "Copied" : "Inbox link · tap to copy").font(Font.wm(.subheadline))
                                    Text(url.absoluteString).font(Font.wm(.caption).monospaced()).foregroundStyle(Theme.quiet)
                                        .lineLimit(1).truncationMode(.middle)
                                }
                                Spacer()
                                Image(systemName: copied ? "checkmark" : "doc.on.doc").foregroundStyle(Theme.accent)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Copies the inbox address")
                    }
                    LabeledContent("Real-time", value: connectionText)
                } header: {
                    Text("Inbox")
                }

                WMSection {
                    Toggle("Demo mode", isOn: Binding(get: { model.demoMode }, set: { model.setDemoMode($0) }))
                } footer: {
                    Text("Made-up chats and visitors for trying the app. Turning it off returns to the real server (sign in if needed).")
                }

                if model.isSignedIn {
                    WMSection {
                        Button("Sign out", role: .destructive) { confirmSignOut = true }
                    }
                }

                WMSection {
                } footer: {
                    Text("WM Chat \(AppConfig.appVersion) · push env: \(AppConfig.pushEnvironment)")
                        .frame(maxWidth: .infinity)
                }
            }
            .navigationTitle("Settings")
            .wmScreen()
            .confirmationDialog("Sign out of WM Chat?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await model.signOut() } }
            } message: {
                Text("This phone stops getting chat and visit notifications until you sign in again.")
            }
            .task(id: scenePhase) { if scenePhase == .active { await load() } }   // re-read after a trip to iOS Settings
            .refreshable { await load() }
            .onChange(of: model.settings?.greeting) { _, new in greeting = new ?? "" }
        }
    }

    /** The notification permission in words. */
    private var permissionText: String {
        switch notificationStatus {
        case .authorized: String(localized: "Allowed")
        case .denied: String(localized: "Denied")
        case .provisional, .ephemeral: String(localized: "Quiet")
        case .notDetermined: String(localized: "Not asked yet")
        default: "–"
        }
    }

    /** The real-time connection state in words, or "Demo". */
    private var connectionText: String {
        if model.backend?.isDemo == true { return String(localized: "Demo") }
        return switch model.connection {
        case .connected: String(localized: "Connected")
        case .connecting: String(localized: "Connecting…")
        case .waiting(let s): String(localized: "Retrying in \(s)s")
        case .off: String(localized: "Off")
        }
    }

    /**
     * Reads the notification settings from iOS and the owner's settings from the server, and shows
     * the error if the server part fails (a cancellation is ignored).
     */
    private func load() async {
        let ns = await UNUserNotificationCenter.current().notificationSettings()
        notificationStatus = ns.authorizationStatus
        soundsOn = ns.soundSetting == .enabled
        timeSensitiveOn = ns.timeSensitiveSetting == .enabled
        criticalOn = ns.criticalAlertSetting == .enabled
        do {
            try await model.loadSettings()
            greeting = model.settings?.greeting ?? ""
            loadError = nil
        } catch is CancellationError {
        } catch {
            loadError = error.localizedDescription
        }
    }

    /**
     * Sends a test push and shows the result line; in Demo mode the line explains the local notification.
     *
     * - Parameter kind: "message" or "visit".
     */
    private func test(_ kind: String) async {
        sendingTest = true
        testResult = await model.testPush(kind: kind)
        sendingTest = false
        if model.backend?.isDemo == true { testResult = String(localized: "Demo: a local notification arrives in 3 s (lock the phone to see it as a push).") }
    }
}
