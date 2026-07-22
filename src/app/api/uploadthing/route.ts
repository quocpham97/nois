import { createRouteHandler } from "uploadthing/next";
import { ourFileRouter } from "./core";

// Serves the UploadThing endpoints at /api/uploadthing (same origin as the app,
// so the client needs no extra URL config). Reads UPLOADTHING_TOKEN from env.
export const { GET, POST } = createRouteHandler({ router: ourFileRouter });
