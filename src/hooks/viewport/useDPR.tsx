import { useEffect, useState } from "react";

export const useDPR = () => {
  const [dpr, setDPR] = useState(
    !window ? 1 : Math.min(window.devicePixelRatio, 2),
  );

  useEffect(() => {
    if (!window) {
      return;
    }

    const handleDPRChange = () => {
      setDPR(window.devicePixelRatio);
    };

    const windowMatch = window.matchMedia(
      `screen and (min-resolution: ${dpr}dppx)`,
    );

    windowMatch.addEventListener("change", handleDPRChange);

    return () => {
      windowMatch.removeEventListener("change", handleDPRChange);
    };
  }, []);

  return dpr;
};
