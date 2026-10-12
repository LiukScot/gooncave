use std::{env, fs, path::PathBuf};

fn main() {
    let directory =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../backend/src/db/migrations");
    println!("cargo:rerun-if-changed={}", directory.display());
    let mut files: Vec<_> = fs::read_dir(directory)
        .expect("read reference migrations")
        .map(|entry| entry.expect("read migration entry").path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "sql"))
        .collect();
    files.sort();
    let mut source = String::from("pub const MIGRATIONS: &[(&str, &str)] = &[\n");
    for path in files {
        source.push_str(&format!(
            "({:?}, include_str!({:?})),\n",
            path.file_name().unwrap().to_str().unwrap(),
            path
        ));
    }
    source.push_str("];\n");
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("migrations.rs"),
        source,
    )
    .expect("embed reference migrations");
}
