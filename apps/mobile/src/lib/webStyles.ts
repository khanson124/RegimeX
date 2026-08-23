import { Platform } from "react-native";
import { colors } from "../theme";

/** Layout tokens for browser/desktop rendering. */
export const webLayout = {
  appMaxWidth: 960,
  authMaxWidth: 420,
  pagePadding: 24
} as const;

let injected = false;

/** Inject global CSS once when running in the browser. */
export function injectWebGlobalStyles(): void {
  if (Platform.OS !== "web" || injected || typeof document === "undefined") return;
  injected = true;

  const style = document.createElement("style");
  style.setAttribute("data-regimex-web", "true");
  style.textContent = `
    html, body, #root, #__next {
      height: 100%;
      width: 100%;
      margin: 0;
      padding: 0;
      background: ${colors.bg};
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    input, textarea, button {
      font-family: inherit;
    }
    input:focus, textarea:focus {
      outline: 2px solid ${colors.accent};
      outline-offset: 1px;
    }
    a {
      text-decoration: none;
    }
    a:hover {
      opacity: 0.85;
    }
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    ::-webkit-scrollbar-thumb {
      background: ${colors.border};
      border-radius: 4px;
    }
    ::-webkit-scrollbar-track {
      background: ${colors.bg};
    }
  `;
  document.head.appendChild(style);
}

/** Merge web-only style objects without affecting native builds. */
export function webStyle<T extends Record<string, unknown>>(style: T): T | undefined {
  return Platform.OS === "web" ? style : undefined;
}
