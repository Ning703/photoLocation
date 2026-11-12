use std::error::Error;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek};
use std::path::Path;

use chrono::NaiveDateTime;
use exif::{Exif, In, Reader, Tag, Value};
use heifer::heifer_isobmff::{HeifFile, boxes::Property};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, RgbImage, RgbaImage};

type PhotoResult<T> = Result<T, Box<dyn Error + Send + Sync>>;
const MAX_PIXELS: u64 = 178_956_970;
const MAX_CONTAINER_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone)]
pub struct Location {
    pub lat: f64,
    pub lng: f64,
    pub captured_at: Option<String>,
}

enum Format {
    Raster(ImageFormat),
    Heic,
    Avif,
}

pub fn supported_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "jpe" | "png" | "webp" | "tif" | "tiff" | "heic" | "heif" | "avif"
            )
        })
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn open(path: &Path) -> PhotoResult<(Format, BufReader<File>)> {
    let mut reader = BufReader::new(File::open(path)?);
    let header = reader.fill_buf()?;
    let format = match image::guess_format(header) {
        Ok(
            kind @ (ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Tiff),
        ) => Format::Raster(kind),
        Ok(ImageFormat::Avif) => Format::Avif,
        _ if header.get(4..8) == Some(b"ftyp") && has_avif_brand(header) => Format::Avif,
        _ if header.get(4..8) == Some(b"ftyp")
            && matches!(
                heifer::check_file_type(header),
                heifer::FileTypeResult::Supported | heifer::FileTypeResult::MayBe
            ) =>
        {
            Format::Heic
        }
        _ => return Err(invalid("unsupported image").into()),
    };
    if !matches!(format, Format::Raster(_))
        && reader.get_ref().metadata()?.len() > MAX_CONTAINER_BYTES
    {
        return Err(invalid("image container exceeds limit").into());
    }
    Ok((format, reader))
}

fn has_avif_brand(header: &[u8]) -> bool {
    let size = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
    header.get(8..size.min(header.len())).is_some_and(|brands| {
        brands
            .chunks_exact(4)
            .enumerate()
            .any(|(index, brand)| index != 1 && matches!(brand, b"avif" | b"avis"))
    })
}

fn raster_decoder(reader: BufReader<File>, format: ImageFormat) -> PhotoResult<impl ImageDecoder> {
    let mut image_reader = ImageReader::with_format(reader, format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(768 * 1024 * 1024);
    image_reader.limits(limits);
    let decoder = image_reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    check_dimensions(width, height)?;
    Ok(decoder)
}

fn check_dimensions(width: u32, height: u32) -> io::Result<()> {
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(invalid("image dimensions exceed limit"));
    }
    Ok(())
}

