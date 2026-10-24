"""Generate the test-image fixtures used by the unit and end-to-end tests.

Every fixture is built in code (no binary blobs checked in blindly) so that the
exact metadata content is documented and reproducible:

  exif-gps.jpg          JPEG + APP1/Exif (camera, lens, timestamps, GPS) + APP1/XMP + COM
  no-metadata.jpg       JPEG with no APP1/COM segments at all
  transparent.png       RGBA PNG with tEXt/iTXt/eXIf/tIME chunks
  clean.png             RGB PNG with no ancillary metadata chunks
  animated.webp         WebP with EXIF + XMP chunks
  clean.webp            WebP without metadata
  huge.jpg              4000x3000 JPEG (large pixel count, small-ish file)
  broken.jpg            JPEG truncated in the middle of the scan
  not-an-image.txt      plain text with a .jpg name (unsupported input)
  unsupported.gif       GIF87a (recognised, not cleanable)

Run:  python scripts/make_fixtures.py
"""

from __future__ import annotations

import io
import os
import struct
import zlib
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------
# Tiny TIFF/EXIF writer
# --------------------------------------------------------------------------
# IFD entry types
BYTE, ASCII, SHORT, LONG, RATIONAL = 1, 2, 3, 4, 5
TYPE_SIZE = {BYTE: 1, ASCII: 1, SHORT: 2, LONG: 4, RATIONAL: 8}


def _pad4(data: bytes) -> bytes:
    return data + b"\x00" * ((4 - len(data) % 4) % 4)


def build_exif() -> bytes:
    """Build a little-endian TIFF block with IFD0 + ExifIFD + GPS IFD."""
    # Entries: (tag, type, values)
    ifd0 = [
        (0x010F, ASCII, b"TestCamera Co.\x00"),          # Make
        (0x0110, ASCII, b"PrivacyEraser TX-1\x00"),      # Model
        (0x0112, SHORT, [1]),                            # Orientation
        (0x0131, ASCII, b"PrivacyEraser FixtureGen 1.0\x00"),  # Software
        (0x013B, ASCII, b"Ada Lovelace\x00"),            # Artist
        (0x8298, ASCII, b"(c) 2026 Ada Lovelace\x00"),   # Copyright
    ]
    exif_ifd = [
        (0x829A, RATIONAL, [(1, 250)]),                  # ExposureTime
        (0x829D, RATIONAL, [(28, 10)]),                  # FNumber f/2.8
        (0x8827, SHORT, [200]),                          # ISO
        (0x9003, ASCII, b"2026:10:25 04:50:42\x00"),     # DateTimeOriginal
        (0x9004, ASCII, b"2026:10:25 04:50:43\x00"),     # DateTimeDigitized
        (0x920A, RATIONAL, [(35, 1)]),                   # FocalLength
        (0xA002, LONG, [640]),                           # PixelXDimension
        (0xA003, LONG, [480]),                           # PixelYDimension
        (0xA434, ASCII, b"TX 35mm f/2.8\x00"),           # LensModel
    ]
    gps_ifd = [
        (0x0000, BYTE, [2, 3, 0, 0]),                    # GPSVersionID
        (0x0001, ASCII, b"N\x00"),                       # LatitudeRef
        (0x0002, RATIONAL, [(37, 1), (46, 1), (2988, 100)]),   # 37°46'29.88"N
        (0x0003, ASCII, b"W\x00"),                       # LongitudeRef
        (0x0004, RATIONAL, [(122, 1), (25, 1), (1080, 100)]),  # 122°25'10.80"W
        (0x0005, BYTE, [0]),                             # AltitudeRef
        (0x0006, RATIONAL, [(1520, 10)]),                # Altitude 152 m
        (0x001D, ASCII, b"2026:10:25\x00"),              # GPSDateStamp
    ]

    # Layout: header(8) | IFD0 | ExifIFD | GPS IFD | data area
    ifd0_entries = list(ifd0) + [(0x8769, LONG, None), (0x8825, LONG, None)]
    ifd0_entries.sort(key=lambda e: e[0])

    def ifd_size(entries) -> int:
        return 2 + 12 * len(entries) + 4

    ifd0_off = 8
    exif_off = ifd0_off + ifd_size(ifd0_entries)
    gps_off = exif_off + ifd_size(exif_ifd)
    data_off = gps_off + ifd_size(gps_ifd)

    data = bytearray()

    def encode_entry(tag: int, typ: int, values) -> bytes:
        """Encode one IFD entry, spilling payloads into the data area."""
        nonlocal data
        if tag == 0x8769:
            return struct.pack("<HHII", tag, LONG, 1, exif_off)
        if tag == 0x8825:
            return struct.pack("<HHII", tag, LONG, 1, gps_off)
        if typ == ASCII:
            payload = values if isinstance(values, bytes) else values.encode()
            count = len(payload)
        elif typ == RATIONAL:
            count = len(values)
            payload = b"".join(struct.pack("<II", num, den) for num, den in values)
        elif typ == SHORT:
            count = len(values)
            payload = b"".join(struct.pack("<H", v) for v in values)
        elif typ == LONG:
            count = len(values)
            payload = b"".join(struct.pack("<I", v) for v in values)
        elif typ == BYTE:
            count = len(values)
            payload = bytes(values)
        else:
            raise ValueError(typ)

        size = TYPE_SIZE[typ] * count
        if size <= 4:
            inline = payload + b"\x00" * (4 - len(payload))
            return struct.pack("<HHI", tag, typ, count) + inline
        offset = data_off + len(data)
        data.extend(_pad4(payload))
        return struct.pack("<HHII", tag, typ, count, offset)

    def encode_ifd(entries) -> bytes:
        body = bytearray(struct.pack("<H", len(entries)))
        for tag, typ, values in entries:
            body.extend(encode_entry(tag, typ, values))
        body.extend(struct.pack("<I", 0))  # next IFD = none
        return bytes(body)

    out = bytearray(b"II" + struct.pack("<HI", 0x2A, ifd0_off))
    out.extend(encode_ifd(ifd0_entries))
    out.extend(encode_ifd(exif_ifd))
    out.extend(encode_ifd(gps_ifd))
    out.extend(data)
    return bytes(out)


