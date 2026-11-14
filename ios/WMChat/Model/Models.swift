/**
 * @file Models.swift
 * Types from docs/chat-protocol.md, shared by the live and demo backends and the views. Decoding is
 * deliberately lenient (missing keys, nulls, numbers sent as strings) because the backend is being
 * written in parallel.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */

import Foundation

/**
 * Lenient readers: each returns nil (or an empty list) instead of throwing when a key is missing,
 * null or of an unexpected type.
 */
extension KeyedDecodingContainer {
    /**
     * Reads a string; a number is turned into text (whole numbers without a decimal point).
     *
     * - Parameter key: The key to read.
     * - Returns: The text, or nil.
     */
    func str(_ key: Key) -> String? {
        if let s = try? decodeIfPresent(String.self, forKey: key) { return s }
        if let d = try? decodeIfPresent(Double.self, forKey: key) {
            return d.rounded() == d ? String(Int64(d)) : String(d)
        }
        return nil
    }

    /**
     * Reads a number; also accepts a numeric string, and a boolean as 1 or 0.
     *
     * - Parameter key: The key to read.
     * - Returns: The number, or nil.
     */
    func num(_ key: Key) -> Double? {
        if let d = try? decodeIfPresent(Double.self, forKey: key) { return d }
        if let s = try? decodeIfPresent(String.self, forKey: key) { return Double(s) }
        if let b = try? decodeIfPresent(Bool.self, forKey: key) { return b ? 1 : 0 }
        return nil
    }

    /**
     * Reads a number and cuts it to an integer.
     *
     * - Parameter key: The key to read.
     * - Returns: The integer, or nil.
     */
    func int(_ key: Key) -> Int? { num(key).map { Int($0) } }

    /**
     * Reads a boolean; also accepts a number (non-zero is true) and the strings "1", "true" and "yes".
     *
     * - Parameter key: The key to read.
     * - Returns: The boolean, or nil.
     */
    func bool(_ key: Key) -> Bool? {
        if let b = try? decodeIfPresent(Bool.self, forKey: key) { return b }
        if let d = try? decodeIfPresent(Double.self, forKey: key) { return d != 0 }
        if let s = try? decodeIfPresent(String.self, forKey: key) { return ["1", "true", "yes"].contains(s.lowercased()) }
        return nil
    }

    /**
     * Reads a list of strings.
     *
     * - Parameter key: The key to read.
     * - Returns: The list, or an empty list when missing or malformed.
     */
    func strings(_ key: Key) -> [String] {
        (try? decodeIfPresent([String].self, forKey: key)) ?? []
    }
}

extension String {
    /** The string itself, or nil when it is empty. */
    var nonEmpty: String? { isEmpty ? nil : self }
}

/** Who wrote a message. */
enum Sender: String, Sendable, Hashable {
    case visitor, owner
}

/**
 * One chat message.
 * `{"id":"m_…","vid":"…","from":"visitor"|"owner","text":"…","at":ms,"page":"/…"?}`
 */
struct Message: Identifiable, Hashable, Sendable, Decodable {
    var id: String
    var vid: String
    var from: Sender
    var text: String
    /** When it was sent, in milliseconds since 1970. */
    var at: Double
    /** The page the visitor was on when writing, if known. */
    var page: String?
    /** Local only: sent by this app and not yet confirmed by the server. */
    var isPending = false
    /** Local only: sending failed and can be retried. */
    var isFailed = false

    /** The keys that come from the server; the local flags are not decoded. */
    enum CodingKeys: String, CodingKey { case id, vid, from, text, at, page }

    /** Creates a message from its parts. */
    init(id: String, vid: String, from: Sender, text: String, at: Double, page: String? = nil,
         isPending: Bool = false, isFailed: Bool = false) {
        self.id = id; self.vid = vid; self.from = from; self.text = text; self.at = at; self.page = page
        self.isPending = isPending; self.isFailed = isFailed
    }

    /**
     * Decodes a message leniently: a missing id gets a random one, a missing sender counts as the
     * visitor, and a missing time becomes now.
     *
     * - Parameter decoder: The decoder to read from.
     * - Throws: When the value is not a keyed container.
     */
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id) ?? UUID().uuidString
        vid = c.str(.vid) ?? ""
        from = Sender(rawValue: c.str(.from) ?? "") ?? .visitor
        text = c.str(.text) ?? ""
        at = c.num(.at) ?? Fmt.nowMs
        page = c.str(.page)?.nonEmpty
    }

    /** `at` as a Date. */
    var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

