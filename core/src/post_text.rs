//! Post descriptions arrive in each site's own markup. The frontend renders one Markdown subset:
//! `**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `||spoiler||`, `[label](https://url)` and
//! `> quote` lines, nested with more `>`. Nothing a post contains reaches the page as HTML.

use regex::Regex;
use std::sync::LazyLock;

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("static pattern")
}

static QUOTE_TAG: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)\[(/?)quote\]"));
static EMPTY_SPOILER: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)\[spoiler\]\s*\[/spoiler\]"));
static SPOILER_TAG: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)\[/?spoiler\]"));
static HEADING: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?im)^h[1-6]\.\s*(.+)$"));
static LINK: LazyLock<Regex> =
    LazyLock::new(|| pattern(r#""([^"\n]+)":\[?((?:https?://|/)[^\s\[\]]+)\]?"#));
static WIKI_LABELLED: LazyLock<Regex> = LazyLock::new(|| pattern(r"\[\[[^\]|]+\|([^\]]+)\]\]"));
static WIKI: LazyLock<Regex> = LazyLock::new(|| pattern(r"\[\[([^\]]+)\]\]"));
static LEFTOVER_TAGS: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r"(?i)\[/?(?:sup|sub|code|table|thead|tbody|tr|td|th|section|color|tn|nodtext|expand)(?:[=,][^\]]*)?\]",
    )
});
static SPACES: LazyLock<Regex> = LazyLock::new(|| pattern(r"[ \t]+"));
static BLANK_RUNS: LazyLock<Regex> = LazyLock::new(|| pattern(r"\n{3,}"));

/// `[quote]` blocks as `>` lines, one more `>` for each level of nesting.
fn quotes(text: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    let mut previous_end = 0;
    let mut after_tag = false;
    let mut push_text = |out: &mut String, depth: usize, chunk: &str| {
        for (index, line) in chunk.split('\n').enumerate() {
            if index > 0 {
                out.push('\n');
            }
            if depth > 0 && (index > 0 || out.is_empty() || out.ends_with('\n')) {
                out.push_str(&">".repeat(depth));
                if !line.is_empty() {
                    out.push(' ');
                }
            }
            out.push_str(line);
        }
    };
    for tag in QUOTE_TAG.captures_iter(text) {
        let whole = tag.get(0).expect("whole match");
        let mut chunk = &text[previous_end..whole.start()];
        if after_tag {
            chunk = chunk.strip_prefix('\n').unwrap_or(chunk);
        }
        chunk = chunk.strip_suffix('\n').unwrap_or(chunk);
        push_text(&mut out, depth, chunk);
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        if tag[1].is_empty() {
            depth += 1;
        } else {
            depth = depth.saturating_sub(1);
        }
        previous_end = whole.end();
        after_tag = true;
    }
    let mut rest = &text[previous_end..];
    if after_tag {
        rest = rest.strip_prefix('\n').unwrap_or(rest);
    }
    push_text(&mut out, depth, rest);
    out
}

/// Trims every line and caps runs of blank lines at one. `None` when nothing is left.
fn tidy(text: &str) -> Option<String> {
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| SPACES.replace_all(line, " ").trim().to_owned())
        .collect();
    let joined = lines.join("\n");
    let tidy = BLANK_RUNS.replace_all(&joined, "\n\n");
    let tidy = tidy.trim();
    (!tidy.is_empty()).then(|| tidy.to_owned())
}

