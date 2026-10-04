/**
 * Softens the seam between two sections of different colour. The SVG is filled
 * with the colour of the section *below*, so the lower band appears to arc up
 * into the one above instead of meeting it on a hard horizontal line.
 *
 * `preserveAspectRatio="none"` lets the curve stretch to any width while keeping
 * its height fixed, and the negative bottom margin closes the sub-pixel gap that
 * otherwise shows as a hairline at some zoom levels.
 */
export function CurvedDivider({ fill }: { fill: string }) {
  return (
    <div aria-hidden className="-mb-px w-full leading-[0]">
      <svg
        viewBox="0 0 1440 100"
        preserveAspectRatio="none"
        className="block h-[56px] w-full md:h-[100px]"
        role="presentation"
      >
        <path d="M0,64 C480,0 960,0 1440,64 L1440,100 L0,100 Z" fill={fill} />
      </svg>
    </div>
  );
}