fn raster_exif(reader: &mut BufReader<File>) -> PhotoResult<Option<Exif>> {
    match Reader::new().read_from_container(reader) {
        Ok(exif) => Ok(Some(exif)),
        Err(exif::Error::NotFound(_)) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn raw_exif(bytes: Option<Vec<u8>>) -> PhotoResult<Option<Exif>> {
    Ok(bytes
        .map(|bytes| Reader::new().read_raw(bytes))
        .transpose()?)
}

pub fn location(path: &Path) -> PhotoResult<Option<Location>> {
    let (format, mut reader) = open(path)?;
    let exif = match format {
        Format::Raster(format) => {
            let exif = raster_exif(&mut reader)?;
            reader.rewind()?;
            raster_decoder(reader, format)?;
            exif
        }
        Format::Avif | Format::Heic => raw_exif(heifer::read_metadata_reader(reader)?.exif)?,
    };
    Ok(exif.as_ref().and_then(location_from_exif))
}

fn location_from_exif(exif: &Exif) -> Option<Location> {
    let lat = degrees(
        exif,
        Tag::GPSLatitude,
        Tag::GPSLatitudeRef,
        b'N',
        b'S',
        90.0,
    )?;
    let lng = degrees(
        exif,
        Tag::GPSLongitude,
        Tag::GPSLongitudeRef,
        b'E',
        b'W',
        180.0,
    )?;
    if lat == 0.0 && lng == 0.0 {
        return None;
    }
    let captured_at = ascii(exif, Tag::DateTimeOriginal)
        .filter(|date| !date.is_empty())
        .or_else(|| ascii(exif, Tag::DateTime))
        .and_then(|date| std::str::from_utf8(date).ok())
        .and_then(|date| NaiveDateTime::parse_from_str(date, "%Y:%m:%d %H:%M:%S").ok())
        .map(|date| date.format("%Y-%m-%dT%H:%M:%S").to_string());
    Some(Location {
        lat,
        lng,
        captured_at,
    })
}

fn ascii(exif: &Exif, tag: Tag) -> Option<&[u8]> {
    match &exif.get_field(tag, In::PRIMARY)?.value {
        Value::Ascii(values) => values.first().map(Vec::as_slice),
        _ => None,
    }
}

fn degrees(
    exif: &Exif,
    tag: Tag,
    direction: Tag,
    positive: u8,
    negative: u8,
    max: f64,
) -> Option<f64> {
    let reference = std::str::from_utf8(ascii(exif, direction)?)
        .ok()?
        .trim_matches(['\0', ' '])
        .as_bytes();
    let [reference] = reference else { return None };
    let sign = match reference.to_ascii_uppercase() {
        value if value == positive => 1.0,
        value if value == negative => -1.0,
        _ => return None,
    };
    let Value::Rational(parts) = &exif.get_field(tag, In::PRIMARY)?.value else {
        return None;
    };
    let [whole, minutes, seconds] = parts.as_slice() else {
        return None;
    };
    let (whole, minutes, seconds) = (whole.to_f64(), minutes.to_f64(), seconds.to_f64());
    let coordinate = whole + minutes / 60.0 + seconds / 3600.0;
    (coordinate.is_finite()
        && coordinate <= max
        && (0.0..=max).contains(&whole)
        && (0.0..60.0).contains(&minutes)
        && (0.0..60.0).contains(&seconds))
    .then_some(sign * coordinate)
}

fn apply_exif(image: &mut DynamicImage, exif: Option<&Exif>) {
    let orientation = exif
        .and_then(|exif| exif.get_field(Tag::Orientation, In::PRIMARY))
        .and_then(|field| field.value.get_uint(0))
        .and_then(|number| u8::try_from(number).ok())
        .and_then(Orientation::from_exif);
    if let Some(orientation) = orientation {
        image.apply_orientation(orientation);
    }
}

pub fn jpeg(path: &Path, size: u32) -> PhotoResult<Vec<u8>> {
    let (format, mut reader) = open(path)?;
    let image = match format {
        Format::Raster(format) => {
            let exif = raster_exif(&mut reader).unwrap_or(None);
            reader.rewind()?;
            let mut image = DynamicImage::from_decoder(raster_decoder(reader, format)?)?;
            apply_exif(&mut image, exif.as_ref());
            image
        }
        Format::Heic | Format::Avif => {
            let mut bytes = Vec::new();
            reader
                .take(MAX_CONTAINER_BYTES + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_CONTAINER_BYTES {
                return Err(invalid("image container exceeds limit").into());
            }
            decode_container(&bytes, format)?
        }
    };
    let scaled = if image.width() > size || image.height() > size {
        image.resize(size, size, FilterType::Lanczos3)
    } else {
        image
    };
    let rgb = if scaled.color().has_alpha() {
        flatten_alpha(scaled.into_rgba8())
    } else {
        scaled.into_rgb8()
    };
    let mut output = Vec::new();
    JpegEncoder::new_with_quality(&mut output, 86).encode_image(&rgb)?;
    Ok(output)
}

fn flatten_alpha(rgba: RgbaImage) -> RgbImage {
    let background = [248u32, 250, 252];
    RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let alpha = u32::from(a);
        let pixels = [r, g, b];
        image::Rgb(std::array::from_fn(|index| {
            ((u32::from(pixels[index]) * alpha + background[index] * (255 - alpha) + 127) / 255)
                as u8
        }))
    })
}

fn decode_container(bytes: &[u8], format: Format) -> PhotoResult<DynamicImage> {
    let file = HeifFile::parse(bytes)?;
    let properties = file.item_properties(file.primary_id)?;
    let mut has_orientation = false;
    let mut image = match format {
        Format::Heic => {
            let image = heifer::decode_rgba8(
                bytes,
                &heifer::Options {
                    max_pixels: MAX_PIXELS,
                    max_threads: 2,
                },
            )?;
            DynamicImage::ImageRgba8(
                RgbaImage::from_raw(image.width, image.height, image.data)
                    .ok_or_else(|| invalid("invalid HEIC pixels"))?,
            )
        }
        Format::Avif => {
            for property in file.item_properties(file.primary_id)? {
                if let Property::ImageSize { width, height } = property {
                    check_dimensions(*width, *height)?;
                }
            }
            decode_avif(bytes)?
        }
        Format::Raster(_) => unreachable!(),
    };
    for property in properties {
        match *property {
            Property::Rotation(turns) => {
                has_orientation = true;
                if matches!(format, Format::Avif) {
                    image = match turns {
                        1 => image.rotate270(),
                        2 => image.rotate180(),
                        3 => image.rotate90(),
                        _ => image,
                    };
                }
            }
            Property::Mirror(top_bottom) => {
                has_orientation = true;
                if matches!(format, Format::Avif) {
                    image = if top_bottom {
                        image.flipv()
                    } else {
                        image.fliph()
                    };
                }
            }
            _ => {}
        }
    }
    if !has_orientation && let Ok(exif) = raw_exif(file.exif(file.primary_id)?) {
        apply_exif(&mut image, exif.as_ref());
    }
    Ok(image)
}

fn decode_avif(bytes: &[u8]) -> PhotoResult<DynamicImage> {
    use avif_decode::Image;
    use image::ImageBuffer;
    let decoded = avif_decode::Decoder::from_avif(bytes)?.to_image()?;
    macro_rules! convert {
        ($pixels:expr, $variant:ident, $to_channels:expr) => {{
            let width = u32::try_from($pixels.width())?;
            let height = u32::try_from($pixels.height())?;
            check_dimensions(width, height)?;
            let channels = $pixels.pixels().flat_map($to_channels).collect();
            DynamicImage::$variant(
                ImageBuffer::from_raw(width, height, channels)
                    .ok_or_else(|| invalid("invalid AVIF pixels"))?,
            )
        }};
    }
    Ok(match decoded {
        Image::Rgb8(pixels) => convert!(pixels, ImageRgb8, |p| [p.r, p.g, p.b]),
        Image::Rgb16(pixels) => convert!(pixels, ImageRgb16, |p| [p.r, p.g, p.b]),
        Image::Rgba8(pixels) => convert!(pixels, ImageRgba8, |p| [p.r, p.g, p.b, p.a]),
        Image::Rgba16(pixels) => convert!(pixels, ImageRgba16, |p| [p.r, p.g, p.b, p.a]),
        Image::Gray8(pixels) => convert!(pixels, ImageLuma8, |p| [p.value()]),
        Image::Gray16(pixels) => convert!(pixels, ImageLuma16, |p| [p.value()]),
    })
}
