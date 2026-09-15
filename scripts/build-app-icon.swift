// Render the app icon from the artwork and pack the macOS icon file.
//
//   npm run icon        (= swift scripts/build-app-icon.swift; macOS with the command line tools)
//
// resources/icon-original.webp is the artwork: an opaque 1254px square with its own rounded,
// black-filled corners. macOS wants the Big Sur template instead — a 1024px canvas with the
// icon body in a centred 824px continuous-corner rounded square and transparent margins. An
// opaque square is not that shape, so macOS 26 sets it back on a grey tile. This draws the
// template → resources/icon.png (also the dev Dock icon), then packs it → build/icon.icns.
//
// Packed with iconutil, not by electron-builder at package time: its converter stores the
// 16/32/64px entries as PNG under the legacy icp4/icp5/icp6 chunk types, which IconServices
// (Finder, Dock, Spotlight) decodes as raw pixels, so those sizes render as noise. iconutil
// writes the types macOS actually reads. Both outputs are committed; rerun after changing the
// artwork (tests/app-icon.test.ts pins the icns to this layout).
import Foundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let artworkURL = root.appendingPathComponent("resources/icon-original.webp")
let pngURL = root.appendingPathComponent("resources/icon.png")
let icnsURL = root.appendingPathComponent("build/icon.icns")

let CANVAS = 1024
let BODY = 824.0 // Apple's template: the body is 824/1024 with 185.4px continuous corners
let CORNER = 185.4
// The artwork's own corners are rounded and black outside the curve. Drawing it a little
// larger than the body keeps that curve outside the template's, so the mask meets flat colour.
let OVERSCAN = 0.04

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("build-app-icon: \(message)\n".utf8))
  exit(1)
}

func loadImage(_ url: URL) -> CGImage {
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else { fail("cannot read \(url.path)") }
  return image
}

func render(_ pixels: Int, _ draw: (CGContext) -> Void) -> CGImage {
  guard
    let ctx = CGContext(
      data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { fail("cannot create a \(pixels)px context") }
  ctx.interpolationQuality = .high
  draw(ctx)
  guard let image = ctx.makeImage() else { fail("cannot render \(pixels)px") }
  return image
}

func writePNG(_ image: CGImage, to url: URL) {
  guard
    let destination = CGImageDestinationCreateWithURL(
      url as CFURL, UTType.png.identifier as CFString, 1, nil)
  else { fail("cannot create \(url.path)") }
  CGImageDestinationAddImage(destination, image, nil)
  if !CGImageDestinationFinalize(destination) { fail("cannot write \(url.path)") }
}

// 1. The template: artwork masked to the rounded body, transparent around it.
let artwork = loadImage(artworkURL)
let icon = render(CANVAS) { ctx in
  let inset = (Double(CANVAS) - BODY) / 2
  let body = CGRect(x: inset, y: inset, width: BODY, height: BODY)
  ctx.addPath(RoundedRectangle(cornerRadius: CORNER, style: .continuous).path(in: body).cgPath)
  ctx.clip()
  ctx.draw(artwork, in: body.insetBy(dx: -BODY * OVERSCAN, dy: -BODY * OVERSCAN))
}
writePNG(icon, to: pngURL)
print("wrote \(pngURL.path) (\(CANVAS)px)")

// 2. The iconset iconutil packs: every size macOS asks for, at 1x and 2x.
let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("cockpit-\(getpid()).iconset")
try? FileManager.default.removeItem(at: iconset)
do { try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true) } catch {
  fail("cannot create \(iconset.path): \(error)")
}
for points in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let pixels = points * scale
    let scaled = render(pixels) { ctx in
      ctx.draw(icon, in: CGRect(x: 0, y: 0, width: pixels, height: pixels))
    }
    let name = "icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"
    writePNG(scaled, to: iconset.appendingPathComponent(name))
  }
}

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["--convert", "icns", "--output", icnsURL.path, iconset.path]
do { try iconutil.run() } catch { fail("cannot run iconutil: \(error)") }
iconutil.waitUntilExit()
try? FileManager.default.removeItem(at: iconset)
if iconutil.terminationStatus != 0 { fail("iconutil exited with \(iconutil.terminationStatus)") }
print("wrote \(icnsURL.path)")
