/// Encodes bytes as lowercase hexadecimal.
pub(crate) fn encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
