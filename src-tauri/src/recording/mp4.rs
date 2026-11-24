//! ISO-BMFF helpers for crash-safe live recordings.
//!
//! Live FFmpeg output uses fragmented MP4 (`empty_moov`) so a killed encoder still
//! leaves a playable file. `+faststart` is avoided on the live encode because it
//! rewrites the whole file at stop and can lose the trailer on a timeout. After a
//! clean stop we remux to a regular MP4 with `+faststart` so the WebView player
//! can read duration without range requests.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Walk at most this many top-level boxes. Live fMP4 finds `moov`/`moof` immediately;
/// a remuxed library file is `ftyp` + `moov` + `mdat` after `+faststart`.
const MAX_TOP_LEVEL_BOXES: usize = 10_000;

pub(crate) const RECORDING_MOVFLAGS: &str = "+frag_keyframe+empty_moov+default_base_moof";
pub(crate) const LIBRARY_MOVFLAGS: &str = "+faststart";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Mp4Probe {
    pub(crate) has_moov: bool,
    pub(crate) has_moof: bool,
    pub(crate) has_movie_extends: bool,
}

impl Mp4Probe {
    /// Live fragment with media. An empty init `moov` alone is not enough.
    pub(crate) fn has_media_fragment(self) -> bool {
        self.has_moof
    }

    /// Regular MP4 with a duration-bearing `moov` (no live fragments or `mvex`).
    pub(crate) fn is_library_ready(self) -> bool {
        self.has_moov && !self.has_moof && !self.has_movie_extends
    }

    pub(crate) fn is_usable_segment(self) -> bool {
        self.has_media_fragment() || self.is_library_ready()
    }
}

pub(crate) fn probe_mp4(path: &Path) -> Mp4Probe {
    let Ok(file) = File::open(path) else {
        return Mp4Probe::default();
    };
    probe_mp4_reader(file)
}

fn probe_mp4_reader<R: Read + Seek>(mut reader: R) -> Mp4Probe {
    let Ok(file_len) = reader.seek(SeekFrom::End(0)) else {
        return Mp4Probe::default();
    };
    if file_len < 8 {
        return Mp4Probe::default();
    }

    let mut probe = Mp4Probe::default();
    let mut offset = 0_u64;

    for _ in 0..MAX_TOP_LEVEL_BOXES {
        if offset + 8 > file_len {
            break;
        }
        if reader.seek(SeekFrom::Start(offset)).is_err() {
            break;
        }

        let mut header = [0_u8; 8];
        if reader.read_exact(&mut header).is_err() {
            break;
        }

        let mut box_size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let box_type = &header[4..8];
        let mut header_len = 8_u64;

        if box_size == 1 {
            let mut large_size = [0_u8; 8];
            if reader.read_exact(&mut large_size).is_err() {
                break;
            }
            box_size = u64::from_be_bytes(large_size);
            header_len = 16;
            if box_size < header_len {
                break;
            }
        } else if box_size == 0 {
            box_size = file_len.saturating_sub(offset);
        } else if box_size < 8 {
            break;
        }

        if box_type == b"moov" {
            probe.has_moov = true;
            probe.has_movie_extends =
                box_contains_child(&mut reader, offset, box_size, header_len, b"mvex");
        } else if box_type == b"moof" {
            probe.has_moof = true;
        }

        if probe.is_library_ready() || (probe.has_moov && probe.has_moof) {
            break;
        }

        let next_offset = offset.saturating_add(box_size);
        if next_offset <= offset {
            break;
        }
        offset = next_offset;
    }

    probe
}

