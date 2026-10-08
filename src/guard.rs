//! Source-scanning helpers for structural guard tests.
//!
//! A guard that enumerates what to check fails open on everything added after
//! it. A guard that *walks* fails closed: a new file is scanned by default and
//! an exemption has to be written down. `claude_desktop`'s note-sanitization
//! guard is built on this.
//!
//! Written by Augusto Claro for the encrypted-sync bundle format (#123) and
//! kept when that module was reverted, because the walking-guard idea outlived
//! the feature it was written for. The `production_code` comment below records
//! a real defect it was hardened against; the file names in it refer to that
//! now-removed module and are left as the history of the fix.

use std::path::{Path, PathBuf};

/// Every `.rs` file under `dir`, recursively.
pub(crate) fn rs_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(dir, &mut out);
    out
}

/// Every `.rs` file under `CARGO_MANIFEST_DIR`-relative `rel`.
///
/// Resolved from the manifest directory rather than from a relative path, so
/// a guard is independent of the working directory and survives the AUR
/// `srcdir` layout.
pub(crate) fn rs_files_in(rel: &str) -> Vec<PathBuf> {
    rs_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join(rel))
}

/// A file's production code: every line that is neither a comment nor part
/// of the file's own `#[cfg(test)]` module. A test that names a needle is a
/// test, not a violation, and prose that discusses one is neither.
///
/// **Comments are removed before the marker is looked for, and that is the
/// fix.** The previous shape split the raw source on the first *textual*
/// `#[cfg(test)]`. In `github/pairing.rs` the first occurrence is inside a
/// doc comment at line 76, so the scanned region ended at line 75 and the
/// 397 lines below it — five production functions — were invisible to every
/// guard built on this helper. Phase 5's audit put
/// `std::env::var("SYNC_PASSWORD")` in that region and watched the T-5-66
/// guard pass.
///
/// `github/mod.rs`'s own guard recorded this exact defect and worked around
/// it for itself; the lesson reached one call site and not the shared helper
/// every other guard depends on. A *smarter* marker search — line-anchored,
/// or `\n#[cfg(test)]\nmod tests` — keeps the same shape: a guard that stops
/// looking where it happens to find a string. Dropping comments first makes
/// the marker unambiguous by construction, because prose is no longer part
/// of the text being searched.
///
/// Returns an owned `String` rather than a borrowed slice, since the result
/// is no longer a contiguous piece of the input.
pub(crate) fn production_code(source: &str) -> String {
    source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .take_while(|line| !line.trim_start().starts_with("#[cfg(test)]"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every call of `opener` (a macro or method head ending in `(`, such as
/// `"println!("`) in `code`, as the text from the opener through its matching
/// `)`. A call left unclosed runs to the end of `code`.
///
/// Parentheses inside string and character literals are not counted: a message
/// like `"step 1) done"` must not end the call early and hide an argument
/// after it, and a stray `)` must not underflow the depth. Matching is
/// textual, so `"println!("` also finds the tail of `eprintln!(` — pass
/// `"println!("` and `"print!("` to cover all four macros without visiting one
/// twice.
pub(crate) fn calls<'a>(code: &'a str, opener: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(found) = code[from..].find(opener) {
        let start = from + found;
        let end = start + call_len(&code[start..]);
        out.push(&code[start..end]);
        from = end.max(start + 1);
    }
    out
}

/// Byte length of the balanced call at the start of `call`. Every byte the
/// scanner branches on is ASCII, so each slice boundary is a char boundary.
fn call_len(call: &str) -> usize {
    let bytes = call.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return i + 1;
                }
            }
            b'"' => i = string_end(bytes, i, None),
            b'r' => {
                if let Some(hashes) = raw_string_hashes(bytes, i) {
                    i = string_end(bytes, i + 1 + hashes, Some(hashes));
                }
            }
            b'\'' => {
                // `'('` and `'\''` are char literals; `'a` is a lifetime.
                if bytes.get(i + 1) == Some(&b'\\') {
                    i = bytes[i + 2..]
                        .iter()
                        .position(|&b| b == b'\'')
                        .map_or(bytes.len(), |n| i + 2 + n);
                } else if bytes.get(i + 2) == Some(&b'\'') {
                    i += 2;
                }
            }
            _ => {}
        }
        i += 1;
    }
    bytes.len()
}

