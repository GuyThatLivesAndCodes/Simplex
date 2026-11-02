import SwiftUI

/// A lightweight confetti burst — colored pieces that fall and fade. Pure SwiftUI (no
/// dependencies). Drop it as an overlay; it animates once on appear.
struct ConfettiView: View {
    var pieceCount = 90
    var colors: [Color] = [
        .white, HabitTheme.terracotta, HabitTheme.terraSoft,
        Color(hex: 0xffd479), Color(hex: 0x8fbf9f), Color(hex: 0xe6a0c4),
    ]

    @State private var animate = false

    var body: some View {
        GeometryReader { geo in
            ZStack {
                ForEach(0..<pieceCount, id: \.self) { i in
                    ConfettiPiece(
                        color: colors[i % colors.count],
                        startX: CGFloat.random(in: 0...geo.size.width),
                        endX: CGFloat.random(in: 0...geo.size.width),
                        height: geo.size.height,
                        delay: Double.random(in: 0...0.5),
                        spin: Double.random(in: 1...3),
                        size: CGFloat.random(in: 6...11),
                        animate: animate
                    )
                }
            }
            .onAppear { animate = true }
            .allowsHitTesting(false)
        }
        .ignoresSafeArea()
    }
}

private struct ConfettiPiece: View {
    let color: Color
    let startX: CGFloat
    let endX: CGFloat
    let height: CGFloat
    let delay: Double
    let spin: Double
    let size: CGFloat
    let animate: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(color)
            .frame(width: size, height: size * 0.5)
            .rotationEffect(.degrees(animate ? 360 * spin : 0))
            .position(x: animate ? endX : startX, y: animate ? height + 40 : -40)
            .opacity(animate ? 0 : 1)
            .animation(.easeIn(duration: Double.random(in: 1.8...2.8)).delay(delay), value: animate)
    }
}
