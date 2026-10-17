use gooncave_core::{
    db::Database,
    http::{Frontend, Server},
};
use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    if !(3..=4).contains(&arguments.len()) {
        return Err("Usage: gooncave-core <data-directory> <library-directory> <frontend-dist-directory> [port]; port defaults to an available loopback port.".into());
    }
    let frontend = PathBuf::from(&arguments[2]);
    if !frontend.join("index.html").is_file() {
        return Err(
            "Build the frontend with npm --prefix frontend run build before starting the core."
                .into(),
        );
    }
    let frontend = frontend.canonicalize()?;
    let port = arguments
        .get(3)
        .map(|value| {
            value.parse::<u16>().map_err(|_| {
                "Port must be an integer from 0 through 65535. Use 0 to choose a local port."
            })
        })
        .transpose()?
        .unwrap_or(0);
    let database = Database::open(&PathBuf::from(&arguments[0]), &PathBuf::from(&arguments[1])).map_err(|error| format!("Cannot open the local library: {error}. Check free disk space and permissions of the data and library directories."))?;
    let server = Server::bind(database, port, Frontend::Directory(frontend)).await?;
    println!("GoonCave core: {}", server.origin);
    let (shutdown, receiver) = tokio::sync::oneshot::channel();
    let mut task = tokio::spawn(server.serve(receiver));
    tokio::select! {
        result = &mut task => { result??; }
        result = tokio::signal::ctrl_c() => {
            result?;
            let _ = shutdown.send(());
            task.await??;
        }
    }
    Ok(())
}
