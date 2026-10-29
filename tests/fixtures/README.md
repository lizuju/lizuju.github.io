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

# Media preview fixtures

`preview-video.mov` is a four-second, 64 × 48 teal frame encoded as H.264 in a
QuickTime container. `preview-audio.mp3` and `preview-audio.m4a` are four-second,
440 Hz synthetic tones encoded as MP3 and AAC respectively, with mono audio at
22,050 Hz. These original synthetic fixtures contain no personal media and use
the repository's MIT license.

They were generated with FFmpeg using `-map_metadata -1 -fflags +bitexact` and
the corresponding `-flags:v +bitexact` or `-flags:a +bitexact`. MOV and M4A use
`-movflags +faststart`; the video uses `libx264`, baseline profile and `yuv420p`,
while the audio uses `libmp3lame` or `aac` at 32 kbit/s. The test runtime does not
require FFmpeg.

Four seconds leave time to seek and verify playback before the media ends,
without enabling native looping during the preview lifecycle checks.

`native-video.mp4` is a twenty-second, 64 × 48 teal frame at 10 frames per second,
encoded as H.264 Constrained Baseline in an MP4 container with no audio track. The
mute-control test loops it beside a twenty-second tone, so both stay well clear of
their loop point while the test compares playback positions. It was generated with
FFmpeg 8.0.1:

```sh
ffmpeg -f lavfi -i color=c=0x157a6e:s=64x48:r=10 -t 20 -c:v libx264 -profile:v baseline \
  -pix_fmt yuv420p -movflags +faststart -map_metadata -1 -fflags +bitexact -flags:v +bitexact \
  -an native-video.mp4
```

Its SHA-256 is `ac27dbb19405fc7d10ed8c61fe4c6e9cbbe7958f80d40b2b6e6219b82fba77ac`.
