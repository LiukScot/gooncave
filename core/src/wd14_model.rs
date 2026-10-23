use crate::{Error, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};

pub(crate) const REVISION: &str = "dbd4dbe553ee51feb3bc745b614fb762080e3912";
pub(crate) const REPOSITORY: &str = "SmilingWolf/wd-v1-4-convnextv2-tagger-v2";
pub(crate) const SIDE: u32 = 448;
pub(crate) const OUTPUTS: usize = 9083;
pub(crate) const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
pub(crate) const ARTIFACTS: [(&str, u64, &str); 2] = [
    (
        "model.onnx",
        388_479_878,
        "e91daa19cd9e8725125b7d70702d1560855fb687f8d8c4218eddaa821f41834a",
    ),
    (
        "selected_tags.csv",
        253_906,
        "8c8750600db36233a1b274ac88bd46289e588b338218c2e4c62bbc9f2b516368",
    ),
];

pub(crate) fn available() -> bool {
    #[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
    {
        std::is_x86_feature_detected!("avx2")
    }
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu")))]
    {
        false
    }
}

pub(crate) fn verify(path: &Path, size: u64, digest: &str) -> Result<()> {
    let mut file = std::fs::File::open(path)?;
    if file.metadata()?.len() != size {
        return Err(Error::Storage(
            "The WD14 download is incomplete. Enable tagging to download it again.".into(),
        ));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    let actual = hash
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if actual != digest {
        return Err(Error::Storage(
            "The WD14 download failed verification. Enable tagging to download it again.".into(),
        ));
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub(crate) struct Tag {
    pub name: String,
    pub category: &'static str,
    pub score: f32,
}

impl Tag {
    pub fn json(&self) -> Value {
        json!({"tag":self.name,"category":self.category,"score":self.score})
    }
}

fn vocabulary(path: &Path) -> Result<Vec<(String, &'static str)>> {
    let mut reader = csv::Reader::from_path(path)
        .map_err(|e| Error::Storage(format!("Cannot read the WD14 vocabulary: {e}")))?;
    let header = reader
        .headers()
        .map_err(|e| Error::Storage(e.to_string()))?;
    let column = |name: &str| {
        header.iter().position(|h| {
            h.trim_start_matches('\u{feff}')
                .trim()
                .eq_ignore_ascii_case(name)
        })
    };
    let name = column("name")
        .ok_or_else(|| Error::Storage("The WD14 vocabulary has no tag names.".into()))?;
    let category = column("category")
        .ok_or_else(|| Error::Storage("The WD14 vocabulary has no categories.".into()))?;
    let mut tags = Vec::new();
    for row in reader.records() {
        let row = row.map_err(|e| Error::Storage(format!("Invalid WD14 vocabulary: {e}")))?;
        let name = row
            .get(name)
            .filter(|s| !s.trim().is_empty() && s.len() <= 500)
            .ok_or_else(|| Error::Storage("The WD14 vocabulary contains an invalid tag.".into()))?;
        // Preserve the Python service's category mapping, including its treatment of ratings.
        let category = match row.get(category).and_then(|c| c.parse::<u8>().ok()) {
            Some(1) => "artist",
            Some(2) => "character",
            Some(3) => "copyright",
            Some(4) => "meta",
            _ => "general",
        };
        tags.push((name.trim().into(), category));
        if tags.len() > OUTPUTS {
            return Err(Error::Storage(
                "The WD14 vocabulary does not match its model.".into(),
            ));
        }
    }
    if tags.len() != OUTPUTS {
        return Err(Error::Storage(
            "The WD14 vocabulary does not match its model.".into(),
        ));
    }
    Ok(tags)
}

pub(crate) fn prepare(bytes: &[u8]) -> Result<Vec<f32>> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(Error::Invalid(
            "WD14 needs an image smaller than 25 MiB.".into(),
        ));
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| Error::Invalid(format!("Cannot identify this image for tagging: {e}")))?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|e| Error::Invalid(format!("Cannot read this image for tagging: {e}")))?
        .into_rgb8();
    // Pillow clips to 8-bit between horizontal and vertical passes; reversing them changes tags.
    let horizontal = image::imageops::resize(
        &image,
        SIDE,
        image.height(),
        image::imageops::FilterType::CatmullRom,
    );
    let resized = image::imageops::resize(
        &horizontal,
        SIDE,
        SIDE,
        image::imageops::FilterType::CatmullRom,
    );
    Ok(resized
        .as_raw()
        .chunks_exact(3)
        .flat_map(|p| [p[2] as f32, p[1] as f32, p[0] as f32])
        .collect())
}

