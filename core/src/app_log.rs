//! The log a person reads and sends from Settings → Report issue. An iPhone has no terminal, so
//! every `eprintln!` of the app also lands here, in two files of bounded size in the data folder.
//! Lines are cleaned before they reach the disk: see [`clean`].

use std::{
    borrow::Cow,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, LazyLock, Mutex, OnceLock, PoisonError},
    time::Duration,
};

use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use regex::{Captures, Regex};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::Database;

const FILE: &str = "app.log";
const OLDER_FILE: &str = "app.log.1";
const MAX_FILE_BYTES: u64 = 128 * 1024;
const MAX_LINE_CHARS: usize = 500;
const MAX_REPORT_LINES: usize = 200;
// A report matters most when the app hangs, so a busy database must not hold it back.
const DATABASE_WAIT: Duration = Duration::from_secs(2);

static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static WRITING: Mutex<Repeats> = Mutex::new(Repeats {
    last: String::new(),
    count: 0,
});

/// How many times in a row the last line came again. One failing job or one page of failing
/// images repeats a line, which would push older lines out of the report.
struct Repeats {
    last: String,
    count: u32,
}

static RULES: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
    [
        (r"(?i)\b(authorization|cookie)\b\s*[=:].*", "$1=<hidden>"),
        (
            r"(?i)\b(api[_-]?key|token|password|passwd|pass|pass_hash|login|username|user_id|secret|session)\b\s*[=:]\s*\S+",
            "$1=<hidden>",
        ),
        (r"(?i)\b[a-z][a-z0-9+.-]*://\S+", "<address>"),
        (r"\S+@\S+\.\S+", "<address>"),
        (r#""[^"]*""#, "<text>"),
        (r#"(^|[\s(=\[:,'])(?:~|[A-Za-z]:)?[/\\]\S[^:"]*"#, "$1<path>"),
        (r"\S*[/\\]\S+", "<path>"),
        (r"\b[A-Za-z0-9_-]{32,}\b", "<id>"),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(pattern).expect("valid pattern"), replacement))
    .collect()
});
static DOTTED_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+\b").expect("valid"));
static DECIMAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+\.\d+$").expect("valid"));

/// Removes what a report must not carry unasked: addresses, file names and paths, quoted text
/// such as tags and titles, secrets and file hashes. It works on patterns, so a tag written bare
/// in a sentence stays; the Report issue page shows the text before anything leaves the device.
fn clean(message: &str) -> String {
    let mut line = message.replace(['\r', '\n'], " ");
    for (rule, replacement) in RULES.iter() {
        if let Cow::Owned(replaced) = rule.replace_all(&line, *replacement) {
            line = replaced;
        }
    }
    DOTTED_NAME
        .replace_all(&line, |name: &Captures| {
            if DECIMAL.is_match(&name[0]) {
                name[0].to_owned()
            } else {
                "<name>".to_owned()
            }
        })
        .chars()
        .take(MAX_LINE_CHARS)
        .collect()
}

fn version() -> &'static str {
    // Release builds receive it from the release workflow; see docs/versioning.md.
    option_env!("GOONCAVE_VERSION").unwrap_or("development")
}

fn commit() -> &'static str {
    let commit = option_env!("GOONCAVE_COMMIT").unwrap_or("unknown");
    commit.get(..7).unwrap_or(commit)
}

fn platform() -> String {
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

/// Sets where the log lives, marks the start of this run and adds crashes to the log. The first
/// call of a process wins; lines from before it stay on stderr only.
pub fn start(data_directory: &Path) {
    let mut first = false;
    DIRECTORY.get_or_init(|| {
        first = true;
        data_directory.to_owned()
    });
    if first {
        log_crashes();
        write_line(&format!(
            "GoonCave {} ({}) started on {}",
            version(),
            commit(),
            platform()
        ));
    }
}

/// A panic prints to stderr without passing through `eprintln!`. The hook keeps the source file
/// name and line, which come from the build and describe no one's library.
fn log_crashes() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        let payload = panic.payload();
        let message = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("no message");
        let place = panic
            .location()
            .map_or("unknown place".to_owned(), |place| {
                let file = Path::new(place.file()).file_name();
                format!("{}:{}", file.unwrap_or_default().display(), place.line())
            });
        write_line(&format!("Crash at {place}: {}", clean(message)));
        previous(panic);
    }));
}

pub fn record(message: &str) {
    write_line(&clean(message));
}

