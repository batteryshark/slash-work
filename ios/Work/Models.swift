import Foundation
import SwiftUI

// Server keys come and go. Decoding a missing (or wrongly typed) key to a
// default keeps an older app talking to a newer Work instead of failing whole.
extension KeyedDecodingContainer {
    func value<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }

    func value<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }
}

struct WorkServiceHealth: Decodable, Sendable {
    let ok: Bool
    let service: ServiceSummary?

    struct ServiceSummary: Decodable, Sendable {
        let instanceId: String?
        let version: String?
        let staleBuild: Bool?
    }
}

struct WorkspaceDirectory: Codable, Sendable {
    let defaultWorkspaceId: String
    let activeWorkspaceId: String
    let workspaces: [WorkspaceSummary]
}

struct WorkspaceSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let root: String
}

struct WorkspacePayload: Codable, Sendable {
    let version: Int
    let workspace: WorkspaceInfo
    let projects: [WorkProject]
    let captures: [WorkCapture]
    let decisions: [WorkDecision]
    let issues: [WorkIssue]
    let notes: [WorkNote]
    let tasks: [WorkTask]
    /// True when the running service is older than the code on disk.
    let staleBuild: Bool?

    private enum CodingKeys: String, CodingKey {
        case version, workspace, projects, captures, decisions, issues, notes, tasks, staleBuild
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        staleBuild = try container.decodeIfPresent(Bool.self, forKey: .staleBuild)
        workspace = try container.decode(WorkspaceInfo.self, forKey: .workspace)
        projects = try container.decode([WorkProject].self, forKey: .projects)
        captures = try container.decode([WorkCapture].self, forKey: .captures)
        decisions = try container.decode([WorkDecision].self, forKey: .decisions)
        // Old on-device snapshots predate Issues. Keeping them readable preserves
        // the app's offline recovery behavior during an upgrade.
        issues = try container.decodeIfPresent([WorkIssue].self, forKey: .issues) ?? []
        notes = try container.decode([WorkNote].self, forKey: .notes)
        tasks = try container.decode([WorkTask].self, forKey: .tasks)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(workspace, forKey: .workspace)
        try container.encode(projects, forKey: .projects)
        try container.encode(captures, forKey: .captures)
        try container.encode(decisions, forKey: .decisions)
        try container.encode(issues, forKey: .issues)
        try container.encode(notes, forKey: .notes)
        try container.encode(tasks, forKey: .tasks)
        try container.encodeIfPresent(staleBuild, forKey: .staleBuild)
    }
}

struct WorkspaceInfo: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let root: String
    let dataDir: String
    let startScopePath: String?
    let statuses: [String]
}

struct WorkProject: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let projectId: String?
    let name: String
    let description: String
    let path: String
    let depth: Int
    let markers: [String]
    let aliasPaths: [String]?
    /// "board" or "list". Absent on older servers, which only had boards.
    let view: String?
    /// Free-text labels that cut across the folder hierarchy. Absent on older
    /// servers and on untagged projects; only `id` is ever required.
    let tags: [String]?

    var showsPlainList: Bool { view == "list" }
    var tagList: [String] { tags ?? [] }
}

struct WorkCapture: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let text: String
    let kind: String
    let scopePath: String
    let projectPath: String?
    let createdAt: String
    let updatedAt: String
}

struct WorkDecision: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let detail: String
    let projectPath: String?
    let options: [String]
    let recommendedOption: String?
    /// Why the recommendation — or, with no recommendation, why no lean is
    /// possible. Optional so records written before the reason rule decode.
    let recommendationReason: String?
    let status: String
    let resolution: DecisionResolution?
    /// Ids of the Work items this question is about, such as "W-0001".
    let refs: [String]?
    let createdAt: String
    let updatedAt: String

    /// Matches the web's `decisionIsActive`: a deferral whose date has passed is
    /// active again. A deferral with no date, or a date still ahead, stays quiet.
    var isOpen: Bool {
        if status == "open" { return true }
        guard status == "deferred", let until = WorkFormatting.date(from: resolution?.choice?.until) else {
            return false
        }
        return until <= .now
    }
    func references(_ itemID: String) -> Bool { refs?.contains(itemID) == true }
}

struct DecisionResolution: Codable, Hashable, Sendable {
    let action: String
    let choice: DecisionChoice?
    let note: String?
    let at: String
}

struct DecisionChoice: Codable, Hashable, Sendable {
    let option: String?
    let until: String?
    let projectPath: String?
}

