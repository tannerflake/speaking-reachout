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
func canvas(_ alpha: Bool) -> CGContext {
    CGContext(data: nil, width: 1920, height: 1280, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: alpha ? CGImageAlphaInfo.premultipliedLast.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue)!
}
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGColor {
    CGColor(red: r/255, green: g/255, blue: b/255, alpha: 1)
}
let ink = color(20,16,24)
func text(_ value: String, _ context: CGContext, center: CGFloat, baseline: CGFloat,
          size: CGFloat, weight: NSFont.Weight, tracking: CGFloat = 0) {
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: size, weight: weight),
        .foregroundColor: NSColor(cgColor: ink)!, .kern: tracking
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: value, attributes: attrs))
    let width = CTLineGetTypographicBounds(line, nil, nil, nil)
    context.textMatrix = .identity
    context.textPosition = CGPoint(x: center-width/2+tracking/2, y: baseline)
    CTLineDraw(line, context)
}
let artwork = load(CommandLine.arguments[1])
let context = canvas(false)
context.setFillColor(color(237,238,227))
context.fill(CGRect(x: 0, y: 0, width: 1920, height: 1280))
let layer = canvas(true)
layer.interpolationQuality = .high
let fills = [color(242,140,128),color(245,163,77),color(246,220,98),color(166,217,153),color(140,179,235)]
let letters = ["S","A","B","C","F"]
let sourceY = [81,262,440,619,796]
let sourceH = [151,150,150,148,147]
let sourceX = [[143,270,390,513,630,750], [143,270,390,513,630,750],
               [143,270,390,513,630,750], [143,270,390,516,644,774],
               [143,269,391,522,652,750]]
let sourceW = [[112,106,108,104,107,100], [112,106,108,104,107,100],
               [112,106,108,104,107,100], [112,107,113,115,117,76],
               [112,106,116,116,115,100]]
for index in 0..<5 {
    let bottom = CGFloat(1280-96-200-index*222)
    let row = CGRect(x: 50, y: bottom, width: 1100, height: 200)
    let shape = CGPath(roundedRect: row, cornerWidth: 26, cornerHeight: 26, transform: nil)
    layer.saveGState()
    layer.addPath(shape); layer.clip()
    layer.setFillColor(color(226,227,214)); layer.fill(row)
    layer.setFillColor(fills[index]); layer.fill(CGRect(x: 50, y: bottom, width: 112, height: 200))
    layer.restoreGState()
    text(letters[index], layer, center: 106, baseline: bottom+78, size: 60, weight: .regular)
    for book in 0..<6 {
        // Book jackets come from the generated edit; every destination is exactly 128 x 192.
        let sourceRow = index == 4 && book == 5 ? 0 : index
        let rect = CGRect(x: sourceX[sourceRow][book], y: sourceY[sourceRow],
                          width: sourceW[sourceRow][book], height: sourceH[sourceRow])
        let cover = artwork.cropping(to: rect)!
        let slot = CGRect(x: CGFloat(180+book*152), y: bottom+4, width: 128, height: 192)
        layer.saveGState()
        if index == 0 && book == 2 {
            // Keep the exact book dimensions, but restore the lifted ranking gesture.
            layer.translateBy(x: slot.midX, y: slot.midY+12)
            layer.rotate(by: -0.075)
            layer.translateBy(x: -slot.midX, y: -slot.midY)
            layer.saveGState()
            layer.setShadow(offset: CGSize(width: 3, height: -4), blur: 8,
                color: CGColor(red:20/255.0,green:16/255.0,blue:24/255.0,alpha:0.2))
            layer.setFillColor(color(226,227,214))
            layer.addPath(CGPath(roundedRect: slot, cornerWidth: 5, cornerHeight: 5, transform: nil))
            layer.fillPath()
            layer.restoreGState()
        }
        layer.addPath(CGPath(roundedRect: slot, cornerWidth: 5, cornerHeight: 5, transform: nil))
        layer.clip(); layer.draw(cover, in: slot)
        layer.restoreGState()
    }
}
// Fade the generated blur into uniform brand paper, ending at x = 1114.
layer.setBlendMode(.destinationIn)
let fade = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [CGColor(gray:1,alpha:1), CGColor(gray:1,alpha:1), CGColor(gray:1,alpha:0), CGColor(gray:1,alpha:0)] as CFArray,
    locations: [0,0.33,0.58,1])!
layer.drawLinearGradient(fade, start: CGPoint(x:0,y:640), end: CGPoint(x:1920,y:640), options: [.drawsBeforeStartLocation,.drawsAfterEndLocation])
context.draw(layer.makeImage()!, in: CGRect(x:0,y:0,width:1920,height:1280))
let logoSource = load("/Users/tannerflake/SPINE/Logos/SPINE Logo v2 (Transparent).png")
let logo = logoSource.cropping(to: CGRect(x:160,y:260,width:704,height:512))!
context.interpolationQuality = .high
context.draw(logo, in: CGRect(x:1290,y:625,width:340,height:340*512/704))
text("SPINE",context,center:1460,baseline:540,size:76,weight:.bold,tracking:14)
text("Rank Your Reads.",context,center:1460,baseline:430,size:54,weight:.medium)
let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL,
    UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
