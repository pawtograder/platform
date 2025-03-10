import { useEffect, useState } from "react";

export const useIntersection = (element: React.RefObject<HTMLElement>, rootMargin: string = "0px") => {
    const [isVisible, setState] = useState(false);

    useEffect(() => {
        const current = element?.current;
        const observer = new IntersectionObserver(
            ([entry]) => {
                setState(entry.isIntersecting);
            },
            { rootMargin }
        );
        current && observer?.observe(current);

        return () => {
            current && observer.unobserve(current);
        }
    }, []);

    return isVisible;
};