enum WorkIssueState: String, Codable, Sendable {
    case queued
    case inProgress = "in_progress"
    case needsHuman = "needs_human"
    case closed

    /// The server's vocabulary can grow. An unknown state must never fail the
    /// whole snapshot, so it decodes to closed instead of throwing.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WorkIssueState(rawValue: raw) ?? .closed
    }

    /// Labels match the web workbench: queued is simply "Open".
    var title: String {
        switch self {
        case .queued: "Open"
        case .inProgress: "In progress"
        case .needsHuman: "Needs you"
        case .closed: "Closed"
        }
    }

    var isTerminal: Bool { self == .closed }
}

struct WorkIssue: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let longId: String
    let title: String
    let body: String
    let state: WorkIssueState
    let scopePath: String
    let projectPath: String?
    /// A human ticks this to hand the issue to automation. Agents cannot set it.
    let delegated: Bool
    let claimedBy: WorkIssueAuthor?
    let resolutionSummary: String?
    let messages: [WorkIssueMessage]
    let stateHistory: [WorkIssueStateChange]
    let createdAt: String
    let updatedAt: String
    /// The actor who filed the issue (the author of the initial body).
    /// Absent in payloads cached before this field existed; bodyAuthor falls
    /// back to the filing state transition in that case.
    let createdBy: WorkIssueAuthor?

    var bodyAuthor: WorkIssueAuthor {
        if let createdBy { return createdBy }
        return stateHistory.first?.actor ?? WorkIssueAuthor(kind: "human", name: nil)
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        longId = c.value(.longId, id)
        title = try c.decode(String.self, forKey: .title)
        body = try c.decode(String.self, forKey: .body)
        state = try c.decode(WorkIssueState.self, forKey: .state)
        scopePath = try c.decode(String.self, forKey: .scopePath)
        projectPath = try c.decodeIfPresent(String.self, forKey: .projectPath)
        delegated = c.value(.delegated, false)
        claimedBy = try c.decodeIfPresent(WorkIssueAuthor.self, forKey: .claimedBy)
        resolutionSummary = try c.decodeIfPresent(String.self, forKey: .resolutionSummary)
        messages = try c.decode([WorkIssueMessage].self, forKey: .messages)
        stateHistory = try c.decode([WorkIssueStateChange].self, forKey: .stateHistory)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        createdBy = try c.decodeIfPresent(WorkIssueAuthor.self, forKey: .createdBy)
    }
}

struct WorkIssueAuthor: Codable, Hashable, Sendable {
    let kind: String
    let name: String?

    var displayName: String {
        if let name, !name.isEmpty { return name }
        return kind == "agent" ? "Agent" : "You"
    }
}

struct WorkIssueMessage: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let body: String
    let author: WorkIssueAuthor
    let createdAt: String
}

struct WorkIssueStateChange: Codable, Hashable, Sendable {
    let from: WorkIssueState?
    let to: WorkIssueState
    let actor: WorkIssueAuthor
    let reason: String?
    let at: String
    let resolutionSummary: String?
}

struct WorkNote: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let text: String
    let scopePath: String
    let projectPath: String?
    let createdBy: NoteAuthor
    let createdAt: String
    let updatedAt: String
}

struct NoteAuthor: Codable, Hashable, Sendable {
    let kind: String
    let name: String?
}

struct ChecklistItem: Codable, Hashable, Sendable {
    let checked: Bool
    let text: String
    /// An agent verified the item as not-done and recorded why. Read-only on
    /// the phone; humans tick boxes or delete rows.
    let declined: Bool
    let reason: String

    init(checked: Bool, text: String, declined: Bool = false, reason: String = "") {
        self.checked = checked
        self.text = text
        self.declined = declined
        self.reason = reason
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        checked = c.value(.checked, false)
        text = c.value(.text, "")
        declined = c.value(.declined, false)
        reason = c.value(.reason, "")
    }
}

