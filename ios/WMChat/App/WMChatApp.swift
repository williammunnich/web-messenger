/**
 * @file WMChatApp.swift
 * The app's entry point and its top-level views: the root that picks setup or the main UI, and the
 * tab bar with Chats and Settings.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

import SwiftUI

/** The app: one window showing RootView, with AppModel in the environment and told about scene phase changes. */
@main
struct WMChatApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel.shared
    @Environment(\.scenePhase) private var scenePhase

    /** The single window scene. */
    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onChange(of: scenePhase, initial: true) { _, phase in model.scenePhaseChanged(phase) }
        }
    }
}

/**
 * Shows setup until a backend exists, then the tabs. Applies the theme's font, accent and page background,
 * and presents the app-wide error alert.
 */
struct RootView: View {
    @Environment(AppModel.self) private var model

    /** Setup or main UI, plus the shared styling and the error alert. */
    var body: some View {
        @Bindable var model = model
        Group {
            if model.isReady {
                MainTabView()
            } else {
                SetupView()
            }
        }
        .font(.wm(.body))
        .tint(Theme.accent)
        .background(Theme.paper.ignoresSafeArea())
        .onAppear { Theme.applyAppearance() }
        .alert(String(localized: "Something went wrong"),
               isPresented: Binding(get: { model.alertMessage != nil }, set: { if !$0 { model.alertMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.alertMessage ?? "")
        }
    }
}

/** The tab bar: Chats (with the unread badge) and Settings. Starts push setup when it appears. */
struct MainTabView: View {
    @Environment(AppModel.self) private var model

    /** The two tabs. */
    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.selectedTab) {
            Tab("Chats", systemImage: "bubble.left.and.bubble.right.fill", value: AppModel.Tab.chats) {
                ChatsView()
            }
            .badge(model.totalUnread)
            Tab("Settings", systemImage: "gearshape.fill", value: AppModel.Tab.settings) {
                SettingsView()
            }
        }
        .task { await model.setUpPush() }
    }
}
