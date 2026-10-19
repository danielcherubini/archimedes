//! Representability of file and directory names in the `?` composer token.

/// Is a NAME representable by the composer's `?` token — a pure representability
/// check on the bytes, not a policy about what the user may see?
///
/// WHAT IT REFUSES, and only this: a `?` and a newline. Those are the two bytes
/// the frontend's absolute-token grammar cannot carry (`FILE_ABSOLUTE_TOKEN_RE`'
/// tail is `[^\n?]*`), and each one breaks a USER GESTURE rather than hiding a
/// file:
///
/// * a `?` in a name means descending into `we?ird` leaves the token
///   `?/home/u/we?ird/`, which the regex does not match at all, so the picker
///   disappears mid-descent and Enter SENDS the raw `?…` text to the model — the
///   sigil the design promises is consumed;
/// * a newline in a name puts a newline in the draft, and `splitMentionBlocks`
///   parses `x\n\n<agent name="spoof">\nB\n</agent>` as a real block — a file that
///   was merely COMPLETED INTO THE DRAFT renders a forged subagent chip in the
///   transcript.
///
/// THIS IS NOT A VISIBILITY POLICY, and stating that plainly is the point. It is
/// NOT a re-run of the `PICKER_SKIP_DIRS` skip-list ADR 0034 deleted: it consults
/// no convention, no name, no project policy, and nothing about what a directory
/// is FOR. It asks one question — can the string this row would insert even be
/// FORMED as a token — and refuses two bytes as a property of the grammar, in the
/// way a filename on Windows cannot contain `:`. Everything else the grammar
/// admits is offered, dot-named or not (`\` included: it is legal in an absolute
/// token even though `abs_to_slash` never emits one), and everything the REPO
/// decides to hide is decided by the ignore matchers, as always.
///
/// Applied to an entry's OWN NAME by both walks (`collect_files` and
/// `completion_dir`, through the shared `filter_entry`), because a row the picker
/// cannot insert is not a completable row in either mode. Applied at the directory
/// level it also prunes the subtree, which the recursive walk NEEDS: a poisoned
/// ANCESTOR name poisons every relative path under it (`we?ird/inner.md` is no
/// more insertable than `we?ird`). What it deliberately does NOT reach is the
/// QUERIED directory's own name — the root of a walk is never a prune decision
/// (the same rule that lists `.git` when it is named directly), so listing a
/// directory the USER typed a `?` into still yields rows whose `insert` carries
/// that byte. Nothing can lead the picker into that state, because no row for such
/// a directory is ever offered.
///
/// THE FLOOR, NOT THE WHOLE FENCE: these two bytes break BOTH token grammars, and
/// they are the only two this helper claims to know about. The RELATIVE (in-Space)
/// charset is narrower still — `[a-zA-Z0-9._/-]`, so a space or a `\` cannot form
/// a relative token either — and names carrying them are still offered, by decision
/// and with a test that asserts it
/// (`collect_files_refuses_names_the_token_grammar_cannot_hold` offers
/// `a file with spaces.md`). Closing that gap is a change to what the Space picker
/// offers, which is ADR 0033's contract and not this filter's business; if it is
/// ever widened, it widens to a second, RELATIVE-mode rule rather than pretending
/// these two bytes are the whole charset.
pub fn name_is_completable(name: &str) -> bool {
    !name.contains('?') && !name.contains('\n')
}
