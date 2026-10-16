//! iOS does not let an app start the `ffmpeg` and `ffprobe` programs the core uses on
//! desktop. A shell that cannot run them registers the platform's own decoder here; the
//! core then builds thumbnails, search images and hashes from the frames it returns.
use std::{path::Path, sync::OnceLock};

use image::{imageops::FilterType, DynamicImage, RgbImage};

use crate::{
    media::{self, MediaKind, Probe},
    Error, Result,
};

pub trait Decoder: Send + Sync {
    /// Width and height as displayed (after EXIF rotation or the video's track
    /// transform), and the duration of a video.
    fn probe(&self, path: &Path, kind: MediaKind) -> std::result::Result<Probe, String>;
    /// One frame as displayed, at `seek` seconds into a video, scaled down so its
    /// longer side is at most `max` pixels. A picture smaller than `max` keeps its size.
    fn frame(
        &self,
        path: &Path,
        kind: MediaKind,
        seek: Option<f64>,
        max: u32,
    ) -> std::result::Result<RgbImage, String>;
}

static DECODER: OnceLock<Box<dyn Decoder>> = OnceLock::new();

/// Registers the decoder once at startup; later calls are ignored.
pub fn register(decoder: Box<dyn Decoder>) {
    let _ = DECODER.set(decoder);
}

pub(crate) fn get() -> Option<&'static dyn Decoder> {
    DECODER.get().map(|decoder| decoder.as_ref())
}

/// Runs a decoder call off the async threads, bounded like an FFmpeg run. A call that
/// times out keeps its blocking thread until the framework returns: it cannot be cancelled.
pub(crate) async fn call<T: Send + 'static>(
    decoder: &'static dyn Decoder,
    work: impl FnOnce(&'static dyn Decoder) -> std::result::Result<T, String> + Send + 'static,
) -> Result<T> {
    let task = tokio::task::spawn_blocking(move || work(decoder));
    match tokio::time::timeout(media::TOOL_TIMEOUT, task).await {
        Ok(Ok(result)) => result.map_err(Error::Storage),
        Ok(Err(error)) => Err(Error::Storage(format!("media decoder stopped: {error}"))),
        Err(_) => Err(Error::Storage("media decoder timed out".into())),
    }
}

/// The grid thumbnail as JPEG: fitted in the box, or a strip cropped to its top.
pub(crate) fn thumbnail(
    decoder: &dyn Decoder,
    path: &Path,
    kind: MediaKind,
    probe: Probe,
    crop: bool,
) -> std::result::Result<Vec<u8>, String> {
    let (side, tallest) = (media::THUMB_BOX, media::thumb_tallest());
    let seek =
        (kind == MediaKind::Video && probe.duration_ms.is_some_and(|d| d > 1000)).then_some(1.0);
    let picture = if crop {
        // A strip's longer side is its height; ask for enough of it to fill the box's width.
        let (width, height) = (probe.width.unwrap_or(1), probe.height.unwrap_or(1));
        let max = (i64::from(side) * height / width.max(1)).clamp(1, 16_384) as u32;
        let frame = decoder.frame(path, kind, seek, max)?;
        let scaled = image::imageops::resize(
            &frame,
            side,
            (u64::from(side) * u64::from(frame.height()) / u64::from(frame.width().max(1)))
                .max(u64::from(tallest)) as u32,
            FilterType::Triangle,
        );
        image::imageops::crop_imm(&scaled, 0, 0, side, tallest).to_image()
    } else {
        decoder.frame(path, kind, seek, side)?
    };
    jpeg(&picture)
}

/// A still PNG of the displayed picture, its longer side at most `max` pixels.
pub(crate) fn png(
    decoder: &dyn Decoder,
    path: &Path,
    kind: MediaKind,
    seek: Option<f64>,
    max: u32,
) -> std::result::Result<Vec<u8>, String> {
    let frame = decoder.frame(path, kind, seek, max)?;
    let mut bytes = std::io::Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(frame)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|error| format!("cannot encode PNG: {error}"))?;
    Ok(bytes.into_inner())
}

/// `size`×`size` grayscale pixels of the whole picture, stretched like FFmpeg's `scale=size:size`.
pub(crate) fn gray(
    decoder: &dyn Decoder,
    path: &Path,
    kind: MediaKind,
    seek: Option<f64>,
    size: u32,
) -> std::result::Result<Vec<u8>, String> {
    // A frame a few times larger than the sample keeps the area average close to FFmpeg's.
    let frame = decoder.frame(path, kind, seek, size.saturating_mul(8).max(64))?;
    let gray = DynamicImage::ImageRgb8(frame).to_luma8();
    Ok(image::imageops::resize(&gray, size, size, FilterType::Triangle).into_raw())
}

fn jpeg(picture: &RgbImage) -> std::result::Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 80)
        .encode_image(picture)
        .map_err(|error| format!("cannot encode JPEG: {error}"))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A picture of `width`×`height` whose left half is black and right half white.
    struct Fake {
        width: u32,
        height: u32,
    }

    impl Decoder for Fake {
        fn probe(&self, _: &Path, _: MediaKind) -> std::result::Result<Probe, String> {
            Ok(Probe {
                width: Some(self.width.into()),
                height: Some(self.height.into()),
                duration_ms: None,
            })
        }
        fn frame(
            &self,
            _: &Path,
            _: MediaKind,
            _: Option<f64>,
            max: u32,
        ) -> std::result::Result<RgbImage, String> {
            let scale = (f64::from(max) / f64::from(self.width.max(self.height))).min(1.0);
            let width = ((f64::from(self.width) * scale).round() as u32).max(1);
            let height = ((f64::from(self.height) * scale).round() as u32).max(1);
            Ok(RgbImage::from_fn(width, height, |x, _| {
                if x < width / 2 {
                    image::Rgb([0, 0, 0])
                } else {
                    image::Rgb([255, 255, 255])
                }
            }))
        }
    }

    fn size(jpeg: &[u8]) -> (u32, u32) {
        let picture = image::load_from_memory(jpeg).unwrap();
        (picture.width(), picture.height())
    }

    #[test]
    fn thumbnails_fit_the_box_or_crop_a_strip_to_its_top() {
        let path = Path::new("x.jpg");
        let wide = Fake {
            width: 1600,
            height: 900,
        };
        let probe = wide.probe(path, MediaKind::Image).unwrap();
        assert_eq!(
            size(&thumbnail(&wide, path, MediaKind::Image, probe, false).unwrap()),
            (400, 225)
        );
        let strip = Fake {
            width: 300,
            height: 3000,
        };
        let probe = strip.probe(path, MediaKind::Image).unwrap();
        assert_eq!(
            size(&thumbnail(&strip, path, MediaKind::Image, probe, true).unwrap()),
            (400, 800)
        );
    }

    #[test]
    fn gray_samples_are_square_and_keep_left_and_right() {
        let wide = Fake {
            width: 1600,
            height: 900,
        };
        let pixels = gray(&wide, Path::new("x.jpg"), MediaKind::Image, None, 8).unwrap();
        assert_eq!(pixels.len(), 64);
        assert!(pixels[0] < 32 && pixels[7] > 224);
    }

    #[test]
    fn search_images_are_png_within_the_bound() {
        let wide = Fake {
            width: 1600,
            height: 900,
        };
        let bytes = png(&wide, Path::new("x.jpg"), MediaKind::Image, None, 512).unwrap();
        let picture = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).unwrap();
        assert_eq!((picture.width(), picture.height()), (512, 288));
    }
}
