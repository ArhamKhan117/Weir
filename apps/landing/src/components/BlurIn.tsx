import { motion, useInView } from "framer-motion";
import { type ReactNode, useRef } from "react";

/**
 * Reveals its children once, by lifting a blur rather than sliding them. The
 * `once` flag matters: a heading that re-blurs every time it scrolls back into
 * view reads as a glitch, not as an entrance.
 */
export function BlurIn({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true });

  return (
    <div ref={ref} className={className}>
      <motion.div
        initial={{ filter: "blur(20px)", opacity: 0 }}
        animate={inView ? { filter: "blur(0px)", opacity: 1 } : undefined}
        transition={{ duration: 1.2 }}
      >
        {children}
      </motion.div>
    </div>
  );
}
