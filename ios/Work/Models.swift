import Foundation
import SwiftUI

struct WorkAPIInfo: Codable, Sendable {
    let version: Int
    let capabilities: [String]
}

struct WorkServiceHealth: Decodable, Sendable {
    let ok: Bool
    let api: WorkAPIInfo?
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
    let location: String?
    let available: Bool?
    let peer: PeerSummary?

    var isAvailable: Bool { available ?? true }
    var isRemote: Bool { location == "remote" }
}

struct PeerSummary: Codable, Hashable, Sendable {
    let id: String
    let name: String
    let baseUrl: String
}

struct WorkspacePayload: Codable, Sendable {
    let version: Int
    let workspace: WorkspaceInfo
    let projects: [WorkProject]
    let captures: [WorkCapture]
    let decisions: [WorkDecision]
    let ideas: [WorkIdea]
    let notes: [WorkNote]
    let tasks: [WorkTask]
}

struct WorkspaceInfo: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let root: String
    let dataDir: String
    let startScopePath: String?
    let statuses: [String]
    let location: String?
    let available: Bool?
    let peer: PeerSummary?
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

struct WorkIdea: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let status: String
    let scopePath: String
    let projectPath: String?
    let tags: [String]
    let source: String?
    let revisitAt: String?
    let agentIntent: String
    let createdAt: String
    let updatedAt: String
    let sections: IdeaSections
}

struct IdeaSections: Codable, Hashable, Sendable {
    let opportunity: String
    let whyItMightMatter: String
    let hypothesis: String
    let unknowns: String
    let potentialShape: String
    let evidence: String
    let risksAndConstraints: String
    let nextEvaluation: String
    let outcome: String
}

struct WorkNote: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let text: String
    let scopePath: String
    let projectPath: String?
    let agentIntent: String
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
        case "deferred": .orange
        case "cancelled": .secondary
        default: .indigo
        }
    }
}