/// Index of the last byte of the string whose opening quote is at `open`.
/// `raw` carries the `#` count of a raw string, which ignores escapes and
/// closes on a quote followed by that many hashes; `None` is an ordinary
/// string, which skips `\"`.
fn string_end(bytes: &[u8], open: usize, raw: Option<usize>) -> usize {
    let hashes = raw.unwrap_or(0);
    let mut i = open + 1;
    while i < bytes.len() {
        if raw.is_none() && bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == b'"' && bytes[i + 1..].iter().take(hashes).all(|&b| b == b'#') {
            return i + hashes;
        }
        i += 1;
    }
    bytes.len()
}

/// The `#` count of a raw string literal starting at `at` (`r"…"`, `r#"…"#`),
/// or `None` when `at` is just an `r` inside an identifier.
fn raw_string_hashes(bytes: &[u8], at: usize) -> Option<usize> {
    if at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_') {
        return None;
    }
    let hashes = bytes[at + 1..].iter().take_while(|&&b| b == b'#').count();
    (bytes.get(at + 1 + hashes) == Some(&b'"')).then_some(hashes)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("a readable source directory") {
        let path = entry.expect("a readable directory entry").path();
        if path.is_dir() {
            walk(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    /// One released section's entries must not reappear anywhere else.
    ///
    /// A PR branched before the last tag keeps its notes under `[Unreleased]`,
    /// and git merges them *cleanly* into whatever now occupies that position
    /// — which is the section that was just published. The repository has been
    /// bitten three times: twice by contributor branches, and once by a
    /// maintainer resolving a conflict with a script, which is what turned a
    /// documented manual check into this test.
    ///
    /// The manual check compares the newest section against its own tag and so
    /// needs git, which the AUR `check()` does not have. This needs only the
    /// file: an entry duplicated across two versions is the shape the accident
    /// takes, whichever direction it came from.
    #[test]
    fn no_changelog_entry_appears_under_two_versions() {
        let Some(changelog) = changelog() else { return };
        let mut seen: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        let mut version = "<before any version heading>";

        for line in changelog.lines() {
            if let Some(rest) = line.strip_prefix("## ") {
                version = rest.trim();
            } else if let Some(entry) = line.strip_prefix("- ") {
                let entry = entry.trim();
                // The first line of a bullet is its identity; continuation
                // lines are indented and never start a bullet.
                if entry.len() > 24 {
                    seen.entry(entry).or_default().push(version);
                }
            }
        }

        let duplicated: Vec<_> = seen
            .iter()
            .filter(|(_, versions)| {
                let mut distinct = versions.to_vec();
                distinct.sort_unstable();
                distinct.dedup();
                distinct.len() > 1
            })
            .map(|(entry, versions)| format!("{versions:?}: {}…", &entry[..40.min(entry.len())]))
            .collect();

        assert!(
            duplicated.is_empty(),
            "these entries appear under more than one version — an [Unreleased] \\
             note has merged into a released section:\n{}",
            duplicated.join("\n")
        );
    }

    /// Keep-A-Changelog allows one heading per category per release, and the
    /// release process reads those headings to pick the next version number. A
    /// second `### Fixed` in one section hides whatever is under it from that
    /// decision. Merging two branches that both add a category produces
    /// exactly this.
    #[test]
    fn no_changelog_section_repeats_a_category() {
        let Some(changelog) = changelog() else { return };
        let mut offenders = Vec::new();
        let mut version = "<before any version heading>";
        let mut categories: Vec<&str> = Vec::new();

        let mut flush = |version: &str, categories: &mut Vec<&str>| {
            let mut sorted = categories.clone();
            sorted.sort_unstable();
            let before = sorted.len();
            sorted.dedup();
            if sorted.len() != before {
                offenders.push(version.to_string());
            }
            categories.clear();
        };

        for line in changelog.lines() {
            if let Some(rest) = line.strip_prefix("## ") {
                flush(version, &mut categories);
                version = rest.trim();
            } else if let Some(rest) = line.strip_prefix("### ") {
                categories.push(rest.trim());
            }
        }
        flush(version, &mut categories);

        // Two released sections shipped this way. Their text is frozen — a
        // tag is immutable and the drift rule forbids editing a published
        // section — so they are named here rather than corrected. The point of
        // this guard is the next one, not the last two.
        const SHIPPED_THIS_WAY: [&str; 2] = ["[1.8.0] — 2026-08-28", "[0.14.0] — 2026-07-20"];
        offenders.retain(|version| !SHIPPED_THIS_WAY.contains(&version.as_str()));

        assert!(
            offenders.is_empty(),
            "these versions carry the same category heading twice, which hides \
             whatever is under the second one from the release's version \
             decision: {offenders:?}"
        );
    }

    /// The changelog, when this build has one.
    ///
    /// `nix/package.nix` filters the source down to what the binary needs, and
    /// `CHANGELOG.md` is not in it — correctly, since adding it would rebuild
    /// the package every time a release note changes. These guards protect the
    /// repository's changelog, so they have nothing to say in a build that
    /// ships without one and skip rather than fail.
    ///
    /// They still run everywhere it matters: a developer's `make test`, the
    /// Linux/macOS/Windows CI jobs, and the AUR `check()`, whose source is the
    /// release tarball and does include the file.
    fn changelog() -> Option<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("CHANGELOG.md");
        std::fs::read_to_string(&path).ok()
    }

    /// Every AUR source array must have a matching sha256sums array of the same
    /// length, both in PKGBUILDs and .SRCINFO files (#335).
    ///
    /// When sources and checksums drift (e.g. adding a detached .sig without a
    /// matching 'SKIP'), makepkg rejects the package.
    #[test]
    fn aur_checksum_arrays_match_source_arrays() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let aur_dir = root.join("packaging/aur");
        if !aur_dir.exists() {
            return;
        }

        for filename in ["PKGBUILD", "PKGBUILD-bin"] {
            let path = aur_dir.join(filename);
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let sources = count_pkgbuild_arrays(&content, "source");
            let checksums = count_pkgbuild_arrays(&content, "sha256sums");
            assert!(
                !sources.is_empty(),
                "{filename} must declare at least one source array"
            );
            for (src_var, src_len) in &sources {
                let suffix = src_var.strip_prefix("source").unwrap_or("");
                let sha_var = format!("sha256sums{suffix}");
                let sha_len = checksums.get(&sha_var).copied().unwrap_or(0);
                assert_eq!(
                    *src_len, sha_len,
                    "{filename}: {src_var} ({src_len} elements) and \
                     {sha_var} ({sha_len} elements) differ in length"
                );
            }
            for sha_var in checksums.keys() {
                let suffix = sha_var.strip_prefix("sha256sums").unwrap_or("");
                let src_var = format!("source{suffix}");
                assert!(
                    sources.contains_key(&src_var),
                    "{filename}: {sha_var} declared without corresponding {src_var}"
                );
            }
        }

        for filename in [".SRCINFO", ".SRCINFO-bin"] {
            let path = aur_dir.join(filename);
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let sources = count_srcinfo_lines(&content, "source");
            let checksums = count_srcinfo_lines(&content, "sha256sums");
            assert!(
                !sources.is_empty(),
                "{filename} must declare at least one source entry"
            );
            for (src_key, src_len) in &sources {
                let suffix = src_key.strip_prefix("source").unwrap_or("");
                let sha_key = format!("sha256sums{suffix}");
                let sha_len = checksums.get(&sha_key).copied().unwrap_or(0);
                assert_eq!(
                    *src_len, sha_len,
                    "{filename}: {src_key} ({src_len} lines) and \
                     {sha_key} ({sha_len} lines) differ in count"
                );
            }
            for sha_key in checksums.keys() {
                let suffix = sha_key.strip_prefix("sha256sums").unwrap_or("");
                let src_key = format!("source{suffix}");
                assert!(
                    sources.contains_key(&src_key),
                    "{filename}: {sha_key} declared without corresponding {src_key}"
                );
            }
        }
    }

    fn count_pkgbuild_arrays(content: &str, prefix: &str) -> BTreeMap<String, usize> {
        let mut results = BTreeMap::new();
        let mut in_array: Option<(String, usize)> = None;

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('#') {
                continue;
            }
            if let Some((name, count)) = in_array.as_mut() {
                let part = trimmed.split('#').next().unwrap_or("").trim();
                *count += count_quoted_items(part);
                if part.contains(')') {
                    results.insert(name.clone(), *count);
                    in_array = None;
                }
            } else if let Some((var_name, rest)) = trimmed.split_once("=(") {
                let var_name = var_name.trim();
                if var_name.starts_with(prefix) {
                    let part = rest.split('#').next().unwrap_or("").trim();
                    let count = count_quoted_items(part);
                    if part.contains(')') {
                        results.insert(var_name.to_string(), count);
                    } else {
                        in_array = Some((var_name.to_string(), count));
                    }
                }
            }
        }
        results
    }

    fn count_quoted_items(s: &str) -> usize {
        let mut count = 0;
        let mut in_single = false;
        let mut in_double = false;
        let mut in_word = false;

        for c in s.chars() {
            if in_single {
                if c == '\'' {
                    in_single = false;
                    count += 1;
                }
            } else if in_double {
                if c == '"' {
                    in_double = false;
                    count += 1;
                }
            } else if c == '\'' {
                in_single = true;
                in_word = false;
            } else if c == '"' {
                in_double = true;
                in_word = false;
            } else if c == '(' || c == ')' || c.is_whitespace() {
                if in_word {
                    count += 1;
                    in_word = false;
                }
            } else {
                in_word = true;
            }
        }
        if in_word {
            count += 1;
        }
        count
    }

    fn count_srcinfo_lines(content: &str, prefix: &str) -> BTreeMap<String, usize> {
        let mut counts = BTreeMap::new();
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some((key, _)) = trimmed.split_once('=') {
                let key = key.trim();
                if key.starts_with(prefix) {
                    *counts.entry(key.to_string()).or_insert(0) += 1;
                }
            }
        }
        counts
    }

    /// A `)` inside a message must not end the call early and hide the
    /// argument after it — the shape a scanner that counts every paren misses.
    #[test]
    fn calls_ignore_parens_inside_literals() {
        let code =
            r##"println!("step 1) {}", path.display()); other(); println!(r#"a ) "b" "#, x);"##;
        let found = super::calls(code, "println!(");
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found[0].ends_with("path.display())"), "{}", found[0]);
        assert!(found[1].ends_with("x)"), "{}", found[1]);
    }

    #[test]
    fn calls_handle_char_literals_lifetimes_and_escapes() {
        let code = r#"print!("{}", f(')', '"', "\"", &'a str)); tail()"#;
        let found = super::calls(code, "print!(");
        assert_eq!(found, [r#"print!("{}", f(')', '"', "\"", &'a str))"#]);
    }

    /// `"println!("` is a substring of `eprintln!(`; each call is still one
    /// hit, and an unbalanced tail neither panics nor loops.
    #[test]
    fn calls_visit_each_macro_once_and_survive_an_unclosed_call() {
        let code = "eprintln!(\"a\"); println!(\"b\"); println!(\"c\"";
        let found = super::calls(code, "println!(");
        assert_eq!(
            found,
            ["println!(\"a\")", "println!(\"b\")", "println!(\"c\""]
        );
    }
}