/// DText (e621) as the Markdown subset. Tags with no counterpart there are dropped and their text
/// kept; `base_url` turns site-relative links into absolute ones.
pub(crate) fn dtext_to_markdown(dtext: Option<&str>, base_url: &str) -> Option<String> {
    let base = base_url.trim_end_matches('/');
    let marks = [("b", "**"), ("i", "*"), ("u", "__"), ("s", "~~")];
    let mut text = dtext?.replace("\r\n", "\n").replace('\r', "\n");
    text = EMPTY_SPOILER.replace_all(&text, "").into_owned();
    for (tag, _) in marks {
        text = pattern(&format!(r"(?i)\[{tag}\]\s*\[/{tag}\]"))
            .replace_all(&text, "")
            .into_owned();
    }
    let text = LINK.replace_all(&text, |link: &regex::Captures| {
        let url = &link[2];
        let url = if url.starts_with('/') {
            format!("{base}{url}")
        } else {
            url.to_owned()
        };
        format!("[{}]({url})", link[1].replace(['[', ']'], ""))
    });
    let text = HEADING.replace_all(&text, "**$1**");
    let text = quotes(&text);
    let mut text = SPOILER_TAG.replace_all(&text, "||").into_owned();
    // Space inside the marks would stop them rendering, so it moves outside.
    for (tag, mark) in marks {
        text = pattern(&format!(r"(?i)\[{tag}\]\s+"))
            .replace_all(&text, format!("[{tag}]"))
            .into_owned();
        text = pattern(&format!(r"(?i)(\s+)\[/{tag}\]"))
            .replace_all(&text, format!("[/{tag}]$1"))
            .into_owned();
        text = pattern(&format!(r"(?i)\[/?{tag}\]"))
            .replace_all(&text, mark)
            .into_owned();
    }
    let text = WIKI_LABELLED.replace_all(&text, "$1");
    let text = WIKI.replace_all(&text, "$1");
    tidy(&LEFTOVER_TAGS.replace_all(&text, ""))
}

#[cfg(test)]
mod tests {
    use super::*;

    const E621: &str = "https://e621.net";
    fn convert(dtext: &str) -> Option<String> {
        dtext_to_markdown(Some(dtext), E621)
    }

    #[test]
    fn formatting_becomes_the_subset() {
        assert_eq!(
            convert("[b][u]Fenneko[/u][/b] and [i]friends[/i], [s]gone[/s]").unwrap(),
            "**__Fenneko__** and *friends*, ~~gone~~"
        );
    }

    #[test]
    fn a_quote_becomes_quoted_lines_and_nests() {
        assert_eq!(
            convert("before\n[quote]\nfirst\nsecond\n[/quote]\nafter").unwrap(),
            "before\n> first\n> second\nafter"
        );
        assert_eq!(
            convert("[quote]outer\n[quote]inner[/quote]\nback[/quote]").unwrap(),
            "> outer\n>> inner\n> back"
        );
    }

    #[test]
    fn a_spoiler_keeps_its_lines_and_an_empty_one_goes() {
        assert_eq!(
            convert("a [spoiler]hidden\nlines[/spoiler] b").unwrap(),
            "a ||hidden\nlines|| b"
        );
        assert_eq!(convert("  [spoiler][/spoiler] "), None);
        assert_eq!(dtext_to_markdown(None, E621), None);
    }

    #[test]
    fn links_headings_and_wiki_links_keep_their_words() {
        assert_eq!(
            convert(
                "\"(6+ Edits)\":https://www.patreon.com/someone and \"rules\":/wiki_pages/rules"
            )
            .unwrap(),
            "[(6+ Edits)](https://www.patreon.com/someone) and [rules](https://e621.net/wiki_pages/rules)"
        );
        assert_eq!(
            convert("h2. Notes\n[section,expanded=More]kept[/section] [[wolf|wolves]] [[fox]]")
                .unwrap(),
            "**Notes**\nkept wolves fox"
        );
    }

    #[test]
    fn a_real_description_reads_in_order() {
        assert_eq!(
            convert("h2.⚡| \"B4uL!\":/posts/1\n[i]\nThank you !\n[/i]\n\n[quote][b][/b]\nNew [b]projects[/b] [spoiler](NSFW)[/spoiler]\n[/quote]")
                .unwrap(),
            "**⚡| [B4uL!](https://e621.net/posts/1)**\n*Thank you !*\n\n> New **projects** ||(NSFW)||"
        );
    }
}
