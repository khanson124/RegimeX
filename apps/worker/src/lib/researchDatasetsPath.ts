import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Resolve research-datasets directory the same way the worker container expects:
 * /app/research-datasets when cwd is under /app (Docker worker WORKDIR).
 */
export function resolveResearchDatasetsDir(): string {
  const fromEnv = process.env.RESEARCH_DATASETS_DIR?.trim();
  if (fromEnv) {
    mkdirSync(fromEnv, { recursive: true });
    return fromEnv;
  }

  const candidates = [
    "/app/research-datasets",
    resolve(process.cwd(), "research-datasets"),
    resolve(process.cwd(), "../../research-datasets"),
    resolve(process.cwd(), "../../../research-datasets")
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }

  // Prefer Docker bind-mount path when running inside the worker image.
  if (process.cwd() === "/app" || process.cwd().startsWith("/app/")) {
    mkdirSync("/app/research-datasets", { recursive: true });
    return "/app/research-datasets";
  }

  const fallback = resolve(process.cwd(), "../../research-datasets");
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

export function researchDatasetPath(filename: string): string {
  return join(resolveResearchDatasetsDir(), filename);
}
