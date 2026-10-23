import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

func load(_ path: String) -> CGImage {
    let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)!
    return CGImageSourceCreateImageAtIndex(source, 0, nil)!
}

let background = load(CommandLine.arguments[1])
let originalLogo = load("/Users/tannerflake/SPINE/Logos/SPINE Logo v2 (Transparent).png")
// Crop only transparent padding. Use the supplied artwork without redrawing it.
let logo = originalLogo.cropping(to: CGRect(x: 160, y: 260, width: 704, height: 512))!
let context = CGContext(data: nil, width: 1920, height: 1280, bitsPerComponent: 8,
                        bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.interpolationQuality = .high
context.draw(background, in: CGRect(x: 0, y: 0, width: 1920, height: 1280))
context.draw(logo, in: CGRect(x: 100, y: 480, width: 440, height: 320))
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
