export const DEFAULT_PRODUCT_NAME = "TestPilot";
export const DEFAULT_LOGO_URL = "/brand/testpilot-logo-light.svg";

/**
 * True when nothing custom has been uploaded, so we can render the built-in
 * lockup — which swaps light/dark variants and has a square mark to fall back on.
 */
export function isBuiltInLogo(logoUrl: string | null | undefined): boolean {
  return (
    !logoUrl ||
    logoUrl === DEFAULT_LOGO_URL ||
    logoUrl === "/brand/testpilot-logo-dark.svg" ||
    logoUrl === "/brand/testpilot-logo-horizontal.svg"
  );
}