/**
 * One conversation as shown in the list.
 * `{"vid","name","email","lastText","lastFrom","lastAt","unread","online","place","device","visits","blocked"}`
 */
struct Conversation: Identifiable, Hashable, Sendable, Decodable {
    var vid: String
    var name: String?
    var email: String?
    var lastText: String?
    var lastFrom: Sender?
    /** Time of the last message, in milliseconds since 1970. */
    var lastAt: Double
    var unread: Int
    var online: Bool
    var place: String?
    var device: String?
    var visits: Int
    var blocked: Bool
    var channel: String? = nil          // "email" when the conversation came in by email

    /** The visitor id doubles as the list identity. */
    var id: String { vid }
    /** A chat visitor who left an address can also get replies by email. */
    var canEmail: Bool { email != nil && channel != "email" }

    /** The keys read from the server. */
    enum CodingKeys: String, CodingKey {
        case vid, name, email, lastText, lastFrom, lastAt, unread, online, place, device, visits, blocked, channel
    }

    /** Creates a conversation from its parts; everything but the visitor id has a default. */
    init(vid: String, name: String? = nil, email: String? = nil, lastText: String? = nil, lastFrom: Sender? = nil,
         lastAt: Double = 0, unread: Int = 0, online: Bool = false, place: String? = nil, device: String? = nil,
         visits: Int = 1, blocked: Bool = false) {
        self.vid = vid; self.name = name; self.email = email; self.lastText = lastText; self.lastFrom = lastFrom
        self.lastAt = lastAt; self.unread = unread; self.online = online; self.place = place; self.device = device
        self.visits = visits; self.blocked = blocked
    }

    /**
     * Decodes a conversation leniently; missing counts and flags get their defaults and empty strings become nil.
     *
     * - Parameter decoder: The decoder to read from.
     * - Throws: When the value is not a keyed container.
     */
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        vid = c.str(.vid) ?? ""
        name = c.str(.name)?.nonEmpty
        email = c.str(.email)?.nonEmpty
        lastText = c.str(.lastText)
        lastFrom = c.str(.lastFrom).flatMap(Sender.init(rawValue:))
        lastAt = c.num(.lastAt) ?? 0
        unread = c.int(.unread) ?? 0
        online = c.bool(.online) ?? false
        place = c.str(.place)?.nonEmpty
        device = c.str(.device)?.nonEmpty
        visits = c.int(.visits) ?? 1
        blocked = c.bool(.blocked) ?? false
        channel = c.str(.channel)?.nonEmpty
    }

    /** The visitor's name, else "Visitor from <city>" from the place, else "Visitor". */
    var displayName: String {
        if let name { return name }
        if let city = place?.split(separator: ",").first { return String(localized: "Visitor from \(String(city))") }
        return String(localized: "Visitor")
    }

    /** Up to two initials from the name, or nil when there is no name. */
    var initials: String? {
        guard let name else { return nil }
        let letters = name.split(separator: " ").prefix(2).compactMap(\.first)
        return letters.isEmpty ? nil : String(letters).uppercased()
    }
}

/** Someone browsing, in Demo mode only (the real list comes from `GET /owner/online`). */
struct LiveSession: Identifiable, Hashable, Sendable, Decodable {
    var id: String
    var vid: String?
    var visits: Int
    var chat: Bool
    /** When last seen, in seconds since 1970 (`firstSeen` uses the same unit). */
    var lastSeen: Double
    var firstSeen: Double?
    var views: Int?
    var page: String
    var ref: String?
    var city: String?
    var region: String?
    var country: String?
    var device: String?
    var os: String?
    var browser: String?
    var active: Bool
    var bot: Bool
    // extra detail for the map breakdown and the timeline
    var lat: Double? = nil
    var lon: Double? = nil
    var who: String? = nil
    var scroll: Int? = nil
    var clicks: Int? = nil
    var ip: String? = nil
    var isp: String? = nil