fn select(vocabulary: &[(String, &'static str)], scores: &[f32]) -> Result<Vec<Tag>> {
    if scores.len() != vocabulary.len()
        || scores
            .iter()
            .any(|s| !s.is_finite() || !(0.0..=1.0).contains(s))
    {
        return Err(Error::Storage(
            "WD14 returned invalid scores. Existing tags were kept.".into(),
        ));
    }
    let mut tags = vocabulary
        .iter()
        .zip(scores)
        .filter_map(|((name, category), &score)| {
            (score >= if *category == "general" { 0.35 } else { 0.5 }).then(|| Tag {
                name: name.clone(),
                category,
                score,
            })
        })
        .collect::<Vec<_>>();
    tags.sort_by(|a, b| b.score.total_cmp(&a.score));
    Ok(tags)
}

#[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
pub(crate) struct Model {
    session: ort::session::Session,
    vocabulary: Vec<(String, &'static str)>,
}

#[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
fn install_runtime(directory: &Path) -> Result<std::path::PathBuf> {
    use std::io::Write;
    const LIBRARY: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/libonnxruntime.so.1.30.0"));
    const HASH: &str = "245a6f8c38127551057a1cd1ffd59f0a186a227ade4f3492dea2494eb565542e";
    let path = directory.join("libonnxruntime.so.1.30.0");
    if verify(&path, LIBRARY.len() as u64, HASH).is_err() {
        let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
        temporary.write_all(LIBRARY)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&path)
            .map_err(|e| Error::Storage(format!("Cannot unpack the bundled WD14 runtime: {e}")))?;
        verify(&path, LIBRARY.len() as u64, HASH)?;
    }
    for (name, bytes) in [
        (
            "onnxruntime-LICENSE",
            include_bytes!(concat!(env!("OUT_DIR"), "/onnxruntime-LICENSE")).as_slice(),
        ),
        (
            "onnxruntime-ThirdPartyNotices.txt",
            include_bytes!(concat!(
                env!("OUT_DIR"),
                "/onnxruntime-ThirdPartyNotices.txt"
            ))
            .as_slice(),
        ),
    ] {
        std::fs::write(directory.join(name), bytes)?;
    }
    Ok(path)
}

#[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
impl Model {
    pub fn load(directory: &Path) -> Result<Self> {
        if !available() {
            return Err(Error::Unavailable(
                "WD14 requires an AVX2-capable Linux computer.",
            ));
        }
        for (name, size, hash) in ARTIFACTS {
            verify(&directory.join(name), size, hash)?;
        }
        static ENVIRONMENT: std::sync::OnceLock<
            std::result::Result<ort::environment::Environment, String>,
        > = std::sync::OnceLock::new();
        let environment = ENVIRONMENT
            .get_or_init(|| {
                let library = install_runtime(directory).map_err(|e| e.to_string())?;
                ort::init_from(library)
                    .map_err(|e| e.to_string())?
                    .with_telemetry(false)
                    .build()
                    .map_err(|e| e.to_string())
            })
            .as_ref()
            .map_err(|e| Error::Storage(format!("Cannot start WD14: {e}")))?;
        let session = (|| -> ort::Result<ort::session::Session> {
            Ok(ort::session::Session::builder(environment)?
                .with_intra_threads(2)?
                .with_inter_threads(1)?
                .with_optimization_level(ort::session::builder::GraphOptimizationLevel::All)?
                // The planned buffers it keeps between images cost ~90 MB for no measurable speed.
                .with_memory_pattern(false)?
                .commit_from_file(directory.join("model.onnx"))?)
        })()
        .map_err(|e| Error::Storage(format!("Cannot load WD14: {e}")))?;
        Ok(Self {
            session,
            vocabulary: vocabulary(&directory.join("selected_tags.csv"))?,
        })
    }

    pub fn tag(&mut self, bytes: &[u8]) -> Result<Vec<Tag>> {
        let input =
            ort::value::Tensor::from_array(([1, SIDE as usize, SIDE as usize, 3], prepare(bytes)?))
                .map_err(|e| Error::Storage(format!("Cannot prepare WD14 input: {e}")))?;
        let outputs = self
            .session
            .run(ort::inputs![input])
            .map_err(|e| Error::Storage(format!("WD14 could not tag this image: {e}")))?;
        let (shape, scores) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| Error::Storage(format!("Cannot read WD14 scores: {e}")))?;
        if shape.as_ref() != [1, OUTPUTS as i64] {
            return Err(Error::Storage(
                "WD14 returned an unexpected result shape.".into(),
            ));
        }
        select(&self.vocabulary, scores)
    }
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu")))]
pub(crate) struct Model;
#[cfg(not(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu")))]
impl Model {
    pub fn load(_: &Path) -> Result<Self> {
        Err(Error::Unavailable("WD14 is currently available on AVX2-capable Linux computers. Phone model size is not decided yet."))
    }
    pub fn tag(&mut self, _: &[u8]) -> Result<Vec<Tag>> {
        Err(Error::Unavailable("WD14 is not available on this device."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_thresholds_and_stable_score_order() {
        let words = vec![
            ("low".into(), "general"),
            ("first".into(), "general"),
            ("second".into(), "meta"),
            ("excluded".into(), "artist"),
        ];
        let tags = select(&words, &[0.35, 0.5, 0.5, 0.499]).unwrap();
        assert_eq!(
            tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            ["first", "second", "low"]
        );
        assert!(select(&words, &[0.35, f32::NAN, 0.5, 0.49]).is_err());
        assert!(select(&words, &[0.35]).is_err());
    }

    #[test]
    fn prepares_rgb_as_bgr_and_rejects_invalid_media() {
        let image = image::RgbImage::from_pixel(3, 2, image::Rgb([10, 20, 30]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let input = prepare(bytes.get_ref()).unwrap();
        assert_eq!(input.len(), 448 * 448 * 3);
        assert!(input.chunks_exact(3).all(|p| p == [30.0, 20.0, 10.0]));
        assert!(prepare(b"not an image").is_err());
    }

    #[test]
    fn bicubic_pixels_match_pillow_references_with_only_rounding_differences() {
        for (source, reference) in [
            (
                include_bytes!("../tests/fixtures/wd14/solid.png").as_slice(),
                include_bytes!("../tests/fixtures/wd14/solid-pillow.png").as_slice(),
            ),
            (
                include_bytes!("../tests/fixtures/wd14/gradient.png").as_slice(),
                include_bytes!("../tests/fixtures/wd14/gradient-pillow.png").as_slice(),
            ),
            (
                include_bytes!("../tests/fixtures/wd14/pattern.png").as_slice(),
                include_bytes!("../tests/fixtures/wd14/pattern-pillow.png").as_slice(),
            ),
        ] {
            let expected = image::load_from_memory(reference).unwrap().to_rgb8();
            let actual = prepare(source).unwrap();
            for (actual, expected) in actual.chunks_exact(3).zip(expected.pixels()) {
                for (actual, expected) in actual.iter().zip([expected[2], expected[1], expected[0]])
                {
                    assert!(
                        (actual - expected as f32).abs() <= 1.0,
                        "Pillow pixel {expected}, native pixel {actual}"
                    );
                }
            }
        }
    }

    #[test]
    fn verifies_download_size_and_hash() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"fixture").unwrap();
        let hash = Sha256::digest(b"fixture")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        verify(file.path(), 7, &hash).unwrap();
        assert!(verify(file.path(), 8, &hash).is_err());
        assert!(verify(file.path(), 7, &"0".repeat(64)).is_err());
    }
}
