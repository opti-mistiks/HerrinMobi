import Foundation

// MARK: - Модель відповіді

private struct GitHubArticlesDB: Decodable {
    let A1: [ProcessedNewsArticle]
    let A2: [ProcessedNewsArticle]
    let B1: [ProcessedNewsArticle]
    let updatedAt: String?
}

// MARK: - NewsServerService

final class NewsServerService: Sendable {

    // ← Заміни на свій GitHub username і назву репозиторію
    private static let rawURL = "https://raw.githubusercontent.com/ТВІ_ЮЗЕРНЕЙМ/worts-news/main/data/articles.json"

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    // MARK: - Завантаження статей

    func fetchArticles(level: NewsLevel) async throws -> [ProcessedNewsArticle] {
        guard let url = URL(string: Self.rawURL) else {
            throw NewsServerError.invalidURL
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        // Не кешуємо — хочемо завжди свіжий JSON
        request.cachePolicy = .reloadIgnoringLocalCacheData

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw NewsServerError.badStatus
        }

        let db = try Self.decoder.decode(GitHubArticlesDB.self, from: data)

        switch level {
        case .a1: return db.A1
        case .a2: return db.A2
        case .b1: return db.B1
        }
    }

    // MARK: - Перевірка перекладу (залишається через Groq напряму)
    // checkTranslation залишаємо як є у GroqNewsService — це разовий запит,
    // не потребує сервера, і не несе жодного ризику (ключ вводить користувач).
    //
    // Якщо хочеш прибрати потребу в ключі користувача — потрібен окремий сервер.
}

// MARK: - Errors

enum NewsServerError: LocalizedError {
    case invalidURL
    case badStatus

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Невірна адреса сервера"
        case .badStatus:  return "Не вдалося завантажити новини"
        }
    }
}
