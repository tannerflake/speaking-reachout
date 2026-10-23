import Foundation
import CoreGraphics
import ImageIO
func read(_ path: String) -> CGContext {
    let source = CGImageSourceCreateWithURL(URL(fileURLWithPath:path) as CFURL,nil)!
    let image = CGImageSourceCreateImageAtIndex(source,0,nil)!
    let c = CGContext(data:nil,width:1920,height:1280,bitsPerComponent:8,bytesPerRow:1920*4,
        space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
    c.draw(image,in:CGRect(x:0,y:0,width:1920,height:1280))
    return c
}
let old = read(CommandLine.arguments[1])
let new = read(CommandLine.arguments[2])
let a = old.data!.assumingMemoryBound(to:UInt8.self)
let b = new.data!.assumingMemoryBound(to:UInt8.self)
var changed = 0
var outside = 0
var minY = 1280
var maxY = 0
for y in 0..<1280 {
    for x in 0..<1920 {
        let i = (y*1920+x)*4
        if a[i] != b[i] || a[i+1] != b[i+1] || a[i+2] != b[i+2] {
            changed += 1
            minY = min(minY,y); maxY = max(maxY,y)
            let permitted = ((x >= 150 && x <= 340) || (x >= 450 && x <= 640)) && y >= 60 && y <= 320
                || x >= 938 && x <= 1070 && y >= 540 && y <= 740
            if !permitted { outside += 1 }
        }
    }
}
print("Changed pixels: \(changed); outside the three edited book regions: \(outside); changed y bounds: \(minY)...\(maxY)")
precondition(outside == 0)
