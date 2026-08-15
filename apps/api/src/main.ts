import { loadConfig } from "@regimex/config";
import { createContext, destroyContext } from "./context.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createContext(config);
  const app = await buildServer(ctx);

  const close = async (): Promise<void> => {
    app.log.info("Shutting down API");
    await app.close();
    await destroyContext(ctx);
    process.exit(0);
  };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info({ port: config.PORT }, "RegimeX API listening");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