    /** The short keys this type is decoded from. */
    enum CodingKeys: String, CodingKey {
        case vid, visits, chat, t, f, v, p, ref, ci, rg, c, dev, os, br, active, bot, lat, lon, who, sc, clicks, ip, isp, s
    }

    /**
     * Creates a session from its parts. The id is the visitor id, or a combination of first-seen time,
     * city and device when there is none.
     */
    init(vid: String?, visits: Int, chat: Bool, lastSeen: Double, firstSeen: Double?, views: Int?, page: String,
         ref: String?, city: String?, region: String?, country: String?, device: String?, os: String?,
         browser: String?, active: Bool = true, bot: Bool = false) {
        self.vid = vid; self.visits = visits; self.chat = chat; self.lastSeen = lastSeen; self.firstSeen = firstSeen
        self.views = views; self.page = page; self.ref = ref; self.city = city; self.region = region
        self.country = country; self.device = device; self.os = os; self.browser = browser
        self.active = active; self.bot = bot
        self.id = vid ?? "\(Int(firstSeen ?? lastSeen))|\(city ?? "")|\(device ?? "")|\(os ?? "")|\(browser ?? "")"
    }

    /**
     * Decodes a session from the short keys, with defaults for what is missing.
     *
     * - Parameter decoder: The decoder to read from.
     * - Throws: When the value is not a keyed container.
     */
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            vid: c.str(.vid)?.nonEmpty, visits: c.int(.visits) ?? 1, chat: c.bool(.chat) ?? false,
            lastSeen: c.num(.t) ?? Date.now.timeIntervalSince1970, firstSeen: c.num(.f), views: c.int(.v),
            page: c.str(.p)?.nonEmpty ?? "/", ref: c.str(.ref)?.nonEmpty, city: c.str(.ci)?.nonEmpty,
            region: c.str(.rg)?.nonEmpty, country: c.str(.c)?.nonEmpty, device: c.str(.dev)?.nonEmpty,
            os: c.str(.os)?.nonEmpty, browser: c.str(.br)?.nonEmpty,
            active: c.bool(.active) ?? true, bot: c.bool(.bot) ?? false)
        lat = c.num(.lat); lon = c.num(.lon); who = c.str(.who)?.nonEmpty; scroll = c.int(.sc); clicks = c.int(.clicks)
        ip = c.str(.ip)?.nonEmpty; isp = c.str(.isp)?.nonEmpty
        if vid == nil, let s = c.str(.s)?.nonEmpty { id = s }      // one row per browsing session in the timeline
    }

    /** City, region and country joined with commas. */
    var place: String { Fmt.joined([city, region, country], separator: ", ") }
    /** Device, OS and browser on one line. */
    var deviceLine: String { Fmt.joined([device, os, browser]) }
    /** Seconds between first and last seen, or nil when the first time is unknown. */
    var secondsOnSite: Double? { firstSeen.map { max(0, lastSeen - $0) } }
}

/** Which visits make the owner's phone ping. */
enum VisitPings: String, CaseIterable, Sendable, Identifiable {
    case all, returning, off
    /** The raw value doubles as the picker identity. */
    var id: String { rawValue }
    /** The name shown in Settings. */
    var label: String {
        switch self {
        case .all: String(localized: "All")
        case .returning: String(localized: "Returning only")
        case .off: String(localized: "Off")
        }
    }
}

/**
 * The owner's settings.
 * `{"available":bool,"visitPings":"all"|"returning"|"off","greeting":"…"}`
 */
struct OwnerSettings: Sendable, Equatable, Decodable {
    var available: Bool
    var visitPings: VisitPings
    var greeting: String

    /** The keys read from the server. */
    enum CodingKeys: String, CodingKey { case available, visitPings, greeting }

    /** Creates settings from their parts. */
    init(available: Bool, visitPings: VisitPings, greeting: String) {
        self.available = available; self.visitPings = visitPings; self.greeting = greeting
    }

    /**
     * Decodes settings leniently: not available, all visit pings and an empty greeting are the defaults.
     *
     * - Parameter decoder: The decoder to read from.
     * - Throws: When the value is not a keyed container.
     */
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = c.bool(.available) ?? false
        visitPings = VisitPings(rawValue: c.str(.visitPings) ?? "") ?? .all
        greeting = c.str(.greeting) ?? ""
    }
}

