/**
 * @file ThreadView.swift
 * One conversation: the message bubbles, the visitor's live typing, read receipts and the composer
 * for the owner's replies.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

import SwiftUI

/**
 * The conversation screen for one visitor. Opening it loads the thread and marks it read; leaving
 * it tells AppModel the thread is closed.
 */
struct ThreadView: View {
    /** Visitor id of the conversation. */
    let vid: String
    @Environment(AppModel.self) private var model
    /** The reply being written. */
    @State private var draft = ""
    /** The "Also email them" choice, once the owner has touched the checkbox. */
    @State private var alsoEmail = false
    /** True once the owner has touched the checkbox; until then it follows whether the visitor is offline. */
    @State private var alsoEmailTouched = false
    /** True while the visitor profile sheet is showing. */
    @State private var showProfile = false
    /** True while the message field has the keyboard. */
    @FocusState private var composerFocused: Bool

    /** The conversation this thread belongs to. */
    private var conversation: Conversation { model.conversation(vid) }
    /** The thread's loaded messages. */
    private var list: [Message] { model.messages[vid] ?? [] }

    /**
     * The scrolling message list with time headers and the read receipt, the composer below it, and
     * the toolbar with the title and the profile and block menu.
     */
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if list.isEmpty {
                        emptyState
                    }
                    ForEach(Array(list.enumerated()), id: \.element.id) { index, message in
                        let previous = index > 0 ? list[index - 1] : nil
                        if previous == nil || message.at - previous!.at > 15 * 60_000 {
                            Text(Fmt.threadHeader(ms: message.at))
                                .font(Font.wm(.caption2).weight(.medium))
                                .foregroundStyle(.secondary)
                                .padding(.top, 14)
                                .padding(.bottom, 6)
                        }
                        MessageBubble(message: message,
                                      tight: previous?.from == message.from && message.at - (previous?.at ?? 0) < 60_000,
                                      showPage: message.from == .visitor && message.page != nil &&
                                          message.page != list[..<index].last(where: { $0.from == .visitor })?.page) {
                            Task { await model.retry(message) }
                        }
                        .id(message.id)
                        if message.id == readReceiptId {
                            Text("Read")
                                .font(Font.wm(.caption2))
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                                .padding(.trailing, 6)
                                .padding(.top, 2)
                        }
                    }
                    if let draft = model.drafting[vid], !draft.isEmpty {
                        DraftBubble(text: draft)
                            .id("typing")
                            .transition(.opacity)
                    } else if model.isTyping(vid) {
                        TypingBubble()
                            .id("typing")
                            .transition(.opacity.combined(with: .scale(scale: 0.8, anchor: .bottomLeading)))
                    }
                    Color.clear.frame(height: 4).id("bottom")
                }
                .padding(.horizontal, 12)
                .animation(.default, value: model.isTyping(vid))
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: list.count) { scrollToBottom(proxy) }
            .onChange(of: model.isTyping(vid)) { scrollToBottom(proxy) }
            .onChange(of: model.drafting[vid]) { scrollToBottom(proxy) }
            .onChange(of: composerFocused) { if composerFocused { scrollToBottom(proxy, delay: 0.3) } }
            .safeAreaInset(edge: .bottom) { composer }
        }
        .background(Theme.paper.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button { showProfile = true } label: { titleView }
                    .buttonStyle(.plain)
                    .accessibilityHint("Shows the visitor profile")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { showProfile = true } label: { Label("Visitor profile", systemImage: "person.text.rectangle") }
                    Button(role: conversation.blocked ? nil : .destructive) {
                        Task { await model.setBlocked(vid: vid, !conversation.blocked) }
                    } label: {
                        Label(conversation.blocked ? "Unblock" : "Block", systemImage: "hand.raised")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("More")
            }
        }
        .sheet(isPresented: $showProfile) {
            VisitorProfileView(vid: vid)
        }
        .task(id: vid) {
            if let prefill = model.drafts.removeValue(forKey: vid), draft.isEmpty { draft = prefill; composerFocused = true }
            await model.openThread(vid)
        }
        .onDisappear { model.closeThread(vid) }
    }

    /**
     * The newest owner message the visitor has read.
     * Nil unless that message is also the last one in the thread.
     */
    private var readReceiptId: String? {
        guard let at = model.visitorReadAt[vid] else { return nil }
        guard let lastOwner = list.last(where: { $0.from == .owner && !$0.isPending && !$0.isFailed }),
              lastOwner.at <= at, list.last?.from == .owner else { return nil }
        return lastOwner.id
    }

    /** The navigation title: online dot, name and a subtitle line. */
    private var titleView: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                if conversation.online {
                    Circle().fill(Theme.online).frame(width: 7, height: 7)
                }
                Text(conversation.displayName)
                    .font(Font.wm(.headline))
                    .lineLimit(1)
            }
            Text(subtitle)
                .font(Font.wm(.caption2))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    /** "typing…", "Blocked", or online state, city and visit label. */
    private var subtitle: String {
        if model.isTyping(vid) { return String(localized: "typing…") }
        if conversation.blocked { return String(localized: "Blocked") }
        return Fmt.joined([conversation.online ? String(localized: "Online") : nil,
                           conversation.place?.split(separator: ",").first.map(String.init),
                           Fmt.visitLabel(conversation.visits)])
    }

    /** Shown while the thread has no messages: an invitation to say hi. */
    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "hand.wave")
                .font(Font.wm(.largeTitle))
                .foregroundStyle(.tint)
            Text("Say hi")
                .font(Font.wm(.headline))
            Text("This visitor hasn't chatted yet. Your message pops up in the site's chat bubble.")
                .font(Font.wm(.subheadline))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
    }

    /** The message field, the send button and, when the visitor left an address, the "Also email them" checkbox. */
    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
        if conversation.canEmail, let address = conversation.email {
            Toggle(isOn: Binding(get: { alsoEmailTouched ? alsoEmail : !conversation.online },
                                 set: { alsoEmail = $0; alsoEmailTouched = true })) {
                Text("Also email them at \(address)").font(.wm(.footnote)).foregroundStyle(Theme.quiet).lineLimit(1).truncationMode(.middle)
            }
            .toggleStyle(.checkbox)
            .padding(.horizontal, 4)
        }
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($composerFocused)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Theme.plate, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.quiet.opacity(0.35), lineWidth: 0.5))
                .onChange(of: draft) { _, new in if !new.isEmpty { model.ownerTyping(vid: vid) } }
            Button {
                let text = draft
                draft = ""
                let email = conversation.canEmail && (alsoEmailTouched ? alsoEmail : !conversation.online)
                Task { await model.send(vid: vid, text: text, email: email) }
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(.title))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(Theme.onAccent, canSend ? Theme.accent : Theme.quiet.opacity(0.5))
            }
            .disabled(!canSend)
            .accessibilityLabel("Send")
        }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    /** True when the draft has something other than whitespace. */
    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /**
     * Scrolls to the end of the thread with a short animation.
     *
     * - Parameter proxy: The scroll view's proxy.
     * - Parameter delay: Seconds to wait first, to let the keyboard finish appearing.
     */
    private func scrollToBottom(_ proxy: ScrollViewProxy, delay: Double = 0) {
        Task {
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }
}

