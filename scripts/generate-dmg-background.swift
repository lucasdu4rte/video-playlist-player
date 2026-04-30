#!/usr/bin/env swift
import AppKit

func render(scale: CGFloat) -> Data {
    let pixelW = Int(600 * scale)
    let pixelH = Int(400 * scale)
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixelW,
        pixelsHigh: pixelH,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!
    let size = CGSize(width: CGFloat(pixelW), height: CGFloat(pixelH))
    NSGraphicsContext.saveGraphicsState()
    let nsCtx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = nsCtx
    let ctx = nsCtx.cgContext

    let colors = [
        NSColor(calibratedRed: 0.97, green: 0.97, blue: 0.98, alpha: 1).cgColor,
        NSColor(calibratedRed: 0.92, green: 0.92, blue: 0.94, alpha: 1).cgColor,
    ]
    let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                              colors: colors as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(gradient,
        start: CGPoint(x: 0, y: size.height),
        end: CGPoint(x: 0, y: 0),
        options: [])

    let arrowY = 200 * scale
    let arrowStart = CGPoint(x: 240 * scale, y: arrowY)
    let arrowEnd = CGPoint(x: 360 * scale, y: arrowY)
    let arrowHead: CGFloat = 12 * scale
    ctx.setStrokeColor(NSColor(calibratedWhite: 0.45, alpha: 1).cgColor)
    ctx.setFillColor(NSColor(calibratedWhite: 0.45, alpha: 1).cgColor)
    ctx.setLineWidth(3 * scale)
    ctx.setLineCap(.round)
    ctx.move(to: arrowStart)
    ctx.addLine(to: CGPoint(x: arrowEnd.x - arrowHead, y: arrowEnd.y))
    ctx.strokePath()
    ctx.move(to: arrowEnd)
    ctx.addLine(to: CGPoint(x: arrowEnd.x - arrowHead, y: arrowEnd.y + arrowHead * 0.7))
    ctx.addLine(to: CGPoint(x: arrowEnd.x - arrowHead, y: arrowEnd.y - arrowHead * 0.7))
    ctx.closePath()
    ctx.fillPath()

    let textY = (400 - 285) * scale
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 16 * scale, weight: .medium),
        .foregroundColor: NSColor(calibratedWhite: 0.35, alpha: 1),
    ]
    let str = NSAttributedString(string: "Drag to Applications", attributes: attrs)
    let textSize = str.size()
    str.draw(at: CGPoint(x: (size.width - textSize.width) / 2, y: textY))

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let outDir = "assets/dmg"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
try render(scale: 1).write(to: URL(fileURLWithPath: "\(outDir)/background.png"))
try render(scale: 2).write(to: URL(fileURLWithPath: "\(outDir)/background@2x.png"))
print("wrote \(outDir)/background.png and background@2x.png")