/** Body for `PUT /owner/settings` ("any of the fields"): nil fields are left out. */
struct SettingsPatch: Sendable, Encodable {
    var available: Bool?
    var visitPings: String?
    var greeting: String?
}

/**
 * What the server remembers about a visitor.
 * `GET /owner/visitor/{vid}` → `profile`.
 */
struct VisitorProfile: Sendable, Decodable {
    var first: Double?
    var last: Double?
    var visits: Int?
    var views: Int?
    var secs: Double?
    var ips: [String]
    var places: [String]
    var devs: [String]
    var refs: [String]
    var pages: [String]
    var name: String?
    var email: String?
    var ipmatch: [String]

    /** The keys read from the server. */
    enum CodingKeys: String, CodingKey {
        case first, last, visits, views, secs, ips, places, devs, refs, pages, name, email, ipmatch
    }

    /** Creates a profile from its parts. */
    init(first: Double?, last: Double?, visits: Int?, views: Int?, secs: Double?, ips: [String], places: [String],
         devs: [String], refs: [String], pages: [String], name: String?, email: String?, ipmatch: [String]) {
        self.first = first; self.last = last; self.visits = visits; self.views = views; self.secs = secs
        self.ips = ips; self.places = places; self.devs = devs; self.refs = refs; self.pages = pages
        self.name = name; self.email = email; self.ipmatch = ipmatch
    }

    /**
     * Decodes a profile leniently; missing lists become empty.
     *
     * - Parameter decoder: The decoder to read from.
     * - Throws: When the value is not a keyed container.
     */
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        first = c.num(.first); last = c.num(.last); visits = c.int(.visits); views = c.int(.views); secs = c.num(.secs)
        ips = c.strings(.ips); places = c.strings(.places); devs = c.strings(.devs); refs = c.strings(.refs)
        pages = c.strings(.pages); name = c.str(.name)?.nonEmpty; email = c.str(.email)?.nonEmpty
        ipmatch = c.strings(.ipmatch)
    }
}

/**
 * `{"profile":Profile|null,"visits":[…]}`. The visit summaries have no fixed shape in the
 * contract, so they're kept as loose JSON and shown key by key.
 */
struct VisitorDetails: Sendable, Decodable {
    var profile: VisitorProfile?
    var visits: [JSONValue]

    /** The keys read from the server. */
    enum CodingKeys: String, CodingKey { case profile, visits }

    /** Creates details from their parts. */
    init(profile: VisitorProfile?, visits: [JSONValue]) { self.profile = profile; self.visits = visits }

    /**
     * Decodes the details; an unreadable profile becomes nil and unreadable visits an empty list.
     *
     * - Parameter decoder: The decoder to read from.
     * - Throws: When the value is not a keyed container.
     */
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        profile = try? c.decodeIfPresent(VisitorProfile.self, forKey: .profile)
        visits = (try? c.decodeIfPresent([JSONValue].self, forKey: .visits)) ?? []
    }
}

/** Any JSON value, for data whose shape is not fixed. */
enum JSONValue: Sendable, Hashable, Decodable {
    case string(String), number(Double), bool(Bool), null
    case array([JSONValue]), object([String: JSONValue])

    /**
     * Decodes whatever JSON value is there, trying null, boolean, number, string, array and object in that order.
     *
     * - Parameter decoder: The decoder to read from.
     * - Throws: When the value is none of these.
     */
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let d = try? c.decode(Double.self) { self = .number(d) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    /**
     * Looks up a key when this value is an object.
     *
     * - Parameter key: The key.
     * - Returns: The value under that key, or nil when missing or when this is not an object.
     */
    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    /**
     * The value as display text: nil for null, objects and empty strings; "yes"/"no" for booleans;
     * array items joined with commas.
     */
    var text: String? {
        switch self {
        case .string(let s): s.isEmpty ? nil : s
        case .number(let d): d.rounded() == d ? String(Int64(d)) : String(format: "%.1f", d)
        case .bool(let b): b ? "yes" : "no"
        case .null: nil
        case .array(let a): a.compactMap(\.text).joined(separator: ", ")
        case .object: nil
        }
    }

    /** The value as a number when it is a number or a numeric string. */
    var number: Double? {
        switch self {
        case .number(let d): d
        case .string(let s): Double(s)
        default: nil
        }
    }
}

/** A server → owner WebSocket frame (all kinds in one struct; `type` says which fields are set). */
struct ServerFrame: Sendable, Decodable {
    var type: String
    var vid: String?
    var message: Message?
    var conversation: Conversation?
    var event: String?
    var page: String?
    var at: Double?
    var error: String?
    var visitor: VisitorBrief? = nil
    var text: String? = nil            // typing: the visitor's draft so far ("" when they cleared it)

