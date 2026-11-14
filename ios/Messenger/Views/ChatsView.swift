/**
 * @file ChatsView.swift
 * The Chats tab: the list of people on the site and of conversations, with the row views, the avatar
 * and the connection badge it is built from.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

import SwiftUI

/**
 * The Chats tab: visitors on the site now, then all conversations, with swipe actions to mark read
 * and to block. Opens ThreadView for the selected visitor.
 */
struct ChatsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    /** On the site and not yet chatting (people already chatting show the online dot on their row below). */
    private var browsing: [OnlineVisitor] {
        model.onSite.filter { o in !model.conversations.contains { $0.vid == o.vid && $0.lastText?.isEmpty == false } }
    }

    /**
     * The list, its empty and loading states, pull to refresh, and a 20-second refresh of who is
     * online while the app is active.
     */
    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.chatPath) {
            List {
                if let error = model.conversationsError {
                    AppSection {
                        Label(error, systemImage: "wifi.exclamationmark")
                            .font(Font.app(.footnote))
                            .foregroundStyle(.secondary)
                    }
                }
                if !browsing.isEmpty {
                    Section {
                        ForEach(browsing) { o in
                            Button { model.openChat(vid: o.vid, sayHi: true) } label: { OnSiteRow(visitor: o) }
                                .buttonStyle(.plain)
                                .listRowBackground(Theme.plate)
                        }
                    } header: {
                        Text("On the site now · tap to say hi").font(Font.app(.footnote)).foregroundStyle(Theme.quiet)
                    }
                }
                ForEach(model.conversations) { c in
                    NavigationLink(value: c.vid) {
                        ConversationRow(conversation: c, typing: model.isTyping(c.vid), draft: model.drafting[c.vid])
                    }
                    .swipeActions(edge: .leading) {
                        if c.unread > 0 {
                            Button {
                                Task { await model.markRead(vid: c.vid) }
                            } label: {
                                Label("Mark read", systemImage: "envelope.open")
                            }
                            .tint(Theme.accent)
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        Button {
                            Task { await model.setBlocked(vid: c.vid, !c.blocked) }
                        } label: {
                            Label(c.blocked ? "Unblock" : "Block", systemImage: c.blocked ? "hand.raised.slash" : "hand.raised")
                        }
                        .tint(c.blocked ? Theme.quiet : Theme.danger)
                    }
                    .listRowBackground(Theme.plate)      // the row colour comes from the theme, not from the system
                }
            }
            .listStyle(.plain)
            .overlay {
                if model.conversations.isEmpty && browsing.isEmpty {
                    if model.conversationsLoaded {
                        ContentUnavailableView("No chats yet", systemImage: "bubble.left.and.bubble.right",
                                               description: Text("When a visitor writes on the site, the conversation shows up here."))
                    } else {
                        ProgressView()
                    }
                }
            }
            .refreshable { await model.refreshConversations(); await model.refreshOnline() }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                while !Task.isCancelled {                    // the socket keeps it live; this catches anything missed
                    await model.refreshOnline()
                    try? await Task.sleep(for: .seconds(20))
                }
            }
            .navigationTitle("Chats")
            .appScreen()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { ConnectionBadge() }
            }
            .navigationDestination(for: String.self) { vid in
                ThreadView(vid: vid)
            }
        }
    }
}

/** "Demo", "Connecting…", "Offline · retry in 4 s", or nothing when connected. */
struct ConnectionBadge: View {
    @Environment(AppModel.self) private var model

    /** The badge for the current backend and connection state. */
    var body: some View {
        if model.backend?.isDemo == true {
            pill(String(localized: "Demo"), color: Theme.warning)
        } else {
            switch model.connection {
            case .connected: EmptyView()
            case .connecting: pill(String(localized: "Connecting…"), color: Theme.quiet)
            case .waiting(let s): pill(String(localized: "Offline · retry in \(s)s"), color: Theme.quiet)
            case .off: pill(String(localized: "Offline"), color: Theme.quiet)
            }
        }
    }

    /**
     * Draws a small rounded label.
     *
     * - Parameter text: The label text.
     * - Parameter color: Text color; the background is a faint tint of it.
     * - Returns: The label view.
     */
    private func pill(_ text: String, color: Color) -> some View {
        Text(text)
            .font(Font.app(.caption).weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .fixedSize()
    }
}

/**
 * A round avatar with the visitor's initials or a person icon (a raised hand when blocked), in the
 * quiet colour when blocked, and the online dot while the visitor is online.
 */
struct Avatar: View {
    /** The conversation the avatar stands for. */
    let conversation: Conversation
    /** Diameter, scaled with the user's text size. */
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 46

