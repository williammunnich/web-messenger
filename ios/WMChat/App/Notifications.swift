/**
 * @file Notifications.swift
 * Notification categories and actions, and the app delegate that registers for push and passes
 * notification taps and actions on to AppModel.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */

import UIKit
import UserNotifications

/** Categories and actions exactly as docs/chat-protocol.md names them. */
enum NotificationSetup {
    static let messageCategory = "MESSAGE"
    static let visitCategory = "VISIT"
    static let replyAction = "REPLY"
    static let readAction = "READ"
    static let sayHiAction = "SAY_HI"

    /** The MESSAGE category (Reply, Mark read) and the VISIT category (Say hi). */
    static var categories: Set<UNNotificationCategory> {
        let reply = UNTextInputNotificationAction(identifier: replyAction, title: String(localized: "Reply"),
                                                  options: [.authenticationRequired],
                                                  textInputButtonTitle: String(localized: "Send"),
                                                  textInputPlaceholder: String(localized: "Message"))
        let read = UNNotificationAction(identifier: readAction, title: String(localized: "Mark read"), options: [])
        let sayHi = UNNotificationAction(identifier: sayHiAction, title: String(localized: "Say hi"), options: [.foreground])
        return [
            UNNotificationCategory(identifier: messageCategory, actions: [reply, read], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: visitCategory, actions: [sayHi], intentIdentifiers: [], options: []),
        ]
    }

    /**
     * Asks for alert/sound/badge and registers with APNs. Time-sensitive delivery comes from the
     * `com.apple.developer.usernotifications.time-sensitive` entitlement (the old `.timeSensitive`
     * authorization option is deprecated and ignored).
     *
     * - Returns: True when the user allowed notifications.
     */
    @MainActor
    static func requestAuthorizationAndRegister() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge, .criticalAlert])) ?? false
        UIApplication.shared.registerForRemoteNotifications()
        return granted
    }
}

/** Push registration + notification delegate. */
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    /**
     * Sets this object as the notification delegate and registers the categories at launch.
     *
     * - Parameter application: The app.
     * - Parameter launchOptions: Why the app was launched; unused.
     * - Returns: Always true.
     */
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(NotificationSetup.categories)
        return true
    }

    /**
     * Passes the APNs device token, as hex, to AppModel.
     *
     * - Parameter application: The app.
     * - Parameter deviceToken: The token from APNs.
     */
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        MainActor.assumeIsolated { AppModel.shared.didReceiveAPNsToken(hex) }
    }

    /**
     * Shows the registration error as the push status.
     *
     * - Parameter application: The app.
     * - Parameter error: Why APNs registration failed.
     */
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        let text = error.localizedDescription
        MainActor.assumeIsolated { AppModel.shared.pushStatus = String(localized: "APNs registration failed: \(text)") }
    }

    /**
     * Foreground: asks AppModel how to show the push (nothing for a message whose thread is open on
     * screen, otherwise banner and sound).
     *
     * - Parameter center: The notification center.
     * - Parameter notification: The push that arrived.
     * - Returns: The presentation options to use.
     */
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let info = Self.keys(notification.request.content.userInfo)
        return await MainActor.run { AppModel.shared.presentationOptions(kind: info.kind, vid: info.vid) }
    }

    /**
     * Runs the tapped notification or action through AppModel and waits until it has finished.
     * Ignored when the push carries no visitor id.
     *
     * - Parameter center: The notification center.
     * - Parameter response: The user's response, with the typed text for a reply.
     */
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = Self.keys(response.notification.request.content.userInfo)
        let action = response.actionIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        guard let vid = info.vid, !vid.isEmpty else { return }
        let kind = info.kind
        await MainActor.run {
            AppModel.shared.notificationTask = Task {
                await AppModel.shared.handleNotificationAction(action, kind: kind, vid: vid, replyText: text)
            }
        }
        await AppModel.shared.notificationTask?.value
    }

    /**
     * Reads the two custom keys of a push payload.
     *
     * - Parameter userInfo: The notification's userInfo.
     * - Returns: The "kind" and "vid" values, each nil when missing.
     */
    nonisolated private static func keys(_ userInfo: [AnyHashable: Any]) -> (kind: String?, vid: String?) {
        (userInfo["kind"] as? String, userInfo["vid"] as? String)
    }
}
