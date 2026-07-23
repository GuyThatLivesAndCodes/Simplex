import SwiftUI

/// The Simplex app hosts multiple SYSTEMS (Database, Habit, …), like the website's app
/// grid. This router tracks which one is active. The app always opens on Database,
/// regardless of what was used last — switching is an explicit choice via the top-left
/// switcher.
@MainActor
final class SystemRouter: ObservableObject {
    enum System: String, CaseIterable, Identifiable {
        case database, habit, neural
        var id: String { rawValue }

        var title: String {
            switch self {
            case .database: return "Database"
            case .habit:    return "Habit"
            case .neural:   return "Neural"
            }
        }
        var subtitle: String {
            switch self {
            case .database: return "Your encrypted vault"
            case .habit:    return "Small things, done daily"
            case .neural:   return "Train your own language model"
            }
        }
        var icon: String {
            switch self {
            case .database: return "folder.fill"
            case .habit:    return "checkmark.seal.fill"
            case .neural:   return "brain"
            }
        }
        /// The accent used on the switcher tile for this system.
        var tint: Color {
            switch self {
            case .database: return SimplexTheme.accent
            case .habit:    return HabitTheme.terracotta
            case .neural:   return SimplexTheme.accent
            }
        }
    }

    /// Always Database on launch (per the product decision) — not persisted.
    @Published var active: System = .database
    @Published var showSwitcher = false

    func switchTo(_ system: System) {
        active = system
        showSwitcher = false
    }
}
