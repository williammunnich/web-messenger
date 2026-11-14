/**
 * @file SetupView.swift
 * The first screen of the app: where the owner enters the inbox address and signs in with Google,
 * or turns on Demo mode.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

import AuthenticationServices
import SwiftUI

/** First run (and after sign-out / a 401): inbox host, Google sign-in, or Demo mode. */
struct SetupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.webAuthenticationSession) private var webAuth
    /** What the owner has typed as the inbox address. */
    @State private var hostText = AppConfig.dashHost ?? ""
    /** True while the sign-in sheet is open. */
    @State private var signingIn = false
    /** The sign-in error to show, if any. */
    @State private var error: String?

    /** The typed address as a clean host, or nil when it isn't a usable address. */
    private var host: String? { AppConfig.normalizeHost(hostText) }

    /** The form: title, sign-in notice, address field, sign-in button and the Demo mode toggle. */
    var body: some View {
        NavigationStack {
            Form {
                WMSection {
                    VStack(spacing: 12) {
                        Image(systemName: "bubble.left.and.text.bubble.right.fill")
                            .font(.system(.largeTitle))
                            .foregroundStyle(.tint)
                        Text("Messenger")
                            .font(Font.wm(.title).bold())
                        Text("Live chat for your website.")
                            .font(Font.wm(.subheadline))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .listRowBackground(Color.clear)
                }

                if let notice = model.signInNotice {
                    WMSection {
                        Label(notice, systemImage: "exclamationmark.circle.fill")
                            .foregroundStyle(Theme.warning)
                    }
                }

                WMSection {
                    TextField("abc123.execute-api.us-east-1.amazonaws.com", text: $hostText)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(Font.wm(.body).monospaced())
                } header: {
                    Text("Inbox address")
                } footer: {
                    if !hostText.isEmpty && host == nil {
                        Text("That doesn't look like an address. Use the InboxUrl from the deploy, or localhost:8790 for the local bench.")
                            .foregroundStyle(Theme.danger)
                    } else {
                        Text("The InboxUrl printed by the deploy.")
                    }
                }

                WMSection {
                    Button {
                        Task { await signIn() }
                    } label: {
                        HStack {
                            Spacer()
                            if signingIn { ProgressView().padding(.trailing, 6) }
                            Label("Sign in with Google", systemImage: "person.badge.key.fill")
                                .font(Font.wm(.headline))
                            Spacer()
                        }
                    }
                    .disabled(host == nil || signingIn)
                } footer: {
                    if let error { Text(error).foregroundStyle(Theme.danger) }
                }

                WMSection {
                    Toggle("Demo mode", isOn: Binding(get: { model.demoMode }, set: { model.setDemoMode($0) }))
                } footer: {
                    Text("Try the app with made-up chats and visitors. Nothing is sent to the server.")
                }
            }
            .navigationTitle("Welcome")
            .wmScreen()
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    /**
     * Opens the server's `app/login` page in a web sign-in sheet with a random `state`, checks that the
     * callback carries the same state and a token, and completes the sign-in. Closing the sheet is not
     * an error; other failures are shown under the button.
     */
    private func signIn() async {
        guard let host, let base = AppConfig.dashURL(host: host) else { return }
        model.saveHost(host)
        error = nil
        signingIn = true
        defer { signingIn = false }
        let state = Fmt.randomState()
        var comps = URLComponents(url: base.appending(path: "app/login"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "state", value: state)]
        do {
            let callback = try await webAuth.authenticate(using: comps.url!,
                                                          callback: .customScheme(AppConfig.callbackScheme),
                                                          preferredBrowserSession: .shared,
                                                          additionalHeaderFields: [:])
            let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let value = { (name: String) in items.first { $0.name == name }?.value }
            guard callback.host() == "auth" else { error = String(localized: "Unexpected sign-in reply."); return }
            guard value("state") == state else { error = String(localized: "Sign-in state didn't match. Try again."); return }
            guard let token = value("token"), !token.isEmpty else {
                error = String(localized: "Sign-in didn't return a session.")
                return
            }
            model.completeSignIn(host: host, token: token)
        } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
            // user closed the sheet
        } catch {
            self.error = error.localizedDescription
        }
    }
}
