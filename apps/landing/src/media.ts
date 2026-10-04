/**
 * Every video the page plays, served from `public/media`.
 *
 * Each clip ships in more than one encoding and a browser takes the first `<source>` it can decode,
 * so they run smallest first: usually AV1, then HEVC where it is worth having (Apple hardware without
 * an AV1 decoder), then H.264, which everything plays. The codec strings are exact, profile, level and bit
 * depth read off the files, so a browser that cannot decode one says so before downloading it.
 *
 * The motion clips were interpolated from their 24 and 30 fps originals to 60 fps.
 */

export interface VideoSource {
  src: string;
  type: string;
}

const AV1_10BIT_L40 = 'video/webm; codecs="av01.0.08M.10"';
const AV1_10BIT_L41 = 'video/webm; codecs="av01.0.09M.10"';
const AV1_10BIT_L50 = 'video/webm; codecs="av01.0.12M.10"';
const HEVC = 'video/mp4; codecs="hvc1"';
const HEVC_MAIN10_L41 = 'video/mp4; codecs="hvc1.2.4.L123.B0"';
const HEVC_MAIN10_L50 = 'video/mp4; codecs="hvc1.2.4.L150.B0"';
const H264 = "video/mp4";

/**
 * The fly-through that ends on the Weir glass tile, 60 fps, about five seconds, in 10-bit so the
 * soft white light does not band. The tile is rendered natively at 1440p; the 1080p cut is the same
 * frames scaled down, for screens with fewer pixels than that to fill. The intro runs HEVC first:
 * at this quality it is the smallest of the three, and Apple hardware and Chrome on a Mac decode it.
 */
export const INTRO_VIDEO_1440: VideoSource[] = [
  { src: "/media/intro-1440-hevc.mp4", type: HEVC_MAIN10_L50 },
  { src: "/media/intro-1440.webm", type: AV1_10BIT_L50 },
  { src: "/media/intro-1440.mp4", type: H264 },
];

export const INTRO_VIDEO: VideoSource[] = [
  { src: "/media/intro-hevc.mp4", type: HEVC_MAIN10_L41 },
  { src: "/media/intro.webm", type: AV1_10BIT_L41 },
  { src: "/media/intro.mp4", type: H264 },
];

/** Screens wider than this in device pixels get the 1440p intro. */
export const INTRO_1440_MIN_DEVICE_WIDTH = 1920;

/**
 * The same film reframed for a tall screen: the fly-through cropped around the portal, and the tile
 * scene rendered so the tile spans most of the width. Cover-scaling the landscape cut on a phone
 * would leave the tile wider than the screen. The query matches the stills' switch in index.css.
 */
export const PORTRAIT_QUERY = "(max-aspect-ratio: 4/5)";

export const INTRO_VIDEO_PORTRAIT: VideoSource[] = [
  { src: "/media/intro-portrait-hevc.mp4", type: HEVC_MAIN10_L41 },
  { src: "/media/intro-portrait.webm", type: AV1_10BIT_L41 },
  { src: "/media/intro-portrait.mp4", type: H264 },
];

/** The ring of flags behind "Send money home". */
export const RING_VIDEO: VideoSource[] = [
  { src: "/media/ring.webm", type: AV1_10BIT_L50 },
  { src: "/media/ring-hevc.mp4", type: HEVC },
  { src: "/media/ring.mp4", type: H264 },
];

export const GLOBE_VIDEO: VideoSource[] = [
  { src: "/media/globe.webm", type: AV1_10BIT_L41 },
  { src: "/media/globe.mp4", type: H264 },
];

/** The three slow glass loops behind the figures in "The short version". */
export const CALM_VIDEOS = [calm("calm-a"), calm("calm-b"), calm("calm-c")] as const;

function calm(name: string): VideoSource[] {
  return [
    { src: `/media/${name}.webm`, type: AV1_10BIT_L40 },
    { src: `/media/${name}.mp4`, type: H264 },
  ];
}
