/**
 * @file DemoData.swift
 * The fixed sample data that DemoBackend starts from in Demo mode.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

import Foundation

/** Fixed sample data for Demo mode. Names, places and messages are invented. */
enum DemoData {
    static let annaVid = "demoAnnaQ7xk2LmP9rT4vW"
    static let berlinVid = "demoBerlinH3nC8sYe1KpZ"
    static let marcusVid = "demoMarcusR5tB0aVu6NdJ"
    static let priyaVid = "demoPriyaF9wE2jXo7GcM1"
    static let spamVid = "demoSpamL4qT6hUz3IbS8a"
    static let fanVid = "demoFanM2vR8kPc5WqYt0e"

    /** The data a fresh demo starts with. */
    struct Seed {
        var conversations: [Conversation]
        var messages: [Message]
        var sessions: [LiveSession]
    }

    /**
     * Builds the sample conversations, their messages and the sessions on the site, with times
     * relative to now.
     *
     * - Returns: The seed data.
     */
    static func make() -> Seed {
        let now = Fmt.nowMs
        let min = 60_000.0, hour = 3_600_000.0, day = 86_400_000.0
        var messages: [Message] = []
        var n = 0
        /** Appends one sample message. */
        func say(_ vid: String, _ from: Sender, _ text: String, ago: Double, page: String? = nil) {
            n += 1
            messages.append(Message(id: "m_seed\(n)", vid: vid, from: from, text: text, at: now - ago, page: page))
        }

        say(marcusVid, .visitor, "Hey, quick one: are you open on public holidays?", ago: 3 * day, page: "/about.html")
        say(marcusVid, .owner, "We are, 10 to 4.", ago: 3 * day - 20 * min)
        say(marcusVid, .visitor, "Great, see you Monday then.", ago: 3 * day - 25 * min)
        say(priyaVid, .visitor, "Hi! Could you give a short talk at our meetup next month?", ago: 2 * day, page: "/blog/")
        say(priyaVid, .owner, "Sure, happy to. Send me a couple of dates?", ago: 2 * day - hour)
        say(priyaVid, .visitor, "Will do — thanks!", ago: 2 * day - hour - 4 * min)
        say(spamVid, .visitor, "Buy cheap SEO backlinks!!! 10000 links for $5", ago: 26 * hour)
        say(annaVid, .visitor, "Hi! I just read your guide to choosing a size.", ago: 9 * min, page: "/blog/size-guide.html")
        say(annaVid, .owner, "Hi Anna! Glad it helped.", ago: 8 * min)
        say(annaVid, .visitor, "Do you ship to Canada?", ago: 3 * min, page: "/blog/size-guide.html")
        say(annaVid, .visitor, "I'd love to order two as a gift 🎁", ago: 2 * min, page: "/blog/size-guide.html")
        say(berlinVid, .visitor, "Hallo! Do you take custom orders?", ago: 40_000, page: "/products.html")

        /** The newest sample message of a visitor. */
        func last(_ vid: String) -> Message { messages.last { $0.vid == vid }! }
        /** Builds a conversation row whose last text, sender and time come from the visitor's newest message. */
        func conv(_ vid: String, name: String? = nil, email: String? = nil, unread: Int, online: Bool, place: String,
                  device: String, visits: Int, blocked: Bool = false) -> Conversation {
            let m = last(vid)
            return Conversation(vid: vid, name: name, email: email, lastText: m.text, lastFrom: m.from, lastAt: m.at,
                                unread: unread, online: online, place: place, device: device, visits: visits, blocked: blocked)
        }

        let conversations = [
            conv(annaVid, name: "Anna", email: "anna@example.com", unread: 2, online: true,
                 place: "Springfield, Illinois, US", device: "Phone · iOS · Safari", visits: 5),
            conv(berlinVid, unread: 1, online: true, place: "Berlin, Berlin, DE", device: "Desktop · macOS · Firefox", visits: 1),
            conv(marcusVid, name: "Marcus", unread: 0, online: false, place: "Portland, Oregon, US",
                 device: "Desktop · Windows · Chrome", visits: 12),
            conv(priyaVid, name: "Priya", email: "priya@example.org", unread: 0, online: false,
                 place: "Bengaluru, Karnataka, IN", device: "Phone · Android · Chrome", visits: 3),
            conv(spamVid, unread: 0, online: false, place: "Lagos, Lagos, NG", device: "Desktop · Linux · Chrome",
                 visits: 1, blocked: true),
        ]

        let t = Date.now.timeIntervalSince1970
        let sessions = [
            LiveSession(vid: annaVid, visits: 5, chat: true, lastSeen: t - 3, firstSeen: t - 640, views: 4,
                        page: "/blog/size-guide.html", ref: "https://www.google.com/", city: "Springfield", region: "Illinois",
                        country: "US", device: "Phone", os: "iOS", browser: "Safari"),
            LiveSession(vid: berlinVid, visits: 1, chat: true, lastSeen: t - 6, firstSeen: t - 95, views: 2,
                        page: "/products.html", ref: "https://www.linkedin.com/", city: "Berlin", region: "Berlin",
                        country: "DE", device: "Desktop", os: "macOS", browser: "Firefox"),
            LiveSession(vid: fanVid, visits: 23, chat: false, lastSeen: t - 12, firstSeen: t - 1520, views: 9,
                        page: "/", ref: nil, city: "Austin", region: "Texas", country: "US",
                        device: "Desktop", os: "macOS", browser: "Safari"),
            LiveSession(vid: "demoNewKj4Hs8Dw2Lq5Xa", visits: 1, chat: false, lastSeen: t - 20, firstSeen: t - 48, views: 1,
                        page: "/privacy.html", ref: "https://duckduckgo.com/", city: "Toronto", region: "Ontario",
                        country: "CA", device: "Tablet", os: "iPadOS", browser: "Safari"),
            LiveSession(vid: nil, visits: 1, chat: false, lastSeen: t - 25, firstSeen: t - 300, views: 3,
                        page: "/blog/", ref: "https://news.ycombinator.com/", city: "Amsterdam", region: "North Holland",
                        country: "NL", device: "Desktop", os: "Linux", browser: "Firefox"),
            LiveSession(vid: "demoOldPq7Rt2Vx9Zb4Nm", visits: 2, chat: false, lastSeen: t - 900, firstSeen: t - 1300, views: 5,
                        page: "/about.html", ref: nil, city: "Chicago", region: "Illinois", country: "US",
                        device: "Phone", os: "Android", browser: "Chrome", active: false),
        ]
        return Seed(conversations: conversations, messages: messages, sessions: sessions)
    }

