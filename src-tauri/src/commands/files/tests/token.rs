use crate::commands::files::name_is_completable;

#[test]
fn name_is_completable_refuses_exactly_the_two_grammar_bytes() {
    // The charset table, pinned so the filter cannot quietly widen. The
    // MUTATION that proves this test is not decoration: adding `||
    // name.contains('\\')` to `name_is_completable` reddens the `\` case below
    // (and `completion_insert_never_contains_a_backslash`'s fixture does NOT,
    // which is why the table is asserted here rather than inferred from a walk).
    //
    // The admitted column is the point: a backslash, a `~`, a `:`, a tab, a
    // carriage return and non-UTF8-lossy names are all bytes the absolute token
    // charset carries, so refusing them here would be the visibility policy this
    // helper's doc comment refuses to be.
    for name in ["we?ird.md", "bad\nname.md", "?", "a?b", "a\nb"] {
        assert!(!name_is_completable(name), "{name:?} must be refused");
    }
    for name in [
        "normal.rs",
        ".env",
        "weird\\name.rs",
        "a file with spaces.md",
        "tab\there",
        "cr\rhere",
        "C:\\Users",
        "日本語.md",
        "",
    ] {
        assert!(name_is_completable(name), "{name:?} must be admitted");
    }
}
