"use client";

import { useEffect, useState } from "react";
import { getBranding } from "@/lib/api";
import { DEFAULT_LOGO_URL, DEFAULT_PRODUCT_NAME, isBuiltInLogo } from "@/lib/branding";

type BrandLogoProps = {
  className?: string;
  alt?: string;
  decorative?: boolean;
};

export function BrandLogo({ className = "h-10 w-auto object-contain", alt, decorative = false }: BrandLogoProps) {
  const [branding, setBranding] = useState({ productName: DEFAULT_PRODUCT_NAME, logoUrl: DEFAULT_LOGO_URL });

  useEffect(() => {
    let alive = true;
    getBranding()
      .then((next) => {
        if (alive) setBranding(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const label = decorative ? undefined : alt || branding.productName || DEFAULT_PRODUCT_NAME;

  // The built-in lockup is drawn as a background image so the light/dark variant
  // is picked by CSS — no theme state to hydrate, and only one file is fetched.
  if (isBuiltInLogo(branding.logoUrl)) {
    if (decorative) {
      return (
        <span
          className={`tp-brand-logo inline-block aspect-[200/177] ${className}`}
          aria-hidden="true"
        />
      );
    }
    return (
      <span
        className={`inline-flex items-center gap-2.5 ${className}`}
        role="img"
        aria-label={label}
      >
        <span className="tp-brand-logo inline-block h-[85%] aspect-[200/177] shrink-0" aria-hidden="true" />
        <span className="font-semibold tracking-tight text-[var(--foreground)] text-[16px] leading-none whitespace-nowrap">
          {branding.productName || DEFAULT_PRODUCT_NAME}
        </span>
      </span>
    );
  }

  return <img src={branding.logoUrl} alt={label ?? ""} className={className} />;
}
