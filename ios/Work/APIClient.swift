import Foundation

enum WorkAPIError: LocalizedError, Equatable {
    case invalidServerURL
    case unsupportedScheme
    case embeddedCredentials
    case nonHTTPResponse
    case incompatibleAPI(Int)
    case responseTooLarge
    case server(status: Int, code: String?, message: String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL:
            "Enter the full Work URL, including http:// or https://."
        case .unsupportedScheme:
            "The Work URL must use HTTP or HTTPS."
        case .embeddedCredentials:
            "Do not put credentials in the Work URL."
        case .nonHTTPResponse:
            "The Work instance returned an invalid response."
        case let .incompatibleAPI(version):
            "This Work instance uses API version \(version), which this app does not support."
        case .responseTooLarge:
            "The Work response exceeded the app's 8 MB safety limit."
        case let .server(status, _, message):
            message.isEmpty ? "Work returned HTTP \(status)." : message
        case let .decoding(message):
            "Work returned data this app could not read: \(message)"
        }
    }
}

enum WorkspaceFetchResult: Sendable {
    case unchanged(etag: String?)
    case snapshot(WorkspacePayload, etag: String?)
}

struct WorkAPIClient: @unchecked Sendable {
    static let supportedAPIVersion = 1
    private static let maximumResponseBytes = 8 * 1024 * 1024

    let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(baseURL: URL, session: URLSession? = nil) throws {
        let validated = try Self.validatedURL(from: baseURL.absoluteString)
        self.baseURL = validated
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 15
            configuration.timeoutIntervalForResource = 30
            configuration.waitsForConnectivity = false
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: configuration)
        }
    }

    static func validatedURL(from value: String) throws -> URL {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              components.host != nil else {
            throw WorkAPIError.invalidServerURL
        }
        guard scheme == "http" || scheme == "https" else {
            throw WorkAPIError.unsupportedScheme
        }
        guard components.user == nil, components.password == nil else {
            throw WorkAPIError.embeddedCredentials
        }
        guard components.query == nil, components.fragment == nil else {
            throw WorkAPIError.invalidServerURL
        }
        components.path = components.path == "/" ? "" : components.path
        guard components.path.isEmpty, let url = components.url else {
            throw WorkAPIError.invalidServerURL
        }
        return url
    }

    func health() async throws -> WorkServiceHealth {
        let health: WorkServiceHealth = try await get("api/health")
        let version = health.api?.version ?? 1
        guard version == Self.supportedAPIVersion else {
            throw WorkAPIError.incompatibleAPI(version)
        }
        return health
    }

    func workspaces(forceRefresh: Bool = false) async throws -> WorkspaceDirectory {
        try await get("api/workspaces", query: forceRefresh ? [URLQueryItem(name: "refresh", value: "1")] : [])
    }

    func workspace(id: String, etag: String?) async throws -> WorkspaceFetchResult {
        var headers: [String: String] = [:]
        if let etag { headers["If-None-Match"] = etag }
        let (data, response) = try await data(path: "api/workspace", workspaceID: id, headers: headers)
        if response.statusCode == 304 {
            return .unchanged(etag: response.value(forHTTPHeaderField: "ETag") ?? etag)
        }
        try validate(response: response, data: data)
        return .snapshot(try decode(WorkspacePayload.self, from: data),
                         etag: response.value(forHTTPHeaderField: "ETag"))
    }

    func createCapture(text: String, kind: String, projectPath: String?, workspaceID: String) async throws -> WorkCapture {
        let body = CaptureRequest(text: text, kind: kind,
                                  scopePath: projectPath ?? ".", projectPath: projectPath)
        return try await send("api/captures", method: "POST", workspaceID: workspaceID, body: body)
    }

    func createTask(title: String, type: String, priority: String, projectPath: String?,
                    dueAt: Date?, workspaceID: String) async throws -> WorkTask {
        let body = CreateTaskRequest(title: title, projectPath: projectPath, type: type,
                                     priority: priority, dueAt: dueAt.map(ISO8601DateFormatter().string))
        return try await send("api/tasks", method: "POST", workspaceID: workspaceID, body: body)
    }

    func moveTask(id: String, status: String, note: String?, workspaceID: String) async throws -> WorkTask {
        try await send("api/tasks/\(encoded(id))/move", method: "POST", workspaceID: workspaceID,
                       body: MoveTaskRequest(status: status, note: note))
    }

    func toggleChecklist(taskID: String, section: String, index: Int, checked: Bool,
                         workspaceID: String) async throws -> WorkTask {
        try await send("api/tasks/\(encoded(taskID))/checklist", method: "POST", workspaceID: workspaceID,
                       body: ChecklistRequest(section: section, index: index, checked: checked))
    }

    func appendTaskLog(taskID: String, message: String, workspaceID: String) async throws -> WorkTask {
        try await send("api/tasks/\(encoded(taskID))/log", method: "POST", workspaceID: workspaceID,
                       body: TaskLogRequest(message: message))
    }

    func resolveDecision(id: String, action: String, option: String?, note: String?, until: Date?,
                         workspaceID: String) async throws -> WorkDecision {
        let choice: DecisionActionChoice?
        if let option {
            choice = DecisionActionChoice(option: option, until: nil)
        } else if let until {
            choice = DecisionActionChoice(option: nil, until: ISO8601DateFormatter().string(from: until))
        } else {
            choice = nil
        }
        return try await send("api/decisions/\(encoded(id))/actions", method: "POST", workspaceID: workspaceID,
                              body: DecisionActionRequest(action: action, choice: choice, note: note))
    }

    func createIdea(title: String, opportunity: String, projectPath: String?, workspaceID: String) async throws -> WorkIdea {
        let body = CreateIdeaRequest(title: title, projectPath: projectPath,
                                     scopePath: projectPath ?? ".", opportunity: opportunity)
        return try await send("api/ideas", method: "POST", workspaceID: workspaceID, body: body)
    }

    func updateIdeaStatus(id: String, status: String, reason: String?, workspaceID: String) async throws -> WorkIdea {
        try await send("api/ideas/\(encoded(id))", method: "PATCH", workspaceID: workspaceID,
                       body: IdeaStatusRequest(status: status, reason: reason))
    }

    func requestIdeaEvaluation(id: String, workspaceID: String) async throws -> WorkIdea {
        try await send("api/ideas/\(encoded(id))", method: "PATCH", workspaceID: workspaceID,
                       body: IdeaIntentRequest(agentIntent: "evaluation_requested"))
    }

    func deleteIdea(id: String, workspaceID: String) async throws {
        try await delete("api/ideas/\(encoded(id))", workspaceID: workspaceID)
    }

    func deleteCapture(id: String, workspaceID: String) async throws {
        try await delete("api/captures/\(encoded(id))", workspaceID: workspaceID)
    }

    func createNote(title: String, text: String, projectPath: String?, workspaceID: String) async throws -> WorkNote {
        let body = CreateNoteRequest(title: title, text: text, scopePath: projectPath ?? ".",
                                     projectPath: projectPath, agentIntent: "reference_only")
        return try await send("api/notes", method: "POST", workspaceID: workspaceID, body: body)
    }

    private func get<Response: Decodable>(_ path: String, workspaceID: String? = nil,
                                           query: [URLQueryItem] = []) async throws -> Response {
        let (data, response) = try await data(path: path, workspaceID: workspaceID, query: query)
        try validate(response: response, data: data)
        return try decode(Response.self, from: data)
    }

    private func send<Response: Decodable, Body: Encodable>(_ path: String, method: String,
                                                             workspaceID: String, body: Body) async throws -> Response {
        let encodedBody = try encoder.encode(body)
        let (data, response) = try await data(path: path, method: method, workspaceID: workspaceID,
                                              headers: ["Content-Type": "application/json"], body: encodedBody)
        try validate(response: response, data: data)
        return try decode(Response.self, from: data)
    }

    private func delete(_ path: String, workspaceID: String) async throws {
        let (data, response) = try await data(path: path, method: "DELETE", workspaceID: workspaceID)
        try validate(response: response, data: data)
    }

    private func data(path: String, method: String = "GET", workspaceID: String? = nil,
                      query: [URLQueryItem] = [], headers: [String: String] = [:],
                      body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: try url(path: path, query: query),
                                 cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let workspaceID { request.setValue(workspaceID, forHTTPHeaderField: "X-Work-Workspace") }
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else { throw WorkAPIError.nonHTTPResponse }
        if let declared = httpResponse.value(forHTTPHeaderField: "Content-Length").flatMap(Int.init),
           declared > Self.maximumResponseBytes {
            throw WorkAPIError.responseTooLarge
        }
        guard data.count <= Self.maximumResponseBytes else { throw WorkAPIError.responseTooLarge }
        return (data, httpResponse)
    }

    private func url(path: String, query: [URLQueryItem]) throws -> URL {
        let normalized = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        var url = baseURL.appending(path: normalized)
        if !query.isEmpty {
            guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                throw WorkAPIError.invalidServerURL
            }
            components.queryItems = query
            guard let queryURL = components.url else { throw WorkAPIError.invalidServerURL }
            url = queryURL
        }
        return url
    }

    private func validate(response: HTTPURLResponse, data: Data) throws {
        guard (200..<300).contains(response.statusCode) else {
            let payload = try? decoder.decode(APIErrorEnvelope.self, from: data)
            let fallback = HTTPURLResponse.localizedString(forStatusCode: response.statusCode)
            throw WorkAPIError.server(status: response.statusCode, code: payload?.code,
                                      message: payload?.message ?? fallback)
        }
    }

    private func decode<Response: Decodable>(_ type: Response.Type, from data: Data) throws -> Response {
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw WorkAPIError.decoding(error.localizedDescription)
        }
    }

    private func encoded(_ pathComponent: String) -> String {
        pathComponent.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? pathComponent
    }
}

