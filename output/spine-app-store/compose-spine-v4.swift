import Foundation
import AppKit
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

func load(_ path: String) -> CGImage {
    let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)!
    return CGImageSourceCreateImageAtIndex(source, 0, nil)!
}
let artwork = load(CommandLine.arguments[1])
let original = load("/Users/tannerflake/SPINE/Logos/SPINE Logo v2 (Transparent).png")
let logo = original.cropping(to: CGRect(x: 160, y: 260, width: 704, height: 512))!
let context = CGContext(data: nil, width: 1920, height: 1280, bitsPerComponent: 8,
    bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.interpolationQuality = .high
context.setFillColor(CGColor(red: 237/255.0, green: 238/255.0, blue: 227/255.0, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: 1920, height: 1280))
// Normalize generated row bands to exact equal heights and margins.
// 5 * 200px + 4 * 22px + 2 * 96px = 1280px.
let bands: [(Int, Int)] = [(97, 164), (270, 164), (443, 162), (614, 164), (787, 163)]
for (index, band) in bands.enumerated() {
    let row = artwork.cropping(to: CGRect(x: 0, y: band.0, width: artwork.width, height: band.1))!
    context.draw(row, in: CGRect(x: 0, y: 1280 - 96 - 200 - index * 222, width: 1920, height: 200))
}
// Insert the original supplied logo without redrawing or regenerating it.
context.draw(logo, in: CGRect(x: 1385, y: 620, width: 300, height: 300 * 512 / 704))
func centeredText(_ text: String, size: CGFloat, weight: NSFont.Weight, tracking: CGFloat, baseline: CGFloat) {
    let string = NSAttributedString(string: text, attributes: [
        .font: NSFont.systemFont(ofSize: size, weight: weight),
        .foregroundColor: NSColor(srgbRed: 20/255.0, green: 16/255.0, blue: 24/255.0, alpha: 1),
        .kern: tracking
    ])
    let line = CTLineCreateWithAttributedString(string)
    let width = CTLineGetTypographicBounds(line, nil, nil, nil)
    context.textMatrix = .identity
    context.textPosition = CGPoint(x: 1535 - width / 2 + tracking / 2, y: baseline)
    CTLineDraw(line, context)
}
centeredText("SPINE", size: 68, weight: .bold, tracking: 12, baseline: 540)
centeredText("Rank Your Reads.", size: 36, weight: .medium, tracking: 0, baseline: 450)
let destination = CGImageDestinationCreateWithURL(
    URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL,
    UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
