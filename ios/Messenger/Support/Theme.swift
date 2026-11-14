/**
 * @file Theme.swift
 * The app's look, in one place: every colour, the font, the bar appearance, and the themed list
 * section and checkbox that the views share.
 *
 * TO CHANGE THE LOOK, EDIT ONLY THIS FILE. The colours are the `static let` lines at the top of
 * `Theme` (each takes a light-mode and a dark-mode 0xRRGGBB value), and the font is `Theme.fontDesign`.
 * No other Swift file contains a colour value; the views only say `Theme.accent`, `Theme.ink` and so on.
 * The asset `Assets.xcassets/AccentColor` holds the same two accent values for the few places where iOS
 * reads the accent itself (for example the app's entry in the Settings app); keep it in step with
 * `Theme.accent`. The values match the widget's defaults in aws/chat/src/public/chat.css.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

import SwiftUI
import UIKit

/** The default theme: plain light and dark surfaces, one blue accent, the system font. */
enum Theme {
    // MARK: Colours (light, dark). Change these values to restyle the whole app.

    /** Page background. */
    static let paper = dynamic(light: 0xF3F4F6, dark: 0x14161A)
    /** Cards and list rows. */
    static let plate = dynamic(light: 0xFFFFFF, dark: 0x1C1F24)
    /** The visitor's message bubbles. */
    static let bubble = dynamic(light: 0xFFFFFF, dark: 0x262A31)
    /** Text. */
    static let ink = dynamic(light: 0x1F2328, dark: 0xE6E8EB)
    /** Secondary text. */
    static let quiet = dynamic(light: 0x5B6470, dark: 0x9AA3AF)
    /** The accent: the owner's own bubbles, buttons, switches, unread counts, avatars. */
    static let accent = dynamic(light: 0x2563EB, dark: 0x60A5FA)
    /** Text and icons on top of the accent. */
    static let onAccent = dynamic(light: 0xFFFFFF, dark: 0x0B1220)
    /** The "online" dot and the "available" indicator. */
    static let online = dynamic(light: 0x1A9F53, dark: 0x34C26E)
    /** Notices that need attention but are not errors (the Demo badge, "your session ended"). */
    static let warning = dynamic(light: 0xB45309, dark: 0xF59E0B)
    /** Errors, failed messages, the Block action and the tab bar's unread badge. */
    static let danger = dynamic(light: 0xD92D20, dark: 0xF04438)

    // MARK: Font

    /**
     * The design of the app's font: `.default` (the system face), `.rounded`, `.serif` or `.monospaced`.
     * Every text style goes through `Font.app(_:)` and `Theme.uiFont(size:weight:)`, which read this value.
     */
    static let fontDesign: Font.Design = .default

    /**
     * Makes a color that follows light and dark mode.
     *
     * - Parameter light: RGB hex value for light mode.
     * - Parameter dark: RGB hex value for dark mode.
     * - Returns: The adaptive color.
     */
    static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }

    /**
     * Makes a UIKit font in the theme's design, for the navigation and tab bars (UIKit appearance
     * objects can't take a SwiftUI `Font`).
     *
     * - Parameter size: Point size.
     * - Parameter weight: Font weight.
     * - Returns: The font; the plain system font when the design isn't available.
     */
    static func uiFont(size: CGFloat, weight: UIFont.Weight) -> UIFont {
        let base = UIFont.systemFont(ofSize: size, weight: weight)
        let design: UIFontDescriptor.SystemDesign = switch fontDesign {
        case .rounded: .rounded
        case .serif: .serif
        case .monospaced: .monospaced
        default: .default
        }
        guard let descriptor = base.fontDescriptor.withDesign(design) else { return base }
        return UIFont(descriptor: descriptor, size: size)
    }

    /**
     * Styles the UIKit parts SwiftUI can't reach: navigation and tab bars in the page colour with
     * themed titles, the tab bar's unread badge, and the tint of segmented controls and switches.
     */
    @MainActor static func applyAppearance() {
        let bg = UIColor(paper), ink = UIColor(Theme.ink)
        let title = uiFont(size: 17, weight: .semibold)
        let large = uiFont(size: 34, weight: .bold)
        let nav = UINavigationBarAppearance()
        nav.configureWithOpaqueBackground()
        nav.backgroundColor = bg
        nav.shadowColor = UIColor(Theme.quiet).withAlphaComponent(0.25)
        nav.titleTextAttributes = [.font: title, .foregroundColor: ink]
        nav.largeTitleTextAttributes = [.font: large, .foregroundColor: ink]
        UINavigationBar.appearance().standardAppearance = nav
        UINavigationBar.appearance().scrollEdgeAppearance = nav
        UINavigationBar.appearance().compactAppearance = nav

        let tab = UITabBarAppearance()
        tab.configureWithOpaqueBackground()
        tab.backgroundColor = bg
        let item = uiFont(size: 11, weight: .regular)
        for layout in [tab.stackedLayoutAppearance, tab.inlineLayoutAppearance, tab.compactInlineLayoutAppearance] {
            layout.normal.titleTextAttributes = [.font: item, .foregroundColor: UIColor(Theme.quiet)]
            layout.normal.iconColor = UIColor(Theme.quiet)
            layout.selected.titleTextAttributes = [.font: item, .foregroundColor: ink]
            layout.selected.iconColor = ink
            layout.normal.badgeBackgroundColor = UIColor(Theme.danger)
        }
        UITabBar.appearance().standardAppearance = tab
        UITabBar.appearance().scrollEdgeAppearance = tab
        UISegmentedControl.appearance().selectedSegmentTintColor = UIColor(accent)
        UISegmentedControl.appearance().setTitleTextAttributes([.foregroundColor: UIColor(onAccent)], for: .selected)
        UISwitch.appearance().onTintColor = UIColor(Theme.accent)
    }
}

