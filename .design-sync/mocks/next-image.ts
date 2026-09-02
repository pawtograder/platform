/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from "react";
export default function Image(props: any) {
  const { src, alt, width, height } = props || {};
  return React.createElement("img", { src: typeof src === "string" ? src : (src && src.src) || "", alt: alt || "", width, height });
}
