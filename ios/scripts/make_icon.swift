/**
 * @file make_icon.swift
 * Draws the 1024 px app icon: a plain white speech bubble on the default theme's blue.
 * It is a generic placeholder; replace it with your own artwork, or change the two colours below.
 * iOS rounds the corners itself, so the square is filled edge to edge (no transparency allowed).
 * Run from ios/:  swift scripts/make_icon.swift Messenger/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */

import AppKit
import CoreGraphics

/** Where the PNG is written: the first argument, or AppIcon-1024.png in the current folder. */
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon-1024.png"
/** Width and height of the icon in pixels. */
let size = 1024
let space = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fatalError("no context") }

/**
 * Makes an opaque sRGB colour from a 0xRRGGBB value.
 *
 * - Parameter hex: The colour value.
 * - Returns: The colour.
 */
func color(_ hex: UInt32) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

/** The background (the same blue as `Theme.accent` in light mode) and the bubble drawn on it. */
let background = color(0x2563EB)
let foreground = color(0xFFFFFF)

// Background: one flat colour, edge to edge.
ctx.setFillColor(background)
ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))

// The speech bubble: a rounded rectangle with a small tail at the bottom left. (CoreGraphics' origin is bottom left.)
ctx.setFillColor(foreground)
let body = CGRect(x: 212, y: 372, width: 600, height: 420)
ctx.addPath(CGPath(roundedRect: body, cornerWidth: 110, cornerHeight: 110, transform: nil))
ctx.fillPath()
ctx.move(to: CGPoint(x: 300, y: 400))
ctx.addLine(to: CGPoint(x: 280, y: 232))
ctx.addLine(to: CGPoint(x: 470, y: 400))
ctx.closePath()
ctx.fillPath()

// Three dots inside the bubble, in the background colour, so it reads as "chat" at small sizes.
ctx.setFillColor(background)
for x in [372, 512, 652] {
    ctx.fillEllipse(in: CGRect(x: x - 38, y: 582 - 38, width: 76, height: 76))
}

guard let image = ctx.makeImage() else { fatalError("no image") }
let rep = NSBitmapImageRep(cgImage: image)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("no png") }
try png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