    /** The circle, its content and the online dot. */
    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Circle()
                .fill(conversation.blocked ? AnyShapeStyle(Theme.quiet.gradient) : AnyShapeStyle(Theme.accent.gradient))
                .frame(width: size, height: size)
                .overlay {
                    if let initials = conversation.initials {
                        Text(initials)
                            .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
                            .foregroundStyle(Theme.onAccent)
                    } else {
                        Image(systemName: conversation.blocked ? "hand.raised.fill" : "person.fill")
                            .font(.system(size: size * 0.42))
                            .foregroundStyle(Theme.onAccent.opacity(0.9))
                    }
                }
            if conversation.online {
                Circle()
                    .fill(Theme.online)
                    .frame(width: size * 0.28, height: size * 0.28)
                    .overlay(Circle().stroke(Theme.plate, lineWidth: 2.5))    // a ring in the row colour sets the dot off from the avatar
                    .accessibilityLabel("Online")
            }
        }
    }
}

/** One row of the conversation list: avatar, name, time, preview, unread count and a detail line. */
struct ConversationRow: View {
    /** The conversation shown. */
    let conversation: Conversation
    /** True while the visitor is typing. */
    let typing: Bool
    /** What the visitor has typed so far, if known. */
    var draft: String? = nil

    /** The row layout. */
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Avatar(conversation: conversation)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(conversation.displayName)
                        .font(Font.app(.headline))
                        .lineLimit(1)
                    if conversation.blocked {
                        Image(systemName: "hand.raised.fill")
                            .font(Font.app(.caption))
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("Blocked")
                    }
                    Spacer(minLength: 4)
                    Text(Fmt.listTime(ms: conversation.lastAt))
                        .font(Font.app(.subheadline))
                        .foregroundStyle(conversation.unread > 0 ? Theme.accent : Theme.quiet)
                }
                HStack(alignment: .top) {
                    preview
                        .font(Font.app(.subheadline))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    if conversation.unread > 0 {
                        Text("\(conversation.unread)")
                            .font(Font.app(.caption).bold())
                            .foregroundStyle(Theme.onAccent)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(Theme.accent, in: Capsule())
                            .accessibilityLabel("\(conversation.unread) unread")
                    }
                }
                Text(details)
                    .font(Font.app(.caption))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }

    /**
     * The preview line: the live draft, "typing…", or the last message (prefixed with "You: " when
     * the owner wrote it).
     */
    private var preview: Text {
        if let draft, !draft.isEmpty { return Text("typing: ").italic() + Text(draft).italic() }
        if typing { return Text("typing…").italic() }
        let text = conversation.lastText ?? ""
        return conversation.lastFrom == .owner ? Text("You: ") + Text(text) : Text(text)
    }

    /** City and region, device type, and "New" or the visit ordinal, joined on one line. */
    private var details: String {
        let returning = conversation.visits > 1 ? String(localized: "\(Fmt.ordinal(conversation.visits)) visit") : String(localized: "New")
        let city = conversation.place?.split(separator: ",").prefix(2).joined(separator: ",")
        let device = conversation.device?.split(separator: "·").first.map { $0.trimmingCharacters(in: .whitespaces) }
        return Fmt.joined([city, device, returning])
    }
}

/** A visitor browsing right now: where they are on the site, where they're from, a Say hi button. */
struct OnSiteRow: View {
    /** The visitor shown. */
    let visitor: OnlineVisitor

    /** The row layout. */
    var body: some View {
        HStack(spacing: 12) {
            Avatar(conversation: visitor.asConversation)
            VStack(alignment: .leading, spacing: 3) {
                Text(visitor.page)
                    .font(Font.app(.headline))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(Fmt.joined([visitor.place?.split(separator: ",").prefix(2).joined(separator: ","),
                                 visitor.device?.split(separator: "·").first.map { $0.trimmingCharacters(in: .whitespaces) },
                                 Fmt.visitLabel(visitor.visits)]))
                    .font(Font.app(.caption))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Label("Say hi", systemImage: "hand.wave")
                .font(Font.app(.subheadline).weight(.semibold))
                .foregroundStyle(Theme.onAccent)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Theme.accent, in: Capsule())
                .fixedSize()
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens a chat. Your message pops up on their screen.")
    }
}
