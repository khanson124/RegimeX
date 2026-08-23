import React from "react";
import { useEffect } from "react";
import { injectWebGlobalStyles } from "../lib/webStyles";

/** Mounts global browser CSS (background, fonts, scrollbars, focus rings). */
export function WebStyleProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    injectWebGlobalStyles();
  }, []);

  return <>{children}</>;
}