fn box_contains_child<R: Read + Seek>(
    reader: &mut R,
    box_offset: u64,
    box_size: u64,
    header_len: u64,
    child_type: &[u8; 4],
) -> bool {
    let end = box_offset.saturating_add(box_size);
    let mut offset = box_offset.saturating_add(header_len);

    while offset + 8 <= end {
        if reader.seek(SeekFrom::Start(offset)).is_err() {
            return false;
        }

        let mut header = [0_u8; 8];
        if reader.read_exact(&mut header).is_err() {
            return false;
        }

        let mut child_size =
            u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        if child_size == 1 {
            let mut large_size = [0_u8; 8];
            if reader.read_exact(&mut large_size).is_err() {
                return false;
            }
            child_size = u64::from_be_bytes(large_size);
            if child_size < 16 {
                return false;
            }
        } else if child_size == 0 {
            child_size = end.saturating_sub(offset);
        } else if child_size < 8 {
            return false;
        }

        if &header[4..8] == child_type {
            return true;
        }

        let next_offset = offset.saturating_add(child_size);
        if next_offset <= offset {
            return false;
        }
        offset = next_offset;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::{probe_mp4_reader, Mp4Probe, LIBRARY_MOVFLAGS, RECORDING_MOVFLAGS};
    use std::io::Cursor;

    fn box_bytes(box_type: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let size = 8 + payload.len();
        let mut bytes = Vec::with_capacity(size);
        bytes.extend_from_slice(&(size as u32).to_be_bytes());
        bytes.extend_from_slice(box_type);
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn recording_movflags_are_fragmented_and_crash_safe() {
        assert!(RECORDING_MOVFLAGS.contains("empty_moov"));
        assert!(RECORDING_MOVFLAGS.contains("frag_keyframe"));
        assert!(!RECORDING_MOVFLAGS.contains("faststart"));
    }

    #[test]
    fn library_movflags_put_the_movie_header_first() {
        assert!(LIBRARY_MOVFLAGS.contains("faststart"));
    }

    #[test]
    fn empty_moov_without_moof_is_not_library_ready() {
        let mut moov_payload = box_bytes(b"mvhd", &[]);
        moov_payload.extend_from_slice(&box_bytes(b"mvex", &[]));
        let mut bytes = box_bytes(b"ftyp", b"isom");
        bytes.extend_from_slice(&box_bytes(b"moov", &moov_payload));
        let probe = probe_mp4_reader(Cursor::new(bytes));
        assert!(probe.has_moov);
        assert!(probe.has_movie_extends);
        assert!(!probe.has_media_fragment());
        assert!(!probe.is_library_ready());
        assert!(!probe.is_usable_segment());
    }

    #[test]
    fn live_fragments_are_usable_segments() {
        let mut bytes = box_bytes(b"ftyp", b"isom");
        bytes.extend_from_slice(&box_bytes(b"moov", &box_bytes(b"mvex", &[])));
        bytes.extend_from_slice(&box_bytes(b"moof", b""));
        bytes.extend_from_slice(&box_bytes(b"mdat", &[0, 1, 2, 3]));
        let probe = probe_mp4_reader(Cursor::new(bytes));
        assert!(probe.has_media_fragment());
        assert!(probe.is_usable_segment());
        assert!(!probe.is_library_ready());
    }

    #[test]
    fn trailing_moov_after_mdat_is_library_ready() {
        let mut bytes = box_bytes(b"ftyp", b"isom");
        bytes.extend_from_slice(&box_bytes(b"mdat", &[0; 64]));
        bytes.extend_from_slice(&box_bytes(b"moov", b"mvhd"));
        let probe = probe_mp4_reader(Cursor::new(bytes));
        assert_eq!(
            probe,
            Mp4Probe {
                has_moov: true,
                has_moof: false,
                has_movie_extends: false,
            }
        );
        assert!(probe.is_library_ready());
    }

    #[test]
    fn rejects_mdat_only_recording() {
        let mut bytes = box_bytes(b"ftyp", b"isomiso2avc1mp41");
        bytes.extend_from_slice(&box_bytes(b"mdat", &[0; 64]));
        let probe = probe_mp4_reader(Cursor::new(bytes));
        assert_eq!(probe, Mp4Probe::default());
    }
}
