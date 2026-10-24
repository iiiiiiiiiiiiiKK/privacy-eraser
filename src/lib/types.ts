/**
 * Shared types for the metadata inspector / cleaner.
 *
 * Vocabulary used throughout the app (and in the UI):
 *  - **detected**: a field we parsed and can show you the value of.
 *  - **cleaned**: a container we removed from the exported bytes and then
 *    verified absent by re-parsing the output.
 *  - **unverified**: something we know can exist but could not confirm or
 *    remove for this file (e.g. custom data inside compressed pixel streams).
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'heic' | 'bmp' | 'tiff' | 'unknown';

/** Where a metadata field physically lives inside the file. */
export type ContainerKind =
  | 'exif'
  | 'xmp'
  | 'iptc'
  | 'icc'
  | 'comment'
  | 'text'
  | 'time'
  | 'jfif'
  | 'adobe'
  | 'photoshop'
  | 'application-extension'
  | 'unknown';

/** How much a field matters for privacy. Drives the UI emphasis. */
export type Sensitivity = 'high' | 'medium' | 'low' | 'none';

export interface MetaField {
  /** Stable key, e.g. `exif.Make`. */
  key: string;
  /** Human readable label, localised where we know the field. */
  label: string;
  /** Raw-ish value rendered for display. */
  value: string;
  /** Category the UI groups by. */
  category: string;
  sensitivity: Sensitivity;
  /** Physical container this field came from. */
  container: ContainerKind;
}

export interface ContainerReport {
  kind: ContainerKind;
  /** Byte length of the container in the original file. */
  bytes: number;
  /** How many times it occurs. */
  count: number;
  /** True when our cleaner knows how to remove it for this format. */
  removable: boolean;
  /** Explanation shown in the boundary table. */
  note: string;
}

export interface GpsInfo {
  latitude: number;
  longitude: number;
  /** Raw EXIF reference values, kept for transparency. */
  latitudeRef?: string;
  longitudeRef?: string;
  altitude?: number;
}

export interface Dimension {
  width: number;
  height: number;
}

export interface ImageInfo {
  format: ImageFormat;
  /** MIME type we will use when exporting. */
  mime: string;
  /** File extension without the dot. */
  ext: string;
  bytes: number;
  dimension: Dimension | null;
  /** True when the byte stream looks structurally valid. */
  structurallyValid: boolean;
  /** Set when we recognised the format but cannot handle it. */
  unsupportedReason?: string;
  hasAlpha?: boolean;
  /** Animation frame count when we can tell (GIF/WebP/PNG APNG). */
  frames?: number;
}

export interface Inspection {
  info: ImageInfo;
  fields: MetaField[];
  containers: ContainerReport[];
  gps: GpsInfo | null;
  /** Which EXIF parsers/extractors actually produced data. */
  parsedBy: string[];
  /** Non-fatal notes, e.g. "EXIF block present but unreadable". */
  notes: string[];
  /** Highest sensitivity among the detected fields. */
  risk: Sensitivity;
}

export interface CleanOptions {
  /**
   * PNG/WebP colour-management blocks carry no personal data but do affect
   * how colours are rendered. Keeping them avoids a visible colour shift.
   */
  keepColorProfile: boolean;
  /** Strip trailing bytes after the image terminator (they can hide anything). */
  stripTrailingBytes: boolean;
}

export interface CleanResult {
  /** The cleaned file bytes. */
  buffer: Uint8Array;
  mime: string;
  ext: string;
  /** Containers actually removed, with byte counts. */
  removed: Array<{ kind: ContainerKind; bytes: number; count: number; label: string }>;
  /** What survives, as re-parsed from the new bytes. */
  remaining: ContainerReport[];
  /** Fields still detected in the output (should be empty for personal data). */
  remainingFields: MetaField[];
  /** True only when the output was re-parsed and found clean. */
  verified: boolean;
  /** Dimensions read back from the cleaned bytes. */
  dimension: Dimension | null;
  bytesBefore: number;
  bytesAfter: number;
  /** Explanation when something could not be verified. */
  verificationNotes: string[];
}

export type ItemStatus = 'queued' | 'inspecting' | 'ready' | 'cleaning' | 'cleaned' | 'error';

export interface WorkItem {
  id: string;
  fileName: string;
  /** Kept only in memory for this tab; never persisted. */
  original: Uint8Array;
  /** Object URL for the preview; revoked when the item is removed. */
  previewUrl: string;
  status: ItemStatus;
  inspection: Inspection | null;
  result: CleanResult | null;
  error: string | null;
}
