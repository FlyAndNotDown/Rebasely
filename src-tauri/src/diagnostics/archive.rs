//! A bounded, stored ZIP containing only generated diagnostic entries.
//! Format: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT

use std::io;

pub(super) const MAX_ARCHIVE_BYTES: usize = 1_100_000;

pub(super) fn stored_zip(entries: &[(&str, Vec<u8>)]) -> io::Result<Vec<u8>> {
    if entries.len() > 6 {
        return Err(invalid_archive());
    }
    let mut output = Vec::new();
    let mut central = Vec::new();
    for (name, contents) in entries {
        if !matches!(
            *name,
            "manifest.json"
                | "README.txt"
                | "events.jsonl"
                | "events.1.jsonl"
                | "events.2.jsonl"
                | "events.3.jsonl"
        ) || contents.len() > 262_144
        {
            return Err(invalid_archive());
        }
        let offset = output.len() as u32;
        let size = contents.len() as u32;
        let crc = crc32(contents);
        word32(&mut output, 0x0403_4b50);
        for value in [20, 0, 0, 0, 33] {
            word16(&mut output, value);
        }
        for value in [crc, size, size] {
            word32(&mut output, value);
        }
        word16(&mut output, name.len() as u16);
        word16(&mut output, 0);
        output.extend_from_slice(name.as_bytes());
        output.extend_from_slice(contents);

        word32(&mut central, 0x0201_4b50);
        for value in [20, 20, 0, 0, 0, 33] {
            word16(&mut central, value);
        }
        for value in [crc, size, size] {
            word32(&mut central, value);
        }
        word16(&mut central, name.len() as u16);
        for _ in 0..4 {
            word16(&mut central, 0);
        }
        word32(&mut central, 0);
        word32(&mut central, offset);
        central.extend_from_slice(name.as_bytes());
        if output.len() + central.len() + 22 > MAX_ARCHIVE_BYTES {
            return Err(invalid_archive());
        }
    }
    let offset = output.len() as u32;
    let central_size = central.len() as u32;
    output.extend_from_slice(&central);
    word32(&mut output, 0x0605_4b50);
    word16(&mut output, 0);
    word16(&mut output, 0);
    word16(&mut output, entries.len() as u16);
    word16(&mut output, entries.len() as u16);
    word32(&mut output, central_size);
    word32(&mut output, offset);
    word16(&mut output, 0);
    Ok(output)
}

fn invalid_archive() -> io::Error {
    io::Error::other("Invalid diagnostic archive.")
}

fn word16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn word32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn crc32(contents: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for byte in contents {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0_u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn rejects_paths_unknown_entries_and_oversized_payloads() {
        for name in [
            "../events.jsonl",
            "/events.jsonl",
            "prefs.json",
            "folder/events.jsonl",
        ] {
            assert!(stored_zip(&[(name, Vec::new())]).is_err());
        }
        assert!(stored_zip(&[("events.jsonl", vec![0; 262_145])]).is_err());
        assert!(stored_zip(&[("events.jsonl", vec![0; 262_144])]).is_ok());
    }

    #[test]
    fn central_directory_points_to_the_real_local_entries() {
        let output = stored_zip(&[
            ("events.jsonl", b"hello\n".to_vec()),
            ("README.txt", Vec::new()),
        ])
        .unwrap();
        let end = output.len() - 22;
        assert_eq!(&output[end..end + 4], &0x0605_4b50_u32.to_le_bytes());
        let central = u32::from_le_bytes(output[end + 16..end + 20].try_into().unwrap()) as usize;
        assert_eq!(
            &output[central..central + 4],
            &0x0201_4b50_u32.to_le_bytes()
        );
        assert_eq!(
            u32::from_le_bytes(output[central + 42..central + 46].try_into().unwrap()),
            0
        );
        assert_eq!(u32::from_le_bytes(output[18..22].try_into().unwrap()), 6);
        assert_eq!(&output[30..42], b"events.jsonl");
    }
}
