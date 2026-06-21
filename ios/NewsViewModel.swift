// NewsViewModel.swift
// Замінює блок "// MARK: - ViewModel" у NewsView.swift

import SwiftUI

@MainActor
final class NewsViewModel: ObservableObject {
    @Published var articles:      [ProcessedNewsArticle] = []
    @Published var isLoadingFeed: Bool = false
    @Published var errorMessage:  String? = nil

    // processingIds залишаємо для сумісності з UI (скелетони більше не потрібні)
    @Published var processingIds: Set<UUID> = []

    private let serverService = NewsServerService()

    // Кеш сесії — щоб не перезавантажувати при перемиканні A1→A2→A1
    private var sessionCache: [NewsLevel: [ProcessedNewsArticle]] = [:]

    // rawArticles — для сумісності, більше не використовується
    var rawArticles: [NewsRSSArticle] = []

    // MARK: - Єдина точка входу

    func enterLevel(_ level: NewsLevel) async {
        // Якщо вже є в кеші сесії — показуємо миттєво без мережі
        if let cached = sessionCache[level], !cached.isEmpty {
            articles = cached
            return
        }
        await loadFromServer(level: level)
    }

    // MARK: - Завантаження з GitHub JSON

    func loadFromServer(level: NewsLevel) async {
        guard !isLoadingFeed else { return }
        isLoadingFeed = true
        errorMessage  = nil

        // Показуємо локальний кеш з диску поки йде запит
        let diskCached = NewsCacheService.shared.allArticles(level: level)
        if !diskCached.isEmpty {
            articles = diskCached
        }

        do {
            let serverArticles = try await serverService.fetchArticles(level: level)

            // Зберігаємо на диск для офлайн-режиму
            // Спочатку очищаємо старий кеш цього рівня
            NewsCacheService.shared.clearLevel(level: level)
            for article in serverArticles {
                NewsCacheService.shared.save(article, level: level)
            }

            articles = serverArticles
            sessionCache[level] = serverArticles

        } catch {
            if diskCached.isEmpty {
                errorMessage = "Не вдалося завантажити новини. Перевірте з'єднання."
            } else {
                sessionCache[level] = diskCached
            }
        }

        isLoadingFeed = false
    }

    // MARK: - Pull-to-refresh

    func refreshFeed(level: NewsLevel) async {
        sessionCache.removeValue(forKey: level)
        await loadFromServer(level: level)
    }

    // MARK: - Сумісність зі старим UI

    func markProcessed(_ level: NewsLevel) { }

    func triggerSimplification(level: NewsLevel) async { }
}
