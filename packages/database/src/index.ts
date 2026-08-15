import { PrismaClient, Prisma } from "@prisma/client";

export { PrismaClient, Prisma };
export type * from "@prisma/client";

let client: PrismaClient | null = null;

/** Singleton Prisma client shared by API and worker within a process. */
export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
    });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}
