import { useEffect, useRef, useState } from "react";

// The pixel width of an element, tracked as it changes.
//
// A chart drawn into a scaled viewBox gets distorted strokes — a 2px line
// becomes 2px tall and 5px wide when the box is stretched horizontally.
// Measuring instead lets the SVG be drawn at its real size, so hairlines
// stay hairlines.
export function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const update = () => setWidth(element.clientWidth);
    update();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
