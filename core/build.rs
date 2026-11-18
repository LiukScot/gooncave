use std::{env, fs, path::PathBuf};

fn main() {
    let directory = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("migrations");
    println!("cargo:rerun-if-changed={}", directory.display());
    let mut files: Vec<_> = fs::read_dir(directory)
        .expect("read migrations")
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
    .expect("embed migrations");
    if env::var("TARGET").as_deref() == Ok("x86_64-unknown-linux-gnu") {
        embed_runtime().expect("download and verify Microsoft's ONNX Runtime 1.30 package; check the network and retry cargo build");
    }
}

fn embed_runtime() -> Result<(), Box<dyn std::error::Error>> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    // Microsoft took the GitHub release down on 2026-11-17; the NuGet package ships the same library.
    const URL: &str =
        "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/1.30.0/microsoft.ml.onnxruntime.1.30.0.nupkg";
    const SIZE: u64 = 157_230_753;
    const HASH: &str = "30df119bd9164eaa187666d93147448fdd4a9a1a3caf83f1505daf7af2d1c5d2";
    const LIB_HASH: &str = "245a6f8c38127551057a1cd1ffd59f0a186a227ade4f3492dea2494eb565542e";
    let output = PathBuf::from(env::var("OUT_DIR")?);
    let library = output.join("libonnxruntime.so.1.30.0");
    if let Ok(bytes) = fs::read(&library) {
        let hash = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if hash == LIB_HASH
            && output.join("onnxruntime-LICENSE").is_file()
            && output.join("onnxruntime-ThirdPartyNotices.txt").is_file()
        {
            return Ok(());
        }
    }
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(1800)))
        .build();
    let bytes = ureq::Agent::new_with_config(config)
        .get(URL)
        .call()?
        .body_mut()
        .with_config()
        .limit(SIZE + 1)
        .read_to_vec()?;
    let hash = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if bytes.len() as u64 != SIZE || hash != HASH {
        return Err("ONNX Runtime package size or SHA-256 did not match the pinned release".into());
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    for (entry, filename) in [
        (
            "runtimes/linux-x64/native/libonnxruntime.so",
            "libonnxruntime.so.1.30.0",
        ),
        ("LICENSE", "onnxruntime-LICENSE"),
        ("ThirdPartyNotices.txt", "onnxruntime-ThirdPartyNotices.txt"),
    ] {
        let mut entry = archive.by_name(entry)?;
        if !entry.is_file() || entry.size() > 32 * 1024 * 1024 {
            return Err("invalid ONNX Runtime package entry".into());
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        if filename == "libonnxruntime.so.1.30.0" {
            let hash = Sha256::digest(&bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            if hash != LIB_HASH {
                return Err("ONNX Runtime library SHA-256 did not match the pinned release".into());
            }
        }
        fs::write(output.join(filename), bytes)?;
    }
    Ok(())
}
