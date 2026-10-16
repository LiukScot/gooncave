//! The iPhone's own decoders for the core, which cannot start FFmpeg there: ImageIO for
//! pictures and AVFoundation for videos.
use std::path::Path;

use gooncave_core::{
    decoder::Decoder,
    media::{MediaKind, Probe},
};
use image::RgbImage;
use objc2::rc::Retained;
use objc2_av_foundation::{AVAsset, AVAssetImageGenerator, AVMediaTypeVideo};
use objc2_core_foundation::{
    CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect, CGSize, CFURL,
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
    CGSizeApplyAffineTransform,
};
use objc2_core_media::CMTime;
use objc2_foundation::{NSString, NSURL};
use objc2_image_io::{
    kCGImagePropertyOrientation, kCGImagePropertyPixelHeight, kCGImagePropertyPixelWidth,
    kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform,
    kCGImageSourceThumbnailMaxPixelSize, CGImageSource,
};

const NO_PICTURE: &str = "no picture in media file";

pub struct Native;

impl Decoder for Native {
    fn probe(&self, path: &Path, kind: MediaKind) -> Result<Probe, String> {
        match kind {
            MediaKind::Image => image_probe(path),
            MediaKind::Video => video_probe(path),
        }
    }

    fn frame(
        &self,
        path: &Path,
        kind: MediaKind,
        seek: Option<f64>,
        max: u32,
    ) -> Result<RgbImage, String> {
        match kind {
            MediaKind::Image => pixels(&*image_frame(path, max)?),
            MediaKind::Video => video_frame(path, seek, max),
        }
    }
}

fn image_source(path: &Path) -> Result<CFRetained<CGImageSource>, String> {
    let url = CFURL::from_file_path(path).ok_or("invalid file path")?;
    // SAFETY: no options are passed.
    unsafe { CGImageSource::with_url(&url, None) }.ok_or_else(|| "cannot open the picture".into())
}

fn image_probe(path: &Path) -> Result<Probe, String> {
    let source = image_source(path)?;
    // SAFETY: no options are passed.
    let properties = unsafe { source.properties_at_index(0, None) }.ok_or(NO_PICTURE)?;
    // SAFETY: ImageIO property dictionaries are keyed by CFString.
    let properties: CFRetained<CFDictionary<CFString, CFType>> =
        unsafe { CFRetained::cast_unchecked(properties) };
    let number = |key: &CFString| {
        properties
            .get(key)
            .and_then(|value| value.downcast::<CFNumber>().ok())
            .and_then(|number| number.as_i64())
            .filter(|value| *value > 0)
    };
    // SAFETY: the keys are constants exported by ImageIO.
    let (mut width, mut height, orientation) = unsafe {
        (
            number(kCGImagePropertyPixelWidth),
            number(kCGImagePropertyPixelHeight),
            number(kCGImagePropertyOrientation),
        )
    };
    if width.is_none() || height.is_none() {
        return Err(NO_PICTURE.into());
    }
    // EXIF orientations 5 through 8 turn the picture a quarter.
    if orientation.is_some_and(|orientation| orientation >= 5) {
        std::mem::swap(&mut width, &mut height);
    }
    Ok(Probe {
        width,
        height,
        duration_ms: None,
    })
}

fn image_frame(path: &Path, max: u32) -> Result<CFRetained<CGImage>, String> {
    let source = image_source(path)?;
    let yes = CFBoolean::new(true);
    let max = CFNumber::new_i64(max.into());
    // SAFETY: the keys are constants exported by ImageIO.
    let keys: [&CFString; 3] = unsafe {
        [
            kCGImageSourceCreateThumbnailFromImageAlways,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceThumbnailMaxPixelSize,
        ]
    };
    let values: [&CFType; 3] = [yes.as_ref(), yes.as_ref(), max.as_ref()];
    let options = CFDictionary::<CFString, CFType>::from_slices(&keys, &values);
    // SAFETY: the options hold the value types ImageIO documents for these keys.
    unsafe { source.thumbnail_at_index(0, Some(options.as_ref())) }
        .ok_or_else(|| "cannot decode the picture".into())
}

