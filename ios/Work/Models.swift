import Foundation
import SwiftUI

struct WorkServiceHealth: Decodable, Sendable {
    let ok: Bool
    let service: ServiceSummary?

    struct ServiceSummary: Decodable, Sendable {
        let instanceId: String?
        let version: String?
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

    private enum CodingKeys: String, CodingKey {
        case version, workspace, projects, captures, decisions, issues, notes, tasks
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
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
    let status: String
    let resolution: DecisionResolution?
    let createdAt: String
    let updatedAt: String

    var isOpen: Bool { status == "open" }
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
    case resolved
    case closed

    var title: String {
        switch self {
        case .queued: "Queued"
        case .inProgress: "Agent working"
        case .needsHuman: "Needs you"
        case .resolved: "Resolved"
        case .closed: "Closed"
        }
    }

    var isTerminal: Bool { self == .resolved || self == .closed }
}

struct WorkIssue: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let body: String
    let state: WorkIssueState
    let scopePath: String
    let projectPath: String?
    let claimedBy: WorkIssueAuthor?
    let resolutionSummary: String?
    let messages: [WorkIssueMessage]
    let stateHistory: [WorkIssueStateChange]
    let createdAt: String
    let updatedAt: String
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
}

struct WorkTask: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let status: String
    let projectPath: String?
    let type: String
    let assignee: String?
    let agents: [String]
    let priority: String
    let tags: [String]
    let dependsOn: [String]
    let blockedBy: [String]
    let blockedReason: String?
    let parentId: String?
    let dueAt: String?
    let estimate: String?
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

    var isFinished: Bool { status == "done" || status == "cancelled" }
    var checklistCompleted: Int {
        requirements.filter(\.checked).count + acceptanceCriteria.filter(\.checked).count
    }
    var checklistTotal: Int { requirements.count + acceptanceCriteria.count }
}

struct TaskSections: Codable, Hashable, Sendable {
    let goal: String
    let requirements: String
    let acceptanceCriteria: String
    let plan: String
    let notes: String
    let progressLog: String
    let completionSummary: String
}

struct TaskLogEntry: Codable, Hashable, Sendable {
    let at: String
    let message: String
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

    static func title(for value: String) -> String {
        value.replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

extension Color {
    static func workPriority(_ priority: String) -> Color {
        switch priority {
        case "critical": .red
        case "high": .orange
        case "medium": .blue
        case "low": .teal
        default: .secondary
        }
    }

    static func workStatus(_ status: String) -> Color {
        switch status {
        case "done", "adopted", "approved": .green
        case "in_progress", "exploring": .blue
        case "review", "proposed": .purple
        case "blocked", "rejected", "declined": .red
        case "deferred", "needs_human": .orange
        case "cancelled", "closed": .secondary
        case "resolved": .green
        default: .indigo
        }
    }
}