XMP_PACKET = """<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:xmp="http://ns.adobe.com/xap/1.0/"
        xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
        dc:creator="Ada Lovelace"
        dc:rights="(c) 2026 Ada Lovelace"
        dc:description="Fixture image for Privacy Eraser tests"
        xmp:CreatorTool="PrivacyEraser FixtureGen 1.0"
        photoshop:City="San Francisco"
        photoshop:Country="United States"/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>""".encode()

JPEG_COMMENT = b"Created for Privacy Eraser test fixtures - safe to delete"


# --------------------------------------------------------------------------
# JPEG assembly helpers
# --------------------------------------------------------------------------
def segment(marker: int, payload: bytes) -> bytes:
    if len(payload) + 2 > 0xFFFF:
        raise ValueError("segment too large")
    return bytes([0xFF, marker]) + struct.pack(">H", len(payload) + 2) + payload


def jpeg_with_metadata(image: Image.Image, exif_block: bytes | None, add_xmp: bool, add_comment: bool) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=92, optimize=False)
    base = buffer.getvalue()
    assert base[:2] == b"\xff\xd8"

    inserts = bytearray()
    if exif_block:
        inserts.extend(segment(0xE1, b"Exif\x00\x00" + exif_block))
    if add_xmp:
        inserts.extend(segment(0xE1, b"http://ns.adobe.com/xap/1.0/\x00" + XMP_PACKET))
    if add_comment:
        inserts.extend(segment(0xFE, JPEG_COMMENT))
    return base[:2] + bytes(inserts) + base[2:]


# --------------------------------------------------------------------------
# PNG chunk helpers
# --------------------------------------------------------------------------
def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def png_with_metadata(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    base = buffer.getvalue()
    iend = base.rindex(b"IEND") - 4
    extra = bytearray()
    extra.extend(png_chunk(b"tEXt", b"Software\x00PrivacyEraser FixtureGen 1.0"))
    extra.extend(png_chunk(b"tEXt", b"Comment\x00Fixture for Privacy Eraser tests"))
    extra.extend(png_chunk(b"iTXt", b"XML:com.adobe.xmp\x00\x00\x00\x00\x00" + XMP_PACKET))
    extra.extend(png_chunk(b"eXIf", build_exif()))
    extra.extend(png_chunk(b"tIME", struct.pack(">HBBBBB", 2026, 10, 25, 4, 50, 42)))
    return base[:iend] + bytes(extra) + base[iend:]


def webp_with_metadata(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    try:
        image.save(buffer, format="WEBP", lossless=True, quality=90, exif=build_exif(), xmp=XMP_PACKET)
    except TypeError:
        image.save(buffer, format="WEBP", lossless=True)
    return buffer.getvalue()


def gradient(size: tuple[int, int], alpha: bool = False) -> Image.Image:
    width, height = size
    mode = "RGBA" if alpha else "RGB"
    image = Image.new(mode, size)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        for x in range(0, width, 1):
            r = int(255 * x / max(1, width - 1))
            g = int(255 * y / max(1, height - 1))
            b = 128
            if alpha:
                draw.point((x, y), fill=(r, g, b, 128 if (x // 16 + y // 16) % 2 == 0 else 255))
            else:
                draw.point((x, y), fill=(r, g, b))
    draw.text((10, 10), "Privacy Eraser", fill=(255, 255, 255) if not alpha else (255, 255, 255, 255))
    return image


def main() -> None:
    exif_block = build_exif()

    jpeg = gradient((640, 480))
    (OUT / "exif-gps.jpg").write_bytes(jpeg_with_metadata(jpeg, exif_block, add_xmp=True, add_comment=True))
    (OUT / "no-metadata.jpg").write_bytes(jpeg_with_metadata(jpeg, None, add_xmp=False, add_comment=False))

    (OUT / "transparent.png").write_bytes(png_with_metadata(gradient((320, 240), alpha=True)))
    buffer = io.BytesIO()
    gradient((160, 120)).save(buffer, format="PNG", optimize=False)
    (OUT / "clean.png").write_bytes(buffer.getvalue())

    webp = gradient((480, 360))
    data = webp_with_metadata(webp)
    (OUT / "animated.webp").write_bytes(data)
    buffer = io.BytesIO()
    webp.save(buffer, format="WEBP", lossless=True)
    (OUT / "clean.webp").write_bytes(buffer.getvalue())

    buffer = io.BytesIO()
    gradient((4000, 3000)).save(buffer, format="JPEG", quality=45)
    (OUT / "huge.jpg").write_bytes(buffer.getvalue())

    good = jpeg_with_metadata(jpeg, exif_block, add_xmp=True, add_comment=True)
    (OUT / "broken.jpg").write_bytes(good[: len(good) // 2])

    (OUT / "not-an-image.txt").write_text("this is not an image\n", encoding="utf-8")

    gif = gradient((64, 64)).convert("P")
    buffer = io.BytesIO()
    gif.save(buffer, format="GIF")
    (OUT / "unsupported.gif").write_bytes(buffer.getvalue())

    for path in sorted(OUT.iterdir()):
        print(f"{path.name:24s} {path.stat().st_size:>9,d} bytes")


if __name__ == "__main__":
    main()
