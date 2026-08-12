import Foundation
import Testing
@testable import Work

struct WorkTests {
    @Test func transportPolicyAllowsUserSelectedTailnetHTTP() {
        let transportPolicy = Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity")
            as? [String: Any]

        #expect(transportPolicy?["NSAllowsArbitraryLoads"] as? Bool == true)
        // On current iOS versions, this key's presence makes iOS ignore NSAllowsArbitraryLoads.
        #expect(transportPolicy?["NSAllowsLocalNetworking"] == nil)
    }

    @Test func serverURLRequiresExplicitSafeHTTPTransport() throws {
        #expect(throws: WorkAPIError.invalidServerURL) {
            try WorkAPIClient.validatedURL(from: "macbook:43170")
        }
        #expect(throws: WorkAPIError.unsupportedScheme) {
            try WorkAPIClient.validatedURL(from: "ftp://macbook/file")
        }
        #expect(throws: WorkAPIError.embeddedCredentials) {
            try WorkAPIClient.validatedURL(from: "http://user:secret@macbook:43170")
        }
        #expect(try WorkAPIClient.validatedURL(from: " http://100.64.0.7:43170/ ").absoluteString
                == "http://100.64.0.7:43170")
    }

    @Test func workspaceSnapshotDecodesCurrentWireShape() throws {
        let data = #"""
        {
          "version":1,
          "workspace":{"id":"ws-1","name":"Projects","root":"/srv/projects","dataDir":"/srv/projects/.work","startScopePath":".","statuses":["backlog","in_progress","review","done"]},
          "staleBuild":true,
          "projects":[{"id":"project-1","projectId":"p-1","name":"Work","description":"Local project manager","path":"work","depth":1,"markers":[".work"],"view":"list"}],
          "captures":[],
          "decisions":[{"id":"decision-1","title":"Choose the client","detail":"Pick one","projectPath":"work","options":["Native","Web"],"recommendedOption":"Native","status":"open","resolution":null,"refs":["W-0001"],"createdAt":"2026-07-19T12:00:00.000Z","updatedAt":"2026-07-19T12:00:00.000Z"}],
          "issues":[{
            "id":"issue_mabc1234_ab12cd34ef56","title":"App freezes on refresh","body":"The app freezes after tapping **Refresh**.\\n\\n```swift\\nawait model.refresh()\\n```","state":"needs_human","scopePath":"work","projectPath":"work","claimedBy":{"kind":"agent","name":"codex-cli"},"resolutionSummary":null,
            "messages":[{"id":"message_mabc1234_ab12cd34ef56","body":"Can you confirm whether this happens while offline?","author":{"kind":"agent","name":"codex-cli"},"createdAt":"2026-07-19T12:05:00.000Z"}],
            "stateHistory":[
              {"from":null,"to":"queued","actor":{"kind":"human","name":null},"at":"2026-07-19T12:00:00.000Z","reason":null,"resolutionSummary":null},
              {"from":"queued","to":"needs_human","actor":{"kind":"agent","name":"codex-cli"},"at":"2026-07-19T12:05:00.000Z","reason":"Need reproduction context.","resolutionSummary":null}
            ],
            "createdAt":"2026-07-19T12:00:00.000Z","updatedAt":"2026-07-19T12:05:00.000Z"
          }],
          "notes":[],
          "tasks":[{
            "id":"W-0001","title":"Build iOS app","status":"in_progress","projectPath":"work","delegated":true,"tags":["ios"],"dependsOn":[],"blockedBy":[],"blockedReason":null,"parentId":null,"dueAt":"2026-07-22T12:00:00.000Z","source":null,"createdAt":"2026-07-19T12:00:00.000Z","updatedAt":"2026-07-19T12:00:00.000Z","startedAt":"2026-07-19T12:00:00.000Z","completedAt":null,"cancelledAt":null,
            "sections":{"description":"A native client.\nSecond line.","goal":"Ship native Work","requirements":"- [x] Connect","acceptanceCriteria":"- [ ] Runs on iPhone","plan":"","notes":"","progressLog":"","completionSummary":""},
            "requirements":[{"checked":true,"text":"Connect"}],"acceptanceCriteria":[{"checked":false,"text":"Runs on iPhone"}],"log":[]
          }]
        }
        """#.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(WorkspacePayload.self, from: data)
        #expect(snapshot.workspace.statuses.count == 4)
        #expect(snapshot.decisions.first?.recommendedOption == "Native")
        #expect(snapshot.issues.first?.state == .needsHuman)
        #expect(snapshot.issues.first?.messages.first?.author.name == "codex-cli")
        #expect(snapshot.issues.first?.stateHistory.first?.from == nil)
        #expect(snapshot.issues.first?.body.contains("```swift") == true)
        #expect(snapshot.tasks.first?.checklistCompleted == 1)
        #expect(snapshot.tasks.first?.dueAt != nil)
        #expect(snapshot.tasks.first?.delegated == true)
        #expect(snapshot.tasks.first?.descriptionSummary == "A native client.")
        #expect(snapshot.decisions.first?.references("W-0001") == true)
        #expect(snapshot.projects.first?.showsPlainList == true)
        #expect(snapshot.staleBuild == true)
    }

    /// Today's breakage: a non-optional Swift field vanished server-side and the
    /// whole snapshot stopped decoding. Missing keys must fall back instead.
    @Test func snapshotDecodesWhenTheServerOmitsNewerKeys() throws {
        let data = #"""
        {
          "version":1,
          "workspace":{"id":"ws-1","name":"Projects","root":"/srv/projects","dataDir":"/srv/projects/.work","startScopePath":".","statuses":[]},
          "projects":[{"id":"p","projectId":null,"name":"Work","description":"","path":"work","depth":1,"markers":[]}],
          "captures":[],
          "decisions":[{"id":"d","title":"Q","detail":"","projectPath":null,"options":[],"recommendedOption":null,"status":"open","resolution":null,"createdAt":"","updatedAt":""}],
          "notes":[],
          "tasks":[{"id":"W-0002"}]
        }
        """#.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(WorkspacePayload.self, from: data)
        let task = try #require(snapshot.tasks.first)
        #expect(task.title == "W-0002")
        #expect(task.status == "backlog")
        #expect(task.delegated == false)
        #expect(task.sections.description.isEmpty)
        #expect(task.descriptionSummary == nil)
        #expect(snapshot.projects.first?.showsPlainList == false)
        #expect(snapshot.decisions.first?.references("W-0002") == false)
        #expect(snapshot.staleBuild == nil)
    }

    @Test func preIssuesWorkspaceSnapshotStillDecodesForOfflineRecovery() throws {
        let data = #"""
        {
          "version":1,
          "workspace":{"id":"ws-1","name":"Projects","root":"/srv/projects","dataDir":"/srv/projects/.work","startScopePath":".","statuses":[]},
          "projects":[],
          "captures":[],
          "decisions":[],
          "notes":[],
          "tasks":[]
        }
        """#.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(WorkspacePayload.self, from: data)
        #expect(snapshot.issues.isEmpty)
    }
}
