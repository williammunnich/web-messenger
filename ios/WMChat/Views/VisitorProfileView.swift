/**
 * @file VisitorProfileView.swift
 * The visitor profile sheet opened from a conversation: what the server remembers about a visitor,
 * their recent visits, and the block toggle.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */

import SwiftUI

/** `GET /owner/visitor/{vid}` shown as a sheet, plus the block toggle. */
struct VisitorProfileView: View {
    /** Visitor id of the profile. */
    let vid: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /** The loaded details; nil while loading. */
    @State private var details: VisitorDetails?
    /** Why loading failed, if it did. */
    @State private var error: String?

    /** The visitor's conversation, for the name, avatar and blocked state. */
    private var conversation: Conversation { model.conversation(vid) }

    /**
     * The profile form: who they are, visit totals, places, devices, referrers, pages, IP addresses,
     * recent visits, the block toggle and the visitor id.
     */
    var body: some View {
        NavigationStack {
            Form {
                WMSection {
                    HStack(spacing: 14) {
                        Avatar(conversation: conversation)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(details?.profile?.name ?? conversation.displayName).font(Font.wm(.headline))
                            if let email = details?.profile?.email ?? conversation.email {
                                Link(email, destination: URL(string: "mailto:\(email)")!)
                                    .font(Font.wm(.subheadline))
                            }
                            Text(conversation.online ? "Online now" : Fmt.visitLabel(conversation.visits))
                                .font(Font.wm(.subheadline))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }

                if let error {
                    WMSection { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary) }
                } else if details == nil {
                    WMSection { HStack { Spacer(); ProgressView(); Spacer() } }
                } else if let p = details?.profile {
                    WMSection("Visits") {
                        row("Visits", p.visits.map { "\($0)" })
                        row("Page views", p.views.map { "\($0)" })
                        row("Time on site", p.secs.map { Fmt.duration(seconds: $0) })
                        row("First seen", p.first.map { Fmt.date(unix: $0).formatted(date: .abbreviated, time: .shortened) })
                        row("Last seen", p.last.map { Fmt.date(unix: $0).formatted(date: .abbreviated, time: .shortened) })
                    }
                    list("Places", p.places, icon: "mappin.and.ellipse")
                    list("Devices", p.devs, icon: "iphone")
                    list("Came from", p.refs.map { Fmt.refHost($0) ?? $0 }, icon: "arrow.turn.down.right")
                    list("Pages", p.pages, icon: "doc.text")
                    list("IP addresses", p.ips, icon: "network", mono: true)
                    if !p.ipmatch.isEmpty {
                        WMSection {
                            ForEach(p.ipmatch, id: \.self) { other in
                                Text(other).font(Font.wm(.footnote).monospaced())
                            }
                        } header: {
                            Text("Same IP, other visitor ids")
                        } footer: {
                            Text("Only a hint — seen on the same address in the last 30 days. Never merged.")
                        }
                    }
                } else {
                    WMSection {
                        Text("No visitor profile. They may have opted out of being remembered.")
                            .foregroundStyle(.secondary)
                    }
                }

                if let visits = details?.visits, !visits.isEmpty {
                    WMSection("Recent visits") {
                        ForEach(Array(visits.prefix(50).enumerated()), id: \.offset) { _, v in
                            VisitSummaryRow(visit: v)
                        }
                    }
                }

                WMSection {
                    Toggle(isOn: Binding(get: { conversation.blocked },
                                         set: { on in Task { await model.setBlocked(vid: vid, on) } })) {
                        Label("Block this visitor", systemImage: "hand.raised")
                    }
                } footer: {
                    Text("A blocked visitor's messages are kept but never notify.")
                }

                WMSection {
                    LabeledContent("Visitor id") {
                        Text(vid).font(Font.wm(.footnote).monospaced()).textSelection(.enabled)
                    }
                }
            }
            .navigationTitle("Visitor")
            .wmScreen()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task { await load() }
            .refreshable { await load() }
        }
    }

    /** Loads the visitor's details from the backend and keeps the error text if that fails. */
    private func load() async {
        guard let backend = model.backend else { return }
        do {
            details = try await backend.visitor(vid: vid)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /**
     * A labelled value row, left out when there is no value.
     *
     * - Parameter title: The label.
     * - Parameter value: The value, or nil to show nothing.
     * - Returns: The row, or nothing.
     */
    @ViewBuilder
    private func row(_ title: LocalizedStringKey, _ value: String?) -> some View {
        if let value { LabeledContent(title, value: value) }
    }

    /**
     * A titled section with one row per item, left out when the list is empty.
     *
     * - Parameter title: The section title.
     * - Parameter items: The texts to list.
     * - Parameter icon: SF Symbol name shown beside each item.
     * - Parameter mono: True to use the monospaced body font.
     * - Returns: The section, or nothing.
     */
    @ViewBuilder
    private func list(_ title: LocalizedStringKey, _ items: [String], icon: String, mono: Bool = false) -> some View {
        if !items.isEmpty {
            WMSection(title) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Label {
                        Text(item).font(mono ? .body.monospaced() : .body).textSelection(.enabled)
                    } icon: {
                        Image(systemName: icon).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

/**
 * A visit summary from the visitor profile. Its shape isn't fixed by the contract, so the row looks
 * for common keys (time, page, referrer, views, seconds) and falls back to listing what's there.
 */
struct VisitSummaryRow: View {
    /** The visit as loose JSON. */
    let visit: JSONValue

    /**
     * Finds the first of several possible keys that has a value.
     *
     * - Parameter keys: Key names to try, in order.
     * - Returns: The first value that is present and not null, or nil.
     */
    private func first(_ keys: [String]) -> JSONValue? {
        for k in keys { if let v = visit[k], v != .null { return v } }
        return nil
    }

    /**
     * Time, page, and a line with views, time on site and referrer; or all keys and values when
     * neither a time nor a page is found.
     */
    var body: some View {
        let when = first(["t", "at", "ms", "start", "first", "f", "time"])?.number.map { Fmt.date(unix: $0) }
        let page = first(["p", "page", "landing", "path"])?.text ?? first(["pages"])?.text
        let ref = first(["ref", "referrer", "r"])?.text.flatMap(Fmt.refHost)
        let views = first(["views", "v", "n"])?.number
        let secs = first(["secs", "duration", "s_on_site", "seconds"])?.number
        VStack(alignment: .leading, spacing: 2) {
            if let when {
                Text(when.formatted(date: .abbreviated, time: .shortened)).font(Font.wm(.subheadline).weight(.medium))
            }
            if let page { Text(page).font(Font.wm(.subheadline)).lineLimit(2) }
            let extra = Fmt.joined([views.map { String(localized: "\(Int($0)) views") },
                                    secs.map { Fmt.duration(seconds: $0) },
                                    ref.map { String(localized: "from \($0)") }])
            if !extra.isEmpty { Text(extra).font(Font.wm(.caption)).foregroundStyle(.secondary) }
            if when == nil && page == nil, case .object(let o) = visit {
                Text(o.sorted { $0.key < $1.key }.compactMap { k, v in v.text.map { "\(k): \($0)" } }.joined(separator: " · "))
                    .font(Font.wm(.caption).monospaced())
            }
        }
    }
}