/**
 * One message: the owner's on the right in the accent color, the visitor's on the left. Pending
 * messages are faded, failed ones get a retry button, and a long press offers Copy.
 */
struct MessageBubble: View {
    /** The message shown. */
    let message: Message
    /** True to sit close under the previous bubble (same sender within a minute). */
    var tight = false
    /** True to show the page the visitor wrote from above the bubble. */
    var showPage = false
    /** Called when the retry button of a failed message is tapped. */
    var onRetry: () -> Void = {}

    /** True for the owner's own messages. */
    private var mine: Bool { message.from == .owner }

    /** The bubble with its optional page label and retry button. */
    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
            if showPage, let page = message.page {
                Label(page, systemImage: "doc.text")
                    .font(Font.wm(.caption2))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.top, 4)
            }
            HStack(alignment: .bottom, spacing: 6) {
                if mine { Spacer(minLength: 56) }
                if message.isFailed {
                    Button(action: onRetry) {
                        Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.danger)
                    }
                    .accessibilityLabel("Not delivered. Retry")
                }
                Text(message.text)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 8)
                    .foregroundStyle(mine ? Theme.onAccent : Theme.ink)
                    .background(mine ? Theme.accent : Theme.bubble,
                                in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .opacity(message.isPending ? 0.65 : 1)
                    .textSelection(.enabled)
                    .contextMenu {
                        Button { UIPasteboard.general.string = message.text } label: { Label("Copy", systemImage: "doc.on.doc") }
                    } preview: {
                        Text(message.date.formatted(date: .abbreviated, time: .shortened)).padding()
                    }
                if !mine { Spacer(minLength: 56) }
            }
        }
        .padding(.top, tight ? 2 : 8)
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(mine ? "You: " : "Visitor: ") + Text(message.text))
    }
}

/** Three pulsing dots, shown while the visitor is typing and no draft text is known. */
struct TypingBubble: View {
    /** The animated dots in a visitor-coloured bubble. */
    var body: some View {
        HStack {
            TimelineView(.animation(minimumInterval: 0.15)) { context in
                let phase = Int(context.date.timeIntervalSinceReferenceDate * 3) % 3
                HStack(spacing: 4) {
                    ForEach(0..<3, id: \.self) { i in
                        Circle()
                            .fill(Theme.quiet)
                            .frame(width: 7, height: 7)
                            .opacity(i == phase ? 1 : 0.35)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(Theme.bubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            Spacer()
        }
        .padding(.top, 8)
        .accessibilityLabel("Visitor is typing")
    }
}

/** What the visitor is typing right now, before they send it: faded and dashed, so it never reads as a sent message. */
struct DraftBubble: View {
    /** The visitor's draft so far. */
    let text: String

    /** The dashed bubble with a "typing…" caption. */
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text("typing…").font(Font.wm(.caption2)).foregroundStyle(Theme.quiet)
                Text(text)
                    .font(Font.wm(.body))
                    .foregroundStyle(Theme.ink.opacity(0.75))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Theme.bubble.opacity(0.55), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(Theme.quiet.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
            }
            Spacer(minLength: 40)
        }
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Visitor is typing: \(text)")
    }
}
