/**
 * @file Feedback.swift
 * In-app sounds and haptics. AppModel uses it to ring while a chat is waiting and to tap when a
 * visitor arrives.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */

import AVFoundation
import UIKit

/** In-app sounds (the bundled .caf files) and haptics. */
@MainActor
final class Feedback {
    /** The one shared instance. */
    static let shared = Feedback()

    /** One audio player per sound name, created on first use. */
    private var players: [String: AVAudioPlayer] = [:]
    /** Generator for the light tap. */
    private let light = UIImpactFeedbackGenerator(style: .light)
    /** True once the audio session category has been set. */
    private var sessionReady = false

    /** Plays message.caf once, for a visitor message that arrives over the WebSocket. */
    func playMessage() { play("message") }

    /**
     * While the app is open and a chat is waiting for an answer, the message sound repeats until it's answered
     * (AppModel decides; opening that chat stops it). Off in the background, where the push alert takes over.
     */
    private var ringing = false
    /**
     * Starts or stops the looping message sound; does nothing when the state doesn't change.
     *
     * - Parameter on: True to ring.
     */
    func setRinging(_ on: Bool) {
        guard on != ringing else { return }
        ringing = on
        if on { play("message", loops: -1) } else { players["message"]?.stop() }
    }

    /** A light tap, used when a visitor comes online. */
    func visitHaptic() { light.impactOccurred() }

    /**
     * Plays a bundled .caf sound from the start. The first call sets the audio session to playback mixed
     * with other audio, so it sounds even with the silent switch on.
     *
     * - Parameter name: File name without the extension.
     * - Parameter loops: Extra repeats; -1 loops until stopped.
     */
    private func play(_ name: String, loops: Int = 0) {
        if !sessionReady {
            try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])   // rings even with the silent switch on
            sessionReady = true
        }
        if players[name] == nil, let url = Bundle.main.url(forResource: name, withExtension: "caf") {
            players[name] = try? AVAudioPlayer(contentsOf: url)
            players[name]?.prepareToPlay()
        }
        guard let player = players[name] else { return }
        player.numberOfLoops = loops
        player.currentTime = 0
        player.play()
    }
}