fn timestamp() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%d %H:%M:%S UTC")
        .to_string()
}

fn repeat_note(count: u32) -> String {
    format!("{} The line above came {count} more times", timestamp())
}

fn write_line(text: &str) {
    let Some(directory) = DIRECTORY.get() else {
        return;
    };
    let written = write_unless_repeated(
        directory,
        &mut WRITING.lock().unwrap_or_else(PoisonError::into_inner),
        text,
    );
    // Outside the lock: a broken stderr panics here, and the panic hook writes to the log.
    if let Err(error) = written {
        std::eprintln!("Cannot write the app log: {error}");
    }
}

fn write_unless_repeated(directory: &Path, repeats: &mut Repeats, text: &str) -> io::Result<()> {
    if repeats.last == text {
        repeats.count += 1;
        return Ok(());
    }
    let mut lines = String::new();
    if repeats.count > 0 {
        lines = format!("{}\n", repeat_note(repeats.count));
    }
    lines.push_str(&format!("{} {text}\n", timestamp()));
    repeats.last = text.to_owned();
    repeats.count = 0;
    append(directory, &lines)
}

fn append(directory: &Path, line: &str) -> io::Result<()> {
    let path = directory.join(FILE);
    match fs::metadata(&path) {
        Ok(file) if file.len() + line.len() as u64 > MAX_FILE_BYTES => {
            fs::rename(&path, directory.join(OLDER_FILE))?;
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(line.as_bytes())
}

/// The newest lines, oldest first.
fn latest(directory: &Path) -> io::Result<String> {
    let mut text = String::new();
    for name in [OLDER_FILE, FILE] {
        match fs::read(directory.join(name)) {
            Ok(bytes) => text.push_str(&String::from_utf8_lossy(&bytes)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    let lines: Vec<_> = text.lines().collect();
    Ok(lines[lines.len().saturating_sub(MAX_REPORT_LINES)..].join("\n"))
}

/// What the report shows as the log: repeats not written yet count too, and a log that cannot be
/// read says so without costing the rest of the report.
fn report_log(directory: &Path) -> String {
    let repeats = WRITING.lock().unwrap_or_else(PoisonError::into_inner);
    match latest(directory) {
        Ok(log) if repeats.count > 0 => format!("{log}\n{}", repeat_note(repeats.count)),
        Ok(log) => log,
        Err(error) => format!("The log could not be read: {}", clean(&error.to_string())),
    }
}

pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/report", get(report))
        .route("/report/window-error", post(window_error))
}

fn word(value: &Value) -> String {
    clean(value.as_str().unwrap_or("idle"))
}

/// One line per background job: states and counts only. Their messages can name sites and files,
/// so they stay out.
async fn jobs(db: &Database) -> Vec<String> {
    let sync = db.sync.snapshot();
    let originals = db
        .originals
        .status
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let favorites = db
        .favorites
        .state()
        .map_or("unreadable".to_owned(), |state| word(&state["status"]));
    let scanning = db.scan.running.load(Ordering::Relaxed);
    let mut lines = vec![
        format!("Folder scan: {}", if scanning { "running" } else { "idle" }),
        format!(
            "Device sync: {}{}",
            word(&sync["state"]),
            if sync["error"].is_string() {
                ", last run failed"
            } else {
                ""
            }
        ),
        format!("Favorites sync: {favorites}"),
        format!(
            "Matching images scan: {}",
            word(&db.duplicates.snapshot()["status"])
        ),
        format!(
            "Originals: {}, {} of {}",
            word(&originals["state"]),
            originals["done"].as_u64().unwrap_or(0),
            originals["total"].as_u64().unwrap_or(0)
        ),
    ];
    let counts = async {
        tokio::try_join!(
            crate::files::progress(State(db.clone())),
            crate::wd14::status(State(db.clone()))
        )
    };
    match tokio::time::timeout(DATABASE_WAIT, counts).await {
        Ok(Ok((Json(library), Json(tagging)))) => {
            lines.push(format!("Files waiting for details: {}", library["waiting"]));
            lines.push(format!(
                "Automatic tagging: {}, {}, {} of {}",
                if tagging["enabled"] == true {
                    "on"
                } else {
                    "off"
                },
                word(&tagging["state"]),
                tagging["completed"],
                tagging["total"]
            ));
        }
        Ok(Err(error)) => lines.push(format!(
            "Database: unreadable, {}",
            clean(&error.to_string())
        )),
        Err(_) => lines.push(format!(
            "Database: busy for more than {} seconds",
            DATABASE_WAIT.as_secs()
        )),
    }
    lines
}

async fn report(State(db): State<Database>) -> Json<Value> {
    let log = match DIRECTORY.get().cloned() {
        Some(directory) => tokio::task::spawn_blocking(move || report_log(&directory))
            .await
            .unwrap_or_else(|error| format!("The log could not be read: {error}")),
        None => String::new(),
    };
    let schema = crate::db::MIGRATIONS
        .last()
        .map_or("none", |(name, _)| name.trim_end_matches(".sql"));
    Json(json!({
        "version": version(),
        "commit": commit(),
        "platform": platform(),
        "schema": schema,
        "jobs": jobs(&db).await,
        "log": log,
    }))
}

#[derive(Deserialize)]
struct WindowError {
    message: String,
}

async fn window_error(Json(error): Json<WindowError>) {
    record(&format!("Window error: {}", error.message));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_removes_what_a_report_must_not_carry() {
        for (message, secret) in [
            (
                "WebDAV answered 500 for https://me:pw@cloud.example/dav/a",
                "cloud.example",
            ),
            (
                "Cannot delete /home/ann/My Pics/a b.jpg: No such file",
                "My Pics",
            ),
            ("Cannot delete C:\\Users\\ann\\a.png: denied", "Users"),
            ("Cannot read Pics/holiday: denied", "holiday"),
            ("Saved holiday.png was refused", "holiday"),
            ("Host cloud.example answered 502", "cloud.example"),
            ("Tag \"blue_sky\" is unknown", "blue_sky"),
            ("api_key=abc123 refused", "abc123"),
            ("Cookie: a=b; sid=topsecret refused", "topsecret"),
            ("Authorization: Bearer topsecret", "topsecret"),
            ("Asked with login=ann refused", "ann"),
            ("Cannot read:/home/ann/secret words/a.jpg", "secret"),
            ("Cannot read '/home/ann/secret words/a.jpg'", "secret"),
            ("Mail ann@mail.example refused", "ann"),
            (
                "Cannot fetch 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                "9f86d081",
            ),
        ] {
            assert!(
                !clean(message).contains(secret),
                "{message} → {}",
                clean(message)
            );
        }
    }

    #[test]
    fn clean_keeps_what_explains_the_problem() {
        assert_eq!(
            clean("Automatic danbooru search: answered 502 after 1.5 s, 3 tries"),
            "Automatic danbooru search: answered 502 after 1.5 s, 3 tries"
        );
        assert_eq!(clean("one\ntwo"), "one two");
        assert_eq!(clean(&"x ".repeat(1000)).chars().count(), MAX_LINE_CHARS);
    }

    #[test]
    fn the_log_stays_bounded_and_keeps_the_newest_lines() {
        let directory = tempfile::tempdir().unwrap();
        let line = format!("{}\n", "x".repeat(99));
        for _ in 0..3 * MAX_FILE_BYTES / 100 {
            append(directory.path(), &line).unwrap();
        }
        append(directory.path(), "newest\n").unwrap();
        for name in [FILE, OLDER_FILE] {
            assert!(fs::metadata(directory.path().join(name)).unwrap().len() <= MAX_FILE_BYTES);
        }
        let log = latest(directory.path()).unwrap();
        assert_eq!(log.lines().count(), MAX_REPORT_LINES);
        assert_eq!(log.lines().last(), Some("newest"));
    }

    #[test]
    fn a_repeated_line_is_written_once_with_a_count() {
        let directory = tempfile::tempdir().unwrap();
        let mut repeats = Repeats {
            last: String::new(),
            count: 0,
        };
        for text in ["same", "same", "same", "other"] {
            write_unless_repeated(directory.path(), &mut repeats, text).unwrap();
        }
        let log = latest(directory.path()).unwrap();
        let lines: Vec<_> = log.lines().collect();
        assert_eq!(lines.len(), 3, "{log}");
        assert!(lines[0].ends_with(" UTC same"), "{log}");
        assert!(lines[1].ends_with("came 2 more times"), "{log}");
        assert!(lines[2].ends_with(" UTC other"), "{log}");
    }

    #[test]
    fn an_unreadable_log_says_so_in_the_report() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join(FILE)).unwrap();
        assert!(report_log(directory.path()).starts_with("The log could not be read: "));
    }

    #[test]
    fn a_missing_log_reads_as_empty() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(latest(directory.path()).unwrap(), "");
    }
}