struct WorkTask: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let status: String
    let projectPath: String?
    /// A human ticks this to hand the item to automation. Agents cannot set it.
    let delegated: Bool
    let tags: [String]
    let dependsOn: [String]
    let blockedBy: [String]
    let blockedReason: String?
    let parentId: String?
    let dueAt: String?
    let source: String?
    let createdAt: String
    let updatedAt: String
    let startedAt: String?
    let completedAt: String?
    let cancelledAt: String?
    let sections: TaskSections
    let requirements: [ChecklistItem]
    let acceptanceCriteria: [ChecklistItem]
    let log: [TaskLogEntry]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.value(.title, id)
        status = c.value(.status, "backlog")
        projectPath = c.value(.projectPath)
        delegated = c.value(.delegated, false)
        tags = c.value(.tags, [])
        dependsOn = c.value(.dependsOn, [])
        blockedBy = c.value(.blockedBy, [])
        blockedReason = c.value(.blockedReason)
        parentId = c.value(.parentId)
        dueAt = c.value(.dueAt)
        source = c.value(.source)
        createdAt = c.value(.createdAt, "")
        updatedAt = c.value(.updatedAt, "")
        startedAt = c.value(.startedAt)
        completedAt = c.value(.completedAt)
        cancelledAt = c.value(.cancelledAt)
        sections = c.value(.sections, TaskSections())
        requirements = c.value(.requirements, [])
        acceptanceCriteria = c.value(.acceptanceCriteria, [])
        log = c.value(.log, [])
    }

    var isFinished: Bool { status == "done" || status == "cancelled" }
    var checklistCompleted: Int {
        requirements.filter(\.checked).count + acceptanceCriteria.filter(\.checked).count
    }
    var checklistTotal: Int { requirements.count + acceptanceCriteria.count }
    /// First non-empty line of the description, for one-line previews.
    var descriptionSummary: String? {
        sections.description
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty }
    }
}

struct TaskSections: Codable, Hashable, Sendable {
    let description: String
    let goal: String
    let requirements: String
    let acceptanceCriteria: String
    let plan: String
    let notes: String
    let progressLog: String
    let completionSummary: String

    init() {
        self.init(description: "", goal: "", requirements: "", acceptanceCriteria: "",
                  plan: "", notes: "", progressLog: "", completionSummary: "")
    }

    init(description: String, goal: String, requirements: String, acceptanceCriteria: String,
         plan: String, notes: String, progressLog: String, completionSummary: String) {
        self.description = description
        self.goal = goal
        self.requirements = requirements
        self.acceptanceCriteria = acceptanceCriteria
        self.plan = plan
        self.notes = notes
        self.progressLog = progressLog
        self.completionSummary = completionSummary
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        description = c.value(.description, "")
        goal = c.value(.goal, "")
        requirements = c.value(.requirements, "")
        acceptanceCriteria = c.value(.acceptanceCriteria, "")
        plan = c.value(.plan, "")
        notes = c.value(.notes, "")
        progressLog = c.value(.progressLog, "")
        completionSummary = c.value(.completionSummary, "")
    }
}

struct TaskLogEntry: Codable, Hashable, Sendable {
    /// Timestamp of the entry; null when a content bullet (a sub-bullet an
    /// agent appended) has no timestamp of its own and none is inherited.
    let at: String?
    let message: String
}

/// An image picked or pasted into a composer, waiting to be sent beside the
/// record it belongs to.
struct PendingImage: Identifiable, Sendable {
    let id = UUID()
    let name: String
    let contentType: String
    let data: Data

    static let maxBytes = 5 * 1024 * 1024
    static let maxPerWrite = 10

    var payload: AttachmentPayload {
        AttachmentPayload(name: name, contentType: contentType, data: data.base64EncodedString())
    }

    /// The server only accepts the four image types it can serve back; the
    /// magic bytes decide, not the file name.
    static func sniffContentType(_ data: Data) -> String? {
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if data.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if data.starts(with: Array("GIF8".utf8)) { return "image/gif" }
        if data.count > 12, data.starts(with: Array("RIFF".utf8)),
           data[8..<12].elementsEqual(Array("WEBP".utf8)) { return "image/webp" }
        return nil
    }
}

/// One rendered block of a record body: plain markdown, or an image stored
/// beside the record (`![name](../attachments/<record>/<name>)`).
enum RecordBodyBlock: Identifiable, Hashable {
    case text(String)
    case attachment(record: String, name: String)

    var id: Self { self }

    private static let refPattern = #"^!\[[^\]]*\]\(\.\./attachments/([^/)]+)/([^)]+)\)$"#

