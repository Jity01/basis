import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count > 1 else {
  fputs("Usage: ocr-helper <jpeg-path>\n", stderr)
  exit(1)
}

let path = CommandLine.arguments[1]
guard let nsImage = NSImage(contentsOfFile: path),
  let tiff = nsImage.tiffRepresentation,
  let rep = NSBitmapImageRep(data: tiff),
  let cgImage = rep.cgImage
else {
  fputs("Failed to load image\n", stderr)
  exit(2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
  try handler.perform([request])
} catch {
  fputs("\(error.localizedDescription)\n", stderr)
  exit(3)
}

guard let observations = request.results as? [VNRecognizedTextObservation] else {
  print("")
  exit(0)
}

let lines = observations.compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\n"))
