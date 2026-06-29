"use client";

import * as React from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

interface CardArtProps {
  smallSrc: string;
  fullSrc: string;
  alt: string;
  sizes: string;
  /** When true, also load the full-res image and fade it in over the small one. */
  loadFull?: boolean;
  priority?: boolean;
  /** Object-fit / extra classes applied to both layers (e.g. "object-cover"). */
  className?: string;
  onError?: () => void;
}

export function CardArt({
  smallSrc,
  fullSrc,
  alt,
  sizes,
  loadFull = false,
  priority = false,
  className,
  onError,
}: CardArtProps): React.JSX.Element {
  const [fullLoaded, setFullLoaded] = React.useState(false);

  return (
    <>
      <Image
        src={smallSrc}
        alt={alt}
        fill
        sizes={sizes}
        priority={priority}
        className={cn(className)}
        onError={onError}
      />
      {loadFull && (
        <Image
          src={fullSrc}
          alt={alt}
          fill
          sizes={sizes}
          className={cn(
            className,
            "transition-opacity duration-200",
            fullLoaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setFullLoaded(true)}
          onError={onError}
        />
      )}
    </>
  );
}
