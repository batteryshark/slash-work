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
            "id":"I-0001","longId":"issue_mabc1234_ab12cd34ef56","title":"App freezes on refresh","body":"The app freezes after tapping **Refresh**.\\n\\n```swift\\nawait model.refresh()\\n```","state":"needs_human","scopePath":"work","projectPath":"work","delegated":true,"claimedBy":{"kind":"agent","name":"codex-cli"},"resolutionSummary":null,
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
        #expect(snapshot.issues.first?.id == "I-0001")
        #expect(snapshot.issues.first?.longId == "issue_mabc1234_ab12cd34ef56")
        #expect(snapshot.issues.first?.messages.first?.author.name == "codex-cli")
        #expect(snapshot.issues.first?.stateHistory.first?.from == nil)
        #expect(snapshot.issues.first?.body.contains("```swift") == true)
        #expect(snapshot.issues.first?.delegated == true)
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

    /// The server collapsed resolved into closed and its vocabulary can grow
    /// again. Any unknown state string must decode to closed, never fail the
    /// whole snapshot.
    @Test func unknownIssueStatesDecodeToClosed() throws {
        let issue = #"{"id":"I-0002","title":"Old","body":"b","state":"resolved","scopePath":".","projectPath":null,"claimedBy":null,"resolutionSummary":null,"messages":[],"stateHistory":[{"from":"some_future_state","to":"resolved","actor":{"kind":"human","name":null},"at":"","reason":null,"resolutionSummary":null}],"createdAt":"","updatedAt":""}"#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(WorkIssue.self, from: issue)
        #expect(decoded.state == .closed)
        #expect(decoded.state.isTerminal)
        #expect(decoded.stateHistory.first?.from == .closed)
        #expect(decoded.stateHistory.first?.to == .closed)
    }

    /// CONTRACT §3: declined means verified-as-not-done with the reason kept.
    /// Older payloads without the keys still decode.
    @Test func checklistItemsCarryDeclineStateTolerantly() throws {
        let declined = #"{"checked":false,"text":"Ship it","declined":true,"reason":"Superseded by W-0002."}"#.data(using: .utf8)!
        let item = try JSONDecoder().decode(ChecklistItem.self, from: declined)
        #expect(item.declined)
        #expect(item.reason == "Superseded by W-0002.")

        let bare = #"{"checked":true,"text":"Connect"}"#.data(using: .utf8)!
        let old = try JSONDecoder().decode(ChecklistItem.self, from: bare)
        #expect(old.checked)
        #expect(old.declined == false)
        #expect(old.reason.isEmpty)
    }

    @Test func statusGroupsFollowTheWebOrder() {
        let statuses = ["backlog", "ready", "in_progress", "review", "done", "someday"]
        #expect(WorkFormatting.statusGroups(for: statuses, showTerminal: false)
                == ["in_progress", "review", "ready", "backlog", "done", "someday"])
        #expect(Array(WorkFormatting.statusGroups(for: statuses, showTerminal: true).suffix(2))
                == ["cancelled", "archived"])
    }

    /// The capture bar's task: switch, pinned to the web dock's regex.
    @Test func taskPrefixTurnsCaptureLinesIntoTaskTitles() {
        #expect(TaskLines.taskCommandTitles("task: Pack the kitchen\ntask: Book the van")
                == ["Pack the kitchen", "Book the van"])
        #expect(TaskLines.taskCommandTitles("TODO buy tape\nsecond line")
                == ["buy tape", "second line"])
        #expect(TaskLines.taskCommandTitles("a plain thought") == nil)
        #expect(TaskLines.taskCommandTitles("task:") == nil)
    }

    @Test func issueDelegationDefaultsOffAndPatchesOnlyDelegation() throws {
        let issue = #"{"id":"issue_mabc1234_ab12cd34ef56","title":"Named issue","body":"Details","state":"queued","scopePath":".","projectPath":null,"claimedBy":null,"resolutionSummary":null,"messages":[],"stateHistory":[],"createdAt":"","updatedAt":""}"#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(WorkIssue.self, from: issue)
        #expect(decoded.delegated == false)
        #expect(decoded.longId == decoded.id)

        let patch = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(IssuePatchRequest(delegated: true))
        ) as? [String: Any]
        #expect(patch?.keys.sorted() == ["delegated"])
        #expect(patch?["delegated"] as? Bool == true)
    }

    /// The web treats a deferral whose date has passed as active again. iOS used
    /// to check the status only, so an expired deferral never came back.
    @Test func expiredDeferralCountsAsActiveLikeTheWeb() throws {
        let past = Self.iso(Date.now.addingTimeInterval(-3600))
        let future = Self.iso(Date.now.addingTimeInterval(3600))

        #expect(try Self.decision(status: "open").isOpen)
        #expect(try Self.decision(status: "deferred", until: past).isOpen)
        #expect(try Self.decision(status: "deferred", until: future).isOpen == false)
        #expect(try Self.decision(status: "deferred").isOpen == false)
        #expect(try Self.decision(status: "resolved", until: past).isOpen == false)
    }

    @Test func taskEditPatchesOnlyTheFieldItNames() throws {
        let edit = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(TaskPatchRequest(description: "Rewritten on the couch"))
        ) as? [String: Any]
        #expect(edit?.keys.sorted() == ["description"])
        #expect(edit?["description"] as? String == "Rewritten on the couch")

        let goal = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(TaskPatchRequest(goal: "Ship it"))
        ) as? [String: Any]
        #expect(goal?.keys.sorted() == ["goal"])

        let delegation = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(TaskPatchRequest(delegated: true))
        ) as? [String: Any]
        #expect(delegation?.keys.sorted() == ["delegated"])
    }

    @Test func projectGroupsFollowTheFolderPath() {
        let paths = ["work-management/project-manager-thing", "life/job-hunt", "maestro",
                     "life/new-house", "reverse-engineering-tools/rekit-factory", ".", "atlas"]
        let groups = projectGroups(paths.map(Self.project))

        // Root-level projects come first under one heading, then folders A→Z.
        #expect(groups.map(\.key) == ["", "life", "reverse-engineering-tools", "work-management"])
        #expect(groups[0].title == "Root")
        #expect(groups[0].projects.map(\.path) == ["atlas", "maestro"])
        #expect(groups[1].title == "Life")
        #expect(groups[1].projects.map(\.path) == ["life/job-hunt", "life/new-house"])
        #expect(groups[2].title == "Reverse Engineering Tools")

        // The workspace root itself is never a group, and input order never matters.
        #expect(groups.flatMap { $0.projects }.contains { $0.path == "." } == false)
        #expect(projectGroups(paths.reversed().map(Self.project)) == groups)
    }

    // The tag colour is a pure function of the name, shared by hand with
    // lib/tags.mjs. These indices are the ones the JavaScript side produces.
    @Test func tagColoursMatchTheWebPalette() {
        #expect(WorkTag.hueIndex("house") == 0)
        #expect(WorkTag.hueIndex("House") == WorkTag.hueIndex("house"))
        #expect(WorkTag.hueIndex("lvp-repair") == 4)
        #expect(WorkTag.hueIndex("work") == 1)
        #expect(WorkTag.hueAngles[WorkTag.hueIndex("lvp-repair")] == 190)
    }

    @Test func tagNormalizationDedupesCaseInsensitivelyAndKeepsFirstCasing() {
        #expect(WorkTag.normalize([" House ", "house", "", "HOUSE", "yard "]) == ["House", "yard"])
        #expect(WorkTag.vocabulary([Self.tagged("a", ["b", "House"]),
                                    Self.tagged("c", ["house", "a"]),
                                    Self.project(path: "d")]) == ["a", "b", "House"])
    }

    @Test func projectDecodesWithoutTags() throws {
        let data = #"{"id":"p","name":"P","description":"","path":"p","depth":1,"markers":[]}"#.data(using: .utf8)!
        #expect(try JSONDecoder().decode(WorkProject.self, from: data).tagList == [])
    }

    private static func project(path: String) -> WorkProject {
        WorkProject(id: path, projectId: nil, name: path, description: "", path: path,
                    depth: path.split(separator: "/").count, markers: [], aliasPaths: nil, view: nil,
                    tags: nil)
    }

    private static func tagged(_ path: String, _ tags: [String]) -> WorkProject {
        WorkProject(id: path, projectId: nil, name: path, description: "", path: path,
                    depth: 1, markers: [], aliasPaths: nil, view: nil, tags: tags)
    }

    private static func iso(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    private static func decision(status: String, until: String? = nil) throws -> WorkDecision {
        let resolution = until.map {
            #"{"action":"defer","choice":{"option":null,"until":"\#($0)","projectPath":null},"note":null,"at":"2026-01-01T00:00:00.000Z"}"#
        } ?? "null"
        let data = #"""
        {"id":"d","title":"Q","detail":"","projectPath":null,"options":[],"recommendedOption":null,
         "status":"\#(status)","resolution":\#(resolution),"refs":[],"createdAt":"","updatedAt":""}
        """#.data(using: .utf8)!
        return try JSONDecoder().decode(WorkDecision.self, from: data)
    }
}

@Test func taskLineSplitMatchesTheSharedRule() throws {
    // Pinned to lib/task-lines.mjs: two implementations of one rule is how the
    // clients drifted three times before.
    #expect(TaskLines.split("Pack the kitchen\nBook the van\n\n- Cancel the internet\n2) Forward the mail")
            == ["Pack the kitchen", "Book the van", "Cancel the internet", "Forward the mail"])
    #expect(TaskLines.split("  spaced  ") == ["spaced"])
    #expect(TaskLines.split("• bullet") == ["bullet"])
    #expect(TaskLines.split("1. numbered") == ["numbered"])
    #expect(TaskLines.split("").isEmpty)
    #expect(TaskLines.split(String(repeating: "x", count: 600)).first?.count == 498)
}
