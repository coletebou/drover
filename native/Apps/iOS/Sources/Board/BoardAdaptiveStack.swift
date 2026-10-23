import SwiftUI

/// HStack at normal text sizes, VStack at accessibility sizes. Shared by the Board and Sessions slices.
struct BoardAdaptiveStack<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var spacing: CGFloat = 6
    @ViewBuilder var content: () -> Content

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: spacing))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: spacing))
        layout { content() }
    }
}
