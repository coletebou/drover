# Window 5: widgets (Widgets/)
WidgetKit extensions, one shared timeline provider reading the cached `native.summary` from the App Group
(refresh via `getTimeline` fetching `native.summary` with the widget token; 5 to 15 min policy). Families:
macOS (systemSmall/Medium/Large: counts + top waiting items), iOS home (small/medium/large),
iOS lock screen (accessoryCircular: waiting count gauge, accessoryRectangular: top waiting headline,
accessoryInline: "2 waiting"), watchOS complications (accessoryCorner/Circular/Rectangular/Inline), StandBy-friendly
small. AppIntent configuration: pick host filter. Deep links `drover://session/<id>` into the apps. Previews with
fixtures. Slices: provider+model, macOS+home views, lock screen+complications, intents+deep links.