    /// Splits a body into text and attachment blocks. Attachment refs sit on
    /// their own lines — the server writes them that way.
    static func parse(_ source: String) -> [RecordBodyBlock] {
        var blocks: [RecordBodyBlock] = []
        var textLines: [String] = []
        func flushText() {
            let text = textLines.joined(separator: "\n")
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                blocks.append(.text(text))
            }
            textLines = []
        }
        for line in source.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let match = trimmed.range(of: refPattern, options: .regularExpression) {
                let ref = String(trimmed[match])
                // Between "](../attachments/" and ")": record/name.
                if let open = ref.range(of: "](../attachments/"), let close = ref.lastIndex(of: ")") {
                    let inner = ref[open.upperBound..<close]
                    let parts = inner.split(separator: "/", maxSplits: 1)
                    if parts.count == 2 {
                        flushText()
                        blocks.append(.attachment(record: String(parts[0]), name: String(parts[1])))
                        continue
                    }
                }
            }
            textLines.append(line)
        }
        flushText()
        return blocks
    }
}

// MARK: Files — the read-only browser under /api/files.

struct FileDirectory: Decodable, Sendable {
    let scopePath: String
    let path: String
    let entries: [FileEntry]
}

struct FileEntry: Decodable, Identifiable, Hashable, Sendable {
    let name: String
    let path: String
    let kind: String
    let language: String?
    let gitStatus: String?
    let previewable: Bool
    let blockedReason: String?

    var id: String { path }
    var isDirectory: Bool { kind == "directory" }

    private enum CodingKeys: String, CodingKey {
        case name, path, kind, language, gitStatus, previewable, blockedReason
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.value(.name, "")
        path = c.value(.path, "")
        kind = c.value(.kind, "other")
        language = c.value(.language)
        gitStatus = c.value(.gitStatus)
        previewable = c.value(.previewable, false)
        blockedReason = c.value(.blockedReason)
    }
}

struct FilePreview: Decodable, Sendable {
    let path: String
    let name: String
    let content: String
    let language: String?
    let size: Int
    let truncated: Bool

    private enum CodingKeys: String, CodingKey {
        case path, name, content, language, size, truncated
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = c.value(.path, "")
        name = c.value(.name, "")
        content = c.value(.content, "")
        language = c.value(.language)
        size = c.value(.size, 0)
        truncated = c.value(.truncated, false)
    }
}

struct ServerProfile: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var url: String

    init(id: String = UUID().uuidString, name: String, url: String) {
        self.id = id
        self.name = name
        self.url = url
    }
}

struct CachedWorkspace: Codable, Sendable {
    let snapshot: WorkspacePayload
    let etag: String?
    let savedAt: Date
}

struct ProjectGroup: Identifiable, Hashable, Sendable {
    let key: String
    let title: String
    let projects: [WorkProject]

    var id: String { key }
}

/// The folder path is the taxonomy: a project's first path segment is its group.
/// Projects that sit directly in the root come first, then folders A→Z, and the
/// projects inside each group stay sorted by path.
func projectGroups(_ projects: [WorkProject]) -> [ProjectGroup] {
    var buckets: [String: [WorkProject]] = [:]
    for project in projects where project.path != "." {
        let key = project.path.contains("/") ? String(project.path.split(separator: "/")[0]) : ""
        buckets[key, default: []].append(project)
    }
    return buckets.keys.sorted { left, right in
        if left.isEmpty != right.isEmpty { return left.isEmpty }
        return left < right
    }.map { key in
        ProjectGroup(key: key,
                     title: key.isEmpty ? "Root" : WorkFormatting.title(for: key),
                     projects: (buckets[key] ?? []).sorted { $0.path < $1.path })
    }
}

enum WorkFormatting {
    private static let fractionalParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let standardParser = ISO8601DateFormatter()

    static func date(from value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        return fractionalParser.date(from: value) ?? standardParser.date(from: value)
    }

    static func shortDate(_ value: String?) -> String? {
        guard let date = date(from: value) else { return nil }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    static func relative(_ value: String?) -> String? {
        guard let date = date(from: value) else { return nil }
        return date.formatted(.relative(presentation: .named))
    }

    enum DueTone { case overdue, today, upcoming }

    /// Calendar-day comparison, matching the web's scheduleTone for all-day
    /// dates: before today is overdue, today is today, later is upcoming.
    static func dueTone(_ value: String?) -> DueTone? {
        guard let date = date(from: value) else { return nil }
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: date)
        let today = calendar.startOfDay(for: .now)
        if start < today { return .overdue }
        if start == today { return .today }
        return .upcoming
    }

    /// Chip text matching the web: "Overdue · Aug 12", "Today", "Tomorrow",
    /// or a short date.
    static func dueLabel(_ value: String?) -> String? {
        guard let date = date(from: value), let tone = dueTone(value) else { return nil }
        let day: String
        if Calendar.current.isDateInToday(date) { day = "Today" }
        else if Calendar.current.isDateInTomorrow(date) { day = "Tomorrow" }
        else { day = date.formatted(.dateTime.month(.abbreviated).day()) }
        return tone == .overdue ? "Overdue · \(day)" : day
    }

