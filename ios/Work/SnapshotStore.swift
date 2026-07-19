import Foundation

actor SnapshotStore {
    private let directory: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(directory: URL? = nil) {
        if let directory {
            self.directory = directory
        } else {
            let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory,
                                                               in: .userDomainMask).first!
            self.directory = applicationSupport
                .appending(path: "Work", directoryHint: .isDirectory)
                .appending(path: "Snapshots", directoryHint: .isDirectory)
        }
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
    }

    func load(serverID: String, workspaceID: String) throws -> CachedWorkspace? {
        let url = fileURL(serverID: serverID, workspaceID: workspaceID)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        return try decoder.decode(CachedWorkspace.self, from: data)
    }

    func save(_ cached: CachedWorkspace, serverID: String, workspaceID: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try encoder.encode(cached)
        try data.write(to: fileURL(serverID: serverID, workspaceID: workspaceID), options: [.atomic])
    }

    func remove(serverID: String) throws {
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        let prefix = "\(safe(serverID))--"
        for url in try FileManager.default.contentsOfDirectory(at: directory,
                                                               includingPropertiesForKeys: nil)
        where url.lastPathComponent.hasPrefix(prefix) {
            try FileManager.default.removeItem(at: url)
        }
    }

    private func fileURL(serverID: String, workspaceID: String) -> URL {
        directory.appending(path: "\(safe(serverID))--\(safe(workspaceID)).json")
    }

    private func safe(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        return value.unicodeScalars.map { allowed.contains($0) ? Character(String($0)) : "_" }
            .reduce(into: "") { $0.append($1) }
    }
}
