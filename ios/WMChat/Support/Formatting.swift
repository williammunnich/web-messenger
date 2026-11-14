/**
 * @file Formatting.swift
 * Text formatting helpers used across the views: times, durations, visit labels and referrer hosts.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */

import Foundation

/** Formatting helpers, grouped in a namespace. */
enum Fmt {
    /**
     * "14:05" today, "Yesterday", weekday within a week, else a short date.
     *
     * - Parameter ms: Unix milliseconds; 0 or less gives an empty string.
     * - Returns: The time for a list row.
     */
    static func listTime(ms: Double) -> String {
        guard ms > 0 else { return "" }
        let date = Date(timeIntervalSince1970: ms / 1000)
        let cal = Calendar.current
        if cal.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if cal.isDateInYesterday(date) { return String(localized: "Yesterday") }
        if let days = cal.dateComponents([.day], from: date, to: .now).day, days < 7 {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(date: .numeric, time: .omitted)
    }

    /**
     * Header shown above a group of messages, Messages style.
     *
     * - Parameter ms: Unix milliseconds.
     * - Returns: "Today 14:05", "Yesterday 14:05", or weekday, date and time.
     */
    static func threadHeader(ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let cal = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if cal.isDateInToday(date) { return String(localized: "Today \(time)") }
        if cal.isDateInYesterday(date) { return String(localized: "Yesterday \(time)") }
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute())
    }

    /**
     * Formats a number as an ordinal, such as "5th".
     *
     * - Parameter n: The number.
     * - Returns: The ordinal, or the plain number if formatting fails.
     */
    static func ordinal(_ n: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .ordinal
        return f.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    /**
     * "Returning · 5th visit" or "New".
     *
     * - Parameter visits: How many visits the visitor has made.
     * - Returns: The label.
     */
    static func visitLabel(_ visits: Int) -> String {
        visits > 1 ? String(localized: "Returning · \(ordinal(visits)) visit") : String(localized: "New")
    }

    /**
     * "4m 12s", "1h 03m", "35s".
     *
     * - Parameter seconds: The duration; negative counts as 0.
     * - Returns: The short duration text.
     */
    static func duration(seconds: Double) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m \(String(format: "%02d", s % 60))s" }
        return "\(s / 3600)h \(String(format: "%02d", (s % 3600) / 60))m"
    }

    /**
     * Unix seconds or milliseconds to a Date (profiles don't say which; values above 1e12 are ms).
     *
     * - Parameter value: The timestamp.
     * - Returns: The date.
     */
    static func date(unix value: Double) -> Date {
        Date(timeIntervalSince1970: value > 1e12 ? value / 1000 : value)
    }

    /**
     * Joins the parts that are present and not blank.
     *
     * - Parameter parts: The pieces; nil and blank ones are skipped.
     * - Parameter separator: What to put between them.
     * - Returns: The joined text.
     */
    static func joined(_ parts: [String?], separator: String = " · ") -> String {
        parts.compactMap { $0?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: separator)
    }

    /**
     * "google.com" from a full referrer URL.
     *
     * - Parameter ref: The referrer.
     * - Returns: The host without "www.", the input itself when it has no host, or nil when empty.
     */
    static func refHost(_ ref: String?) -> String? {
        guard let ref, !ref.isEmpty else { return nil }
        if let host = URL(string: ref)?.host() {
            return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        }
        return ref
    }

    /**
     * Makes a random letters-and-digits string, used as the sign-in `state` value.
     *
     * - Parameter length: Number of characters.
     * - Returns: The random string.
     */
    static func randomState(length: Int = 32) -> String {
        let chars = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        var rng = SystemRandomNumberGenerator()
        return String((0..<length).map { _ in chars[Int(rng.next(upperBound: UInt64(chars.count)))] })
    }

    /** The current time in unix milliseconds. */
    static var nowMs: Double { Date.now.timeIntervalSince1970 * 1000 }
}
