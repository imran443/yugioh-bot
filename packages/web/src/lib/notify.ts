import { createBroadcaster, createAnnouncer, httpTransport } from "@yugidraft/shared/notify";
import { env } from "./env";

export const broadcaster = createBroadcaster(httpTransport({ url: env.wsInternalUrl, secret: env.wsInternalSecret }));
export const announcer = createAnnouncer(httpTransport({ url: env.botAnnounceUrl, secret: env.botAnnounceSecret }));
