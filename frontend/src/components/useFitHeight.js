import { useLayoutEffect, useRef } from "react";

// A page that is exactly as tall as the window under the sticky header, so
// the page itself never scrolls and the lists inside it do. Sets --fit-h on
// the element the returned ref is attached to.
export function useFitHeight(extra = 4, min = 420) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const measure = () => {
      const top = document.querySelector(".topbar")?.getBoundingClientRect().height || 56;
      // The page's own padding around the content is part of what's left over.
      const main = document.querySelector(".dashboard");
      const pad = main
        ? parseFloat(getComputedStyle(main).paddingTop) + parseFloat(getComputedStyle(main).paddingBottom)
        : 0;
      ref.current?.style.setProperty("--fit-h", `${Math.max(min, window.innerHeight - top - pad - extra)}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [extra, min]);
  return ref;
}
