use std::{sync::Arc, time::Duration};

use gooncave_core::{
    db::Database,
    http::{Frontend, Server},
};
use serde_json::Value;
use tokio::sync::oneshot;

struct Running {
    address: String,
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

async fn serve(database: Database) -> Running {
    let server = Server::bind(database, 0, Frontend::Embedded(Arc::new(|_| None)))
        .await
        .unwrap();
    let address = format!("{}/report", server.origin);
    let (stop, stopped) = oneshot::channel();
    let task = tokio::spawn(server.serve(stopped));
    Running {
        address,
        stop,
        task,
    }
}

async fn report(address: &str) -> Value {
    reqwest::get(address).await.unwrap().json().await.unwrap()
}

#[tokio::test]
async fn the_report_lists_background_work() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(directory.path(), &directory.path().join("library")).unwrap();
    let running = serve(database).await;
    let jobs = report(&running.address).await["jobs"].to_string();
    for line in [
        "Folder scan: ",
        "Favorites sync: idle",
        "Files waiting for details: 0",
        "Automatic tagging: ",
    ] {
        assert!(jobs.contains(line), "{line} is missing from {jobs}");
    }
    running.stop.send(()).unwrap();
    running.task.await.unwrap().unwrap();
}

#[tokio::test]
async fn the_report_still_answers_while_the_database_is_busy() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(directory.path(), &directory.path().join("library")).unwrap();
    let busy = database.clone();
    let running = serve(database).await;
    let (held, holding) = oneshot::channel();
    let holder = tokio::spawn(async move {
        busy.call(move |_| {
            held.send(()).unwrap();
            std::thread::sleep(Duration::from_secs(4));
            Ok(())
        })
        .await
    });
    holding.await.unwrap();

    let started = std::time::Instant::now();
    let answer = report(&running.address).await;
    assert!(started.elapsed() < Duration::from_secs(4));
    let jobs = answer["jobs"].to_string();
    assert!(jobs.contains("Database: busy"), "{jobs}");
    assert!(jobs.contains("Favorites sync: idle"), "{jobs}");

    holder.await.unwrap().unwrap();
    running.stop.send(()).unwrap();
    running.task.await.unwrap().unwrap();
}
