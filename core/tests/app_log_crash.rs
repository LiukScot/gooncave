//! Alone in its file: the log folder is set once per process, and every test here shares one.
use std::fs;

use gooncave_core::app_log;

#[test]
fn the_log_marks_the_start_and_records_a_crash_without_private_details() {
    let directory = tempfile::tempdir().unwrap();
    app_log::start(directory.path());

    std::thread::spawn(|| panic!("cannot read /home/ann/holiday.png"))
        .join()
        .unwrap_err();

    let log = fs::read_to_string(directory.path().join("app.log")).unwrap();
    assert!(log.contains(") started on "), "{log}");
    assert!(log.contains("Crash at app_log_crash.rs:"), "{log}");
    assert!(log.contains("cannot read <path>"), "{log}");
    assert!(!log.contains("holiday"), "{log}");
}