fn asset(path: &Path) -> Result<Retained<AVAsset>, String> {
    let path = path.to_str().ok_or("invalid file path")?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    // SAFETY: `url` is a file URL.
    Ok(unsafe { AVAsset::assetWithURL(&url) })
}

fn video_probe(path: &Path) -> Result<Probe, String> {
    let asset = asset(path)?;
    // SAFETY: AVMediaTypeVideo is a constant exported by AVFoundation.
    let video = unsafe { AVMediaTypeVideo }.ok_or("AVFoundation is unavailable")?;
    // The synchronous accessors block until the file's header is read, which is
    // what this background call wants.
    #[allow(deprecated)]
    let track = unsafe { asset.tracksWithMediaType(video) }
        .firstObject()
        .ok_or(NO_PICTURE)?;
    // SAFETY: plain property reads on a loaded track.
    let size =
        unsafe { CGSizeApplyAffineTransform(track.naturalSize(), track.preferredTransform()) };
    let (width, height) = (
        size.width.abs().round() as i64,
        size.height.abs().round() as i64,
    );
    if width <= 0 || height <= 0 {
        return Err(NO_PICTURE.into());
    }
    // SAFETY: plain property read.
    let seconds = unsafe { asset.duration().seconds() };
    Ok(Probe {
        width: Some(width),
        height: Some(height),
        duration_ms: (seconds.is_finite() && seconds > 0.0)
            .then(|| (seconds * 1000.0).round() as i64),
    })
}

fn video_frame(path: &Path, seek: Option<f64>, max: u32) -> Result<RgbImage, String> {
    let asset = asset(path)?;
    // SAFETY: the generator reads `asset`, which outlives it here.
    let generator = unsafe { AVAssetImageGenerator::assetImageGeneratorWithAsset(&asset) };
    let time = unsafe {
        generator.setAppliesPreferredTrackTransform(true);
        generator.setMaximumSize(CGSize::new(f64::from(max), f64::from(max)));
        CMTime::with_seconds(seek.unwrap_or(0.0), 600)
    };
    // This runs on a blocking worker thread, where the synchronous call is fine.
    #[allow(deprecated)]
    // SAFETY: a null `actualTime` is allowed.
    let frame = unsafe { generator.copyCGImageAtTime_actualTime_error(time, std::ptr::null_mut()) };
    let frame = frame.map_err(|error| error.localizedDescription().to_string())?;
    pixels(&frame)
}

/// Draws the picture into an 8-bit RGB buffer, top row first.
fn pixels(picture: &CGImage) -> Result<RgbImage, String> {
    let (width, height) = (
        CGImage::width(Some(picture)),
        CGImage::height(Some(picture)),
    );
    if width == 0 || height == 0 {
        return Err(NO_PICTURE.into());
    }
    let mut rgbx = vec![0u8; width * height * 4];
    let space = CGColorSpace::new_device_rgb().ok_or("cannot create a color space")?;
    // SAFETY: `rgbx` holds `height` rows of `width * 4` bytes and outlives the context.
    let context = unsafe {
        CGBitmapContextCreate(
            rgbx.as_mut_ptr().cast(),
            width,
            height,
            8,
            width * 4,
            Some(&space),
            CGImageAlphaInfo::NoneSkipLast.0,
        )
    }
    .ok_or("cannot create a drawing buffer")?;
    let area = CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize::new(width as f64, height as f64),
    );
    CGContext::draw_image(Some(&context), area, Some(picture));
    drop(context);
    let rgb = rgbx
        .chunks_exact(4)
        .flat_map(|pixel| [pixel[0], pixel[1], pixel[2]])
        .collect();
    RgbImage::from_raw(width as u32, height as u32, rgb).ok_or_else(|| NO_PICTURE.into())
}
