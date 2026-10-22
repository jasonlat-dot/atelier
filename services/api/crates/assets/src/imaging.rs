use crate::{AssetError, MAX_IMAGE_BYTES};
use image::{GenericImageView, ImageDecoder, ImageFormat, ImageReader};
use std::io::Cursor;

pub struct PreparedImage {
    pub original: Vec<u8>,
    pub thumbnail: Vec<u8>,
    pub width: u32,
    pub height: u32,
}
pub fn prepare(bytes: &[u8], declared_mime: &str) -> Result<PreparedImage, AssetError> {
    if bytes.is_empty() {
        return Err(AssetError::Validation);
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(AssetError::TooLarge);
    }
    let format = image::guess_format(bytes).map_err(|_| AssetError::Validation)?;
    let mime = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        _ => return Err(AssetError::Validation),
    };
    if declared_mime != mime {
        return Err(AssetError::Validation);
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| AssetError::Validation)?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 32_000_000 {
        return Err(AssetError::TooLarge);
    }
    let orientation = decoder.orientation().map_err(|_| AssetError::Validation)?;
    let mut image =
        image::DynamicImage::from_decoder(decoder).map_err(|_| AssetError::Validation)?;
    image.apply_orientation(orientation);
    let (width, height) = image.dimensions();
    // Fresh pixels discard uploaded EXIF, comments and other metadata.
    let mut original = Cursor::new(Vec::new());
    image
        .write_to(&mut original, ImageFormat::Png)
        .map_err(|_| AssetError::Store)?;
    if original.get_ref().len() > MAX_IMAGE_BYTES {
        return Err(AssetError::TooLarge);
    }
    let thumb = image.thumbnail(480, 480).to_rgb8();
    let mut thumbnail = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut thumbnail, 82)
        .encode_image(&thumb)
        .map_err(|_| AssetError::Store)?;
    Ok(PreparedImage {
        original: original.into_inner(),
        thumbnail,
        width,
        height,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn png() -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(8, 4)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }
    #[test]
    fn rejects_spoofed_content_mime_svg_and_truncated_images() {
        for input in [
            b"not png".as_slice(),
            b"<svg xmlns='http://www.w3.org/2000/svg'/>".as_slice(),
            &png()[..20],
        ] {
            assert!(prepare(input, "image/png").is_err());
        }
        assert!(prepare(&png(), "image/jpeg").is_err());
        assert!(prepare(&vec![0; MAX_IMAGE_BYTES + 1], "image/png").is_err());
    }
    #[test]
    fn reencodes_pixels_instead_of_preserving_uploaded_payload() {
        let mut bytes = png();
        bytes.extend_from_slice(b"PRIVATE-EXIF-LIKE-PAYLOAD");
        let result = prepare(&bytes, "image/png").unwrap();
        assert_eq!((result.width, result.height), (8, 4));
        assert!(!result
            .original
            .windows(b"PRIVATE-EXIF-LIKE-PAYLOAD".len())
            .any(|w| w == b"PRIVATE-EXIF-LIKE-PAYLOAD"));
        assert_eq!(
            image::guess_format(&result.original).unwrap(),
            ImageFormat::Png
        );
        assert_eq!(
            image::guess_format(&result.thumbnail).unwrap(),
            ImageFormat::Jpeg
        );
    }
}