    /// The web's Work-list group order: known statuses in a fixed rank, then
    /// whatever else the workspace defines, then the terminal pair on demand.
    static func statusGroups(for statuses: [String], showTerminal: Bool) -> [String] {
        let known = ["in_progress", "blocked", "review", "ready", "backlog", "done"]
        var order = known.filter { statuses.contains($0) }
        order.append(contentsOf: statuses.filter { !known.contains($0) && $0 != "cancelled" && $0 != "archived" })
        if showTerminal { order.append(contentsOf: ["cancelled", "archived"]) }
        return order
    }

    static func title(for value: String) -> String {
        value.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

/// Project tags. The rules live in lib/tags.mjs on the service side; this is
/// the verbatim port, so a tag looks the same on the phone and on the desktop
/// with no stored colour and nothing to sync.
enum WorkTag {
    /// Hue angles chosen to stay distinguishable in light and dark mode.
    static let hueAngles: [Double] = [8, 40, 92, 152, 190, 232, 276, 322]

    /// Must match `tagHueIndex` in lib/tags.mjs exactly.
    static func hueIndex(_ tag: String) -> Int {
        var hash: UInt32 = 0
        for unit in tag.lowercased().utf16 { hash = hash &* 31 &+ UInt32(unit) }
        return Int(hash % UInt32(hueAngles.count))
    }

    static func color(_ tag: String) -> Color {
        Color(hue: hueAngles[hueIndex(tag)] / 360, saturation: 0.62, brightness: 0.72)
    }

    /// Trim, drop blanks, dedupe case-insensitively, keep the first-seen casing.
    static func normalize(_ values: [String]) -> [String] {
        var seen: Set<String> = []
        var result: [String] = []
        for value in values {
            let tag = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !tag.isEmpty, seen.insert(tag.lowercased()).inserted else { continue }
            result.append(tag)
        }
        return result
    }

    /// Suggestions are derived, never stored: the union of every project's tags.
    static func vocabulary(_ projects: [WorkProject]) -> [String] {
        normalize(projects.flatMap(\.tagList))
            .sorted { $0.lowercased() < $1.lowercased() }
    }
}

extension Color {
    static func workStatus(_ status: String) -> Color {
        switch status {
        case "done", "adopted", "approved": .green
        case "in_progress", "exploring": .blue
        case "review", "proposed": .purple
        case "blocked", "rejected", "declined": .red
        case "deferred", "needs_human": .orange
        case "cancelled", "closed", "archived": .secondary
        default: .indigo
        }
    }
}

enum TaskLines {
    /// One typed or pasted line becomes one task title. Must match
    /// `splitTaskTitles` in lib/task-lines.mjs exactly — pasting a list is the
    /// whole point, so the shapes a list arrives in are normalised here rather
    /// than in each input handler.
    static func split(_ text: String) -> [String] {
        text.components(separatedBy: .newlines).compactMap { raw in
            var line = raw.trimmingCharacters(in: .whitespaces)
            if let marker = line.range(of: #"^(?:[-*+•–]|\d+[.)])\s+"#, options: .regularExpression) {
                line = String(line[marker.upperBound...]).trimmingCharacters(in: .whitespaces)
            }
            guard !line.isEmpty else { return nil }
            return line.count > 500 ? String(line.prefix(497)) + "…" : line
        }
    }

    private static let commandPrefix = #"^(?:task|todo)\s*:?\s+"#

    /// The capture bar's `task:` switch, matching the web dock: when the first
    /// line starts with `task:` or `todo:`, every line becomes a task title
    /// (the prefix is stripped wherever it repeats). Nil means plain capture.
    static func taskCommandTitles(_ text: String) -> [String]? {
        let lines = split(text)
        guard let first = lines.first,
              first.range(of: commandPrefix, options: [.regularExpression, .caseInsensitive]) != nil else {
            return nil
        }
        let titles = lines.map { line in
            if let marker = line.range(of: commandPrefix, options: [.regularExpression, .caseInsensitive]) {
                return String(line[marker.upperBound...]).trimmingCharacters(in: .whitespaces)
            }
            return line
        }.filter { !$0.isEmpty }
        return titles.isEmpty ? nil : titles
    }
}
