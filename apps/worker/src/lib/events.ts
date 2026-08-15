import { type Redis } from "ioredis";
import { CHANNELS, type AppWsEvent, type AppWsEventType } from "@regimex/shared";

/** Publish a realtime event for the API to relay to the user's app clients. */
export function createEventPublisher(redis: Redis) {
  return async function publish<T>(userId: string, type: AppWsEventType, payload: T): Promise<void> {
    const event: AppWsEvent<T> = { type, userId, payload, ts: Date.now() };
    await redis.publish(CHANNELS.appEvents, JSON.stringify(event));
  };
}

export type EventPublisher = ReturnType<typeof createEventPublisher>;