    /**
     * Builds a made-up profile and visit list for a visitor, based on their conversation or session
     * when there is one.
     *
     * - Parameter vid: Visitor id.
     * - Parameter conversation: The visitor's conversation, if any.
     * - Parameter session: The visitor's session, if any.
     * - Returns: The profile and up to six visits.
     */
    static func details(for vid: String, conversation: Conversation?, session: LiveSession?) -> VisitorDetails {
        let t = Date.now.timeIntervalSince1970
        let visits = conversation?.visits ?? session?.visits ?? 1
        let place = conversation?.place ?? session?.place ?? "Springfield, Illinois, US"
        let dev = conversation?.device ?? session?.deviceLine ?? "Phone · iOS · Safari"
        let profile = VisitorProfile(
            first: t - Double(visits) * 4 * 86_400, last: t - 60, visits: visits, views: visits * 3 + 1,
            secs: Double(visits) * 210, ips: ["203.0.113.24", "198.51.100.7"], places: [place, "Austin, Texas, US"],
            devs: [dev], refs: ["https://www.google.com/", "https://news.ycombinator.com/"],
            pages: ["/blog/size-guide.html", "/", "/about.html", "/products.html"],
            name: conversation?.name, email: conversation?.email, ipmatch: vid == DemoData.annaVid ? ["demoAnnaLaptopX1y2Z3"] : [])
        let visitList: [JSONValue] = (0..<min(visits, 6)).map { i in
            .object(["t": .number(t - Double(i) * 4 * 86_400), "p": .string(i == 0 ? "/blog/size-guide.html" : "/"),
                     "views": .number(Double(2 + i % 3)), "secs": .number(Double(90 + i * 40)),
                     "ref": i == 0 ? .string("https://www.google.com/") : .null])
        }
        return VisitorDetails(profile: profile, visits: visitList)
    }
}
