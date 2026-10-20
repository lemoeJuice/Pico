# pico.rolling-context

Rolling Context keeps Canonical History intact and changes only the Model Input projection. A sealed turn is summarized independently. After each successful summary, tier review currently skips because Runtime cannot estimate complete net savings: Usage rates alone do not cover segment token savings, cache-prefix effects, expected future reuse, or summary/reviewer costs. Segments stay hot without a reviewer call. Manual `/compact` is the explicit fallback.

The host loads this package through the `pico.rolling-context` dynamic entry. Its UI is served in the plugin sandbox.
