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
          "projects":[{"id":"project-1","projectId":"p-1","name":"Work","description":"Local project manager","path":"work","depth":1,"markers":[".work"]}],
          "captures":[],
          "decisions":[{"id":"decision-1","title":"Choose the client","detail":"Pick one","projectPath":"work","options":["Native","Web"],"recommendedOption":"Native","status":"open","resolution":null,"createdAt":"2026-07-19T12:00:00.000Z","updatedAt":"2026-07-19T12:00:00.000Z"}],
          "ideas":[],
          "notes":[],
          "tasks":[{
            "id":"W-0001","title":"Build iOS app","status":"in_progress","projectPath":"work","type":"feature","assignee":null,"agents":[],"priority":"high","tags":["ios"],"dependsOn":[],"blockedBy":[],"blockedReason":null,"parentId":null,"dueAt":"2026-07-22T12:00:00.000Z","estimate":null,"source":null,"createdAt":"2026-07-19T12:00:00.000Z","updatedAt":"2026-07-19T12:00:00.000Z","startedAt":"2026-07-19T12:00:00.000Z","completedAt":null,"cancelledAt":null,
            "sections":{"goal":"Ship native Work","requirements":"- [x] Connect","acceptanceCriteria":"- [ ] Runs on iPhone","plan":"","notes":"","progressLog":"","completionSummary":""},
            "requirements":[{"checked":true,"text":"Connect"}],"acceptanceCriteria":[{"checked":false,"text":"Runs on iPhone"}],"log":[]
          }]
        }
        """#.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(WorkspacePayload.self, from: data)
        #expect(snapshot.workspace.statuses.count == 4)
        #expect(snapshot.decisions.first?.recommendedOption == "Native")
        #expect(snapshot.tasks.first?.checklistCompleted == 1)
        #expect(snapshot.tasks.first?.dueAt != nil)
    }
}