    /** The keys read from the server. */
    enum CodingKeys: String, CodingKey { case type, vid, message, conversation, event, page, at, error, visitor, text }

    /** Creates a frame from its parts (used by the demo backend). */
    init(type: String, vid: String? = nil, message: Message? = nil, conversation: Conversation? = nil,
         event: String? = nil, page: String? = nil, at: Double? = nil, error: String? = nil) {
        self.type = type; self.vid = vid; self.message = message; self.conversation = conversation
        self.event = event; self.page = page; self.at = at; self.error = error
    }

    /**
     * Decodes a frame leniently; parts that are missing or unreadable become nil.
     *
     * - Parameter decoder: The decoder to read from.
     * - Throws: When the value is not a keyed container.
     */
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = c.str(.type) ?? ""
        vid = c.str(.vid)
        message = try? c.decodeIfPresent(Message.self, forKey: .message)
        conversation = try? c.decodeIfPresent(Conversation.self, forKey: .conversation)
        event = c.str(.event)
        page = c.str(.page)
        at = c.num(.at)
        error = c.str(.error)
        visitor = try? c.decodeIfPresent(VisitorBrief.self, forKey: .visitor)
        text = try? c.decodeIfPresent(String.self, forKey: .text)
    }
}

/** State of the real-time connection; `waiting` carries the seconds until the next attempt. */
enum ConnectionState: Sendable, Equatable {
    case off, connecting, connected, waiting(seconds: Int)
}

/**
 * Someone with the site open right now (a live chat socket), from `GET /owner/online` and the
 * owner socket's `visitor` online/offline events. Messaging them pops the chat open in their browser.
 */
struct OnlineVisitor: Identifiable, Hashable, Sendable, Decodable {
    var vid: String
    var page: String
    /** Time of the latest event, in milliseconds since 1970 (`since`, the arrival time, uses the same unit). */
    var at: Double
    var since: Double
    var place: String?
    var device: String?
    var visits: Int
    var conversation: Conversation?
    /** The visitor id doubles as the list identity. */
    var id: String { vid }

    /** The keys read from the server. */
    enum CodingKeys: String, CodingKey { case vid, page, at, since, place, device, visits, conversation }

    /** Creates an online visitor from its parts; `since` defaults to `at`. */
    init(vid: String, page: String, at: Double, since: Double? = nil, place: String? = nil, device: String? = nil,
         visits: Int = 1, conversation: Conversation? = nil) {
        self.vid = vid; self.page = page; self.at = at; self.since = since ?? at
        self.place = place; self.device = device; self.visits = visits; self.conversation = conversation
    }

    /**
     * Decodes an online visitor leniently; the visit count is at least 1.
     *
     * - Parameter decoder: The decoder to read from.
     * - Throws: When the value is not a keyed container.
     */
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        vid = c.str(.vid) ?? ""
        page = c.str(.page) ?? "/"
        at = c.num(.at) ?? Fmt.nowMs
        since = c.num(.since) ?? at
        place = c.str(.place)?.nonEmpty
        device = c.str(.device)?.nonEmpty
        visits = max(1, c.int(.visits) ?? 1)
        conversation = try? c.decodeIfPresent(Conversation.self, forKey: .conversation)
    }

    /** The visitor's conversation, or a new online one built from place, device and visits. */
    var asConversation: Conversation {
        conversation ?? Conversation(vid: vid, online: true, place: place, device: device, visits: visits)
    }
}

/** Profile bits sent with a `visitor` online event for someone who hasn't chatted yet. */
struct VisitorBrief: Sendable, Decodable {
    var place: String?
    var device: String?
    var visits: Int?
}
