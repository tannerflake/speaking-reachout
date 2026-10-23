import Foundation
import CoreGraphics
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
context.draw(artwork, in: CGRect(x: 0, y: 0, width: 1920, height: 1280))
// Directly composite the supplied PNG. No regenerated or redrawn brand mark.
context.draw(logo, in: CGRect(x: 894, y: 1155, width: 132, height: 96))
let destination = CGImageDestinationCreateWithURL(
    URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL,
    UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
