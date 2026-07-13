# Adoption guidance reads must bind lstat to a no-follow open

`prepare-adoption` recursively reads repository guidance that may live under any directory name. A separate `lstatSync(path)` followed by `readFileSync(path)` is not sufficient: another process can replace the final file with a symlink between those calls and make the audit candidate read unintended bytes.

Regular guidance now goes through the repository-scoped `O_NOFOLLOW` reader, which compares the opened file identity with the preceding `lstat`. Symlink guidance remains explicit metadata and must resolve to a safe in-repository text target. A deterministic test swaps a referenced document to an external symlink inside the lstat/open window and requires candidate preparation to fail before creating the external bundle.
