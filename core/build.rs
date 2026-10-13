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
    if env::var("TARGET").as_deref() == Ok("x86_64-unknown-linux-gnu") {
        embed_runtime().expect("download and verify Microsoft's ONNX Runtime 1.30 SDK; check the network and retry cargo build");
    }
}

fn embed_runtime() -> Result<(), Box<dyn std::error::Error>> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    const URL: &str = "https://github.com/microsoft/onnxruntime/releases/download/v1.30.0/onnxruntime-linux-x64-1.30.0.tgz";
    const SIZE: u64 = 11_306_877;
    const HASH: &str = "a5ed5a3cac51fbb2e90da632ae43d19212faaa20e76484e62bcb7c23ddb3b3fd";
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
        .timeout_global(Some(std::time::Duration::from_secs(120)))
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
        return Err("ONNX Runtime SDK size or SHA-256 did not match the pinned release".into());
    }
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes.as_slice()));
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;
        let filename = match path.to_str() {
            Some("onnxruntime-linux-x64-1.30.0/lib/libonnxruntime.so.1.30.0") => {
                "libonnxruntime.so.1.30.0"
            }
            Some("onnxruntime-linux-x64-1.30.0/LICENSE") => "onnxruntime-LICENSE",
            Some("onnxruntime-linux-x64-1.30.0/ThirdPartyNotices.txt") => {
                "onnxruntime-ThirdPartyNotices.txt"
            }
            _ => continue,
        };
        if !entry.header().entry_type().is_file() || entry.size() > 32 * 1024 * 1024 {
            return Err("invalid ONNX Runtime SDK entry".into());
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
    for name in [
        "libonnxruntime.so.1.30.0",
        "onnxruntime-LICENSE",
        "onnxruntime-ThirdPartyNotices.txt",
    ] {
        if !output.join(name).is_file() {
            return Err(format!("ONNX Runtime SDK did not contain {name}").into());
        }
    }
    Ok(())
}
