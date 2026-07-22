import SwiftUI
import UniformTypeIdentifiers
import PhotosUI

/// Wraps `UIDocumentPickerViewController` so the user can pick any file from the Files
/// app / iCloud Drive / other providers to upload. Returns security-scoped URLs.
struct DocumentPicker: UIViewControllerRepresentable {
    let onPick: ([URL]) -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        picker.allowsMultipleSelection = true
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ vc: UIDocumentPickerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPick: ([URL]) -> Void
        init(onPick: @escaping ([URL]) -> Void) { self.onPick = onPick }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            onPick(urls)
        }
    }
}

/// Wraps `PHPickerViewController` for photos/videos. Exports the selected item to a
/// temp file and hands back (url, filename, vaultType) so the store can upload it.
struct PhotoPicker: UIViewControllerRepresentable {
    /// (temp file url, filename, vault type "image"/"video")
    let onPick: (URL, String, String) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration()
        config.selectionLimit = 0            // 0 = unlimited
        config.filter = .any(of: [.images, .videos])
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ vc: PHPickerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let onPick: (URL, String, String) -> Void
        init(onPick: @escaping (URL, String, String) -> Void) { self.onPick = onPick }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            for result in results {
                let provider = result.itemProvider
                // Prefer a file representation so we get the real bytes + extension.
                let typeId: String
                let vaultType: String
                if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                    typeId = UTType.movie.identifier; vaultType = "video"
                } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    typeId = UTType.image.identifier; vaultType = "image"
                } else { continue }

                provider.loadFileRepresentation(forTypeIdentifier: typeId) { [onPick] url, _ in
                    guard let url else { return }
                    // The system deletes the provided URL when this closure returns, so copy first.
                    let name = url.lastPathComponent
                    let tmp = FileManager.default.temporaryDirectory
                        .appendingPathComponent(UUID().uuidString + "-" + name)
                    do {
                        try FileManager.default.copyItem(at: url, to: tmp)
                        DispatchQueue.main.async { onPick(tmp, name, vaultType) }
                    } catch { /* skip this one */ }
                }
            }
        }
    }
}
