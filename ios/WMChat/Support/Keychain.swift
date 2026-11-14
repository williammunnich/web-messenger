/**
 * @file Keychain.swift
 * A small Keychain wrapper. The app uses it to keep the owner's session token.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */

import Foundation
import Security

/**
 * Tiny generic-password wrapper. Items are readable after first unlock so notification
 * actions (Reply / Mark read) work while the phone is locked.
 */
enum Keychain {
    /** The Keychain service name: the app's bundle identifier. */
    private static let service = Bundle.main.bundleIdentifier ?? "messenger"

    /**
     * Reads a stored string.
     *
     * - Parameter account: The item's account name.
     * - Returns: The value, or nil when there is none.
     */
    static func string(for account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /**
     * Stores a string, replacing any earlier value for the account.
     *
     * - Parameter value: The text to store.
     * - Parameter account: The item's account name.
     * - Returns: True when it was saved.
     */
    @discardableResult
    static func set(_ value: String, for account: String) -> Bool {
        delete(account)
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    /**
     * Deletes the item for an account, if there is one.
     *
     * - Parameter account: The item's account name.
     */
    static func delete(_ account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