private struct APIErrorEnvelope: Decodable {
    let code: String?
    let message: String?

    private enum CodingKeys: String, CodingKey { case error }
    private struct Detail: Decodable { let code: String?; let message: String? }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let text = try? container.decode(String.self, forKey: .error) {
            code = nil
            message = text
        } else if let detail = try? container.decode(Detail.self, forKey: .error) {
            code = detail.code
            message = detail.message
        } else {
            code = nil
            message = nil
        }
    }
}

private struct CaptureRequest: Encodable {
    let text: String
    let kind: String
    let scopePath: String
    let projectPath: String?
}

private struct CreateTaskRequest: Encodable {
    let title: String
    let projectPath: String?
    let type: String
    let priority: String
    let dueAt: String?
}

private struct MoveTaskRequest: Encodable { let status: String; let note: String? }
private struct ChecklistRequest: Encodable { let section: String; let index: Int; let checked: Bool }
private struct TaskLogRequest: Encodable { let message: String }
private struct DecisionActionChoice: Encodable { let option: String?; let until: String? }
private struct DecisionActionRequest: Encodable { let action: String; let choice: DecisionActionChoice?; let note: String? }
private struct CreateIdeaRequest: Encodable { let title: String; let projectPath: String?; let scopePath: String; let opportunity: String }
private struct IdeaStatusRequest: Encodable { let status: String; let reason: String? }
private struct IdeaIntentRequest: Encodable { let agentIntent: String }
private struct CreateNoteRequest: Encodable {
    let title: String
    let text: String
    let scopePath: String
    let projectPath: String?
    let agentIntent: String
}