/** The app's font. */
extension Font {
    /**
     * The theme's face (`Theme.fontDesign`) at a Dynamic Type style, so text still scales with the
     * user's size setting.
     *
     * - Parameter style: The text style.
     * - Returns: The font.
     */
    static func app(_ style: Font.TextStyle) -> Font { .system(style, design: Theme.fontDesign) }
}

/** Hex color support. */
extension Color {
    /**
     * Creates an opaque sRGB color from a 0xRRGGBB value.
     *
     * - Parameter hex: The color value.
     */
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

/** Hex color support. */
extension UIColor {
    /**
     * Creates an opaque color from a 0xRRGGBB value.
     *
     * - Parameter hex: The color value.
     */
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/** Lists and forms on the theme's page colour instead of the system's. */
struct AppScreen: ViewModifier {
    /**
     * Hides the system list background and applies the paper background and ink text color.
     *
     * - Parameter content: The view to style.
     * - Returns: The styled view.
     */
    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            .background(Theme.paper.ignoresSafeArea())
            .foregroundStyle(Theme.ink)
    }
}

/** Shorthand for the screen styling. */
extension View {
    /**
     * Applies `AppScreen`.
     *
     * - Returns: The styled view.
     */
    func appScreen() -> some View { modifier(AppScreen()) }
}

/** A list section whose rows sit on the theme's plate color (SwiftUI only lets rows set their own background). */
struct AppSection<Header: View, Content: View, Footer: View>: View {
    private let content: Content, header: Header, footer: Footer

    /**
     * Creates a section with a header and a footer.
     *
     * - Parameter content: The rows.
     * - Parameter header: The header view.
     * - Parameter footer: The footer view.
     */
    init(@ViewBuilder content: () -> Content, @ViewBuilder header: () -> Header, @ViewBuilder footer: () -> Footer) {
        self.content = content(); self.header = header(); self.footer = footer()
    }

    /** The section, with themed rows and footnote-sized header and footer. */
    var body: some View {
        Section {
            Group { content }.listRowBackground(Theme.plate)
        } header: {
            header.font(.app(.footnote)).foregroundStyle(Theme.quiet)
        } footer: {
            footer.font(.app(.footnote)).foregroundStyle(Theme.quiet)
        }
    }
}

/** A section without header and footer. */
extension AppSection where Header == EmptyView, Footer == EmptyView {
    /**
     * Creates a section from rows only.
     *
     * - Parameter content: The rows.
     */
    init(@ViewBuilder content: () -> Content) { self.init(content: content, header: { EmptyView() }, footer: { EmptyView() }) }
}
/** A section with a footer only. */
extension AppSection where Header == EmptyView {
    /**
     * Creates a section with rows and a footer.
     *
     * - Parameter content: The rows.
     * - Parameter footer: The footer view.
     */
    init(@ViewBuilder content: () -> Content, @ViewBuilder footer: () -> Footer) { self.init(content: content, header: { EmptyView() }, footer: footer) }
}
/** A section with a header only. */
extension AppSection where Footer == EmptyView {
    /**
     * Creates a section with rows and a header.
     *
     * - Parameter content: The rows.
     * - Parameter header: The header view.
     */
    init(@ViewBuilder content: () -> Content, @ViewBuilder header: () -> Header) { self.init(content: content, header: header, footer: { EmptyView() }) }
}
/** A section with a plain text title. */
extension AppSection where Header == Text, Footer == EmptyView {
    /**
     * Creates a section titled with a string.
     *
     * - Parameter title: The header text.
     * - Parameter content: The rows.
     */
    init<S: StringProtocol>(_ title: S, @ViewBuilder content: () -> Content) {
        self.init(content: content, header: { Text(title) }, footer: { EmptyView() })
    }
}
/** A section with a localized text title. */
extension AppSection where Header == Text, Footer == EmptyView {
    /**
     * Creates a section titled with a localized string key.
     *
     * - Parameter title: The header text.
     * - Parameter content: The rows.
     */
    init(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) {
        self.init(content: content, header: { Text(title) }, footer: { EmptyView() })
    }
}

/** A square checkbox (iOS has only switches built in). */
struct CheckboxToggleStyle: ToggleStyle {
    /**
     * Draws the checkbox and its label as a button that flips the toggle.
     *
     * - Parameter configuration: The toggle's state and label.
     * - Returns: The checkbox view.
     */
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack(spacing: 8) {
                Image(systemName: configuration.isOn ? "checkmark.square.fill" : "square")
                    .foregroundStyle(configuration.isOn ? Theme.accent : Theme.quiet)
                    .imageScale(.large)
                configuration.label
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(configuration.isOn ? .isSelected : [])
    }
}
/** Lets a toggle be styled with `.toggleStyle(.checkbox)`. */
extension ToggleStyle where Self == CheckboxToggleStyle { static var checkbox: CheckboxToggleStyle { .init() } }
