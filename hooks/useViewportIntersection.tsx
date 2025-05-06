import { useEffect, useState } from "react";

export const useIntersection = (
  element: React.RefObject<HTMLElement>,
  options: {
    rootMargin: string;
    delay: number;
  }
) => {
  const [isVisible, setState] = useState(false);

  useEffect(() => {
    const current = element?.current;
    let timeoutId: NodeJS.Timeout | null = null;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          timeoutId = setTimeout(() => {
            setState(true);
          }, options.delay || 0);
        } else {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          setState(false);
        }
      },
      { rootMargin: options.rootMargin || "0px" }
    );
    current && observer?.observe(current);

    return () => {
      current && observer.unobserve(current);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [element, options.rootMargin, options.delay]);

  return isVisible;
};
