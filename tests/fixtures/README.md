# HEIC preview fixture

`heic-gradient.heic` is an original, synthetic 64 × 48 RGB gradient created for
these tests. It contains no third-party photographs or other media. Its pixel
values are `R = x * 4`, `G = y * 5`, `B = (x + y) * 2`.

The source PNG was encoded as HEIC using Apple's `sips-316` on macOS 27.0.1:

```sh
sips -s format heic gradient.png --out heic-gradient.heic
```

The result is a real 623-byte HEVC/HEIF image, not renamed PNG data. It is
distributed under this repository's MIT license. Its SHA-256 is
`b7fd82b86c5f8fc3b1eaf27860c3c3a6a10b0c9a2b3898ccf95193a82904fd4f`.
